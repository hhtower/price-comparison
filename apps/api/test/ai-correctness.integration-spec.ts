import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { migrateToLatest } from '../scripts/migrate.js';
import { AiRepository } from '../src/ai/ai.repository.js';
import { productContentFingerprint } from '../src/standardization/fingerprint.js';
import { AdminRepository } from '../src/admin/admin.repository.js';
import { ProductsRepository } from '../src/products/products.repository.js';
import { JobsRepository } from '../src/jobs/jobs.repository.js';
import { buildCanonicalStandardKey } from '../src/standardization/canonical-key.js';
import { jsonb, type DatabaseSchema } from '../src/database/types.js';
import type { ParsedStandardizationResponse } from '../src/ai/ai.schemas.js';
import { buildStandardizationRequest, estimateStandardizationRequest, STANDARDIZATION_PROMPT_VERSION } from '../src/ai/standardization-request.js';
import { PIPELINE_VERSIONS } from '../src/ai/pipeline-versions.js';
import { recordManualDecisions } from '../src/standardization/decision-history.js';
import { validateStandardizationEvidence } from '../src/ai/standardization-evidence.js';
import { saveStandardizationThroughReview } from './standardization-review-fixture.js';

let db: Kysely<DatabaseSchema>;
let admin: Pool;
let schema: string;
before(async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL is required');
  schema = `ai_correctness_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema ${schema}`);
  process.env.PG_SCHEMA = schema;
  db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public`, max: 4 }) }) });
  await migrateToLatest(db);
});
after(async () => {
  await db?.destroy();
  if (admin && schema) await admin.query(`drop schema if exists ${schema} cascade`);
  await admin?.end();
  delete process.env.PG_SCHEMA;
});

async function product(name: string) {
  const shop = await db.insertInto('shops').values({ name: 'correctness', platform: 'integration', url: `https://shop.invalid/${randomUUID()}`, enabled: true }).returning('id').executeTakeFirstOrThrow();
  const source = { name, spec: 'monthly', source_category: '', source_data: {} };
  return db.insertInto('products').values({ ...source, source_data: jsonb({}), shop_id: shop.id, external_id: randomUUID(), normalized_key: randomUUID(), url: '', content_version: 1n, content_fingerprint: productContentFingerprint(source) }).returningAll().executeTakeFirstOrThrow();
}
async function claim(batch: bigint, step: 'request' | 'publish', attempts: bigint) {
  const token = randomUUID();
  await db.updateTable('ai_job_batches').set({ step, status: 'running', attempts, claimed_by: 'correctness', claim_token: token, lease_until: new Date(Date.now() + 60000) }).where('id', '=', batch).execute();
  return { workerId: 'correctness', attempt: attempts, token };
}
async function prepare(products: { id: bigint }[], repository = new AiRepository(db)) {
  const job = await repository.createJob({ model: 'mock', productIds: products.map(p => p.id), batchSize: 32 });
  assert.equal(job.batches.length, 1);
  const batch = job.batches[0]!.id;
  const requestClaim = await claim(batch, 'request', 1n);
  await repository.prepareBatch(batch);
  await repository.reserveBatchRequest(batch, requestClaim);
  return { repository, job, batch, requestClaim };
}
type Prepared = Awaited<ReturnType<typeof prepare>>;
async function historicalReview(productId: bigint, action: 'quarantine' | 'exclude', reason: string) {
  await db.transaction().execute(transaction => recordManualDecisions(transaction, [productId], { action, standardProductId: null, reason }));
}

test('jobs freeze independent pipeline versions and reject a changed schema before requesting', async () => {
  const source = await product('ChatGPT Plus pipeline versions');
  const task = await prepare([source]);
  assert.equal(task.job.prompt_version, STANDARDIZATION_PROMPT_VERSION);
  assert.equal((task.job.pipeline_versions as Record<string, unknown>).schema, PIPELINE_VERSIONS.schema);
  await db.updateTable('ai_jobs').set({ pipeline_versions: jsonb({ ...PIPELINE_VERSIONS, schema: 'stale' }) }).where('id', '=', task.job.id).execute();
  await assert.rejects(task.repository.getBatchRequest(task.batch), { code: 'AI_POLICY_STALE' });
  await task.repository.cancelJob(task.job.id);
});

