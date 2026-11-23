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
import { parseStandardizationProtocolResponse, type ParsedStandardizationResponse } from '../src/ai/ai.schemas.js';
import { buildStandardizationRequest, estimateStandardizationRequest, STANDARDIZATION_PROMPT_VERSION } from '../src/ai/standardization-request.js';
import { PIPELINE_VERSIONS, STANDARDIZATION_POLICY_VERSION } from '../src/ai/pipeline-versions.js';
import { recordManualDecisions } from '../src/standardization/decision-history.js';
import { validateStandardizationEvidence } from '../src/ai/standardization-evidence.js';
import { recordCandidateCatalogChanges } from '../src/catalog/catalog-version.repository.js';
import { CATALOG_ALIAS_VERSION } from '../src/standardization/catalog-aliases.js';
import { saveStandardizationThroughReview, seedUsableOffers } from './standardization-review-fixture.js';

let db: Kysely<DatabaseSchema>;
let admin: Pool;
let schema: string;
let plusId: bigint, pro5xId: bigint, teamId: bigint, team5xId: bigint;
before(async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL is required');
  schema = `ai_correctness_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`create schema ${schema}`);
  process.env.PG_SCHEMA = schema;
  db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public`, max: 4 }) }) });
  await migrateToLatest(db);
  plusId = await seedStandard('ChatGPT Plus', 'openai', 'chatgpt', 'plus');
  pro5xId = await seedStandard('ChatGPT Pro 5x', 'openai', 'chatgpt', 'pro_5x');
  teamId = await seedStandard('ChatGPT Team', 'openai', 'chatgpt', 'team');
  team5xId = await seedStandard('ChatGPT Team 5x', 'openai', 'chatgpt', 'team_5x');
});
after(async () => {
  await db?.destroy();
  if (admin && schema) await admin.query(`drop schema if exists ${schema} cascade`);
  await admin?.end();
  delete process.env.PG_SCHEMA;
});

async function seedStandard(name: string, family: string, product: string, tier: string) {
  const row = await db.insertInto('standard_products').values({ catalog_definition: name + ': only this product and plan; duration and delivery are offer attributes.', name, canonical_family: family,
    canonical_product: product, canonical_tier: tier, verification_state: 'verified',
    standard_key: buildCanonicalStandardKey({ family, product, tier }) }).returning('id').executeTakeFirstOrThrow();
  await db.transaction().execute(tx => recordCandidateCatalogChanges(tx, [row.id], CATALOG_ALIAS_VERSION));
  return row.id;
}
async function product(name: string) {
  const shop = await db.insertInto('shops').values({ name: 'correctness', platform: 'integration', url: `https://shop.invalid/${randomUUID()}`, enabled: true }).returning('id').executeTakeFirstOrThrow();
  const source = { name, spec: 'monthly', source_category: '', source_data: {} };
  const row = await db.insertInto('products').values({ ...source, source_data: jsonb({}), shop_id: shop.id, external_id: randomUUID(), normalized_key: randomUUID(), url: '', content_version: 1n, content_fingerprint: productContentFingerprint(source) }).returningAll().executeTakeFirstOrThrow();
  await seedUsableOffers(db, [row.id]);
  return row;
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
  assert.equal(task.job.rule_version, STANDARDIZATION_POLICY_VERSION);
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
  await historicalReview(source.id, 'quarantine', '当前原始证据已人工核对');
  const retry = await prepare([source]); await save(retry, decision([source])); await publish(retry);
  assert.equal((await db.selectFrom('standard_product_members').select('publication_state').where('product_id', '=', source.id).executeTakeFirstOrThrow()).publication_state, 'quarantined');
  const next = { ...source, name: 'ChatGPT Pro 5x changed listing' };
  await db.updateTable('products').set({ name: next.name, content_version: source.content_version + 1n, content_fingerprint: productContentFingerprint(next), standardization_revision: sql`standardization_revision + 1` }).where('id', '=', source.id).execute();
  await db.deleteFrom('standard_product_members').where('product_id', '=', source.id).execute();
  const changed = await prepare([next]); await save(changed, decision([next], pro5xId)); await publish(changed);
  const current = await db.selectFrom('standard_product_members as m').innerJoin('standard_products as s', 's.id', 'm.standard_product_id').select(['m.assignment_source', 's.canonical_tier']).where('m.product_id', '=', source.id).executeTakeFirstOrThrow();
  assert.deepEqual(current, { assignment_source: 'ai', canonical_tier: 'pro_5x' });
  const history = await sql<{ content_version: bigint }>`select content_version from product_standardization_decisions where product_id = ${source.id}`.execute(db);
  assert.ok(history.rows.some(row => row.content_version === source.content_version));
});

