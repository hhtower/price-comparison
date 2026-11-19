import { tagRows } from './tag-fixtures.js';
import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { migrationProvider } from '../scripts/migrate.js';
import { AiRepository } from '../src/ai/ai.repository.js';
import { createAiWorker, createOpenAiModelCall } from '../src/ai/ai.worker.js';
import { recordTagRepairAttempt, validateReviewedTagExtractionDecision } from '../src/ai/tag-extraction-result.js';
import type { WarrantyLabels } from '../src/ai/tag-warranty-request.js';
import { buildExtractionPayload } from '../src/ai/adaptive-batching.js';
import { CONSISTENCY_KEYS, DISCLOSURE_KEYS, TEXT_REVIEW_VERSION, validateTextReview } from '../src/shops/shop-text-review.js';
import { pipelineVersionSnapshot, STANDARDIZATION_POLICY_VERSION } from '../src/ai/pipeline-versions.js';
import { STANDARDIZATION_PROMPT_VERSION } from '../src/ai/standardization-request.js';
import { productContentFingerprint } from '../src/standardization/fingerprint.js';
import { jsonb, type DatabaseSchema, type JsonValue } from '../src/database/types.js';
import { JobsRepository } from '../src/jobs/jobs.repository.js';

let db: Kysely<DatabaseSchema>, admin: Pool, schema: string;
before(async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL required');
  schema = `tag_checkpoint_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
  admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema "${schema}"`);
  db = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({
    connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public`, max: 4,
  }) }) });
  const migrated = await new Migrator({ db, provider: migrationProvider, migrationTableSchema: schema }).migrateToLatest();
  if (migrated.error) throw migrated.error;
});
after(async () => {
  await db?.destroy();
  if (schema) await admin.query(`drop schema "${schema}" cascade`);
  await admin?.end();
});

afterEach(async () => {
  await db.updateTable('ai_jobs').set({ status: 'cancelled' }).where('status', 'in', ['queued', 'running', 'paused', 'ready']).execute();
});

const claim = { workerId: 'checkpoint-worker', attempt: 1n, token: 'request-claim' };
const metadata = { firstContentMs: 10, responseMs: 20, usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
  responseId: 'mock-response', responseModel: 'mock-model' };
const warrantyLabels: WarrantyLabels = {
  subscription_warranty: 6, subscription_warranty_t: 'hour',
  usage_warranty: null, usage_warranty_t: 'first_login',
};
const noWarranty: WarrantyLabels = {
  subscription_warranty: null, subscription_warranty_t: null,
  usage_warranty: null, usage_warranty_t: null,
};

async function fixture(count = 1, evidence?: string, stage: 'warranty' | 'extract' | 'review' = 'extract',
  warrantyEligible = stage === 'warranty') {
  const shop = await db.insertInto('shops').values({ platform: 'test', name: 'test', url: `https://test.invalid/${Math.random()}`, enabled: true }).returningAll().executeTakeFirstOrThrow();
  const payload = { name: 'ChatGPT Plus', spec: '1\u4e2a\u6708', sourceData: evidence === undefined ? {} : { evidence }, warrantyEligible,
    shopSource: { url: shop.url, protocol: shop.protocol, platform: shop.platform } };
  const fingerprint = productContentFingerprint({ ...payload, sourceCategory: '' });
  const products = await db.insertInto('products').values(Array.from({ length: count }, (_, index) => ({
    shop_id: shop.id, external_id: String(index), ...{ name: payload.name, spec: payload.spec }, source_category: '',
    source_data: jsonb(payload.sourceData), normalized_key: `checkpoint-${index}`, url: 'https://test.invalid/p',
    content_version: 1n, content_fingerprint: fingerprint,
  }))).returningAll().execute();
  const job = await db.insertInto('ai_jobs').values({
    total: BigInt(count), model: 'mock', job_type: 'tag_extraction', status: 'running',
    prompt_version: STANDARDIZATION_PROMPT_VERSION, rule_version: STANDARDIZATION_POLICY_VERSION,
    pipeline_versions: jsonb(pipelineVersionSnapshot('mock')),
  }).returning('id').executeTakeFirstOrThrow();
  const inputId = products[0]!.id;
  await db.insertInto('ai_job_inputs').values({ job_id: job.id, input_id: inputId, payload: jsonb(payload),
    fingerprint, content_version: 1n, input_bytes: 100n, estimated_tokens: 100n }).execute();
  await db.insertInto('ai_job_input_members').values(products.map(product => ({
    job_id: job.id, input_id: inputId, product_id: product.id, fingerprint, payload: jsonb(payload),
    content_version: 1n, standardization_revision: product.standardization_revision,
  }))).execute();
  const standard = await db.insertInto('standard_products').values({
    name: 'test', canonical_family: 'openai', canonical_product: 'chatgpt',
    canonical_tier: warrantyEligible ? 'plus' : 'free', verification_state: 'verified',
  }).returning('id').executeTakeFirstOrThrow();
  await db.insertInto('standard_product_members').values(products.map(product => ({
    product_id: product.id, standard_product_id: standard.id, assignment_source: 'ai' as const, publication_state: 'published' as const,
  }))).execute();
  const batch = await db.insertInto('ai_job_batches').values({
    job_id: job.id, batch_index: 0n, product_ids: jsonb([String(inputId)]), product_count: BigInt(count),
    step: 'request', status: 'running', claimed_by: claim.workerId, attempts: claim.attempt,
    claim_token: claim.token, lease_until: new Date(Date.now() + 60000), request_budget_used: 1, request_budget_limit: 2,
    ...(stage === 'review' ? { reference_snapshot: jsonb({ tagStage: 'review', tagRepairRound: 1 }) } : {}),
    ...(stage === 'warranty' ? { reference_snapshot: jsonb({
      tagStage: 'warranty', strategyVersion: 'approved-candidate-20261119-v1', catalogVersion: '0', candidates: [],
      inputs: [{ id: String(inputId), candidateStandardProductIds: [], stats: { scanned: 0, compared: 0, truncated: false } }],
    }) } : {}),
  }).returning('id').executeTakeFirstOrThrow();
  const decision = validateReviewedTagExtractionDecision(inputId, [
    { name: 'duration', value: 30, evidence: [], proposalIndex: 0 },
    { name: 'unknown', value: 'no', evidence: [], proposalIndex: 1 },
  ], [], payload, [true, true], true);
  return { job, batch, inputId, products, decision, payload, repo: new AiRepository(db) };
}
async function batchRow(id: bigint) {
  return db.selectFrom('ai_job_batches').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
}
async function claimPublish(id: bigint, token = 'publish-claim') {
  await db.updateTable('ai_job_batches').set({
    status: 'running', claimed_by: claim.workerId, attempts: 1n, claim_token: token, lease_until: new Date(Date.now() + 60000),
  }).where('id', '=', id).execute();
  return { ...claim, token };
}

async function warrantyReviewFixture(count = 1, labels = warrantyLabels) {
  const f = await fixture(count, undefined, 'warranty');
  const next = () => db.selectFrom('ai_job_batches').selectAll().where('job_id', '=', f.job.id)
    .orderBy('batch_index', 'desc').executeTakeFirstOrThrow();
  await f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id,
    [{ productId: f.inputId, tags: [], rejectedTags: [], warrantyLabels: labels }], metadata, claim, 'warranty');
  const extraction = await next();
  await claimPublish(extraction.id, claim.token);
  await db.updateTable('ai_job_batches').set({ request_budget_used: 1 }).where('id', '=', extraction.id).execute();
  await f.repo.checkpointTagExtractionBatchDecision(f.job.id, extraction.id,
    [{ productId: f.inputId, tags: [], rejectedTags: [] }], metadata, claim, 'extract');
  const review = await next();
  await claimPublish(review.id, claim.token);
  await db.updateTable('ai_job_batches').set({ request_budget_used: 1,
    reference_snapshot: jsonb({ ...(review.reference_snapshot as Record<string, JsonValue>), tagRepairRound: 1 }),
  }).where('id', '=', review.id).execute();
  return { ...f, batch: review };
}