test('a current pipeline can register evidence processed under a stale pipeline exactly once', async () => {
  const source = await product('ChatGPT Plus pipeline migration');
  const repository = new AiRepository(db);
  const old = await repository.createJob({ model: 'mock', productIds: [source.id], jobType: 'incremental' });
  await repository.cancelJob(old.id);
  await db.updateTable('ai_jobs').set({ pipeline_versions: jsonb({}) }).where('id', '=', old.id).execute();
  const current = await repository.createJob({ model: 'mock', productIds: [source.id], jobType: 'incremental' });
  assert.equal(current.inputs.length, 1);
  assert.equal((await db.selectFrom('ai_standardization_executions').select('job_id').where('product_id', '=', source.id).executeTakeFirstOrThrow()).job_id, current.id);
  assert.equal((await repository.createJob({ model: 'mock', productIds: [source.id], jobType: 'incremental' })).inputs.length, 0);
  await repository.cancelJob(current.id);
});

test('global pending review excludes a current manual exclusion without discarding its history', async () => {
  const source = await product('ChatGPT Plus deliberately excluded');
  await historicalReview(source.id, 'exclude', '审核为占位说明，无有效报价');
  const rows = await new AiRepository(db).listGlobalResults({ limit: 100 });
  const item = rows.items.find(item => item.productId === String(source.id));
  assert.equal(item, undefined);
  const decision = await db.selectFrom('product_standardization_decisions').select(['action', 'reason'])
    .where('product_id', '=', source.id).orderBy('id', 'desc').executeTakeFirstOrThrow();
  assert.deepEqual(decision, { action: 'exclude', reason: '审核为占位说明，无有效报价' });
});

test('explicit provider refusal materializes its own terminal category without a retry', async () => {
  const source = await product('ChatGPT Plus provider refusal');
  const task = await prepare([source]);
  await new JobsRepository(db).fail('ai_batch', task.batch, 'correctness', 'provider policy', { retry: true, retryClass: 'provider_policy_rejection' });
  const result = await db.selectFrom('ai_standardization_results').select('reason_code').where('job_id', '=', task.job.id).executeTakeFirstOrThrow();
  assert.equal(result.reason_code, 'provider_policy_rejection');
  const batch = await db.selectFrom('ai_job_batches').select(['status', 'request_budget_used']).where('id', '=', task.batch).executeTakeFirstOrThrow();
  assert.deepEqual(batch, { status: 'failed', request_budget_used: 1 });
});

test('complete request planning freezes split batches with zero provider reservations', async () => {
  const members = await Promise.all([product('ChatGPT Plus request budget first'), product('ChatGPT Plus request budget second')]);
  const repository = new AiRepository(db);
  const job = await repository.createJob({ model: 'mock', productIds: members.map(p => p.id) });
  assert.equal(job.batches.length, 1);
  const batchId = job.batches[0]!.id;
  const original = await db.selectFrom('ai_job_inputs').select(['input_id', 'payload']).where('job_id', '=', job.id).orderBy('input_id').execute();
  const candidates: never[] = [];
  const one = estimateStandardizationRequest(buildStandardizationRequest({ model: 'mock', candidates, inputs: [{ productId: original[0]!.input_id, payload: original[0]!.payload, candidateStandardProductIds: [] }] }));
  const previous = process.env.AI_REQUEST_MAX_BYTES;
  process.env.AI_REQUEST_MAX_BYTES = String(one.requestBytes + 8);
  try { await repository.prepareBatch(batchId); } finally { if (previous === undefined) delete process.env.AI_REQUEST_MAX_BYTES; else process.env.AI_REQUEST_MAX_BYTES = previous; }
  const batches = await db.selectFrom('ai_job_batches').select(['product_ids', 'request_budget_used', 'reference_snapshot', 'request_estimate']).where('job_id', '=', job.id).execute();
  assert.equal(batches.length, 2);
  assert.ok(batches.every(b => b.request_budget_used === 0 && b.reference_snapshot && b.request_estimate));
  assert.deepEqual(batches.flatMap(b => b.product_ids as string[]).sort(), members.map(p => String(p.id)).sort());
  await repository.cancelJob(job.id);
});

test('manual assignment retains reviewed evidence and unbinding protects that evidence version', async () => {
  const source = await product('ChatGPT Plus manual evidence');
  const seed = await prepare([source]);
  await save(seed, decision([source])); await publish(seed);
  const membership = await db.selectFrom('standard_product_members').select('standard_product_id').where('product_id', '=', source.id).executeTakeFirstOrThrow();
  const products = new ProductsRepository(db);
  await products.assignStandardProduct(source.id, membership.standard_product_id);
  const history = await sql<{ action: string; evidence_known: boolean; evidence_snapshot: { name: string }; content_version: bigint }>`select * from product_standardization_decisions where product_id = ${source.id} order by id desc limit 1`.execute(db);
  assert.equal(history.rows[0]?.action, 'assign');
  assert.equal(history.rows[0]?.evidence_known, true);
  assert.equal(history.rows[0]?.evidence_snapshot.name, source.name);
  assert.equal(history.rows[0]?.content_version, source.content_version);
  await products.assignStandardProduct(source.id, null);
  const retry = await prepare([source]); await save(retry, decision([source])); await publish(retry);
  assert.equal((await db.selectFrom('standard_product_members').where('product_id', '=', source.id).execute()).length, 0);
});

