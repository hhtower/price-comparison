import { tagRows } from './tag-fixtures.js';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { migrateToLatest } from '../scripts/migrate.js';
import { AiRepository } from '../src/ai/ai.repository.js';
import { JobsRepository } from '../src/jobs/jobs.repository.js';
import { parseStandardizationProtocolResponse } from '../src/ai/ai.schemas.js';
import type { ParsedStandardizationResponse, StandardizationDecision } from '../src/ai/ai.schemas.js';
import type { DatabaseSchema, JsonValue } from '../src/database/types.js';
import { jsonb } from '../src/database/types.js';
import { buildCanonicalStandardKey } from '../src/standardization/canonical-key.js';
import { productContentFingerprint } from '../src/standardization/fingerprint.js';
import { finalizeOrScheduleMissing } from '../src/ai/standardization-finalizer.js';
import { DomainConflictError } from '../src/common/errors.js';
import { recordCandidateCatalogChanges } from '../src/catalog/catalog-version.repository.js';
import { STANDARDIZATION_POLICY_VERSION } from '../src/ai/pipeline-versions.js';
import { CATALOG_ALIAS_VERSION } from '../src/standardization/catalog-aliases.js';
import { recordManualDecisions } from '../src/standardization/decision-history.js';
import { StandardizationRepository } from '../src/standardization/standardization.repository.js';
import { createOpenAiModelCall } from '../src/ai/ai.worker.js';
import { validateReviewedTagExtractionDecision } from '../src/ai/tag-extraction-result.js';
import { saveStandardizationThroughReview } from './standardization-review-fixture.js';
import { AdminRepository } from '../src/admin/admin.repository.js';

