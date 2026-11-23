import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { TagExtractionDecision } from '../src/ai/tag-extraction-result.js';
import { jsonb, type DatabaseSchema, type JsonValue } from '../src/database/types.js';

// Publication tests start at a durable checkpoint; executor tests exercise its creation.
export async function seedAttributePublication(
  db: Kysely<DatabaseSchema>, batchId: bigint, items: readonly TagExtractionDecision[],
) {
  const batch = await db.selectFrom('ai_job_batches as b').innerJoin('ai_jobs as j', 'j.id', 'b.job_id')
    .select(['b.reference_snapshot', 'j.job_type']).where('b.id', '=', batchId).executeTakeFirstOrThrow();
  const document = { items: items.map(item => ({ ...item, productId: String(item.productId) })) };
  await db.updateTable('ai_job_batches').set({
    step: 'publish',
    validated_decision: jsonb(document as unknown as JsonValue),
    decision_hash: createHash('sha256').update(JSON.stringify(document)).digest('hex'),
    decision_saved_at: new Date(),
    reference_snapshot: jsonb({ ...(batch.reference_snapshot as Record<string, JsonValue> | null),
      reviewStage: batch.job_type === 'text_review' ? 'generate' : 'review' }),
    request_budget_used: 1, confirmed_requests: 1, unknown_requests: 0,
  }).where('id', '=', batchId).execute();
}