test('warranty labels survive general review, repair, stale claims and atomic publication retry for deduplicated members', async () => {
  const source = '订阅质保6小时，使用仅保首登。会员30天。';
  const f = await fixture(2, source, 'warranty');
  const next = async () => db.selectFrom('ai_job_batches').selectAll().where('job_id', '=', f.job.id)
    .orderBy('batch_index', 'desc').executeTakeFirstOrThrow();
  const responses = [
    warrantyLabels,
    { items: [{ id: String(f.inputId), tags: [{ name: 'duration', value: 60 }] }] },
    { items: [{ id: String(f.inputId), feedback: '使用期限应为30天。', accepted: [false], complete: false }] },
    { items: [{ id: String(f.inputId), tags: [{ name: 'duration', value: 30 }] }] },
    { items: [{ id: String(f.inputId), feedback: '', accepted: [true], complete: true }] },
  ];
  let sends = 0;
  const call = createOpenAiModelCall(f.repo, {
    AI_BASE_URL: 'https://mock.invalid/v1', AI_API_KEY: 'mock', AI_MODEL: 'mock',
  }, async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    assert.equal(request.stream, true);
    const sent = JSON.parse(request.messages[1].content);
    const inputs = Array.isArray(sent) ? sent : sent.inputs;
    assert.equal(inputs.length, 1, 'deduplicated members share one warranty input');
    assert.equal(inputs[0].id, String(f.inputId));
    assert.equal(inputs[0].sourceData.evidence, source);
    assert.equal(inputs[0].warrantyEligible, undefined);
    if (sends === 0) {
      assert.deepEqual(Object.keys(sent), ['inputs']);
      assert.equal(request.temperature, 0.2);
    } else {
      assert.doesNotMatch(JSON.stringify(request.messages), /warrantyLabels|subscription_warranty|usage_warranty|warranty_terms/);
      if (sends === 2 || sends === 4) {
        assert.deepEqual(sent.proposals.items[0].tags, [{ name: 'duration', value: sends === 2 ? 60 : 30 }]);
        assert.equal(sent.proposals.items[0].candidateCount, 1);
      }
      if (sends === 3) assert.deepEqual(sent.previousDecisions, [{
        id: String(f.inputId), draft: [{ name: 'duration', value: 60 }], feedback: '使用期限应为30天。',
      }]);
    }
    const content = JSON.stringify(responses[sends++]);
    return new Response([
      { choices: [{ delta: { content: content.slice(0, 20) } }] },
      { choices: [{ delta: { content: content.slice(20) }, finish_reason: 'stop' }] },
    ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n');
  });
  for (const stage of ['warranty', 'extract', 'review', 'repair', 'review'] as const) {
    const batch = await next();
    const inputs = await f.repo.getTagExtractionBatchInputs(batch.id);
    assert.equal(inputs.stage, stage);
    assert.equal(inputs.inputs.length, 1);
    assert.equal((inputs.inputs[0]!.payload as any).warrantyEligible, true);
    if (stage !== 'warranty') {
      assert.deepEqual(inputs.warrantyLabels, warrantyLabels);
      assert.equal((batch.reference_snapshot as any).warrantyBatchId, String(f.batch.id));
      assert.equal(batch.request_budget_used, 0);
    }
    await f.repo.prepareBatch(batch.id);
    const batchClaim = await claimPublish(batch.id, `warranty-${sends}`);
    await db.updateTable('ai_job_batches').set({ request_budget_used: 1 }).where('id', '=', batch.id).execute();
    const result = await call({ id: batch.id, row: { job_type: 'tag_extraction', step: 'request' } }, new AbortController().signal);
    assert.deepEqual(result.tagExtractionItems![0]!.warrantyLabels,
      stage === 'warranty' || stage === 'review' ? warrantyLabels : undefined);
    await f.repo.checkpointTagExtractionBatchDecision(f.job.id, batch.id, result.tagExtractionItems!, result.metadata, batchClaim, stage);
    assert.equal((await db.selectFrom('product_tags').selectAll().where('product_id', 'in', f.products.map(p => p.id)).execute()).length, 0);
    assert.ok((await db.selectFrom('ai_job_input_members').select('output').where('job_id', '=', f.job.id).execute()).every(m => m.output === null));
  }
  assert.equal(sends, 5);
  const saved = await batchRow(f.batch.id);
  assert.equal(saved.step, 'done');
  assert.equal(saved.status, 'succeeded');
  assert.equal(saved.confirmed_requests, 1);
  assert.deepEqual(saved.validated_decision, { items: [{
    productId: String(f.inputId), tags: [], rejectedTags: [], warrantyLabels,
  }] });
  const finalReview = await next();
  assert.equal(finalReview.step, 'publish');
  assert.deepEqual((finalReview.validated_decision as any).items[0].warrantyLabels, warrantyLabels);
  const before = f.products.flatMap(product => [
    { product_id: product.id, name: 'duration', value: 360 },
    { product_id: product.id, name: 'usage_warranty', value: '质保 1 天' },
  ]);
  await db.insertInto('product_tags').values(tagRows(before)).execute();
  const publishClaim = await claimPublish(finalReview.id);
  const claimed = await batchRow(finalReview.id);
  for (const staleClaim of [
    { ...publishClaim, workerId: 'old-worker' },
    { ...publishClaim, attempt: 0n },
    { ...publishClaim, token: 'old-token' },
  ]) {
    await assert.rejects(f.repo.publishTagExtractionBatch(finalReview.id, staleClaim), /stale batch/);
    assert.deepEqual(await batchRow(finalReview.id), claimed);
  }
  await db.updateTable('ai_job_batches').set({ lease_until: new Date(0) }).where('id', '=', finalReview.id).execute();
  await assert.rejects(f.repo.publishTagExtractionBatch(finalReview.id, publishClaim), /stale batch lease/);
  await claimPublish(finalReview.id);
  const cacheBefore = await db.selectFrom('catalog_cache_versions').selectAll().execute();
  await sql`create function fail_warranty_publication() returns trigger language plpgsql as $$
    begin
      if new.product_id = ${sql.raw(String(f.products[1]!.id))} and new.name = 'usage_warranty' then
        raise exception 'warranty publication unavailable';
      end if;
      return new;
    end $$`.execute(db);
  await sql`create trigger fail_warranty_publication before insert on product_tags
    for each row execute function fail_warranty_publication()`.execute(db);
  try {
    await assert.rejects(f.repo.publishTagExtractionBatch(finalReview.id, publishClaim), /warranty publication unavailable/);
    assert.deepEqual(await db.selectFrom('product_tags').select(['product_id', 'name', 'value'])
      .where('product_id', 'in', f.products.map(product => product.id)).orderBy('product_id').orderBy('name').execute(), before);
    assert.ok((await db.selectFrom('ai_job_input_members').select('output').where('job_id', '=', f.job.id).execute())
      .every(member => member.output === null));
    assert.deepEqual(await db.selectFrom('catalog_cache_versions').selectAll().execute(), cacheBefore);
    const failed = await batchRow(finalReview.id);
    assert.equal(failed.step, 'publish');
    assert.equal(failed.confirmed_requests, 1);
    assert.deepEqual(failed.validated_decision, finalReview.validated_decision);
    assert.equal(sends, 5);
  } finally {
    await sql`drop trigger fail_warranty_publication on product_tags`.execute(db);
    await sql`drop function fail_warranty_publication()`.execute(db);
  }
  await new AiRepository(db).publishTagExtractionBatch(finalReview.id, publishClaim);
  assert.equal(sends, 5, 'publication retry reuses saved labels without a model request');
  const expected = [
    { name: 'duration', value: 30 },
    { name: 'subscription_warranty', value: '质保 6 小时' },
    { name: 'usage_warranty', value: '首登' },
  ];
  for (const product of f.products) {
    assert.deepEqual(await db.selectFrom('product_tags').select(['name', 'value']).where('product_id', '=', product.id)
      .orderBy('name').execute(), expected);
    const { output } = await db.selectFrom('ai_job_input_members').select('output').where('job_id', '=', f.job.id)
      .where('product_id', '=', product.id).executeTakeFirstOrThrow();
    assert.deepEqual((output as any).warrantyLabels, warrantyLabels);
    assert.deepEqual((output as any).review.decisions, [true], 'general review votes cover only duration');
    assert.deepEqual((output as any).acceptedTags.slice(1), expected.slice(1).map(tag => ({ ...tag, evidence: [] })));
    assert.deepEqual((output as any).attempts.map((attempt: any) => attempt.reviewDecisions), [[false], [true]]);
  }
  assert.equal((await db.selectFrom('ai_job_batches').select('id').where('job_id', '=', f.job.id).execute()).length, 5);
  assert.deepEqual((await batchRow(f.batch.id)).validated_decision, saved.validated_decision);
});

for (const unavailable of ['disabled shop', 'deleted products', 'free identity', 'unverified identity', 'merged identity'] as const) {
  test(`unavailable warranty singleton with ${unavailable} prepares then skips without provider calls or budget use`, async () => {
    const f = await fixture(2, '订阅质保6小时。', 'warranty');
    const before = [{ name: 'duration', value: 360 }, { name: 'usage_warranty', value: '质保 1 天' }];
    await db.insertInto('product_tags').values(tagRows(f.products.flatMap(product =>
      before.map(tag => ({ ...tag, product_id: product.id }))))).execute();
    await db.updateTable('ai_job_batches').set({ status: 'queued', attempts: 0n, claimed_by: null,
      claim_token: null, lease_until: null, request_budget_used: 0 }).where('id', '=', f.batch.id).execute();
    if (unavailable === 'disabled shop') {
      await db.updateTable('shops').set({ enabled: false }).where('id', '=', f.products[0]!.shop_id).execute();
    } else if (unavailable === 'deleted products') {
      await db.updateTable('products').set({ deleted_at: new Date() }).where('id', 'in', f.products.map(product => product.id)).execute();
    } else {
      const assignment = await db.selectFrom('standard_product_members').select('standard_product_id')
        .where('product_id', '=', f.inputId).executeTakeFirstOrThrow();
      if (unavailable === 'free identity') {
        await db.updateTable('standard_products').set({ canonical_tier: 'free' }).where('id', '=', assignment.standard_product_id).execute();
      } else if (unavailable === 'unverified identity') {
        await db.updateTable('standard_products').set({ verification_state: 'provisional' }).where('id', '=', assignment.standard_product_id).execute();
      } else {
        const target = await db.insertInto('standard_products').values({
          name: 'Merge target', canonical_family: 'openai', canonical_product: 'chatgpt',
          canonical_tier: 'plus', verification_state: 'verified',
        }).returning('id').executeTakeFirstOrThrow();
        await db.updateTable('standard_products').set({ merged_into_id: target.id }).where('id', '=', assignment.standard_product_id).execute();
      }
      assert.deepEqual(await db.selectFrom('products').select(['id', 'standardization_revision'])
        .where('id', 'in', f.products.map(product => product.id)).orderBy('id').execute(),
      f.products.map(product => ({ id: product.id, standardization_revision: product.standardization_revision })));
    }
    const inputs = (await f.repo.getTagExtractionBatchInputs(f.batch.id)).inputs;
    assert.equal(inputs.length, unavailable === 'disabled shop' || unavailable === 'deleted products' ? 0 : 1);
    const events: string[] = [], failures: string[] = [];
    let providerCalls = 0;
    const prepareBatch = f.repo.prepareBatch.bind(f.repo);
    f.repo.prepareBatch = async (...args) => { await prepareBatch(...args); events.push('batch prepared'); };
    const reserve = f.repo.reserveBatchRequest.bind(f.repo);
    f.repo.reserveBatchRequest = async (...args) => {
      const result = await reserve(...args);
      events.push(`reserve ${result}`);
      return result;
    };
    const modelCall = createOpenAiModelCall(f.repo, {
      AI_BASE_URL: 'https://mock.invalid/v1', AI_API_KEY: 'mock', AI_MODEL: 'mock',
    }, async () => { providerCalls++; assert.fail('unavailable warranty input must never call the provider'); });
    const prepareModel = modelCall.prepare!;
    modelCall.prepare = async (...args) => {
      const execute = await prepareModel(...args);
      events.push('model prepared');
      return execute;
    };
    const jobs = new JobsRepository(db), settled = Promise.withResolvers<void>();
    const worker = createAiWorker({
      claimNext: jobs.claimNext.bind(jobs), heartbeat: jobs.heartbeat.bind(jobs), complete: jobs.complete.bind(jobs),
      requeue: jobs.requeue.bind(jobs),
      fail: async (kind, id, workerId, error, options) => { failures.push(error); await jobs.fail(kind, id, workerId, error, options); },
      onSettled: () => settled.resolve(),
    }, { repository: f.repo, workerId: 'unavailable-warranty-worker', concurrency: 1, modelCall });
    try {
      assert.equal(await worker.runOnce(), 1);
      await settled.promise;
      assert.equal(await worker.runOnce(), 0);
    } finally { await worker.stop(); }
    assert.deepEqual(failures, []);
    assert.deepEqual(events, ['batch prepared', 'model prepared', 'reserve skipped']);
    assert.equal(providerCalls, 0);
    const batch = await batchRow(f.batch.id);
    assert.equal(batch.step, 'done');
    assert.equal(batch.status, 'succeeded');
    assert.equal(batch.request_budget_used, 0);
    assert.equal(batch.confirmed_requests, 0);
    assert.equal(batch.unknown_requests, 0);
    assert.equal(batch.validated_decision, null);
    assert.deepEqual(batch.product_ids, []);
    assert.equal((await db.selectFrom('ai_job_batches').select('id').where('job_id', '=', f.job.id).execute()).length, 1);
    const members = await db.selectFrom('ai_job_input_members').select(['product_id', 'payload', 'reason_code', 'output'])
      .where('job_id', '=', f.job.id).execute();
    assert.equal(members.length, 2);
    const reason = unavailable === 'free identity' ? 'revision_changed'
      : unavailable === 'unverified identity' || unavailable === 'merged identity' ? 'not_published' : 'source_unavailable';
    for (const member of members) {
      assert.deepEqual(member.payload, f.payload);
      assert.equal(member.reason_code, reason);
      const output = member.output as any;
      assert.equal(output.outcome, 'skipped');
      assert.equal(output.reasonCode, reason);
      assert.deepEqual(output.before, before);
      assert.deepEqual(output.after, before);
      assert.deepEqual(output.diff, []);
      assert.equal(output.versions.contentVersion, '1');
      assert.equal(output.warrantyLabels, undefined, 'no result is invented for a skipped warranty request');
      assert.deepEqual(await db.selectFrom('product_tags').select(['name', 'value']).where('product_id', '=', member.product_id)
        .orderBy('name').execute(), before);
    }
  });
}

test('queued warranty skips its free alias before reservation while its paid dedup peer completes the worker pipeline', async () => {
  const f = await fixture(2, '订阅质保6小时，使用仅保首登。会员30天。', 'warranty');
  const first = f.products[0]!, second = f.products[1]!;
  const assignment = await db.selectFrom('standard_product_members').select('standard_product_id')
    .where('product_id', '=', first.id).executeTakeFirstOrThrow();
  const paid = await db.insertInto('standard_products').values({
    name: 'Paid dedup peer', canonical_family: 'openai', canonical_product: 'chatgpt',
    canonical_tier: 'plus', verification_state: 'verified',
  }).returning('id').executeTakeFirstOrThrow();
  await db.updateTable('standard_product_members').set({ standard_product_id: paid.id }).where('product_id', '=', second.id).execute();
  await db.updateTable('standard_products').set({ canonical_tier: 'free' }).where('id', '=', assignment.standard_product_id).execute();
  const before = [{ name: 'duration', value: 360 }, { name: 'usage_warranty', value: '质保 1 天' }];
  await db.insertInto('product_tags').values(tagRows(f.products.flatMap(product =>
    before.map(tag => ({ ...tag, product_id: product.id }))))).execute();
  await db.updateTable('ai_job_batches').set({ status: 'queued', attempts: 0n, claimed_by: null,
    claim_token: null, lease_until: null, request_budget_used: 0 }).where('id', '=', f.batch.id).execute();
  const responses = [
    warrantyLabels,
    { items: [{ id: String(f.inputId), tags: [{ name: 'duration', value: 30 }] }] },
    { items: [{ id: String(f.inputId), feedback: '', accepted: [true], complete: true }] },
  ];
  let providerCalls = 0, settled = Promise.withResolvers<void>();
  let skipped: JsonValue | undefined;
  const failures: string[] = [], reservations: string[] = [];
  const reserve = f.repo.reserveBatchRequest.bind(f.repo);
  f.repo.reserveBatchRequest = async (...args) => {
    const outcome = await reserve(...args);
    reservations.push(outcome);
    return outcome;
  };
  const modelCall = createOpenAiModelCall(f.repo, {
    AI_BASE_URL: 'https://mock.invalid/v1', AI_API_KEY: 'mock', AI_MODEL: 'mock',
  }, async (_url, init) => {
    const member = await db.selectFrom('ai_job_input_members').select(['reason_code', 'output'])
      .where('job_id', '=', f.job.id).where('product_id', '=', first.id).executeTakeFirstOrThrow();
    assert.equal(member.reason_code, 'revision_changed', 'the free alias must be skipped before any provider request');
    assert.equal((member.output as any).outcome, 'skipped');
    if (skipped === undefined) skipped = member.output;
    else assert.deepEqual(member.output, skipped);
    const request = JSON.parse(String(init?.body));
    assert.equal(request.stream, true);
    const payload = JSON.parse(request.messages[1].content);
    const inputs = Array.isArray(payload) ? payload : payload.inputs;
    assert.equal(inputs.length, 1, 'the paid peer keeps the unique frozen input');
    assert.equal(inputs[0].id, String(f.inputId));
    const response = responses[providerCalls++];
    assert.ok(response, 'only warranty, extraction and review may call the provider');
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(response) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  const jobs = new JobsRepository(db);
  const worker = createAiWorker({
    claimNext: jobs.claimNext.bind(jobs), heartbeat: jobs.heartbeat.bind(jobs), complete: jobs.complete.bind(jobs),
    requeue: jobs.requeue.bind(jobs),
    fail: async (kind, id, workerId, error, options) => { failures.push(error); await jobs.fail(kind, id, workerId, error, options); },
    onSettled: () => settled.resolve(),
  }, { repository: f.repo, workerId: 'mixed-scope-warranty-worker', concurrency: 1, modelCall });
  try {
    for (let turn = 0; turn < 4; turn++) {
      settled = Promise.withResolvers<void>();
      assert.equal(await worker.runOnce(), 1);
      await settled.promise;
      assert.deepEqual(failures, []);
      assert.equal(providerCalls, Math.min(turn + 1, 3));
    }
    assert.equal(await worker.runOnce(), 0);
  } finally { await worker.stop(); }
  assert.deepEqual(reservations, ['reserved', 'reserved', 'reserved']);
  const batches = await db.selectFrom('ai_job_batches').selectAll().where('job_id', '=', f.job.id).execute();
  assert.equal(batches.length, 3);
  for (const batch of batches) {
    assert.equal(batch.request_budget_used, 1);
    assert.equal(batch.confirmed_requests, 1);
    assert.equal(batch.unknown_requests, 0);
    assert.equal(batch.step, 'done');
  }
  assert.deepEqual(await db.selectFrom('product_tags').select(['name', 'value']).where('product_id', '=', first.id).orderBy('name').execute(), before);
  const members = await db.selectFrom('ai_job_input_members').select(['input_id', 'reason_code', 'output'])
    .where('job_id', '=', f.job.id).orderBy('product_id').execute();
  assert.deepEqual(members.map(member => member.input_id), [f.inputId, f.inputId]);
  assert.deepEqual(members[0]!.output, skipped, 'later checkpoints and publication preserve the early skip audit');
  assert.deepEqual((members[0]!.output as any).before, before);
  assert.deepEqual((members[0]!.output as any).after, before);
  assert.deepEqual((members[0]!.output as any).diff, []);
  assert.equal(members[1]!.reason_code, null);
  assert.equal((members[1]!.output as any).outcome, 'updated');
  assert.deepEqual((members[1]!.output as any).warrantyLabels, warrantyLabels);
  assert.deepEqual(await db.selectFrom('product_tags').select(['name', 'value']).where('product_id', '=', second.id).orderBy('name').execute(), [
    { name: 'duration', value: 30 },
    { name: 'subscription_warranty', value: '质保 6 小时' },
    { name: 'usage_warranty', value: '首登' },
  ]);
});

test('warranty sources reject foreign, missing, incomplete and malformed checkpoints and retain labels for unavailable inputs', async () => {
  const f = await fixture(1, '首登包换', 'warranty');
  const item = { productId: String(f.inputId), tags: [], rejectedTags: [], warrantyLabels };
  await f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id,
    [{ ...item, productId: f.inputId }], {}, claim, 'warranty');
  const child = await db.selectFrom('ai_job_batches').selectAll().where('job_id', '=', f.job.id).where('id', '!=', f.batch.id).executeTakeFirstOrThrow();
  const foreign = await fixture(1, '其他商品', 'warranty');
  await foreign.repo.checkpointTagExtractionBatchDecision(foreign.job.id, foreign.batch.id,
    [{ ...item, productId: foreign.inputId }], {}, claim, 'warranty');
  for (const sourceId of [String(foreign.batch.id), '999999999999', 'invalid', null]) {
    await db.updateTable('ai_job_batches').set({ reference_snapshot: jsonb({
      ...(child.reference_snapshot as Record<string, JsonValue>), warrantyBatchId: sourceId,
    }) }).where('id', '=', child.id).execute();
    await assert.rejects(f.repo.getTagExtractionBatchInputs(child.id));
  }
  await db.updateTable('ai_job_batches').set({ reference_snapshot: jsonb(child.reference_snapshot!) }).where('id', '=', child.id).execute();
  const saved = await batchRow(f.batch.id);
  for (const change of [
    { status: 'running' as const },
    { step: 'request' as const },
    { reference_snapshot: jsonb({ tagStage: 'extract' }) },
    { validated_decision: jsonb({ items: [] }) },
    { validated_decision: jsonb({ items: [item, item] }) },
    { validated_decision: jsonb({ items: [{ ...item, productId: String(f.inputId + 1n) }] }) },
    { validated_decision: jsonb({ items: [{ ...item, warrantyLabels: null }] }) },
    { validated_decision: jsonb({ items: [{ ...item, warrantyLabels: { ...warrantyLabels, usage_warranty: 6 } }] }) },
    { validated_decision: jsonb({ items: [{ ...item, warrantyLabels: { ...warrantyLabels, extra: null } }] }) },
  ]) {
    await db.updateTable('ai_job_batches').set(change).where('id', '=', f.batch.id).execute();
    await assert.rejects(f.repo.getTagExtractionBatchInputs(child.id));
    await db.updateTable('ai_job_batches').set({ status: saved.status, step: saved.step, reference_snapshot: jsonb(saved.reference_snapshot!),
      validated_decision: jsonb(saved.validated_decision!) }).where('id', '=', f.batch.id).execute();
  }
  await db.updateTable('products').set({ deleted_at: new Date() }).where('id', '=', f.inputId).execute();
  const unavailable = await f.repo.getTagExtractionBatchInputs(child.id);
  assert.deepEqual(unavailable.inputs, []);
  assert.deepEqual(unavailable.warrantyLabels, warrantyLabels, 'availability guards must not discard the frozen warranty result');
});

test('warranty rejects invalid labels, mismatched IDs and stale claims before storing or enqueueing', async () => {
  const f = await fixture(1, '首登包换', 'warranty');
  const item = { productId: f.inputId, tags: [], rejectedTags: [], warrantyLabels };
  for (const items of [[], [item, item], [{ ...item, productId: f.inputId + 1n }],
    [{ ...item, warrantyLabels: undefined }],
    [{ ...item, warrantyLabels: { ...warrantyLabels, subscription_warranty: 0 } }],
    [{ ...item, warrantyLabels: { ...warrantyLabels, usage_warranty: 6 } }],
    [{ ...item, tags: [{ name: 'duration', value: 30, evidence: [] }] }],
    [{ ...item, rejectedTags: [{ name: 'duration', value: 30, evidence: [], reasonCode: 'review_rejected', reason: 'No' }] }]]) {
    await assert.rejects(f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id, items, {}, claim, 'warranty'));
  }
  await db.updateTable('ai_job_batches').set({ product_ids: jsonb([String(f.inputId), String(f.inputId + 1n)]) })
    .where('id', '=', f.batch.id).execute();
  await assert.rejects(f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id,
    [item, { ...item, productId: f.inputId + 1n }], {}, claim, 'warranty'), /Invalid warranty checkpoint/);
  await db.updateTable('ai_job_batches').set({ product_ids: jsonb([String(f.inputId)]) }).where('id', '=', f.batch.id).execute();
  await db.updateTable('ai_job_inputs').set({ payload: jsonb({ ...f.payload, warrantyEligible: false }) })
    .where('job_id', '=', f.job.id).execute();
  await assert.rejects(f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id, [item], {}, claim, 'warranty'), /AI membership/);
  await db.updateTable('ai_job_inputs').set({ payload: jsonb(f.payload) }).where('job_id', '=', f.job.id).execute();
  await assert.rejects(f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id, [item], {}, { ...claim, token: 'stale' }, 'warranty'), /stale/);
  await db.updateTable('ai_jobs').set({ cancel_requested: true }).where('id', '=', f.job.id).execute();
  await assert.rejects(f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id, [item], {}, claim, 'warranty'), /cannot checkpoint/);
  assert.equal((await batchRow(f.batch.id)).validated_decision, null);
  assert.equal((await batchRow(f.batch.id)).confirmed_requests, 0);
  assert.equal((await db.selectFrom('ai_job_batches').select('id').where('job_id', '=', f.job.id).execute()).length, 1);
});

