import React from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import QualityToolsPage from './QualityToolsPage.jsx';
import { catalog, report } from './quality-test-fixtures.js';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
function server({hold=false,kind='ai',failure=false}={}) {
 let current=report(kind,hold?'running':'completed'); const calls=[];
 const json=data=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
 vi.stubGlobal('fetch',vi.fn(async(url,options={})=>{
  calls.push({url,...options,body:options.body?JSON.parse(options.body):undefined});
  if(url==='/api/quality/catalog')return json(catalog);
  if(url==='/api/quality/tasks'||url.endsWith('/retest'))return failure?new Response('upstream-secret',{status:400}):json({id:url.endsWith('/retest')?'task-2':'task-1',accessToken:'memory-token'});
  if(url.endsWith('/cancel')){current=report(kind,'cancelled',{configuration:current.configuration});return json(current);}
  if(url.endsWith('/events'))return new Response(new ReadableStream(),{headers:{'Content-Type':'text/event-stream'}});
  return json({...current,id:url.includes('task-2')?'task-2':'task-1'});
 }));return calls;
}
async function ready(){render(<QualityToolsPage/>);await waitFor(()=>expect(screen.getByRole('button',{name:'展开检测项目'})).toBeEnabled());}
function fill(extra={}){for(const [label,value]of Object.entries({'被测 Base URL':'https://relay.example/v1','API Key':'sk-secret','目标模型':'test-model',...extra}))fireEvent.change(screen.getByLabelText(label,{exact:true}),{target:{value}});}
const start=()=>fireEvent.click(screen.getByRole('button',{name:'开始检测'}));

test.each(['ai','ip'])('keeps %s progress in one task overview once the snapshot arrives',async kind=>{
 server({hold:true,kind});const original=fetch;let finishCreation;
 vi.stubGlobal('fetch',vi.fn((url,options)=>url==='/api/quality/tasks'?new Promise(resolve=>{finishCreation=resolve;}):original(url,options)));
 await ready();
 if(kind==='ai')fill();
 else{fireEvent.click(screen.getByRole('tab',{name:'IP检测'}));fireEvent.change(screen.getByLabelText('IP 地址或 SOCKS5 地址'),{target:{value:'1.2.3.4'}});}
 start();expect(screen.getByRole('heading',{name:'正在创建检测任务'})).toBeVisible();
 await act(async()=>{finishCreation(new Response(JSON.stringify({id:'task-1',accessToken:'memory-token'})));});
 const overview=await screen.findByRole('region',{name:'检测概览'});
 expect(within(overview).getByRole('heading',{name:kind==='ai'?'AI检测中':'IP检测中'})).toBeVisible();
 expect(screen.getAllByRole('region',{name:'检测进度'})).toHaveLength(1);
 fireEvent.click(screen.getByRole('button',{name:'取消检测'}));
 await screen.findByText('检测已取消');
 expect(screen.queryByRole('region',{name:'检测进度'})).not.toBeInTheDocument();
 expect(screen.getByRole('region',{name:'检测概览'})).toBeVisible();
});

