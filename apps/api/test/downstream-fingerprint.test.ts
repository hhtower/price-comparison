import assert from 'node:assert/strict';
import test from 'node:test';
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type CompiledQuery } from 'kysely';
import { AiRepository, productFingerprint } from '../src/ai/ai.repository.js';
import { createMembershipFeatureJob, createTagJob, previewTagJob } from '../src/ai/tag-extraction-jobs.js';
import { recordManualDecisions } from '../src/standardization/decision-history.js';
import { reconcileNameConsensus } from '../src/standardization/name-consensus-repair.js';
import type { DatabaseSchema, JsonValue } from '../src/database/types.js';
import { captureRatingText } from '../src/platforms/source-evidence.js';
import { productContentFingerprint } from '../src/standardization/fingerprint.js';

const source = {
  name: 'ChatGPT Free', source_name: 'ChatGPT Free', source_description: '', spec: 'monthly',
  source_category: '', source_data: {} as Record<string, JsonValue>,
};
const fingerprint = (p: typeof source) => productContentFingerprint({
  name: p.source_name || p.name, description: p.source_description || undefined,
  spec: p.spec, sourceCategory: p.source_category, sourceData: p.source_data,
});
const product = (id: bigint, overrides: Partial<typeof source> = {}) => ({
  id, ...source, ...overrides,
  content_fingerprint: fingerprint({ ...source, ...overrides }), content_version: 1n, standardization_revision: 0n,
  standardization_locked: false, deleted_at: null, enabled: true, shop_deleted_at: null,
  standard_product_id: 9n, published: true, ai_membership: false, human: false, manual: false,
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
  assert.equal(f.inserts.get('product_standardization_decisions')?.[0]?.content_fingerprint, product(1n).content_fingerprint);
  const updates = f.queries.filter(query => query.sql.startsWith('update "products"'));
  assert.equal(updates.length, 1);
  assert.ok(!updates[0]!.sql.includes('content_fingerprint'));
});

