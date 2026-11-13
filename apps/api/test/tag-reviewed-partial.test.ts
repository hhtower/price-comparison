import assert from 'node:assert/strict';
import test from 'node:test';
import * as results from '../src/ai/tag-extraction-result.js';
import type { TagExtractionDecision, TagExtractionTag, TagFact } from '../src/ai/tag-extraction-result.js';

const tag = (name: string, value: TagFact['value'], proposalIndex = 0): TagExtractionTag => ({
  name, value, proposalIndex, evidence: [],
});
const reject = (fact: TagExtractionTag) => ({ ...fact, reasonCode: 'review_rejected', reason: 'LLM 对该标签判定为否' });
const decision = (tags: TagExtractionTag[], rejectedTags: ReturnType<typeof reject>[] = [], complete = true): TagExtractionDecision =>
  results.validateReviewedTagExtractionDecision(1n, tags, rejectedTags, {}, undefined, complete);

test('partial success replaces a valid single value and retains the failed dimension', () => {
  const result = results.buildTagExtractionOutcome(decision([tag('duration', 30)], [reject(tag('region', 'jp'))]),
    [{ name: 'duration', value: 7 }, { name: 'region', value: 'us' }]);
  assert.equal(result.outcome, 'partial_success');
  assert.equal(result.successfulCount, 1);
  assert.equal(result.failedCount, 1);
  assert.equal(result.complete, true);
  assert.deepEqual(result.after, [{ name: 'duration', value: 30 }, { name: 'region', value: 'us' }]);
  assert.deepEqual(result.diff, [{ name: 'duration', before: [7], after: [30] }]);
});

test('incomplete results retain unmentioned facts and accumulate successful multivalues', () => {
  const result = results.buildTagExtractionOutcome(decision([tag('duration', 30), tag('region', 'jp')], [], false),
    [{ name: 'duration', value: 7 }, { name: 'region', value: 'us' }, { name: 'sms_verification', value: 'verified' }]);
  assert.equal(result.outcome, 'partial_success');
  assert.equal(result.complete, false);
  assert.equal(result.failedCount, 0);
  assert.deepEqual(result.after, [
    { name: 'duration', value: 30 }, { name: 'region', value: 'jp' },
    { name: 'region', value: 'us' }, { name: 'sms_verification', value: 'verified' },
  ]);
});

test('a failed multivalue retains old facts alongside successes without duplicates', () => {
  const result = results.buildTagExtractionOutcome(decision([tag('region', 'jp')], [reject(tag('region', 'ca'))]),
    [{ name: 'region', value: 'us' }, { name: 'region', value: 'jp' }]);
  assert.deepEqual(result.after, [{ name: 'region', value: 'jp' }, { name: 'region', value: 'us' }]);
  assert.equal(result.outcome, 'partial_success');
});

test('complete multivalues replace old values and complete empty results can clear them', () => {
  const before = [{ name: 'region', value: 'us' }];
  const replaced = results.buildTagExtractionOutcome(decision([tag('region', 'jp')]), before);
  assert.deepEqual(replaced.after, [{ name: 'region', value: 'jp' }]);
  assert.equal(replaced.outcome, 'updated');
  const empty = results.buildTagExtractionOutcome(decision([]), before);
  assert.deepEqual(empty.after, []);
  assert.equal(empty.outcome, 'empty');
  assert.deepEqual(empty.diff, [{ name: 'region', before: ['us'], after: [] }]);
});

test('pure failure or incomplete empty results cannot delete any existing fact', () => {
  const before = [{ name: 'duration', value: 7 }, { name: 'region', value: 'us' }];
  for (const candidate of [decision([], [reject(tag('duration', 30))]), decision([], [], false)]) {
    const result = results.buildTagExtractionOutcome(candidate, before);
    assert.deepEqual(result.after, before);
    assert.deepEqual(result.diff, []);
    assert.equal(result.outcome, 'failed');
    assert.equal(result.successfulCount, 0);
  }
});

