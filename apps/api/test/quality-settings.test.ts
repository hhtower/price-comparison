import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createAiQualityDetector } from '../src/quality/ai-quality-detector.js';
import { QUALITY_CATALOG } from '../src/quality/quality.catalog.js';
import { validateQualityInput } from '../src/quality/quality-input.js';
import { validateQualityProgress } from '../src/quality/quality-evidence.js';
import { buildQualityReport } from '../src/quality/quality-report.js';
import type { AiQualityInput, QualityProgress } from '../src/quality/quality.types.js';

const base: AiQualityInput = {kind:'ai',endpoint:'https://relay.example/v1',apiKey:'settings-only-key',model:'gpt-5.4',mode:'standard',runs:3,items:['connectivity','streaming']};
const samples: Array<{text:string}> = JSON.parse(readFileSync(new URL('./fixtures/modeltrace-gpt54.json',import.meta.url),'utf8'));
function stream(content: string) {
  return new Response([
    {id:'settings',model:base.model,choices:[{delta:{content:content.slice(0,1)}}]},
    {id:'settings',model:base.model,choices:[{delta:{content:content.slice(1)},finish_reason:'stop'}]},
    {id:'settings',model:base.model,choices:[],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}},
  ].map(part=>'data: '+JSON.stringify(part)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
}

test('retired behavior check is absent from every mode and rejected as an input',()=>{
  assert.equal(QUALITY_CATALOG.ai.some(item=>item.id==='behavior-match'),false);
  for(const [mode,count] of [['quick',4],['standard',13],['full',17]] as const) assert.equal(QUALITY_CATALOG.ai.filter(item=>item.modes?.includes(mode)).length,count);
  assert.throws(()=>validateQualityInput({...base,items:[...base.items,'behavior-match']}));
});

for(const mode of ['quick','standard','full'] as const) for(const runs of [1,3,5]) {
  test(`${mode} respects ${runs} selected runs for shared observations, probes, stability and fingerprints`,async()=>{
    for(const ids of [['connectivity','model-identity','streaming','token-usage','latency'],['iq-test'],['stability'],['fingerprint-match']]) {
      let calls=0;const progress:QualityProgress[]=[];
      const detect=createAiQualityDetector({environment:{},fetchImpl:async(url,init)=>{
        const request=JSON.parse(String(init?.body));
        assert.equal(String(url),base.endpoint+'/chat/completions');
        assert.equal(new Headers(init?.headers).get('authorization'),'Bearer '+base.apiKey);
        assert.equal(request.model,base.model);assert.equal(request.stream,true);
        const text=ids[0]==='fingerprint-match'?samples[calls%samples.length].text:ids[0]==='iq-test'?'{"answer":21}':ids[0]==='stability'?'READY-7':'READY';
        calls++;return stream(text);
      }});
      const input={...base,mode,runs};
      const items=await detect(input,ids,new AbortController().signal,()=>{},value=>progress.push(value));
      const insufficient=ids[0]==='stability'&&runs===1;
      assert.equal(calls,insufficient?0:runs,ids.join(','));
      assert.deepEqual(items.map(item=>item.id),ids);
      if(insufficient){assert.equal(items[0].status,'unrun');assert.equal(items[0].reason,'insufficient-samples');assert.equal(items[0].score,null);}
      else {assert.ok(items.every(item=>item.evidence?.attempts?.length===runs));assert.deepEqual(progress.map(entry=>entry.attempt),Array.from({length:runs},(_,i)=>i+1));}
      const configuration={runs,mode,selected:ids};
      for(const entry of progress){assert.equal(entry.total,runs);validateQualityProgress([entry],configuration,'running');}
      const report=buildQualityReport({id:'settings',kind:'ai',state:'completed',target:base.endpoint,model:base.model,configuration,progress:[],createdAt:'2026-09-26T00:00:00.000Z',completedAt:'2026-09-26T00:00:01.000Z'},items);
      assert.equal(report.configuration.runs,runs);
    }
  });
}

test('invalid setting values fail validation instead of being coerced',()=>{
  for(const patch of [{mode:['full']},{mode:{toString:()=> 'full'}},{runs:null},{runs:'3'},{runs:0},{runs:6},{runs:1.5},{runs:NaN},{runs:Infinity}]) assert.throws(()=>validateQualityInput({...base,...patch}));
  assert.equal(validateQualityInput({...base,runs:undefined}).runs,3);
});
