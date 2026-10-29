import assert from 'node:assert/strict';
import test from 'node:test';
import { validate } from 'class-validator';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { AiController, TagJobCreateDto, TagJobScopeDto } from '../src/ai/ai.controller.js';
import { AiAdminController } from '../src/ai/ai-admin.controller.js';
import { AiService } from '../src/ai/ai.service.js';
test('tag creation validates cost acknowledgment and bounded IDs, disallows caller model',async()=>{
 const valid={productIds:['1'],requestId:'7310f082-cb6e-4422-8c8d-966788b25905',previewDigest:'a'.repeat(64),acknowledgePossibleCharge:true};
 assert.equal((await validate(Object.assign(new TagJobCreateDto(),valid))).length,0);
 for(const productIds of [null,[],['0'],['1','1'],Array.from({length:501},(_,i)=>String(i+1))]) assert.ok((await validate(Object.assign(new TagJobCreateDto(),{...valid,productIds}))).length);
 assert.ok((await validate(Object.assign(new TagJobCreateDto(),{...valid,model:'paid'}),{whitelist:true,forbidNonWhitelisted:true})).length);
 assert.ok((await validate(Object.assign(new TagJobCreateDto(),{...valid,acknowledgePossibleCharge:false}))).length);
 assert.ok((await validate(Object.assign(new TagJobScopeDto(),{scopeShopId:null}))).length);
 const calls:unknown[]=[];const controller=new AiController({createTagJob:async(input:unknown)=>{calls.push(input);return{id:1n}}}as never,{}as never);
 await assert.rejects(controller.createTags({...valid,acknowledgePossibleCharge:false}),{code:'AI_RETRY_ACK_REQUIRED'});assert.equal(calls.length,0);
 assert.deepEqual(await controller.createTags(valid),{id:'1'});assert.equal((calls[0] as any).productIds[0],1n);
});
test('tag admin routes retain authentication and validate pagination/IDs',async()=>{
 assert.ok(Reflect.getMetadata(GUARDS_METADATA,AiController).includes(AuthGuard));
 assert.ok(Reflect.getMetadata(GUARDS_METADATA,AiAdminController).includes(AuthGuard));
 const calls:unknown[]=[];const admin=new AiAdminController({listTagJobResults:(v:unknown)=>{calls.push(v);return{items:[]}},tagProductAudit:(...v:unknown[])=>{calls.push(v);return{}}}as never);
 admin.tagResults('2','10');admin.tagAudit('2','3');
 assert.deepEqual(calls,[{jobId:2n,limit:10,cursor:undefined},[2n,3n]]);
 assert.throws(()=>admin.tagResults('2','101'),{code:'INVALID_PAGE_SIZE'});assert.throws(()=>admin.tagAudit('2','0'),{code:'INVALID_ID'});
});

test('all-pending scope validates a boolean and is passed through preview and creation', async () => {
 const scope = { allPending: true };
 assert.equal((await validate(Object.assign(new TagJobScopeDto(), scope), { whitelist: true, forbidNonWhitelisted: true })).length, 0);
 for (const allPending of [null, 'true', 1, false]) assert.ok((await validate(Object.assign(new TagJobScopeDto(), { allPending }))).length);
 const calls: unknown[] = [];
 const controller = new AiController({ previewTagJob: async (input: unknown) => { calls.push(input); return {}; }, createTagJob: async (input: unknown) => { calls.push(input); return { id: 1n }; } } as never, {} as never);
 await controller.previewTags(scope as TagJobScopeDto);
 await controller.createTags({ ...scope, requestId: '7310f082-cb6e-4422-8c8d-966788b25905', previewDigest: 'a'.repeat(64), acknowledgePossibleCharge: true } as TagJobCreateDto);
 assert.equal((calls[0] as any).allPending, true);
 assert.equal((calls[1] as any).allPending, true);
 assert.equal((await validate(Object.assign(new TagJobCreateDto(),{allPending:true,requestId:'7310f082-cb6e-4422-8c8d-966788b25905',acknowledgePossibleCharge:true}))).length,0);
 assert.ok((await validate(Object.assign(new TagJobCreateDto(),{productIds:['1'],requestId:'7310f082-cb6e-4422-8c8d-966788b25905',acknowledgePossibleCharge:true}))).length);
});
test('tag service always chooses configured runtime model',async()=>{
 const previous={...process.env};
 try{
 process.env.AI_STANDARDIZATION_ENABLED='true';process.env.AI_API_KEY='test';process.env.AI_BASE_URL='http://localhost:1234/v1';process.env.AI_MODEL='local-test';
 let captured:any;const service=new AiService({previewTagJob:(input:unknown)=>{captured=input;return{};}}as never);
 service.previewTagJob({productIds:[1n]});assert.equal(captured.model,'local-test');
 }finally{for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);}
});

test('disabled tag extraction rejects previews, bulk creation and targeted retries before repository access', () => {
 const previous = { ...process.env };
 try {
  Object.assign(process.env, { AI_STANDARDIZATION_ENABLED: 'true', AI_TAG_EXTRACTION_ENABLED: 'false', AI_API_KEY: 'test', AI_BASE_URL: 'http://localhost:1234/v1', AI_MODEL: 'local-test' });
  let calls = 0;
  const service = new AiService({ previewTagJob: () => { calls++; }, createTagJob: () => { calls++; } } as never);
  assert.throws(() => service.previewTagJob({ productIds: [1n] }), { code: 'AI_TAG_EXTRACTION_DISABLED' });
  for (const scope of [{ productIds: [1n] }, { allPending: true }, { productIds: [1n], retryOfJobId: 2n }]) {
   assert.throws(() => service.createTagJob({ ...scope, requestId: 'request' }), { code: 'AI_TAG_EXTRACTION_DISABLED' });
  }
  assert.equal(calls, 0);
  delete process.env.AI_TAG_EXTRACTION_ENABLED;
  service.previewTagJob({ productIds: [1n] });
  service.createTagJob({ allPending: true, requestId: 'request' });
  assert.equal(calls, 2);
 } finally { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); }
});
