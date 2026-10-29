import test from 'node:test';
import assert from 'node:assert/strict';
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type CompiledQuery } from 'kysely';
import { StandardizationRepository } from '../src/standardization/standardization.repository.js';
import { ProductsRepository } from '../src/products/products.repository.js';
import type { DatabaseSchema } from '../src/database/types.js';
import { productContentFingerprint } from '../src/standardization/fingerprint.js';
import { buildCanonicalStandardKey } from '../src/standardization/canonical-key.js';

const claim = { id: 1n, product_id: 11n, event_id: 21n, attempts: 2n, claim_token: 'token-2' };
const product = {id:11n,shop_id:3n,name:'ChatGPT Pro 5x',source_name:'ChatGPT Pro 5x',source_description:'Original body',content_fingerprint:productContentFingerprint({name:'ChatGPT Pro 5x',description:'Original body',spec:'monthly'}),spec:'monthly',source_category:'',source_data:{},content_version:1n,standardization_revision:3n};
function fixture(rows: unknown[] = [claim], acknowledged: unknown[] = rows, currentProduct = product, eligibleProductIds = [11n], options: {
  lockedRows?: unknown[];
  eligibleShopIds?: bigint[];
  currentMembershipStandardProductId?: bigint | null;
  candidateStandardHasPublishedMember?: boolean;
  onQuery?: (query: CompiledQuery) => void;
} = {}) {
  const events: string[] = [];
  const queries: CompiledQuery[] = [];
  let outboxReads = 0;
  let storedProduct = { ...currentProduct };
  class Driver extends DummyDriver {
    async beginTransaction() { events.push('begin'); }
    async commitTransaction() { events.push('commit'); }
    async rollbackTransaction() { events.push('rollback'); }
    async acquireConnection(): Promise<any> {
      return { executeQuery: async (query: CompiledQuery) => {
        queries.push(query);
        options.onQuery?.(query);
        if(query.sql.startsWith('select') && query.sql.includes('"standardization_outbox"')) return {rows:++outboxReads === 1 ? rows : options.lockedRows ?? rows};
        if(query.sql.startsWith('update "standardization_outbox"')) {
          if(query.parameters.includes('queued')) {events.push('defer');return {rows:[],numAffectedRows:1n};}
          events.push('ack'); return {rows:acknowledged.map((row:any)=>({id:row.id})),numAffectedRows:BigInt(acknowledged.length)};
        }
        if(query.sql.startsWith('select') && query.sql.includes('from "shops"')) return {rows:(options.eligibleShopIds ?? [currentProduct.shop_id]).map(id=>({id}))};
        if(query.sql.startsWith('select') && query.sql.includes('inner join "shops"')) return {rows:eligibleProductIds.map(id=>({id}))};
        if(query.sql.startsWith('select') && query.sql.includes('"products"') && query.sql.endsWith('for share')) return {rows:eligibleProductIds.map(id=>({id}))};
        if(query.sql.startsWith('select') && query.sql.includes('"products"')) return {rows:[storedProduct]};
        if(query.sql.startsWith('update "products" as "p"')) return {rows:[],numAffectedRows:0n};
        if(query.sql.startsWith('update "products"')) {
          const updates=Object.fromEntries([...query.sql.matchAll(/"([^"]+)" = \$(\d+)/g)].map(([,key,index])=>[key,query.parameters[Number(index)-1]]));
          storedProduct = { ...storedProduct, ...updates };
          return {rows:[storedProduct],numAffectedRows:1n};
        }
        if(query.sql.startsWith('insert into "product_change_events"')) {events.push('event');return {rows:[{id:31n}]};}
        if(query.sql.startsWith('insert into "standardization_outbox"')) {events.push('outbox');return {rows:[]};}
        if(query.sql.startsWith('select') && query.sql.includes('from "standard_product_members"')) {
          return {rows:options.currentMembershipStandardProductId === null || options.currentMembershipStandardProductId === undefined
            ? []
            : [{standard_product_id:options.currentMembershipStandardProductId}]};
        }
        if(query.sql.startsWith('select') && query.sql.includes('"standard_products"')) return {rows:[{id:4n,canonical_family:'openai',canonical_product:'chatgpt',canonical_tier:'pro_5x',standard_key:buildCanonicalStandardKey({family:'openai',product:'chatgpt',tier:'pro_5x'}),verification_state:'verified',has_published_member:options.candidateStandardHasPublishedMember ?? true}]};
        if(query.sql.startsWith('select') && query.sql.includes('from "standardization_catalog_versions"')) return {rows:[{version:1n,alias_policy_version:'catalog-sms-20260919-v2'}]};
        if(query.sql.includes('update catalog_cache_versions')) {events.push('cache'); return {rows:[{version:2n}]};}
        if(query.sql.includes('update standardization_catalog_versions')) return {rows:[{version:2n,alias_policy_version:'catalog-sms-20260919-v2'}]};
        return {rows:[],numAffectedRows:1n};
      }};
    }
  }
  const db = new Kysely<DatabaseSchema>({dialect:{createAdapter:()=>new PostgresAdapter(),createDriver:()=>new Driver(),createIntrospector:db=>new PostgresIntrospector(db),createQueryCompiler:()=>new PostgresQueryCompiler()}});
  return {db,events,queries};
}

test('incremental creation reuses the AI transaction and acknowledges only current live claims',async()=>{
  const f=fixture([claim,{...claim,id:2n,event_id:22n}]);
  const repository=new StandardizationRepository(f.db,{createJob:async(input:any,tx:any)=>{
    assert.equal(tx.isTransaction,true);
    assert.deepEqual(input.productIds,[11n]);
    assert.deepEqual(input.sourceEvents,[{productId:11n,eventId:21n},{productId:11n,eventId:22n}]);
    assert.equal(input.jobType,'incremental'); assert.equal(input.priority,50); assert.equal(input.triggerEventId,21n);
    f.events.push('create'); return {id:9n};
  }} as never);
  const result=await repository.createIncrementalJob({outbox:[claim,{...claim,id:2n}],workerId:'w',priority:50});
  assert.equal(result?.id,9n);
  assert.deepEqual(f.events,['begin','create','ack','commit']);
  assert.match(f.queries[0]!.sql,/claimed_by.*lease_until.*clock_timestamp\(\)/);
  assert.doesNotMatch(f.queries[0]!.sql,/for update|for share/);
  const locks=f.queries.filter(query=>/for update|for share/.test(query.sql));
  assert.equal(locks.length,3);
  assert.match(locks[0]!.sql,/from "shops".*order by "id"(?: asc)? for share/);
  assert.match(locks[1]!.sql,/from "products".*order by "id"(?: asc)? for share/);
  assert.match(locks[2]!.sql,/from "standardization_outbox".*claimed_by.*lease_until.*clock_timestamp\(\).*order by "id"(?: asc)? for update/);
  assert.match(f.queries.at(-1)!.sql,/lease_until.*clock_timestamp\(\)/);
  await f.db.destroy();
});

test('outbox claims exclude unavailable shops and deleted products without actor privilege',async()=>{
  const f=fixture();
  await new StandardizationRepository(f.db,{} as never).claimOutbox('w');
  const query=f.queries[0]!.sql;
  assert.match(query,/products/);
  assert.match(query,/shops/);
  assert.doesNotMatch(query,/standardization_locked/);
  assert.match(query,/enabled\s*=\s*true/);
  assert.match(query,/p\.deleted_at is null/);
  assert.match(query,/s\.deleted_at is null/);
  await f.db.destroy();
});

test('recoverFinalization fails abandoned batches before scanning for unfinalized jobs',async()=>{
  const f=fixture();
  await new StandardizationRepository(f.db,{} as never).recoverFinalization(9);
  const reaper=f.queries.find(query=>query.sql.includes('with abandoned as')&&query.sql.includes('update ai_job_batches'));
  const scan=f.queries.find(query=>query.sql.includes('from "ai_jobs" as "j"'));
  assert.ok(reaper,'abandoned batch recovery must run');
  assert.ok(scan,'finalization scan must run');
  assert.ok(f.queries.indexOf(reaper)<f.queries.indexOf(scan),'abandoned batches must be terminal before finalization rescans jobs');
  assert.ok(reaper.parameters.includes(9));
  await f.db.destroy();
});

test('unavailable claims are requeued without creating an empty AI job',async()=>{
  const f=fixture([claim],[claim],product,[]);
  const repository=new StandardizationRepository(f.db,{createJob:async()=>assert.fail('created an empty job')} as never);
  assert.equal(await repository.createIncrementalJob({outbox:[claim],workerId:'w',priority:50}),null);
  assert.deepEqual(f.events,['begin','defer','commit']);
  const deferred=f.queries.find(query=>query.sql.startsWith('update "standardization_outbox"'))!;
  assert.match(deferred.sql,/available_at.*clock_timestamp\(\).*interval/);
  assert.ok(deferred.parameters.includes('queued'));
  await f.db.destroy();
});

test('mixed claims acknowledge only eligible products and lock eligibility until commit',async()=>{
  const blocked={...claim,id:2n,product_id:12n,event_id:22n};
  const f=fixture([claim,blocked],[claim]);
  const repository=new StandardizationRepository(f.db,{createJob:async(input:any)=>{
    assert.deepEqual(input.productIds,[11n]);f.events.push('create');return {id:9n};
  }} as never);
  assert.deepEqual((await repository.createIncrementalJob({outbox:[claim,blocked],workerId:'w',priority:50}))?.sourceOutboxIds,[1n]);
  assert.deepEqual(f.events,['begin','defer','create','ack','commit']);
  const shopEligibility=f.queries.find(query=>query.sql.includes('from "shops"'))!;
  assert.ok(shopEligibility);
  assert.match(shopEligibility.sql,/deleted_at.*enabled.*for share/);
  const productEligibility=f.queries.find(query=>query.sql.includes('"content_fingerprint" from "products"')&&query.sql.endsWith('for share'))!;
  assert.ok(productEligibility);
  assert.match(productEligibility.sql,/shop_id.*deleted_at.*for share/);
  assert.doesNotMatch(productEligibility.sql,/standardization_locked/);
  await f.db.destroy();
});

test('claims replaced while waiting for eligibility locks cannot enter the AI job',async()=>{
  const replaced={...claim,id:2n,product_id:12n,event_id:22n};
  const f=fixture([claim,replaced],[claim],product,[11n,12n],{lockedRows:[claim,{...replaced,claim_token:'replacement'}]});
  const repository=new StandardizationRepository(f.db,{createJob:async(input:any)=>{
    assert.deepEqual(input.productIds,[11n]);f.events.push('create');return {id:9n};
  }} as never);
  assert.deepEqual((await repository.createIncrementalJob({outbox:[claim,replaced],workerId:'w',priority:50}))?.sourceOutboxIds,[1n]);
  assert.deepEqual(f.events,['begin','create','ack','commit']);
  await f.db.destroy();
});

test('claims expired during eligibility locking neither create nor acknowledge a job',async()=>{
  const f=fixture([claim],[],product,[11n],{lockedRows:[]});
  const repository=new StandardizationRepository(f.db,{createJob:async()=>assert.fail('expired claim created a job')} as never);
  assert.equal(await repository.createIncrementalJob({outbox:[claim],workerId:'w',priority:50}),null);
  assert.deepEqual(f.events,['begin','commit']);
  await f.db.destroy();
});

test('shops that become unavailable defer claims without taking product locks or creating AI jobs',async()=>{
  const f=fixture([claim],[claim],product,[11n],{eligibleShopIds:[]});
  const repository=new StandardizationRepository(f.db,{createJob:async()=>assert.fail('unavailable shop created a job')} as never);
  assert.equal(await repository.createIncrementalJob({outbox:[claim],workerId:'w',priority:50}),null);
  assert.deepEqual(f.events,['begin','defer','commit']);
  assert.equal(f.queries.some(query=>query.sql.includes('"content_fingerprint" from "products"')&&query.sql.endsWith('for share')),false);
  await f.db.destroy();
});

test('cancellation while locking eligibility rolls back before AI creation',async()=>{
  const controller=new AbortController();
  const f=fixture([claim],[claim],product,[11n],{onQuery:query=>{
    if(query.sql.includes('for share')) controller.abort(new Error('cancelled during eligibility locking'));
  }});
  const repository=new StandardizationRepository(f.db,{createJob:async()=>assert.fail('cancelled claim created a job')} as never);
  await assert.rejects(repository.createIncrementalJob({outbox:[claim],workerId:'w',priority:50,signal:controller.signal}),/cancelled during eligibility locking/);
  assert.deepEqual(f.events,['begin','rollback']);
  await f.db.destroy();
});

test('lost and superseded claims cannot create an AI job or acknowledge the outbox',async()=>{
  for(const rows of [[],[{...claim,claim_token:'newer-token'}],[{...claim,attempts:3n}]]){
    const f=fixture(rows);
    const repository=new StandardizationRepository(f.db,{createJob:async()=>assert.fail('stale claim created a job')} as never);
    assert.equal(await repository.createIncrementalJob({outbox:[claim],workerId:'w',priority:50}),null);
    assert.deepEqual(f.events,['begin','commit']);
    await f.db.destroy();
  }
});

test('AI creation failure rolls back without acknowledging its events',async()=>{
  const f=fixture();
  const repository=new StandardizationRepository(f.db,{createJob:async()=>{throw new Error('creation failed');}} as never);
  await assert.rejects(repository.createIncrementalJob({outbox:[claim],workerId:'w',priority:50}),/creation failed/);
  assert.deepEqual(f.events,['begin','rollback']);
  await f.db.destroy();
});

test('expiry or cancellation during AI creation rolls the transaction back',async()=>{
  for(const reason of ['expiry','cancellation']){
    const f=fixture([claim],[]); const controller=new AbortController();
    const repository=new StandardizationRepository(f.db,{createJob:async()=>{
      f.events.push('create');
      if(reason==='cancellation') controller.abort(new Error('cancelled'));
      return {id:9n};
    }} as never);
    await assert.rejects(repository.createIncrementalJob({outbox:[claim],workerId:'w',priority:50,signal:controller.signal}),/expired|cancelled/);
    assert.equal(f.events.at(-1),'rollback');
    assert.equal(f.events.includes('commit'),false);
    await f.db.destroy();
  }
});

test('cancellation during outbox acknowledgement rolls back the created AI job',async()=>{
  const controller=new AbortController();
  const f=fixture([claim],[claim],product,[11n],{onQuery:query=>{
    if(query.sql.startsWith('update "standardization_outbox"')) controller.abort(new Error('cancelled during acknowledgement'));
  }});
  const repository=new StandardizationRepository(f.db,{createJob:async()=>{f.events.push('create');return {id:9n};}} as never);
  await assert.rejects(repository.createIncrementalJob({outbox:[claim],workerId:'w',priority:50,signal:controller.signal}),/cancelled during acknowledgement/);
  assert.deepEqual(f.events,['begin','create','ack','rollback']);
  await f.db.destroy();
});

test('assignment, withdrawal and tag edits advance revision and invalidate the catalog',async()=>{
  for(const action of ['assignment','withdrawal','tags','clear-tags']){
    const f=fixture(undefined,undefined,undefined,undefined,action==='withdrawal'
      ? {currentMembershipStandardProductId:4n,candidateStandardHasPublishedMember:false}
      : {});
    const repository=new ProductsRepository(f.db);
    if(action==='assignment') await repository.assignStandardProduct(11n,4n);
    else if(action==='withdrawal') await repository.assignStandardProduct(11n,null);
    else await repository.replaceTags(11n,action==='clear-tags'?[]:[{name:'duration',value:'annual'}]);
    assert.match(f.queries[0]!.sql,/select.*from "products".*for no key update/);
    assert.ok(f.events.includes('cache'));
    assert.ok(f.queries.some(query=>query.sql.startsWith('update "products"')&&query.sql.includes('"standardization_revision" = standardization_revision + 1')),action);
    assert.equal(f.queries.some(query=>query.sql.includes('standardization_locked')),false,action);
    assert.equal(f.queries.some(query=>query.sql.startsWith('insert into "standardization_outbox"')),false,action);
    if(action==='withdrawal') assert.equal(f.queries.some(query=>query.sql.startsWith('insert into "standard_product_members"')),false);
    if(action==='assignment'||action==='withdrawal'){
      assert.ok(f.queries.some(query=>query.sql.includes('update standardization_catalog_versions')),action);
      const change=f.queries.find(query=>query.sql.startsWith('insert into "catalog_index_changes"'))!;
      assert.ok(change,action);
      assert.ok(change.parameters.includes(action==='assignment'?'upsert':'delete'),action);
    }
    await f.db.destroy();
  }
});

test('editing evidence versions the product and atomically queues its new fingerprint',async()=>{
  const f=fixture();
  await new ProductsRepository(f.db).update(11n,{description:'Annual source body'});
  assert.deepEqual(f.events,['begin','event','outbox','cache','commit']);
  const fingerprint=productContentFingerprint({name:product.name,description:'Annual source body',spec:product.spec});
  const update=f.queries.find(query=>query.sql.startsWith('update "products"'))!;
  assert.ok(update.parameters.includes(fingerprint));
  assert.ok(update.parameters.includes(2n));
  assert.ok(update.parameters.includes(4n));
  assert.match(update.sql,/content_changed_at/);
  const event=f.queries.find(query=>query.sql.startsWith('insert into "product_change_events"'))!;
  assert.ok(event.parameters.includes('evidence_changed'));
  assert.ok(event.parameters.includes(fingerprint));
  assert.ok(event.parameters.includes(2n));
  assert.ok(f.queries.some(query=>query.sql.startsWith('delete from "standard_product_members"')));
  assert.ok(f.queries.some(query=>query.sql.startsWith('delete from "product_tags"')));
  assert.match(f.queries.find(query=>query.sql.startsWith('insert into "standardization_outbox"'))!.sql,/on conflict do nothing/);
  await f.db.destroy();
});

test('cosmetic and quote evidence changes preserve publication and revision without enqueueing',async()=>{
  for(const input of [{spec:' monthly ',sourceData:{price:123}},{imageUrl:'https://example.test/new.png'}]){
    const f=fixture();
    const updated=await new ProductsRepository(f.db).update(11n,input);
    assert.deepEqual(f.events,['begin','cache','commit']);
    assert.equal(f.queries.some(query=>query.sql.startsWith('delete from "standard_product_members"')),false);
    const update=f.queries.find(query=>query.sql.startsWith('update "products" set '))!;
    assert.ok(update);
    assert.equal(update.sql.includes('"standardization_revision" ='),false);
    assert.equal(updated?.standardization_revision,3n);
    assert.equal(updated?.content_version,1n);
    await f.db.destroy();
  }
});