test('changed provider evidence uses a fresh reviewed target and preserves the old manual audit', async () => {
  const alphaId = await seedStandard('Alpha API 接口服务', 'alpha', 'api_service', 'standard');
  const betaId = await seedStandard('Beta API 接口服务', 'beta', 'api_service', 'standard');
  const row = await product('Alpha API 接口服务');
  const products = new ProductsRepository(db);
  const base = { shopId: row.shop_id, externalId: row.external_id, name: row.name, spec: row.spec, normalizedKey: row.normalized_key, url: row.url };
  await products.upsertBatch([{ ...base, sourceData: { apiEndpoint: 'https://alpha.example/v1' } }]);
  const alpha = (await products.findById(row.id))!;
  const seed = await prepare([alpha]); await save(seed, decision([alpha], alphaId)); await publish(seed);
  await products.assignStandardProduct(row.id, alphaId);
  await products.upsertBatch([{ ...base, name: 'Beta API 接口服务', sourceData: { apiEndpoint: 'https://beta.example/v1' } }]);
  const beta = (await products.findById(row.id))!;
  assert.ok(beta.content_version > alpha.content_version);
  assert.equal((await db.selectFrom('standard_product_members').where('product_id', '=', row.id).execute()).length, 0);
  const changed = await prepare([beta]);
  const request = await changed.repository.getBatchRequest(changed.batch);
  assert.equal(Object.hasOwn(request.inputs[0]!, 'previousDecision'), false);
  assert.equal((request.inputs[0]!.payload as Record<string, unknown>).name, beta.name);
  await save(changed, decision([beta], betaId)); await publish(changed);
  assert.deepEqual(await db.selectFrom('standard_product_members').select(['standard_product_id', 'assignment_source'])
    .where('product_id', '=', row.id).executeTakeFirstOrThrow(), { standard_product_id: betaId, assignment_source: 'ai' });
  const history = await db.selectFrom('product_standardization_decisions').select(['standard_product_id', 'content_version'])
    .where('product_id', '=', row.id).execute();
  assert.ok(history.some(item => item.standard_product_id === alphaId && item.content_version === alpha.content_version));
  await products.assignStandardProduct(row.id, betaId);
  await products.upsertBatch([{ ...base, name: beta.name, sourceData: { apiEndpoint: 'https://beta.example/v1', price: 99, stock: 5 } }]);
  assert.equal((await products.findById(row.id))!.content_version, beta.content_version);
  assert.equal((await db.selectFrom('standard_product_members').select('assignment_source').where('product_id', '=', row.id).executeTakeFirstOrThrow()).assignment_source, 'human');
});