test.each([['ai','queued'],['ai','running'],['ip','queued'],['ip','running']])('withholds %s results while %s and shows the final report only after completion',async(kind,state)=>{
 server({hold:true,kind});const original=fetch;let events;
 const tested=state==='queued'?0:1;
 const pending=report(kind,state);
 pending.items=pending.items.map((item,index)=>({...item,status:index<tested?'risk':'unrun',score:index<tested?0:null}));
 pending.summary={score:tested?0:null,tested,risk:tested,unrun:pending.summary.total-tested,unavailable:0,cancelled:0,total:pending.summary.total,overall:tested?'存在风险':'存在未覆盖风险'};
 vi.stubGlobal('fetch',vi.fn((url,options)=>{
  if(url==='/api/quality/tasks/task-1')return Promise.resolve(new Response(JSON.stringify(pending)));
  if(url.endsWith('/events'))return Promise.resolve(new Response(new ReadableStream({start(controller){events=controller;}}),{headers:{'Content-Type':'text/event-stream'}}));
  return original(url,options);
 }));
 await ready();
 if(kind==='ai')fill();
 else{fireEvent.click(screen.getByRole('tab',{name:'IP检测'}));fireEvent.change(screen.getByLabelText('IP 地址或 SOCKS5 地址'),{target:{value:'1.2.3.4'}});}
 start();
 const overview=await screen.findByRole('region',{name:'检测概览'});
 expect(within(overview).getByRole('heading',{name:state==='queued'?'检测任务排队中':kind==='ai'?'AI检测中':'IP检测中'})).toBeVisible();
 expect(within(overview).getAllByText(new RegExp('已完成 '+tested+' 项'))).toHaveLength(1);
 expect(within(overview).queryByText(/风险.*项|未测试.*项|已取消.*项/)).not.toBeInTheDocument();
 expect(screen.queryByRole('heading',{name:pending.summary.overall})).not.toBeInTheDocument();
 expect(document.querySelector('.quality-report-score')).not.toBeInTheDocument();
 expect(screen.queryByRole('button',{name:new RegExp(pending.items[0].label)})).not.toBeInTheDocument();
 expect(screen.queryByText(/问题与未覆盖项/)).not.toBeInTheDocument();
 const indicator=screen.getByRole('progressbar',{name:'检测进度'});
 expect(indicator).not.toHaveAttribute('aria-valuenow');
 expect(indicator).toHaveAttribute('aria-valuetext','已完成 '+tested+' 项 / 本次 '+pending.configuration.selected.length+' 项');
 await waitFor(()=>expect(events).toBeDefined());
 await act(async()=>{events.enqueue(new TextEncoder().encode('data: '+JSON.stringify(report(kind))+'\n\n'));});
 expect(await screen.findByRole('heading',{name:'存在风险'})).toBeVisible();
 expect(screen.queryByRole('region',{name:'检测进度'})).not.toBeInTheDocument();
 expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
 expect(document.querySelector('.quality-report-score strong')).toHaveTextContent(kind==='ai'?'85':'79');
 expect(screen.getAllByRole('button',{name:new RegExp(pending.items[0].label)})[0]).toBeEnabled();
 expect(screen.getByLabelText('已完成 '+report(kind).summary.tested+' 项')).toBeVisible();
});

test('a disconnected running task does not expose its partial report',async()=>{
 server({hold:true});const original=fetch;
 vi.stubGlobal('fetch',vi.fn((url,options)=>url.endsWith('/events')?Promise.resolve(new Response(new ReadableStream({start(controller){controller.close();}}),{headers:{'Content-Type':'text/event-stream'}})):original(url,options)));
 await ready();fill();start();
 await screen.findByRole('heading',{name:'检测进度连接中断'});
 expect(screen.getByRole('progressbar',{name:'检测进度'})).toHaveAttribute('aria-valuetext','检测进度连接中断');
 expect(screen.queryByRole('heading',{name:'存在风险'})).not.toBeInTheDocument();
 expect(document.querySelector('.quality-report-score')).not.toBeInTheDocument();
 expect(screen.queryByRole('button',{name:/基础连通性/})).not.toBeInTheDocument();
 expect(screen.getAllByText(/已完成 \d+ 项/)).toHaveLength(1);
});