test('an unknown rejected name prevents deletion of unmentioned existing dimensions', () => {
  const result = results.buildTagExtractionOutcome(decision([tag('duration', 30)], [reject(tag('unknown', 'yes'))]),
    [{ name: 'duration', value: 7 }, { name: 'region', value: 'us' }]);
  assert.deepEqual(result.after, [{ name: 'duration', value: 30 }, { name: 'region', value: 'us' }]);
});

test('a failed single-value candidate does not block an independently accepted replacement', () => {
  const result = results.buildTagExtractionOutcome(decision([tag('duration', 30)], [reject(tag('duration', 90))]),
    [{ name: 'duration', value: 7 }]);
  assert.deepEqual(result.after, [{ name: 'duration', value: 30 }]);
  assert.equal(result.outcome, 'partial_success');
});

test('terminal results keep existing data even when a successful replacement was proposed', () => {
  const before = [{ name: 'duration', value: 7 }];
  for (const outcome of ['failed', 'cancelled', 'skipped'] as const) {
    const result = results.buildTagExtractionOutcome(decision([tag('duration', 30)]), before, { outcome, reasonCode: 'terminal' });
    assert.equal(result.outcome, outcome);
    assert.deepEqual(result.after, before);
    assert.deepEqual(result.diff, []);
  }
});

test('repair preserves earlier success, resolves corrected failures and records both rounds', () => {
  const previous = results.validateReviewedTagExtractionDecision(1n, [tag('duration', 30, 0)],
    [reject(tag('region', 'us', 1))], {}, [true, false], false);
  const current = results.validateReviewedTagExtractionDecision(1n, [tag('region', 'jp', 0)], [], {}, [true], true);
  assert.equal(typeof results.mergeTagExtractionDecision, 'function');
  const merged = results.mergeTagExtractionDecision(previous, current);
  assert.deepEqual(merged.tags.map(item => [item.name, item.value, item.proposalIndex]), [
    ['duration', 30, 0], ['region', 'jp', 1],
  ]);
  assert.deepEqual(merged.rejectedTags, []);
  assert.deepEqual(merged.reviewDecisions, [true, true]);
  assert.equal(merged.complete, true);
  assert.deepEqual(merged.attempts, [
    { round: 1, tags: previous.tags, rejectedTags: previous.rejectedTags, complete: false, reviewDecisions: [true, false] },
    { round: 2, tags: current.tags, rejectedTags: [], complete: true, reviewDecisions: [true] },
  ]);
  assert.deepEqual(results.buildTagExtractionOutcome(merged, []).attempts, merged.attempts);
  assert.deepEqual(previous.reviewDecisions, [true, false]);
});

test('repair cannot replace a previously approved single value and same facts deduplicate', () => {
  const previous = results.validateReviewedTagExtractionDecision(1n, [tag('duration', 30, 0), tag('region', 'us', 1)], [], {}, [true, true], false);
  const current = results.validateReviewedTagExtractionDecision(1n, [tag('duration', 90, 0), tag('region', 'us', 1)],
    [reject(tag('sms_verification', 'verified', 2))], {}, [true, true, false]);
  assert.equal(typeof results.mergeTagExtractionDecision, 'function');
  const merged = results.mergeTagExtractionDecision(previous, current);
  assert.deepEqual(merged.tags.map(item => [item.name, item.value]), [['duration', 30], ['region', 'us']]);
  assert.deepEqual(merged.rejectedTags.map(item => [item.name, item.reasonCode]), [
    ['sms_verification', 'review_rejected'], ['duration', 'tag_single_value_conflict'],
  ]);
  assert.deepEqual(merged.reviewDecisions, [true, true, false, true]);
  assert.deepEqual([...merged.tags, ...merged.rejectedTags].map(item => item.proposalIndex), [0, 1, 2, 3]);
  const published = results.validateReviewedTagExtractionDecision(1n, merged.tags, merged.rejectedTags, {}, merged.reviewDecisions, merged.complete);
  assert.deepEqual(published.tags, merged.tags);
  assert.deepEqual(published.rejectedTags, merged.rejectedTags);
  assert.deepEqual(published.reviewDecisions, [true, true, false, true]);
  const conflict = published.rejectedTags.find(item => item.reasonCode === 'tag_single_value_conflict')!;
  assert.equal(published.reviewDecisions?.[conflict.proposalIndex!], true);
});