test('deduplicated evidence still preserves each member manual decision without exposing history', async () => {
  const reviewed = await product('ChatGPT Plus identical quarantine grouping');
  const untouched = await product(reviewed.name);
  await historicalReview(reviewed.id, 'quarantine', '仅第一件当前证据隔离');
  const task = await prepare([reviewed, untouched]);
  const inputs = await db.selectFrom('ai_job_inputs').select(['input_id', 'fingerprint', 'manual_decision_id']).where('job_id', '=', task.job.id).orderBy('input_id').execute();
  assert.equal(inputs.length, 1);
  assert.ok(inputs.every(row => row.fingerprint === reviewed.content_fingerprint));
  assert.notEqual(inputs[0]!.manual_decision_id, null);
  const request = await task.repository.getBatchRequest(task.batch);
  assert.ok(request.inputs.every(input => !Object.hasOwn(input, 'previousDecision')));
  await historicalReview(reviewed.id, 'exclude', '较晚复核不改变已冻结原始证据');
  assert.deepEqual((await task.repository.getBatchRequest(task.batch)).inputs, request.inputs);
  await save(task, decision([reviewed])); await publish(task);
  assert.deepEqual(await db.selectFrom('standard_product_members').select('product_id').where('product_id', 'in', [reviewed.id, untouched.id]).execute(), [{ product_id: untouched.id }]);
});

test('identical current evidence deduplicates without treating old manual decisions as current evidence', async () => {
  const first = await product('原先销售对象甲'); const second = await product('原先销售对象乙');
  const products = new ProductsRepository(db);
  await historicalReview(first.id, 'quarantine', '甲旧证据隔离');
  await historicalReview(second.id, 'exclude', '乙旧证据排除');
  await products.update(first.id, { name: 'ChatGPT Plus changed equal evidence' });
  await products.update(second.id, { name: 'ChatGPT Plus changed equal evidence' });
  const task = await prepare([first, second]);
  const current = (await products.findById(first.id))!;
  const request = await task.repository.getBatchRequest(task.batch);
  assert.equal(request.inputs.length, 1);
  assert.ok(request.inputs.every(input => input.fingerprint === current.content_fingerprint));
  assert.ok(request.inputs.every(input => !Object.hasOwn(input, 'previousDecision')));
  assert.ok(request.inputs.every(input => (input.payload as Record<string, unknown>).name === current.name));
  const history = await db.selectFrom('product_standardization_decisions').select(['product_id', 'content_fingerprint'])
    .where('product_id', 'in', [first.id, second.id]).orderBy('product_id').execute();
  assert.deepEqual(history, [{ product_id: first.id, content_fingerprint: first.content_fingerprint },
    { product_id: second.id, content_fingerprint: second.content_fingerprint }]);
  await task.repository.cancelJob(task.job.id);
});

test('review history grouping still reuses identical evidence without any manual history', async () => {
  const first = await product('ChatGPT Plus equal no-history grouping'); const second = await product(first.name);
  const task = await prepare([first, second]);
  const request = await task.repository.getBatchRequest(task.batch);
  assert.equal(request.inputs.length, 1); assert.equal(request.inputs[0]!.fingerprint, first.content_fingerprint);
  assert.equal(Object.hasOwn(request.inputs[0]!, 'previousDecision'), false);
  const members = await db.selectFrom('ai_job_input_members').select(['product_id', 'input_id']).where('job_id', '=', task.job.id).orderBy('product_id').execute();
  assert.deepEqual(members, [{ product_id: first.id, input_id: first.id }, { product_id: second.id, input_id: first.id }]);
  await task.repository.cancelJob(task.job.id);
});
function decision(products: { id: bigint; name: string }[], standardProductId = plusId): ParsedStandardizationResponse {
  return parseStandardizationProtocolResponse({ items: products.map(product => ({
    id: String(product.id), standardProductId: String(standardProductId), nullReason: null, evidence: [{ path: 'name', quote: product.name }],
  })) }, products.map(product => ({ id: String(product.id), candidateStandardProductIds: [String(standardProductId)] })));
}
async function save(task: Prepared, response: ParsedStandardizationResponse, approve?: (proposal: ParsedStandardizationResponse['items'][number]) => boolean) {
  task.batch = await saveStandardizationThroughReview(db, task.repository, {
    jobId: task.job.id, batchId: task.batch, decision: response, claim: task.requestClaim, approve,
  });
}
async function publish(task: Prepared, attempt = 1n) {
  await task.repository.publishBatch(task.batch, await claim(task.batch, 'publish', attempt));
}

