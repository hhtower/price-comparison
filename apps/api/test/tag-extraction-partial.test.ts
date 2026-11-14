import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTagExtractionResponse } from '../src/ai/tag-extraction-request.js';
import { validateReviewedTagExtractionDecision } from '../src/ai/tag-extraction-result.js';
import type { TagValue } from '@price-comparison/catalog/purchase-attributes';

const tag = (name: string, value: TagValue, proposalIndex: number) => ({ name, value, proposalIndex, evidence: [] });

test('reviewed candidates retain per-tag vocabulary and numeric rejection diagnostics', () => {
  const result = validateReviewedTagExtractionDecision(1n, [tag('duration', 30, 0), tag('invented', 'yes', 1),
    tag('subscription_override', '有', 2), tag('duration', 0, 3)], [], {}, [true, true, true, true]);
  assert.deepEqual(result.tags.map(t => [t.name, t.value]), [['duration', 30]]);
  assert.deepEqual(result.rejectedTags.map(t => t.reasonCode), ['tag_name_unknown', 'tag_value_invalid', 'tag_value_invalid']);
});

test('duplicates and conflicting single values are rejected while multiple regions survive', () => {
  const duration = tag('duration', 30, 0);
  const result = validateReviewedTagExtractionDecision(1n, [duration, tag('duration', 30, 1),
    tag('sms_verification', 'verified', 2), tag('sms_verification', 'unverified', 3)], [], {}, [true, true, true, true]);
  assert.deepEqual(result.tags, [duration]);
  assert.deepEqual(result.rejectedTags.map(t => t.reasonCode).sort(), ['tag_duplicate', 'tag_single_value_conflict', 'tag_single_value_conflict']);
  const regions = [tag('region', 'us', 0), tag('region', 'jp', 1)];
  assert.deepEqual(validateReviewedTagExtractionDecision(1n, regions, [], {}, [true, true]).tags, regions);
});

test('a rejected occurrence cannot hide a later approved occurrence of the same fact', () => {
  const approved = tag('duration', 30, 1);
  const rejected = { ...tag('duration', 30, 0), reasonCode: 'review_rejected', reason: '模拟复核拒绝该标签' };
  const result = validateReviewedTagExtractionDecision(1n, [approved], [rejected], {}, [false, true]);
  assert.deepEqual(result.tags, [approved]);
  assert.deepEqual(result.rejectedTags, [rejected]);
  assert.deepEqual(result.reviewDecisions, [false, true]);
});

test('closed name-value protocol rejects structural corruption and oversized responses', () => {
  const fact = { name: 'duration', value: 30 };
  assert.deepEqual(parseTagExtractionResponse(JSON.stringify({ items: [{ id: '1', tags: [fact] }] })).items[0]!.tags, [fact]);
  for (const items of [
    [{ id: '1', tags: [fact], extra: true }], [{ id: '1', tags: [{ ...fact, extra: true }] }],
    [{ id: '1', tags: [] }, { id: '1', tags: [] }], [{ id: '0', tags: [] }],
    [{ id: '1', tags: Array(101).fill(fact) }], [{ id: '1', tags: [{ ...fact, path: 'spec', quote: '1个月' }] }],
    [{ id: '1', tags: [{ ...fact, evidence: [] }] }], [{ id: '1', tags: [{ ...fact, value: { kind: 'range', min: 1 } }] }],
  ]) assert.throws(() => parseTagExtractionResponse(JSON.stringify({ items })));
  assert.throws(() => parseTagExtractionResponse('{"items":'));
});

test('100 approved duplicate candidates preserve all model votes and only one accepted fact', () => {
  const proposed = Array.from({ length: 100 }, (_, index) => tag('supported_client', 'codex', index));
  const result = validateReviewedTagExtractionDecision(1n, proposed, [], {}, Array(100).fill(true));
  assert.equal(result.tags.length, 1);
  assert.equal(result.rejectedTags.length, 99);
  assert.ok(result.rejectedTags.every(item => item.reasonCode === 'tag_duplicate'));
  assert.deepEqual(result.reviewDecisions, Array(100).fill(true));
});