test('human quarantine is preserved on same evidence and changed evidence can be reassessed', async () => {
  const source = await product('ChatGPT Plus quarantine evidence');
  const seed = await prepare([source]); await save(seed, decision([source])); await publish(seed);
  await db.updateTable('standard_product_members').set({ assignment_source: 'human', publication_state: 'quarantined' }).where('product_id', '=', source.id).execute();
  const retry = await prepare([source]); await save(retry, decision([source])); await publish(retry);
  assert.equal((await db.selectFrom('standard_product_members').select('publication_state').where('product_id', '=', source.id).executeTakeFirstOrThrow()).publication_state, 'quarantined');
  const next = { ...source, name: 'ChatGPT Pro 5x changed listing' };
  await db.updateTable('products').set({ name: next.name, content_version: source.content_version + 1n, content_fingerprint: productContentFingerprint(next), standardization_revision: sql`standardization_revision + 1` }).where('id', '=', source.id).execute();
  await db.deleteFrom('standard_product_members').where('product_id', '=', source.id).execute();
  const changed = await prepare([next]); await save(changed, decision([next], 'pro_5x')); await publish(changed);
  const current = await db.selectFrom('standard_product_members as m').innerJoin('standard_products as s', 's.id', 'm.standard_product_id').select(['m.assignment_source', 's.canonical_tier']).where('m.product_id', '=', source.id).executeTakeFirstOrThrow();
  assert.deepEqual(current, { assignment_source: 'ai', canonical_tier: 'pro_5x' });
  const history = await sql<{ content_version: bigint }>`select content_version from product_standardization_decisions where product_id = ${source.id}`.execute(db);
  assert.ok(history.rows.some(row => row.content_version === source.content_version));
});

test('a manually reviewed API listing can change provider, but cannot reuse the old provider identity', async () => {
  const row = await product('Alpha API 接口服务');
  const products = new ProductsRepository(db);
  const base = { shopId: row.shop_id, externalId: row.external_id, name: row.name, spec: row.spec, normalizedKey: row.normalized_key, url: row.url };
  await products.upsertBatch([{ ...base, sourceData: { apiEndpoint: 'https://alpha.example/v1' } }]);
  const alpha = (await products.findById(row.id))!;
  const response = (p: { id: bigint; name: string }, provider: string): ParsedStandardizationResponse => {
    const identity = { family: provider, product: 'api_service', tier: 'standard' };
    const canonicalKey = buildCanonicalStandardKey(identity);
    return { identities: [{ ...identity, ref: String(p.id), canonicalKey, reason: '明确服务端点', evidence: [{ path: 'name', quote: p.name }] }],
      items: [{ id: String(p.id), status: 'classified', identity: { kind: 'new', ref: String(p.id), canonicalKey }, ruleIds: [],
        evidence: [{ path: 'name', quote: p.name }], reason: '明确服务端点', reasonCode: null }], missingIds: [] };
  };
  const seed = await prepare([alpha]); await save(seed, response(alpha, 'alpha')); await publish(seed);
  const original = await db.selectFrom('standard_product_members').select('standard_product_id').where('product_id', '=', row.id).executeTakeFirstOrThrow();
  await products.assignStandardProduct(row.id, original.standard_product_id);
  await products.upsertBatch([{ ...base, name: 'Beta API 接口服务', sourceData: { apiEndpoint: 'https://beta.example/v1' } }]);
  const beta = (await products.findById(row.id))!;
  assert.ok(beta.content_version > alpha.content_version);
  assert.equal((await db.selectFrom('standard_product_members').where('product_id', '=', row.id).execute()).length, 0);
  const staleIdentity = await prepare([beta]);
  const request = await staleIdentity.repository.getBatchRequest(staleIdentity.batch);
  assert.equal((request.inputs[0]!.previousDecision as Record<string, unknown>).action, 'assign');
  assert.equal((request.inputs[0]!.payload as Record<string, unknown>).name, beta.name);
  await save(staleIdentity, response(beta, 'alpha')); await publish(staleIdentity);
  assert.equal((await db.selectFrom('ai_standardization_results').select('reason_code').where('job_id', '=', staleIdentity.job.id).executeTakeFirstOrThrow()).reason_code, 'identity_conflict');
  const changed = await prepare([beta]); await save(changed, response(beta, 'beta')); await publish(changed);
  const assignment = await db.selectFrom('standard_product_members as m').innerJoin('standard_products as s', 's.id', 'm.standard_product_id')
    .select(['s.id', 's.canonical_family', 'm.assignment_source']).where('m.product_id', '=', row.id).executeTakeFirstOrThrow();
  assert.equal(assignment.canonical_family, 'beta');
  assert.equal(assignment.assignment_source, 'ai');
  assert.notEqual(assignment.id, original.standard_product_id);
  const oldStandard = await db.selectFrom('standard_products').select('service_evidence').where('id', '=', original.standard_product_id).executeTakeFirstOrThrow();
  assert.deepEqual((oldStandard.service_evidence as Record<string, unknown>).endpoints, ['https://alpha.example/v1']);
  await products.assignStandardProduct(row.id, assignment.id);
  await products.upsertBatch([{ ...base, name: beta.name, sourceData: { apiEndpoint: 'https://beta.example/v1', price: 99, stock: 5 } }]);
  assert.equal((await products.findById(row.id))!.content_version, beta.content_version);
  assert.equal((await db.selectFrom('standard_product_members').select('assignment_source').where('product_id', '=', row.id).executeTakeFirstOrThrow()).assignment_source, 'human');
});