test('extraction checkpoints and enqueues exactly one review before any member result or product write', async () => {
  const f = await fixture(2);
  await f.repo.prepareBatch(f.batch.id);
  await f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id, [f.decision], metadata, claim, 'extract');
  const extraction = await batchRow(f.batch.id);
  assert.equal(extraction.step, 'done');
  assert.equal(extraction.status, 'succeeded');
  assert.equal(extraction.confirmed_requests, 1);
  assert.ok(extraction.validated_decision);
  assert.ok(extraction.finished_at);
  const review = await db.selectFrom('ai_job_batches').selectAll().where('job_id', '=', f.job.id).where('id', '!=', f.batch.id).executeTakeFirstOrThrow();
  assert.equal(review.step, 'request');
  assert.equal(review.status, 'queued');
  assert.equal(review.batch_index, extraction.batch_index + 1n);
  assert.equal(review.round, 1);
  assert.equal(review.request_budget_limit, 2);
  assert.equal(review.request_budget_used, 0);
  assert.equal(review.attempts, 0n);
  assert.deepEqual(review.product_ids, extraction.product_ids);
  assert.equal(review.product_count, extraction.product_count);
  const reference = review.reference_snapshot as Record<string, unknown>;
  assert.equal(reference.tagStage, 'review');
  assert.equal(reference.extractionBatchId, String(f.batch.id));
  assert.deepEqual(reference.inputs, [{ id: String(f.inputId), candidateStandardProductIds: [], stats: { scanned: 0, compared: 0, truncated: false } }]);
  assert.deepEqual(reference.candidates, []);
  const restored = await new AiRepository(db).getTagExtractionBatchInputs(review.id);
  assert.equal(restored.stage, 'review');
  assert.deepEqual(restored.proposals, { items: [{ id: String(f.inputId), tags: [
    { name: 'duration', value: 30 },
    { name: 'unknown', value: 'no' },
  ] }] });
  const members = await db.selectFrom('ai_job_input_members').select('output').where('job_id', '=', f.job.id).execute();
  assert.ok(members.every(member => member.output === null));
  assert.equal((await db.selectFrom('product_tags').selectAll().where('product_id', 'in', f.products.map(product => product.id)).execute()).length, 0);
  await assert.rejects(f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id, [f.decision], metadata, claim, 'extract'), /stale batch/);
  assert.equal((await db.selectFrom('ai_job_batches').select('id').where('job_id', '=', f.job.id).execute()).length, 2);
  await db.updateTable('ai_job_batches').set({ status: 'cancelled' }).where('id', '=', review.id).execute();
});

test('review is claimable and reservable while a prior extraction still occupies its rolling window', async () => {
  const previousConcurrency = process.env.AI_CONCURRENCY;
  process.env.AI_CONCURRENCY = '1';
  const f = await fixture();
  f.decision.rejectedTags = [];
  f.decision.reviewDecisions = [true];
  try {
    await f.repo.prepareBatch(f.batch.id);
    const blocker = await db.insertInto('ai_job_batches').values({
      job_id: f.job.id, batch_index: 1n, product_ids: jsonb([]), product_count: 0n, round: 0,
      status: 'running', claimed_by: 'other-worker', claim_token: 'other-claim', lease_until: new Date(Date.now() + 60000),
    }).returning('id').executeTakeFirstOrThrow();
    await f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id, [f.decision], metadata, claim, 'extract');
    const jobs = new JobsRepository(db);
    const claimed = await jobs.claimAvailable('ai_standardization', 'review-worker', 1);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]!.row.job_id, f.job.id);
    assert.equal(claimed[0]!.row.round, 1);
    const reviewClaim = { workerId: claimed[0]!.claimed_by, attempt: claimed[0]!.attempts, token: String(claimed[0]!.row.claim_token) };
    await f.repo.prepareBatch(claimed[0]!.id);
    assert.equal(await f.repo.reserveBatchRequest(claimed[0]!.id, reviewClaim), 'reserved');
    const restored = await f.repo.getTagExtractionBatchInputs(claimed[0]!.id);
    assert.equal(restored.stage, 'review');
    assert.equal(restored.proposals?.items[0]?.id, String(f.inputId));
    const reviewed = { ...f.decision, reviewed: true, complete: true, rejectedTags: [] };
    await f.repo.checkpointTagExtractionBatchDecision(f.job.id, claimed[0]!.id, [reviewed], metadata, reviewClaim, 'review');
    const publication = await jobs.claimAvailable('ai_standardization', 'publisher', 1);
    assert.equal(publication[0]?.id, claimed[0]!.id);
    await f.repo.publishTagExtractionBatch(publication[0]!.id, {
      workerId: publication[0]!.claimed_by, attempt: publication[0]!.attempts, token: String(publication[0]!.row.claim_token),
    });
    assert.equal((await batchRow(claimed[0]!.id)).step, 'done');
    assert.equal((await batchRow(blocker.id)).status, 'running');
  } finally {
    await db.updateTable('ai_jobs').set({ status: 'cancelled' }).where('id', '=', f.job.id).execute();
    if (previousConcurrency === undefined) delete process.env.AI_CONCURRENCY;
    else process.env.AI_CONCURRENCY = previousConcurrency;
  }
});

test('explicit checkpoint stages must match the frozen batch marker; only review can queue publication', async () => {
  const f = await fixture();
  f.decision.rejectedTags = [];
  f.decision.reviewDecisions = [true];
  await assert.rejects(f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id, [f.decision], metadata, claim), /stage/);
  assert.equal((await batchRow(f.batch.id)).confirmed_requests, 0);
  assert.equal((await batchRow(f.batch.id)).validated_decision, null);
  await assert.rejects(f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id, [f.decision], metadata, claim, 'review'), /stage/);
  await assert.rejects(f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id, [], metadata, claim, 'extract'), /does not match/);
  await f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id, [f.decision], metadata, claim, 'extract');
  const review = await db.selectFrom('ai_job_batches').select('id').where('job_id', '=', f.job.id).where('id', '!=', f.batch.id).executeTakeFirstOrThrow();
  const reviewClaim = await claimPublish(review.id, 'review-request-claim');
  await db.updateTable('ai_job_batches').set({ request_budget_used: 1 }).where('id', '=', review.id).execute();
  const reviewed = { ...f.decision, reviewed: true, complete: true, rejectedTags: [] };
  await assert.rejects(f.repo.checkpointTagExtractionBatchDecision(f.job.id, review.id, [reviewed], metadata, reviewClaim, 'extract'), /stage/);
  await assert.rejects(f.repo.checkpointTagExtractionBatchDecision(f.job.id, review.id, [], metadata, reviewClaim, 'review'), /does not match/);
  for (const complete of [undefined, null, 'true', 1]) {
    await assert.rejects(f.repo.checkpointTagExtractionBatchDecision(f.job.id, review.id,
      [{ ...reviewed, complete } as any], metadata, reviewClaim, 'review'), /boolean completeness/);
    assert.equal((await batchRow(review.id)).confirmed_requests, 0);
    assert.equal((await batchRow(review.id)).validated_decision, null);
  }
  await f.repo.checkpointTagExtractionBatchDecision(f.job.id, review.id, [reviewed], metadata, reviewClaim, 'review');
  const publication = await batchRow(review.id);
  assert.equal(publication.step, 'publish');
  assert.equal(publication.confirmed_requests, 1);
  assert.equal((publication.validated_decision as any).items[0].reviewed, true);
  const publishClaim = await claimPublish(review.id);
  await f.repo.publishTagExtractionBatch(review.id, publishClaim);
  assert.equal((await batchRow(review.id)).step, 'done');
  assert.equal((await db.selectFrom('ai_job_batches').select('id').where('job_id', '=', f.job.id).execute()).length, 2);
});

test('streamed review rejects coerced votes and completeness before saving any checkpoint', async () => {
  const f = await fixture();
  f.decision.rejectedTags = [];
  f.decision.reviewDecisions = [true];
  await f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id, [f.decision], metadata, claim, 'extract');
  const review = await db.selectFrom('ai_job_batches').select('id').where('job_id', '=', f.job.id)
    .where('id', '!=', f.batch.id).executeTakeFirstOrThrow();
  const original = await batchRow(review.id);
  for (const invalid of [
    { feedback: '', accepted: ['true'], complete: true },
    { feedback: '', accepted: [true], complete: 'false' },
    { feedback: '', accepted: [true] },
    { feedback: '', accepted: [], complete: true },
  ]) {
    let sends = 0;
    const call = createOpenAiModelCall(f.repo, {
      AI_BASE_URL: 'https://mock.invalid/v1', AI_API_KEY: 'mock-key', AI_MODEL: 'mock',
    }, async () => {
      sends++;
      const content = JSON.stringify({ items: [{ id: String(f.inputId), ...invalid }] });
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
    await assert.rejects(call({ id: review.id, row: { job_id: f.job.id, job_type: 'tag_extraction', step: 'request' } },
      new AbortController().signal), error => Reflect.get(error as object, 'retryClass') === 'invalid_response');
    assert.equal(sends, 1);
    assert.deepEqual(await batchRow(review.id), original);
    assert.equal((await db.selectFrom('ai_job_input_members').select('output').where('job_id', '=', f.job.id).executeTakeFirstOrThrow()).output, null);
    assert.equal((await db.selectFrom('product_tags').select('id').where('product_id', '=', f.inputId).execute()).length, 0);
  }
});

test('complete reviewed empty extraction clears old tags without scheduling repair', async () => {
  const f = await fixture();
  const before = [{ name: 'duration', value: 360 }, { name: 'region', value: 'us' }];
  await db.insertInto('product_tags').values(tagRows(before.map(tag => ({ ...tag, product_id: f.inputId })))).execute();
  const extracted = { productId: f.inputId, tags: [], rejectedTags: [] };
  await f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id, [extracted], metadata, claim, 'extract');
  const review = await db.selectFrom('ai_job_batches').select('id').where('job_id', '=', f.job.id)
    .where('id', '!=', f.batch.id).executeTakeFirstOrThrow();
  const reviewClaim = await claimPublish(review.id);
  await db.updateTable('ai_job_batches').set({ request_budget_used: 1 }).where('id', '=', review.id).execute();
  await f.repo.checkpointTagExtractionBatchDecision(f.job.id, review.id,
    [{ ...extracted, reviewed: true, complete: true, reviewDecisions: [] }], metadata, reviewClaim, 'review');
  await f.repo.publishTagExtractionBatch(review.id, await claimPublish(review.id));
  assert.deepEqual(await db.selectFrom('product_tags').select('id').where('product_id', '=', f.inputId).execute(), []);
  const { output } = await db.selectFrom('ai_job_input_members').select('output').where('job_id', '=', f.job.id).executeTakeFirstOrThrow();
  assert.equal((output as any).outcome, 'empty');
  assert.equal((output as any).complete, true);
  assert.deepEqual((output as any).before, before);
  assert.deepEqual((output as any).after, []);
  assert.deepEqual((output as any).diff, before.map(tag => ({ name: tag.name, before: [tag.value], after: [] })));
  assert.equal((await db.selectFrom('ai_job_batches').select('id').where('job_id', '=', f.job.id).execute()).length, 2);
});

