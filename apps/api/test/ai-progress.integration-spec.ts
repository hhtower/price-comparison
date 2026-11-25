import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { CompiledQuery, Kysely, PostgresDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { migrationProvider } from '../scripts/migrate.js';
import { jsonb, type DatabaseSchema } from '../src/database/types.js';
import { getJobProgress } from '../src/ai/ai-progress.repository.js';

type Plan = { 'Relation Name'?: string; 'Actual Loops': number; Plans?: Plan[] };
const nodes = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(nodes)];

test('progress projects members once while preserving legacy JSON and version semantics', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const schema = `progress_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  let lastQuery: CompiledQuery | undefined;
  const db = new Kysely<DatabaseSchema>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public` }) }),
    log: event => { if (event.query.sql.includes('from ai_job_progress p')) lastQuery = event.query; },
  });
  try {
    await admin.query(`create schema "${schema}"`);
    const migration = await new Migrator({ db, provider: migrationProvider, migrationTableSchema: schema }).migrateToLatest();
    if (migration.error) throw migration.error;
    const shop = await db.insertInto('shops').values({ platform: 'test', name: 'progress', url: 'https://test.invalid', enabled: true }).returning('id').executeTakeFirstOrThrow();
    const cases = [
      { status: 'queued', output: { acceptedTags: null } },
      { status: 'processing', output: { rejectedTags: {} } },
      { status: 'classified', output: { outcome: 'updated', acceptedTags: [1, 2], rejectedTags: [3],
        classificationReviewed: true, classification: { kind: 'account', reason: 'llm_reviewed' } } },
      { status: 'classified', output: { outcome: 'partial_success', acceptedTags: [], rejectedTags: [], classificationReviewed: false } },
      { status: 'failed', output: { outcome: 'failed' } },
      { status: 'cancelled', output: { outcome: 'cancelled' } },
      { status: 'classified', output: { outcome: 'unexpected' } },
      { status: 'classified', output: undefined },
      { status: 'classified', output: 'legacy' },
      { status: 'classified', output: ['acceptedTags'] },
      { status: 'classified', output: null },
      { status: 'classified', output: { outcome: 'unchanged', classificationReviewed: 'true', classification: { kind: 'account', reason: 'llm_reviewed' } } },
      { status: 'classified', output: { outcome: 'review', classificationReviewed: 'false' } },
      { status: 'classified', output: { outcome: 'empty', classificationReviewed: true, classification: { kind: 'invalid', reason: 'llm_reviewed' } } },
      { status: 'classified', output: { outcome: 'skipped', classificationReviewed: true, classification: { kind: 'account', reason: 'llm_reviewed' } } },
      { status: 'classified', output: { outcome: 123 } },
      { status: 'classified', output: { outcome: { value: 'updated' } } },
    ];
    const products = await db.insertInto('products').values(cases.map((_, i) => ({
      shop_id: shop.id, external_id: String(i), name: 'progress', normalized_key: `progress-${i}`, url: '',
    }))).returning('id').execute();
    const job = await db.insertInto('ai_jobs').values({ model: 'mock', job_type: 'membership_features', status: 'running', total: 99n }).returning('id').executeTakeFirstOrThrow();
    const inputId = products[0]!.id;
    await db.insertInto('ai_job_inputs').values({ job_id: job.id, input_id: inputId, fingerprint: 'test', payload: jsonb({}), content_version: 1n, input_bytes: 1n, estimated_tokens: 1n }).execute();
    await db.insertInto('ai_job_input_members').values(cases.map((item, i) => ({
      job_id: job.id, input_id: inputId, product_id: products[i]!.id, status: item.status,
      output: item.output === undefined ? null : jsonb(item.output),
    }))).execute();
    await db.insertInto('ai_job_progress').values({
      job_id: job.id, total: 99n, queued: 10n, running: 20n, processed: 69n, succeeded: 60n, failed: 9n, version: 7n,
    }).execute();

    for (const jobType of ['membership_features', 'tag_extraction', 'text_review', 'manual_full'] as const) {
      await t.test(`${jobType} retains counters, outcomes and acceptance rules`, async () => {
        await db.updateTable('ai_jobs').set({ job_type: jobType }).where('id', '=', job.id).execute();
        const snapshot = await getJobProgress(db, job.id);
        assert.ok(snapshot);
        const attribute = jobType !== 'manual_full';
        assert.deepEqual([snapshot.total, snapshot.queued, snapshot.running, snapshot.processed, snapshot.succeeded, snapshot.failed],
          attribute ? ['17', '1', '1', '15', '5', '1'] : ['99', '10', '20', '69', '60', '9']);
        assert.equal(snapshot.rawProductCount, attribute ? 17 : 99);
        assert.equal(snapshot.uniqueInputCount, 1);
        assert.equal(snapshot.version, '7');
        const tag = jobType === 'membership_features' || jobType === 'tag_extraction';
        const outcomes = { updated: 1, unchanged: 1, empty: 1, review: 1, partial_success: 1, skipped: 1, failed: 1, cancelled: 1, unrecorded: 7 };
        assert.deepEqual(snapshot.tagResults, tag ? outcomes : undefined);
        assert.deepEqual(snapshot.textReviewResults, jobType === 'text_review' ? outcomes : undefined);
        assert.deepEqual(snapshot.tagAcceptance, tag ? { acceptedTags: 2, rejectedTags: 1, partialProducts: 2 } : undefined);
        assert.deepEqual(snapshot.featureAcceptance, jobType === 'membership_features' ? { acceptedProducts: 1, rejectedProducts: 1 } : undefined);
      });
    }
    await db.updateTable('ai_jobs').set({ job_type: 'membership_features' }).where('id', '=', job.id).execute();

    await t.test('one member table scan serves counters and outcome distribution', async () => {
      await getJobProgress(db, job.id);
      assert.ok(lastQuery);
      const result = await db.executeQuery<{ 'QUERY PLAN': { Plan: Plan }[] }>(
        CompiledQuery.raw('explain (analyze, format json) ' + lastQuery.sql, [...lastQuery.parameters]));
      const scans = nodes(result.rows[0]!['QUERY PLAN'][0]!.Plan).filter(node => node['Relation Name'] === 'ai_job_input_members');
      assert.equal(scans.length, 1);
      assert.equal(scans[0]!['Actual Loops'], 1);
    });

    await t.test('malformed terminal tag arrays still fail, but since and non-tag jobs skip their evaluation', async () => {
      for (const field of ['acceptedTags', 'rejectedTags']) {
        for (const value of [null, 'invalid', {}, 1]) {
          await db.updateTable('ai_job_input_members').set({ output: jsonb({ outcome: 'updated', [field]: value }) })
            .where('job_id', '=', job.id).where('product_id', '=', products[2]!.id).execute();
          await db.updateTable('ai_jobs').set({ job_type: 'membership_features' }).where('id', '=', job.id).execute();
          assert.equal(await getJobProgress(db, job.id, 7n), null);
          assert.equal(await getJobProgress(db, job.id, 8n), null);
          await assert.rejects(getJobProgress(db, job.id, 6n), { code: '22023' });
          for (const jobType of ['text_review', 'manual_full'] as const) {
            await db.updateTable('ai_jobs').set({ job_type: jobType }).where('id', '=', job.id).execute();
            assert.ok(await getJobProgress(db, job.id));
          }
        }
      }
    });

    await t.test('unchanged version executes no member scan and missing progress returns null', async () => {
      await db.updateTable('ai_jobs').set({ job_type: 'membership_features' }).where('id', '=', job.id).execute();
      assert.equal(await getJobProgress(db, job.id, 7n), null);
      assert.ok(lastQuery);
      const result = await db.executeQuery<{ 'QUERY PLAN': { Plan: Plan }[] }>(
        CompiledQuery.raw('explain (analyze, format json) ' + lastQuery.sql, [...lastQuery.parameters]));
      assert.ok(nodes(result.rows[0]!['QUERY PLAN'][0]!.Plan)
        .filter(node => node['Relation Name'] === 'ai_job_input_members').every(node => node['Actual Loops'] === 0));
      assert.equal(await getJobProgress(db, -1n), null);
      await db.deleteFrom('ai_job_input_members').where('job_id', '=', job.id).execute();
      const empty = await getJobProgress(db, job.id);
      assert.equal(empty?.total, '0');
      assert.equal(empty?.processed, '0');
      assert.deepEqual(empty?.tagAcceptance, { acceptedTags: 0, rejectedTags: 0, partialProducts: 0 });
    });
  } finally {
    await db.destroy();
    await admin.query(`drop schema if exists "${schema}" cascade`);
    await admin.end();
  }
});
