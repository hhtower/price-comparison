import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { migrateToLatest } from '../scripts/migrate.js';
import { AiRepository } from '../src/ai/ai.repository.js';
import { JobsRepository } from '../src/jobs/jobs.repository.js';
import { parseStandardizationProtocolResponse } from '../src/ai/ai.schemas.js';
import type { ParsedStandardizationResponse, StandardizationDecision, StandardizationIdentity } from '../src/ai/ai.schemas.js';
import type { DatabaseSchema } from '../src/database/types.js';
import { jsonb } from '../src/database/types.js';
import { buildCanonicalStandardKey } from '../src/standardization/canonical-key.js';
import { productContentFingerprint } from '../src/standardization/fingerprint.js';
import { finalizeOrScheduleMissing } from '../src/ai/standardization-finalizer.js';
import { DomainConflictError } from '../src/common/errors.js';
import { recordCandidateCatalogChanges } from '../src/catalog/catalog-version.repository.js';
import { IDENTITY_POLICY_VERSION } from '../src/standardization/identity-policy.js';
import { recordManualDecisions } from '../src/standardization/decision-history.js';
import { StandardizationRepository } from '../src/standardization/standardization.repository.js';
import { createOpenAiModelCall } from '../src/ai/ai.worker.js';
import { saveStandardizationThroughReview } from './standardization-review-fixture.js';

