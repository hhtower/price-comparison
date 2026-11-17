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

test('full repair replaces approved duration and withdraws approved clients while retaining both feedback audits', () => {
  const previous = { ...results.validateReviewedTagExtractionDecision(1n, [
    tag('duration', 30, 0),
    tag('supported_client', 'codex', 1),
  ], [], {}, [true, true], false), reviewFeedback: 'Recheck the selected duration and supported clients.' };
  const current = { ...results.validateReviewedTagExtractionDecision(1n, [
    tag('supported_client', 'sub2api', 1),
    tag('duration', 90, 0),
  ], [], {}, [true, true], true), reviewFeedback: 'The selected duration and supported client are complete.' };
  const before = structuredClone({ previous, current });
  const merged = results.recordTagRepairAttempt(previous, current);
  assert.deepEqual(merged.tags, current.tags);
  assert.deepEqual(merged.rejectedTags, []);
  assert.deepEqual(merged.reviewDecisions, current.reviewDecisions);
  assert.equal(merged.reviewFeedback, current.reviewFeedback);
  assert.deepEqual(merged.attempts?.map(attempt => attempt.reviewFeedback), [previous.reviewFeedback, current.reviewFeedback]);
  const published = results.buildTagExtractionOutcome(merged, []);
  assert.deepEqual(published.after, current.tags.map(({ name, value }) => ({ name, value })));
  assert.equal(published.review?.mode === 'per_tag_binary' && published.review.feedback, current.reviewFeedback);
  assert.deepEqual(published.attempts?.map(attempt => attempt.reviewFeedback), [previous.reviewFeedback, current.reviewFeedback]);
  assert.deepEqual({ previous, current }, before);
});

test('partial success publishes only the accepted current values', () => {
  const result = results.buildTagExtractionOutcome(decision([tag('duration', 30)], [reject(tag('region', 'jp'))]),
    [{ name: 'duration', value: 7 }, { name: 'region', value: 'us' }]);
  assert.equal(result.outcome, 'partial_success');
  assert.equal(result.successfulCount, 1);
  assert.equal(result.failedCount, 1);
  assert.equal(result.complete, true);
  assert.deepEqual(result.after, [{ name: 'duration', value: 30 }]);
  assert.deepEqual(result.diff, [{ name: 'duration', before: [7], after: [30] }, { name: 'region', before: ['us'], after: [] }]);
});

test('incomplete results do not merge unmentioned persisted facts', () => {
  const result = results.buildTagExtractionOutcome(decision([tag('duration', 30), tag('region', 'jp')], [], false),
    [{ name: 'duration', value: 7 }, { name: 'region', value: 'us' }, { name: 'sms_verification', value: 'verified' }]);
  assert.equal(result.outcome, 'partial_success');
  assert.equal(result.complete, false);
  assert.equal(result.failedCount, 0);
  assert.deepEqual(result.after, [
    { name: 'duration', value: 30 }, { name: 'region', value: 'jp' },
  ]);
});

