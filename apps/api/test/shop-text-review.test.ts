import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readTextEvidence, validateTextReview, createTextReviewAccumulator, prepareTextReview, TEXT_REVIEW_VERSION, type ProductReviewRow } from '../src/shops/shop-text-review.js';

const text = { unitId: 'item', name: '月度套餐', description: '交付账号。服务一个月。', hash: 'a'.repeat(64) };
const answers = Object.fromEntries(['L1','L2','L3','R1','R2','R3','A1','A2'].map(key => [key, true]));
const consistency = Object.fromEntries(['C1','C2','C3','C4','C5','C6'].map(key => [key, false]));
const review = { answers, consistency };
const source = { url: 'https://example.test/shop', protocol: 'liandong', platform: 'test' };
const manifest = { sourceUrl: source.url, sourceProtocol: source.protocol, sourcePlatform: source.platform,
  observedAt: 100, units: [{ unitId: 'item', hash: text.hash }, { unitId: 'unknown', hash: null }] };
const stored = { version: TEXT_REVIEW_VERSION, contentVersion: '1', fingerprint: 'b'.repeat(64), source, textHash: text.hash, review };
const row = { external_id: 'item', content_version: 1n, content_fingerprint: stored.fingerprint,
  source_data: { ratingText: text }, text_review: stored };

function aggregateTextReviews(input: unknown, origin: typeof source, rows: ProductReviewRow[], now: number) {
  const accumulator = createTextReviewAccumulator(input, origin, now);
  for (const row of rows) {
    const review = prepareTextReview(row);
    if (review) accumulator?.add(review);
  }
  return accumulator?.finish() ?? null;
}

test('text review requires exactly fourteen booleans and complete captured text', () => {
  assert.deepEqual(validateTextReview(review, text), review);
  assert.throws(() => validateTextReview(null, null));
  assert.throws(() => validateTextReview(review, null));
  assert.throws(() => validateTextReview(null, text));
  assert.throws(() => validateTextReview({ ...review, answers: { L1: answers.L1 } }, text));
  for (const value of [null, 'false', 0, { value: true, reason: '旧格式', evidence: [] }]) {
    assert.throws(() => validateTextReview({ ...review, answers: { ...answers, L1: value } }, text));
    assert.throws(() => validateTextReview({ ...review, consistency: { ...consistency, C1: value } }, text));
  }
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
    answers: { ...answers, L1: false } } } };
  assert.equal(aggregateTextReviews(manifest, source, [row, conflict], 100)?.reviewed, 0);
  assert.deepEqual(aggregateTextReviews(manifest, source, [row], 86_400_100), first);
  assert.equal(aggregateTextReviews(manifest, source, [row], 99), null);
});

test('incremental text reviews keep conflicts across batches and retain only judgments', () => {
  const accumulator = createTextReviewAccumulator(manifest, source, 100)!;
  accumulator.add(prepareTextReview(row)!);
  assert.equal(accumulator.finish().reviewed, 1);
  accumulator.add(prepareTextReview({ ...row, external_id: 'duplicate' })!);
  assert.equal(accumulator.finish().reviewed, 1);
  accumulator.add(prepareTextReview({ ...row, text_review: { ...stored, review: { ...review,
    answers: { ...answers, L1: false } } } })!);
  accumulator.add(prepareTextReview(row)!);
  const result = accumulator.finish();
  assert.equal(result.reviewed, 0);
  assert.equal(result.listings[0]?.answers, null);
  assert.ok(!JSON.stringify(result).includes('evidence'));
  assert.ok(createTextReviewAccumulator(manifest, source, 86_400_100));
});

test('prepared reviews retain only validated judgments and recheck the live manifest and source', () => {
  const prepared = prepareTextReview(row)!;
  assert.ok(prepared);
  assert.ok(!JSON.stringify(prepared).includes('description'));
  assert.ok(!JSON.stringify(prepared).includes('evidence'));
  const accumulator = createTextReviewAccumulator(manifest, source, 100)!;
  accumulator.add(prepared);
  assert.deepEqual(accumulator.finish(), aggregateTextReviews(manifest, source, [row], 100));
  const changedSource = createTextReviewAccumulator({ ...manifest, sourceUrl: 'https://changed.invalid' },
    { ...source, url: 'https://changed.invalid' }, 100)!;
  changedSource.add(prepared);
  assert.equal(changedSource.finish().reviewed, 0);
  const changedManifest = createTextReviewAccumulator({
    ...manifest, units: [{ unitId: text.unitId, hash: 'c'.repeat(64) }],
  }, source, 100)!;
  changedManifest.add(prepared);
  assert.equal(changedManifest.finish().reviewed, 0);
  assert.equal(prepareTextReview({ ...row, content_version: 2n }), null);
  assert.equal(prepareTextReview({ ...row, content_fingerprint: 'changed' }), null);
  assert.equal(prepareTextReview({ ...row, text_review: { ...stored, review: {
    ...review, answers: { ...answers, L1: null },
  } } }), null);
  assert.equal(prepareTextReview({ ...row, text_review: { ...stored, version: 'shop-title-body-20261027-v1' } }), null);
});
