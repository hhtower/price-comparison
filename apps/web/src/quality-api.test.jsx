import { afterEach, expect, test, vi } from 'vitest';
import { createQualityApi } from './quality-api.js';
import { report } from './quality-test-fixtures.js';
afterEach(()=>vi.restoreAllMocks());
const task={id:'task-1',accessToken:'private-token'};
const json=data=>new Response(JSON.stringify(data));
const stream=chunks=>new Response(new ReadableStream({start(controller){for(const chunk of chunks)controller.enqueue(chunk);controller.close();}}),{headers:{'Content-Type':'text/event-stream'}});
test('model discovery keeps credentials in the POST body and validates the complete list', async () => {
 const fetcher = vi.fn().mockResolvedValueOnce(json({ models: ['model-b', 'model-a', 'model-b'] })).mockResolvedValueOnce(json({ models: ['valid', null] }));
 const signal = new AbortController().signal;
 const input = { endpoint: 'https://relay.example/v1', apiKey: 'private-key' };
 const api = createQualityApi(fetcher);
 expect(await api.models(input, signal)).toEqual(['model-a', 'model-b']);
 expect(fetcher).toHaveBeenCalledWith('/api/quality/models', expect.objectContaining({ method: 'POST', body: JSON.stringify(input), signal, cache: 'no-store', credentials: 'omit', redirect: 'error' }));
 await expect(api.models(input, signal)).rejects.toThrow();
});
test('parses split UTF-8 and CRLF SSE frames with complete snapshots and bearer auth',async()=>{
 const running=report('ai','running'); const completed=report();
 const bytes=new TextEncoder().encode(': heartbeat\r\ndata: '+JSON.stringify(running)+'\r\n\r\ndata: '+JSON.stringify(completed)+'\n\n');
 const fetcher=vi.fn().mockResolvedValueOnce(json(running)).mockResolvedValueOnce(stream(Array.from(bytes,byte=>new Uint8Array([byte]))));
 const seen=[];await createQualityApi(fetcher).watch(task,item=>seen.push(item),new AbortController().signal);
 expect(seen.at(-1)).toEqual(completed);expect(seen.some(item=>item.state==='running')).toBe(true);
 for(const[url,options]of fetcher.mock.calls){expect(url).not.toContain('private-token');expect(options.headers.Authorization).toBe('Bearer private-token');}
});
test('stream disconnection reads the authoritative terminal snapshot',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(json(report('ai','running'))).mockResolvedValueOnce(stream([])).mockResolvedValueOnce(json(report('ai','cancelled')));
 const seen=[];await createQualityApi(fetcher).watch(task,value=>seen.push(value),new AbortController().signal);
 expect(seen.at(-1).state).toBe('cancelled');expect(fetcher.mock.calls.at(-1)[0]).toBe('/api/quality/tasks/task-1');
});
test('disconnection cannot turn a running snapshot into success',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(json(report('ai','running'))).mockResolvedValueOnce(stream([])).mockResolvedValueOnce(json(report('ai','running')));
 await expect(createQualityApi(fetcher).watch(task,()=>{},new AbortController().signal)).rejects.toThrow(/连接.*重新连接/);
});
test('aborting a pending stream cancels its reader and does not publish late snapshots',async()=>{
 let controller;let cancelled=false;const abort=new AbortController();const seen=[];
 const fetcher=vi.fn().mockResolvedValueOnce(json(report('ai','running'))).mockResolvedValueOnce(new Response(new ReadableStream({start(value){controller=value;},cancel(){cancelled=true;}}),{headers:{'Content-Type':'text/event-stream'}}));
 const watching=createQualityApi(fetcher).watch(task,value=>seen.push(value),abort.signal);
 await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(2));abort.abort();await watching;
 expect(cancelled).toBe(true);expect(seen.every(item=>item.state==='running')).toBe(true);expect(()=>controller.enqueue(new Uint8Array())).toThrow();
});
test('malformed SSE recovers from the snapshot instead of publishing unchecked data',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(json(report('ai','running'))).mockResolvedValueOnce(stream([new TextEncoder().encode('data: {bad}\n\n')])).mockResolvedValueOnce(json(report()));
 const seen=[];await createQualityApi(fetcher).watch(task,item=>seen.push(item),new AbortController().signal);expect(seen.at(-1)).toEqual(report());
});
test('rejects snapshots from another task and masks unsafe server error bodies',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(json(report('ai','completed',{id:'other-task'})));
 await expect(createQualityApi(fetcher).get(task)).rejects.toThrow(/报告/);
 const failed=vi.fn().mockResolvedValue(new Response('leaked-key',{status:400}));await expect(createQualityApi(failed).start({})).rejects.toThrow(/检查.*配置/);
});
test('retest always sends an item id array with the input payload',async()=>{
 const fetcher=vi.fn().mockResolvedValue(json({id:'task-2',accessToken:'next-token'}));
 const input={kind:'ai',apiKey:'secret',model:'model'};
 await createQualityApi(fetcher).retest(task,['tool-calling','math-reasoning'],input);
 expect(fetcher).toHaveBeenCalledWith('/api/quality/tasks/task-1/retest',expect.objectContaining({
  method:'POST',body:JSON.stringify({itemIds:['tool-calling','math-reasoning'],input}),
 }));
 const requestBody=JSON.parse(fetcher.mock.calls[0][1].body);
 expect(requestBody).not.toHaveProperty('itemId');
});