test.each(['full','single'])('hides the previous report while creating a %s rerun and restores it if creation fails',async mode=>{
 server();const original=fetch;let rejectCreation;
 await ready();fill();start();await screen.findByRole('heading',{name:'存在风险'});
 if(mode==='single'){fireEvent.click(screen.getAllByRole('button',{name:/工具调用/})[0]);fireEvent.click(screen.getByRole('button',{name:'重新测试此项'}));}
 vi.stubGlobal('fetch',vi.fn((url,options)=>url==='/api/quality/tasks'||url.endsWith('/retest')?new Promise(resolve=>{rejectCreation=resolve;}):original(url,options)));
 fill();fireEvent.click(screen.getByRole('button',{name:mode==='single'?'开始单项重测':'开始检测'}));
 expect(screen.getByRole('heading',{name:'正在创建检测任务'})).toBeVisible();
 expect(screen.queryByRole('heading',{name:'存在风险'})).not.toBeInTheDocument();
 expect(document.querySelector('.quality-report-score')).not.toBeInTheDocument();
 expect(screen.queryByRole('button',{name:/工具调用/})).not.toBeInTheDocument();
 expect(screen.queryByText(/已完成 \d+ 项/)).not.toBeInTheDocument();
 await act(async()=>{rejectCreation(new Response('no',{status:400}));});
 await screen.findByRole('alert');
 expect(screen.getByRole('heading',{name:'存在风险'})).toBeVisible();
 expect(screen.getAllByRole('button',{name:/工具调用/})[0]).toBeEnabled();
});
test('loads dynamic catalog and protects required checks while allowing custom scope',async()=>{
 const calls=server();await ready();await waitFor(()=>expect(calls.some(c=>c.url==='/api/quality/catalog')).toBe(true));
 expect(screen.getByRole('tab',{name:/IP检测/})).toBeInTheDocument();
 const opener=screen.getByRole('button',{name:'展开检测项目'});opener.focus();fireEvent.click(opener);
 const drawer=screen.getByRole('dialog',{name:'选择检测项目'});
 expect(within(drawer).getByRole('button',{name:'关闭检测项目'})).toHaveFocus();
 expect(within(drawer).getByRole('checkbox',{name:/基础连通性/})).toBeDisabled();expect(within(drawer).getByRole('checkbox',{name:/流式协议/})).toBeDisabled();expect(within(drawer).getByRole('checkbox',{name:/逻辑推理/})).toBeChecked();expect(within(drawer).getByRole('checkbox',{name:/PDF/})).not.toBeChecked();expect(drawer).not.toHaveTextContent('%');
 fireEvent.click(within(drawer).getByRole('checkbox',{name:/智商测试/}));fireEvent.click(within(drawer).getByRole('button',{name:'应用设置'}));expect(screen.getByText(/自定义检测/)).toBeInTheDocument();expect(opener).toHaveFocus();
 fireEvent.click(opener);fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
test('validates target credentials and uses built-in checks without an official-key form',async()=>{
 const calls=server();await ready();start();expect(screen.getByRole('alert')).toHaveTextContent('请填写被测 Base URL');fill({'被测 Base URL':'https://user:pass@example.com/v1'});start();expect(screen.getByRole('alert')).toHaveTextContent(/有效.*URL/);
 fill({'API Key':''});start();expect(screen.getByRole('alert')).toHaveTextContent('API Key');fill({'目标模型':''});start();expect(screen.getByRole('alert')).toHaveTextContent('目标模型');fill();
 expect(screen.queryByLabelText('真实性基准')).not.toBeInTheDocument();
 expect(screen.queryByLabelText('官方 API Key')).not.toBeInTheDocument();
 start();await screen.findByText('存在风险');expect(screen.getByLabelText('API Key',{exact:true})).toHaveValue('');
 const submitted=calls.find(c=>c.url==='/api/quality/tasks').body;
 expect(submitted).not.toHaveProperty('official');expect(submitted).not.toHaveProperty('baseline');
 expect(submitted.items).toEqual(expect.arrayContaining(['fingerprint-match']));
});
test('keeps server report identity and scoring independent from the edited form and enables full rerun',async()=>{
 server();const original=fetch;const incomplete=report('ai','completed',{items:report().items.map(item=>item.id==='math-reasoning'?{id:item.id,status:'unrun',score:null,summary:'尚未完成。'}:item)});
 vi.stubGlobal('fetch',vi.fn((url,options)=>url==='/api/quality/tasks/task-1'?Promise.resolve(Response.json(incomplete)):original(url,options)));
 await ready();fill();start();await screen.findByText('存在风险');expect(screen.getByLabelText('已完成 12 项')).toBeVisible();expect(screen.getByLabelText('未测试 1 项')).toBeVisible();fill({'被测 Base URL':'https://other.example/v1'});expect(screen.getByText('https://relay.example/v1')).toBeInTheDocument();
 fireEvent.click(screen.getAllByRole('button',{name:/数学推理/})[0]);fireEvent.click(screen.getByRole('button',{name:'加入完整检测后重跑'}));expect(screen.getByLabelText('检测档位')).toHaveValue('full');expect(screen.getByRole('status')).toHaveTextContent('重新填写');
});
test('cancel retains completed results and uses bearer tokens only in headers',async()=>{
 const calls=server({hold:true});await ready();fill();start();await waitFor(()=>expect(calls.some(c=>c.url.endsWith('/events'))).toBe(true));fireEvent.click(screen.getByRole('button',{name:'取消检测'}));await screen.findByText('检测已取消');expect(screen.getAllByRole('button',{name:/基础连通性/})[0]).toHaveTextContent('90');expect(screen.getAllByText('检测取消').length).toBeGreaterThan(0);expect(screen.getByText('检测未完成')).toBeInTheDocument();expect(calls.filter(c=>c.url.includes('task-1')).every(c=>c.headers.Authorization==='Bearer memory-token')).toBe(true);expect(calls.every(c=>!c.url.includes('memory-token'))).toBe(true);
});
test('single-item retest waits for new credentials without removing other results',async()=>{
 const calls=server();await ready();fill();start();await screen.findByText('存在风险');fireEvent.click(screen.getAllByRole('button',{name:/工具调用/})[0]);fireEvent.click(screen.getByRole('button',{name:'重新测试此项'}));expect(screen.getByRole('status')).toHaveTextContent('重新填写');expect(calls.some(c=>c.url.endsWith('/retest'))).toBe(false);expect(screen.getByLabelText('已完成 13 项')).toBeVisible();fill();fireEvent.click(screen.getByRole('button',{name:'开始单项重测'}));await waitFor(()=>expect(calls.find(c=>c.url.endsWith('/retest'))?.body).toMatchObject({itemIds:['tool-calling'],input:{apiKey:'sk-secret'}}));expect(screen.getByLabelText('API Key',{exact:true})).toHaveValue('');
});
test('renders strict report configuration, coverage and risk before uncovered groups',async()=>{
 const base=report();
 const configured=report('ai','completed',{configuration:{runs:3,mode:'standard',selected:catalog.ai.map(item=>item.id)},progress:[],items:base.items.map(item=>item.id==='model-identity'?{...item,label:'模型名称一致性',status:'risk',score:40,summary:'名称不匹配，来源未验证。',evidence:{attempts:[{run:1,outcome:'mismatch'},{run:2,outcome:'pass'}]}}:item.id==='long-context'?{...item,status:'unrun',score:null,reason:'not-selected',summary:'未选择检测。'}:item)});
 server();const original=fetch;vi.stubGlobal('fetch',vi.fn((url,options)=>url==='/api/quality/tasks/task-1'?Promise.resolve(new Response(JSON.stringify(configured))):original(url,options)));
 await ready();fill();start();await screen.findByRole('heading',{name:'存在风险'});
 expect(screen.getByText(/^覆盖率/)).toBeInTheDocument();expect(screen.getByLabelText('覆盖率 76%')).toBeVisible();expect(screen.queryByRole('region',{name:'评分说明'})).not.toBeInTheDocument();
 const risk=screen.getAllByRole('button',{name:/模型名称一致性/})[0];expect(risk).toHaveTextContent('不匹配');
 expect(screen.getByText(/未覆盖项目/)).toBeInTheDocument();expect(screen.getByText('标准模式')).toBeVisible();expect(screen.getAllByText(/3 次/).length).toBeGreaterThan(1);
});
test('shows evidence categories and measured thresholds in item details',async()=>{
 const base=report();
 const configured=report('ai','completed',{configuration:{runs:2,mode:'quick',selected:catalog.ai.slice(0,2).map(item=>item.id)},progress:[],items:base.items.map(item=>item.id==='tool-calling'?{...item,status:'risk',evidence:{attempts:[{run:1,outcome:'timeout'},{run:2,outcome:'invalid-response'}]}}:item.id==='latency'?{...item,evidence:{measurements:[{run:1,firstTokenMs:5100,responseMs:31000,tokensPerSecond:4}]}}:item)});
 server();const original=fetch;vi.stubGlobal('fetch',vi.fn((url,options)=>url==='/api/quality/tasks/task-1'?Promise.resolve(new Response(JSON.stringify(configured))):original(url,options)));
 await ready();fill();start();await screen.findByRole('heading',{name:'存在风险'});fireEvent.click(screen.getAllByRole('button',{name:/工具调用/})[0]);
 expect(screen.getByText(/超时/)).toBeInTheDocument();expect(screen.getByText(/无效响应/)).toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'关闭检测详情'}));fireEvent.click(screen.getByRole('button',{name:/响应速度/}));expect(screen.getByText(/首 token.*5100.*5000/)).toBeInTheDocument();expect(screen.getByText(/总耗时.*31000.*30000/)).toBeInTheDocument();expect(screen.getByText(/速度.*4.*5/)).toBeInTheDocument();
});
test.each([['fingerprint-match','指纹一致性']])('does not present successful %s sampling as baseline agreement',async(itemId,label)=>{
 const base=report();
 const configured=report('ai','completed',{configuration:{runs:3,mode:'standard',selected:[itemId]},items:base.items.map(item=>item.id===itemId?{id:item.id,status:'risk',score:0,summary:'内置探针的输出指纹存在波动。',evidence:{attempts:Array.from({length:3},(_,index)=>({run:index+1,outcome:'pass'}))}}:item)});
 server();const original=fetch;vi.stubGlobal('fetch',vi.fn((url,options)=>url==='/api/quality/tasks/task-1'?Promise.resolve(new Response(JSON.stringify(configured))):original(url,options)));
 await ready();fill();start();await screen.findByRole('heading',{name:'存在风险'});
 const card=screen.getByRole('button',{name:new RegExp(label)});expect(card).toHaveTextContent('0');fireEvent.click(card);
 const evidence=screen.getByRole('region',{name:'基准采样请求证据'});
 expect(evidence).toHaveTextContent('有效响应 3 次 / 共 3 次采样请求');
 expect(evidence).toHaveTextContent('第 3 次请求：有效响应');
 expect(evidence).toHaveTextContent('采样成功仅表示取得有效响应，不代表与基准一致；一致性结论以本项评分和摘要为准。');
 expect(evidence).not.toHaveTextContent('通过');
});