for (const kind of ['identity', 'membership_features', 'tag_extraction'] as const) {
  const taskProduct = (id: bigint, overrides: Partial<typeof source> = {}) => ({ ...product(id, {
    ...(kind === 'membership_features' ? { name: 'ChatGPT Plus', source_name: 'ChatGPT Plus' } : {}), ...overrides,
  }), ai_membership: kind === 'membership_features' });
  const create = (db: Kysely<DatabaseSchema>, products: ReturnType<typeof product>[]) => {
    const scope = { model: 'mock', productIds: products.map(p => p.id) };
    return kind === 'identity' ? new AiRepository(db).createJob(scope)
      : db.transaction().execute(tx => kind === 'membership_features' ? createMembershipFeatureJob(tx, scope) : createTagJob(tx, scope));
  };

  test(`${kind} groups the four approved fields using the single stored fingerprint`, async () => {
    const products = [taskProduct(1n), taskProduct(2n),
      taskProduct(3n, { source_name: kind === 'membership_features' ? 'ChatGPT Pro' : 'ChatGPT Free 免费版' }),
      taskProduct(4n, { source_description: 'Full original body' }),
      taskProduct(5n, { source_data: { evidence: 'Different delivery' } }),
      taskProduct(6n, { source_data: { content: 'Additional full body' } }),
      taskProduct(7n, { spec: 'annual' }),
      taskProduct(8n, { source_data: { warranty_info: 'Subscription covered for 30 days' } }),
    ];
    const f = fixture(products);
    await create(f.db, products);
    const inputs = f.inserts.get('ai_job_inputs')!;
    assert.equal(inputs.length, 7);
    assert.equal(new Set(products.map(p => p.content_fingerprint)).size, 7);
    for (const input of inputs) assert.equal(input.fingerprint, products.find(p => p.id === input.input_id)!.content_fingerprint);
    const members = f.inserts.get('ai_job_input_members')!;
    assert.deepEqual(members.map(row => row.input_id), [1n, 1n, 3n, 4n, 5n, 6n, 7n, 8n]);
    for (const member of members) assert.equal(member.fingerprint, products.find(p => p.id === member.product_id)!.content_fingerprint);
    if (kind === 'identity') {
      assert.ok(f.queries.find(query => query.sql.includes('for key share'))!.sql.includes('"products"."content_fingerprint"'));
      assert.deepEqual(f.inserts.get('ai_standardization_executions')!.map(row => row.fingerprint), products.map(p => p.content_fingerprint));
    }
  });

  test(`${kind} preserves distinct full contexts while sharing their stored fingerprint`, async () => {
    const products = [taskProduct(1n),
      taskProduct(2n, { source_category: 'Merchant category only' }),
      taskProduct(3n, { source_data: { usage_guide: 'Usage instructions only' } }),
    ];
    assert.equal(new Set(products.map(p => p.content_fingerprint)).size, 1);
    const f = fixture(products);
    await create(f.db, products);
    assert.equal(f.inserts.get('ai_job_inputs')!.length, 3);
    assert.deepEqual(f.inserts.get('ai_job_input_members')!.map(row => row.input_id), [1n, 2n, 3n]);
    const members = f.inserts.get('ai_job_input_members')!;
    assert.ok(members.every(row => row.fingerprint === products[0]!.content_fingerprint));
    assert.equal(JSON.parse(members[1]!.payload as string).category, 'Merchant category only');
    assert.equal(JSON.parse(members[2]!.payload as string).sourceData.usage_guide, 'Usage instructions only');
  });

  test(`${kind} sends all differing context without recomputing stored fingerprints`, async () => {
    const products = [taskProduct(1n), taskProduct(2n, { source_data: {
      brand: 'other', vendor: 'other', tags: ['other'], attrs: { plan: 'other' }, unknown: 'other',
    } }), taskProduct(3n, { spec: 'annual', source_data: { evidence: 'Different body' } })];
    assert.equal(products[1]!.content_fingerprint, products[0]!.content_fingerprint);
    assert.notEqual(products[2]!.content_fingerprint, products[0]!.content_fingerprint);
    // Deliberately stale source hash: downstream grouping must trust storage, not rehash the payload.
    products[2]!.content_fingerprint = products[0]!.content_fingerprint;
    const f = fixture(products);
    await create(f.db, products);
    assert.equal(f.inserts.get('ai_job_inputs')!.length, 3);
    assert.deepEqual(f.inserts.get('ai_job_input_members')!.map(row => row.input_id), [1n, 2n, 3n]);
    assert.ok(f.inserts.get('ai_job_input_members')!.every(row => row.fingerprint === products[0]!.content_fingerprint));
    const payload = JSON.parse(f.inserts.get('ai_job_input_members')![1]!.payload as string);
    assert.equal(payload.sourceData.brand, 'other');
    assert.equal(payload.sourceData.vendor, 'other');
    assert.deepEqual(payload.sourceData.tags, ['other']);
    assert.deepEqual(payload.sourceData.attrs, { plan: 'other' });
    assert.equal(payload.sourceData.unknown, 'other');
  });

  test(`${kind} keeps identical payloads with different stored fingerprints separate`, async () => {
    const products = [taskProduct(1n), { ...taskProduct(2n), content_fingerprint: taskProduct(3n, { spec: 'annual' }).content_fingerprint }];
    const f = fixture(products);
    await create(f.db, products);
    assert.deepEqual(f.inserts.get('ai_job_inputs')!.map(row => row.fingerprint), products.map(p => p.content_fingerprint));
  });

  test(`${kind} adds shop text review context only for tag grouping`, async () => {
    const products = [taskProduct(1n),
      taskProduct(2n, { source_data: { ratingText: captureRatingText('parent-a', 'Original shop title', 'Shop description')! } }),
      taskProduct(3n, { source_data: { ratingText: captureRatingText('parent-b', 'Original shop title', 'Shop description')! } }),
    ];
    assert.equal(new Set(products.map(p => p.content_fingerprint)).size, 1);
    const f = fixture(products);
    await create(f.db, products);
    assert.deepEqual(f.inserts.get('ai_job_input_members')!.map(row => row.input_id),
      kind === 'tag_extraction' ? [1n, 2n, 2n] : [1n, 1n, 1n]);
    assert.ok(f.inserts.get('ai_job_inputs')!.every(row => row.fingerprint === products[0]!.content_fingerprint));
  });
}

