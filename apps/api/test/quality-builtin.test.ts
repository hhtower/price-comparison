import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createAiQualityDetector } from '../src/quality/ai-quality-detector.js';
import { compareBuiltinFingerprint, createFingerprintChallenges, BUILTIN_FINGERPRINT_MODELS, supportsBuiltinFingerprint } from '../src/quality/ai-quality-baselines.js';
import { validateQualityInput } from '../src/quality/quality-input.js';
import type { AiQualityInput, QualityProgress } from '../src/quality/quality.types.js';

const samples: Array<{text:string;expected_count:number}> = JSON.parse(readFileSync(new URL('./fixtures/modeltrace-gpt54.json', import.meta.url), 'utf8'));
const input: AiQualityInput = { kind: 'ai', endpoint: 'https://relay.example/v1', apiKey: 'target-only-key', model: 'gpt-5.4', mode: 'standard', runs: 3, items: ['connectivity', 'streaming', 'fingerprint-match'] };
const ids = ['fingerprint-match'];
function stream(content: string, model = input.model, finish = 'stop') {
  return new Response([
    { id: 'sample', model, choices: [{ delta: { content: content.slice(0, 1) } }] },
    { id: 'sample', model, choices: [{ delta: { content: content.slice(1) }, finish_reason: finish }] },
  ].map(part => 'data: ' + JSON.stringify(part) + '\n\n').join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}
function fixture(respond = (index: number, model: string) => stream(samples[index % samples.length].text, model)) {
  const requests: Array<{ url: string; key: string | null; body: any }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push({ url: String(url), key: new Headers(init?.headers).get('authorization'), body });
    return respond(requests.length - 1, body.model);
  };
  return { requests, detect: createAiQualityDetector({ fetchImpl, environment: {} }) };
}

test('AI input needs only target credentials and rejects customer baseline configuration', () => {
  assert.deepEqual(validateQualityInput(input), input);
  for (const patch of [{ baseline: 'platform' }, { baseline: 'official' }, { official: { endpoint: 'https://api.openai.com/v1', apiKey: 'official-key', model: input.model } }]) assert.throws(() => validateQualityInput({ ...input, ...patch }));
});

test('pinned ModelTrace references reproduce the known candidate ranking', () => {
  assert.equal(BUILTIN_FINGERPRINT_MODELS.length, 16);
  const result = compareBuiltinFingerprint(input.model, samples);
  assert.equal(result.predictedModel, 'gpt-5.4');
  assert.equal(result.fingerprint, 100);
  assert.equal(result.fingerprintMatches, true);
  for (const count of [1, 2]) assert.equal(compareBuiltinFingerprint(input.model, samples.slice(0, count)).predictedModel, input.model);
  assert.throws(() => compareBuiltinFingerprint(input.model, []));
  assert.throws(() => compareBuiltinFingerprint('unregistered-model', samples));
});

test('randomized challenges retain the enrolled range, count and no-tool constraints', () => {
  const challenges = createFingerprintChallenges(5);
  assert.equal(new Set(challenges.map(item=>item.id)).size, 5);
  assert.equal(new Set(challenges.map(item=>item.expected_count)).size, 5);
  for (const item of challenges) {
    assert.ok(item.expected_count >= 292 && item.expected_count <= 332);
    assert.ok(item.prompt.includes(String(item.expected_count)) && item.prompt.includes('1 到 355') && item.prompt.includes('禁止调用'));
  }
});

test('built-in fingerprint uses three selected streamed observations with target credentials', async () => {
  const { detect, requests } = fixture(); const progress: QualityProgress[] = [];
  const items = await detect(input, ids, new AbortController().signal, () => {}, item => progress.push(item));
  assert.deepEqual(items.map(item => [item.status, item.score]), [['pass', 100]]);
  assert.equal(requests.length, 3);
  assert.ok(requests.every(request => request.url === input.endpoint + '/chat/completions' && request.key === 'Bearer ' + input.apiKey && request.body.stream === true));
  assert.deepEqual(progress.map(item => item.attempt), [1, 2, 3]);
  assert.ok(progress.every(item => item.total === 3));
  assert.ok(items.every(item => item.summary.includes('内置') && item.summary.includes('不能证明模型来源')));
  assert.ok(items.every(item => item.evidence?.attempts?.length === 3));
  assert.ok(!JSON.stringify(items).includes(input.apiKey) && !JSON.stringify(items).includes(samples[0].text.slice(0,30)));
});