for (const scenario of [
  { name: '通用 API 接口服务', endpoint: null, expected: 'service_provider_missing' },
  { name: '通用 API 接口服务（附赠教程）', endpoint: 'https://beta.invalid/v1', expected: 'service_provider_conflict' },
  { name: '通用 API 接口服务同站套餐', endpoint: 'https://alpha.invalid/v1', expected: null },
  { name: '通用 API 接口服务同站套餐（附赠教程）', endpoint: 'https://alpha.invalid/v1', expected: null },
]) test(`durable provider publication: ${scenario.name} ${scenario.endpoint ?? 'missing'}`, async () => {
  const identity = { family: 'provider', product: 'api_service', tier: 'standard' };
  const canonicalKey = buildCanonicalStandardKey(identity);
  const target = await db.selectFrom('standard_products').select('id').where('standard_key', '=', canonicalKey).executeTakeFirst()
    ?? await db.insertInto('standard_products').values({ name: 'Generic relay credits', canonical_family: identity.family, canonical_product: identity.product, canonical_tier: identity.tier, standard_key: canonicalKey, verification_state: 'verified', service_evidence: jsonb({ state: 'verified', source: 'manual', endpoints: ['https://alpha.invalid/v1'], brands: [] }) }).returning('id').executeTakeFirstOrThrow();
  const source = await product(scenario.name);
  if (scenario.endpoint) await new ProductsRepository(db).update(source.id, { sourceData: { apiEndpoint: scenario.endpoint } });
  const task = await prepare([source]);
  const payload = (await task.repository.getBatchRequest(task.batch)).inputs[0]!.payload as { name: string };
  const evidence = [{ path: 'name', quote: payload.name }];
  await save(task, { identities: [{ ...identity, ref: String(source.id), canonicalKey, reason: '明确额度销售对象', evidence }],
    items: [{ id: String(source.id), status: 'classified', identity: { kind: 'new', ref: String(source.id), canonicalKey }, ruleIds: [], evidence, reason: '明确额度销售对象', reasonCode: null }], missingIds: [] });
  await publish(task);
  const result = await db.selectFrom('ai_standardization_results').select(['status', 'reason', 'standard_product_id']).where('job_id', '=', task.job.id).where('product_id', '=', source.id).executeTakeFirstOrThrow();
  assert.equal(result.status, scenario.expected ? 'unclassified' : 'classified');
  const member = await db.selectFrom('standard_product_members').select('standard_product_id').where('product_id', '=', source.id).executeTakeFirst();
  if (scenario.expected) { assert.equal(result.reason, scenario.expected); assert.equal(result.standard_product_id, null); assert.equal(member, undefined); }
  else { assert.equal(result.standard_product_id, target.id); assert.equal(member?.standard_product_id, target.id); }
  assert.deepEqual((await db.selectFrom('standard_products').select('service_evidence').where('id', '=', target.id).executeTakeFirstOrThrow()).service_evidence, { state: 'verified', source: 'manual', endpoints: ['https://alpha.invalid/v1'], brands: [] });
});