test('publication preserves reviewer rejections instead of semantically accepting them again', async () => {
  const f = await fixture(1, undefined, 'review');
  const reviewed = validateReviewedTagExtractionDecision(f.inputId, [],
    [{ ...f.decision.tags[0]!, reasonCode: 'review_rejected', reason: 'LLM 对该标签判定为否' }], {}, [false], true);
  await f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id, [reviewed], metadata, claim, 'review');
  await f.repo.publishTagExtractionBatch(f.batch.id, await claimPublish(f.batch.id));
  assert.equal((await db.selectFrom('product_tags').selectAll().where('product_id', '=', f.inputId).execute()).length, 0);
  const member = await db.selectFrom('ai_job_input_members').select('output').where('job_id', '=', f.job.id).executeTakeFirstOrThrow();
  assert.equal((member.output as any).outcome, 'failed');
  assert.deepEqual((member.output as any).rejectedTags, reviewed.rejectedTags);
  assert.deepEqual((member.output as any).review, { mode: 'per_tag_binary', decisions: [false] });
});

test('reviewed client passes structural revalidation without inventing citations or a second classification', async () => {
  const f = await fixture(1, '可使用Codex。', 'review');
  const tag = { name: 'supported_client', value: 'codex', evidence: [], proposalIndex: 0 };
  const reviewed = validateReviewedTagExtractionDecision(f.inputId, [tag], [], {}, [true], true);
  assert.equal(reviewed.tags.length, 1);
  await f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id, [reviewed], metadata, claim, 'review');
  await f.repo.publishTagExtractionBatch(f.batch.id, await claimPublish(f.batch.id));
  assert.deepEqual(await db.selectFrom('product_tags').select(['name', 'value']).where('product_id', '=', f.inputId).execute(),
    [{ name: 'supported_client', value: 'codex' }]);
  const member = await db.selectFrom('ai_job_input_members').select('output').where('job_id', '=', f.job.id).executeTakeFirstOrThrow();
  assert.deepEqual((member.output as any).review, { mode: 'per_tag_binary', decisions: [true] });
});

test('all-null warranty labels clear every prior warranty tag and persist for deduplicated members', async () => {
  const f = await warrantyReviewFixture(2, noWarranty);
  const before = [
    { name: 'subscription_warranty', value: '质保 30 天' },
    { name: 'usage_warranty', value: '首登' },
    { name: 'warranty_terms', value: '旧保障条款' },
  ];
  await db.insertInto('product_tags').values(tagRows(f.products.flatMap(product =>
    before.map(tag => ({ ...tag, product_id: product.id }))))).execute();
  const reviewed = { ...validateReviewedTagExtractionDecision(f.inputId, [], [], {}, [], true), warrantyLabels: noWarranty };
  await f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id, [reviewed], metadata, claim, 'review');
  await f.repo.publishTagExtractionBatch(f.batch.id, await claimPublish(f.batch.id));
  assert.deepEqual(await db.selectFrom('product_tags').selectAll().where('product_id', 'in', f.products.map(product => product.id)).execute(), []);
  const members = await db.selectFrom('ai_job_input_members').select('output').where('job_id', '=', f.job.id).execute();
  assert.equal(members.length, 2);
  for (const { output } of members) {
    assert.deepEqual((output as any).warrantyLabels, noWarranty);
    assert.deepEqual((output as any).acceptedTags, []);
    assert.deepEqual((output as any).review.decisions, []);
    assert.equal((output as any).outcome, 'empty');
    assert.deepEqual((output as any).before, before);
    assert.deepEqual((output as any).after, []);
    assert.deepEqual((output as any).diff, before.map(tag => ({ name: tag.name, before: [tag.value], after: [] })));
  }
});

test('general review cannot approve warranty tags or overwrite the independent four-field result', async () => {
  const f = await warrantyReviewFixture();
  const tags = [
    { name: 'subscription_warranty', value: '质保 90 天', evidence: [], proposalIndex: 0 },
    { name: 'usage_warranty', value: '质保 30 天', evidence: [], proposalIndex: 1 },
    { name: 'warranty_terms', value: '通用审查不能生成保障条款', evidence: [], proposalIndex: 2 },
  ];
  const reviewed = { ...validateReviewedTagExtractionDecision(f.inputId, tags, [], f.payload, [true, true, true], true), warrantyLabels };
  assert.deepEqual(reviewed.tags, []);
  assert.deepEqual(reviewed.rejectedTags.map(tag => [tag.name, tag.reasonCode]),
    tags.map(tag => [tag.name, 'tag_name_unknown']));
  await f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id, [reviewed], metadata, claim, 'review');
  await f.repo.publishTagExtractionBatch(f.batch.id, await claimPublish(f.batch.id));
  assert.deepEqual(await db.selectFrom('product_tags').select(['name', 'value']).where('product_id', '=', f.inputId).orderBy('name').execute(), [
    { name: 'subscription_warranty', value: '质保 6 小时' },
    { name: 'usage_warranty', value: '首登' },
  ]);
  const { output } = await db.selectFrom('ai_job_input_members').select('output').where('job_id', '=', f.job.id).executeTakeFirstOrThrow();
  assert.deepEqual((output as any).warrantyLabels, warrantyLabels);
  assert.deepEqual((output as any).rejectedTags, reviewed.rejectedTags);
});

for (const eligible of [true, false]) {
  test(`publication rolls back all members when frozen eligibility ${eligible} disagrees with warranty label presence`, async () => {
    const f = eligible ? await fixture(2, undefined, 'review') : await warrantyReviewFixture(2);
    const before = f.products.map(product => ({ product_id: product.id, name: 'duration', value: 360 }));
    await db.insertInto('product_tags').values(tagRows(before)).execute();
    await db.updateTable('ai_job_input_members').set({ payload: jsonb({ ...f.payload, warrantyEligible: eligible }) })
      .where('job_id', '=', f.job.id).where('product_id', '=', f.products[1]!.id).execute();
    const reviewed = { ...validateReviewedTagExtractionDecision(f.inputId, [f.decision.tags[0]!], [], {}, [true], true),
      ...(!eligible ? { warrantyLabels } : {}) };
    await f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id, [reviewed], metadata, claim, 'review');
    const checkpoint = await batchRow(f.batch.id);
    await assert.rejects(f.repo.publishTagExtractionBatch(f.batch.id, await claimPublish(f.batch.id)), /frozen membership scope/);
    assert.deepEqual(await db.selectFrom('product_tags').select(['product_id', 'name', 'value'])
      .where('product_id', 'in', f.products.map(product => product.id)).orderBy('product_id').execute(), before);
    assert.ok((await db.selectFrom('ai_job_input_members').select('output').where('job_id', '=', f.job.id).execute())
      .every(member => member.output === null));
    assert.deepEqual((await batchRow(f.batch.id)).validated_decision, checkpoint.validated_decision);
  });
}

for (const hasWarrantySource of [true, false]) {
  test(`review checkpoint rejects warranty label presence inconsistent with source ${hasWarrantySource}`, async () => {
    const f = hasWarrantySource ? await warrantyReviewFixture() : await fixture(1, undefined, 'review');
    const reviewed = { ...validateReviewedTagExtractionDecision(f.inputId, [], [], {}, [], true),
      ...(!hasWarrantySource ? { warrantyLabels } : {}) };
    const before = await batchRow(f.batch.id);
    await assert.rejects(f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id, [reviewed], metadata, claim, 'review'),
      /Reviewed warranty labels must match the frozen warranty stage/);
    assert.deepEqual(await batchRow(f.batch.id), before);
    assert.ok((await db.selectFrom('ai_job_input_members').select('output').where('job_id', '=', f.job.id).execute())
      .every(member => member.output === null));
  });
}

test('publication skips a warranty member downgraded to free without a product revision while publishing its paid dedup peer', async () => {
  const f = await warrantyReviewFixture(2);
  const first = f.products[0]!, second = f.products[1]!;
  const firstIdentity = await db.selectFrom('standard_product_members').select('standard_product_id')
    .where('product_id', '=', first.id).executeTakeFirstOrThrow();
  const secondIdentity = await db.insertInto('standard_products').values({
    name: 'Independent paid identity', canonical_family: 'openai', canonical_product: 'chatgpt',
    canonical_tier: 'plus', verification_state: 'verified',
  }).returning('id').executeTakeFirstOrThrow();
  await db.updateTable('standard_product_members').set({ standard_product_id: secondIdentity.id })
    .where('product_id', '=', second.id).execute();
  const before = [{ name: 'duration', value: 360 }, { name: 'usage_warranty', value: '质保 1 天' }];
  await db.insertInto('product_tags').values(tagRows(f.products.flatMap(product =>
    before.map(tag => ({ ...tag, product_id: product.id }))))).execute();
  const reviewed = { ...validateReviewedTagExtractionDecision(f.inputId, [f.decision.tags[0]!], [], f.payload, [true], true), warrantyLabels };
  await f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id, [reviewed], metadata, claim, 'review');
  const publishClaim = await claimPublish(f.batch.id);
  await db.updateTable('standard_products').set({ canonical_tier: 'free' }).where('id', '=', firstIdentity.standard_product_id).execute();
  assert.deepEqual(await db.selectFrom('products').select(['id', 'standardization_revision'])
    .where('id', 'in', [first.id, second.id]).orderBy('id').execute(),
  f.products.map(product => ({ id: product.id, standardization_revision: product.standardization_revision })));
  await f.repo.publishTagExtractionBatch(f.batch.id, publishClaim);
  assert.deepEqual(await db.selectFrom('product_tags').select(['name', 'value']).where('product_id', '=', first.id).orderBy('name').execute(), before);
  assert.deepEqual(await db.selectFrom('product_tags').select(['name', 'value']).where('product_id', '=', second.id).orderBy('name').execute(), [
    { name: 'duration', value: 30 },
    { name: 'subscription_warranty', value: '质保 6 小时' },
    { name: 'usage_warranty', value: '首登' },
  ]);
  const members = await db.selectFrom('ai_job_input_members').select(['input_id', 'reason_code', 'output'])
    .where('job_id', '=', f.job.id).orderBy('product_id').execute();
  assert.deepEqual(members.map(member => member.input_id), [f.inputId, f.inputId]);
  assert.equal(members[0]!.reason_code, 'revision_changed');
  assert.equal((members[0]!.output as any).outcome, 'skipped');
  assert.deepEqual((members[0]!.output as any).after, before);
  assert.deepEqual((members[0]!.output as any).diff, []);
  assert.equal(members[1]!.reason_code, null);
  assert.equal((members[1]!.output as any).outcome, 'updated');
  for (const member of members) assert.deepEqual((member.output as any).warrantyLabels, warrantyLabels);
});

test('accepted ordinary field replaces the complete tag set without a citation check', async () => {
  const f = await fixture(1, '支持Codex。', 'review');
  await db.insertInto('product_tags').values(tagRows([
    { product_id: f.inputId, name: 'supported_client', value: 'claude' },
    { product_id: f.inputId, name: 'region', value: 'us' },
  ])).execute();
  const reviewed = validateReviewedTagExtractionDecision(f.inputId,
    [{ name: 'supported_client', value: 'codex', evidence: [], proposalIndex: 0 }], [], {}, [true], true);
  await f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id, [reviewed], metadata, claim, 'review');
  await f.repo.publishTagExtractionBatch(f.batch.id, await claimPublish(f.batch.id));
  assert.deepEqual(await db.selectFrom('product_tags').select(['name', 'value']).where('product_id', '=', f.inputId).orderBy('name').execute(),
    [{ name: 'supported_client', value: 'codex' }]);
});

test('local publication of only false votes preserves stored tags without model requests or tag writes', async () => {
  const f = await fixture(1, '支持网页，未声明Codex。', 'review');
  const before = [{ name: 'access_channel', value: 'web' }, { name: 'duration', value: 30 }, { name: 'region', value: 'us' }];
  await db.insertInto('product_tags').values(tagRows(before.map(tag => ({ ...tag, product_id: f.inputId })))).execute();
  const reviewed = validateReviewedTagExtractionDecision(f.inputId, [],
    [{ name: 'supported_client', value: 'codex', evidence: [], proposalIndex: 0,
      reasonCode: 'review_rejected', reason: 'LLM 对该标签判定为否' }], {}, [false], true);
  await f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id, [reviewed], metadata, claim, 'review');
  assert.deepEqual(await db.selectFrom('product_tags').select(['name', 'value']).where('product_id', '=', f.inputId).orderBy('name').execute(), before);
  const jobs = new JobsRepository(db);
  let modelCalls = 0, reservations = 0;
  const reserve = f.repo.reserveBatchRequest.bind(f.repo);
  f.repo.reserveBatchRequest = async (...args) => { reservations++; return reserve(...args); };
  const settled = Promise.withResolvers<void>(), failures: string[] = [];
  const worker = createAiWorker({
    claimNext: jobs.claimNext.bind(jobs), heartbeat: jobs.heartbeat.bind(jobs), complete: jobs.complete.bind(jobs),
    requeue: jobs.requeue.bind(jobs),
    fail: async (kind, id, workerId, error, options) => { failures.push(error); await jobs.fail(kind, id, workerId, error, options); },
    onSettled: () => settled.resolve(),
  }, {
    repository: f.repo, workerId: 'rejected-tag-publisher', concurrency: 1,
    modelCall: async () => { modelCalls++; assert.fail('local tag publication must not call a model'); },
  });
  await sql`create function forbid_rejected_tag_write() returns trigger language plpgsql as $$
    begin
      if coalesce(new.product_id, old.product_id) = ${sql.raw(String(f.inputId))} then raise exception 'false votes must not mutate product tags'; end if;
      return null;
    end $$`.execute(db);
  await sql`create trigger forbid_rejected_tag_write before insert or update or delete on product_tags for each row execute function forbid_rejected_tag_write()`.execute(db);
  try { assert.equal(await worker.runOnce(), 1); await settled.promise; } finally {
    await worker.stop();
    await sql`drop trigger forbid_rejected_tag_write on product_tags`.execute(db);
    await sql`drop function forbid_rejected_tag_write()`.execute(db);
  }
  assert.deepEqual(failures, []);
  assert.equal(modelCalls, 0);
  assert.equal(reservations, 0);
  assert.deepEqual(await db.selectFrom('product_tags').select(['name', 'value']).where('product_id', '=', f.inputId).orderBy('name').execute(), before);
  const member = await db.selectFrom('ai_job_input_members').select('output').where('job_id', '=', f.job.id).executeTakeFirstOrThrow();
  const audit = member.output as any;
  assert.deepEqual(audit.acceptedTags, []);
  assert.deepEqual(audit.rejectedTags, reviewed.rejectedTags);
  assert.deepEqual(audit.review, { mode: 'per_tag_binary', decisions: [false] });
  assert.deepEqual(audit.before, before);
  assert.deepEqual(audit.after, before);
  assert.equal('retainedUnconfirmed' in audit, false);
  assert.deepEqual(audit.diff, []);
  assert.equal(audit.outcome, 'failed');
  assert.equal(audit.successfulCount, 0);
  assert.equal(audit.failedCount, 1);
  const done = await batchRow(f.batch.id);
  assert.equal(done.step, 'done');
  assert.equal(done.request_budget_used, 1);
  assert.equal(done.confirmed_requests, 1);
});

