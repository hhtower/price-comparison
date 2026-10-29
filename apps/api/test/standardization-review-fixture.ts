import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { AiRepository } from '../src/ai/ai.repository.js';
import type { ParsedStandardizationResponse, StandardizationDecision } from '../src/ai/ai.schemas.js';
import { isReviewableStandardizationDecision, parseStandardizationReviewResponse } from '../src/ai/standardization-review-request.js';
import { validateStandardizationEvidence } from '../src/ai/standardization-evidence.js';
import type { DatabaseSchema } from '../src/database/types.js';

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
    generationRequest.inputs.map(item => ({ id: String(item.productId), payload: item.payload })), generationRequest.candidates, 'boundary');
  await repository.persistBatchDecision(input.jobId, input.batchId, generated, input.metadata ?? {}, input.claim);
  const generation = await db.selectFrom('ai_job_batches').select(['step', 'validated_decision'])
    .where('id', '=', input.batchId).executeTakeFirstOrThrow();
  const reviews = await db.selectFrom('ai_job_batches').select('id')
    .where('job_id', '=', input.jobId)
    .where(sql<string>`reference_snapshot->>'standardizationStage'`, '=', 'review')
    .where(sql<string>`reference_snapshot->>'generationBatchId'`, '=', String(input.batchId)).execute();
  const proposals = generation.validated_decision as unknown as ParsedStandardizationResponse;
  if (!proposals.items.some(isReviewableStandardizationDecision)) {
    assert.equal(reviews.length, 0, 'local validation errors and missing IDs must not spend review requests');
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
      .map(proposal => ({ id: proposal.id, approved: input.approve?.(proposal) ?? true })),
  }), request.proposals);
  const bounded = validateStandardizationEvidence(reviewed,
    request.inputs.map(item => ({ id: String(item.productId), payload: item.payload })), request.candidates, 'boundary');
  await repository.persistBatchDecision(input.jobId, batchId, bounded, {}, claim);
  return batchId;
}
