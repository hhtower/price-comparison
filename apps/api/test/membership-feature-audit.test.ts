import assert from 'node:assert/strict';
import test from 'node:test';
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type CompiledQuery, type DatabaseConnection } from 'kysely';
import { AiRepository } from '../src/ai/ai.repository.js';
import type { DatabaseSchema, JsonValue } from '../src/database/types.js';

function fixture(jobType: string, output: JsonValue, status = 'classified', batches: object[] = []) {
  class Driver extends DummyDriver {
    async acquireConnection(): Promise<DatabaseConnection> {
      return {
        async executeQuery<R>(query: CompiledQuery) {
          const rows = query.sql.includes('from "ai_jobs"') ? [{ id: 1n, job_type: jobType }]
            : query.sql.includes('from "ai_job_input_members"') ? [{
              id: 2n, input_id: 2n, product_id: 2n, status, output, payload: {}, name: 'product', spec: '',
              content_version: 1n, standardization_revision: 0n, fingerprint: 'current', reason_code: null,
            }] : query.sql.includes('from "ai_job_batches"') ? batches : undefined;
          assert.ok(rows, `Unexpected query: ${query.sql}`);
          return { rows: rows as R[] };
        },
        async *streamQuery<R>(): AsyncIterableIterator<{ rows: R[] }> { throw new Error('Unexpected stream'); },
      };
    }
  }
  const db = new Kysely<DatabaseSchema>({ dialect: {
    createAdapter: () => new PostgresAdapter(), createDriver: () => new Driver(),
    createIntrospector: database => new PostgresIntrospector(database), createQueryCompiler: () => new PostgresQueryCompiler(),
  } });
  return { db, repo: new AiRepository(db) };
}

const legacy = {
  outcome: 'updated', classification: { kind: 'account', reason: 'llm_reviewed', durationSource: 'default' },
  classificationReviewed: true, proposedMembershipKind: 'account',
  acceptedTags: Array.from({ length: 7 }, () => ({ name: 'duration', value: '1 month', evidence: [] })),
  rejectedTags: [{ name: 'access', value: 'shared', evidence: [] }], diff: [],
};

test('feature results count seven historical facts as one saved classification and never count unsaved approvals', async t => {
  for (const [output, status, accepted, rejected] of [
    [legacy, 'classified', 1, 0],
    [{ ...legacy, outcome: 'empty' }, 'classified', 1, 0],
    [{ ...legacy, classification: null }, 'classified', 0, 0],
    [{ ...legacy, outcome: 'skipped' }, 'classified', 0, 0],
    [{ ...legacy, outcome: 'failed' }, 'failed', 0, 0],
    [{ ...legacy, outcome: 'failed', classificationReviewed: false }, 'failed', 0, 1],
    [legacy, 'processing', 0, 0],
  ] as const) {
    const f = fixture('membership_features', output, status);
    t.after(() => f.db.destroy());
    const result = await f.repo.listTagJobResults({ jobId: 1n, limit: 10 });
    assert.equal(result.items[0]?.acceptedCount, accepted);
    assert.equal(result.items[0]?.rejectedCount, rejected);
  }
  const tags = fixture('tag_extraction', legacy);
  t.after(() => tags.db.destroy());
  const result = await tags.repo.listTagJobResults({ jobId: 1n, limit: 10 });
  assert.equal(result.items[0]?.acceptedCount, 7);
  assert.equal(result.items[0]?.rejectedCount, 1);
});

test('feature batch audits expose the proposed kind and false classification verdict while preserving legacy fields', async t => {
  const f = fixture('membership_features', legacy, 'classified', [
    { id: 10n, reference_snapshot: null, request_estimate: null, response_diagnostic: null,
      validated_decision: { items: [{ productId: '2', membershipKind: 'rental', tags: legacy.acceptedTags, rejectedTags: [] }] } },
    { id: 11n, reference_snapshot: { tagStage: 'review', extractionBatchId: '10' }, request_estimate: null, response_diagnostic: null,
      validated_decision: { items: [{ productId: '2', membershipKind: 'rental', classificationReviewed: false, reviewDecisions: [true, false] }] } },
  ]);
  t.after(() => f.db.destroy());
  const audit = await f.repo.tagProductAudit(1n, 2n);
  assert.equal(audit.batches[0].proposed_membership_kind, 'rental');
  assert.equal(audit.batches[0].classification_decision, null);
  assert.equal(audit.batches[0].classification_feedback, null);
  assert.equal(audit.batches[0].proposals.length, 7);
  assert.equal(audit.batches[1].proposed_membership_kind, 'rental');
  assert.equal(audit.batches[1].classification_decision, false);
  assert.equal(audit.batches[1].classification_feedback, null);
  assert.deepEqual(audit.batches[1].review_decisions, [true, false]);
  assert.deepEqual(audit.member.output, legacy);
});

test('feature audits expose durable diagnostic refs and the shared repair round without changing the proposal', async t => {
  const feedback = { classificationDecision: false, code: 'delivery_mismatch', refs: [0, 2] };
  const f = fixture('membership_features', { ...legacy, review: {
    mode: 'membership_binary', decision: false, code: 'delivery_mismatch', refs: [0, 2],
  } }, 'failed', [
    { id: 10n, reference_snapshot: { tagStage: 'review', extractionBatchId: '9' }, request_estimate: null, response_diagnostic: null,
      validated_decision: { items: [{ productId: '2', membershipKind: 'rental', membershipRefs: [0],
        reviewed: true, classificationReviewed: false, membershipReview: feedback, tags: [], rejectedTags: [] }] } },
    { id: 11n, reference_snapshot: { tagStage: 'repair', repairReviewBatchId: '10', reviewRepairRound: 1 },
      request_estimate: null, response_diagnostic: null, validated_decision: { items: [{
        productId: '2', membershipKind: 'account', membershipRefs: [2], tags: [], rejectedTags: [],
      }] } },
    { id: 12n, reference_snapshot: { tagStage: 'review', extractionBatchId: '11', repairReviewBatchId: '10', reviewRepairRound: 1 },
      request_estimate: null, response_diagnostic: null, validated_decision: { items: [{
        productId: '2', membershipKind: 'account', membershipRefs: [2], reviewed: true, classificationReviewed: true,
        membershipReview: { classificationDecision: true, code: null, refs: [] }, tags: [], rejectedTags: [],
      }] } },
    { id: 13n, reference_snapshot: { tagStage: 'repair', tagRepairRound: 1 },
      request_estimate: null, response_diagnostic: null, validated_decision: null },
  ]);
  t.after(() => f.db.destroy());
  const audit = await f.repo.tagProductAudit(1n, 2n);
  assert.equal(audit.batches[0].proposed_membership_kind, 'rental');
  assert.deepEqual(audit.batches[0].classification_feedback, feedback);
  assert.equal(audit.batches[1].proposed_membership_kind, 'account');
  assert.equal(audit.batches[1].classification_feedback, null);
  assert.deepEqual(audit.batches[2].classification_feedback, { classificationDecision: true, code: null, refs: [] });
  assert.deepEqual(audit.batches.map((batch: { tagRepairRound: number }) => batch.tagRepairRound), [0, 1, 1, 1]);
  assert.deepEqual(audit.member.output.review, { mode: 'membership_binary', decision: false, code: 'delivery_mismatch', refs: [0, 2] });
});