for (const stage of ['warranty', 'extract'] as const) test(`${stage} child enqueue failure rolls back checkpoint and request confirmation together`, async () => {
  const f = await fixture(1, '首登包换', stage);
  const nextStage = stage === 'warranty' ? 'extract' : 'review';
  await sql`create function fail_review_enqueue() returns trigger language plpgsql as $$
    begin
      if new.job_id = ${sql.raw(String(f.job.id))} and new.reference_snapshot->>'tagStage' = ${sql.lit(nextStage)} then raise exception 'review enqueue unavailable'; end if;
      return new;
    end $$`.execute(db);
  await sql`create trigger fail_review_enqueue before insert on ai_job_batches for each row execute function fail_review_enqueue()`.execute(db);
  try {
    const item = stage === 'warranty'
      ? { productId: f.inputId, tags: [], rejectedTags: [], warrantyLabels }
      : f.decision;
    await assert.rejects(f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id, [item], metadata, claim, stage), /review enqueue unavailable/);
    const original = await batchRow(f.batch.id);
    assert.equal(original.step, 'request');
    assert.equal(original.confirmed_requests, 0);
    assert.equal(original.validated_decision, null);
    assert.equal((await db.selectFrom('ai_job_batches').select('id').where('job_id', '=', f.job.id).execute()).length, 1);
  } finally {
    await sql`drop trigger fail_review_enqueue on ai_job_batches`.execute(db);
    await sql`drop function fail_review_enqueue()`.execute(db);
  }
});

test('checkpoint durably confirms the request and saves evidence before any product writes; a new repository publishes it', async () => {
  const f = await fixture(1, undefined, 'review');
  await f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id, [f.decision], metadata, claim, 'review');
  const saved = await batchRow(f.batch.id);
  assert.equal(saved.step, 'publish');
  assert.equal(saved.status, 'queued');
  assert.equal(saved.attempts, 0n);
  assert.equal(saved.claim_token, null);
  assert.equal(saved.request_budget_used, 1);
  assert.equal(saved.confirmed_requests, 1);
  assert.equal(saved.unknown_requests, 0);
  assert.ok(saved.decision_saved_at);
  assert.deepEqual(saved.validated_decision, { items: [{ ...f.decision, productId: String(f.inputId) }] });
  assert.deepEqual(saved.response_usage, metadata.usage);
  assert.equal(saved.response_id, metadata.responseId);
  assert.equal((await db.selectFrom('product_tags').selectAll().where('product_id', '=', f.inputId).execute()).length, 0);
  const publicationClaim = await claimPublish(f.batch.id);
  await new AiRepository(db).publishTagExtractionBatch(f.batch.id, publicationClaim);
  const member = await db.selectFrom('ai_job_input_members').select('output').where('job_id', '=', f.job.id).executeTakeFirstOrThrow();
  assert.equal((member.output as any).outcome, 'partial_success');
  assert.equal((member.output as any).acceptedTags.length, 1);
  assert.equal((member.output as any).rejectedTags.length, 1);
  const done = await batchRow(f.batch.id);
  assert.equal(done.step, 'done');
  assert.deepEqual(done.validated_decision, saved.validated_decision);
  assert.deepEqual(done.response_usage, metadata.usage);
});

test('invalid IDs, stale claims and an unresolved request cannot checkpoint or confirm anything', async () => {
  const f = await fixture(1, undefined, 'review');
  for (const items of [[f.decision, f.decision], [{ ...f.decision, productId: 999999999n }]]) {
    await assert.rejects(f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id, items, metadata, claim, 'review'), /does not match/);
  }
  for (const stale of [{ ...claim, token: 'stale' }, { ...claim, attempt: 2n }, { ...claim, workerId: 'other' }]) {
    await assert.rejects(f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id, [f.decision], metadata, stale, 'review'), /stale batch/);
  }
  await db.updateTable('ai_job_batches').set({ unknown_requests: 1 }).where('id', '=', f.batch.id).execute();
  await assert.rejects(f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id, [f.decision], metadata, claim, 'review'), /request/);
  await db.updateTable('ai_job_batches').set({ unknown_requests: 0, lease_until: new Date(Date.now() - 1000) }).where('id', '=', f.batch.id).execute();
  await assert.rejects(f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id, [f.decision], metadata, claim, 'review'), /stale batch/);
  const unchanged = await batchRow(f.batch.id);
  assert.equal(unchanged.validated_decision, null);
  assert.equal(unchanged.confirmed_requests, 0);
  await db.updateTable('ai_job_batches').set({ status: 'cancelled' }).where('id', '=', f.batch.id).execute();
});

test('old tag protocol cannot checkpoint or publish a saved response over current tags', async () => {
  for (const stage of ['request', 'publish'] as const) {
    const f = await fixture(1, undefined, 'review');
    const before = [{ name: 'duration', value: 365 }];
    await db.insertInto('product_tags').values(tagRows(before.map(tag => ({ ...tag, product_id: f.inputId })))).execute();
    if (stage === 'publish') await f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id, [f.decision], metadata, claim, 'review');
    await db.updateTable('ai_jobs').set({ pipeline_versions: jsonb({
      ...(pipelineVersionSnapshot('mock') as Record<string, string>), tagProtocol: 'tag-json-object-per-tag-20261023-v2',
    }) }).where('id', '=', f.job.id).execute();
    if (stage === 'request') {
      await assert.rejects(f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id, [f.decision], metadata, claim, 'review'),
        { code: 'AI_POLICY_STALE' });
      assert.equal((await batchRow(f.batch.id)).confirmed_requests, 0);
    } else {
      await assert.rejects(f.repo.publishTagExtractionBatch(f.batch.id, await claimPublish(f.batch.id)), { code: 'AI_POLICY_STALE' });
      assert.equal((await batchRow(f.batch.id)).step, 'publish');
    }
    assert.deepEqual(await db.selectFrom('product_tags').select(['name', 'value']).where('product_id', '=', f.inputId).execute(), before);
    assert.equal((await db.selectFrom('ai_job_input_members').select('output').where('job_id', '=', f.job.id).executeTakeFirstOrThrow()).output, null);
    await db.updateTable('ai_jobs').set({ status: 'cancelled' }).where('id', '=', f.job.id).execute();
  }
});

test('a failed checkpoint update rolls back its confirmation and leaves no durable response', async () => {
  const f = await fixture(1, undefined, 'review');
  await sql`create function fail_tag_checkpoint() returns trigger language plpgsql as $$
    begin
      if new.id = ${sql.raw(String(f.batch.id))} and new.step = 'publish' then raise exception 'checkpoint storage unavailable'; end if;
      return new;
    end $$`.execute(db);
  await sql`create trigger fail_tag_checkpoint before update on ai_job_batches for each row execute function fail_tag_checkpoint()`.execute(db);
  try {
    await assert.rejects(f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id, [f.decision], metadata, claim, 'review'), /checkpoint storage unavailable/);
    const unchanged = await batchRow(f.batch.id);
    assert.equal(unchanged.validated_decision, null);
    assert.equal(unchanged.confirmed_requests, 0);
    assert.equal(unchanged.step, 'request');
    assert.equal(unchanged.response_id, null);
  } finally {
    await sql`drop trigger fail_tag_checkpoint on ai_job_batches`.execute(db);
    await sql`drop function fail_tag_checkpoint()`.execute(db);
  }
});

test('extraction and review survive a product SQL failure with no model request during local publication retry', async () => {
  const f = await fixture(2);
  f.decision.rejectedTags = [];
  f.decision.reviewDecisions = [true];
  await db.updateTable('ai_job_batches').set({ status: 'queued', attempts: 0n, claimed_by: null,
    claim_token: null, lease_until: null, request_budget_used: 0 }).where('id', '=', f.batch.id).execute();
  await sql`create function fail_tag_write() returns trigger language plpgsql as $$
    begin
      if new.product_id = ${sql.raw(String(f.products[1]!.id))} then raise exception 'simulated product SQL timeout'; end if;
      return new;
    end $$`.execute(db);
  await sql`create trigger fail_tag_write before insert on product_tags for each row execute function fail_tag_write()`.execute(db);
  const jobs = new JobsRepository(db);
  let calls = 0, reservations = 0;
  const reserve = f.repo.reserveBatchRequest.bind(f.repo);
  f.repo.reserveBatchRequest = async (...args) => { reservations++; return reserve(...args); };
  let settled = Promise.withResolvers<void>();
  const failures: Array<{ retry?: boolean; retryClass?: string | null }> = [];
  const worker = createAiWorker({
    claimNext: jobs.claimNext.bind(jobs), heartbeat: jobs.heartbeat.bind(jobs), complete: jobs.complete.bind(jobs),
    requeue: jobs.requeue.bind(jobs),
    fail: async (kind, id, workerId, error, options) => { failures.push(options ?? {}); await jobs.fail(kind, id, workerId, error, options); },
    onSettled: () => settled.resolve(),
  }, {
    repository: f.repo, workerId: claim.workerId, concurrency: 1, retryBaseMs: 1,
    modelCall: async claimed => {
      calls++;
      const { stage, proposals } = await f.repo.getTagExtractionBatchInputs(BigInt(claimed.id));
      if (stage === 'review') assert.equal(proposals?.items[0]?.id, String(f.inputId));
      return { items: [], missingIds: [], tagExtractionStage: stage,
        tagExtractionItems: [stage === 'review' ? { ...f.decision, reviewed: true, complete: true, rejectedTags: [] } : f.decision], metadata };
    },
  });
  async function run() { settled = Promise.withResolvers<void>(); assert.equal(await worker.runOnce(), 1); await settled.promise; }
  try {
    await run();
    assert.equal((await batchRow(f.batch.id)).step, 'done');
    const review = await db.selectFrom('ai_job_batches').select('id').where('job_id', '=', f.job.id).where('id', '!=', f.batch.id).executeTakeFirstOrThrow();
    await run();
    assert.equal((await batchRow(review.id)).step, 'publish');
    await run();
    assert.equal(failures[0]?.retry, true);
    assert.equal(failures[0]?.retryClass, 'local');
    assert.equal((await db.selectFrom('product_tags').selectAll().where('product_id', 'in', f.products.map(p => p.id)).execute()).length, 0);
    assert.equal((await batchRow(review.id)).step, 'publish');
    await sql`drop trigger fail_tag_write on product_tags`.execute(db);
    await sql`drop function fail_tag_write()`.execute(db);
    await db.updateTable('ai_job_batches').set({ available_at: sql`now()` }).where('id', '=', review.id).execute();
    await run();
    assert.equal((await batchRow(review.id)).step, 'done');
    assert.equal((await db.selectFrom('product_tags').selectAll().where('product_id', 'in', f.products.map(p => p.id)).execute()).length, 2);
    assert.equal(calls, 2);
    assert.equal(reservations, 2);
    assert.equal((await batchRow(f.batch.id)).confirmed_requests, 1);
    assert.equal((await batchRow(review.id)).confirmed_requests, 1);
  } finally {
    await worker.stop();
    await sql`drop trigger if exists fail_tag_write on product_tags`.execute(db);
    await sql`drop function if exists fail_tag_write()`.execute(db);
  }
});

