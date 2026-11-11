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
  assert.equal(audit.batches[0].proposals.length, 7);
  assert.equal(audit.batches[1].proposed_membership_kind, 'rental');
  assert.equal(audit.batches[1].classification_decision, false);
  assert.deepEqual(audit.batches[1].review_decisions, [true, false]);
  assert.deepEqual(audit.member.output, legacy);
});