test.each([':::1','2001:db8:::1','999.1.2.3','01.2.3.4','socks5://host:0','socks5://host:65536','socks5://host:1080/path'])('rejects malformed IP/proxy %s',async target=>{server({kind:'ip'});await ready();fireEvent.click(screen.getByRole('tab',{name:/IP检测/}));fireEvent.change(screen.getByLabelText('IP 地址或 SOCKS5 地址'),{target:{value:target}});start();expect(screen.getByRole('alert')).toHaveTextContent('有效的 IP 地址或 SOCKS5 地址');});
test('clears SOCKS credentials and shows server applicability',async()=>{server({kind:'ip'});await ready();fireEvent.click(screen.getByRole('tab',{name:/IP检测/}));const input=screen.getByLabelText('IP 地址或 SOCKS5 地址');fireEvent.change(input,{target:{value:'socks5://user:proxy-secret@proxy.example:1080'}});expect(screen.getByText('已识别：SOCKS5 代理')).toBeInTheDocument();start();await screen.findByText('存在风险');expect(input).toHaveValue('');expect(screen.getAllByText('需 SOCKS5').length).toBeGreaterThan(0);expect(screen.getByText('1.2.3.4')).toBeInTheDocument();});
test('switching tools preserves each form and the custom AI scope in separate accessible panels',async()=>{
 server();await ready();fill({'API Key':''});
 fireEvent.change(screen.getByLabelText('检测档位'),{target:{value:'full'}});
 fireEvent.change(screen.getByLabelText('检测次数'),{target:{value:'5'}});
 fireEvent.click(screen.getByRole('button',{name:'展开检测项目'}));
 fireEvent.click(screen.getByRole('checkbox',{name:'智商测试'}));
 fireEvent.click(screen.getByRole('button',{name:'应用设置'}));
 const aiPanel=screen.getByRole('tabpanel',{name:'AI检测'});
 const aiTab=screen.getByRole('tab',{name:'AI检测'});
 const ipTab=screen.getByRole('tab',{name:'IP检测'});
 fireEvent.click(ipTab);
 expect(aiPanel).toBeInTheDocument();expect(aiPanel).not.toBeVisible();expect(aiPanel).toHaveAttribute('inert');
 expect(screen.queryByRole('textbox',{name:'被测 Base URL'})).not.toBeInTheDocument();
 const ipPanel=screen.getByRole('tabpanel',{name:'IP检测'});
 expect(aiTab).toHaveAttribute('aria-controls',aiPanel.id);expect(ipTab).toHaveAttribute('aria-controls',ipPanel.id);expect(aiPanel.id).not.toBe(ipPanel.id);
 fireEvent.change(screen.getByLabelText('IP 地址或 SOCKS5 地址'),{target:{value:'8.8.8.8'}});
 fireEvent.click(aiTab);
 expect(screen.getByLabelText('被测 Base URL')).toHaveValue('https://relay.example/v1');expect(screen.getByLabelText('目标模型')).toHaveValue('test-model');
 expect(screen.getByLabelText('检测档位')).toHaveValue('full');expect(screen.getByLabelText('检测次数')).toHaveValue('5');
 expect(screen.getByText('自定义检测 · 16 项检测')).toBeVisible();
 fireEvent.click(screen.getByRole('button',{name:'展开检测项目'}));expect(screen.getByRole('checkbox',{name:'智商测试'})).not.toBeChecked();
 fireEvent.click(screen.getByRole('button',{name:'关闭检测项目'}));fireEvent.click(ipTab);
 expect(screen.getByLabelText('IP 地址或 SOCKS5 地址')).toHaveValue('8.8.8.8');expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
});