test('streamed full repair replaces mistakenly approved channels and regions and publishes current results atomically', async () => {
  const evidence = '支持Codex和网页。账号已接码。日本区。会员30天。';
  const f = await fixture(2, evidence);
  const second = f.products[1]!;
  const secondPayload = { name: 'ChatGPT Plus second SKU', spec: second.spec, sourceData: { evidence }, shopSource: f.payload.shopSource };
  const fingerprint = productContentFingerprint({ ...secondPayload, sourceCategory: '' });
  await db.updateTable('products').set({ name: secondPayload.name, content_fingerprint: fingerprint }).where('id', '=', second.id).execute();
  await db.insertInto('ai_job_inputs').values({ job_id: f.job.id, input_id: second.id, payload: jsonb(secondPayload),
    fingerprint, content_version: 1n, input_bytes: 100n, estimated_tokens: 100n }).execute();
  await db.updateTable('ai_job_input_members').set({ input_id: second.id, payload: jsonb(secondPayload), fingerprint })
    .where('job_id', '=', f.job.id).where('product_id', '=', second.id).execute();
  const before = [
    { product_id: f.inputId, name: 'duration', value: 360 },
    { product_id: f.inputId, name: 'supported_client', value: 'claude' },
    { product_id: second.id, name: 'duration', value: 360 },
    { product_id: second.id, name: 'region', value: 'jp' },
  ];
  await db.insertInto('product_tags').values(tagRows(before)).execute();
  await db.updateTable('ai_job_batches').set({ status: 'queued', attempts: 0n, claimed_by: null,
    claim_token: null, lease_until: null, request_budget_used: 0, product_ids: jsonb([String(f.inputId), String(second.id)]) })
    .where('id', '=', f.batch.id).execute();
  const client = { name: 'supported_client', value: 'codex' };
  const sms = { name: 'sms_verification', value: 'verified' };
  const duration = { name: 'duration', value: 30 };
  const wrongChannel = { name: 'access_channel', value: 'api' };
  const channel = { name: 'access_channel', value: 'web' };
  const wrongOverride = { name: 'subscription_override', value: '无' };
  const correctedRegion = { name: 'region', value: 'jp' };
  const bulk = { name: 'bulk_purchase', value: 'supported' };
  const region = { name: 'region', value: 'us' };
  const proposals = { items: [
    { id: String(f.inputId), tags: [client, sms, { ...duration, value: 60 }, wrongChannel, bulk, region, wrongOverride] },
    { id: String(second.id), tags: [duration, channel, bulk] },
  ] };
  const repair = { items: [
    { id: String(f.inputId), tags: [client, sms, duration, channel, correctedRegion] },
    { id: String(second.id), tags: [duration, channel, bulk] },
  ] };
  const votes = [[true, true, false, true, true, true, true], [true, true, false]];
  const repairVotes = [[true, true, true, true, true], [true, true, false]];
  const feedback = ['需重新核对渠道、地区和使用期限。', '批量购买没有依据。'];
  const repairFeedback = ['完整候选集已覆盖渠道和地区。', '批量仍无依据。'];
  const responses = [proposals, { items: proposals.items.map((item, index) => ({ id: item.id,
    feedback: feedback[index], accepted: votes[index], complete: false })).reverse() }, repair,
    { items: repair.items.map((item, index) => ({ id: item.id, feedback: repairFeedback[index], accepted: repairVotes[index], complete: index === 0 })).reverse() }];
  let sends = 0, settled = Promise.withResolvers<void>();
  let requestAssertion: unknown;
  const claims: bigint[] = [], failures: string[] = [];
  const jobs = new JobsRepository(db);
  const modelCall = createOpenAiModelCall(f.repo, {
    AI_BASE_URL: 'https://mock.invalid/v1', AI_API_KEY: 'mock-key', AI_MODEL: 'mock',
  }, async (_url, init) => {
    try {
      const request = JSON.parse(String(init?.body));
      assert.equal(request.stream, true);
      assert.equal(request.model, 'mock');
      const payload = JSON.parse(request.messages[1].content);
      if (sends === 0) {
        assert.deepEqual(payload.map((input: { id: string }) => input.id), proposals.items.map(item => item.id));
      } else {
        assert.equal(payload.inputs.length, 2);
        if (sends === 1) assert.deepEqual(payload.proposals,
          { items: proposals.items.map(item => ({ ...item, candidateCount: item.tags.length })) });
        const previous = payload.previousDecisions?.find((item: { id: string }) => item.id === String(f.inputId));
        const previousSecond = payload.previousDecisions?.find((item: { id: string }) => item.id === String(second.id));
        if (sends === 2) {
          assert.deepEqual(previous, { id: String(f.inputId),
            draft: proposals.items[0]!.tags, feedback: feedback[0] });
          assert.deepEqual(previousSecond, { id: String(second.id),
            draft: [duration, channel, bulk], feedback: feedback[1] });
        } else assert.equal(payload.previousDecisions, undefined, 'review cannot see earlier votes or feedback');
        if (sends === 3) assert.deepEqual(payload.proposals,
          { items: repair.items.map(item => ({ ...item, candidateCount: item.tags.length })) },
          'review receives the complete replacement, including resubmitted accepted tags');
      }
      const body = responses[sends++];
      assert.ok(body, 'repair is bounded to one round; publication must never issue a fifth request');
      const content = JSON.stringify(body);
      return new Response([
        { id: 'response-' + sends, model: 'mock', choices: [{ delta: { content: content.slice(0, 30) } }] },
        { id: 'response-' + sends, model: 'mock', choices: [{ delta: { content: content.slice(30) }, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 100 * sends, completion_tokens: 50, total_tokens: 100 * sends + 50 } },
      ].map(chunk => 'data: ' + JSON.stringify(chunk) + '\n\n').join('') + 'data: [DONE]\n\n');
    } catch (error) { requestAssertion = error; throw error; }
  });
  const worker = createAiWorker({
    claimNext: async (...args) => { const claimed = await jobs.claimNext(...args); if (claimed) claims.push(claimed.id); return claimed; },
    heartbeat: jobs.heartbeat.bind(jobs), complete: jobs.complete.bind(jobs), requeue: jobs.requeue.bind(jobs),
    fail: async (kind, id, workerId, error, options) => { failures.push(error); await jobs.fail(kind, id, workerId, error, options); },
    onSettled: () => settled.resolve(),
  }, { repository: f.repo, workerId: 'stream-checkpoint-worker', concurrency: 1, modelCall });
  async function run() {
    settled = Promise.withResolvers<void>();
    assert.equal(await worker.runOnce(), 1);
    await settled.promise;
    assert.ifError(requestAssertion);
    assert.deepEqual(failures, []);
  }
  async function tags() {
    return db.selectFrom('product_tags').select(['product_id', 'name', 'value']).where('product_id', 'in', [f.inputId, second.id])
      .orderBy('product_id').orderBy('name').execute();
  }
  try {
    for (let request = 1; request <= 4; request++) {
      await run();
      assert.equal(sends, request);
      assert.deepEqual(await tags(), before, 'request checkpoints cannot publish product facts');
      assert.ok((await db.selectFrom('ai_job_input_members').select('output').where('job_id', '=', f.job.id).execute())
        .every(member => member.output === null));
    }
    const batches = await db.selectFrom('ai_job_batches').selectAll().where('job_id', '=', f.job.id).orderBy('batch_index').execute();
    assert.equal(batches.length, 4);
    const review = batches[1]!, repairBatch = batches[2]!, finalReview = batches[3]!;
    assert.equal((repairBatch.reference_snapshot as any).tagStage, 'repair');
    assert.equal((repairBatch.reference_snapshot as any).repairReviewBatchId, String(review.id));
    assert.equal((finalReview.reference_snapshot as any).tagRepairRound, 1);
    assert.equal((finalReview.reference_snapshot as any).extractionBatchId, String(repairBatch.id));
    for (const batch of batches) {
      assert.equal(batch.request_budget_used, 1);
      assert.equal(batch.confirmed_requests, 1);
    }
    assert.equal(finalReview.step, 'publish');
    assert.equal(finalReview.status, 'queued');
    assert.deepEqual(finalReview.response_usage, { promptTokens: 400, completionTokens: 50, totalTokens: 450 });
    const saved = finalReview.validated_decision;
    await sql`create function fail_full_repair_write() returns trigger language plpgsql as $$
      begin
        if new.product_id = ${sql.raw(String(second.id))} then raise exception 'full repair write unavailable'; end if;
        return new;
      end $$`.execute(db);
    await sql`create trigger fail_full_repair_write before insert on product_tags for each row execute function fail_full_repair_write()`.execute(db);
    try {
      await assert.rejects(f.repo.publishTagExtractionBatch(finalReview.id, await claimPublish(finalReview.id)), /full repair write unavailable/);
      assert.deepEqual(await tags(), before, 'failed replacement rolls back tags for every member');
      assert.ok((await db.selectFrom('ai_job_input_members').select('output').where('job_id', '=', f.job.id).execute())
        .every(member => member.output === null));
      assert.deepEqual((await batchRow(finalReview.id)).validated_decision, saved);
      assert.equal(sends, 4);
    } finally {
      await sql`drop trigger fail_full_repair_write on product_tags`.execute(db);
      await sql`drop function fail_full_repair_write()`.execute(db);
    }
    await db.updateTable('ai_job_batches').set({ status: 'queued', attempts: 0n, claimed_by: null,
      claim_token: null, lease_until: null }).where('id', '=', finalReview.id).execute();
    await run();
    assert.equal(sends, 4);
    assert.deepEqual(claims, [...batches.map(batch => batch.id), finalReview.id]);
    const expected = [
      ...[client, sms, duration, channel, correctedRegion].map(tag => ({ product_id: f.inputId, ...tag })),
      ...[duration, channel].map(tag => ({ product_id: second.id, ...tag })),
    ].sort((a, b) => a.product_id < b.product_id ? -1 : a.product_id > b.product_id ? 1 : a.name.localeCompare(b.name));
    assert.deepEqual(await tags(), expected, 'partial publication contains only accepted facts from this task');
    for (const [index, proposal] of proposals.items.entries()) {
      const audit = await f.repo.tagProductAudit(f.job.id, BigInt(proposal.id));
      assert.deepEqual(audit.batches.map((batch: any) => batch.id), batches.map(batch => String(batch.id)));
      assert.deepEqual(audit.batches[0].proposals, proposal.tags.map((tag, proposalIndex) => ({ ...tag, evidence: [], proposalIndex })));
      assert.deepEqual(audit.batches[1].review_decisions, votes[index]);
      assert.equal(audit.member.output.outcome, index === 0 ? 'updated' : 'partial_success');
      assert.equal(audit.member.output.complete, index === 0);
      assert.equal(audit.member.output.successfulCount, index === 0 ? 5 : 2);
      assert.equal(audit.member.output.failedCount, index === 0 ? 0 : 1);
      assert.deepEqual(audit.member.output.attempts.map((attempt: any) => attempt.reviewDecisions), [votes[index], repairVotes[index]]);
      assert.deepEqual(audit.member.output.attempts.map((attempt: any) => attempt.round), [1, 2]);
      assert.deepEqual(audit.member.output.review.decisions, repairVotes[index]);
      assert.equal(audit.member.output.review.feedback, repairFeedback[index]);
      assert.deepEqual(audit.member.output.attempts.map((attempt: any) => attempt.reviewFeedback), [feedback[index], repairFeedback[index]]);
      assert.equal(audit.batches[3].review_feedback, repairFeedback[index]);
    }
    assert.equal((await db.selectFrom('ai_jobs').select('status').where('id', '=', f.job.id).executeTakeFirstOrThrow()).status, 'ready_with_errors');
    assert.equal((await db.selectFrom('ai_job_batches').select('id').where('job_id', '=', f.job.id).execute()).length, 4);
    assert.equal((await batchRow(finalReview.id)).step, 'done');
    assert.deepEqual((await batchRow(finalReview.id)).validated_decision, saved);
    assert.equal(await worker.runOnce(), 0, 'partial publication cannot enqueue another repair');
  } finally { await worker.stop(); }
});

test('mixed initial review publishes resolved inputs immediately and isolates the remaining repair', async () => {
  const f = await fixture(2);
  const second = f.products[1]!;
  const payload = { name: second.name, spec: '2个月，日区', sourceData: {}, shopSource: f.payload.shopSource };
  const fingerprint = productContentFingerprint({ ...payload, sourceCategory: '' });
  await db.updateTable('products').set({ spec: payload.spec, content_fingerprint: fingerprint }).where('id', '=', second.id).execute();
  await db.insertInto('ai_job_inputs').values({ job_id: f.job.id, input_id: second.id, payload: jsonb(payload),
    fingerprint, content_version: 1n, input_bytes: 100n, estimated_tokens: 100n }).execute();
  await db.updateTable('ai_job_input_members').set({ input_id: second.id, payload: jsonb(payload), fingerprint })
    .where('job_id', '=', f.job.id).where('product_id', '=', second.id).execute();
  await db.updateTable('ai_job_batches').set({ product_ids: jsonb([String(f.inputId), String(second.id)]) }).where('id', '=', f.batch.id).execute();
  const duration = { name: 'duration', value: 30, evidence: [], proposalIndex: 0 };
  const secondDuration = { ...duration, value: 60 };
  const region = { name: 'region', value: 'us', evidence: [], proposalIndex: 1 };
  await f.repo.prepareBatch(f.batch.id);
  await f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id, [
    { productId: f.inputId, tags: [duration], rejectedTags: [] },
    { productId: second.id, tags: [secondDuration, region], rejectedTags: [] },
  ], metadata, claim, 'extract');
  const review = await db.selectFrom('ai_job_batches').select('id').where('job_id', '=', f.job.id)
    .where('id', '!=', f.batch.id).executeTakeFirstOrThrow();
  const resolved = validateReviewedTagExtractionDecision(f.inputId, [duration], [], {}, [true], true);
  const pending = validateReviewedTagExtractionDecision(second.id, [secondDuration], [
    { ...region, reasonCode: 'review_rejected', reason: 'LLM 对该标签判定为否' },
  ], payload, [true, false], false);
  const reviewClaim = await claimPublish(review.id);
  await db.updateTable('ai_job_batches').set({ request_budget_used: 1 }).where('id', '=', review.id).execute();
  await f.repo.checkpointTagExtractionBatchDecision(f.job.id, review.id, [pending, resolved], metadata, reviewClaim, 'review');
  const children = await db.selectFrom('ai_job_batches').selectAll().where('job_id', '=', f.job.id)
    .where('id', 'not in', [f.batch.id, review.id]).orderBy('batch_index').execute();
  assert.equal(children.length, 2);
  const [publication, repair] = children;
  assert.notEqual(publication!.id, repair!.id);
  assert.deepEqual(publication!.product_ids, [String(f.inputId)]);
  assert.equal(publication!.product_count, 1n);
  assert.equal(publication!.step, 'publish');
  assert.equal(publication!.status, 'queued');
  assert.equal(publication!.request_budget_used, 0);
  assert.equal(publication!.confirmed_requests, 0);
  assert.deepEqual(publication!.validated_decision, { items: [{ ...resolved, productId: String(f.inputId) }] });
  assert.equal((publication!.reference_snapshot as any).tagPublishOnly, true);
  assert.equal((publication!.reference_snapshot as any).tagStage, 'review');
  assert.equal((publication!.reference_snapshot as any).extractionBatchId, String(f.batch.id));
  assert.equal((publication!.reference_snapshot as any).repairReviewBatchId, undefined);
  assert.deepEqual(repair!.product_ids, [String(second.id)]);
  assert.equal(repair!.product_count, 1n);
  assert.equal(repair!.step, 'request');
  assert.equal(repair!.validated_decision, null);
  assert.equal((repair!.reference_snapshot as any).tagStage, 'repair');
  assert.equal((repair!.reference_snapshot as any).tagRepairRound, 1);
  assert.equal((repair!.reference_snapshot as any).repairReviewBatchId, String(review.id));
  assert.equal((repair!.reference_snapshot as any).tagPublishOnly, undefined);

  await f.repo.publishTagExtractionBatch(publication!.id, await claimPublish(publication!.id));
  const memberRows = () => db.selectFrom('ai_job_input_members').select(['product_id', 'output'])
    .where('job_id', '=', f.job.id).orderBy('product_id').execute();
  const published = await memberRows();
  assert.equal((published[0]!.output as any).outcome, 'updated');
  assert.equal(published[1]!.output, null);
  assert.deepEqual(await db.selectFrom('product_tags').select(['product_id', 'name', 'value'])
    .where('product_id', 'in', [f.inputId, second.id]).execute(), [{ product_id: f.inputId, name: 'duration', value: 30 }]);
  const root = () => db.selectFrom('ai_jobs').select(['status', 'finished_at']).where('id', '=', f.job.id).executeTakeFirstOrThrow();
  assert.deepEqual(await root(), { status: 'running', finished_at: null });
  assert.equal((await batchRow(repair!.id)).status, 'queued');
  const context = await f.repo.getTagExtractionBatchInputs(repair!.id);
  assert.equal(context.stage, 'repair');
  assert.deepEqual(context.inputs.map(input => input.productId), [second.id]);
  assert.deepEqual(context.previousDecisions, [pending]);
  assert.equal(context.proposals, undefined);

  const corrected = { name: 'region', value: 'jp', evidence: [], proposalIndex: 0 };
  const repairClaim = await claimPublish(repair!.id);
  await db.updateTable('ai_job_batches').set({ request_budget_used: 1 }).where('id', '=', repair!.id).execute();
  await f.repo.checkpointTagExtractionBatchDecision(f.job.id, repair!.id,
    [{ productId: second.id, tags: [corrected], rejectedTags: [] }], metadata, repairClaim, 'repair');
  const finalReview = await db.selectFrom('ai_job_batches').select('id').where('job_id', '=', f.job.id)
    .where('id', 'not in', [f.batch.id, review.id, publication!.id, repair!.id]).executeTakeFirstOrThrow();
  const finalContext = await f.repo.getTagExtractionBatchInputs(finalReview.id);
  assert.deepEqual(finalContext.previousDecisions, [pending]);
  assert.deepEqual(finalContext.proposals, { items: [{ id: String(second.id), tags: [{ name: 'region', value: 'jp' }] }] });
  const finalClaim = await claimPublish(finalReview.id);
  await db.updateTable('ai_job_batches').set({ request_budget_used: 1 }).where('id', '=', finalReview.id).execute();
  const repaired = recordTagRepairAttempt(pending, validateReviewedTagExtractionDecision(second.id, [corrected], [], payload, [true], true));
  await f.repo.checkpointTagExtractionBatchDecision(f.job.id, finalReview.id, [repaired], metadata, finalClaim, 'review');
  assert.deepEqual(await root(), { status: 'running', finished_at: null });
  await f.repo.publishTagExtractionBatch(finalReview.id, await claimPublish(finalReview.id));
  assert.equal((await root()).status, 'succeeded');
  assert.ok((await root()).finished_at);
  const completed = await memberRows();
  assert.deepEqual(completed[0], published[0], 'repair must not republish the already resolved member');
  assert.equal((completed[1]!.output as any).outcome, 'updated');
  assert.deepEqual((completed[1]!.output as any).after, [{ name: 'region', value: 'jp' }]);
});