test('hidden verified candidates accept publication without changing their display flag', async () => {
  const source = await product('ChatGPT Go hidden identity');
  const standardId = await seedStandard('ChatGPT Go', 'openai', 'chatgpt', 'go');
  await db.updateTable('standard_products').set({ hidden: true }).where('id', '=', standardId).execute();
  const task = await prepare([source]);
  await save(task, decision([source], standardId)); await publish(task);
  assert.deepEqual(await db.selectFrom('ai_standardization_results').select(['status', 'standard_product_id']).where('job_id', '=', task.job.id).executeTakeFirstOrThrow(),
    { status: 'classified', standard_product_id: standardId });
  assert.equal((await db.selectFrom('standard_products').select('hidden').where('id', '=', standardId).executeTakeFirstOrThrow()).hidden, true);
});

test('legacy verified standards with no approved definition stay outside frozen candidates', async () => {
  const name = 'Legacy unadmitted product';
  const targetId = await seedStandard(name, 'legacy', 'unadmitted', 'standard');
  await db.updateTable('standard_products').set({ catalog_definition: null }).where('id', '=', targetId).execute();
  const source = await product(name);
  const task = await prepare([source]);
  const request = await task.repository.getBatchRequest(task.batch);
  assert.ok(!request.candidates.some(candidate => candidate.id === String(targetId)));
  await assert.rejects(save(task, decision([source], targetId)), { reasonCode: 'invalid_response' });
  assert.deepEqual(await db.selectFrom('standard_product_members').select('product_id').where('product_id', '=', source.id).execute(), []);
  assert.equal((await db.selectFrom('standard_products').select('hidden').where('id', '=', targetId).executeTakeFirstOrThrow()).hidden, false);
  await task.repository.cancelJob(task.job.id);
});

test('frozen names and applicability definitions must still match at publication', async () => {
  for (const field of ['name', 'definition', 'admission'] as const) {
    const name = `Frozen boundary ${field}`;
    const targetId = await seedStandard(name, `boundary_${field}`, 'plan', 'standard');
    const source = await product(name);
    const task = await prepare([source]);
    const request = await task.repository.getBatchRequest(task.batch);
    const candidate = request.candidates.find(row => row.id === String(targetId))!;
    assert.equal(candidate.displayName, name);
    assert.equal(candidate.definition, `${name}: only this product and plan; duration and delivery are offer attributes.`);
    await save(task, decision([source], targetId));
    await db.updateTable('standard_products').set(field === 'name' ? { name: `${name} changed` }
      : { catalog_definition: field === 'definition' ? 'A different admitted plan boundary' : null }).where('id', '=', targetId).execute();
    await publish(task);
    assert.deepEqual(await db.selectFrom('ai_standardization_results').select(['status', 'reason_code'])
      .where('job_id', '=', task.job.id).executeTakeFirstOrThrow(), { status: 'unclassified', reason_code: 'publication_blocked' });
    assert.deepEqual(await db.selectFrom('standard_product_members').select('product_id').where('product_id', '=', source.id).execute(), []);
  }
});