test('review history grouping freezes quarantine separately from identical evidence with no history', async () => {
  const reviewed = await product('ChatGPT Plus identical quarantine grouping');
  const untouched = await product(reviewed.name);
  await historicalReview(reviewed.id, 'quarantine', '仅第一件当前证据隔离');
  const task = await prepare([reviewed, untouched]);
  const inputs = await db.selectFrom('ai_job_inputs').select(['input_id', 'fingerprint', 'previous_decision']).where('job_id', '=', task.job.id).orderBy('input_id').execute();
  assert.equal(inputs.length, 2);
  assert.ok(inputs.every(row => row.fingerprint === reviewed.content_fingerprint));
  const request = await task.repository.getBatchRequest(task.batch);
  const prior = request.inputs.find(input => input.productId === reviewed.id)!.previousDecision as Record<string, unknown>;
  assert.equal(prior.action, 'quarantine'); assert.equal(prior.reason, '仅第一件当前证据隔离');
  assert.equal(prior.fingerprint, reviewed.content_fingerprint);
  assert.equal(request.inputs.find(input => input.productId === untouched.id)!.previousDecision, null);
  await historicalReview(reviewed.id, 'exclude', '较晚复核不改变已冻结历史');
  assert.deepEqual((await task.repository.getBatchRequest(task.batch)).inputs.map(input => input.previousDecision), request.inputs.map(input => input.previousDecision));
  const members = await db.selectFrom('ai_job_input_members').select(['product_id', 'input_id']).where('job_id', '=', task.job.id).orderBy('product_id').execute();
  assert.deepEqual(members, [{ product_id: reviewed.id, input_id: reviewed.id }, { product_id: untouched.id, input_id: untouched.id }]);
  await task.repository.cancelJob(task.job.id);
});

test('review history grouping keeps two old decisions separate after evidence becomes identical', async () => {
  const first = await product('原先销售对象甲'); const second = await product('原先销售对象乙');
  const products = new ProductsRepository(db);
  await historicalReview(first.id, 'quarantine', '甲旧证据隔离');
  await historicalReview(second.id, 'exclude', '乙旧证据排除');
  await products.update(first.id, { name: 'ChatGPT Plus changed equal evidence' });
  await products.update(second.id, { name: 'ChatGPT Plus changed equal evidence' });
  const task = await prepare([first, second]);
  const current = (await products.findById(first.id))!;
  const request = await task.repository.getBatchRequest(task.batch);
  assert.equal(request.inputs.length, 2);
  assert.ok(request.inputs.every(input => input.fingerprint === current.content_fingerprint));
  for (const [productId, action, reason, oldFingerprint] of [[first.id, 'quarantine', '甲旧证据隔离', first.content_fingerprint], [second.id, 'exclude', '乙旧证据排除', second.content_fingerprint]] as const) {
    const input = request.inputs.find(input => input.productId === productId)!;
    const previous = input.previousDecision as Record<string, unknown>;
    assert.equal(previous.action, action); assert.equal(previous.reason, reason); assert.equal(previous.fingerprint, oldFingerprint);
    assert.equal(previous.contentVersion, '1'); assert.equal(previous.scope, 'historical_evidence_only');
    assert.equal((input.payload as Record<string, unknown>).name, current.name);
    assert.notEqual(previous.fingerprint, input.fingerprint);
  }
  const members = await db.selectFrom('ai_job_input_members').select(['product_id', 'input_id']).where('job_id', '=', task.job.id).orderBy('product_id').execute();
  assert.deepEqual(members, [{ product_id: first.id, input_id: first.id }, { product_id: second.id, input_id: second.id }]);
  await task.repository.cancelJob(task.job.id);
});

test('review history grouping still reuses identical evidence without any manual history', async () => {
  const first = await product('ChatGPT Plus equal no-history grouping'); const second = await product(first.name);
  const task = await prepare([first, second]);
  const request = await task.repository.getBatchRequest(task.batch);
  assert.equal(request.inputs.length, 1); assert.equal(request.inputs[0]!.fingerprint, first.content_fingerprint);
  assert.equal(request.inputs[0]!.previousDecision, null);
  const members = await db.selectFrom('ai_job_input_members').select(['product_id', 'input_id']).where('job_id', '=', task.job.id).orderBy('product_id').execute();
  assert.deepEqual(members, [{ product_id: first.id, input_id: first.id }, { product_id: second.id, input_id: first.id }]);
  await task.repository.cancelJob(task.job.id);
});
function decision(products: { id: bigint; name: string }[], tier = 'plus'): ParsedStandardizationResponse {
  return {
    identities: products.map(p => ({ ref: String(p.id), family: 'openai', product: 'chatgpt', tier, canonicalKey: buildCanonicalStandardKey({ family: 'openai', product: 'chatgpt', tier }), reason: 'mock', evidence: [{ path: 'name', quote: p.name }] })),
    items: products.map(p => ({ id: String(p.id), status: 'classified', identity: { kind: 'new', ref: String(p.id), canonicalKey: buildCanonicalStandardKey({ family: 'openai', product: 'chatgpt', tier }) }, ruleIds: [], evidence: [{ path: 'name', quote: p.name }], reason: 'mock', reasonCode: null })), missingIds: [],
  };
}
async function save(task: Prepared, response: ParsedStandardizationResponse, approve?: (proposal: ParsedStandardizationResponse['items'][number]) => boolean) {
  task.batch = await saveStandardizationThroughReview(db, task.repository, {
    jobId: task.job.id, batchId: task.batch, decision: response, claim: task.requestClaim, approve,
  });
}
async function publish(task: Prepared, attempt = 1n) {
  await task.repository.publishBatch(task.batch, await claim(task.batch, 'publish', attempt));
}