describe('AI identity standardization publication', () => {
  let database: Kysely<DatabaseSchema>;
  let pool: Pool;
  let admin: Pool;
  let schema = '';
  let sequence = 0;
  let plusId: bigint;
  const previousCatalogInterval = process.env.CATALOG_VERSION_BUMP_MIN_INTERVAL_MS;

  before(async () => {
    if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required for AI integration tests');
    schema = `ai_regroup_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
    admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`create schema "${schema}"`);
    process.env.PG_SCHEMA = schema;
    process.env.CATALOG_VERSION_BUMP_MIN_INTERVAL_MS = '0';
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path="${schema}",public`, max: 12 });
    database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    await migrateToLatest(database);
    plusId = await seedStandard('ChatGPT Plus', 'openai', 'chatgpt', 'plus');
  });

  after(async () => {
    await database?.destroy();
    if (admin && schema) await admin.query(`drop schema if exists "${schema}" cascade`);
    await admin?.end();
    delete process.env.PG_SCHEMA;
    if (previousCatalogInterval === undefined) delete process.env.CATALOG_VERSION_BUMP_MIN_INTERVAL_MS;
    else process.env.CATALOG_VERSION_BUMP_MIN_INTERVAL_MS = previousCatalogInterval;
  });

  async function addShop(enabled = true) {
    sequence += 1;
    return database.insertInto('shops').values({
      platform: 'integration', url: `https://shop.invalid/${sequence}`, name: `shop-${sequence}`, enabled,
      deleted_at: null, last_fetch_at: null, last_error: null,
    }).returning('id').executeTakeFirstOrThrow();
  }

  async function addProduct(shopId: bigint, name: string, spec = 'monthly', sourceData: Record<string, JsonValue> = { title: name, selected: spec }) {
    sequence += 1;
    const fingerprint = productContentFingerprint({ name, spec, sourceCategory: '', sourceData });
    return database.insertInto('products').values({
      shop_id: shopId, external_id: `p-${sequence}`, name, spec, source_category: '', source_data: jsonb(sourceData),
      normalized_key: `product-${sequence}`, url: `https://product.invalid/${sequence}`, deleted_at: null,
      content_version: 1n, content_fingerprint: fingerprint, standardization_locked: false,
    }).returning(['id', 'content_version', 'content_fingerprint']).executeTakeFirstOrThrow();
  }

  async function seedStandard(name: string, family: string, product: string, tier: string, aliases: string[] = []) {
    const row = await database.insertInto('standard_products').values({ catalog_definition: name + ': only this product and plan; duration and delivery are offer attributes.', name, canonical_family: family,
      canonical_product: product, canonical_tier: tier, standard_key: buildCanonicalStandardKey({ family, product, tier }),
      aliases, verification_state: 'verified' }).returning('id').executeTakeFirstOrThrow();
    await database.transaction().execute(tx => recordCandidateCatalogChanges(tx, [row.id], CATALOG_ALIAS_VERSION));
    return row.id;
  }

  function classified(id: bigint, standardProductId = plusId, quote = 'ChatGPT Plus'): StandardizationDecision {
    return parseStandardizationProtocolResponse({ items: [{ id: String(id), standardProductId: String(standardProductId),
      evidence: [{ path: 'name', quote }] }] }, [{ id: String(id), candidateStandardProductIds: [String(standardProductId)] }]).items[0]!;
  }

  async function createPreparedJob(productIds: bigint[], withFeatures = false, candidateIds?: bigint[]) {
    const repository = new AiRepository(database);
    const job = await repository.createJob({ model: `integration-${++sequence}`, productIds, batchSize: 32 });
    assert.equal(job.batches.length, 1);
    assert.equal(job.rule_version, STANDARDIZATION_POLICY_VERSION);
    const batchId = job.batches[0]!.id;
    if (withFeatures) {
      const feature = await database.selectFrom('ai_jobs').select('id').where('parent_identity_job_id', '=', job.id)
        .where('job_type', '=', 'membership_features').executeTakeFirst();
      if (feature) {
        const batches = await database.selectFrom('ai_job_batches').select('id').where('job_id', '=', feature.id).execute();
        for (const batch of batches) {
          await claim(batch.id, 'request', 1n, 'feature-claim');
          await repository.prepareBatch(batch.id);
          await repository.reserveBatchRequest(batch.id);
          const input = await repository.getTagExtractionBatchInputs(batch.id);
          await repository.persistTagExtractionBatchDecision(feature.id, batch.id,
            input.inputs.map(row => ({ productId: row.productId, tags: [], rejectedTags: [], reviewed: true,
              membershipKind: 'account' as const, classificationReviewed: true })), {},
            { workerId: 'integration', attempt: 1n, token: 'feature-claim' });
        }
      }
    }
    await claim(batchId, 'request', 1n, 'request-claim');
    await repository.prepareBatch(batchId);
    if (candidateIds) {
      const snapshot = await database.selectFrom('ai_job_batches').select('reference_snapshot').where('id', '=', batchId).executeTakeFirstOrThrow();
      const reference = snapshot.reference_snapshot as any;
      const standards = await database.selectFrom('standard_products').selectAll().where('id', 'in', candidateIds).execute();
      assert.equal(standards.length, candidateIds.length);
      reference.strategyVersion = 'approved-candidate-20261119-v1';
      reference.candidates = standards.map(row => ({ id: String(row.id), family: row.canonical_family,
        product: row.canonical_product, tier: row.canonical_tier, aliases: row.aliases, definition: row.catalog_definition, displayName: row.name }));
      for (const input of reference.inputs) input.candidateStandardProductIds = candidateIds.map(String);
      await database.updateTable('ai_job_batches').set({ reference_snapshot: jsonb(reference) }).where('id', '=', batchId).execute();
    }
    await repository.reserveBatchRequest(batchId, { workerId: 'integration', attempt: 1n, token: 'request-claim' });
    return { repository, job, batchId };
  }

  async function claim(batchId: bigint, step: 'request' | 'publish', attempt: bigint, token: string) {
    await database.updateTable('ai_job_batches').set({
      step, status: 'running', attempts: attempt, claimed_by: 'integration', claim_token: token,
      lease_until: new Date(Date.now() + 60_000), available_at: sql`now()`,
    }).where('id', '=', batchId).execute();
  }

  async function saveDecision(
    prepared: Awaited<ReturnType<typeof createPreparedJob>>,
    decision: ParsedStandardizationResponse,
    approve?: (proposal: StandardizationDecision) => boolean,
    metadata?: Parameters<AiRepository['persistBatchDecision']>[3],
  ) {
    prepared.batchId = await saveStandardizationThroughReview(database, prepared.repository, {
      jobId: prepared.job.id, batchId: prepared.batchId, decision, approve, metadata,
      claim: { workerId: 'integration', attempt: 1n, token: 'request-claim' },
    });
  }

  async function saveAndPublish(
    prepared: Awaited<ReturnType<typeof createPreparedJob>>,
    decision: ParsedStandardizationResponse,
    approve?: (proposal: StandardizationDecision) => boolean,
    metadata?: Parameters<AiRepository['persistBatchDecision']>[3],
  ) {
    await saveDecision(prepared, decision, approve, metadata);
    await claim(prepared.batchId, 'publish', 2n, 'publish-claim');
    await prepared.repository.publishBatch(prepared.batchId, { workerId: 'integration', attempt: 2n, token: 'publish-claim' });
  }

  test('streamed JSON is validated and reviewed before local publication', async () => {
    const shop = await addShop();
    const product = await addProduct(shop.id, 'ChatGPT Plus');
    const prepared = await createPreparedJob([product.id]);
    const evidence = [{ path: 'name', quote: 'ChatGPT Plus' }];
    let requests = 0;
    const call = createOpenAiModelCall(prepared.repository, {
      AI_BASE_URL: 'https://model.invalid/v1', AI_API_KEY: 'mock', AI_MODEL: 'mock',
    }, async (_url, init) => {
      requests++;
      const sent = JSON.parse(String(init?.body));
      assert.equal(sent.stream, true);
      assert.deepEqual(sent.response_format, { type: 'json_object' });
      const input = JSON.parse(sent.messages[1].content).items[0];
      const content = JSON.stringify({ items: [{
        id: input.id, standardProductId: String(plusId), evidence,
      }] });
      const fragments = [content.slice(0, 4), content.slice(4, -2), content.slice(-2)];
      return new Response(fragments.map((part, index) =>
        `data: ${JSON.stringify({ choices: [{ delta: { content: part }, ...(index === fragments.length - 1 ? { finish_reason: 'stop' } : {}) }] })}\n\n`,
      ).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    });
    const { metadata, standardizationStage, items, missingIds } = await call({ id: prepared.batchId }, new AbortController().signal);
    assert.equal(standardizationStage, 'generate');
    await saveAndPublish(prepared, { items, missingIds }, undefined, metadata);
    const result = await database.selectFrom('ai_standardization_results').select(['status', 'reason_code', 'standard_product_id'])
      .where('job_id', '=', prepared.job.id).where('product_id', '=', product.id).executeTakeFirstOrThrow();
    const member = await database.selectFrom('standard_product_members').select('standard_product_id')
      .where('product_id', '=', product.id).executeTakeFirstOrThrow();
    const batch = await database.selectFrom('ai_job_batches').select(['status', 'step', 'request_budget_used', 'confirmed_requests'])
      .where('id', '=', prepared.batchId).executeTakeFirstOrThrow();
    assert.equal(requests, 1);
    assert.equal(result.status, 'classified');
    assert.equal(result.reason_code, null);
    assert.equal(result.standard_product_id, member.standard_product_id);
    assert.deepEqual(batch, { status: 'succeeded', step: 'done', request_budget_used: 1, confirmed_requests: 1 });
  });

  test('independent service listings select the same explicitly admitted candidate without creating standards', async () => {
    const shop = await addShop();
    for (const [family, canonicalProduct, names] of [
      ['openai', 'codex_sms', ['OpenAI 手机接码服务', 'ChatGPT 手机接码服务']],
      ['anthropic', 'claude_sms', ['Anthropic 手机接码服务', 'Claude Code 手机接码服务']],
      ['google', 'google_sms', ['Google 手机接码服务', 'Gemini 手机接码服务']],
    ] as const) {
      const targetId = await seedStandard(names[0], family, canonicalProduct, 'standard', [...names]);
      const before = await database.selectFrom('standard_products').select('id').orderBy('id').execute();
      for (const name of names) {
        const product = await addProduct(shop.id, name);
        const prepared = await createPreparedJob([product.id], false, [targetId]);
        await saveAndPublish(prepared, { items: [classified(product.id, targetId, name)], missingIds: [] });
        assert.equal((await database.selectFrom('standard_product_members').select('standard_product_id').where('product_id', '=', product.id).executeTakeFirstOrThrow()).standard_product_id, targetId);
      }
      assert.deepEqual(await database.selectFrom('standard_products').select('id').orderBy('id').execute(), before);
    }
  });

  test('fenced JSON is rejected without a compatibility unwrap or partial checkpoint', async () => {
    const shop = await addShop(); const product = await addProduct(shop.id, 'ChatGPT Plus fenced response');
    const prepared = await createPreparedJob([product.id]);
    const content = '```json\n' + JSON.stringify({ items: [{
      id: String(product.id), standardProductId: String(plusId), evidence: [{ path: 'name', quote: 'ChatGPT Plus' }],
    }] }) + '\n```';
    const call = createOpenAiModelCall(prepared.repository, {
      AI_BASE_URL: 'https://model.invalid/v1', AI_API_KEY: 'mock', AI_MODEL: 'mock',
    }, async () => new Response('data: ' + JSON.stringify({ choices: [{
      delta: { content }, finish_reason: 'stop',
    }] }) + '\n\ndata: [DONE]\n\n'));
    await assert.rejects(call({ id: prepared.batchId }, new AbortController().signal), { retryClass: 'invalid_response' });
    assert.equal((await database.selectFrom('ai_job_batches').select('validated_decision')
      .where('id', '=', prepared.batchId).executeTakeFirstOrThrow()).validated_decision, null);
    assert.deepEqual(await database.selectFrom('ai_standardization_results').select('product_id')
      .where('job_id', '=', prepared.job.id).execute(), []);
    await prepared.repository.cancelJob(prepared.job.id);
  });

  test('binary review rejects non-SMS evidence for a frozen existing SMS candidate', async () => {
    const shop = await addShop();
    const name = '域名邮箱 接马 (二次码|OpenAI业务)';
    const product = await addProduct(shop.id, name);
    const targetId = await seedStandard('SMS review target', 'sms-review', 'sms_service', 'standard');
    const prepared = await createPreparedJob([product.id], false, [targetId]);
    await saveAndPublish(prepared, { items: [classified(product.id, targetId, name)], missingIds: [] }, () => false);
    assert.deepEqual(await database.selectFrom('standard_product_members').select('product_id').where('product_id', '=', product.id).execute(), []);
    assert.deepEqual(await database.selectFrom('ai_standardization_results').select(['status', 'reason_code']).where('job_id', '=', prepared.job.id).executeTakeFirstOrThrow(),
      { status: 'unclassified', reason_code: 'review_rejected' });
  });

  test('saved publication cannot bypass a task policy upgrade', async () => {
    const shop = await addShop(); const product = await addProduct(shop.id, 'ChatGPT Plus old policy');
    const prepared = await createPreparedJob([product.id]);
    await saveDecision(prepared, { items: [classified(product.id)], missingIds: [] });
    await database.updateTable('ai_jobs').set({ rule_version: 'catalog-identity-20260925-v3' }).where('id', '=', prepared.job.id).execute();
    await claim(prepared.batchId, 'publish', 2n, 'publish-claim');
    await assert.rejects(prepared.repository.publishBatch(prepared.batchId, { workerId: 'integration', attempt: 2n, token: 'publish-claim' }),
      error => error instanceof DomainConflictError && error.code === 'AI_POLICY_STALE');
    assert.deepEqual(await database.selectFrom('standard_product_members').select('product_id').where('product_id', '=', product.id).execute(), []);
    await database.updateTable('ai_jobs').set({ status: 'cancelled' }).where('id', '=', prepared.job.id).execute();
  });

  test('publication preserves the frozen reviewed target despite a larger same-name group', async () => {
    const shop = await addShop(); const name = '微软邮箱长效 Outlook Hotmail OAuth2 双令牌';
    const majorityId = await seedStandard('Microsoft Outlook', 'microsoft', 'outlook', 'standard');
    const minorityId = await seedStandard('Outlook account', 'email', 'outlook_account', 'standard');
    for (const standardId of [majorityId, majorityId, majorityId, minorityId]) {
      const peer = await addProduct(shop.id, name);
      await database.insertInto('standard_product_members').values({ product_id: peer.id, standard_product_id: standardId, assignment_source: 'ai' }).execute();
    }
    const source = await addProduct(shop.id, name);
    const prepared = await createPreparedJob([source.id], false, [majorityId, minorityId]);
    await saveAndPublish(prepared, { items: [classified(source.id, minorityId, name)], missingIds: [] });
    assert.equal((await database.selectFrom('standard_product_members').select('standard_product_id').where('product_id', '=', source.id).executeTakeFirstOrThrow()).standard_product_id, minorityId);
    const result = await database.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', prepared.job.id).executeTakeFirstOrThrow();
    assert.equal(result.standard_product_id, minorityId);
    assert.equal((result.decision as unknown as StandardizationDecision).review?.approved, true);
    assert.deepEqual((result.decision as unknown as StandardizationDecision).ruleIds, []);
  });

  test('model relay offers are excluded before model requests while ordinary offers still match candidates', async () => {
    const shop = await addShop();
    const relay = await addProduct(shop.id, 'Codex API 中转充值 100刀');
    const ordinary = await addProduct(shop.id, 'ChatGPT Plus 账号');
    const prepared = await createPreparedJob([relay.id, ordinary.id]);
    assert.equal(prepared.job.processed, 1n);
    assert.equal(prepared.job.unclassified, 1n);
    assert.deepEqual(await database.selectFrom('ai_standardization_results').select(['product_id', 'batch_id', 'reason_code'])
      .where('job_id', '=', prepared.job.id).execute(),
    [{ product_id: relay.id, batch_id: null, reason_code: 'api_relay_excluded' }]);
    const request = await prepared.repository.getBatchRequest(prepared.batchId);
    assert.deepEqual(request.inputs.map(input => input.productId), [ordinary.id]);
    await saveAndPublish(prepared, { items: [classified(ordinary.id, plusId, 'ChatGPT Plus 账号')], missingIds: [] });
    assert.ok(await database.selectFrom('products').select('id').where('id', '=', relay.id).executeTakeFirst());
    assert.equal((await prepared.repository.listGlobalResults({ limit: 100 })).items.some(item => item.productId === String(relay.id)), false);
    const pending = await new AdminRepository(database).listProducts({ pending: true, shopId: shop.id, limit: 100 });
    assert.equal(pending.items.some(item => item.id === relay.id), false);
    assert.equal((await prepared.repository.listRetryPool({ limit: 100 })).items.some(item => item.productId === String(relay.id)), false);
    await database.updateTable('products').set({ content_version: sql`content_version + 1` }).where('id', '=', relay.id).execute();
    const changed = await new AdminRepository(database).listProducts({ pending: true, shopId: shop.id, limit: 100 });
    assert.equal(changed.items.some(item => item.id === relay.id), true);
  });

  test('an all-relay job completes locally without a model batch', async () => {
    const shop = await addShop();
    const relay = await addProduct(shop.id, 'Claude API 中转余额充值');
    const repository = new AiRepository(database);
    const job = await repository.createJob({ model: 'mock', productIds: [relay.id] });
    assert.deepEqual(job.batches, []);
    assert.equal(job.status, 'succeeded');
    assert.equal(job.processed, 1n);
    assert.equal((await database.selectFrom('ai_standardization_executions').select('status')
      .where('job_id', '=', job.id).executeTakeFirstOrThrow()).status, 'completed');
  });

  test('deleted products and inactive shops are skipped before reserving an LLM request', async () => {
    for (const invalidate of ['product', 'shop'] as const) {
      const shop = await addShop();
      const source = await addProduct(shop.id, `Queued source ${invalidate}`);
      const repository = new AiRepository(database);
      const job = await repository.createJob({ model: 'mock', productIds: [source.id] });
      const batchId = job.batches[0]!.id;
      await claim(batchId, 'request', 1n, 'request-claim');
      if (invalidate === 'product') await database.updateTable('products').set({ deleted_at: sql`now()` }).where('id', '=', source.id).execute();
      else await database.updateTable('shops').set({ enabled: false }).where('id', '=', shop.id).execute();

      await repository.prepareBatch(batchId);
      assert.deepEqual((await repository.getBatchRequest(batchId)).inputs, []);
      assert.equal(await repository.reserveBatchRequest(batchId, { workerId: 'integration', attempt: 1n, token: 'request-claim' }), 'skipped');
      const finished = await database.selectFrom('ai_job_batches').select(['step', 'status', 'request_budget_used']).where('id', '=', batchId).executeTakeFirstOrThrow();
      assert.deepEqual(finished, { step: 'done', status: 'succeeded', request_budget_used: 0 });
      const result = await database.selectFrom('ai_standardization_results').select(['status', 'reason_code']).where('job_id', '=', job.id).where('product_id', '=', source.id).executeTakeFirstOrThrow();
      assert.deepEqual(result, { status: 'unclassified', reason_code: 'source_changed' });
    }
  });

  test('local relay exclusions preserve persistent locks and current manual decisions', async () => {
    const shop = await addShop();
    for (const protection of ['lock', 'review'] as const) {
      const name = 'Codex API 中转充值 ' + protection;
      const source = await addProduct(shop.id, name);
      if (protection === 'lock') await database.updateTable('products').set({ standardization_locked: true }).where('id', '=', source.id).execute();
      else await database.transaction().execute(tx => recordManualDecisions(tx, [source.id], { action: 'quarantine', standardProductId: null, reason: 'Preserve human review' }));
      const before = await database.selectFrom('products').selectAll().where('id', '=', source.id).executeTakeFirstOrThrow();
      const decisions = await database.selectFrom('product_standardization_decisions').selectAll().where('product_id', '=', source.id).execute();
      const job = await new AiRepository(database).createJob({ model: 'mock', productIds: [source.id] });
      assert.deepEqual(job.batches, []);
      assert.deepEqual(await database.selectFrom('standard_product_members').select('product_id').where('product_id', '=', source.id).execute(), []);
      assert.deepEqual(await database.selectFrom('products').selectAll().where('id', '=', source.id).executeTakeFirstOrThrow(), before);
      assert.deepEqual(await database.selectFrom('product_standardization_decisions').selectAll().where('product_id', '=', source.id).execute(), decisions);
    }
  });

  test('incremental registration is atomic with outbox consumption', async () => {
    const shop = await addShop();
    const relay = await addProduct(shop.id, '模型 API 中转充值 100美元');
    const event = await database.insertInto('product_change_events').values({
      product_id: relay.id, shop_id: shop.id, event_type: 'evidence_changed',
      content_version: relay.content_version, fingerprint: relay.content_fingerprint, payload: jsonb({ name: '模型 API 中转充值 100美元' }),
    }).returning('id').executeTakeFirstOrThrow();
    const outbox = await database.insertInto('standardization_outbox').values({
      product_id: relay.id, event_id: event.id, fingerprint: relay.content_fingerprint,
      status: 'running', claimed_by: 'exclusion-test', claim_token: 'exclusion-claim', attempts: 1n,
      lease_until: new Date(Date.now() + 60000),
    }).returningAll().executeTakeFirstOrThrow();
    const oldModel = process.env.AI_MODEL;
    process.env.AI_MODEL = 'mock';
    try {
      const real = new AiRepository(database);
      const throwing = {
        createJob: async (input: Parameters<AiRepository['createJob']>[0], tx: Parameters<AiRepository['createJob']>[1]) => {
          const job = await real.createJob(input, tx);
          assert.equal((await tx!.selectFrom('ai_job_batches').select('id').where('job_id', '=', job.id).execute()).length, 0);
          throw new Error('after registration before outbox acknowledgement');
        },
      } as unknown as AiRepository;
      await assert.rejects(new StandardizationRepository(database, throwing).createIncrementalJob({
        outbox: [outbox], workerId: 'exclusion-test', priority: 50,
      }), /after registration/);
      assert.equal((await database.selectFrom('standardization_outbox').select('status').where('id', '=', outbox.id).executeTakeFirstOrThrow()).status, 'running');
      assert.equal((await database.selectFrom('ai_standardization_results').select('job_id').where('product_id', '=', relay.id).execute()).length, 0);
      const created = await new StandardizationRepository(database, real).createIncrementalJob({
        outbox: [outbox], workerId: 'exclusion-test', priority: 50,
      });
      assert.ok(created);
      assert.equal((await database.selectFrom('standardization_outbox').select('status').where('id', '=', outbox.id).executeTakeFirstOrThrow()).status, 'succeeded');
      assert.deepEqual(await database.selectFrom('ai_standardization_results').select('product_id').where('job_id', '=', created.id).execute(), [{ product_id: relay.id }]);
      assert.equal((await database.selectFrom('ai_job_batches').select('id').where('job_id', '=', created.id).execute()).length, 0);
      const duplicate = await real.createJob({ model: 'mock', productIds: [relay.id], jobType: 'incremental' });
      assert.equal(duplicate.total, 0n);
      assert.equal((await database.selectFrom('ai_standardization_results').select('job_id').where('product_id', '=', relay.id).execute()).length, 1);
    } finally {
      if (oldModel === undefined) delete process.env.AI_MODEL;
      else process.env.AI_MODEL = oldModel;
    }
  });

  test('concurrent incremental registration records a local relay exclusion once', async () => {
    const shop = await addShop();
    const relay = await addProduct(shop.id, '模型 API 中转充值 500美元');
    const jobs = await Promise.all([new AiRepository(database), new AiRepository(database)].map(repository =>
      repository.createJob({ model: 'mock', productIds: [relay.id], jobType: 'incremental' })));
    assert.deepEqual(jobs.map(job => Number(job.total)).sort(), [0, 1]);
    const results = await database.selectFrom('ai_standardization_results').select('job_id').where('product_id', '=', relay.id).execute();
    const executions = await database.selectFrom('ai_standardization_executions').select('job_id').where('product_id', '=', relay.id).execute();
    assert.equal(results.length, 1);
    assert.deepEqual(executions, [{ job_id: jobs.find(job => job.total === 1n)!.id }]);
  });

  test('binary rejection blocks contradictory first-login promises without creating a verified identity', async () => {
    const shop = await addShop();
    const source = await addProduct(shop.id, 'ChatGPT Plus 账号 首登质保2小时', '1 month');
    const sourceData = { evidence: '提供Plus账号密码2FA。仅质保下单后1小时内首次登录。' };
    await database.updateTable('products').set({
      source_data: jsonb(sourceData),
      content_fingerprint: productContentFingerprint({ name: 'ChatGPT Plus 账号 首登质保2小时', spec: '1 month', sourceData }),
    }).where('id', '=', source.id).execute();
    const prepared = await createPreparedJob([source.id]);
    const before = await database.selectFrom('standard_products').select('id').execute();
    await saveAndPublish(prepared, { items: [classified(source.id, plusId)], missingIds: [] }, () => false);
    const result = await database.selectFrom('ai_standardization_results').selectAll()
      .where('job_id', '=', prepared.job.id).executeTakeFirstOrThrow();
    assert.equal(result.status, 'unclassified');
    assert.equal(result.reason_code, 'review_rejected');
    assert.equal((await database.selectFrom('standard_product_members').select('product_id').where('product_id', '=', source.id).execute()).length, 0);
    assert.equal((await database.selectFrom('product_tags').select('id').where('product_id', '=', source.id).execute()).length, 0);
    assert.deepEqual(await database.selectFrom('standard_products').select('id').execute(), before);
  });

  test('same-name majority cannot replace one frozen reviewed target across products', async () => {
    const shop = await addShop(); const name = '独立测试邮箱长效 OAuth2 账号';
    const majorityId = await seedStandard('Netease mail', 'netease', '163_mail', 'standard');
    const selectedId = await seedStandard('Another mail account', 'another_vendor', 'mail_account', 'standard');
    for (let index = 0; index < 2; index++) {
      const peer = await addProduct(shop.id, name);
      await database.insertInto('standard_product_members').values({ product_id: peer.id, standard_product_id: majorityId }).execute();
    }
    const source = await addProduct(shop.id, name), unrelated = await addProduct(shop.id, name + ' 第二品牌');
    const prepared = await createPreparedJob([source.id, unrelated.id], false, [majorityId, selectedId]);
    await saveAndPublish(prepared, { items: [source, unrelated].map(product => classified(product.id, selectedId, name)), missingIds: [] });
    const members = await database.selectFrom('standard_product_members').select('standard_product_id').where('product_id', 'in', [source.id, unrelated.id]).execute();
    assert.equal(members.length, 2); assert.ok(members.every(member => member.standard_product_id === selectedId));
  });

  test('concurrent same-name publications retain their distinct frozen existing IDs', async () => {
    const shop = await addShop(); const name = '并发测试 Example 邮箱账户完整名称';
    const first = await addProduct(shop.id, name), second = await addProduct(shop.id, name);
    const targets = [await seedStandard('Example mail zero', 'example', 'mail_0', 'standard'),
      await seedStandard('Example mail one', 'example', 'mail_1', 'standard')];
    const prepared = [await createPreparedJob([first.id], false, targets), await createPreparedJob([second.id], false, targets)];
    for (const [index, task] of prepared.entries()) {
      await saveDecision(task, { items: [classified(task.job.inputs[0]!.productId, targets[index]!, name)], missingIds: [] });
      await claim(task.batchId, 'publish', 2n, 'publish-claim');
    }
    const before = await database.selectFrom('standard_products').select('id').orderBy('id').execute();
    await Promise.all(prepared.map(task => task.repository.publishBatch(task.batchId, { workerId: 'integration', attempt: 2n, token: 'publish-claim' })));
    assert.deepEqual(await database.selectFrom('standard_product_members').select(['product_id', 'standard_product_id']).where('product_id', 'in', [first.id, second.id]).orderBy('product_id').execute(),
      [{ product_id: first.id, standard_product_id: targets[0] }, { product_id: second.id, standard_product_id: targets[1] }]);
    assert.deepEqual(await database.selectFrom('standard_products').select('id').orderBy('id').execute(), before);
  });

  test('Grok same-evidence listings deduplicate and reuse the canonical candidate across requests', async () => {
    const shop = await addShop();
    const source = await addProduct(shop.id, 'Grok 普号', '');
    const fields = { family: 'xai', product: 'grok', tier: 'free' };
    const standard = await database.insertInto('standard_products').values({ catalog_definition: 'Explicit fixture admission: only the named product and plan; duration and delivery do not change identity.',
      name: 'Grok 普通账号', aliases: ['gro普号(库存)'], standard_key: buildCanonicalStandardKey(fields),
      canonical_family: fields.family, canonical_product: fields.product, canonical_tier: fields.tier, verification_state: 'verified',
    }).returning('id').executeTakeFirstOrThrow();
    await database.insertInto('standard_product_members').values({ standard_product_id: standard.id, product_id: source.id, publication_state: 'published' }).execute();
    const products = [];
    for (const id of [1, 2]) {
      const product = await addProduct(shop.id, 'gro普号(库存)', '');
      await database.updateTable('products').set({ source_data: jsonb({
        category: { id, name: 'gro' }, create_time: id, user: { nickname: `店铺${id}` },
        evidence: '清库存，有一些可用build，有的只能console和web',
      }) }).where('id', '=', product.id).execute();
      products.push(product.id);
    }
    const prepared = await createPreparedJob(products);
    assert.equal(prepared.job.inputs.length, 1, 'source IDs and shop metadata must not create separate model inputs');
    const request = await prepared.repository.getBatchRequest(prepared.batchId);
    assert.ok(request.inputs[0]!.candidateStandardProductIds.includes(standard.id.toString()), 'the canonical Grok free candidate must be supplied');
    const representative = request.inputs[0]!.productId;
    const evidence = [{ path: 'name', quote: 'gro普号(库存)' }];
    const parsed = parseStandardizationProtocolResponse({
      items: [{ id: representative.toString(), standardProductId: String(standard.id), evidence }],
    }, [{ id: representative.toString(), candidateStandardProductIds: request.inputs[0]!.candidateStandardProductIds }]);
    await saveAndPublish(prepared, parsed);
    const members = await database.selectFrom('standard_product_members').select('standard_product_id').where('product_id', 'in', products).execute();
    assert.equal(members.length, 2);
    assert.ok(members.every(member => member.standard_product_id === standard.id));
  });

  test('publication cannot resurrect a standard merged after candidate preparation', async () => {
    const shop = await addShop(); const name = 'Merged account free';
    const sourceId = await seedStandard(name, 'merge-test', 'account', 'free');
    const targetId = await seedStandard('Manual merge target', 'merge-target', 'account', 'standard');
    const probe = await addProduct(shop.id, name);
    const prepared = await createPreparedJob([probe.id], false, [sourceId]);
    await saveDecision(prepared, { items: [classified(probe.id, sourceId, name)], missingIds: [] });
    await database.updateTable('standard_products').set({ merged_into_id: targetId, hidden: true }).where('id', '=', sourceId).execute();
    await claim(prepared.batchId, 'publish', 2n, 'publish-claim');
    await prepared.repository.publishBatch(prepared.batchId, { workerId: 'integration', attempt: 2n, token: 'publish-claim' });
    assert.deepEqual(await database.selectFrom('ai_standardization_results').select(['status', 'reason_code']).where('job_id', '=', prepared.job.id).executeTakeFirstOrThrow(),
      { status: 'unclassified', reason_code: 'publication_blocked' });
    assert.deepEqual(await database.selectFrom('standard_product_members').select('product_id').where('product_id', '=', probe.id).execute(), []);
  });

  test('admitted standards remain candidates after all historical members are deleted', async () => {
    const shop = await addShop();
    const fields = { family: 'expired-mail', product: 'mail_account', tier: 'standard' };
    const target = await database.insertInto('standard_products').values({ catalog_definition: 'Explicit fixture admission: only the named product and plan; duration and delivery do not change identity.', name: '已归档邮箱套餐', canonical_family: fields.family,
      canonical_product: fields.product, canonical_tier: fields.tier, standard_key: buildCanonicalStandardKey(fields), verification_state: 'verified' }).returning('id').executeTakeFirstOrThrow();
    const old = await addProduct(shop.id, '已归档邮箱套餐');
    await database.insertInto('standard_product_members').values({ product_id: old.id, standard_product_id: target.id, publication_state: 'published' }).execute();
    await database.updateTable('products').set({ deleted_at: new Date() }).where('id', '=', old.id).execute();
    const change = await database.transaction().execute(tx => recordCandidateCatalogChanges(tx, [target.id], CATALOG_ALIAS_VERSION));
    const operation = await database.selectFrom('catalog_index_changes').select('operation').where('standard_product_id', '=', target.id).where('version', '=', change.version).executeTakeFirstOrThrow();
    assert.equal(operation.operation, 'upsert');
    const probe = await addProduct(shop.id, '已归档邮箱套餐');
    const prepared = await createPreparedJob([probe.id]);
    const request = await prepared.repository.getBatchRequest(prepared.batchId);
    assert.equal(request.inputs[0]!.candidateStandardProductIds.includes(target.id.toString()), true);
    await prepared.repository.cancelJob(prepared.job.id);
  });

  test('request windows follow configured concurrency for new jobs and both claim paths', async () => {
    const previous = process.env.AI_CONCURRENCY;
    const repository = new AiRepository(database);
    const queue = new JobsRepository(database);
    // Earlier publication tests leave independently scheduled tag jobs queued.
    for (const prior of await database.selectFrom('ai_jobs').select('id').where('status', 'in', ['queued', 'running']).execute()) await repository.cancelJob(prior.id);
    const shop = await addShop();
    const productIds: bigint[] = [];
    for (let index = 0; index < 6; index++) productIds.push((await addProduct(shop.id, `ChatGPT Free window listing ${index}`)).id);
    try {
      for (const mode of ['bulk', 'single'] as const) {
        process.env.AI_CONCURRENCY = '4';
        const job = await repository.createJob({ model: 'window-test', productIds, batchSize: 1 });
        try {
          assert.equal(job.request_window_size, 4);
          assert.equal(job.batches.length, 6);
          // Existing jobs retain an old window, but scheduling must use current configuration.
          await database.updateTable('ai_jobs').set({ request_window_size: 2 }).where('id', '=', job.id).execute();
          assert.equal(await queue.queueDepth('ai_batch'), 4);
          if (mode === 'bulk') {
            assert.equal((await queue.claimAvailable('ai_standardization', 'window-worker', 10)).length, 4);
          } else {
            for (let index = 0; index < 4; index++) assert.ok(await queue.claimNext('ai_batch', 'window-worker', 60_000));
            assert.equal(await queue.claimNext('ai_batch', 'window-worker', 60_000), null);
          }
          assert.equal(await queue.queueDepth('ai_batch'), 0);
          assert.equal((await database.selectFrom('ai_jobs').select('request_window_size').where('id', '=', job.id).executeTakeFirstOrThrow()).request_window_size, 4);
          // Lowering the limit does not cancel in-flight work or make more work eligible.
          process.env.AI_CONCURRENCY = '1';
          assert.equal(await queue.queueDepth('ai_batch'), 0);
          assert.equal((await queue.claimAvailable('ai_standardization', 'window-worker', 10)).length, 0);
          // Increasing it opens more slots even while the persisted value is still four.
          process.env.AI_CONCURRENCY = '5';
          assert.equal(await queue.queueDepth('ai_batch'), 1);
          assert.equal((await queue.claimAvailable('ai_standardization', 'window-worker', 10)).length, 1);
        } finally { await repository.cancelJob(job.id); }
      }
      process.env.AI_CONCURRENCY = '65';
      const largeWindow = await repository.createJob({ model: 'window-test', productIds: [productIds[0]!] });
      assert.equal(largeWindow.request_window_size, 65, 'the old independent database cap must not override AI_CONCURRENCY');
      await repository.cancelJob(largeWindow.id);
    } finally {
      if (previous === undefined) delete process.env.AI_CONCURRENCY;
      else process.env.AI_CONCURRENCY = previous;
    }
  });

  test('paused publication can requeue and resume without repeating a model request', async () => {
    const shop = await addShop();
    const product = await addProduct(shop.id, 'ChatGPT Plus interrupted publication');
    const prepared = await createPreparedJob([product.id]);
    await saveDecision(prepared, {
      items: [classified(prepared.job.inputs[0]!.productId, plusId)], missingIds: [],
    });
    await claim(prepared.batchId, 'publish', 2n, 'publish-claim');
    await prepared.repository.pauseJob(prepared.job.id);
    await assert.rejects(prepared.repository.publishBatch(prepared.batchId), /cannot publish/);
    const queue = new JobsRepository(database);
    await queue.requeue('ai_batch', prepared.batchId, 'integration');
    const interrupted = await database.selectFrom('ai_job_batches').select(['status', 'step', 'error_source', 'request_budget_used', 'confirmed_requests']).where('id', '=', prepared.batchId).executeTakeFirstOrThrow();
    assert.deepEqual(interrupted, { status: 'queued', step: 'publish', error_source: 'local', request_budget_used: 1, confirmed_requests: 1 });
    await prepared.repository.resumeJob(prepared.job.id);
    await claim(prepared.batchId, 'publish', 3n, 'resumed-claim');
    await prepared.repository.publishBatch(prepared.batchId, { workerId: 'integration', attempt: 3n, token: 'resumed-claim' });
    // Completion interrupted after publishing must stay successful.
    await queue.requeue('ai_batch', prepared.batchId, 'integration');
    const finished = await database.selectFrom('ai_job_batches').select(['status', 'request_budget_used', 'confirmed_requests']).where('id', '=', prepared.batchId).executeTakeFirstOrThrow();
    assert.deepEqual(finished, { status: 'succeeded', request_budget_used: 1, confirmed_requests: 1 });
    assert.equal((await database.selectFrom('standard_product_members').select('product_id').where('product_id', '=', product.id).execute()).length, 1);
  });

  test('uncertain request interrupted while paused remains terminal with its original budget', async () => {
    const shop = await addShop();
    const product = await addProduct(shop.id, 'ChatGPT Plus uncertain request');
    const repository = new AiRepository(database);
    const job = await repository.createJob({ model: 'integration-unknown', productIds: [product.id] });
    const batchId = job.batches[0]!.id;
    await claim(batchId, 'request', 1n, 'request-claim');
    await repository.prepareBatch(batchId);
    await repository.reserveBatchRequest(batchId, { workerId: 'integration', attempt: 1n, token: 'request-claim' });
    await repository.pauseJob(job.id);
    await new JobsRepository(database).requeue('ai_batch', batchId, 'integration');
    assert.deepEqual(await database.selectFrom('ai_job_batches').select(['status', 'error_source', 'request_budget_used', 'confirmed_requests']).where('id', '=', batchId).executeTakeFirstOrThrow(), {
      status: 'failed', error_source: 'request_outcome_unknown', request_budget_used: 1, confirmed_requests: 0,
    });
  });

  test('old wire output throws a technical validation error and cannot assign or create a standard', async () => {
    const shop = await addShop(); const product = await addProduct(shop.id, 'ChatGPT Plus malformed output');
    const prepared = await createPreparedJob([product.id]); const id = String(product.id);
    const before = await database.selectFrom('standard_products').select('id').orderBy('id').execute();
    assert.throws(() => parseStandardizationProtocolResponse({ items: [{
      id, action: 'create_identity', identity: { family: 'openai', product: 'chatgpt', tier: 'new' }, ruleIds: [], evidence: [],
    }] }, [{ id, candidateStandardProductIds: [String(plusId)] }]), { reasonCode: 'invalid_response' });
    assert.equal((await database.selectFrom('ai_job_batches').select('validated_decision').where('id', '=', prepared.batchId).executeTakeFirstOrThrow()).validated_decision, null);
    assert.deepEqual(await database.selectFrom('standard_product_members').select('product_id').where('product_id', '=', product.id).execute(), []);
    assert.deepEqual(await database.selectFrom('standard_products').select('id').orderBy('id').execute(), before);
    await prepared.repository.cancelJob(prepared.job.id);
  });

  async function failUnknownJob(productIds: bigint[]) {
    const repository = new AiRepository(database);
    const job = await repository.createJob({ model: 'integration-unknown', productIds });
    for (const batch of job.batches) {
      await claim(batch.id, 'request', 1n, 'request-claim');
      await repository.prepareBatch(batch.id);
      await repository.reserveBatchRequest(batch.id);
      await repository.recordBatchRequestOutcome(batch.id, 'unknown');
      await new JobsRepository(database).fail('ai_batch', batch.id, 'integration', 'AI response timed out after 180000ms', { retry: false, retryClass: 'provider_unknown' });
    }
    return { repository, job };
  }


  test('historical unknown results expose the saved batch failure cause', async () => {
    const shop = await addShop();
    const product = await addProduct(shop.id, 'ChatGPT Plus historical timeout');
    const { repository, job } = await failUnknownJob([product.id]);
    await database.updateTable('ai_standardization_results').set({ reason: '模型请求结果未知，未重发以避免重复调用' }).where('job_id', '=', job.id).execute();
    const page = await repository.listJobResults({ jobId: job.id, limit: 10 });
    assert.match(String(page.items[0]?.reason), /超时/);
    assert.match(String(page.items[0]?.reason), /180/);
  });

  test('whole-response format failure retains its specific reason through finalization', async () => {
    const shop = await addShop();
    const product = await addProduct(shop.id, 'ChatGPT Plus invalid identity reference');
    const prepared = await createPreparedJob([product.id]);
    const reason = 'AI identity ref 无效：字符串为空';
    await new JobsRepository(database).fail('ai_batch', prepared.batchId, 'integration', reason, { retry: false, retryClass: 'invalid_response' });
    const page = await prepared.repository.listJobResults({ jobId: prepared.job.id, limit: 10 });
    assert.equal(page.items[0]?.reasonCode, 'invalid_response');
    assert.equal(page.items[0]?.reason, reason);
  });

  test('completed invalid responses keep durable diagnostics and provider metadata without saving a decision', async () => {
    const shop = await addShop();
    const product = await addProduct(shop.id, 'ChatGPT Plus response audit');
    const prepared = await createPreparedJob([product.id]);
    const content = '{"items":"private-response-body"}';
    const call = createOpenAiModelCall(prepared.repository, {
      AI_BASE_URL: 'https://model.invalid/v1', AI_API_KEY: 'mock', AI_MODEL: 'mock',
    }, async () => new Response([
      { id: 'audit-response-1', model: 'actual-model', choices: [{ delta: { content }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } },
    ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'));
    let failure: any;
    try { await call({ id: prepared.batchId }, new AbortController().signal); }
    catch (error) { failure = error; }
    assert.equal(failure.retryClass, 'invalid_response');
    const claim = { workerId: 'integration', attempt: 1n, token: 'request-claim' };
    await assert.rejects(prepared.repository.recordBatchRequestOutcome(prepared.batchId, 'confirmed', failure.responseMetadata,
      { ...claim, token: 'stale' }), /stale batch response audit/);
    await prepared.repository.recordBatchRequestOutcome(prepared.batchId, 'confirmed', failure.responseMetadata, claim);
    await prepared.repository.recordBatchRequestOutcome(prepared.batchId, 'confirmed', failure.responseMetadata, claim);
    await new JobsRepository(database).fail('ai_batch', prepared.batchId, 'integration', failure.message,
      { retry: false, retryClass: 'invalid_response' });
    const batch = await database.selectFrom('ai_job_batches').selectAll().where('id', '=', prepared.batchId).executeTakeFirstOrThrow();
    assert.equal(batch.confirmed_requests, 1, 'audit retries do not count another provider request');
    assert.equal(batch.request_budget_used, 1);
    assert.equal(batch.validated_decision, null);
    assert.equal(batch.response_id, 'audit-response-1');
    assert.equal((batch.response_usage as any).totalTokens, 30);
    assert.equal((batch.response_diagnostic as any).code, 'items_type_invalid');
    assert.equal((batch.response_diagnostic as any).constraint.actualType, 'string');
    assert.doesNotMatch(JSON.stringify(batch.response_diagnostic), /private-response-body/);
    const snapshot = await prepared.repository.adminJobSnapshot(prepared.job.id);
    assert.equal((snapshot.errors[0]!.diagnostic as any).fieldPath, 'items');
    assert.equal(snapshot.errors[0]!.responseId, 'audit-response-1');
    await assert.rejects(prepared.repository.recordBatchRequestOutcome(prepared.batchId, 'confirmed', failure.responseMetadata, claim),
      /stale batch response audit/);
  });

  test('one malformed streamed item rejects the whole response without a partial checkpoint', async () => {
    const shop = await addShop();
    const first = await addProduct(shop.id, 'ChatGPT Plus audit first'), second = await addProduct(shop.id, 'ChatGPT Plus audit second');
    const prepared = await createPreparedJob([first.id, second.id]);
    const body = JSON.stringify({ items: [
      { id: String(first.id), standardProductId: String(plusId), evidence: [{ path: 'name', quote: 'ChatGPT Plus' }] },
      { id: String(second.id), standardProductId: String(plusId), evidence: [] },
    ] });
    const call = createOpenAiModelCall(prepared.repository, { AI_BASE_URL: 'https://model.invalid/v1', AI_API_KEY: 'mock', AI_MODEL: 'mock' },
      async () => new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: body }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n'));
    await assert.rejects(call({ id: prepared.batchId }, new AbortController().signal), { retryClass: 'invalid_response' });
    assert.equal((await database.selectFrom('ai_job_batches').select('validated_decision').where('id', '=', prepared.batchId).executeTakeFirstOrThrow()).validated_decision, null);
    assert.deepEqual(await database.selectFrom('ai_standardization_results').select('product_id').where('job_id', '=', prepared.job.id).execute(), []);
    await prepared.repository.cancelJob(prepared.job.id);
  });

  test('multiple reviewed listings share one frozen existing standard without new identity mappings', async () => {
    const shop = await addShop();
    const first = await addProduct(shop.id, 'ChatGPT Plus monthly'), second = await addProduct(shop.id, 'OpenAI ChatGPT Plus one month');
    const prepared = await createPreparedJob([first.id, second.id]);
    const before = await database.selectFrom('standard_products').select('id').orderBy('id').execute();
    await saveAndPublish(prepared, { items: prepared.job.inputs.map(input => classified(input.productId)), missingIds: [] });
    const members = await database.selectFrom('standard_product_members').select('standard_product_id').where('product_id', 'in', [first.id, second.id]).execute();
    assert.equal(members.length, 2); assert.ok(members.every(row => row.standard_product_id === plusId));
    assert.deepEqual(await database.selectFrom('ai_batch_identity_mappings').select('identity_ref').where('batch_id', '=', prepared.batchId).execute(), []);
    assert.deepEqual(await database.selectFrom('standard_products').select('id').orderBy('id').execute(), before);
  });

  test('concurrent publications reuse one admitted ID without creating standards', async () => {
    const firstShop = await addShop(), secondShop = await addShop();
    const first = await addProduct(firstShop.id, 'ChatGPT Plus first concurrent listing');
    const second = await addProduct(secondShop.id, 'ChatGPT Plus second concurrent listing');
    const tasks = [await createPreparedJob([first.id]), await createPreparedJob([second.id])];
    for (const prepared of tasks) {
      await saveDecision(prepared, { items: [classified(prepared.job.inputs[0]!.productId)], missingIds: [] });
      await claim(prepared.batchId, 'publish', 2n, 'publish-claim');
    }
    const before = await database.selectFrom('standard_products').select('id').orderBy('id').execute();
    await Promise.all(tasks.map(task => task.repository.publishBatch(task.batchId, { workerId: 'integration', attempt: 2n, token: 'publish-claim' })));
    const results = await database.selectFrom('ai_standardization_results').select('standard_product_id').where('product_id', 'in', [first.id, second.id]).execute();
    assert.equal(results.length, 2); assert.ok(results.every(row => row.standard_product_id === plusId));
    assert.deepEqual(await database.selectFrom('standard_products').select('id').orderBy('id').execute(), before);
  });

  test('rejects an existing standard ID that was not frozen for that input', async () => {
    const shop = await addShop(); const source = await addProduct(shop.id, 'ChatGPT Plus unrelated candidate');
    const targetId = await seedStandard('ChatGPT Pro', 'openai', 'chatgpt', 'pro');
    const prepared = await createPreparedJob([source.id], false, [plusId]);
    await assert.rejects(prepared.repository.persistBatchDecision(prepared.job.id, prepared.batchId,
      { items: [classified(source.id, targetId)], missingIds: [] }, {}, { workerId: 'integration', attempt: 1n, token: 'request-claim' }),
      /候选|unfrozen candidate/i);
    assert.equal(await database.selectFrom('ai_publication_units').select('id').where('batch_id', '=', prepared.batchId).executeTakeFirst(), undefined);
    await prepared.repository.cancelJob(prepared.job.id);
  });

  test('another standard alias cannot redirect the exact frozen matched ID', async () => {
    const shop = await addShop(); const source = await addProduct(shop.id, 'ChatGPT Plus subscription');
    const teamId = await seedStandard('OpenAI consumer subscription', 'openai', 'chatgpt', 'team', ['ChatGPT Plus']);
    const prepared = await createPreparedJob([source.id], false, [plusId, teamId]);
    await saveAndPublish(prepared, { items: [classified(source.id)], missingIds: [] });
    assert.equal((await database.selectFrom('ai_standardization_results').select('standard_product_id').where('job_id', '=', prepared.job.id).executeTakeFirstOrThrow()).standard_product_id, plusId);
  });

  test('a frozen candidate quarantined after review remains publication-blocked', async () => {
    const shop = await addShop(); const source = await addProduct(shop.id, 'ChatGPT Pro 5x quarantined');
    const targetId = await seedStandard('ChatGPT Pro 5x', 'openai', 'chatgpt', 'pro_5x');
    const prepared = await createPreparedJob([source.id], false, [targetId]);
    await saveDecision(prepared, { items: [classified(source.id, targetId, 'ChatGPT Pro 5x')], missingIds: [] });
    await database.updateTable('standard_products').set({ verification_state: 'quarantined' }).where('id', '=', targetId).execute();
    await claim(prepared.batchId, 'publish', 2n, 'publish-claim');
    await prepared.repository.publishBatch(prepared.batchId, { workerId: 'integration', attempt: 2n, token: 'publish-claim' });
    assert.deepEqual(await database.selectFrom('ai_standardization_results').select(['status', 'reason_code', 'current_assignment_preserved']).where('job_id', '=', prepared.job.id).executeTakeFirstOrThrow(),
      { status: 'unclassified', reason_code: 'publication_blocked', current_assignment_preserved: true });
  });

  test('replay after commit confirmation loss is idempotent and bumps catalog version once', async () => {
    const shop = await addShop(); const source = await addProduct(shop.id, 'Claude Team annual');
    const targetId = await seedStandard('Claude Team', 'anthropic', 'claude', 'team');
    const prepared = await createPreparedJob([source.id], false, [targetId]);
    const before = (await database.selectFrom('catalog_cache_versions').select('version').where('id', '=', 1).executeTakeFirstOrThrow()).version;
    await saveAndPublish(prepared, { items: [classified(source.id, targetId, 'Claude Team annual')], missingIds: [] });
    const after = (await database.selectFrom('catalog_cache_versions').select('version').where('id', '=', 1).executeTakeFirstOrThrow()).version;
    await prepared.repository.publishBatch(prepared.batchId, { workerId: 'integration', attempt: 2n, token: 'publish-claim' });
    const replayed = (await database.selectFrom('catalog_cache_versions').select('version').where('id', '=', 1).executeTakeFirstOrThrow()).version;
    assert.equal(after, before + 1n); assert.equal(replayed, after);
    assert.equal((await database.selectFrom('ai_standardization_results').select('product_id').where('job_id', '=', prepared.job.id).execute()).length, 1);
  });

  test('source revision or shop invalidation prevents publication without losing a terminal result', async () => {
    for (const invalidate of ['revision', 'manual', 'shop'] as const) {
      const shop = await addShop();
      const source = await addProduct(shop.id, `ChatGPT Plus ${invalidate}`);
      const prepared = await createPreparedJob([source.id]);
      await saveDecision(prepared, {
        items: [classified(prepared.job.inputs[0]!.productId, plusId)], missingIds: [],
      });
      if (invalidate === 'revision') await database.updateTable('products').set({ content_version: 2n }).where('id', '=', source.id).execute();
      else if (invalidate === 'manual') await database.updateTable('products').set({ standardization_revision: sql`standardization_revision + 1` }).where('id', '=', source.id).execute();
      else await database.updateTable('shops').set({ enabled: false }).where('id', '=', shop.id).execute();
      await claim(prepared.batchId, 'publish', 2n, 'publish-claim');
      await prepared.repository.publishBatch(prepared.batchId, { workerId: 'integration', attempt: 2n, token: 'publish-claim' });
      const result = await database.selectFrom('ai_standardization_results').select(['status', 'reason_code']).where('job_id', '=', prepared.job.id).executeTakeFirstOrThrow();
      assert.deepEqual(result, { status: 'unclassified', reason_code: 'source_changed' });
      assert.equal(await database.selectFrom('standard_product_members').select('product_id').where('product_id', '=', source.id).executeTakeFirst(), undefined);
      await assert.rejects(prepared.repository.reapplySavedResults(prepared.job.id), error => error instanceof DomainConflictError && error.code === 'AI_REAPPLY_NOT_FOUND');
    }
  });

  test('publication uses stored source fingerprints despite processed evidence changes', async () => {
    for (const changed of [false, true]) {
      const shop = await addShop();
      const source = await addProduct(shop.id, `ChatGPT Plus source ${changed}`);
      const prepared = await createPreparedJob([source.id]);
      await database.updateTable('products').set({ spec: 'processed evidence',
        ...(changed ? { content_fingerprint: 'changed-source-hash' } : {}),
      }).where('id', '=', source.id).execute();
      await saveAndPublish(prepared, {
        items: [classified(prepared.job.inputs[0]!.productId, plusId)], missingIds: [],
      });
      const result = await database.selectFrom('ai_standardization_results').select(['status', 'reason_code']).where('job_id', '=', prepared.job.id).executeTakeFirstOrThrow();
      assert.deepEqual(result, changed ? { status: 'unclassified', reason_code: 'source_changed' } : { status: 'classified', reason_code: null });
    }
  });

  test('reapplies saved source-changed decisions without another request and preserves successful members', async () => {
    const shop = await addShop();
    const source = await addProduct(shop.id, 'ChatGPT Plus recover');
    const unchanged = await addProduct(shop.id, 'ChatGPT Plus keep published');
    const prepared = await createPreparedJob([source.id, unchanged.id]);
    await saveAndPublish(prepared, { items: prepared.job.inputs.map(input => classified(input.productId, plusId)), missingIds: [] });
    const preserved = await database.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', prepared.job.id).where('product_id', '=', unchanged.id).executeTakeFirstOrThrow();
    // Reproduce the persisted terminal state of the old empty-fingerprint bug.
    await database.deleteFrom('standard_product_members').where('product_id', '=', source.id).execute();
    await database.updateTable('ai_standardization_results').set({ status: 'unclassified', standard_product_id: null, reason_code: 'source_changed' }).where('job_id', '=', prepared.job.id).where('product_id', '=', source.id).execute();
    await database.updateTable('ai_job_input_members').set({ status: 'unclassified', reason_code: 'source_changed' }).where('job_id', '=', prepared.job.id).where('product_id', '=', source.id).execute();
    const before = await database.selectFrom('ai_job_batches').select(['request_budget_used', 'confirmed_requests']).where('id', '=', prepared.batchId).executeTakeFirstOrThrow();
    const page = await prepared.repository.listJobResults({ jobId: prepared.job.id, limit: 1 });
    assert.equal(page.items[0]?.productId, source.id.toString());
    assert.equal(page.items[0]?.reasonCode, 'source_changed');
    await prepared.repository.reapplySavedResults(prepared.job.id);
    await assert.rejects(prepared.repository.reapplySavedResults(prepared.job.id), error => error instanceof DomainConflictError && error.code === 'AI_JOB_STATE');
    await claim(prepared.batchId, 'publish', 3n, 'recovery-claim');
    const version = (await prepared.repository.getJobProgress(prepared.job.id))!.version;
    await prepared.repository.publishBatch(prepared.batchId, { workerId: 'integration', attempt: 3n, token: 'recovery-claim' });
    assert.equal((await prepared.repository.getJobProgress(prepared.job.id, BigInt(version)))?.status, 'succeeded');
    assert.deepEqual(await database.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', prepared.job.id).where('product_id', '=', unchanged.id).executeTakeFirstOrThrow(), preserved);
    assert.equal((await database.selectFrom('ai_standardization_results').select('status').where('job_id', '=', prepared.job.id).executeTakeFirstOrThrow()).status, 'classified');
    assert.deepEqual(await prepared.repository.listJobResults({ jobId: prepared.job.id, limit: 1 }), { items: [], nextCursor: null });
    assert.deepEqual(await database.selectFrom('ai_job_batches').select(['request_budget_used', 'confirmed_requests']).where('id', '=', prepared.batchId).executeTakeFirstOrThrow(), before);
    await assert.rejects(prepared.repository.reapplySavedResults(prepared.job.id), error => error instanceof DomainConflictError && error.code === 'AI_REAPPLY_NOT_FOUND');
  });

  test('partial publication reapply schedules only newly published products in each attribute child kind', async t => {
    const previousTags = process.env.AI_TAG_EXTRACTION_ENABLED;
    process.env.AI_TAG_EXTRACTION_ENABLED = 'true';
    t.after(() => {
      if (previousTags === undefined) delete process.env.AI_TAG_EXTRACTION_ENABLED;
      else process.env.AI_TAG_EXTRACTION_ENABLED = previousTags;
    });
    const firstShop = await addShop(), secondShop = await addShop();
    const first = await addProduct(firstShop.id, 'ChatGPT Plus first');
    const second = await addProduct(secondShop.id, 'ChatGPT Plus recovered');
    const prepared = await createPreparedJob([first.id, second.id]);
    await saveDecision(prepared, { items: prepared.job.inputs.map(input => classified(input.productId, plusId)), missingIds: [] });
    // Make only B unavailable after review, then restore its unchanged evidence for real reapplication.
    await database.updateTable('shops').set({ enabled: false }).where('id', '=', secondShop.id).execute();
    await claim(prepared.batchId, 'publish', 2n, 'partial-publish');
    await prepared.repository.publishBatch(prepared.batchId, { workerId: 'integration', attempt: 2n, token: 'partial-publish' });
    const results = () => database.selectFrom('ai_standardization_results').select(['product_id', 'status', 'reason_code'])
      .where('job_id', '=', prepared.job.id).orderBy('product_id').execute();
    assert.deepEqual(await results(), [
      { product_id: first.id, status: 'classified', reason_code: null },
      { product_id: second.id, status: 'unclassified', reason_code: 'source_changed' },
    ]);
    const children = () => database.selectFrom('ai_jobs').select(['id', 'job_type', 'status', 'retry_of_job_id'])
      .where('parent_identity_job_id', '=', prepared.job.id).orderBy('id').execute();
    const members = (jobId: bigint) => database.selectFrom('ai_job_input_members').select('product_id')
      .where('job_id', '=', jobId).orderBy('product_id').execute();
    const initial = await children();
    assert.deepEqual(initial.map(child => child.job_type).sort(), ['membership_features', 'tag_extraction']);
    for (const child of initial) {
      assert.deepEqual(await members(child.id), [{ product_id: first.id }]);
      await prepared.repository.cancelJob(child.id);
    }
    const cancelled = await children();
    assert.ok(cancelled.every(child => child.status === 'cancelled'));
    const requestCounts = () => database.selectFrom('ai_job_batches').select(['id', 'request_budget_used', 'confirmed_requests'])
      .where('job_id', '=', prepared.job.id).orderBy('id').execute();
    const requestsBefore = await requestCounts();
    await database.updateTable('shops').set({ enabled: true }).where('id', '=', secondShop.id).execute();
    await prepared.repository.reapplySavedResults(prepared.job.id);
    await claim(prepared.batchId, 'publish', 3n, 'partial-recovery');
    await prepared.repository.publishBatch(prepared.batchId, { workerId: 'integration', attempt: 3n, token: 'partial-recovery' });
    assert.deepEqual(await results(), [
      { product_id: first.id, status: 'classified', reason_code: null },
      { product_id: second.id, status: 'classified', reason_code: null },
    ]);
    const recovered = await children();
    assert.equal(recovered.length, 4, 'B needs one new feature child and one new tag child despite existing A children');
    assert.deepEqual(recovered.filter(child => initial.some(old => old.id === child.id)), cancelled);
    const additional = recovered.filter(child => !initial.some(old => old.id === child.id));
    assert.deepEqual(additional.map(child => child.job_type).sort(), ['membership_features', 'tag_extraction']);
    for (const child of additional) {
      assert.equal(child.retry_of_job_id, null);
      assert.deepEqual(await members(child.id), [{ product_id: second.id }], 'the new child must not rerun A');
    }
    await Promise.all([
      database.transaction().execute(tx => finalizeOrScheduleMissing(tx, prepared.job.id)),
      database.transaction().execute(tx => finalizeOrScheduleMissing(tx, prepared.job.id)),
    ]);
    await prepared.repository.publishBatch(prepared.batchId, { workerId: 'integration', attempt: 3n, token: 'partial-recovery' });
    await assert.rejects(prepared.repository.reapplySavedResults(prepared.job.id),
      error => error instanceof DomainConflictError && error.code === 'AI_REAPPLY_NOT_FOUND');
    assert.deepEqual(await children(), recovered);
    assert.deepEqual(await requestCounts(), requestsBefore, 'reapplication must not make another model request');
    for (const child of initial) assert.deepEqual(await members(child.id), [{ product_id: first.id }]);
    for (const child of additional) assert.deepEqual(await members(child.id), [{ product_id: second.id }]);
  });

  test('missing item is a technical failure and concurrent finalizers do not create missing-id rounds', async () => {
    const shop = await addShop(); const source = await addProduct(shop.id, 'ChatGPT Plus missing response');
    const prepared = await createPreparedJob([source.id]);
    assert.throws(() => parseStandardizationProtocolResponse({ items: [] },
      [{ id: String(source.id), candidateStandardProductIds: [String(plusId)] }]), { reasonCode: 'invalid_response' });
    await assert.rejects(prepared.repository.persistBatchDecision(prepared.job.id, prepared.batchId,
      { items: [], missingIds: [String(source.id)] }, {}, { workerId: 'integration', attempt: 1n, token: 'request-claim' }));
    assert.equal((await database.selectFrom('ai_job_batches').select('validated_decision')
      .where('id', '=', prepared.batchId).executeTakeFirstOrThrow()).validated_decision, null);
    await new JobsRepository(database).fail('ai_batch', prepared.batchId, 'integration', 'missing input item', { retry: false, retryClass: 'invalid_response' });
    await Promise.all([database.transaction().execute(tx => finalizeOrScheduleMissing(tx, prepared.job.id)),
      database.transaction().execute(tx => finalizeOrScheduleMissing(tx, prepared.job.id))]);
    assert.deepEqual(await database.selectFrom('ai_job_batches').select('round').where('job_id', '=', prepared.job.id).execute(), [{ round: 0 }]);
    assert.deepEqual(await database.selectFrom('ai_job_input_members').select(['missing_reprocess_count', 'reason_code']).where('job_id', '=', prepared.job.id).execute(),
      [{ missing_reprocess_count: 0, reason_code: 'invalid_response' }]);
  });

  test('unclassified result pages use numeric cursors without dropping or repeating products', async () => {
    const shop = await addShop();
    const first = await addProduct(shop.id, 'Unknown listing first');
    const second = await addProduct(shop.id, 'Unknown listing second');
    const prepared = await createPreparedJob([first.id, second.id]);
    await saveAndPublish(prepared, {
      missingIds: [],
      items: prepared.job.inputs.map(input => ({ id: input.productId.toString(), status: 'unclassified', ruleIds: [], evidence: [{ path: 'name', quote: input.productId === first.id ? 'Unknown listing first' : 'Unknown listing second' }], reasonCode: 'unmatched', reason: '未匹配到已准入标准商品' })),
    });
    const page = await prepared.repository.listJobResults({ jobId: prepared.job.id, limit: 1 });
    assert.deepEqual(page.items.map(item => item.productId), [first.id.toString()]);
    assert.equal(page.nextCursor, first.id.toString());
    const next = await prepared.repository.listJobResults({ jobId: prepared.job.id, limit: 1, cursor: page.nextCursor! });
    assert.deepEqual(next.items.map(item => item.productId), [second.id.toString()]);
    assert.equal(next.nextCursor, null);
    await assert.rejects(prepared.repository.listJobResults({ jobId: prepared.job.id, limit: 1, cursor: 'not-an-id' }), error => error instanceof DomainConflictError && error.code === 'INVALID_CURSOR');
  });
  test('streaming mock publishes Team JSON, RT and registered mailboxes through the full guarded path', async () => {
    const shop = await addShop();
    for (const [name, body, tier] of [
      ['Team 5X成品JSON', '已开通Team 5X账号，成品JSON交付，仅支持Sub2API。', 'team_5x'],
      ['G Team 子号Token', '实时验活的ChatGPT Team子号，含RT，CPA JSON和sub2api导入JSON。', 'team'],
      ['Team 5X Gmail邮箱', '本商品为Team 5X成品账号，Gmail注册，账密2FA，能反代也能网页。', 'team_5x'],
    ] as const) {
      const source = await addProduct(shop.id, name, '', { evidence: body });
      const target = await database.selectFrom('standard_products').select('id').where('canonical_family', '=', 'openai').where('canonical_product', '=', 'chatgpt').where('canonical_tier', '=', tier).executeTakeFirst()
        ?? { id: await seedStandard('ChatGPT ' + tier, 'openai', 'chatgpt', tier) };
      const prepared = await createPreparedJob([source.id], true, [target.id]);
      const evidence = [{ path: 'name', quote: name }];
      const response = JSON.stringify({ items: [{ id: String(source.id), standardProductId: String(target.id), evidence }] });
      const call = createOpenAiModelCall(prepared.repository, { AI_BASE_URL: 'https://mock.invalid/v1', AI_API_KEY: 'mock-only', AI_MODEL: 'mock' },
        async (_url, init) => {
          assert.equal(JSON.parse(String(init?.body)).stream, true);
          return new Response([{ choices: [{ delta: { content: response.slice(0, 31) } }] },
            { choices: [{ delta: { content: response.slice(31) }, finish_reason: 'stop' }] }]
            .map(chunk => 'data: ' + JSON.stringify(chunk) + '\n\n').join('') + 'data: [DONE]\n\n');
        });
      const { metadata, standardizationStage, items, missingIds } = await call({ id: prepared.batchId } as never, new AbortController().signal);
      assert.equal(standardizationStage, 'generate');
      assert.equal(items[0]?.status, 'classified');
      await saveAndPublish(prepared, { items, missingIds }, undefined, metadata);
      const member = await database.selectFrom('standard_product_members').selectAll().where('product_id', '=', source.id).executeTakeFirstOrThrow();
      assert.equal(member.publication_state, 'published');
      const standard = await database.selectFrom('standard_products').select(['canonical_tier', 'service_evidence']).where('id', '=', member.standard_product_id).executeTakeFirstOrThrow();
      assert.equal(standard.canonical_tier, tier); assert.deepEqual(standard.service_evidence, {});
      const tagJob = await database.selectFrom('ai_jobs').select('id').where('parent_identity_job_id', '=', prepared.job.id)
        .where('job_type', '=', 'tag_extraction').executeTakeFirstOrThrow();
      const tagBatch = await database.selectFrom('ai_job_batches').select('id').where('job_id', '=', tagJob.id).executeTakeFirstOrThrow();
      await claim(tagBatch.id, 'request', 1n, 'membership-tags');
      await prepared.repository.prepareBatch(tagBatch.id);
      assert.equal(await prepared.repository.reserveBatchRequest(tagBatch.id), 'reserved');
      const tagInput = (await prepared.repository.getTagExtractionBatchInputs(tagBatch.id)).inputs[0]!;
      const reviewedTags = validateReviewedTagExtractionDecision(source.id, [], [], tagInput.payload, [], true);
      if ((tagInput.payload as { warrantyEligible?: boolean }).warrantyEligible) reviewedTags.warrantyLabels = {
        subscription_warranty: null, subscription_warranty_t: null, usage_warranty: null, usage_warranty_t: null,
      };
      await prepared.repository.persistTagExtractionBatchDecision(tagJob.id, tagBatch.id,
        [reviewedTags], {},
        { workerId: 'integration', attempt: 1n, token: 'membership-tags' });
      const published = await database.selectFrom('standard_product_members as m').innerJoin('standard_products as s', 's.id', 'm.standard_product_id')
        .select(['m.publication_state', 's.id']).where('m.product_id', '=', source.id).executeTakeFirstOrThrow();
      assert.deepEqual(published, { publication_state: 'published', id: member.standard_product_id });
    }
  });

  test('late tag extraction cannot overwrite changed evidence or a new manual review', async () => {
    for (const drift of ['evidence', 'fingerprint', 'manual', 'unchanged', 'failed'] as const) {
      const shop = await addShop(); const source = await addProduct(shop.id, `ChatGPT Plus 成品账号 ${drift}`);
      await database.insertInto('product_tags').values(tagRows({ product_id: source.id, name: 'usage_restriction', value: '人工保留限制' })).execute();
      const prepared = await createPreparedJob([source.id], true);
      await saveAndPublish(prepared, { items: [classified(source.id, plusId)], missingIds: [] });
      assert.deepEqual(await database.selectFrom('product_tags').select(['name', 'value']).where('product_id', '=', source.id).execute(),
        [{ name: 'usage_restriction', value: '人工保留限制' }]);
      const result = await database.selectFrom('ai_standardization_results').select('decision').where('job_id', '=', prepared.job.id).executeTakeFirstOrThrow();
      assert.equal(Object.hasOwn(result.decision as object, 'tags'), false);
      const tagJob = await database.selectFrom('ai_jobs').selectAll().where('job_type', '=', 'tag_extraction').orderBy('id', 'desc').executeTakeFirstOrThrow();
      const batch = await database.selectFrom('ai_job_batches').selectAll().where('job_id', '=', tagJob.id).executeTakeFirstOrThrow();
      await claim(batch.id, 'request', 1n, 'tag-claim');
      const frozen = await prepared.repository.getTagExtractionBatchInputs(batch.id);
      assert.equal(frozen.inputs[0]?.name, `ChatGPT Plus 成品账号 ${drift}`);
      const reviewedTags = validateReviewedTagExtractionDecision(source.id,
        [{ name: 'duration', value: 30, proposalIndex: 0, evidence: [{ path: 'spec', quote: 'monthly' }] }],
        [], frozen.inputs[0]!.payload, [true], true);
      if ((frozen.inputs[0]!.payload as { warrantyEligible?: boolean }).warrantyEligible) reviewedTags.warrantyLabels = {
        subscription_warranty: null, subscription_warranty_t: null, usage_warranty: null, usage_warranty_t: null,
      };
      if (drift === 'manual') await database.transaction().execute(tx => recordManualDecisions(tx, [source.id], { action: 'quarantine', standardProductId: null, reason: '新人工审核' }));
      else if (drift === 'evidence') await database.updateTable('products').set({ content_version: 2n, standardization_revision: 9n }).where('id', '=', source.id).execute();
      else if (drift === 'fingerprint') {
        const name = '更新后的Team资料';
        const changed = await database.updateTable('products').set({ name, source_name: name,
          content_fingerprint: productContentFingerprint({ name, spec: 'monthly' }),
        }).where('id', '=', source.id).returning(['content_version', 'content_fingerprint']).executeTakeFirstOrThrow();
        assert.equal(changed.content_version, source.content_version, 'fingerprint drift is guarded even without a version change');
        assert.notEqual(changed.content_fingerprint, source.content_fingerprint);
        assert.equal((await prepared.repository.getTagExtractionBatchInputs(batch.id)).inputs[0]?.name, frozen.inputs[0]?.name);
      }
      if (drift === 'failed') {
        await database.updateTable('ai_job_batches').set({ status: 'failed', error_source: 'invalid_response', error: 'bad tag response' }).where('id', '=', batch.id).execute();
        await database.transaction().execute(tx => finalizeOrScheduleMissing(tx, tagJob.id));
        assert.equal((await database.selectFrom('ai_jobs').select('status').where('id', '=', tagJob.id).executeTakeFirstOrThrow()).status, 'ready_with_errors');
        assert.equal((await database.selectFrom('ai_standardization_results').select('product_id').where('job_id', '=', tagJob.id).execute()).length, 0, 'tag failures do not overwrite identity results');
      } else {
        if (drift === 'unchanged') {
          await database.updateTable('ai_jobs').set({ pipeline_versions: jsonb({ ...(tagJob.pipeline_versions as Record<string, string>), tagPrompt: 'stale-tag-prompt' }) }).where('id', '=', tagJob.id).execute();
          await assert.rejects(prepared.repository.getTagExtractionBatchInputs(batch.id), error => error instanceof DomainConflictError && error.code === 'AI_POLICY_STALE');
          await assert.rejects(prepared.repository.persistTagExtractionBatchDecision(tagJob.id, batch.id,
            [{ productId: source.id, tags: [{ name: 'duration', value: 30, evidence: [{ path: 'spec', quote: 'monthly' }] }], rejectedTags: [] }]), error => error instanceof DomainConflictError && error.code === 'AI_POLICY_STALE');
          await database.updateTable('ai_jobs').set({ pipeline_versions: jsonb(tagJob.pipeline_versions!) }).where('id', '=', tagJob.id).execute();
          await assert.rejects(prepared.repository.persistTagExtractionBatchDecision(tagJob.id, batch.id,
            [{ productId: source.id + 1000000n, tags: [{ name: 'duration', value: 30, evidence: [{ path: 'spec', quote: 'monthly' }] }], rejectedTags: [] }], {}, { workerId: 'integration', attempt: 1n, token: 'tag-claim' }), /does not match/);
        }
        await prepared.repository.persistTagExtractionBatchDecision(tagJob.id, batch.id, [reviewedTags], {}, { workerId: 'integration', attempt: 1n, token: 'tag-claim' });
      }
      assert.deepEqual((await database.selectFrom('product_tags').select(['name', 'value']).where('product_id', '=', source.id).orderBy('name').execute()),
        drift === 'unchanged' ? [{ name: 'duration', value: 30 }] : [{ name: 'usage_restriction', value: '人工保留限制' }]);
    }
  });


});