test('a failed multivalue cannot introduce other values into the accepted result', () => {
  const result = results.buildTagExtractionOutcome(decision([tag('region', 'jp')], [reject(tag('region', 'ca'))]),
    [{ name: 'region', value: 'us' }, { name: 'region', value: 'jp' }]);
  assert.deepEqual(result.after, [{ name: 'region', value: 'jp' }]);
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

test('an unknown rejected name cannot expand the accepted result', () => {
  const result = results.buildTagExtractionOutcome(decision([tag('duration', 30)], [reject(tag('unknown', 'yes'))]),
    [{ name: 'duration', value: 7 }, { name: 'region', value: 'us' }]);
  assert.deepEqual(result.after, [{ name: 'duration', value: 30 }]);
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

test('repair uses only current candidates and records both independent rounds', () => {
  const previous = results.validateReviewedTagExtractionDecision(1n, [tag('duration', 30, 0)],
    [reject(tag('region', 'us', 1))], {}, [true, false], false);
  const current = results.validateReviewedTagExtractionDecision(1n, [tag('region', 'jp', 0)], [], {}, [true], true);
  assert.equal(typeof results.recordTagRepairAttempt, 'function');
  const merged = results.recordTagRepairAttempt(previous, current);
  assert.deepEqual(merged.tags.map(item => [item.name, item.value, item.proposalIndex]), [
    ['region', 'jp', 0],
  ]);
  assert.deepEqual(merged.rejectedTags, []);
  assert.deepEqual(merged.reviewDecisions, [true]);
  assert.equal(merged.complete, true);
  assert.deepEqual(merged.attempts, [
    { round: 1, tags: previous.tags, rejectedTags: previous.rejectedTags, complete: false, reviewDecisions: [true, false] },
    { round: 2, tags: current.tags, rejectedTags: [], complete: true, reviewDecisions: [true] },
  ]);
  assert.deepEqual(results.buildTagExtractionOutcome(merged, []).attempts, merged.attempts);
  assert.deepEqual(previous.reviewDecisions, [true, false]);
});

test('repair replaces previously approved single values and keeps only current votes and indexes', () => {
  const previous = results.validateReviewedTagExtractionDecision(1n, [tag('duration', 30, 0), tag('region', 'us', 1)], [], {}, [true, true], false);
  const current = results.validateReviewedTagExtractionDecision(1n, [tag('duration', 90, 0), tag('region', 'us', 1)],
    [reject(tag('sms_verification', 'verified', 2))], {}, [true, true, false]);
  assert.equal(typeof results.recordTagRepairAttempt, 'function');
  const merged = results.recordTagRepairAttempt(previous, current);
  assert.deepEqual(merged.tags.map(item => [item.name, item.value]), [['duration', 90], ['region', 'us']]);
  assert.deepEqual(merged.rejectedTags.map(item => [item.name, item.reasonCode]), [
    ['sms_verification', 'review_rejected'],
  ]);
  assert.deepEqual(merged.reviewDecisions, [true, true, false]);
  assert.deepEqual([...merged.tags, ...merged.rejectedTags].map(item => item.proposalIndex), [0, 1, 2]);
  const published = results.validateReviewedTagExtractionDecision(1n, merged.tags, merged.rejectedTags, {}, merged.reviewDecisions, merged.complete);
  assert.deepEqual(published.tags, merged.tags);
  assert.deepEqual(published.rejectedTags, merged.rejectedTags);
  assert.deepEqual(published.reviewDecisions, [true, true, false]);
});

test('incomplete repair does not restore earlier accepted or rejected candidates', () => {
  const previous = decision([tag('duration', 30)], [reject(tag('region', 'us'))], false);
  const current = decision([tag('supported_client', 'codex')], [], false);
  assert.equal(typeof results.recordTagRepairAttempt, 'function');
  const result = results.buildTagExtractionOutcome(results.recordTagRepairAttempt(previous, current), [{ name: 'region', value: 'jp' }]);
  assert.equal(result.outcome, 'partial_success');
  assert.equal(result.failedCount, 0);
  assert.equal(result.complete, false);
  assert.deepEqual(result.after, [{ name: 'supported_client', value: 'codex' }]);
  assert.equal(result.attempts?.[0]?.rejectedTags.length, 1);
});

test('previous completeness and feedback cannot override the current review', () => {
  const previous = { ...decision([tag('region', 'us')]), reviewFeedback: '上一轮认为完整。' };
  const current = { ...decision([tag('duration', 30)], [], false), reviewFeedback: '' };
  const merged = results.recordTagRepairAttempt(previous, current);
  assert.equal(merged.complete, false);
  assert.equal(merged.reviewFeedback, '');
  assert.equal(results.needsTagRepair(merged), true);
  assert.equal(results.buildTagExtractionOutcome(merged, []).complete, false);
  assert.deepEqual(merged.tags, current.tags);
});

test('internal feedback validation only checks string shape and length', () => {
  assert.equal(results.validateReviewedTagExtractionDecision(1n, [], [], {}, [], true, '').reviewFeedback, '');
  const feedback = '不需要程序理解反馈含义。'.repeat(20);
  assert.equal(results.validateReviewedTagExtractionDecision(1n, [], [], {}, [], false, feedback).reviewFeedback, feedback);
  for (const invalid of [null, 1, {}, 'x'.repeat(1001)]) {
    assert.throws(() => results.validateReviewedTagExtractionDecision(1n, [], [], {}, [], true, invalid as string));
  }
});

test('a complete correction resolves withdrawn candidates but preserves their original audit', () => {
  const previous = results.validateReviewedTagExtractionDecision(1n, [tag('bulk_purchase', 'supported', 0)],
    [reject(tag('supported_client', 'codex', 1))], {}, [true, false], true);
  const current = results.validateReviewedTagExtractionDecision(1n, [], [], {}, [], true);
  const merged = results.recordTagRepairAttempt(previous, current);
  const outcome = results.buildTagExtractionOutcome(merged, []);
  assert.deepEqual(merged.tags, []);
  assert.deepEqual(merged.rejectedTags, []);
  assert.deepEqual(merged.reviewDecisions, []);
  assert.equal(outcome.outcome, 'empty');
  assert.equal(outcome.failedCount, 0);
  assert.deepEqual(merged.attempts?.[0]?.rejectedTags, previous.rejectedTags);
  assert.deepEqual(merged.attempts?.[1]?.reviewDecisions, []);
});

test('confirmed complete empty correction can finish successfully after all candidates were withdrawn', () => {
  const previous = decision([], [reject(tag('supported_client', 'codex'))], false);
  const result = results.buildTagExtractionOutcome(results.recordTagRepairAttempt(previous, decision([])), []);
  assert.equal(result.outcome, 'empty');
  assert.equal(result.failedCount, 0);
  assert.equal(result.attempts?.[0]?.rejectedTags.length, 1);
});

test('merging different products fails instead of transferring facts', () => {
  assert.equal(typeof results.recordTagRepairAttempt, 'function');
  assert.throws(() => results.recordTagRepairAttempt(decision([]), { ...decision([]), productId: 2n }));
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
  const merged = results.recordTagRepairAttempt(previous, current);
  assert.deepEqual(merged.rejectedTags.map(item => item.reasonCode), ['tag_name_unknown']);
  assert.deepEqual(merged.reviewDecisions, [true]);
  assert.deepEqual(merged.attempts?.map(attempt => attempt.reviewDecisions), [[false], [true]]);
});

test('two full rounds keep every final candidate index and vote without audit truncation', () => {
  const round = (prefix: string) => results.validateReviewedTagExtractionDecision(1n,
    Array.from({ length: 100 }, (_, index) => tag('supported_client', `${prefix}${index}`, index)), [], {}, Array(100).fill(true));
  const merged = results.recordTagRepairAttempt(round('first'), round('second'));
  const published = results.validateReviewedTagExtractionDecision(1n, merged.tags, merged.rejectedTags, {}, merged.reviewDecisions, merged.complete);
  assert.equal(published.tags.length, 100);
  assert.equal(published.tags.at(-1)?.proposalIndex, 99);
  const audit = results.buildTagExtractionOutcome(merged, []);
  assert.equal(audit.acceptedTags.length, 100);
  assert.equal(audit.review?.mode, 'per_tag_binary');
  assert.equal(audit.review?.mode === 'per_tag_binary' && audit.review.decisions?.length, 100);
  assert.equal(audit.attempts?.[0]?.tags.length, 100);
  assert.equal(audit.attempts?.[1]?.tags.length, 100);
  assert.throws(() => results.validateReviewedTagExtractionDecision(1n,
    [...published.tags, tag('supported_client', 'overflow', 100)], [], {}, Array(101).fill(true)));
});

test('repair attempts redact rejected credentials without mutating the original snapshot', () => {
  const previous = { ...decision([], [reject(tag('unknown', 'password=hidden'))], false), reviewFeedback: 'password=old-secret' };
  const merged = results.recordTagRepairAttempt(previous, { ...decision([tag('duration', 30)]), reviewFeedback: 'password=new-secret' });
  const audit = results.buildTagExtractionOutcome(merged, []);
  assert.equal(audit.attempts?.[0]?.rejectedTags[0]?.value, 'password=[redacted]');
  assert.equal(merged.attempts?.[0]?.rejectedTags[0]?.value, 'password=hidden');
  assert.ok(!JSON.stringify(audit).includes('hidden'));
  assert.ok(!JSON.stringify(audit).includes('old-secret'));
  assert.ok(!JSON.stringify(audit).includes('new-secret'));
  assert.equal(merged.reviewFeedback, 'password=new-secret');
});