test('hidden verified identities accept publication without changing their display flag', async () => {
  const source = await product('ChatGPT Go hidden identity');
  const task = await prepare([source]);
  const fields = { family: 'openai', product: 'chatgpt', tier: 'go' };
  const standard = await db.insertInto('standard_products').values({ name: 'hidden Go', canonical_family: fields.family,
    canonical_product: fields.product, canonical_tier: fields.tier, standard_key: buildCanonicalStandardKey(fields),
    hidden: true, verification_state: 'verified' }).returning('id').executeTakeFirstOrThrow();
  await save(task, decision([source], 'go')); await publish(task);
  const result = await db.selectFrom('ai_standardization_results').select(['status', 'standard_product_id']).where('job_id', '=', task.job.id).executeTakeFirstOrThrow();
  assert.deepEqual(result, { status: 'classified', standard_product_id: standard.id });
  assert.equal((await db.selectFrom('standard_products').select('hidden').where('id', '=', standard.id).executeTakeFirstOrThrow()).hidden, true);
});

test('a failed sibling identity is removed before batch storage and canonical publication', async () => {
  const sources = [await product('ChatGPT Team 5x invalid first'), await product('ChatGPT Team 5x valid second')];
  const task = await prepare(sources);
  const response = decision(sources, 'team_5x');
  response.identities[0]!.evidence = [{ path: 'name', quote: 'UNVALIDATED_QUOTE_MARKER' }];
  response.identities[0]!.reason = 'UNVALIDATED_REASON_MARKER';
  const request = await task.repository.getBatchRequest(task.batch);
  const validated = validateStandardizationEvidence(response, request.inputs.map(input => ({ id: String(input.productId), payload: input.payload })), request.candidates);
  await save(task, validated);
  const saved = await db.selectFrom('ai_job_batches').select('validated_decision').where('id', '=', task.batch).executeTakeFirstOrThrow();
  assert.doesNotMatch(JSON.stringify(saved.validated_decision), /UNVALIDATED_/);
  await publish(task);
  const result = await db.selectFrom('ai_standardization_results').select(['product_id', 'status', 'standard_product_id']).where('job_id', '=', task.job.id).orderBy('product_id').execute();
  assert.deepEqual(result.map(row => row.status), ['unclassified', 'classified']);
  const standard = await db.selectFrom('standard_products').select('verification_reason').where('id', '=', result[1]!.standard_product_id!).executeTakeFirstOrThrow();
  assert.doesNotMatch(JSON.stringify(standard.verification_reason), /UNVALIDATED_/);
});

test('admin identity edits refresh warm candidate indexes and reject changed frozen candidates', async () => {
  const seed = await product('ChatGPT Plus seed correctness');
  const initial = await prepare([seed]);
  await save(initial, decision([seed])); await publish(initial);
  const standard = await db.selectFrom('standard_product_members').select('standard_product_id').where('product_id', '=', seed.id).executeTakeFirstOrThrow();
  const source = await product('ChatGPT Plus frozen correctness');
  const task = await prepare([source]);
  const before = await task.repository.getBatchRequest(task.batch);
  const id = String(standard.standard_product_id);
  assert.equal(before.candidates.find(c => c.id === id)?.tier, 'plus');
  await new AdminRepository(db).updateStandardProduct(standard.standard_product_id, { canonicalTier: 'team' });
  const next = await prepare([await product('ChatGPT Plus next correctness')], task.repository);
  const refreshed = await task.repository.getBatchRequest(next.batch);
  assert.equal(refreshed.candidates.find(c => c.id === id)?.tier, 'team');
  const response = decision([source]);
  response.identities = [];
  response.items[0]!.identity = { kind: 'existing', standardProductId: id };
  await save(task, response); await publish(task);
  const result = await db.selectFrom('ai_standardization_results').select(['status', 'reason_code']).where('job_id', '=', task.job.id).executeTakeFirstOrThrow();
  assert.deepEqual(result, { status: 'unclassified', reason_code: 'publication_blocked' });
  const diagnostic = (await db.selectFrom('ai_standardization_results').select('decision').where('job_id', '=', task.job.id).executeTakeFirstOrThrow()).decision as any;
  assert.equal(diagnostic.diagnostic.stage, 'publication');
  assert.equal(diagnostic.diagnostic.code, 'candidate_unavailable');
  assert.equal((await db.selectFrom('standard_product_members').where('product_id', '=', source.id).execute()).length, 0);
  await next.repository.cancelJob(next.job.id);
});