test.each(['ai','ip'])('switching away from %s keeps observation alive and retains its background completion',async kind=>{
 const calls=server({hold:true,kind});const original=fetch;let events;let streamSignal;
 vi.stubGlobal('fetch',vi.fn((url,options)=>{
  if(url.endsWith('/events')){streamSignal=options.signal;return Promise.resolve(new Response(new ReadableStream({start(controller){events=controller;}}),{headers:{'Content-Type':'text/event-stream'}}));}
  return original(url,options);
 }));
 await ready();
 const taskTab=screen.getByRole('tab',{name:kind==='ai'?'AI检测':'IP检测'});
 const otherTab=screen.getByRole('tab',{name:kind==='ai'?'IP检测':'AI检测'});
 fireEvent.click(taskTab);
 if(kind==='ai')fill();else fireEvent.change(screen.getByLabelText('IP 地址或 SOCKS5 地址'),{target:{value:'1.2.3.4'}});
 start();await waitFor(()=>expect(events).toBeDefined());fireEvent.click(otherTab);
 expect(streamSignal.aborted).toBe(false);expect(calls.some(call=>call.url.endsWith('/cancel'))).toBe(false);
 expect(taskTab).toHaveAccessibleDescription('检测中');expect(screen.queryByRole('region',{name:'检测进度'})).not.toBeInTheDocument();
 await act(async()=>{events.enqueue(new TextEncoder().encode('data: '+JSON.stringify(report(kind))+'\n\n'));});
 expect(screen.queryByRole('region',{name:'检测报告'})).not.toBeInTheDocument();
 fireEvent.click(taskTab);expect(screen.getByRole('heading',{name:'存在风险'})).toBeVisible();expect(taskTab).not.toHaveAccessibleDescription('检测中');
 expect(screen.getByRole('region',{name:'检测报告'})).toHaveTextContent(kind==='ai'?'85':'79');
 fireEvent.click(otherTab);fireEvent.click(taskTab);expect(screen.getByRole('heading',{name:'存在风险'})).toBeVisible();
 expect(calls.filter(call=>call.url==='/api/quality/tasks')).toHaveLength(1);expect(calls.some(call=>call.url.endsWith('/cancel'))).toBe(false);
});