test('unresolved earlier failures survive a repair in another dimension', () => {
  const previous = decision([tag('duration', 30)], [reject(tag('region', 'us'))], false);
  const current = decision([tag('supported_client', 'codex')]);
  assert.equal(typeof results.mergeTagExtractionDecision, 'function');
  const result = results.buildTagExtractionOutcome(results.mergeTagExtractionDecision(previous, current), [{ name: 'region', value: 'jp' }]);
  assert.equal(result.outcome, 'partial_success');
  assert.equal(result.failedCount, 1);
  assert.ok(result.after.some(fact => fact.name === 'region' && fact.value === 'jp'));
});

test('merging different products fails instead of transferring facts', () => {
  assert.equal(typeof results.mergeTagExtractionDecision, 'function');
  assert.throws(() => results.mergeTagExtractionDecision(decision([]), { ...decision([]), productId: 2n }));
});

test('repair is needed for missing or rejected facts but not harmless duplicate proposals', () => {
  assert.equal(typeof results.needsTagRepair, 'function');
  assert.equal(results.needsTagRepair(decision([])), false);
  assert.equal(results.needsTagRepair(decision([], [], false)), true);
  assert.equal(results.needsTagRepair(decision([], [reject(tag('region', 'us'))])), true);
  assert.equal(results.needsTagRepair(decision([tag('region', 'us'), tag('region', 'us')])), false);
});

test('a repeated failed repair retains the latest program rejection and its true model vote', () => {
  const previous = results.validateReviewedTagExtractionDecision(1n, [], [reject(tag('unknown', 'yes', 0))], {}, [false]);
  const current = results.validateReviewedTagExtractionDecision(1n, [tag('unknown', 'yes', 0)], [], {}, [true]);
  const merged = results.mergeTagExtractionDecision(previous, current);
  assert.deepEqual(merged.rejectedTags.map(item => item.reasonCode), ['tag_name_unknown']);
  assert.deepEqual(merged.reviewDecisions, [true]);
  assert.deepEqual(merged.attempts?.map(attempt => attempt.reviewDecisions), [[false], [true]]);
});

test('two full rounds keep every final candidate index and vote without audit truncation', () => {
  const round = (prefix: string) => results.validateReviewedTagExtractionDecision(1n,
    Array.from({ length: 100 }, (_, index) => tag('supported_client', `${prefix}${index}`, index)), [], {}, Array(100).fill(true));
  const merged = results.mergeTagExtractionDecision(round('first'), round('second'));
  const published = results.validateReviewedTagExtractionDecision(1n, merged.tags, merged.rejectedTags, {}, merged.reviewDecisions, merged.complete);
  assert.equal(published.tags.length, 200);
  assert.equal(published.tags.at(-1)?.proposalIndex, 199);
  const audit = results.buildTagExtractionOutcome(merged, []);
  assert.equal(audit.acceptedTags.length, 200);
  assert.equal(audit.review?.mode, 'per_tag_binary');
  assert.equal(audit.review?.mode === 'per_tag_binary' && audit.review.decisions?.length, 200);
  assert.equal(audit.attempts?.[0]?.tags.length, 100);
  assert.equal(audit.attempts?.[1]?.tags.length, 100);
  assert.throws(() => results.validateReviewedTagExtractionDecision(1n,
    [...published.tags, tag('supported_client', 'overflow', 200)], [], {}, Array(201).fill(true)));
});

test('repair attempts redact rejected credentials without mutating the original snapshot', () => {
  const previous = decision([], [reject(tag('unknown', 'password=hidden'))], false);
  const merged = results.mergeTagExtractionDecision(previous, decision([tag('duration', 30)]));
  const audit = results.buildTagExtractionOutcome(merged, []);
  assert.equal(audit.attempts?.[0]?.rejectedTags[0]?.value, 'password=[redacted]');
  assert.equal(merged.attempts?.[0]?.rejectedTags[0]?.value, 'password=hidden');
  assert.ok(!JSON.stringify(audit).includes('hidden'));
});