test('batch-wide resolved identity cannot silently change before the next publication unit', async () => {
  const source = await product('ChatGPT Plus mapping correctness');
  const task = await prepare([source]);
  const response = decision([source]);
  await save(task, response);
  const fields = { family: 'mapping', product: 'unrelated', tier: 'standard' };
  const wrong = await db.insertInto('standard_products').values({ name: 'Unrelated mapping target', platform: fields.family,
    canonical_family: fields.family, canonical_product: fields.product, canonical_tier: fields.tier,
    standard_key: buildCanonicalStandardKey(fields), verification_state: 'verified' }).returning('id').executeTakeFirstOrThrow();
  await db.updateTable('ai_batch_identity_mappings').set({ status: 'resolved', standard_product_id: wrong.id }).where('batch_id', '=', task.batch).execute();
  await publish(task);
  const result = await db.selectFrom('ai_standardization_results').select(['status', 'reason_code']).where('job_id', '=', task.job.id).executeTakeFirstOrThrow();
  assert.deepEqual(result, { status: 'unclassified', reason_code: 'publication_blocked' });
});

test('manual publication retry restores failed members, preserves successes and reuses the saved request', async () => {
  const members = await Promise.all([product('ChatGPT Plus retry a'), product('ChatGPT Plus retry b')]);
  const task = await prepare(members);
  await save(task, decision(members));
  const unit = await db.selectFrom('ai_publication_units').selectAll().where('batch_id', '=', task.batch).executeTakeFirstOrThrow();
  await db.updateTable('ai_publication_units').set({ product_ids: jsonb([String(members[0]!.id)]), member_count: 1 }).where('id', '=', unit.id).execute();
  await db.insertInto('ai_publication_units').values({ batch_id: task.batch, unit_index: 1, product_ids: jsonb([String(members[1]!.id)]), member_count: 1, tag_count: 0, payload_bytes: 500n, status: 'blocked' }).execute();
  // Commit the first unit, then force a recoverable local failure in the next unit.
  await assert.rejects(publish(task), /incomplete/);
  const success = await db.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', task.job.id).where('product_id', '=', members[0]!.id).executeTakeFirstOrThrow();
  await new JobsRepository(db).fail('ai_batch', task.batch, 'correctness', 'local retry exhausted', { retry: false, retryClass: 'local' });
  await task.repository.retryJob(task.job.id);
  const reopened = await db.selectFrom('ai_job_input_members').select(['product_id', 'status']).where('job_id', '=', task.job.id).orderBy('product_id').execute();
  assert.deepEqual(reopened.map(m => m.status), ['classified', 'queued']);
  const job = await db.selectFrom('ai_jobs').select('phase').where('id', '=', task.job.id).executeTakeFirstOrThrow();
  assert.equal(job.phase, 'standardizing');
  const progress = await task.repository.getJobProgress(task.job.id);
  assert.equal(progress?.results.classified, 1);
  assert.equal(progress?.results.unclassified, 0);
  assert.equal(progress?.publication.pendingMembers, 1);
  assert.equal(progress?.requests.budgetUsed, 2);
  await publish(task);
  assert.equal((await db.selectFrom('standard_product_members').where('product_id', 'in', members.map(p => p.id)).execute()).length, 2);
  assert.deepEqual(await db.selectFrom('ai_standardization_results').selectAll().where('job_id', '=', task.job.id).where('product_id', '=', members[0]!.id).executeTakeFirstOrThrow(), success);
  const finished = await db.selectFrom('ai_job_batches').select(['status', 'request_budget_used', 'confirmed_requests']).where('id', '=', task.batch).executeTakeFirstOrThrow();
  assert.deepEqual(finished, { status: 'succeeded', request_budget_used: 1, confirmed_requests: 1 });
});

