import assert from 'node:assert/strict';
import test from 'node:test';
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type CompiledQuery } from 'kysely';
import { AiRepository, productFingerprint } from '../src/ai/ai.repository.js';
import { createTagJob, previewTagJob } from '../src/ai/tag-extraction-jobs.js';
import { recordManualDecisions } from '../src/standardization/decision-history.js';
import { reconcileNameConsensus } from '../src/standardization/name-consensus-repair.js';
import type { DatabaseSchema } from '../src/database/types.js';
import { captureRatingText } from '../src/platforms/source-evidence.js';

const product = (id: bigint, spec = 'monthly') => ({
  id, name: 'ChatGPT Plus', spec, source_category: '', source_data: {},
  content_fingerprint: 'stored-source-hash', content_version: 1n, standardization_revision: 0n,
  standardization_locked: false, deleted_at: null, enabled: true, shop_deleted_at: null,
  standard_product_id: 9n, published: true, human: false, manual: false,
  shop_url: 'https://shop.invalid', shop_protocol: 'test', shop_platform: 'test',
});

function fixture(products = [product(1n)], manual: unknown[] = [], consensus: unknown[] = []) {
  const queries: CompiledQuery[] = [];
  const inserts = new Map<string, Record<string, unknown>[]>();
  const job = { id: 11n, total: BigInt(products.length), status: 'queued', pipeline_versions: {} };
  class Driver extends DummyDriver {
    async acquireConnection(): Promise<any> {
      return { executeQuery: async (query: CompiledQuery) => {
        queries.push(query);
        const node = query.query;
        if (node.kind === 'InsertQueryNode' && node.values?.kind === 'ValuesNode') {
          const table = query.sql.match(/^insert into "([^"]+)"/)![1]!;
          const rows = node.values.values.map(row => Object.fromEntries(node.columns!.map((column, index) => [
            column.column.name, row.kind === 'PrimitiveValueListNode' ? row.values[index]
              : row.values[index]?.kind === 'ValueNode' ? row.values[index].value : undefined,
          ])));
          inserts.set(table, [...inserts.get(table) ?? [], ...rows]);
          if (table === 'ai_jobs') return { rows: [job] };
          if (table === 'ai_job_batches') return { rows: rows.map((row, index) => ({ ...row, product_ids: JSON.parse(row.product_ids as string), id: BigInt(index + 1) })) };
        }
        if (query.sql.trimStart().startsWith('select')) {
          if (query.sql.includes('from ai_job_progress p')) return { rows: [{ job_id: job.id, updated_at: new Date() }] };
          if (query.sql.includes('from "product_standardization_decisions"')) return { rows: manual };
          if (query.sql.includes('from "ai_jobs"')) return { rows: [job] };
          if (query.sql.includes('inner join "standard_products" as "sp"')) return { rows: consensus };
          if (query.sql.includes('from "products"')) return { rows: products };
        }
        return { rows: [], numAffectedRows: 1n };
      } };
    }
  }
  const db = new Kysely<DatabaseSchema>({ dialect: {
    createAdapter: () => new PostgresAdapter(), createDriver: () => new Driver(),
    createIntrospector: db => new PostgresIntrospector(db), createQueryCompiler: () => new PostgresQueryCompiler(),
  } });
  return { db, queries, inserts };
}

test('downstream fingerprint uses the stored source hash despite processed evidence changes', () => {
  const original = product(1n);
  const processed = { ...original, name: 'Processed title', spec: 'annual', source_data: { model: 'processed' } };
  assert.equal(productFingerprint(original), original.content_fingerprint);
  assert.equal(productFingerprint(processed), original.content_fingerprint);
});

test('manual review records the stored source hash without rewriting products hash', async () => {
  const f = fixture();
  await recordManualDecisions(f.db, [1n], { action: 'exclude', standardProductId: null, reason: 'reviewed' });
  assert.equal(f.inserts.get('product_standardization_decisions')?.[0]?.content_fingerprint, 'stored-source-hash');
  const updates = f.queries.filter(query => query.sql.startsWith('update "products"'));
  assert.equal(updates.length, 1);
  assert.ok(!updates[0]!.sql.includes('content_fingerprint'));
});

test('standardization inputs split same-source SKUs by spec and source data while retaining source hashes', async () => {
  const products = [product(1n), product(2n), product(3n, 'annual'), { ...product(4n), source_data: { evidence: 'different delivery' } }];
  const f = fixture(products);
  const job = await new AiRepository(f.db).createJob({ model: 'mock', productIds: products.map(p => p.id) });
  assert.equal(job.inputs.length, 3);
  assert.ok(job.inputs.every(input => input.fingerprint === 'stored-source-hash'));
  const members = f.inserts.get('ai_job_input_members')!;
  assert.deepEqual(members.map(row => row.input_id), [1n, 1n, 3n, 4n]);
  assert.ok(f.queries.find(query => query.sql.includes('for key share'))!.sql.includes('"products"."content_fingerprint"'));
});