test('one invalid citation rejects the complete batch without partial persistence or standard creation', async () => {
  const sources = [await product('ChatGPT Team 5x invalid first'), await product('ChatGPT Team 5x valid second')];
  const task = await prepare(sources);
  const response = decision(sources, team5xId);
  response.items[0]!.evidence = [{ path: 'name', quote: 'UNVALIDATED_QUOTE_MARKER' }];
  const request = await task.repository.getBatchRequest(task.batch);
  const before = await db.selectFrom('standard_products').select('id').orderBy('id').execute();
  assert.throws(() => validateStandardizationEvidence(response, request.inputs.map(input => ({
    id: String(input.productId), payload: input.payload, candidateStandardProductIds: input.candidateStandardProductIds,
  })), request.candidates), { reasonCode: 'evidence_invalid' });
  await assert.rejects(save(task, response), { reasonCode: 'evidence_invalid' });
  assert.equal((await db.selectFrom('ai_job_batches').select('validated_decision').where('id', '=', task.batch).executeTakeFirstOrThrow()).validated_decision, null);
  assert.deepEqual(await db.selectFrom('ai_standardization_results').select('product_id').where('job_id', '=', task.job.id).execute(), []);
  assert.deepEqual(await db.selectFrom('standard_products').select('id').orderBy('id').execute(), before);
  await task.repository.cancelJob(task.job.id);
});

test('admin identity edits refresh warm candidate indexes and reject changed frozen candidates', async () => {
  const seed = await product('YouTube Individual seed correctness');
  const youtubeId = await seedStandard('YouTube Individual', 'youtube', 'youtube', 'individual');
  const initial = await prepare([seed]);
  const initialDecision = decision([seed], youtubeId);
  await save(initial, initialDecision); await publish(initial);
  const standard = await db.selectFrom('standard_product_members').select('standard_product_id').where('product_id', '=', seed.id).executeTakeFirstOrThrow();
  const source = await product('YouTube Individual frozen correctness');
  const task = await prepare([source]);
  const before = await task.repository.getBatchRequest(task.batch);
  const id = String(standard.standard_product_id);
  assert.equal(before.candidates.find(c => c.id === id)?.tier, 'individual');
  await new AdminRepository(db).updateStandardProduct(standard.standard_product_id, { canonicalTier: 'family' });
  const next = await prepare([await product('YouTube Individual next correctness')], task.repository);
  const refreshed = await task.repository.getBatchRequest(next.batch);
  assert.equal(refreshed.candidates.find(c => c.id === id)?.tier, 'family');
  const response = decision([source], standard.standard_product_id);
  await save(task, response); await publish(task);
  const result = await db.selectFrom('ai_standardization_results').select(['status', 'reason_code']).where('job_id', '=', task.job.id).executeTakeFirstOrThrow();
  assert.deepEqual(result, { status: 'unclassified', reason_code: 'publication_blocked' });
  const diagnostic = (await db.selectFrom('ai_standardization_results').select('decision').where('job_id', '=', task.job.id).executeTakeFirstOrThrow()).decision as any;
  assert.equal(diagnostic.diagnostic.stage, 'publication');
  assert.equal(diagnostic.diagnostic.code, 'candidate_unavailable');
  assert.equal((await db.selectFrom('standard_product_members').where('product_id', '=', source.id).execute()).length, 0);
  await next.repository.cancelJob(next.job.id);
});

