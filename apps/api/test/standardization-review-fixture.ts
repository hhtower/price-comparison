import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { AiRepository } from '../src/ai/ai.repository.js';
import { parseStandardizationProtocolResponse, type ParsedStandardizationResponse, type StandardizationDecision } from '../src/ai/ai.schemas.js';
import { buildExtractionPayload } from '../src/ai/adaptive-batching.js';
import { pipelineVersionSnapshot, STANDARDIZATION_POLICY_VERSION } from '../src/ai/pipeline-versions.js';
import { STANDARDIZATION_PROMPT_VERSION } from '../src/ai/standardization-request.js';
import { isReviewableStandardizationDecision, parseStandardizationReviewResponse } from '../src/ai/standardization-review-request.js';
import { validateStandardizationEvidence } from '../src/ai/standardization-evidence.js';
import { jsonb, type DatabaseSchema } from '../src/database/types.js';
import { productContentFingerprint } from '../src/standardization/fingerprint.js';

export async function seedUsableOffers(db: Kysely<DatabaseSchema>, productIds: readonly bigint[]) {
  if (!productIds.length) return;
  await db.insertInto('offers').values(productIds.map(productId => ({
    product_id: productId, price: '19.99', currency: 'USD', stock_available: true, is_stale: false,
    captured_at: new Date(), idempotency_key: randomUUID(),
  }))).execute();
}

export async function seedMatchOnlyReviewFixture(
  db: Kysely<DatabaseSchema>,
  names = ['ChatGPT Plus', 'Claude Pro'],
) {
  const standards = await db.insertInto('standard_products').values([
    { name: 'ChatGPT Plus', canonical_family: 'openai', canonical_product: 'chatgpt', canonical_tier: 'plus', verification_state: 'verified',
      catalog_definition: 'ChatGPT Plus subscriptions and accounts; excludes other ChatGPT plans.' },
    { name: 'Claude Pro', canonical_family: 'anthropic', canonical_product: 'claude', canonical_tier: 'pro', verification_state: 'verified',
      catalog_definition: 'Claude Pro subscriptions and accounts; excludes other Claude plans.' },
  ]).returningAll().execute();
  const shop = await db.insertInto('shops').values({
    platform: 'test', name: 'Match-only fixture', url: `https://${randomUUID()}.invalid`, enabled: true,
  }).returning('id').executeTakeFirstOrThrow();
  const products = await db.insertInto('products').values(names.map((name, index) => ({
    shop_id: shop.id, external_id: String(index), name, spec: '', source_category: '',
    source_data: jsonb({}), normalized_key: `review-${index}`, url: 'https://test.invalid/p',
    content_version: 1n, content_fingerprint: productContentFingerprint({ name, spec: '', sourceCategory: '', sourceData: {} }),
  }))).returningAll().execute();
  await seedUsableOffers(db, products.map(product => product.id));
  const job = await db.insertInto('ai_jobs').values({
    total: BigInt(products.length), model: 'mock', job_type: 'manual_full', status: 'running',
    prompt_version: STANDARDIZATION_PROMPT_VERSION, rule_version: STANDARDIZATION_POLICY_VERSION,
    pipeline_versions: jsonb(pipelineVersionSnapshot('mock')),
  }).returning('id').executeTakeFirstOrThrow();
  for (const product of products) {
    const payload = buildExtractionPayload({ id: String(product.id), name: product.name, spec: '', sourceData: {} });
    await db.insertInto('ai_job_inputs').values({
      job_id: job.id, input_id: product.id, payload: jsonb(payload), fingerprint: product.content_fingerprint,
      content_version: 1n, input_bytes: 100n, estimated_tokens: 100n, status: 'queued',
    }).execute();
    await db.insertInto('ai_job_input_members').values({
      job_id: job.id, input_id: product.id, product_id: product.id, fingerprint: product.content_fingerprint,
      payload: jsonb(payload), content_version: 1n, standardization_revision: product.standardization_revision,
    }).execute();
  }
  const candidates = standards.map(standard => ({
    id: String(standard.id), displayName: standard.name, family: standard.canonical_family, product: standard.canonical_product,
    tier: standard.canonical_tier, aliases: [standard.name], definition: standard.catalog_definition,
  }));
  const inputs = products.map(product => ({
    id: String(product.id),
    candidateStandardProductIds: [String(standards[product.name.startsWith('Claude') ? 1 : 0]!.id)],
    stats: { scanned: 2, compared: 2, truncated: false },
  }));
  const claim = { workerId: 'review-worker', attempt: 1n, token: 'request-claim' };
  const batch = await db.insertInto('ai_job_batches').values({
    job_id: job.id, batch_index: 0n, product_ids: jsonb(products.map(product => String(product.id))),
    product_count: BigInt(products.length), step: 'request', status: 'running', claimed_by: claim.workerId,
    attempts: claim.attempt, claim_token: claim.token, lease_until: new Date(Date.now() + 60_000),
    request_budget_used: 1, request_budget_limit: 2,
    reference_snapshot: jsonb({ strategyVersion: 'approved-candidate-20261119-v1', catalogVersion: '0', inputs, candidates }),
  }).returningAll().executeTakeFirstOrThrow();
  const raw = { items: products.map((product, index) => ({
    id: String(product.id), standardProductId: inputs[index]!.candidateStandardProductIds[0]!, nullReason: null,
    evidence: [{ path: 'name', quote: product.name }],
  })) };
  const proposals = parseStandardizationProtocolResponse(raw, inputs);
  return { job, batch, products, standards, inputs, candidates, raw, proposals, claim, repo: new AiRepository(db) };
}