test('tag inputs split same-source SKUs and preview detects payload changes without a new source hash', async () => {
  const products = [product(1n), product(2n), product(3n, 'annual'), { ...product(4n), source_data: { evidence: 'different delivery' } }];
  const f = fixture(products);
  const scope = { model: 'mock', productIds: products.map(p => p.id) };
  const before = await previewTagJob(f.db, scope);
  assert.equal(before.counts.uniqueInputs, 3);
  await f.db.transaction().execute(tx => createTagJob(tx, scope));
  assert.equal(f.inserts.get('ai_job_inputs')?.length, 3);
  assert.deepEqual(f.inserts.get('ai_job_input_members')?.map(row => row.input_id), [1n, 1n, 3n, 4n]);
  assert.ok(f.inserts.get('ai_job_inputs')!.every(row => row.fingerprint === 'stored-source-hash'));
  products[2]!.spec = 'weekly';
  const after = await previewTagJob(f.db, scope);
  assert.notEqual(after.previewDigest, before.previewDigest);
  products[3]!.source_data = { evidence: 'changed delivery' };
  assert.notEqual((await previewTagJob(f.db, scope)).previewDigest, after.previewDigest);
});

test('equal payloads with different stored source hashes remain separate in both job types', async () => {
  const products = [product(1n), { ...product(2n), content_fingerprint: 'other-source-hash' }];
  const scope = { model: 'mock', productIds: products.map(p => p.id) };
  const identity = fixture(products);
  const job = await new AiRepository(identity.db).createJob(scope);
  assert.equal(job.inputs.length, 2);
  const tag = fixture(products);
  await tag.db.transaction().execute(tx => createTagJob(tx, scope));
  assert.equal(tag.inserts.get('ai_job_inputs')?.length, 2);
});

test('tag inputs keep absent rating text separate from a complete empty source description', async () => {
  const products = [product(1n), { ...product(2n), source_data: {
    ratingText: captureRatingText('parent', 'ChatGPT Plus', ''),
  } }];
  const f = fixture(products);
  const scope = { model: 'mock', productIds: products.map(p => p.id) };
  const preview = await previewTagJob(f.db, scope);
  assert.equal(preview.counts.uniqueInputs, 2);
  await f.db.transaction().execute(tx => createTagJob(tx, scope));
  assert.deepEqual(f.inserts.get('ai_job_input_members')?.map(row => row.input_id), [1n, 2n]);
  products[0]!.source_data = products[1]!.source_data;
  assert.notEqual((await previewTagJob(f.db, scope)).previewDigest, preview.previewDigest);
});

test('tag preview and persistence count oversized members through their payload representative', async () => {
  const products = [product(1n), product(2n, 'x'.repeat(100_000)), product(3n, 'x'.repeat(100_000))];
  const f = fixture(products);
  const scope = { model: 'mock', productIds: products.map(p => p.id) };
  const preview = await previewTagJob(f.db, scope);
  assert.equal(preview.counts.uniqueInputs, 2);
  assert.equal(preview.counts.oversized, 2);
  await f.db.transaction().execute(tx => createTagJob(tx, scope));
  assert.deepEqual(f.inserts.get('ai_job_input_members')?.map(row => [row.input_id, row.status]), [
    [1n, 'queued'], [2n, 'unclassified'], [2n, 'unclassified'],
  ]);
});

test('consensus repair protects manual decisions with the stored hash for assigned and unassigned products', async () => {
  const reviewed = { id: 1n, product_id: 1n, content_version: 1n, content_fingerprint: 'stored-source-hash', evidence_known: true };
  const p = product(1n);
  const member = { ...p, canonical_family: 'openai', canonical_product: 'chatgpt', canonical_tier: 'plus', assignment_source: 'ai' };
  const winner = { ...member, id: 2n, standard_product_id: 10n };
  const assigned = fixture([], [reviewed], [member, winner, { ...winner, id: 3n }]);
  const plan = await reconcileNameConsensus(assigned.db);
  assert.equal(plan.protectedProducts, 1);
  assert.deepEqual(plan.changes, []);
  const unassigned = fixture([p], [reviewed]);
  const other = await reconcileNameConsensus(unassigned.db);
  assert.equal(other.protectedProducts, 1);
  assert.deepEqual(other.changes, []);
});
