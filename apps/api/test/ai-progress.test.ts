import assert from 'node:assert/strict';
import test from 'node:test';
import { recordAiTiming } from '../src/observability/ai-metrics.js';
import { MetricsRegistry } from '../src/observability/metrics.js';
import { extractionProgressDelta, progressSnapshotFromRow } from '../src/ai/ai-progress.repository.js';

test('AI timing writes bounded Redis hash counters and 48h expiry', async () => {
  const calls: string[] = [];
  const redis = {
    async hincrby(key: string, field: string, value: number) { calls.push(`h:${key}:${field}:${value}`); },
    async expire(key: string, seconds: number) { calls.push(`e:${key}:${seconds}`); },
  };
  await recordAiTiming(redis, { stage: 'standardization', workerId: 'w1', queueWaitMs: 12, firstContentMs: 34, responseMs: 56, inputBytes: 100, outputBytes: 20, retryClass: 'network', jobId: 1n });
  assert.ok(calls.some((line) => line.includes(':count:1')));
  assert.ok(calls.some((line) => line.includes(':retry_network:1')));
  assert.ok(calls.some((line) => line.endsWith(':172800')));
  assert.equal(calls.some((line) => line.includes('api_key') || line.includes('prompt')), false);
});

test('missing Redis is a no-op', async () => {
  await recordAiTiming(undefined, { stage: 'standardization', queueWaitMs: 0, firstContentMs: null, responseMs: 1, inputBytes: 0, outputBytes: 0, retryClass: null });
});

test('local metrics still receive AI timing when Redis is unavailable', async () => {
  const metrics = new MetricsRegistry();
  await recordAiTiming(undefined, { stage: 'standardization', queueWaitMs: 12, firstContentMs: 34, responseMs: 56, inputBytes: 100, outputBytes: 20, retryClass: 'network' }, undefined, metrics);
  assert.deepEqual(metrics.snapshot().standardization, {
    standardizationPlanningMs: 0,
    aiQueueWaitMs: 12,
    aiFirstContentMs: 34,
    aiResponseMs: 56,
    aiRetryTotal: 1,
  });
});

test('extraction progress moves expanded products for cache, oversized, claim and completion', () => {
  assert.deepEqual(extractionProgressDelta('initialize', 5), { queued: 5 });
  assert.deepEqual(extractionProgressDelta('cached', 2), { queued: -2, processed: 2, succeeded: 2 });
  assert.deepEqual(extractionProgressDelta('oversized', 2), { queued: -2, failed: 2 });
  assert.deepEqual(extractionProgressDelta('claimed', 3), { queued: -3, running: 3 });
  assert.deepEqual(extractionProgressDelta('succeeded', 3), { running: -3, processed: 3, succeeded: 3 });
  assert.deepEqual(extractionProgressDelta('retry', 3), { running: -3, queued: 3, failed: -3 });
  assert.deepEqual(extractionProgressDelta('failed', 3), { running: -3, failed: 3 });
});

test('progress snapshot reports request, publication and terminal result dimensions', () => {
  const snapshot = progressSnapshotFromRow({
    job_id: 9n, version: 4n, phase: 'standardizing', status: 'running', total: 12n,
    queued: 2n, running: 3n, processed: 7n, succeeded: 6n, failed: 1n, unique_input_count: 8,
    batch_total: 3, batch_queued: 1, batch_running: 1, batch_succeeded: 1,
    confirmed_requests: 2, unknown_requests: 1, request_budget_used: 3, request_budget_limit: 5,
    unit_total: 4, unit_queued: 1, unit_running: 1, unit_succeeded: 2, published_members: 6, pending_members: 4,
    classified: 6, unclassified: 2, standard_products: 3, reason_counts: { missing_id: 1, input_too_large: 1 },
    scheduled_missing: 1, reprocessed_missing: 1, updated_at: new Date('2026-09-20T00:00:00.000Z'),
  });
  assert.equal(snapshot.rawProductCount, 12);
  assert.equal(snapshot.uniqueInputCount, 8);
  assert.deepEqual(snapshot.requests, { totalBatches: 3, queuedBatches: 1, runningBatches: 1, succeededBatches: 1, failedBatches: 0, cancelledBatches: 0, confirmed: 2, unknown: 1, budgetUsed: 3, budgetLimit: 5 });
  assert.equal(snapshot.publication.publishedMembers, 6);
  assert.deepEqual(snapshot.results.unclassifiedReasons, { missing_id: 1, input_too_large: 1 });
  assert.deepEqual(snapshot.missing, { scheduledInputs: 1, reprocessedInputs: 1 });
});

test('progress snapshot does not count failed inputs as failed request batches', () => {
  for (const batchFailed of [0, 1]) {
    const snapshot = progressSnapshotFromRow({ job_id: 9n, status: 'failed', failed: 1n, batch_failed: batchFailed });
    assert.equal(snapshot.requests.failedBatches, batchFailed);
    assert.equal(snapshot.failed, '1');
    assert.equal(snapshot.status, 'failed');
  }
});

test('standardization stages report batch work without inventing published product results', () => {
  const snapshot = progressSnapshotFromRow({
    job_type: 'manual_full', extraction_completed: 3, review_queued: 2,
    review_running: 1, review_completed: 4, publication_queued: 5,
    batch_succeeded: 7, total: 20n,
  });
  assert.deepEqual(snapshot.standardizationStages, {
    generationCompleted: 3, reviewQueued: 2, reviewRunning: 1, reviewCompleted: 4, publicationQueued: 5,
  });
  assert.equal(snapshot.tagStages, undefined);
  assert.equal(snapshot.results.classified, 0);
  assert.equal(snapshot.publication.publishedMembers, 0);
  assert.equal(snapshot.processed, '0');
  assert.equal(progressSnapshotFromRow({ job_type: 'tag_extraction' }).standardizationStages, undefined);
});