export async function saveStandardizationThroughReview(
  db: Kysely<DatabaseSchema>,
  repository: AiRepository,
  input: {
    jobId: bigint;
    batchId: bigint;
    decision: ParsedStandardizationResponse;
    claim: { workerId: string; attempt: bigint; token: string };
    metadata?: Parameters<AiRepository['persistBatchDecision']>[3];
    approve?: (proposal: StandardizationDecision) => boolean;
  },
): Promise<bigint> {
  const generationRequest = await repository.getBatchRequest(input.batchId, true);
  const generated = validateStandardizationEvidence(input.decision,
    generationRequest.inputs.map(item => ({
      id: String(item.productId), payload: item.payload, candidateStandardProductIds: item.candidateStandardProductIds,
    })), generationRequest.candidates);
  await repository.persistBatchDecision(input.jobId, input.batchId, generated, input.metadata ?? {}, input.claim);
  const generation = await db.selectFrom('ai_job_batches').select(['step', 'validated_decision'])
    .where('id', '=', input.batchId).executeTakeFirstOrThrow();
  const reviews = await db.selectFrom('ai_job_batches').select('id')
    .where('job_id', '=', input.jobId)
    .where(sql<string>`reference_snapshot->>'standardizationStage'`, '=', 'review')
    .where(sql<string>`reference_snapshot->>'generationBatchId'`, '=', String(input.batchId)).execute();
  const proposals = generation.validated_decision as unknown as ParsedStandardizationResponse;
  if (!proposals.items.some(isReviewableStandardizationDecision)) {
    assert.equal(reviews.length, 0, 'local terminal decisions must not spend review requests');
    assert.equal(generation.step, 'publish');
    return input.batchId;
  }
  assert.equal(generation.step, 'done', 'generation must checkpoint before review');
  assert.equal(reviews.length, 1, 'these bounded fixtures require one real review batch');
  const batchId = reviews[0]!.id;
  const claim = { workerId: input.claim.workerId, attempt: 1n, token: randomUUID() };
  await db.updateTable('ai_job_batches').set({
    status: 'running', attempts: claim.attempt, claimed_by: claim.workerId, claim_token: claim.token,
    lease_until: new Date(Date.now() + 60_000),
  }).where('id', '=', batchId).execute();
  let reservation = await repository.reserveBatchRequest(batchId, claim);
  while (reservation === 'refresh') {
    await repository.prepareBatch(batchId);
    reservation = await repository.reserveBatchRequest(batchId, claim);
  }
  if (reservation === 'skipped') return batchId;
  assert.equal(reservation, 'reserved');
  const request = await repository.getBatchRequest(batchId);
  assert.equal(request.stage, 'review');
  assert.ok(request.proposals);
  const reviewed = parseStandardizationReviewResponse(JSON.stringify({
    items: request.proposals.items.filter(isReviewableStandardizationDecision)
      .map(proposal => {
        const approved = input.approve?.(proposal) ?? true;
        return { id: proposal.id, approved, code: approved ? null : 'source_conflict',
          evidence: approved ? [] : proposal.evidence.slice(0, 5) };
      }),
  }), request.proposals, request);
  const bounded = validateStandardizationEvidence(reviewed,
    request.inputs.map(item => ({
      id: String(item.productId), payload: item.payload, candidateStandardProductIds: item.candidateStandardProductIds,
    })), request.candidates);
  await repository.persistBatchDecision(input.jobId, batchId, bounded, {}, claim);
  return batchId;
}