test.each([
 ['missing configuration', value => { delete value.configuration; }],
 ['extra report field', value => { value.rawResponse = 'sensitive'; }],
 ['extra summary field', value => { value.summary.coverage = 99; }],
 ['inconsistent counts', value => { value.summary.tested += 1; }],
 ['inconsistent score', value => { value.summary.score = 7; }],
 ['missing catalogue item', value => { value.items.pop(); }],
 ['changed catalogue label', value => { value.items[0].label = 'wrong'; }],
 ['too many runs', value => { value.configuration.runs = 6; }],
 ['duplicate selection', value => { value.configuration.selected.push(value.configuration.selected[0]); }],
 ['unknown selection', value => { value.configuration.selected = ['unknown']; }],
 ['AI configuration with null mode', value => { value.configuration.mode = null; }],
 ['extra configuration field', value => { value.configuration.rawPrompt = 'sensitive'; }],
 ['noncanonical timestamp', value => { value.createdAt = '2026-09-26'; }],
 ['missing terminal time', value => { delete value.completedAt; }],
 ['reason on scored item', value => { value.items[0].reason = 'unsupported'; }],
 ['empty evidence', value => { value.items[0].evidence = {}; }],
 ['extra attempt field', value => { value.items[0].evidence = {attempts:[{run:1,outcome:'pass',raw:'secret'}]}; }],
 ['nonsequential attempt', value => { value.items[0].evidence = {attempts:[{run:2,outcome:'pass'}]}; }],
 ['excessive attempts', value => { value.items[0].evidence = {attempts:Array.from({length:6},(_,i)=>({run:i+1,outcome:'pass'}))}; }],
 ['measurements on wrong item', value => { value.items[0].evidence = {measurements:[{run:1,firstTokenMs:1,responseMs:2,tokensPerSecond:3}]}; }],
 ['impossible measured timing', value => { value.items.find(item=>item.id==='latency').evidence = {measurements:[{run:1,firstTokenMs:3,responseMs:2,tokensPerSecond:null}]}; }],
])('rejects malformed report: %s', async (_, mutate) => {
 const invalid = report(); mutate(invalid);
 const api = createQualityApi(async()=>json(invalid));
 await expect(api.get(task)).rejects.toThrow(/报告/);
});

test.each([
 ['unknown active item', progress => { progress.itemId = 'unknown'; }],
 ['wrong request stage', progress => { progress.stage = 'baseline'; }],
 ['invented request total', progress => { progress.total = 30; }],
 ['extra active field', progress => { progress.response = 'secret'; }],
])('rejects invalid request progress: %s', async (_, mutate) => {
 const invalid = report('ai','running');
 invalid.progress = [{itemId:'iq-test',stage:'probe',attempt:1,total:3,startedAt:invalid.createdAt}];
 mutate(invalid.progress[0]);
 await expect(createQualityApi(async()=>json(invalid)).get(task)).rejects.toThrow(/报告/);
});

test('rejects a pending snapshot with progress attached to a completed item', async () => {
 const invalid = report('ai','running');
 invalid.progress = [{itemId:'connectivity',stage:'measurement',attempt:1,total:3,startedAt:invalid.createdAt}];
 await expect(createQualityApi(async()=>json(invalid)).get(task)).rejects.toThrow(/报告/);
});