test('identity keeps historical manual decisions separate without replacing the stored fingerprint', async () => {
  const products = [product(1n), product(2n), product(3n)];
  const f = fixture(products, [{
    id: 7n, product_id: 2n, action: 'assign', content_version: 0n,
    content_fingerprint: product(2n, { spec: 'annual' }).content_fingerprint,
    evidence_known: true, target_snapshot: null, created_at: new Date('2026-01-01'), reason: 'previous review',
  }]);
  await new AiRepository(f.db).createJob({ model: 'mock', productIds: products.map(p => p.id) });
  const inputs = f.inserts.get('ai_job_inputs')!;
  assert.deepEqual(inputs.map(row => [row.input_id, row.manual_decision_id]), [[1n, null], [2n, 7n]]);
  assert.ok(inputs.every(row => row.fingerprint === products[0]!.content_fingerprint));
  assert.deepEqual(f.inserts.get('ai_job_input_members')!.map(row => [row.product_id, row.input_id]), [[1n, 1n], [3n, 1n], [2n, 2n]]);
});

test('tag preview changes when source content gets its updated stored fingerprint', async () => {
  const products = [product(1n), product(2n), product(3n, { spec: 'annual' }), product(4n, { source_data: { evidence: 'different delivery' } })];
  const f = fixture(products);
  const scope = { model: 'mock', productIds: products.map(p => p.id) };
  const before = await previewTagJob(f.db, scope);
  assert.equal(before.counts.uniqueInputs, 3);
  await f.db.transaction().execute(tx => createTagJob(tx, scope));
  assert.equal(f.inserts.get('ai_job_inputs')?.length, 3);
  assert.deepEqual(f.inserts.get('ai_job_input_members')?.map(row => row.input_id), [1n, 1n, 3n, 4n]);
  assert.deepEqual(f.inserts.get('ai_job_inputs')!.map(row => row.fingerprint), [products[0], products[2], products[3]].map(p => p!.content_fingerprint));
  products[2]!.spec = 'weekly';
  assert.notEqual((await previewTagJob(f.db, scope)).previewDigest, before.previewDigest);
  products[2]!.content_fingerprint = fingerprint(products[2]!);
  const after = await previewTagJob(f.db, scope);
  assert.notEqual(after.previewDigest, before.previewDigest);
  products[3]!.source_data = { evidence: 'changed delivery' };
  products[3]!.content_fingerprint = fingerprint(products[3]!);
  assert.notEqual((await previewTagJob(f.db, scope)).previewDigest, after.previewDigest);
});

test('tag inputs keep absent rating text separate from a complete empty source description', async () => {
  const products = [product(1n), product(2n, { source_data: {
    ratingText: captureRatingText('parent', 'ChatGPT Plus', '')!,
  } })];
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
  const products = [product(1n), product(2n, { spec: 'x'.repeat(100_000) }), product(3n, { spec: 'x'.repeat(100_000) })];
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
  const reviewed = { id: 1n, product_id: 1n, content_version: 1n, content_fingerprint: product(1n).content_fingerprint, evidence_known: true };
  const p = { ...product(1n), name: 'ChatGPT free' };
  const member = { ...p, canonical_family: 'openai', canonical_product: 'chatgpt', canonical_tier: 'free', assignment_source: 'ai' };
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