test.each(['ai','ip'])('explicit cancel still stops %s after switching back',async kind=>{
 const calls=server({hold:true,kind});await ready();
 const taskTab=screen.getByRole('tab',{name:kind==='ai'?'AI检测':'IP检测'});
 const otherTab=screen.getByRole('tab',{name:kind==='ai'?'IP检测':'AI检测'});
 fireEvent.click(taskTab);if(kind==='ai')fill();else fireEvent.change(screen.getByLabelText('IP 地址或 SOCKS5 地址'),{target:{value:'1.2.3.4'}});
 start();await waitFor(()=>expect(calls.some(call=>call.url.endsWith('/events'))).toBe(true));
 fireEvent.click(otherTab);fireEvent.click(taskTab);fireEvent.click(screen.getByRole('button',{name:'取消检测'}));
 expect(await screen.findByText('检测已取消')).toBeVisible();expect(calls.filter(call=>call.url.endsWith('/cancel'))).toHaveLength(1);
 expect(calls.find(call=>call.url.endsWith('/events')).signal.aborted).toBe(true);
});

test('switching tools closes native dialogs before hiding their panel',async()=>{
 server();await ready();fireEvent.click(screen.getByRole('button',{name:'展开检测项目'}));
 const drawer=screen.getByRole('dialog');fireEvent.click(screen.getByRole('tab',{name:'IP检测'}));expect(drawer.open).toBe(false);expect(document.querySelector('dialog[open]')).toBeNull();
 fireEvent.click(screen.getByRole('tab',{name:'AI检测'}));
 if(screen.queryByRole('dialog'))fireEvent.click(screen.getByRole('button',{name:'关闭检测项目'}));
 fill();start();await screen.findByText('存在风险');fireEvent.click(screen.getAllByRole('button',{name:/工具调用/})[0]);
 const detail=screen.getByRole('dialog');fireEvent.click(screen.getByRole('tab',{name:'IP检测'}));expect(detail.open).toBe(false);expect(document.querySelector('dialog[open]')).toBeNull();
});

test('leaving the page still aborts observation and cancels a hidden running task',async()=>{
 const calls=server({hold:true});await ready();fill();start();await waitFor(()=>expect(calls.some(call=>call.url.endsWith('/events'))).toBe(true));
 fireEvent.click(screen.getByRole('tab',{name:'IP检测'}));expect(calls.some(call=>call.url.endsWith('/cancel'))).toBe(false);
 cleanup();expect(calls.find(call=>call.url.endsWith('/events')).signal.aborted).toBe(true);expect(calls.filter(call=>call.url.endsWith('/cancel'))).toHaveLength(1);
});
test('API errors are actionable and never reflect upstream secrets',async()=>{server({failure:true});await ready();fill();start();expect(await screen.findByRole('alert')).toHaveTextContent(/检查.*配置/);expect(document.body).not.toHaveTextContent('upstream-secret');expect(screen.getByRole('button',{name:'开始检测'})).toBeEnabled();});