test('review preparation excludes proposals for frozen inputs whose shop became unavailable', async () => {
  const f = await fixture();
  await f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id, [f.decision], metadata, claim, 'extract');
  const review = await db.selectFrom('ai_job_batches').select('id').where('job_id', '=', f.job.id).where('round', '=', 1).executeTakeFirstOrThrow();
  await db.updateTable('shops').set({ enabled: false }).where('id', '=', f.products[0]!.shop_id).execute();
  const request = await f.repo.getTagExtractionBatchInputs(review.id);
  assert.deepEqual(request.inputs, []);
  assert.deepEqual(request.proposals, { items: [] });
});

test('publication fences old claims and rechecks source, lock and frozen member evidence', async () => {
  const f = await fixture(3, undefined, 'review');
  await f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id, [f.decision], metadata, claim, 'review');
  const currentClaim = await claimPublish(f.batch.id);
  await assert.rejects(f.repo.publishTagExtractionBatch(f.batch.id, { ...currentClaim, token: 'stale' }), /stale batch/);
  await db.updateTable('products').set({ standardization_locked: true }).where('id', '=', f.products[1]!.id).execute();
  await db.updateTable('products').set({ content_version: 2n }).where('id', '=', f.products[2]!.id).execute();
  await f.repo.publishTagExtractionBatch(f.batch.id, currentClaim);
  const members = await db.selectFrom('ai_job_input_members').select(['reason_code', 'output']).where('job_id', '=', f.job.id).orderBy('product_id').execute();
  assert.deepEqual(members.map(member => member.reason_code), ['tag_evidence_rejected', 'product_locked', 'source_changed']);
  assert.equal((await db.selectFrom('product_tags').select('product_id').where('product_id', 'in', f.products.map(p => p.id)).execute()).length, 1);
});

test('cancellation after checkpoint retains the response but permits no product publication', async () => {
  const f = await fixture(1, undefined, 'review');
  await f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id, [f.decision], metadata, claim, 'review');
  const currentClaim = await claimPublish(f.batch.id);
  await f.repo.cancelJob(f.job.id);
  await assert.rejects(f.repo.publishTagExtractionBatch(f.batch.id, currentClaim));
  assert.equal((await db.selectFrom('product_tags').selectAll().where('product_id', '=', f.inputId).execute()).length, 0);
  assert.ok((await batchRow(f.batch.id)).validated_decision);
});

test('audit returns the full frozen payload after source changes and redacts untrusted secrets without rewriting snapshots', async () => {
  const f = await fixture();
  const evidence = 'Public evidence. '.repeat(150) + 'The final original fact.';
  const payload = { name: 'Original product', spec: 'Original spec', sourceData: {
    evidence, nested: [{ 'API-Key': 'untrusted-key', password: 123456, token: { value: 'untrusted-token' },
      Authorization: 'untrusted-auth', cookie: ['untrusted-cookie'], session_id: 'untrusted-session',
      text: 'Bearer private-token password=private-password https://user:private-pass@test.invalid/p?api_key=private-query',
      'field password=private-field': 'public fact' }],
  } };
  await db.updateTable('ai_job_input_members').set({ payload: jsonb(payload) })
    .where('job_id', '=', f.job.id).where('product_id', '=', f.inputId).execute();
  await db.updateTable('products').set({ name: 'Current product', spec: 'Current spec', source_data: jsonb({ evidence: 'Current evidence' }),
    content_version: 2n }).where('id', '=', f.inputId).execute();
  const audit = await f.repo.tagProductAudit(f.job.id, f.inputId);
  assert.equal(audit.member.payload.name, payload.name);
  assert.equal(audit.member.payload.spec, payload.spec);
  assert.equal(audit.member.payload.sourceData.evidence, evidence);
  const nested = audit.member.payload.sourceData.nested[0];
  for (const key of ['API-Key', 'password', 'token', 'Authorization', 'cookie', 'session_id']) assert.equal(nested[key], '[redacted]');
  assert.equal(nested['field password=[redacted]'], 'public fact');
  assert.equal(nested.text, 'Bearer [redacted] password=[redacted] https://test.invalid/p');
  const serialized = JSON.stringify(audit);
  for (const secret of ['untrusted-key', '123456', 'untrusted-token', 'untrusted-auth', 'untrusted-cookie', 'untrusted-session',
    'private-token', 'private-password', 'private-pass', 'private-query', 'private-field', 'Current evidence']) {
    assert.ok(!serialized.includes(secret), `audit leaked ${secret}`);
  }
  const member = await db.selectFrom('ai_job_input_members').select('payload')
    .where('job_id', '=', f.job.id).where('product_id', '=', f.inputId).executeTakeFirstOrThrow();
  assert.deepEqual(member.payload, payload);
});

test('audit redacts bare untrusted secrets cited by candidates and member output without changing database snapshots', async () => {
  const f = await fixture();
  const secret = 'untrusted-secret';
  const payload = { name: 'Untrusted product', spec: '1\u4e2a\u6708', sourceData: { api_key: secret } };
  const sensitive = { name: 'unknown', value: secret, evidence: [{ path: 'sourceData.api_key', quote: secret }] };
  const publicTag = { name: 'duration', value: 30, evidence: [{ path: 'spec', quote: payload.spec }] };
  const output = { outcome: 'review', acceptedTags: [sensitive, publicTag],
    rejectedTags: [{ ...sensitive, reasonCode: 'tag_value_invalid', reason: 'Untrusted rejected tag' }],
    before: [], after: [], diff: [], retainedUnconfirmed: [] };
  await db.updateTable('ai_job_inputs').set({ payload: jsonb(payload) }).where('job_id', '=', f.job.id).where('input_id', '=', f.inputId).execute();
  await db.updateTable('ai_job_input_members').set({ payload: jsonb(payload), output: jsonb(output) })
    .where('job_id', '=', f.job.id).where('product_id', '=', f.inputId).execute();
  await f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id,
    [{ productId: f.inputId, tags: [sensitive, publicTag], rejectedTags: [] }], metadata, claim, 'extract');
  const checkpointBefore = await batchRow(f.batch.id);
  const audit = await f.repo.tagProductAudit(f.job.id, f.inputId);
  const inputAfter = await db.selectFrom('ai_job_inputs').select('payload')
    .where('job_id', '=', f.job.id).where('input_id', '=', f.inputId).executeTakeFirstOrThrow();
  const memberAfter = await db.selectFrom('ai_job_input_members').select(['payload', 'output'])
    .where('job_id', '=', f.job.id).where('product_id', '=', f.inputId).executeTakeFirstOrThrow();
  assert.deepEqual(inputAfter.payload, payload);
  assert.deepEqual(memberAfter, { payload, output });
  assert.deepEqual(await batchRow(f.batch.id), checkpointBefore);
  assert.deepEqual(audit.batches[0].proposals[1], { ...publicTag, proposalIndex: 1 });
  assert.deepEqual(audit.member.output.acceptedTags[1], publicTag);
  const audited = [audit.batches[0].proposals[0], audit.member.output.acceptedTags[0], audit.member.output.rejectedTags[0]];
  assert.equal(audit.member.payload.sourceData.api_key, '[redacted]');
  assert.deepEqual(audited.map(tag => ({ value: tag.value, evidence: tag.evidence })), audited.map(() => ({
    value: '[redacted]', evidence: [{ path: 'sourceData.api_key', quote: '[redacted]' }],
  })));
  assert.ok(!JSON.stringify(audit).includes(secret), 'audit response must not expose a bare secret through any candidate or untrusted output');
});

test('audit exposes only its own ordered proposals, raw votes and exact lineage after a publication failure', async () => {
  const f = await fixture(2);
  const second = f.products[1]!;
  const payload = { name: 'Second independent product', spec: second.spec, sourceData: {}, shopSource: f.payload.shopSource };
  const fingerprint = productContentFingerprint({ ...payload, sourceCategory: '' });
  await db.insertInto('ai_job_inputs').values({ job_id: f.job.id, input_id: second.id, payload: jsonb(payload),
    fingerprint, content_version: 1n, input_bytes: 100n, estimated_tokens: 100n }).execute();
  await db.updateTable('ai_job_input_members').set({ input_id: second.id, payload: jsonb(payload), fingerprint })
    .where('job_id', '=', f.job.id).where('product_id', '=', second.id).execute();
  await db.updateTable('ai_job_batches').set({ product_ids: jsonb([String(f.inputId), String(second.id)]),
    started_at: new Date('2026-10-25T01:00:00Z'), request_estimate: jsonb({ totalTokens: 321 }) }).where('id', '=', f.batch.id).execute();
  const tag = { name: 'duration', value: 30, evidence: [{ path: 'spec', quote: '1\u4e2a\u6708' }] };
  const long = { name: 'password=private-name', value: 'secret=private-value',
    evidence: [{ path: 'sourceData.password=private-path', quote: `password=private-quote ${'q'.repeat(1200)}` }] };
  const other = { productId: second.id, tags: [{ ...tag, value: 'Other product private candidate' }], rejectedTags: [] };
  await f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id,
    [{ productId: f.inputId, tags: [tag, tag, long], rejectedTags: [] }, other], metadata, claim, 'extract');
  const review = await db.selectFrom('ai_job_batches').select('id').where('job_id', '=', f.job.id).where('round', '=', 1).executeTakeFirstOrThrow();
  const reviewed = { productId: f.inputId, tags: [{ ...tag, proposalIndex: 0 }], rejectedTags: [
    { ...tag, proposalIndex: 1, reasonCode: 'review_rejected', reason: 'LLM 对该标签判定为否' },
    { ...long, proposalIndex: 2, reasonCode: 'review_rejected', reason: 'LLM 对该标签判定为否' },
  ], reviewed: true, complete: true, reviewDecisions: [true, false, false] };
  const reviewClaim = await claimPublish(review.id, 'review-audit-claim');
  await db.updateTable('ai_job_batches').set({ request_budget_used: 1, started_at: new Date('2026-10-25T02:00:00Z'),
    request_estimate: jsonb({ totalTokens: 654 }),
    reference_snapshot: jsonb({ tagStage: 'review', tagRepairRound: 1, extractionBatchId: String(f.batch.id) }) }).where('id', '=', review.id).execute();
  await f.repo.checkpointTagExtractionBatchDecision(f.job.id, review.id,
    [reviewed, { ...other, tags: [], rejectedTags: [{ ...other.tags[0]!, proposalIndex: 0,
      reasonCode: 'review_rejected', reason: 'LLM 对该标签判定为否' }], reviewed: true, complete: true, reviewDecisions: [false] }], metadata, reviewClaim, 'review');
  await sql`create function fail_audit_publication() returns trigger language plpgsql as $$
    begin raise exception 'audit publication unavailable'; end $$`.execute(db);
  await sql`create trigger fail_audit_publication before insert on product_tags for each row execute function fail_audit_publication()`.execute(db);
  try {
    await assert.rejects(f.repo.publishTagExtractionBatch(review.id, await claimPublish(review.id)), /audit publication unavailable/);
  } finally {
    await sql`drop trigger fail_audit_publication on product_tags`.execute(db);
    await sql`drop function fail_audit_publication()`.execute(db);
  }
  await db.updateTable('ai_job_batches').set({ status: 'failed', error: 'password=private-failure',
    error_source: 'publication', retry_class: 'local', finished_at: new Date('2026-10-25T03:00:00Z'),
    response_diagnostic: jsonb({ code: 'accepted', chunkCount: 3 }) }).where('id', '=', review.id).execute();
  const audit = await f.repo.tagProductAudit(f.job.id, f.inputId);
  const savedExtract = await batchRow(f.batch.id), savedReview = await batchRow(review.id);
  assert.deepEqual(audit.batches.map((batch: any) => batch.id), [String(f.batch.id), String(review.id)]);
  for (const saved of [savedExtract, savedReview]) {
    const batch = audit.batches.find((item: any) => item.id === String(saved.id));
    for (const key of ['id', 'batch_index', 'round', 'status', 'step', 'attempts', 'product_count', 'input_bytes',
      'estimated_tokens', 'queued_at', 'planned_at', 'request_budget_used', 'request_budget_limit',
      'confirmed_requests', 'unknown_requests', 'started_at', 'decision_saved_at', 'finished_at', 'first_content_at',
      'response_completed_at', 'response_model', 'response_id', 'response_usage', 'response_ms', 'request_estimate',
      'response_diagnostic', 'decision_hash', 'error_source', 'retry_class'] as const) {
      const value = saved[key];
      assert.deepEqual(batch[key], value instanceof Date ? value.toISOString() : typeof value === 'bigint' ? String(value) : value, key);
    }
  }
  const extraction = audit.batches[0], reviewedBatch = audit.batches[1];
  assert.equal(extraction.stage, 'extract');
  assert.equal(extraction.extraction_batch_id, null);
  assert.deepEqual(extraction.proposals.slice(0, 2), [{ ...tag, proposalIndex: 0 }, { ...tag, proposalIndex: 1 }]);
  assert.equal(extraction.proposals[2].proposalIndex, 2);
  assert.equal(extraction.proposals[2].evidence[0].quote.length, 1000);
  assert.equal(extraction.proposals.length, 3);
  assert.equal(reviewedBatch.stage, 'review');
  assert.equal(reviewedBatch.extraction_batch_id, String(f.batch.id));
  assert.deepEqual(reviewedBatch.review_decisions, reviewed.reviewDecisions);
  assert.equal(reviewedBatch.error, 'password=[redacted]');
  assert.equal(audit.member.output, null);
  const otherAudit = await f.repo.tagProductAudit(f.job.id, second.id);
  assert.deepEqual(otherAudit.batches[0].proposals, [{ ...other.tags[0], proposalIndex: 0 }]);
  assert.deepEqual(otherAudit.batches[1].review_decisions, [false]);
  assert.equal((await db.selectFrom('product_tags').select('product_id').where('product_id', 'in', [f.inputId, second.id]).execute()).length, 0);
  const serialized = JSON.stringify(audit);
  for (const privateValue of ['Other product private candidate', 'validated_decision', 'reference_snapshot',
    'private-name', 'private-value', 'private-path', 'private-quote', 'private-failure']) assert.ok(!serialized.includes(privateValue), privateValue);
});

