import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { migrateToLatest } from '../scripts/migrate.js';
import { AiRepository } from '../src/ai/ai.repository.js';
import { finalizeOrScheduleMissing } from '../src/ai/standardization-finalizer.js';
import { jsonb, type DatabaseSchema } from '../src/database/types.js';
import { productContentFingerprint } from '../src/standardization/fingerprint.js';

describe('missing-ID retry batch limits', () => {
  let database: Kysely<DatabaseSchema>;
  let admin: Pool;
  let schema = '';
  let sequence = 0;

  before(async () => {
    if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required for AI integration tests');
    schema = `ai_missing_batch_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
    admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`create schema "${schema}"`);
    process.env.PG_SCHEMA = schema;
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path="${schema}",public`, max: 12 });
    database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    await migrateToLatest(database);
  });

  after(async () => {
    await database?.destroy();
    if (admin && schema) await admin.query(`drop schema if exists "${schema}" cascade`);
    await admin?.end();
    delete process.env.PG_SCHEMA;
  });

  async function missingJob(batchSize = 2) {
    const shop = await database.insertInto('shops').values({
      platform: 'integration', url: `https://shop.invalid/missing-${++sequence}`, name: `missing-${sequence}`,
      enabled: true, deleted_at: null, last_fetch_at: null, last_error: null,
    }).returning('id').executeTakeFirstOrThrow();
    const productIds: bigint[] = [];
    for (const name of [`alpha-${sequence}`, `beta-${sequence}`]) {
      const sourceData = { title: name, description: name.repeat(name.startsWith('alpha') ? 50 : 65) };
      const fingerprint = productContentFingerprint({ name, spec: 'monthly', sourceCategory: '', sourceData });
      const product = await database.insertInto('products').values({
        shop_id: shop.id, external_id: name, name, spec: 'monthly', source_category: '', source_data: jsonb(sourceData),
        normalized_key: name, url: `https://product.invalid/${name}`, deleted_at: null, content_version: 1n,
        content_fingerprint: fingerprint, standardization_locked: false,
      }).returning('id').executeTakeFirstOrThrow();
      productIds.push(product.id);
    }
    const job = await new AiRepository(database).createJob({ model: `missing-${sequence}`, productIds, batchSize });
    assert.equal(job.batches.length, batchSize === 1 ? 2 : 1);
    await database.updateTable('ai_job_input_members').set({ status: 'unclassified', reason_code: 'missing_id' })
      .where('job_id', '=', job.id).execute();
    await database.updateTable('ai_job_inputs').set({ status: 'succeeded', reason_code: 'missing_id' })
      .where('job_id', '=', job.id).execute();
    await database.updateTable('ai_job_batches').set({ status: 'succeeded', step: 'done', finished_at: sql`now()` })
      .where('job_id', '=', job.id).execute();
    return job;
  }

  async function withLimits(limits: { items: number; bytes: number; tokens: number }, action: () => Promise<void>) {
    const keys = ['AI_BATCH_MAX_ITEMS', 'AI_BATCH_MAX_INPUT_BYTES', 'AI_BATCH_MAX_INPUT_TOKENS'] as const;
    const previous = keys.map(key => process.env[key]);
    [process.env.AI_BATCH_MAX_ITEMS, process.env.AI_BATCH_MAX_INPUT_BYTES, process.env.AI_BATCH_MAX_INPUT_TOKENS] =
      [String(limits.items), String(limits.bytes), String(limits.tokens)];
    try { await action(); } finally {
      keys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      });
    }
  }

  test('missing retry obeys the current maximum item count', async () => {
    const job = await missingJob();
    await withLimits({ items: 1, bytes: 24_576, tokens: 6_000 }, async () => {
      await database.transaction().execute(tx => finalizeOrScheduleMissing(tx, job.id));
    });
    const batches = await database.selectFrom('ai_job_batches').select(['product_ids', 'request_budget_limit'])
      .where('job_id', '=', job.id).where('round', '=', 1).orderBy('batch_index').execute();
    assert.equal(batches.length, 2);
    assert.deepEqual(batches.map(batch => (batch.product_ids as string[]).length), [1, 1]);
    assert.deepEqual(batches.map(batch => batch.request_budget_limit), [1, 1]);
  });

  test('missing retry respects the original job item cap', async () => {
    const job = await missingJob(1);
    await withLimits({ items: 32, bytes: 24_576, tokens: 6_000 }, async () => {
      await database.transaction().execute(tx => finalizeOrScheduleMissing(tx, job.id));
    });
    const batches = await database.selectFrom('ai_job_batches').select('product_ids')
      .where('job_id', '=', job.id).where('round', '=', 1).orderBy('batch_index').execute();
    assert.equal(batches.length, 2);
    assert.deepEqual(batches.map(batch => (batch.product_ids as string[]).length), [1, 1]);
  });

  test('missing retry obeys the current byte budget', async () => {
    const job = await missingJob();
    const sizes = await database.selectFrom('ai_job_inputs').select(['input_bytes', 'estimated_tokens'])
      .where('job_id', '=', job.id).orderBy('input_id').execute();
    const maxBytes = Number(sizes.reduce((max, row) => row.input_bytes > max ? row.input_bytes : max, 0n));
    assert.ok(Number(sizes[0]!.input_bytes + sizes[1]!.input_bytes) > maxBytes);
    await withLimits({ items: 2, bytes: maxBytes, tokens: 6_000 }, async () => {
      await database.transaction().execute(tx => finalizeOrScheduleMissing(tx, job.id));
    });
    const batches = await database.selectFrom('ai_job_batches').select(['product_ids', 'input_bytes', 'estimated_tokens'])
      .where('job_id', '=', job.id).where('round', '=', 1).orderBy('batch_index').execute();
    assert.equal(batches.length, 2);
    assert.deepEqual(batches.map(batch => (batch.product_ids as string[]).length), [1, 1]);
    assert.ok(batches.every(batch => Number(batch.input_bytes) <= maxBytes));
  });

  test('missing retry obeys the current token budget', async () => {
    const job = await missingJob();
    const sizes = await database.selectFrom('ai_job_inputs').select('estimated_tokens')
      .where('job_id', '=', job.id).orderBy('input_id').execute();
    const maxTokens = Number(sizes.reduce((max, row) => row.estimated_tokens > max ? row.estimated_tokens : max, 0n));
    assert.ok(Number(sizes[0]!.estimated_tokens + sizes[1]!.estimated_tokens) > maxTokens);
    await withLimits({ items: 2, bytes: 24_576, tokens: maxTokens }, async () => {
      await database.transaction().execute(tx => finalizeOrScheduleMissing(tx, job.id));
    });
    const batches = await database.selectFrom('ai_job_batches').select(['product_ids', 'estimated_tokens'])
      .where('job_id', '=', job.id).where('round', '=', 1).orderBy('batch_index').execute();
    assert.equal(batches.length, 2);
    assert.deepEqual(batches.map(batch => (batch.product_ids as string[]).length), [1, 1]);
    assert.ok(batches.every(batch => Number(batch.estimated_tokens) <= maxTokens));
  });

  test('an input oversized after configuration shrink becomes terminal unclassified', async () => {
    const job = await missingJob();
    const inputs = await database.selectFrom('ai_job_inputs').select(['input_id', 'input_bytes']).where('job_id', '=', job.id).orderBy('input_id').execute();
    const smaller = Number(inputs[0]!.input_bytes < inputs[1]!.input_bytes ? inputs[0]!.input_bytes : inputs[1]!.input_bytes);
    await withLimits({ items: 2, bytes: smaller, tokens: 6_000 }, async () => {
      await database.transaction().execute(tx => finalizeOrScheduleMissing(tx, job.id));
    });
    const oversized = inputs.filter(input => Number(input.input_bytes) > smaller).map(input => input.input_id.toString());
    assert.ok(oversized.length > 0);
    const batches = await database.selectFrom('ai_job_batches').select(['product_ids', 'status']).where('job_id', '=', job.id).where('round', '=', 1).execute();
    assert.deepEqual(batches.flatMap(batch => batch.product_ids as string[]), inputs.filter(input => Number(input.input_bytes) <= smaller).map(input => input.input_id.toString()));
    const results = await database.selectFrom('ai_standardization_results').select(['input_id', 'status', 'reason_code'])
      .where('job_id', '=', job.id).orderBy('input_id').execute();
    assert.deepEqual(results.filter(row => oversized.includes(row.input_id.toString())).map(row => [row.status, row.reason_code]),
      oversized.map(() => ['unclassified', 'input_too_large']));
    const stranded = await database.selectFrom('ai_job_input_members').select('product_id').where('job_id', '=', job.id)
      .where('status', '=', 'queued').where('input_id', 'in', oversized.map(BigInt)).execute();
    assert.equal(stranded.length, 0);
    await database.updateTable('ai_job_batches').set({ status: 'succeeded', step: 'done' })
      .where('job_id', '=', job.id).where('round', '=', 1).execute();
    await database.transaction().execute(tx => finalizeOrScheduleMissing(tx, job.id));
    const finished = await database.selectFrom('ai_jobs').select('status').where('id', '=', job.id).executeTakeFirstOrThrow();
    assert.equal(finished.status, 'ready_with_errors');
  });

  test('all oversized missing inputs finish without queued or unreported products', async () => {
    const job = await missingJob();
    await withLimits({ items: 2, bytes: 1, tokens: 6_000 }, async () => {
      await database.transaction().execute(tx => finalizeOrScheduleMissing(tx, job.id));
    });
    const batches = await database.selectFrom('ai_job_batches').select('id')
      .where('job_id', '=', job.id).where('round', '=', 1).execute();
    assert.equal(batches.length, 0);
    const inputs = await database.selectFrom('ai_job_inputs').select(['status', 'reason_code', 'missing_reprocess_count'])
      .where('job_id', '=', job.id).execute();
    assert.deepEqual(inputs.map(row => [row.status, row.reason_code, row.missing_reprocess_count]),
      [['failed', 'input_too_large', 1], ['failed', 'input_too_large', 1]]);
    const members = await database.selectFrom('ai_job_input_members').select(['status', 'reason_code'])
      .where('job_id', '=', job.id).execute();
    assert.deepEqual(members.map(row => [row.status, row.reason_code]),
      [['unclassified', 'input_too_large'], ['unclassified', 'input_too_large']]);
    const results = await database.selectFrom('ai_standardization_results').select(['status', 'reason_code'])
      .where('job_id', '=', job.id).execute();
    assert.deepEqual(results.map(row => [row.status, row.reason_code]),
      [['unclassified', 'input_too_large'], ['unclassified', 'input_too_large']]);
    const finished = await database.selectFrom('ai_jobs').select(['status', 'processed', 'unclassified'])
      .where('id', '=', job.id).executeTakeFirstOrThrow();
    assert.deepEqual(finished, { status: 'ready_with_errors', processed: 2n, unclassified: 2n });
    await database.transaction().execute(tx => finalizeOrScheduleMissing(tx, job.id));
    assert.equal((await database.selectFrom('ai_job_batches').select('id')
      .where('job_id', '=', job.id).where('round', '=', 1).execute()).length, 0);
  });
});
