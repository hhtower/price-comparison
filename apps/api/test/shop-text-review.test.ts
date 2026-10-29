import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readTextEvidence, validateTextReview, createTextReviewAccumulator, TEXT_REVIEW_VERSION, type ProductReviewRow } from '../src/shops/shop-text-review.js';

const text = { unitId: 'item', name: '月度套餐', description: '交付账号。服务一个月。', hash: 'a'.repeat(64) };
const answers = Object.fromEntries(['L1','L2','L3','R1','R2','R3','A1','A2'].map(key => [key,
  { value: true, reason: '明确说明', evidence: [{ field: 'name', quote: '月度套餐' }] }]));
const consistency = Object.fromEntries(['C1','C2','C3','C4','C5','C6'].map(key => [key,
  { value: false, reason: '完整审核未见冲突', evidence: [] }]));
const review = { answers, consistency };
const source = { url: 'https://example.test/shop', protocol: 'liandong', platform: 'test' };
const manifest = { sourceUrl: source.url, sourceProtocol: source.protocol, sourcePlatform: source.platform,
  observedAt: 100, units: [{ unitId: 'item', hash: text.hash }, { unitId: 'unknown', hash: null }] };
const stored = { version: TEXT_REVIEW_VERSION, contentVersion: '1', fingerprint: 'b'.repeat(64), source, textHash: text.hash, review };
const row = { external_id: 'item', content_version: 1n, content_fingerprint: stored.fingerprint,
  source_data: { ratingText: text }, text_review: stored };

function aggregateTextReviews(input: unknown, origin: typeof source, rows: ProductReviewRow[], now: number) {
  const accumulator = createTextReviewAccumulator(input, origin, now);
  for (const row of rows) accumulator?.add(row);
  return accumulator?.finish() ?? null;
}

test('text review requires closed complete three-state judgments and real scoped quotes', () => {
  assert.deepEqual(validateTextReview(review, text), review);
  assert.equal(validateTextReview(null, null), null);
  assert.throws(() => validateTextReview(review, null));
  assert.throws(() => validateTextReview(null, text));
  assert.throws(() => validateTextReview({ ...review, answers: { L1: answers.L1 } }, text));
  assert.throws(() => validateTextReview({ ...review, answers: { ...answers, L1: { ...answers.L1, evidence: [{ field: 'name', quote: '伪造' }] } } }, text));
  assert.throws(() => validateTextReview({ ...review, consistency: { ...consistency, C1: { value: true, reason: '冲突', evidence: [] } } }, text));
  assert.deepEqual(readTextEvidence({ shopText: text }), text);
  assert.equal(readTextEvidence({ shopText: { ...text, hash: 'invalid' } }), null);
});

test('whole-source manifest preserves unknowns, deduplicates SKUs and rejects stale or conflicting reviews', () => {
  const first = aggregateTextReviews(manifest, source, [row], 100);
  assert.equal(first?.listings.length, 2);
  assert.equal(first?.reviewed, 1);
  assert.equal(first?.listings[0]?.answers?.L1, true);
  assert.equal(first?.listings[1]?.answers, null);
  assert.deepEqual(aggregateTextReviews(manifest, source, [row, { ...row, external_id: 'other-sku' }], 100), first);
  assert.equal(aggregateTextReviews(manifest, { ...source, url: 'changed' }, [row], 100), null);
  assert.equal(aggregateTextReviews(manifest, source, [{ ...row, content_version: 2n }], 100)?.reviewed, 0);
  assert.equal(aggregateTextReviews(manifest, source, [{ ...row, text_review: { ...stored, source: { ...source, protocol: 'other' } } }], 100)?.reviewed, 0);
  const conflict = { ...row, text_review: { ...stored, review: { ...review,
    answers: { ...answers, L1: { value: false, reason: '未明确', evidence: [] } } } } };
  assert.equal(aggregateTextReviews(manifest, source, [row, conflict], 100)?.reviewed, 0);
  assert.equal(aggregateTextReviews(manifest, source, [row], 86_400_100), null);
});

test('incremental text reviews keep conflicts across batches and retain only judgments', () => {
  const accumulator = createTextReviewAccumulator(manifest, source, 100)!;
  accumulator.add(row);
  assert.equal(accumulator.finish().reviewed, 1);
  accumulator.add({ ...row, external_id: 'duplicate' });
  assert.equal(accumulator.finish().reviewed, 1);
  accumulator.add({ ...row, text_review: { ...stored, review: { ...review,
    answers: { ...answers, L1: { value: false, reason: '未明确', evidence: [] } } } } });
  accumulator.add(row);
  const result = accumulator.finish();
  assert.equal(result.reviewed, 0);
  assert.equal(result.listings[0]?.answers, null);
  assert.ok(!JSON.stringify(result).includes('evidence'));
  assert.equal(createTextReviewAccumulator(manifest, source, 86_400_100), null);
});