test('entering publication starts a fresh bounded local attempt budget', async () => {
  const source = await product('ChatGPT Plus phase attempts');
  const task = await prepare([source]);
  await save(task, decision([source]));
  const batch = await db.selectFrom('ai_job_batches').select(['attempts', 'step']).where('id', '=', task.batch).executeTakeFirstOrThrow();
  assert.deepEqual(batch, { attempts: 0n, step: 'publish' });
  await task.repository.cancelJob(task.job.id);
});

test('clearing a canonical identity removes it from an already warmed candidate index', async () => {
  const seed = await product('ChatGPT Plus clear seed');
  const initial = await prepare([seed]);
  await save(initial, decision([seed]));
  await publish(initial);
  const assigned = await db.selectFrom('standard_product_members').select('standard_product_id').where('product_id', '=', seed.id).executeTakeFirstOrThrow();
  const repository = new AiRepository(db);
  const source = await product('ChatGPT Plus clear candidate');
  const task = await prepare([source], repository);
  assert.ok((await repository.getBatchRequest(task.batch)).candidates.some(row => row.id === String(assigned.standard_product_id)));
  await new AdminRepository(db).updateStandardProduct(assigned.standard_product_id, { canonicalFamily: '', canonicalProduct: '', canonicalTier: '' });
  const next = await prepare([await product('ChatGPT Plus after clear')], repository);
  assert.ok(!(await repository.getBatchRequest(next.batch)).candidates.some(row => row.id === String(assigned.standard_product_id)));
  await repository.cancelJob(task.job.id);
  await repository.cancelJob(next.job.id);
});

test('binary review rejects an identity conflicting with the sold non-SMS product', async () => {
  const source = await product('ChatGPT Plus actual identity');
  const task = await prepare([source]);
  await save(task, decision([source], 'team'), () => false);
  await publish(task);
  const result = await db.selectFrom('ai_standardization_results').select(['status', 'reason_code']).where('job_id', '=', task.job.id).executeTakeFirstOrThrow();
  assert.deepEqual(result, { status: 'unclassified', reason_code: 'review_rejected' });
  assert.equal((await db.selectFrom('standard_product_members').select('product_id').where('product_id', '=', source.id).execute()).length, 0);
});

test('local catalog bounds reject invalid identities and binary review rejects fake generic tools', async () => {
  for (const [productName, name, approved] of [
    ['grok_super', 'Grok Super会员', true], ['grok_heavy', 'Grok Heavy会员', true],
    ['x_account', 'X账号', true], ['residential_proxy', '住宅IP代理', true],
    ['grok_tool', 'Grok Super会员', false], ['x_account_bundle', 'X账号', false],
  ] as const) {
    const source = await product(name);
    const task = await prepare([source]);
    const identity = { family: 'generic', product: productName!, tier: 'standard' };
    const canonicalKey = buildCanonicalStandardKey(identity);
    const response = decision([source]);
    Object.assign(response.identities[0]!, identity, { canonicalKey });
    response.items[0]!.identity = { kind: 'new', ref: String(source.id), canonicalKey };
    await save(task, response, () => approved);
    await publish(task);
    const result = await db.selectFrom('ai_standardization_results').select(['status', 'reason_code'])
      .where('job_id', '=', task.job.id).executeTakeFirstOrThrow();
    assert.deepEqual(result, { status: 'unclassified', reason_code: approved ? 'publication_blocked' : 'review_rejected' }, productName);
    assert.equal((await db.selectFrom('standard_product_members').where('product_id', '=', source.id).execute()).length, 0);
    assert.equal((await db.selectFrom('standard_products').where('standard_key', '=', canonicalKey).execute()).length, 0);
  }
});

test('reapplying saved results resets the local publication attempt budget', async () => {
  const source = await product('ChatGPT Plus reapply attempts');
  const task = await prepare([source]);
  await save(task, decision([source]));
  await publish(task, 4n);
  await db.deleteFrom('standard_product_members').where('product_id', '=', source.id).execute();
  await db.updateTable('ai_standardization_results').set({ status: 'unclassified', standard_product_id: null, reason_code: 'source_changed' }).where('job_id', '=', task.job.id).execute();
  await db.updateTable('ai_job_input_members').set({ status: 'unclassified', reason_code: 'source_changed' }).where('job_id', '=', task.job.id).execute();
  await task.repository.reapplySavedResults(task.job.id);
  const row = await db.selectFrom('ai_job_batches').select(['attempts', 'request_budget_used']).where('id', '=', task.batch).executeTakeFirstOrThrow();
  assert.deepEqual(row, { attempts: 0n, request_budget_used: 1 });
  await publish(task);
  assert.equal((await db.selectFrom('standard_product_members').select('product_id').where('product_id', '=', source.id).execute()).length, 1);
});
