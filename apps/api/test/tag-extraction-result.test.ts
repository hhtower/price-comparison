import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateReviewedTagExtractionDecision, buildTagExtractionOutcome } from '../src/ai/tag-extraction-result.js';

test('mocked rejection retains the candidate and sanitizes its audit evidence', () => {
  const decision = validateReviewedTagExtractionDecision(1n, [
    { name: 'duration', value: 30, proposalIndex: 0, evidence: [] },
  ], [
    { name: 'warranty', value: 'password=hidden', proposalIndex: 1,
      evidence: [{ path: 'sourceData.note', quote: 'password=hidden' }], reasonCode: 'review_rejected', reason: '' },
  ], {}, [true, false], true);
  assert.equal(decision.tags.length, 1);
  assert.equal(decision.rejectedTags.length, 1);
  const result = buildTagExtractionOutcome(decision, []);
  assert.equal(result.rejectedTags[0]?.evidence[0]?.quote, 'password=[redacted]');
  assert.equal(result.rejectedTags[0]?.reasonCode, 'review_rejected');
  assert.equal(result.outcome, 'partial_success');
  assert.equal(result.successfulCount, 1);
  assert.equal(result.failedCount, 1);
  assert.deepEqual(result.review, { mode: 'per_tag_binary', decisions: [true, false] });
});

test('complete results replace facts while failed results preserve existing facts', () => {
  const decision = validateReviewedTagExtractionDecision(1n, [
    { name: 'duration', value: 30, proposalIndex: 0, evidence: [] },
  ], [], {}, [true], true);
  const before = [{ name: 'duration', value: 30 }, { name: 'region', value: 'us' }];
  const unchanged = buildTagExtractionOutcome(decision, before);
  assert.equal(unchanged.outcome, 'updated');
  assert.deepEqual(unchanged.after, [before[0]]);
  assert.equal('retainedUnconfirmed' in unchanged, false);
  const updated = buildTagExtractionOutcome(decision, [{ name: 'duration', value: 365 }]);
  assert.equal(updated.outcome, 'updated');
  assert.equal(updated.diff.length, 1);
  const empty = buildTagExtractionOutcome(validateReviewedTagExtractionDecision(1n, [], [], {}, [], true), before);
  assert.equal(empty.outcome, 'empty');
  assert.deepEqual(empty.after, []);
  assert.equal(empty.diff.length, 2);
  const rejected = validateReviewedTagExtractionDecision(1n, [], [
    { name: 'region', value: 'jp', proposalIndex: 0, evidence: [], reasonCode: 'review_rejected', reason: '' },
  ], {}, [false], true);
  const failed = buildTagExtractionOutcome(rejected, before);
  assert.equal(failed.outcome, 'failed');
  assert.deepEqual(failed.after, before);
  assert.deepEqual(failed.diff, []);
});

test('all retained audit strings and arrays are bounded and redacted', () => {
  const before = Array.from({length: 300}, () => ({name:'password=hidden',value:'Bearer private'}));
  const audit=buildTagExtractionOutcome({productId:1n,tags:[],rejectedTags:[]},before,{outcome:'skipped',reasonCode:'password=hidden'});
  assert.equal(audit.before.length,256);
  assert.equal(audit.before[0]?.value,'Bearer [redacted]');
  assert.equal(audit.after[0]?.name,'password=[redacted]');
  assert.equal(audit.reasonCode,'password=[redacted]');
  assert.ok(!JSON.stringify(audit).includes('hidden'));
});

test('quoted JSON credentials are redacted throughout accepted, rejected and diff audits',()=>{
  const secret='{"password":"hidden","api_key":"private","secret":"has spaces"}';
  const tag={name:'duration',value:secret,evidence:[{path:'spec',quote:secret}]};
  const output=buildTagExtractionOutcome({productId:1n,tags:[tag],rejectedTags:[{...tag,reason:secret,reasonCode:'invalid'}]},[{name:'duration',value:'{"access_token":"before-secret"}'}]);
  for(const field of [output.acceptedTags,output.rejectedTags,output.before,output.after,output.diff]) {
    const text=JSON.stringify(field);
    for(const value of ['hidden','private','has spaces','before-secret']) assert.ok(!text.includes(value),text);
    assert.ok(text.includes('[redacted]'));
  }
});

test('feature audit records a single classification verdict without per-tag or text review', () => {
  for (const classificationReviewed of [true, false]) {
    const audit = buildTagExtractionOutcome({
      productId: 1n, membershipKind: 'short_term', tags: [], rejectedTags: [], reviewed: true, classificationReviewed,
    }, []);
    assert.deepEqual(audit.review, { mode: 'membership_binary', decision: classificationReviewed });
    assert.equal(audit.textReview, undefined);
  }
});