test.each([['quick',4],['standard',13],['full',17]])('submits the %s scope from catalog with required probes',async(mode,count)=>{
 const calls=server();await ready();fill();fireEvent.change(screen.getByLabelText('检测档位'),{target:{value:mode}});start();await screen.findByText('存在风险');
 const input=calls.find(c=>c.url==='/api/quality/tasks').body;expect(input.mode).toBe(mode);expect(input.items).toHaveLength(count);expect(input.items).toEqual(expect.arrayContaining(['connectivity','streaming']));
});
test('drawer traps keyboard focus and detail Escape restores its invoking card',async()=>{
 server();await ready();fireEvent.click(screen.getByRole('button',{name:'展开检测项目'}));let dialog=screen.getByRole('dialog');
 const close=within(dialog).getByRole('button',{name:'关闭检测项目'});const apply=within(dialog).getByRole('button',{name:'应用设置'});close.focus();fireEvent.keyDown(dialog,{key:'Tab',shiftKey:true});expect(apply).toHaveFocus();fireEvent.keyDown(dialog,{key:'Tab'});expect(close).toHaveFocus();fireEvent.keyDown(dialog,{key:'Escape'});
 fill();start();await screen.findByText('存在风险');const card=screen.getAllByRole('button',{name:/工具调用/})[0];card.focus();fireEvent.click(card);dialog=screen.getByRole('dialog');fireEvent.keyDown(dialog,{key:'Escape'});expect(card).toHaveFocus();
});
test('a disconnected task can be discarded to allow correcting configuration',async()=>{
 const calls=server({hold:true});const original=fetch;vi.stubGlobal('fetch',vi.fn(async(url,options)=>url.endsWith('/events')?new Response(new ReadableStream({start(c){c.close();}}),{headers:{'Content-Type':'text/event-stream'}}):original(url,options)));
 await ready();fill();start();await screen.findByRole('button',{name:'重新连接'});fireEvent.click(screen.getByRole('button',{name:'重新配置'}));expect(screen.getByRole('button',{name:'开始检测'})).toBeEnabled();expect(screen.queryByRole('heading',{name:'检测进度连接中断'})).not.toBeInTheDocument();
});
test('a failed new submission cannot change the saved target of the previous report',async()=>{
 server();await ready();fill();start();await screen.findByText('存在风险');const original=fetch;vi.stubGlobal('fetch',vi.fn(async(url,options)=>url==='/api/quality/tasks'?new Response('no',{status:400}):original(url,options)));
 fill({'被测 Base URL':'https://failed.example/v1'});start();await screen.findByRole('alert');fireEvent.click(screen.getAllByRole('button',{name:/工具调用/})[0]);fireEvent.click(screen.getByRole('button',{name:'重新测试此项'}));expect(screen.getByLabelText('被测 Base URL')).toHaveValue('https://relay.example/v1');
});
test('single-item retest refuses a different target to protect the parent report',async()=>{
 const calls=server();await ready();fill();start();await screen.findByText('存在风险');fireEvent.click(screen.getAllByRole('button',{name:/工具调用/})[0]);fireEvent.click(screen.getByRole('button',{name:'重新测试此项'}));fill({'被测 Base URL':'https://different.example/v1'});fireEvent.click(screen.getByRole('button',{name:'开始单项重测'}));expect(screen.getByRole('alert')).toHaveTextContent(/原.*目标/);expect(calls.some(c=>c.url.endsWith('/retest'))).toBe(false);
});
test.each(['socks5://user@host:1080','socks5://:pass@host:1080','socks5://user:pa%00ss@host:1080'])('rejects incomplete or control-character SOCKS credentials %s',async target=>{
 server({kind:'ip'});await ready();fireEvent.click(screen.getByRole('tab',{name:/IP检测/}));fireEvent.change(screen.getByLabelText('IP 地址或 SOCKS5 地址'),{target:{value:target}});start();expect(screen.getByRole('alert')).toHaveTextContent('有效的 IP 地址或 SOCKS5 地址');
});

test('a late create response after switching tools stays with its original tool',async()=>{
 const calls=server();const original=fetch;let resolveCreation;let creationSignal;
 vi.stubGlobal('fetch',vi.fn((url,options)=>url==='/api/quality/tasks'?new Promise(resolve=>{resolveCreation=resolve;creationSignal=options.signal;}):original(url,options)));
 await ready();fill();start();fireEvent.click(screen.getByRole('tab',{name:'IP检测'}));expect(creationSignal.aborted).toBe(false);
 await act(async()=>{resolveCreation(Response.json({id:'task-1',accessToken:'memory-token'}));});
 expect(calls.some(call=>call.url.endsWith('/cancel'))).toBe(false);expect(screen.queryByRole('region',{name:'检测报告'})).not.toBeInTheDocument();
 expect(screen.getByLabelText('IP 地址或 SOCKS5 地址')).toHaveValue('');
 fireEvent.click(screen.getByRole('tab',{name:'AI检测'}));expect(await screen.findByRole('heading',{name:'存在风险'})).toBeVisible();
});