test('legacy resolved identity mappings cannot redirect a frozen existing ID', async () => {
  const source = await product('ChatGPT Plus mapping correctness');
  const task = await prepare([source]);
  const response = decision([source]);
  await save(task, response);
  const fields = { family: 'mapping', product: 'unrelated', tier: 'standard' };
  const wrong = await db.insertInto('standard_products').values({ catalog_definition: 'Explicit fixture admission: only the named product and plan; duration and delivery do not change identity.', name: 'Unrelated mapping target', platform: fields.family,
    canonical_family: fields.family, canonical_product: fields.product, canonical_tier: fields.tier,
    standard_key: buildCanonicalStandardKey(fields), verification_state: 'verified' }).returning('id').executeTakeFirstOrThrow();
  const mappings = await db.selectFrom('ai_batch_identity_mappings').selectAll().where('batch_id', '=', task.batch).execute();
  assert.deepEqual(mappings, []);
  await db.insertInto('ai_batch_identity_mappings').values({
    batch_id: task.batch, identity_ref: `existing:${plusId}`, canonical_key: buildCanonicalStandardKey({ family: 'openai', product: 'chatgpt', tier: 'plus' }),
    status: 'resolved', standard_product_id: wrong.id, identity_snapshot: jsonb({ family: 'mapping', product: 'unrelated', tier: 'standard' }),
  }).execute();
  await publish(task);
  const result = await db.selectFrom('ai_standardization_results').select(['status', 'reason_code']).where('job_id', '=', task.job.id).executeTakeFirstOrThrow();
  assert.deepEqual(result, { status: 'classified', reason_code: null });
  assert.equal((await db.selectFrom('standard_product_members').select('standard_product_id')
    .where('product_id', '=', source.id).executeTakeFirstOrThrow()).standard_product_id, plusId);
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
  const reopenedByProduct = new Map(reopened.map(member => [member.product_id, member.status]));
  assert.equal(reopenedByProduct.get(members[0]!.id), 'classified');
  assert.equal(reopenedByProduct.get(members[1]!.id), 'queued');
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
  const seed = await product('Microsoft Outlook account clear seed');
  const outlookId = await seedStandard('Microsoft Outlook account', 'microsoft', 'outlook', 'standard');
  const initial = await prepare([seed]);
  const initialDecision = decision([seed], outlookId);
  await save(initial, initialDecision);
  await publish(initial);
  const assigned = await db.selectFrom('standard_product_members').select('standard_product_id').where('product_id', '=', seed.id).executeTakeFirstOrThrow();
  const repository = new AiRepository(db);
  const source = await product('Microsoft Outlook account clear candidate');
  const task = await prepare([source], repository);
  assert.ok((await repository.getBatchRequest(task.batch)).candidates.some(row => row.id === String(assigned.standard_product_id)));
  await new AdminRepository(db).updateStandardProduct(assigned.standard_product_id, { canonicalFamily: '', canonicalProduct: '', canonicalTier: '' });
  const next = await prepare([await product('Microsoft Outlook account after clear')], repository);
  assert.ok(!(await repository.getBatchRequest(next.batch)).candidates.some(row => row.id === String(assigned.standard_product_id)));
  await repository.cancelJob(task.job.id);
  await repository.cancelJob(next.job.id);
});

test('binary review rejects an identity conflicting with the sold non-SMS product', async () => {
  const source = await product('ChatGPT Plus actual identity');
  const task = await prepare([source]);
  await save(task, decision([source], teamId), () => false);
  await publish(task);
  const result = await db.selectFrom('ai_standardization_results').select(['status', 'reason_code']).where('job_id', '=', task.job.id).executeTakeFirstOrThrow();
  assert.deepEqual(result, { status: 'unclassified', reason_code: 'review_rejected' });
  assert.equal((await db.selectFrom('standard_product_members').select('product_id').where('product_id', '=', source.id).execute()).length, 0);
});

test('legacy identity creation output is rejected without adding standards or publication units', async () => {
  const source = await product('Grok Super会员');
  const task = await prepare([source]);
  const before = await db.selectFrom('standard_products').select('id').orderBy('id').execute();
  const legacy = { identities: [{ ref: 'new', family: 'generic', product: 'grok_tool', tier: 'standard' }],
    items: [{ id: String(source.id), action: 'create_identity', identity: { ref: 'new' } }] };
  assert.throws(() => parseStandardizationProtocolResponse(legacy,
    [{ id: String(source.id), candidateStandardProductIds: [] }]), { reasonCode: 'invalid_response' });
  await assert.rejects(task.repository.persistBatchDecision(task.job.id, task.batch,
    legacy as unknown as ParsedStandardizationResponse, {}, task.requestClaim), /obsolete identity protocol/);
  assert.deepEqual(await db.selectFrom('standard_products').select('id').orderBy('id').execute(), before);
  assert.deepEqual(await db.selectFrom('ai_publication_units').select('id').where('batch_id', '=', task.batch).execute(), []);
  await task.repository.cancelJob(task.job.id);
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
