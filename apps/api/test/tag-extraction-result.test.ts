import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateTagExtractionDecision, buildTagExtractionOutcome } from '../src/ai/tag-extraction-result.js';

test('tag extraction retains rejected canonical facts and sanitized citations', () => {
  const decision = validateTagExtractionDecision(1n, [
    { name: 'duration', value: '1 month', evidence: [{ path: 'spec', quote: '1个月' }] },
    { name: 'renewable', value: '有', evidence: [{ path: 'sourceData.note', quote: 'password=hidden' }] },
  ], { spec: '1个月', sourceData: { note: 'password=hidden' } });
  assert.equal(decision.tags.length, 1);
  assert.equal(decision.rejectedTags.length, 1);
  assert.equal(buildTagExtractionOutcome(decision, []).rejectedTags[0]?.evidence[0]?.quote, 'password=[redacted]');
  assert.ok(decision.rejectedTags[0]?.reasonCode);
});

test('audit distinguishes unchanged, updates, empty and review while retaining unconfirmed fields', () => {
  const decision = validateTagExtractionDecision(1n, [{ name: 'duration', value: '1 month', evidence: [{ path: 'spec', quote: '1个月' }] }], { spec: '1个月' });
  const before = [{ name: 'duration', value: '1 month' }, { name: 'renewable', value: '有' }];
  const unchanged = buildTagExtractionOutcome(decision, before);
  assert.equal(unchanged.outcome, 'unchanged');
  assert.deepEqual(unchanged.retainedUnconfirmed, [before[1]]);
  const updated = buildTagExtractionOutcome(decision, [{ name: 'duration', value: '1年' }]);
  assert.equal(updated.outcome, 'updated');
  assert.equal(updated.diff.length, 1);
  assert.equal(buildTagExtractionOutcome(validateTagExtractionDecision(1n, [], {}), before).outcome, 'empty');
  const rejected = validateTagExtractionDecision(1n, [{ name: 'renewable', value: '有', evidence: [{ path: 'spec', quote: '无' }] }], { spec: '无' });
  assert.equal(buildTagExtractionOutcome(rejected, before).outcome, 'review');
});

test('all retained audit strings and arrays are bounded and redacted', () => {
  const before = Array.from({length: 300}, () => ({name:'password=hidden',value:'Bearer private'}));
  const audit=buildTagExtractionOutcome({productId:1n,tags:[],rejectedTags:[]},before,{outcome:'skipped',reasonCode:'password=hidden'});
  assert.equal(audit.before.length,256);
  assert.equal(audit.before[0]?.value,'Bearer [redacted]');
  assert.equal(audit.retainedUnconfirmed[0]?.name,'password=[redacted]');
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