test('a late create response after leaving the page is cancelled',async()=>{
 const calls=server();const original=fetch;let resolveCreation;
 vi.stubGlobal('fetch',vi.fn((url,options)=>url==='/api/quality/tasks'?new Promise(resolve=>{resolveCreation=resolve;}):original(url,options)));
 await ready();fill();start();cleanup();
 await act(async()=>{resolveCreation(new Response(JSON.stringify({id:'late-ai',accessToken:'late-token'})));});
 await waitFor(()=>expect(calls.some(c=>c.url==='/api/quality/tasks/late-ai/cancel')).toBe(true));
 expect(screen.queryByRole('region',{name:'检测报告'})).not.toBeInTheDocument();
});
test('completed retest preserves unrelated cards and uses the server summary',async()=>{
 server();const original=fetch;const revised=report('ai','completed',{id:'task-2',configuration:{runs:3,mode:'standard',selected:['tool-calling']},items:report().items.map(i=>i.id==='tool-calling'?{...i,status:'pass',score:99,summary:'重测已通过。'}:i)});
 vi.stubGlobal('fetch',vi.fn((url,options)=>url==='/api/quality/tasks/task-2'?Promise.resolve(new Response(JSON.stringify(revised))):original(url,options)));
 await ready();fill();start();await screen.findByText('存在风险');fireEvent.click(screen.getAllByRole('button',{name:/工具调用/})[0]);fireEvent.click(screen.getByRole('button',{name:'重新测试此项'}));fill();fireEvent.click(screen.getByRole('button',{name:'开始单项重测'}));await screen.findByRole('heading',{name:'通过'});
 expect(screen.getAllByRole('button',{name:/工具调用/})[0]).toHaveTextContent('99');expect(screen.getAllByRole('button',{name:/智商测试/})[0]).toHaveTextContent('90');expect(screen.getByText('报告累计 13 项')).toBeInTheDocument();expect(screen.getByText('91')).toBeInTheDocument();
});
test('catalog errors can be retried without loading fixture data',async()=>{
 server();const original=fetch;let fail=true;vi.stubGlobal('fetch',vi.fn((url,options)=>url==='/api/quality/catalog'&&fail?Promise.resolve(new Response('private',{status:503})):original(url,options)));
 render(<QualityToolsPage/>);await screen.findByRole('alert');expect(screen.queryByRole('button',{name:'开始检测'})).not.toBeInTheDocument();fail=false;fireEvent.click(screen.getByRole('button',{name:'重新加载检测项目'}));await screen.findByRole('button',{name:'开始检测'});
});
test('completed failure remains actionable and null score displays no fabricated score',async()=>{
 server();const original=fetch;const failed=report('ai','failed',{items:catalog.ai.map(item=>({id:item.id,status:'unrun',score:null,summary:'任务失败，尚未执行。'}))});vi.stubGlobal('fetch',vi.fn((url,options)=>url==='/api/quality/tasks/task-1'?Promise.resolve(new Response(JSON.stringify(failed))):original(url,options)));
 await ready();fill();start();await screen.findByText('检测失败');expect(screen.getByRole('button',{name:'开始检测'})).toBeEnabled();expect(document.querySelector('.quality-report-score strong')).toHaveTextContent('--');
});


test('discarding a disconnected retest resets its pending item selection',async()=>{
 server();const original=fetch;let retesting=false;vi.stubGlobal('fetch',vi.fn((url,options)=>{if(url.endsWith('/retest'))retesting=true;if(retesting&&url==='/api/quality/tasks/task-2')return Promise.resolve(new Response(JSON.stringify(report('ai','running',{id:'task-2'}))));if(url.endsWith('/events'))return Promise.resolve(new Response(new ReadableStream({start(c){c.close();}}),{headers:{'Content-Type':'text/event-stream'}}));return original(url,options);}));
 await ready();fill();start();await screen.findByText('存在风险');fireEvent.click(screen.getAllByRole('button',{name:/工具调用/})[0]);fireEvent.click(screen.getByRole('button',{name:'重新测试此项'}));fill();fireEvent.click(screen.getByRole('button',{name:'开始单项重测'}));await screen.findByRole('button',{name:'重新配置'});fireEvent.click(screen.getByRole('button',{name:'重新配置'}));expect(screen.getByRole('button',{name:'开始检测'})).toBeEnabled();
});
