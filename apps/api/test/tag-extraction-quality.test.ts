import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateTagFacts, passesTagReleaseGate, compareTagEvaluationRuns } from '../src/ai/tag-extraction-quality.js';
test('fact metrics count product/field/value, duplicates once, wrong values as FP and FN', () => {
 const expected = [{id:'1',tags:[{name:'duration',value:'1 month'},{name:'renewable',value:'无'}]}];
 const report = evaluateTagFacts(expected, [{id:'1',tags:[{name:'duration',value:'30 days'},{name:'renewable',value:'无'},{name:'renewable',value:'无'}]}]);
 assert.deepEqual(report.total, {expected:2,predicted:2,tp:1,fp:1,fn:1,precision:0.5,recall:0.5});
 assert.equal(report.fields.duration.fn,1); assert.equal(report.fields.duration.fp,1);
 assert.equal(passesTagReleaseGate(report,report),false);
});
test('release requires complete coverage and measured baseline with no field regression', () => {
 const expected=[{id:'1',tags:[]},{id:'2',tags:[{name:'duration',value:'1 month'}]}];
 const good=evaluateTagFacts(expected,expected);
 assert.equal(passesTagReleaseGate(good,good),true);
 assert.equal(passesTagReleaseGate(good,null),false);
 assert.equal(passesTagReleaseGate(evaluateTagFacts(expected,[expected[1]]),good),false);
 assert.throws(()=>evaluateTagFacts(expected,[...expected,expected[0]]));
});

import { validateTagExtractionDecision } from '../src/ai/tag-extraction-result.js';
import { normalizeSpec } from '../src/products/product-spec.js';
import { buildExtractionPayload } from '../src/ai/adaptive-batching.js';
import { PURCHASE_GUIDE_FIELDS } from '@price-comparison/catalog/purchase-guide-content';
import { readFile } from 'node:fs/promises';
import { parseTagExtractionResponse, buildTagExtractionRequest } from '../src/ai/tag-extraction-request.js';
const fixture = JSON.parse(await readFile(new URL('./fixtures/tag-extraction-quality-expanded-20261016.json', import.meta.url), 'utf8'));
test('synthetic references satisfy closed protocol and retain validated facts', () => {
 for (const split of ['diagnostic']) {
  const samples=fixture.samples.filter((sample:any)=>sample.split===split);
  assert.ok(samples.length>=4);
  const expected=samples.map((sample:any)=>({id:sample.id,tags:sample.expected}));
  parseTagExtractionResponse(JSON.stringify({items:expected}));
  const accepted = [];
  for(const sample of samples) {
   const payload=buildTagExtractionRequest([sample.input],'mock').messages[1].content;
   assert.ok(!/https?:|@|api_key|password/iu.test(payload));
   for(const tag of sample.expected) assert.ok(tag.path.split('.').reduce((value:any,key:string)=>value[key],sample.input).includes(tag.quote));
   const proposed=sample.expected.map(({name,value,path,quote}:any)=>({name,value,evidence:[{path,quote:path==='spec'?normalizeSpec(quote):quote}]}));
   const validated=validateTagExtractionDecision(BigInt(sample.id),proposed,buildExtractionPayload(sample.input));
   accepted.push({id:sample.id,tags:validated.tags});
  }
  const report=evaluateTagFacts(expected,expected);
  assert.equal(report.total.fp,0); assert.equal(report.total.fn,0);
  assert.deepEqual(evaluateTagFacts(expected,accepted),report);
 }
});

test('saved real run comparisons require matching immutable manifests and holdout observations',()=>{
 const manifest={kind:'real-model' as const,provider:'provider',requestedModel:'model',responseModel:'snapshot',promptVersion:'v3',promptSha256:'a'.repeat(64),protocolVersion:'json-v1',rulesSha256:'b'.repeat(64),fixtureVersion:'fixture-v1',fixtureSha256:'c'.repeat(64),split:'holdout' as const,capturedAt:'2026-10-15'};
 const responses=[{id:'1',tags:[{name:'duration',value:'1 month'}]}];
 const baseline={manifest,responses}; const candidate={manifest:{...manifest,promptVersion:'v4'},responses};
 assert.equal(compareTagEvaluationRuns(responses,null,candidate).passed,false);
 assert.equal(compareTagEvaluationRuns(responses,baseline,candidate).passed,true);
 assert.throws(()=>compareTagEvaluationRuns(responses,baseline,{...candidate,manifest:{...candidate.manifest,rulesSha256:'d'.repeat(64)}}));
});

test('release gate accepts removing a baseline-only hallucinated field',()=>{
 const gold=[{id:'1',tags:[{name:'duration',value:'1 month'}]}];
 const baseline=evaluateTagFacts(gold,[{id:'1',tags:[...gold[0].tags,{name:'renewable',value:'有'}]}]);
 assert.equal(passesTagReleaseGate(evaluateTagFacts(gold,gold),baseline),true);
});

test('synthetic references cover all collection groups',()=>{
 const real=fixture.samples.filter((sample:any)=>sample.provenance.kind==='synthetic-control');
 const groups=new Set(real.flatMap((sample:any)=>sample.expected.map((tag:any)=>PURCHASE_GUIDE_FIELDS[tag.name].collectionGroup)));
 assert.deepEqual([...groups].sort(),[...new Set(Object.values(PURCHASE_GUIDE_FIELDS).map(field=>field.collectionGroup))].sort());
 assert.match(fixture.annotationScope,/not independent human/);
});