describe('AI identity standardization publication', () => {
  let database: Kysely<DatabaseSchema>;
  let pool: Pool;
  let admin: Pool;
  let schema = '';
  let sequence = 0;

  before(async () => {
    if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required for AI integration tests');
    schema = `ai_regroup_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
    admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`create schema "${schema}"`);
    process.env.PG_SCHEMA = schema;
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path="${schema}",public`, max: 12 });
    database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    await migrateToLatest(database);
  });

  after(async () => {
    await database?.destroy();
    if (admin && schema) await admin.query(`drop schema if exists "${schema}" cascade`);
    await admin?.end();
    delete process.env.PG_SCHEMA;
  });

  async function addShop(enabled = true) {
    sequence += 1;
    return database.insertInto('shops').values({
      platform: 'integration', url: `https://shop.invalid/${sequence}`, name: `shop-${sequence}`, enabled,
      deleted_at: null, last_fetch_at: null, last_error: null,
    }).returning('id').executeTakeFirstOrThrow();
  }

  async function addProduct(shopId: bigint, name: string, spec = 'monthly', sourceData: Record<string, unknown> = { title: name, selected: spec }) {
    sequence += 1;
    const fingerprint = productContentFingerprint({ name, spec, sourceCategory: '', sourceData });
    return database.insertInto('products').values({
      shop_id: shopId, external_id: `p-${sequence}`, name, spec, source_category: '', source_data: jsonb(sourceData),
      normalized_key: `product-${sequence}`, url: `https://product.invalid/${sequence}`, deleted_at: null,
      content_version: 1n, content_fingerprint: fingerprint, standardization_locked: false,
    }).returning(['id', 'content_version', 'content_fingerprint']).executeTakeFirstOrThrow();
  }

  function identity(ref: string, family = 'openai', product = 'chatgpt', tier = 'plus', quote = 'ChatGPT Plus'): StandardizationIdentity {
    const fields = { family, product, tier };
    return { ref, ...fields, canonicalKey: buildCanonicalStandardKey(fields), reason: 'integration evidence', evidence: [{ path: 'name', quote }] };
  }

  function classified(id: bigint, ref: string, quote = 'ChatGPT Plus'): StandardizationDecision {
    return {
      id: id.toString(), status: 'classified', identity: { kind: 'new', ref, canonicalKey: identity(ref).canonicalKey },
      ruleIds: ['integration'], evidence: [{ path: 'name', quote }], reasonCode: null, reason: 'classified',
    };
  }

  async function createPreparedJob(productIds: bigint[]) {
    const repository = new AiRepository(database);
    const job = await repository.createJob({ model: `integration-${++sequence}`, productIds, batchSize: 32 });
    assert.equal(job.batches.length, 1);
    const batchId = job.batches[0]!.id;
    await claim(batchId, 'request', 1n, 'request-claim');
    await repository.prepareBatch(batchId);
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
  ) {
    await saveDecision(prepared, decision, approve);
    await claim(prepared.batchId, 'publish', 2n, 'publish-claim');
    await prepared.repository.publishBatch(prepared.batchId, { workerId: 'integration', attempt: 2n, token: 'publish-claim' });
  }

  test('streamed fenced JSON is validated and reviewed before local publication', async () => {
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
      const content = `\`\`\`json\n${JSON.stringify({ items: [{
        id: input.id, action: 'create_identity',
        identity: { family: 'openai', product: 'chatgpt', tier: 'plus', evidence, reason: 'Explicit offer' },
        evidence, ruleIds: [], reason: 'Explicit offer',
      }] })}\n\`\`\``;
      const fragments = [content.slice(0, 4), content.slice(4, -2), content.slice(-2)];
      return new Response(fragments.map((part, index) =>
        `data: ${JSON.stringify({ choices: [{ delta: { content: part }, ...(index === fragments.length - 1 ? { finish_reason: 'stop' } : {}) }] })}\n\n`,
      ).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    });
    const decision = await call({ id: prepared.batchId }, new AbortController().signal);
    await saveAndPublish(prepared, decision);
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

  test('different service descriptions in independent batches reuse one provider identity', async () => {
    const shop = await addShop();
    for (const [family, canonicalProduct, aliases, names] of [
      ['openai', 'codex_sms', ['openai_sms', 'chatgpt_sms'], ['OpenAI 手机接码服务', 'ChatGPT 手机接码服务']],
      ['anthropic', 'claude_sms', ['anthropic_sms', 'claude_code_sms'], ['Anthropic 手机接码服务', 'Claude Code 手机接码服务']],
      ['google', 'google_sms', ['google_sms', 'gemini_sms'], ['Google 手机接码服务', 'Gemini 手机接码服务']],
    ] as const) {
      const assigned: bigint[] = [];
      for (const [index, alias] of aliases.entries()) {
        const product = await addProduct(shop.id, names[index]!);
        const prepared = await createPreparedJob([product.id]);
        const evidence = [{ path: 'name', quote: names[index]! }];
        const parsed = parseStandardizationProtocolResponse({ items: [{ id: String(product.id), action: 'create_identity',
          identity: { family, product: alias, tier: 'standard', reason: 'Explicit SMS service', evidence },
          ruleIds: [], evidence, reason: 'Explicit SMS service' }],
        }, [{ id: String(product.id), candidateStandardProductIds: [], candidateRefs: {} }]);
        await saveAndPublish(prepared, parsed);
        assigned.push((await database.selectFrom('standard_product_members').select('standard_product_id').where('product_id', '=', product.id).executeTakeFirstOrThrow()).standard_product_id);
      }
      assert.equal(assigned[0], assigned[1]);
      const standards = await database.selectFrom('standard_products').select(['id', 'name', 'canonical_product']).where('canonical_family', '=', family).where('canonical_product', 'in', [canonicalProduct, ...aliases]).where('merged_into_id', 'is', null).execute();
      assert.equal(standards.length, 1);
      assert.equal(standards[0]?.canonical_product, canonicalProduct);
      assert.equal(standards[0]?.name, ({ openai: 'Codex', anthropic: 'Claude', google: 'Google' })[family] + ' 手机接码');
    }
  });

  test('binary review rejects non-SMS sale evidence for new and existing SMS identities', async () => {
    const shop = await addShop();
    for (const mode of ['new', 'existing'] as const) {
      const name = `域名邮箱 接马 (二次码|OpenAI业务|${mode})`;
      const product = await addProduct(shop.id, name);
      const prepared = await createPreparedJob([product.id]);
      const proposed = identity('bad-sms', 'openai', 'codex_sms', 'standard', name);
      const standard = await database.selectFrom('standard_products').select('id').where('standard_key', '=', proposed.canonicalKey).executeTakeFirstOrThrow();
      if (mode === 'existing') {
        const snapshot = await database.selectFrom('ai_job_batches').select('reference_snapshot').where('id', '=', prepared.batchId).executeTakeFirstOrThrow();
        const reference = snapshot.reference_snapshot as any;
        reference.inputs[0].candidateStandardProductIds = [String(standard.id)];
        reference.candidates = [{ id: String(standard.id), family: 'openai', product: 'codex_sms', tier: 'standard', aliases: [] }];
        await database.updateTable('ai_job_batches').set({ reference_snapshot: jsonb(reference) }).where('id', '=', prepared.batchId).execute();
      }
      await saveAndPublish(prepared, { identities: mode === 'new' ? [proposed] : [], items: [{ ...classified(product.id, proposed.ref, name),
        identity: mode === 'new' ? { kind: 'new', ref: proposed.ref, canonicalKey: proposed.canonicalKey } : { kind: 'existing', standardProductId: String(standard.id) },
      }], missingIds: [] }, () => false);
      assert.equal((await database.selectFrom('standard_product_members').select('product_id').where('product_id', '=', product.id).execute()).length, 0);
      const result = await database.selectFrom('ai_standardization_results').select(['status', 'reason_code']).where('job_id', '=', prepared.job.id).executeTakeFirstOrThrow();
      assert.deepEqual(result, { status: 'unclassified', reason_code: 'review_rejected' });
    }
  });

  test('saved publication cannot bypass an identity policy upgrade', async () => {
    const shop = await addShop();
    const product = await addProduct(shop.id, 'Codex 手机接码服务 old policy');
    const prepared = await createPreparedJob([product.id]);
    const proposed = identity('old-sms', 'openai', 'codex_sms', 'standard', 'Codex 手机接码服务 old policy');
    await saveDecision(prepared, { identities: [proposed], items: [{
      ...classified(product.id, proposed.ref, 'Codex 手机接码服务 old policy'), identity: { kind: 'new', ref: proposed.ref, canonicalKey: proposed.canonicalKey },
    }], missingIds: [] });
    await database.updateTable('ai_jobs').set({ rule_version: 'catalog-identity-20260925-v3' }).where('id', '=', prepared.job.id).execute();
    await claim(prepared.batchId, 'publish', 2n, 'publish-claim');
    await assert.rejects(prepared.repository.publishBatch(prepared.batchId, { workerId: 'integration', attempt: 2n, token: 'publish-claim' }),
      error => error instanceof DomainConflictError && error.code === 'AI_POLICY_STALE');
    assert.equal((await database.selectFrom('standard_product_members').select('product_id').where('product_id', '=', product.id).execute()).length, 0);
    await prepared.repository.cancelJob(prepared.job.id);
  });

  test('publication preserves the reviewed identity despite a larger same-name group', async () => {
    const shop = await addShop();
    const title = '微软邮箱长效 Outlook Hotmail OAuth2 双令牌';
    const majority = await database.insertInto('standard_products').values({
      name: 'microsoft / outlook / standard', canonical_family: 'microsoft', canonical_product: 'outlook',
      canonical_tier: 'standard', verification_state: 'verified',
    }).returning('id').executeTakeFirstOrThrow();
    const minority = await database.insertInto('standard_products').values({
      name: 'email / outlook_account / standard', canonical_family: 'email', canonical_product: 'outlook_account',
      canonical_tier: 'standard', verification_state: 'verified',
    }).returning('id').executeTakeFirstOrThrow();
    for (const standardId of [majority.id, majority.id, majority.id, minority.id]) {
      const peer = await addProduct(shop.id, title);
      await database.insertInto('standard_product_members').values({ product_id: peer.id, standard_product_id: standardId, assignment_source: 'ai' }).execute();
    }
    const source = await addProduct(shop.id, title);
    const prepared = await createPreparedJob([source.id]);
    const proposed = identity('outlook-alternative', 'email', 'receive_credits', 'standard', title);
    await saveAndPublish(prepared, { identities: [proposed], items: [{ ...classified(source.id, proposed.ref, title),
      identity: { kind: 'new', ref: proposed.ref, canonicalKey: proposed.canonicalKey },
    }], missingIds: [] });
    const membership = await database.selectFrom('standard_product_members').selectAll().where('product_id', '=', source.id).executeTakeFirstOrThrow();
    assert.notEqual(membership.standard_product_id, majority.id);
    const result = await database.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', prepared.job.id).executeTakeFirstOrThrow();
    assert.equal(result.standard_product_id, membership.standard_product_id);
    assert.equal((result.decision as unknown as StandardizationDecision).review?.approved, true);
    assert.ok(!(result.decision as unknown as StandardizationDecision).ruleIds.includes('same_name_majority'));
    const proposedRows = await database.selectFrom('standard_products').select('id').where('standard_key', '=', proposed.canonicalKey).execute();
    assert.deepEqual(proposedRows, [{ id: membership.standard_product_id }]);
  });

  test('high-confidence relays are excluded locally while weak signals enter the model queue', async () => {
    const shop = await addShop();
    const relay = await addProduct(shop.id, 'Codex API 中转充值 100刀');
    const account = await addProduct(shop.id, 'ChatGPT Plus 账号');
    const ambiguous = await addProduct(shop.id, '100元余额卡', '', {
      category: '模型 API 中转', apiEndpoint: 'https://relay.invalid/v1',
    });
    const accountWithPolicyWarning = await addProduct(shop.id, '【正规实付】Super gro12个月年卡 全程质保订阅', '', {
      evidence: '<p>Super Grok 12个月年卡全程质保订阅，使用买家自己的X账号开通。</p><p>账号封禁无售后：官方风控导致的账号封禁，99% 是由于违规使用（例如批量注册的号、暴力、</p><p>API中转、频繁切换节点或者发送敏感问题等等以及违法违规情况），因此封号不在质保范围。</p>',
    });
    const repository = new AiRepository(database);
    const excluded = await repository.createJob({ model: 'mock', productIds: [relay.id] });
    assert.equal(excluded.processed, 1n);
    assert.equal(excluded.status, 'succeeded');
    assert.deepEqual(excluded.batches, []);
    assert.equal((await database.selectFrom('ai_standardization_results').select('reason_code')
      .where('job_id', '=', excluded.id).executeTakeFirstOrThrow()).reason_code, 'not_sellable');
    assert.equal((await database.selectFrom('ai_job_inputs').select('status')
      .where('job_id', '=', excluded.id).executeTakeFirstOrThrow()).status, 'succeeded');
    assert.equal((await database.selectFrom('ai_standardization_executions').select('status')
      .where('job_id', '=', excluded.id).executeTakeFirstOrThrow()).status, 'completed');
    const queued = await repository.createJob({ model: 'mock', productIds: [account.id, ambiguous.id, accountWithPolicyWarning.id] });
    assert.equal(queued.total, 3n);
    assert.equal(queued.processed, 1n);
    assert.equal(queued.unclassified, 1n);
    assert.equal(queued.status, 'queued');
    assert.equal(queued.inputs.length, 3);
    assert.equal(queued.batches.length, 2, 'independent sale objects use separate requests');
    assert.deepEqual(queued.batches.flatMap(batch => batch.productIds), [account.id, accountWithPolicyWarning.id]);
    const queuedMembers = await database.selectFrom('ai_job_input_members').select(['product_id', 'status'])
      .where('job_id', '=', queued.id).execute();
    assert.deepEqual(queuedMembers.map(row => [row.product_id, row.status]), [
      [account.id, 'queued'], [ambiguous.id, 'unclassified'], [accountWithPolicyWarning.id, 'queued'],
    ]);
    const eligible = await repository.createJob({ model: 'mock', productIds: [accountWithPolicyWarning.id] });
    assert.equal(eligible.total, 1n);
    assert.equal(eligible.processed, 0n);
    assert.equal(eligible.unclassified, 0n);
    assert.equal(eligible.inputs.length, 1);
    assert.equal(eligible.batches.length, 1);
    const progress = await repository.getJobProgress(queued.id);
    assert.equal(progress?.processed, '1');
    assert.equal(progress?.results.unclassified, 1);
    assert.equal(progress?.requests.totalBatches, 2);
    const reviewed = await addProduct(shop.id, '已审核排除的模糊额度卡');
    await database.transaction().execute(tx => recordManualDecisions(tx, [reviewed.id], { action: 'exclude', standardProductId: null, reason: '审核确认中转余额' }));
    assert.equal((await repository.createJob({ model: 'mock', productIds: [reviewed.id] })).total, 0n);
    const mixed = await repository.createJob({ model: 'mock', productIds: [relay.id, account.id] });
    assert.equal(mixed.total, 2n);
    assert.deepEqual(mixed.inputs.map(input => input.productId), [relay.id, account.id]);
    assert.deepEqual(mixed.batches.flatMap(batch => batch.productIds), [account.id]);
    assert.equal((await database.selectFrom('ai_standardization_results').select('product_id')
      .where('job_id', '=', mixed.id).executeTakeFirstOrThrow()).product_id, relay.id);
    await repository.cancelJob(queued.id);
    await repository.cancelJob(mixed.id);
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

  test('local relay exclusion does not override locked, reviewed or already published products', async () => {
    const shop = await addShop();
    const locked = await addProduct(shop.id, 'Codex API 中转充值 100刀');
    const reviewed = await addProduct(shop.id, 'Codex API 中转充值 200刀');
    const published = await addProduct(shop.id, 'Codex API 中转充值 300刀');
    await database.updateTable('products').set({ standardization_locked: true }).where('id', '=', locked.id).execute();
    await database.transaction().execute(tx => recordManualDecisions(tx, [reviewed.id], {
      action: 'quarantine', standardProductId: null, reason: 'Preserve human review',
    }));
    const standard = await database.insertInto('standard_products').values({
      name: 'Reviewed product', canonical_family: 'fixture', canonical_product: 'approved', canonical_tier: 'standard',
      verification_state: 'verified',
    }).returning('id').executeTakeFirstOrThrow();
    await database.insertInto('standard_product_members').values({
      product_id: published.id, standard_product_id: standard.id, publication_state: 'published', assignment_source: 'human',
    }).execute();
    const job = await new AiRepository(database).createJob({ model: 'mock', productIds: [locked.id, reviewed.id, published.id] });
    assert.equal(job.total, 0n);
    assert.equal((await database.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', job.id).execute()).length, 0);
    assert.equal((await database.selectFrom('standard_product_members').select('standard_product_id')
      .where('product_id', '=', published.id).executeTakeFirstOrThrow()).standard_product_id, standard.id);
  });

  test('incremental high-confidence relay exclusion records its result atomically with outbox consumption', async () => {
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
          const result = await tx!.selectFrom('ai_standardization_results').select('reason_code').where('job_id', '=', job.id).executeTakeFirstOrThrow();
          assert.equal(result.reason_code, 'not_sellable');
          throw new Error('after local exclusion before outbox acknowledgement');
        },
      } as unknown as AiRepository;
      await assert.rejects(new StandardizationRepository(database, throwing).createIncrementalJob({
        outbox: [outbox], workerId: 'exclusion-test', priority: 50,
      }), /after local exclusion/);
      assert.equal((await database.selectFrom('standardization_outbox').select('status').where('id', '=', outbox.id).executeTakeFirstOrThrow()).status, 'running');
      assert.equal((await database.selectFrom('ai_standardization_results').select('job_id').where('product_id', '=', relay.id).execute()).length, 0);
      const created = await new StandardizationRepository(database, real).createIncrementalJob({
        outbox: [outbox], workerId: 'exclusion-test', priority: 50,
      });
      assert.ok(created);
      assert.equal((await database.selectFrom('standardization_outbox').select('status').where('id', '=', outbox.id).executeTakeFirstOrThrow()).status, 'succeeded');
      assert.equal((await database.selectFrom('ai_standardization_results').select('reason_code').where('job_id', '=', created.id).executeTakeFirstOrThrow()).reason_code, 'not_sellable');
      assert.equal((await database.selectFrom('ai_job_batches').select('id').where('job_id', '=', created.id).execute()).length, 0);
      const duplicate = await real.createJob({ model: 'mock', productIds: [relay.id], jobType: 'incremental' });
      assert.equal(duplicate.total, 0n);
      assert.equal((await database.selectFrom('ai_standardization_results').select('job_id').where('product_id', '=', relay.id).execute()).length, 1);
    } finally {
      if (oldModel === undefined) delete process.env.AI_MODEL;
      else process.env.AI_MODEL = oldModel;
    }
  });

  test('concurrent incremental relay exclusion registers one current result and execution', async () => {
    const shop = await addShop();
    const relay = await addProduct(shop.id, '模型 API 中转充值 500美元');
    const jobs = await Promise.all([new AiRepository(database), new AiRepository(database)].map(repository =>
      repository.createJob({ model: 'mock', productIds: [relay.id], jobType: 'incremental' })));
    assert.deepEqual(jobs.map(job => Number(job.total)).sort(), [0, 1]);
    const results = await database.selectFrom('ai_standardization_results').select('job_id').where('product_id', '=', relay.id).execute();
    const executions = await database.selectFrom('ai_standardization_executions').select('job_id').where('product_id', '=', relay.id).execute();
    assert.equal(results.length, 1);
    assert.deepEqual(executions, results);
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
    const proposed = identity('business-conflict');
    const before = await database.selectFrom('standard_products').select('id').execute();
    await saveAndPublish(prepared, { identities: [proposed], items: [classified(source.id, proposed.ref)], missingIds: [] }, () => false);
    const result = await database.selectFrom('ai_standardization_results').selectAll()
      .where('job_id', '=', prepared.job.id).executeTakeFirstOrThrow();
    assert.equal(result.status, 'unclassified');
    assert.equal(result.reason_code, 'review_rejected');
    assert.equal((await database.selectFrom('standard_product_members').select('product_id').where('product_id', '=', source.id).execute()).length, 0);
    assert.equal((await database.selectFrom('product_tags').select('id').where('product_id', '=', source.id).execute()).length, 0);
    assert.deepEqual(await database.selectFrom('standard_products').select('id').execute(), before);
  });

  test('same-name majority cannot replace a shared reviewed identity for any product', async () => {
    const shop = await addShop();
    const name = '独立测试邮箱长效 OAuth2 账号';
    const majority = await database.insertInto('standard_products').values({ name: 'netease 163 mail standard',
      canonical_family: 'netease', canonical_product: '163_mail', canonical_tier: 'standard', verification_state: 'verified',
    }).returning('id').executeTakeFirstOrThrow();
    for (let index = 0; index < 2; index++) {
      const peer = await addProduct(shop.id, name);
      await database.insertInto('standard_product_members').values({ product_id: peer.id, standard_product_id: majority.id }).execute();
    }
    const source = await addProduct(shop.id, name);
    const unrelated = await addProduct(shop.id, `${name} 第二品牌`);
    const prepared = await createPreparedJob([source.id, unrelated.id]);
    const proposed = identity('shared-local-override', 'another_vendor', 'mail_account', 'standard', name);
    await saveAndPublish(prepared, { identities: [proposed], items: [source, unrelated].map(product => ({
      ...classified(product.id, proposed.ref, name), identity: { kind: 'new', ref: proposed.ref, canonicalKey: proposed.canonicalKey },
    })), missingIds: [] });
    const sourceMember = await database.selectFrom('standard_product_members').select('standard_product_id').where('product_id', '=', source.id).executeTakeFirstOrThrow();
    const unrelatedMember = await database.selectFrom('standard_product_members').select('standard_product_id').where('product_id', '=', unrelated.id).executeTakeFirstOrThrow();
    assert.notEqual(sourceMember.standard_product_id, majority.id);
    const proposedStandard = await database.selectFrom('standard_products').select('id').where('standard_key', '=', proposed.canonicalKey).executeTakeFirstOrThrow();
    assert.equal(unrelatedMember.standard_product_id, proposedStandard.id);
    assert.equal(sourceMember.standard_product_id, proposedStandard.id);
    assert.notEqual(unrelatedMember.standard_product_id, majority.id);
  });

  test('concurrent same-name publications retain their distinct reviewed identities', async () => {
    const shop = await addShop();
    const name = '并发测试 Example 邮箱账户完整名称';
    const first = await addProduct(shop.id, name);
    const second = await addProduct(shop.id, name);
    const prepared = [await createPreparedJob([first.id]), await createPreparedJob([second.id])];
    for (const [index, task] of prepared.entries()) {
      const proposed = identity(`concurrent-${index}`, 'example', `mail_${index}`, 'standard', name);
      await saveDecision(task, { identities: [proposed], items: [{
        ...classified(task.job.inputs[0]!.productId, proposed.ref, name), identity: { kind: 'new', ref: proposed.ref, canonicalKey: proposed.canonicalKey },
      }], missingIds: [] });
      await claim(task.batchId, 'publish', 2n, 'publish-claim');
    }
    await Promise.all(prepared.map(task => task.repository.publishBatch(task.batchId, { workerId: 'integration', attempt: 2n, token: 'publish-claim' })));
    const memberships = await database.selectFrom('standard_product_members').select('standard_product_id').where('product_id', 'in', [first.id, second.id]).execute();
    assert.equal(memberships.length, 2);
    assert.equal(new Set(memberships.map(row => row.standard_product_id)).size, 2);
    const proposedKeys = [0, 1].map(index => identity(`concurrent-${index}`, 'example', `mail_${index}`, 'standard').canonicalKey);
    const proposedRows = await database.selectFrom('standard_products').select('id').where('standard_key', 'in', proposedKeys).execute();
    assert.equal(proposedRows.length, 2);
    assert.deepEqual(new Set(memberships.map(row => row.standard_product_id)), new Set(proposedRows.map(row => row.id)));
    const assigned = await database.selectFrom('standard_product_members as m')
      .innerJoin('standard_products as s', 's.id', 'm.standard_product_id')
      .select(['m.product_id', 's.canonical_family', 's.canonical_product', 's.canonical_tier'])
      .where('m.product_id', 'in', [first.id, second.id]).orderBy('m.product_id').execute();
    assert.deepEqual(assigned, [
      { product_id: first.id, canonical_family: 'example', canonical_product: 'mail_0', canonical_tier: 'standard' },
      { product_id: second.id, canonical_family: 'example', canonical_product: 'mail_1', canonical_tier: 'standard' },
    ]);
  });

  test('Grok same-evidence listings deduplicate and reuse the canonical candidate across requests', async () => {
    const shop = await addShop();
    const source = await addProduct(shop.id, 'Grok 普号', '');
    const fields = { family: 'xai', product: 'grok', tier: 'free' };
    const standard = await database.insertInto('standard_products').values({
      name: 'xai / grok / free', standard_key: buildCanonicalStandardKey(fields),
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
      items: [{ id: representative.toString(), action: 'create_identity',
        identity: { family: 'x', product: 'grok', tier: 'free', reason: 'Grok free account', evidence },
        ruleIds: [], evidence, reason: 'Grok free account' }],
    }, [{ id: representative.toString(), candidateStandardProductIds: request.inputs[0]!.candidateStandardProductIds, candidateRefs: {} }]);
    await saveAndPublish(prepared, parsed);
    const members = await database.selectFrom('standard_product_members').select('standard_product_id').where('product_id', 'in', products).execute();
    assert.equal(members.length, 2);
    assert.ok(members.every(member => member.standard_product_id === standard.id));
  });

  test('publication cannot resurrect a standard merged after candidate preparation', async () => {
    for (const choice of ['existing', 'new'] as const) {
      const shop = await addShop();
      const fields = { family: `merge-test-${choice}`, product: 'account', tier: 'free' };
      const source = await database.insertInto('standard_products').values({ name: `${fields.family} account free`,
        canonical_family: fields.family, canonical_product: fields.product, canonical_tier: fields.tier,
        standard_key: buildCanonicalStandardKey(fields), verification_state: 'verified',
      }).returning('id').executeTakeFirstOrThrow();
      const target = await database.insertInto('standard_products').values({ name: 'Manual merge target', verification_state: 'verified' }).returning('id').executeTakeFirstOrThrow();
      const member = await addProduct(shop.id, `${fields.family} account free`, 'old');
      await database.insertInto('standard_product_members').values({ standard_product_id: source.id, product_id: member.id, publication_state: 'published' }).execute();
      const probe = await addProduct(shop.id, `${fields.family} account free`, 'new');
      const prepared = await createPreparedJob([probe.id]);
      const request = await prepared.repository.getBatchRequest(prepared.batchId);
      assert.ok(request.inputs[0]!.candidateStandardProductIds.includes(source.id.toString()));
      const proposed = identity('merged', fields.family, fields.product, fields.tier, `${fields.family} account free`);
      const item = { ...classified(probe.id, proposed.ref, `${fields.family} account free`), identity: choice === 'existing'
        ? { kind: 'existing' as const, standardProductId: source.id.toString() }
        : { kind: 'new' as const, ref: proposed.ref, canonicalKey: proposed.canonicalKey } };
      await saveDecision(prepared, { identities: [proposed], items: [item], missingIds: [] });
      await database.updateTable('standard_products').set({ merged_into_id: target.id, hidden: true }).where('id', '=', source.id).execute();
      await database.updateTable('standard_product_members').set({ standard_product_id: target.id }).where('standard_product_id', '=', source.id).execute();
      await claim(prepared.batchId, 'publish', 2n, 'publish-claim');
      await prepared.repository.publishBatch(prepared.batchId, { workerId: 'integration', attempt: 2n, token: 'publish-claim' });
      const result = await database.selectFrom('ai_standardization_results').select(['status', 'reason_code']).where('job_id', '=', prepared.job.id).where('product_id', '=', probe.id).executeTakeFirstOrThrow();
      assert.equal(result.status, 'unclassified');
      assert.equal(result.reason_code, 'publication_blocked');
    }
  });

  test('standards with only deleted members leave both full and incremental candidate indexes', async () => {
    const shop = await addShop();
    const fields = { family: 'expired-mail', product: 'mail_account', tier: 'standard' };
    const target = await database.insertInto('standard_products').values({ name: '已归档邮箱套餐', canonical_family: fields.family,
      canonical_product: fields.product, canonical_tier: fields.tier, standard_key: buildCanonicalStandardKey(fields), verification_state: 'verified' }).returning('id').executeTakeFirstOrThrow();
    const old = await addProduct(shop.id, '已归档邮箱套餐');
    await database.insertInto('standard_product_members').values({ product_id: old.id, standard_product_id: target.id, publication_state: 'published' }).execute();
    await database.updateTable('products').set({ deleted_at: new Date() }).where('id', '=', old.id).execute();
    const change = await database.transaction().execute(tx => recordCandidateCatalogChanges(tx, [target.id], IDENTITY_POLICY_VERSION));
    const operation = await database.selectFrom('catalog_index_changes').select('operation').where('standard_product_id', '=', target.id).where('version', '=', change.version).executeTakeFirstOrThrow();
    assert.equal(operation.operation, 'delete');
    const probe = await addProduct(shop.id, '已归档邮箱套餐');
    const prepared = await createPreparedJob([probe.id]);
    const request = await prepared.repository.getBatchRequest(prepared.batchId);
    assert.equal(request.inputs[0]!.candidateStandardProductIds.includes(target.id.toString()), false);
    await prepared.repository.cancelJob(prepared.job.id);
  });

  test('request windows follow configured concurrency for new jobs and both legacy claim paths', async () => {
    const previous = process.env.AI_CONCURRENCY;
    const repository = new AiRepository(database);
    const queue = new JobsRepository(database);
    // Earlier publication tests leave independently scheduled tag jobs queued.
    for (const prior of await database.selectFrom('ai_jobs').select('id').where('status', 'in', ['queued', 'running']).execute()) await repository.cancelJob(prior.id);
    const shop = await addShop();
    const productIds: bigint[] = [];
    for (let index = 0; index < 6; index++) productIds.push((await addProduct(shop.id, `window listing ${index}`)).id);
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
      identities: [identity('resume')], items: [classified(prepared.job.inputs[0]!.productId, 'resume')], missingIds: [],
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

  test('field-level validation reason reaches admin results without assigning the malformed item', async () => {
    const shop = await addShop();
    const product = await addProduct(shop.id, 'ChatGPT Plus malformed output');
    const prepared = await createPreparedJob([product.id]);
    const id = prepared.job.inputs[0]!.productId.toString();
    const decision = parseStandardizationProtocolResponse({ items: [{
      id, action: 'create_identity', ruleIds: [], evidence: [], reason: 'fixture', confidence: 1,
    }] }, [{ id, candidateStandardProductIds: [], candidateRefs: {} }]);
    await saveAndPublish(prepared, decision);
    const page = await prepared.repository.listJobResults({ jobId: prepared.job.id, limit: 10 });
    assert.match(String(page.items[0]?.reason), /缺少字段.*identity.*多余字段.*confidence/);
    assert.equal((page.items[0]?.diagnostic as any)?.fieldPath, 'items[0].identity');
    assert.equal((await database.selectFrom('standard_product_members').select('product_id').where('product_id', '=', product.id).execute()).length, 0);
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

  test('a saved mixed response retains bounded item diagnostics across publication', async () => {
    const shop = await addShop();
    const first = await addProduct(shop.id, 'ChatGPT Plus audit first');
    const second = await addProduct(shop.id, 'ChatGPT Plus audit second');
    const prepared = await createPreparedJob([first.id, second.id]);
    const generationBatchId = prepared.batchId;
    const call = createOpenAiModelCall(prepared.repository, {
      AI_BASE_URL: 'https://model.invalid/v1', AI_API_KEY: 'mock', AI_MODEL: 'mock',
    }, async () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ items: [
      { id: String(first.id), action: 'not_sellable', ruleIds: [], evidence: [], reason: 'not sold' },
      { id: String(second.id), action: 'create_identity', ruleIds: [], evidence: [], reason: 'private reason',
        identity: { family: 'openai', product: 'chatgpt', tier: null, reason: 'private', evidence: [] } },
    ] }) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`));
    const result = await call({ id: prepared.batchId }, new AbortController().signal);
    assert.equal(result.metadata!.responseDiagnostic!.rejectedItemCount, 1);
    await saveDecision(prepared, result, undefined, result.metadata);
    await claim(prepared.batchId, 'publish', 2n, 'publish-claim');
    await prepared.repository.publishBatch(prepared.batchId, { workerId: 'integration', attempt: 2n, token: 'publish-claim' });
    const batch = await database.selectFrom('ai_job_batches').select(['response_diagnostic', 'validated_decision'])
      .where('id', '=', generationBatchId).executeTakeFirstOrThrow();
    assert.equal((batch.response_diagnostic as any).issues[0].itemId, String(second.id));
    assert.equal((batch.response_diagnostic as any).issues[0].code, 'invalid_type');
    assert.doesNotMatch(JSON.stringify(batch.response_diagnostic), /private/);
    assert.ok(batch.validated_decision);
  });

  test('same-key refs retain their reviewed proposals and share one published standard identity', async () => {
    const shop = await addShop();
    const first = await addProduct(shop.id, 'ChatGPT Plus monthly');
    const second = await addProduct(shop.id, 'OpenAI ChatGPT Plus one month');
    const prepared = await createPreparedJob([first.id, second.id]);
    const ids = prepared.job.inputs.map(input => input.productId);
    const left = identity('left');
    const right = identity('right');
    await saveAndPublish(prepared, {
      identities: [right, left],
      items: [classified(ids[0]!, 'left'), classified(ids[1]!, 'right')],
      missingIds: [],
    });
    const standards = await database.selectFrom('standard_products').select(['id', 'standard_key']).where('standard_key', '=', left.canonicalKey).execute();
    assert.equal(standards.length, 1);
    const members = await database.selectFrom('standard_product_members').select('standard_product_id').where('product_id', 'in', [first.id, second.id]).execute();
    assert.deepEqual(new Set(members.map(row => row.standard_product_id.toString())).size, 1);
    const mappings = await database.selectFrom('ai_batch_identity_mappings').select(['identity_ref', 'standard_product_id']).where('batch_id', '=', prepared.batchId).execute();
    assert.deepEqual(mappings.map(row => row.identity_ref).sort(), ['left', 'right']);
    assert.ok(mappings.every(row => row.standard_product_id === standards[0]!.id));
  });

  test('concurrent publications with one canonical key create one standard identity', async () => {
    const firstShop = await addShop();
    const secondShop = await addShop();
    const first = await addProduct(firstShop.id, 'ChatGPT Plus first concurrent listing');
    const second = await addProduct(secondShop.id, 'ChatGPT Plus second concurrent listing');
    const firstPrepared = await createPreparedJob([first.id]);
    const secondPrepared = await createPreparedJob([second.id]);
    const proposed = identity('concurrent');

    for (const prepared of [firstPrepared, secondPrepared]) {
      await saveDecision(prepared, {
        identities: [proposed],
        items: [classified(prepared.job.inputs[0]!.productId, proposed.ref)],
        missingIds: [],
      });
      await claim(prepared.batchId, 'publish', 2n, 'publish-claim');
    }

    await Promise.all([
      firstPrepared.repository.publishBatch(firstPrepared.batchId, { workerId: 'integration', attempt: 2n, token: 'publish-claim' }),
      secondPrepared.repository.publishBatch(secondPrepared.batchId, { workerId: 'integration', attempt: 2n, token: 'publish-claim' }),
    ]);

    const standards = await database.selectFrom('standard_products')
      .select('id')
      .where('standard_key', '=', proposed.canonicalKey)
      .execute();
    assert.equal(standards.length, 1);
    const results = await database.selectFrom('ai_standardization_results')
      .select(['product_id', 'standard_product_id'])
      .where('product_id', 'in', [first.id, second.id])
      .execute();
    assert.equal(results.length, 2);
    assert.deepEqual(new Set(results.map(row => row.standard_product_id?.toString())).size, 1);
  });

  test('rejects an existing standard ID that was not frozen for that input', async () => {
    const shop = await addShop();
    const source = await addProduct(shop.id, 'Unrelated product');
    const standard = await database.insertInto('standard_products').values({
      name: 'ChatGPT Pro', platform: 'openai', standard_key: identity('x', 'openai', 'chatgpt', 'pro').canonicalKey,
      canonical_platform: 'openai', canonical_family: 'openai', canonical_product: 'chatgpt', canonical_tier: 'pro', verification_state: 'verified',
    }).returning('id').executeTakeFirstOrThrow();
    const prepared = await createPreparedJob([source.id]);
    const item: StandardizationDecision = {
      ...classified(prepared.job.inputs[0]!.productId, 'unused'),
      identity: { kind: 'existing', standardProductId: standard.id.toString() },
    };
    await assert.rejects(prepared.repository.persistBatchDecision(prepared.job.id, prepared.batchId, { identities: [], items: [item], missingIds: [] }, {}, {
      workerId: 'integration', attempt: 1n, token: 'request-claim',
    }), /unfrozen candidate/i);
    assert.equal(await database.selectFrom('ai_publication_units').select('id').where('batch_id', '=', prepared.batchId).executeTakeFirst(), undefined);
  });

  test('a legacy alias cannot redirect ChatGPT Plus to the Team identity', async () => {
    const shop = await addShop();
    const source = await addProduct(shop.id, 'ChatGPT Plus subscription');
    const existing = await database.insertInto('standard_products').values({
      name: 'OpenAI consumer subscription', platform: 'openai', standard_key: buildCanonicalStandardKey({ family: 'openai', product: 'chatgpt', tier: 'team' }),
      canonical_platform: 'openai', canonical_family: 'openai', canonical_product: 'chatgpt', canonical_tier: 'team', verification_state: 'verified',
    }).returning('id').executeTakeFirstOrThrow();
    await database.updateTable('standard_products').set({ aliases: ['ChatGPT Plus'] }).where('id', '=', existing.id).execute();
    const prepared = await createPreparedJob([source.id]);
    const inputId = prepared.job.inputs[0]!.productId;
    const proposedKey = identity('alias').canonicalKey;
    await saveAndPublish(prepared, { identities: [identity('alias')], items: [classified(inputId, 'alias')], missingIds: [] });
    const result = await database.selectFrom('ai_standardization_results').select('standard_product_id').where('job_id', '=', prepared.job.id).executeTakeFirstOrThrow();
    const plus = await database.selectFrom('standard_products').select('id').where('standard_key', '=', proposedKey).executeTakeFirstOrThrow();
    assert.equal(result.standard_product_id, plus.id);
    assert.notEqual(result.standard_product_id, existing.id);
    assert.equal(Number((await database.selectFrom('standard_products').select(sql<number>`count(*)::int`.as('count')).where('standard_key', '=', proposedKey).executeTakeFirstOrThrow()).count), 1);
  });

  test('quarantined canonical identities remain publication-blocked after approval', async () => {
    const shop = await addShop();
    const source = await addProduct(shop.id, 'ChatGPT Pro 5x quarantined');
    const proposed = identity('quarantine', 'openai', 'chatgpt', 'pro_5x', 'ChatGPT Pro 5x');
    await database.insertInto('standard_products').values({
      name: 'Quarantined', platform: 'openai', standard_key: proposed.canonicalKey,
      canonical_platform: 'openai', canonical_family: 'openai', canonical_product: 'chatgpt', canonical_tier: 'pro_5x', verification_state: 'quarantined',
    }).execute();
    const prepared = await createPreparedJob([source.id]);
    const item = classified(prepared.job.inputs[0]!.productId, proposed.ref, 'ChatGPT Pro 5x');
    item.identity = {
      kind: 'new',
      ref: proposed.ref,
      canonicalKey: proposed.canonicalKey,
    };
    await saveAndPublish(prepared, { identities: [proposed], items: [item], missingIds: [] });
    const result = await database.selectFrom('ai_standardization_results').select(['status', 'reason_code', 'current_assignment_preserved']).where('job_id', '=', prepared.job.id).executeTakeFirstOrThrow();
    assert.deepEqual(result, { status: 'unclassified', reason_code: 'publication_blocked', current_assignment_preserved: true });
  });

  test('replay after commit confirmation loss is idempotent and bumps catalog version once', async () => {
    const shop = await addShop();
    const source = await addProduct(shop.id, 'Claude Team annual');
    const prepared = await createPreparedJob([source.id]);
    const proposed = identity('claude', 'anthropic', 'claude', 'team', 'Claude Team annual');
    const item = classified(prepared.job.inputs[0]!.productId, proposed.ref, 'Claude Team annual');
    item.identity = { kind: 'new', ref: proposed.ref, canonicalKey: proposed.canonicalKey };
    const before = (await database.selectFrom('catalog_cache_versions').select('version').where('id', '=', 1).executeTakeFirstOrThrow()).version;
    await saveAndPublish(prepared, { identities: [proposed], items: [item], missingIds: [] });
    const after = (await database.selectFrom('catalog_cache_versions').select('version').where('id', '=', 1).executeTakeFirstOrThrow()).version;
    await prepared.repository.publishBatch(prepared.batchId, { workerId: 'integration', attempt: 2n, token: 'publish-claim' });
    const replayed = (await database.selectFrom('catalog_cache_versions').select('version').where('id', '=', 1).executeTakeFirstOrThrow()).version;
    assert.equal(after, before + 1n);
    assert.equal(replayed, after);
    assert.equal(Number((await database.selectFrom('ai_standardization_results').select(sql<number>`count(*)::int`.as('count')).where('job_id', '=', prepared.job.id).executeTakeFirstOrThrow()).count), 1);
  });

  test('source revision or shop invalidation prevents publication without losing a terminal result', async () => {
    for (const invalidate of ['revision', 'manual', 'shop'] as const) {
      const shop = await addShop();
      const source = await addProduct(shop.id, `ChatGPT Plus ${invalidate}`);
      const prepared = await createPreparedJob([source.id]);
      const proposed = identity(`invalid-${invalidate}`);
      await saveDecision(prepared, {
        identities: [proposed], items: [classified(prepared.job.inputs[0]!.productId, proposed.ref)], missingIds: [],
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
        identities: [identity('legacy')], items: [classified(prepared.job.inputs[0]!.productId, 'legacy')], missingIds: [],
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
    await saveAndPublish(prepared, { identities: [identity('recover')], items: prepared.job.inputs.map(input => classified(input.productId, 'recover')), missingIds: [] });
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

  test('concurrent finalizers create only one bounded missing-id round', async () => {
    const shop = await addShop();
    const source = await addProduct(shop.id, 'ChatGPT Plus missing response');
    const repository = new AiRepository(database);
    const job = await repository.createJob({ model: `integration-${++sequence}`, productIds: [source.id], batchSize: 32 });
    const batchId = job.batches[0]!.id;
    await database.updateTable('ai_job_input_members').set({ status: 'unclassified', reason_code: 'missing_id' })
      .where('job_id', '=', job.id).execute();
    await database.updateTable('ai_job_inputs').set({ status: 'succeeded', reason_code: 'missing_id' })
      .where('job_id', '=', job.id).execute();
    await database.updateTable('ai_job_batches').set({ status: 'succeeded', step: 'done', finished_at: sql`now()` })
      .where('id', '=', batchId).execute();

    await Promise.all([
      database.transaction().execute(tx => finalizeOrScheduleMissing(tx, job.id)),
      database.transaction().execute(tx => finalizeOrScheduleMissing(tx, job.id)),
    ]);

    const retries = await database.selectFrom('ai_job_batches')
      .select(['round', 'request_budget_limit', 'request_budget_used'])
      .where('job_id', '=', job.id).where('round', '=', 1).execute();
    assert.deepEqual(retries, [{ round: 1, request_budget_limit: 1, request_budget_used: 0 }]);
    const member = await database.selectFrom('ai_job_input_members')
      .select(['missing_reprocess_count', 'status', 'reason_code']).where('job_id', '=', job.id).executeTakeFirstOrThrow();
    assert.deepEqual(member, { missing_reprocess_count: 1, status: 'queued', reason_code: null });
  });

  test('unclassified result pages use numeric cursors without dropping or repeating products', async () => {
    const shop = await addShop();
    const first = await addProduct(shop.id, 'Unknown listing first');
    const second = await addProduct(shop.id, 'Unknown listing second');
    const prepared = await createPreparedJob([first.id, second.id]);
    await saveAndPublish(prepared, {
      identities: [], missingIds: [],
      items: prepared.job.inputs.map(input => ({ id: input.productId.toString(), status: 'unclassified', ruleIds: [], evidence: [], reasonCode: 'insufficient_evidence', reason: 'No known identity' })),
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
      const prepared = await createPreparedJob([source.id]);
      const evidence = [{ path: 'name', quote: name }];
      const response = JSON.stringify({ items: [{ id: String(source.id), action: 'create_identity',
        identity: { family: 'openai', product: 'chatgpt', tier, reason: '实际账号', evidence }, evidence, ruleIds: [], reason: '已开通账号' }] });
      const call = createOpenAiModelCall(prepared.repository, { AI_BASE_URL: 'https://mock.invalid/v1', AI_API_KEY: 'mock-only', AI_MODEL: 'mock' },
        async (_url, init) => {
          assert.equal(JSON.parse(String(init?.body)).stream, true);
          return new Response([{ choices: [{ delta: { content: response.slice(0, 31) } }] },
            { choices: [{ delta: { content: response.slice(31) }, finish_reason: 'stop' }] }]
            .map(chunk => 'data: ' + JSON.stringify(chunk) + '\n\n').join('') + 'data: [DONE]\n\n');
        });
      const decision = await call({ id: prepared.batchId } as never, new AbortController().signal);
      assert.equal(decision.items[0]?.status, 'classified');
      await saveAndPublish(prepared, decision);
      const member = await database.selectFrom('standard_product_members').selectAll().where('product_id', '=', source.id).executeTakeFirstOrThrow();
      assert.equal(member.publication_state, 'published');
      const standard = await database.selectFrom('standard_products').select(['canonical_tier', 'service_evidence']).where('id', '=', member.standard_product_id).executeTakeFirstOrThrow();
      assert.equal(standard.canonical_tier, tier); assert.deepEqual(standard.service_evidence, {});
    }
  });

  test('late tag extraction cannot overwrite changed evidence or a new manual review', async () => {
    for (const drift of ['evidence', 'fingerprint', 'manual', 'unchanged', 'failed'] as const) {
      const shop = await addShop(); const source = await addProduct(shop.id, `ChatGPT Plus 成品账号 ${drift}`);
      await database.insertInto('product_tags').values({ product_id: source.id, name: 'usage_restriction', value: '人工保留限制' }).execute();
      const prepared = await createPreparedJob([source.id]); const proposed = identity('tag-parent');
      await saveAndPublish(prepared, { identities: [proposed], items: [classified(source.id, proposed.ref)], missingIds: [] });
      assert.deepEqual(await database.selectFrom('product_tags').select(['name', 'value']).where('product_id', '=', source.id).execute(),
        [{ name: 'usage_restriction', value: '人工保留限制' }]);
      const result = await database.selectFrom('ai_standardization_results').select('decision').where('job_id', '=', prepared.job.id).executeTakeFirstOrThrow();
      assert.equal(Object.hasOwn(result.decision as object, 'tags'), false);
      const tagJob = await database.selectFrom('ai_jobs').selectAll().where('job_type', '=', 'tag_extraction').orderBy('id', 'desc').executeTakeFirstOrThrow();
      const batch = await database.selectFrom('ai_job_batches').selectAll().where('job_id', '=', tagJob.id).executeTakeFirstOrThrow();
      await claim(batch.id, 'request', 1n, 'tag-claim');
      const frozen = await prepared.repository.getTagExtractionBatchInputs(batch.id);
      assert.equal(frozen.inputs[0]?.name, `ChatGPT Plus 成品账号 ${drift}`);
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
            [{ productId: source.id, tags: [{ name: 'delivery', value: 'account', evidence: [{ path: 'name', quote: '成品账号' }] }], rejectedTags: [] }]), error => error instanceof DomainConflictError && error.code === 'AI_POLICY_STALE');
          await database.updateTable('ai_jobs').set({ pipeline_versions: jsonb(tagJob.pipeline_versions!) }).where('id', '=', tagJob.id).execute();
          await assert.rejects(prepared.repository.persistTagExtractionBatchDecision(tagJob.id, batch.id,
            [{ productId: source.id + 1000000n, tags: [{ name: 'delivery', value: 'account', evidence: [{ path: 'name', quote: '成品账号' }] }], rejectedTags: [] }], {}, { workerId: 'integration', attempt: 1n, token: 'tag-claim' }), /does not match/);
        }
        await prepared.repository.persistTagExtractionBatchDecision(tagJob.id, batch.id, [{ productId: source.id, tags: [{ name: 'delivery', value: 'account', evidence: [{ path: 'name', quote: '成品账号' }] }], rejectedTags: [] }], {}, { workerId: 'integration', attempt: 1n, token: 'tag-claim' });
      }
      assert.deepEqual((await database.selectFrom('product_tags').select(['name', 'value']).where('product_id', '=', source.id).orderBy('name').execute()),
        [...(drift === 'unchanged' ? [{ name: 'delivery', value: 'account' }] : []), { name: 'usage_restriction', value: '人工保留限制' }]);
    }
  });


});