test('fingerprints matching a different enrolled model show risk despite valid responses', async () => {
  const { detect } = fixture();
  const items = await detect({...input,model:'gpt-5.5'}, ids, new AbortController().signal, () => {});
  assert.ok(items.every(item=>item.status==='risk' && item.evidence?.attempts?.every(attempt=>attempt.outcome==='pass')));
  assert.equal(items[0].score, 0); assert.match(items[0].summary, /gpt-5.4/);
});

test('unknown model labels and unregistered aliases remain uncovered without upstream requests', async () => {
  for (const model of ['unknown-model', 'gpt-5.4-latest', 'my-claude-opus']) {
    assert.equal(supportsBuiltinFingerprint(model), false);
    const { detect, requests } = fixture();
    const items = await detect({...input,model},ids,new AbortController().signal,()=>{});
    assert.ok(items.every(item=>item.status==='unrun' && item.score===null && item.reason==='unsupported' && !item.evidence));
    assert.equal(requests.length,0);
  }
});

test('truncated, sparse, empty or model-mismatched samples cannot pass and are not retried', async () => {
  for (const respond of [() => stream(samples[0].text, input.model, 'length'), () => stream(''), () => stream('1 2 3'), () => stream(samples[0].text, 'other-model')]) {
    const { detect, requests } = fixture(respond);
    const items = await detect(input, ids, new AbortController().signal, () => {});
    assert.ok(items.every(item => item.status === 'risk' && item.evidence?.attempts?.[0].outcome === 'invalid-response'));
    assert.equal(requests.length, 1);
  }
});

test('full mode respects five selected observations and maintains exact progress and evidence counts', async () => {
  const {detect,requests}=fixture(); const progress: QualityProgress[]=[];
  const items=await detect({...input,mode:'full',runs:5},ids,new AbortController().signal,()=>{},entry=>progress.push(entry));
  assert.equal(requests.length,5); assert.equal(items[0].status,'pass');
  assert.deepEqual(progress.map(entry=>entry.attempt),[1,2,3,4,5]);
  assert.ok(progress.every(entry=>entry.total===5 && entry.stage==='baseline'));
  assert.ok(items.every(item=>item.evidence?.attempts?.length===5));
});

test('fingerprint timeout and cancellation use the shared runtime without partial publication', async () => {
  let requests=0;
  const timeout=createAiQualityDetector({environment:{},timeoutMs:20,fetchImpl:async(_url,init)=>{
    requests++;return new Promise((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>reject(init!.signal!.reason),{once:true}));
  }});
  const timedOut=await timeout(input,ids,new AbortController().signal,()=>{});
  assert.equal(requests,1);assert.ok(timedOut.every(item=>item.evidence?.attempts?.[0].outcome==='timeout'));
  const controller=new AbortController();let ready!:()=>void;
  const started=new Promise<void>(resolve=>{ready=resolve;});
  const cancelled=createAiQualityDetector({environment:{},fetchImpl:async(_url,init)=>new Response(new ReadableStream({start(stream){
    stream.enqueue(new TextEncoder().encode('data: '+JSON.stringify({id:'partial',model:input.model,choices:[{delta:{content:'private-partial'}}]})+'\n\n'));
    init!.signal!.addEventListener('abort',()=>stream.error(init!.signal!.reason),{once:true});ready();
  }}),{headers:{'content-type':'text/event-stream'}})});
  const pending=cancelled(input,ids,controller.signal,()=>{});await started;controller.abort();
  const items=await pending;assert.ok(items.every(item=>item.status==='cancelled' && !item.evidence));
  assert.ok(!JSON.stringify(items).includes('private-partial'));
});