test('audit preserves indexed candidates in the review loader order', async () => {
  const f = await fixture();
  await f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id, [f.decision], metadata, claim, 'extract');
  const review = await db.selectFrom('ai_job_batches').select('id').where('job_id', '=', f.job.id).where('round', '=', 1).executeTakeFirstOrThrow();
  const restored = await f.repo.getTagExtractionBatchInputs(review.id);
  const audit = await f.repo.tagProductAudit(f.job.id, f.inputId);
  assert.equal(audit.batches[0].proposals.length, 2);
  assert.deepEqual(audit.batches[0].proposals.map(({ name, value, proposalIndex }: any) => ({
    name, value, proposalIndex,
  })), restored.proposals!.items[0]!.tags.map((tag, proposalIndex) => ({ ...tag, proposalIndex })));
  assert.equal(audit.batches[0].proposals[1].name, 'unknown');
  assert.ok(!Object.hasOwn(audit.batches[0].proposals[1], 'reasonCode'));
});

test('audit exposes saved votes and never reconstructs corrupted vectors from tag outcomes', async () => {
  const f = await fixture();
  const reviewed = { ...f.decision, reviewed: true, complete: true };
  await db.updateTable('ai_job_batches').set({ reference_snapshot: jsonb({ tagStage: 'review', tagRepairRound: 1 }) }).where('id', '=', f.batch.id).execute();
  await f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id, [reviewed], metadata, claim, 'review');
  await f.repo.publishTagExtractionBatch(f.batch.id, await claimPublish(f.batch.id));
  const saved = await f.repo.tagProductAudit(f.job.id, f.inputId);
  assert.deepEqual(saved.batches[0].review_decisions, [true, true]);
  assert.deepEqual(saved.member.output.review, { mode: 'per_tag_binary', decisions: [true, true] });
  for (const vector of [[true, 'false'], null, [], [false, true]]) {
    await db.updateTable('ai_job_batches').set({ validated_decision: jsonb({ items: [
      { ...reviewed, productId: String(f.inputId), reviewDecisions: vector },
    ] }) }).where('id', '=', f.batch.id).execute();
    const audit = await f.repo.tagProductAudit(f.job.id, f.inputId);
    assert.deepEqual(audit.batches[0].review_decisions, Array.isArray(vector) && vector.every(value => typeof value === 'boolean') ? vector : null);
  }
});

async function textPublicationFixture(count = 1) {
  const f = await fixture(count);
  const product = f.products[0]!;
  const source = await db.selectFrom('shops').select(['url', 'protocol', 'platform']).where('id', '=', product.shop_id).executeTakeFirstOrThrow();
  const text = { unitId: 'shared-listing', name: product.name, description: '交付账号。服务有效期1个月。', hash: 'a'.repeat(64) };
  const sourceData = { ratingText: text };
  const payload = { ...buildExtractionPayload({ id: String(f.inputId), name: product.name, spec: product.spec, sourceData }), shopSource: source };
  const fingerprint = productContentFingerprint({ name: product.name, spec: product.spec, sourceCategory: '', sourceData });
  await db.updateTable('products').set({ source_data: jsonb(sourceData), content_fingerprint: fingerprint })
    .where('id', 'in', f.products.map(product => product.id)).execute();
  await db.updateTable('ai_job_inputs').set({ payload: jsonb(payload), fingerprint }).where('job_id', '=', f.job.id).execute();
  await db.updateTable('ai_job_input_members').set({ payload: jsonb(payload), fingerprint }).where('job_id', '=', f.job.id).execute();
  await db.updateTable('ai_jobs').set({ job_type: 'text_review' }).where('id', '=', f.job.id).execute();
  await db.updateTable('ai_job_batches').set({ reference_snapshot: jsonb({ tagStage: 'extract' }) }).where('id', '=', f.batch.id).execute();
  const review = validateTextReview({
    answers: { ...Object.fromEntries(DISCLOSURE_KEYS.map(key => [key, false])), L1: true, L2: true },
    consistency: Object.fromEntries(CONSISTENCY_KEYS.map(key => [key, false])),
  }, text)!;
  const decision = { productId: f.inputId, tags: [], rejectedTags: [], textReview: review };
  const stored = { version: TEXT_REVIEW_VERSION, contentVersion: String(product.content_version), fingerprint,
    source, textHash: text.hash, review };
  return { ...f, source, text, sourceData, payload, fingerprint, review, decision, stored };
}

test('text publication waits for the shop before locking products held by the crawler', async () => {
  const f = await textPublicationFixture();
  await f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id, [f.decision], metadata, claim, 'extract');
  const publishClaim = await claimPublish(f.batch.id);
  await db.connection().execute(async connection => {
    const { pid } = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(connection)).rows[0]!;
    let publication: Promise<void> | undefined;
    try {
      await db.transaction().execute(async crawler => {
        await crawler.selectFrom('shops').select('id').where('id', '=', f.products[0]!.shop_id).forNoKeyUpdate().execute();
        publication = new AiRepository(connection).publishTagExtractionBatch(f.batch.id, publishClaim);
        // Keep failures observed while the crawler transaction releases its locks.
        void publication.catch(() => {});
        let waiting = false;
        for (let attempt = 0; attempt < 200; attempt++) {
          const activity = await admin.query('select wait_event_type from pg_stat_activity where pid = $1', [pid]);
          if (activity.rows[0]?.wait_event_type === 'Lock') { waiting = true; break; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.ok(waiting, 'publication must wait for the crawler shop lock');
        await sql`set local lock_timeout = '500ms'`.execute(crawler);
        await crawler.updateTable('products').set({ updated_at: new Date() }).where('id', '=', f.products[0]!.id).execute();
      });
    } finally {
      await publication;
    }
  });
  assert.deepEqual((await db.selectFrom('products').select('text_review').where('id', '=', f.inputId).executeTakeFirstOrThrow()).text_review, f.stored);
});

test('independent text publication preserves tags and rolls back reviews and audit for all members on SQL failure and retries the saved checkpoint', async () => {
  const f = await textPublicationFixture(2);
  const productIds = f.products.map(product => product.id);
  const tagsBefore = productIds.map(product_id => ({ product_id, name: 'duration', value: 360 }));
  await db.insertInto('product_tags').values(tagRows(tagsBefore)).execute();
  await f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id, [f.decision], metadata, claim, 'extract');
  const checkpoint = await batchRow(f.batch.id);
  assert.equal(checkpoint.step, 'publish');
  assert.equal((await db.selectFrom('ai_job_batches').select('id').where('job_id', '=', f.job.id).execute()).length, 1);
  assert.deepEqual((checkpoint.validated_decision as any).items[0].tags, []);
  assert.deepEqual((checkpoint.validated_decision as any).items[0].textReview, f.review);
  const publishClaim = await claimPublish(f.batch.id);
  const cacheBefore = await db.selectFrom('catalog_cache_versions').selectAll().execute();
  await sql`create function fail_text_review_publication() returns trigger language plpgsql as $$
    begin
      if new.id = ${sql.raw(String(f.products[1]!.id))} and new.text_review is not null then
        raise exception 'text review storage unavailable';
      end if;
      return new;
    end $$`.execute(db);
  await sql`create trigger fail_text_review_publication before update of text_review on products
    for each row execute function fail_text_review_publication()`.execute(db);
  try {
    await assert.rejects(new AiRepository(db).publishTagExtractionBatch(f.batch.id, publishClaim), /text review storage unavailable/);
    assert.deepEqual(await db.selectFrom('product_tags').select(['product_id', 'name', 'value'])
      .where('product_id', 'in', productIds).orderBy('product_id').execute(), tagsBefore);
    assert.deepEqual((await db.selectFrom('products').select('text_review').where('id', 'in', productIds).execute())
      .map(product => product.text_review), [null, null]);
    assert.ok((await db.selectFrom('ai_job_input_members').select('output').where('job_id', '=', f.job.id).execute())
      .every(member => member.output === null));
    assert.deepEqual(await db.selectFrom('catalog_cache_versions').selectAll().execute(), cacheBefore);
    const failed = await batchRow(f.batch.id);
    assert.equal(failed.step, 'publish');
    assert.equal(failed.confirmed_requests, 1);
    assert.deepEqual(failed.validated_decision, checkpoint.validated_decision);
  } finally {
    await sql`drop trigger fail_text_review_publication on products`.execute(db);
    await sql`drop function fail_text_review_publication()`.execute(db);
  }
  await new AiRepository(db).publishTagExtractionBatch(f.batch.id, publishClaim);
  assert.ok((await db.selectFrom('products').select('text_review').where('id', 'in', productIds).execute())
    .every(product => { assert.deepEqual(product.text_review, f.stored); return true; }));
  assert.deepEqual((await db.selectFrom('product_tags').select('value').where('product_id', 'in', productIds).execute())
    .map(tag => tag.value), [360, 360]);
  const done = await batchRow(f.batch.id);
  assert.equal(done.step, 'done');
  assert.equal(done.confirmed_requests, 1);
});

for (const changed of ['body', 'url', 'protocol', 'platform'] as const) {
  test(`text review publication rejects a changed ${changed} only for its own frozen member after deduplication`, async () => {
    const f = await textPublicationFixture(2);
    const first = f.products[0]!, second = f.products[1]!;
    const secondSource = { ...f.source, url: `https://second.invalid/${f.job.id}`, protocol: 'original-protocol' };
    const secondShop = await db.insertInto('shops').values({ ...secondSource, name: 'second source', enabled: true })
      .returning('id').executeTakeFirstOrThrow();
    await db.updateTable('products').set({ shop_id: secondShop.id, text_review: jsonb({ ...f.stored, source: secondSource }) })
      .where('id', '=', second.id).execute();
    await db.updateTable('ai_job_input_members').set({ payload: jsonb({ ...f.payload, shopSource: secondSource }) })
      .where('job_id', '=', f.job.id).where('product_id', '=', second.id).execute();
    await db.insertInto('product_tags').values(tagRows({ product_id: second.id, name: 'duration', value: 360 })).execute();
    await f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id, [f.decision], metadata, claim, 'extract');
    if (changed === 'body') {
      const sourceData = { ratingText: { ...f.text, description: '改为交付兑换码。', hash: 'b'.repeat(64) } };
      const fingerprint = productContentFingerprint({ name: second.name, spec: second.spec, sourceCategory: '', sourceData });
      await db.updateTable('products').set({ source_data: jsonb(sourceData), content_fingerprint: fingerprint, content_version: 2n })
        .where('id', '=', second.id).execute();
    } else {
      await db.updateTable('shops').set({ [changed]: `${secondSource[changed]}/changed` }).where('id', '=', secondShop.id).execute();
    }
    await new AiRepository(db).publishTagExtractionBatch(f.batch.id, await claimPublish(f.batch.id));
    const products = await db.selectFrom('products').select(['id', 'text_review']).where('id', 'in', [first.id, second.id]).orderBy('id').execute();
    assert.deepEqual(products[0]!.text_review, f.stored, 'the unchanged member uses its own source, not the other shop source');
    assert.deepEqual(products[1]!.text_review, { ...f.stored, source: secondSource }, 'stale publication cannot replace the old bound review');
    assert.deepEqual(await db.selectFrom('product_tags').select(['product_id', 'value']).where('product_id', 'in', [first.id, second.id])
      .orderBy('product_id').execute(), [{ product_id: second.id, value: 360 }]);
    const members = await db.selectFrom('ai_job_input_members').select(['input_id', 'reason_code', 'output']).where('job_id', '=', f.job.id)
      .orderBy('product_id').execute();
    assert.deepEqual(members.map(member => member.input_id), [f.inputId, f.inputId], 'one shared review fans out across different shop sources');
    assert.equal((members[0]!.output as any).outcome, 'updated');
    assert.equal((members[1]!.output as any).outcome, 'skipped');
    assert.equal(members[1]!.reason_code, changed === 'body' ? 'source_changed' : 'text_review_source_changed');
    assert.deepEqual((members[1]!.output as any).textReview, f.review, 'the rejected review remains in member audit');
  });
}

test('changing only the text review bumps the catalog version without changing tags and done publication is idempotent', async () => {
  const f = await textPublicationFixture();
  const priorReview = { ...f.review, answers: { ...f.review.answers, L2: false } };
  await db.updateTable('products').set({ text_review: jsonb({ ...f.stored, review: priorReview }) }).where('id', '=', f.inputId).execute();
  const tags = [{ name: 'duration', value: 360 }];
  await db.insertInto('product_tags').values(tagRows(tags.map(tag => ({ ...tag, product_id: f.inputId })))).execute();
  await f.repo.checkpointTagExtractionBatchDecision(f.job.id, f.batch.id, [f.decision], metadata, claim, 'extract');
  // Make the row eligible for a bump even when the runner uses production coalescing.
  await db.updateTable('catalog_cache_versions').set({ updated_at: new Date(0) }).where('id', '=', 1).execute();
  const before = await db.selectFrom('catalog_cache_versions').select('version').where('id', '=', 1).executeTakeFirstOrThrow();
  const publishClaim = await claimPublish(f.batch.id);
  await new AiRepository(db).publishTagExtractionBatch(f.batch.id, publishClaim);
  const after = await db.selectFrom('catalog_cache_versions').select('version').where('id', '=', 1).executeTakeFirstOrThrow();
  assert.equal(after.version, before.version + 1n);
  assert.deepEqual((await db.selectFrom('products').select('text_review').where('id', '=', f.inputId).executeTakeFirstOrThrow()).text_review, f.stored);
  assert.deepEqual(await db.selectFrom('product_tags').select(['name', 'value']).where('product_id', '=', f.inputId).execute(), tags);
  const member = await db.selectFrom('ai_job_input_members').select('output').where('job_id', '=', f.job.id).executeTakeFirstOrThrow();
  assert.equal((member.output as any).outcome, 'updated');
  assert.deepEqual((member.output as any).diff, []);
  assert.deepEqual((member.output as any).textReview, f.review);
  await f.repo.publishTagExtractionBatch(f.batch.id, publishClaim);
  assert.deepEqual(await db.selectFrom('catalog_cache_versions').select('version').where('id', '=', 1).executeTakeFirstOrThrow(), after);
});
