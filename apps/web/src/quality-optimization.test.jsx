import React from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import QualityToolsPage from './QualityToolsPage.jsx';
import { report, catalog } from './quality-test-fixtures.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function mockReport(snapshot) {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    calls.push({ url, body: options.body ? JSON.parse(options.body) : undefined });
    if (url === '/api/quality/catalog') return Response.json(catalog);
    if (url === '/api/quality/tasks' || url.endsWith('/retest')) return Response.json({ id: 'task-1', accessToken: 'local-test-token' });
    if (url.endsWith('/events')) return new Response(new ReadableStream(), { headers: { 'Content-Type': 'text/event-stream' } });
    return Response.json(snapshot);
  }));
  return calls;
}
async function startReport(snapshot, ipTarget = '1.2.3.4') {
  const calls = mockReport(snapshot);
  render(<QualityToolsPage />);
  await waitFor(() => expect(screen.getByRole('button', { name: '开始检测' })).toBeEnabled());
  if (snapshot.kind === 'ip') {
    fireEvent.click(screen.getByRole('tab', {name:'IP检测'}));
    fireEvent.change(screen.getByLabelText('IP 地址或 SOCKS5 地址'), {target:{value:ipTarget}});
  } else for (const [label, value] of Object.entries({ '被测 Base URL': 'https://relay.example/v1', 'API Key': 'local-test-key', '目标模型': 'test-model' })) {
      fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value } });
    }
  fireEvent.click(screen.getByRole('button', { name: '开始检测' }));
  await screen.findByRole('heading', { name: snapshot.state === 'running' ? (snapshot.kind === 'ai' ? 'AI检测中' : 'IP检测中') : snapshot.summary.overall });
  return calls;
}

test('AI report separates coverage from score and exposes a risk-only retest action', async () => {
  await startReport(report());
  expect(screen.getByText(/^覆盖率/)).toBeVisible();
  expect(screen.getByRole('button', { name: '重测风险项' })).toBeEnabled();
  expect(document.body).not.toHaveTextContent('需 SOCKS5');
});

test('standard report counts its 13 checks without treating full-mode checks as uncovered', async () => {
  await startReport(report());
  const overview = screen.getByRole('region', {name:'检测概览'});
  expect(overview).toHaveAttribute('data-tone', 'risk');
  expect(within(overview).getByRole('heading', {name:'存在风险'})).toBeVisible();
  expect(within(overview).getByLabelText('已测项目评分：85')).toBeVisible();
  expect(within(overview).getByLabelText('已完成 13 项')).toBeVisible();
  expect(within(overview).getByLabelText('未测试 0 项')).toBeVisible();
  expect(within(overview).getByLabelText('覆盖率 100%')).toBeVisible();
  expect(overview).toHaveTextContent('检测范围 13 项');
  expect(overview).not.toHaveTextContent('共 17 项');
  expect(screen.queryByRole('region', {name:'评分说明'})).not.toBeInTheDocument();
  expect(document.body).not.toHaveTextContent(/分组加权|组内平均|重新归一/);
  const risks = screen.getByRole('region', {name:'风险项'});
  expect(screen.queryByRole('region', {name:'未覆盖项目'})).not.toBeInTheDocument();
  expect(screen.queryByRole('button', {name:/长上下文/})).not.toBeInTheDocument();
  expect(within(risks).getByRole('button', {name:/工具调用/})).toBeVisible();
  expect(screen.getByRole('region', {name:'推理能力'})).toHaveTextContent('智商测试');
  expect(within(overview).getByLabelText('报告时间')).toHaveAttribute('dateTime', '2026-09-26T00:00:12.000Z');
});

test.each([['pass','名称匹配'],['risk','名称不匹配']])('model identity %s comes from status and warns about unverified source', async (status, label) => {
  const base = report();
  const snapshot = report('ai','completed',{items:base.items.map(item=>item.id==='model-identity'?{...item,status,summary:'服务端检测结论。'}:item)});
  await startReport(snapshot);
  const card = screen.getAllByRole('button',{name:/模型名称一致性/})[0];
  expect(card).toHaveTextContent(label);
  expect(card).toHaveTextContent('来源未验证');
  fireEvent.click(card);
  expect(screen.getByRole('dialog')).toHaveTextContent(/名称一致.*来源/);
});

test('IP report omits scoring prose and AI configuration metadata', async () => {
  await startReport(report('ip'));
  expect(screen.queryByRole('region',{name:'评分说明'})).not.toBeInTheDocument();
  const overview = screen.getByRole('region',{name:'检测概览'});
  expect(overview).not.toHaveTextContent(/检测模式|基准：|未知/);
  expect(overview).toHaveTextContent('3 次');
});

test('details show each validated outcome and nullable latency evidence with exact thresholds', async () => {
  const base = report();
  const snapshot = report('ai','completed',{items:base.items.map(item=>item.id==='latency'?{...item,evidence:{measurements:[{run:1,firstTokenMs:null,responseMs:31000,tokensPerSecond:null},{run:2,firstTokenMs:5100,responseMs:10000,tokensPerSecond:4}]}}:item)});
  await startReport(snapshot);
  fireEvent.click(screen.getAllByRole('button',{name:/工具调用/})[0]);
  let dialog = screen.getByRole('dialog');
  expect(dialog).toHaveTextContent('第 1 轮：通过');
  expect(dialog).toHaveTextContent('第 2 轮：超时');
  expect(dialog).toHaveTextContent('第 3 轮：无效响应');
  fireEvent.click(within(dialog).getByRole('button',{name:'关闭检测详情'}));
  fireEvent.click(screen.getAllByRole('button',{name:/响应速度/})[0]);
  dialog = screen.getByRole('dialog');
  expect(dialog).toHaveTextContent(/首 token.*未取得.*≤ 5000 ms/);
  expect(dialog).toHaveTextContent(/总耗时.*31000.*≤ 30000 ms/);
  expect(dialog).toHaveTextContent(new RegExp('速度.*未取得.*≥ 5 token/s'));
  expect(dialog).toHaveTextContent(/第 2 轮.*5100.*10000.*4/);
});

test('built-in check retest restores the target and needs only the target key', async () => {
  const calls = await startReport(report());
  fireEvent.change(screen.getByLabelText('被测 Base URL'),{target:{value:'https://edited.example/v1'}});
  fireEvent.change(screen.getByLabelText('检测档位'),{target:{value:'quick'}});
  fireEvent.click(screen.getAllByRole('button',{name:/指纹一致性/})[0]);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'重新测试此项'}));
  expect(screen.getByLabelText('被测 Base URL')).toHaveValue('https://relay.example/v1');
  expect(screen.getByLabelText('检测档位')).toHaveValue('standard');
  expect(screen.queryByLabelText('真实性基准')).not.toBeInTheDocument();
  expect(screen.getByLabelText('API Key',{exact:true})).toHaveValue('');
  fireEvent.change(screen.getByLabelText('API Key',{exact:true}),{target:{value:'new-key'}});
  fireEvent.click(screen.getByRole('button',{name:'开始单项重测'}));
  await waitFor(()=>expect(calls.filter(call=>call.url.endsWith('/retest'))).toHaveLength(1));
  const submitted=calls.find(call=>call.url.endsWith('/retest')).body;
  expect(submitted).toMatchObject({itemIds:['fingerprint-match'],input:{apiKey:'new-key'}});
  expect(submitted.input).not.toHaveProperty('official');expect(submitted.input).not.toHaveProperty('baseline');
});

test('unsupported item offers explanation without a futile retest or include action', async () => {
  const base = report();
  await startReport(report('ai','completed',{items:base.items.map(item=>item.id==='pdf'?{...item,reason:'unsupported',summary:'该模型未声明 PDF 能力。'}:item)}));
  fireEvent.click(screen.getAllByRole('button',{name:/PDF/})[0]);
  const dialog = screen.getByRole('dialog');
  expect(dialog).toHaveTextContent(/暂不支持.*能力/);
  expect(within(dialog).queryByRole('button',{name:/重新测试|加入.*检测/})).not.toBeInTheDocument();
});

test('running report shows every active request, selected completions, results and a live task timer', async () => {
  const createdAt = new Date(Date.now()-7000).toISOString();
  const base = report('ai','running');
  const snapshot = report('ai','running',{createdAt,configuration:{...base.configuration,selected:['iq-test','fingerprint-match','math-reasoning','logic-reasoning']},items:base.items.map(item=>item.id==='iq-test'?{...item,status:'risk',score:0,summary:'第 1 轮答案无效。',evidence:{attempts:[{run:1,outcome:'invalid-response'}]}}:item.id==='fingerprint-match'?{...item,reason:'unsupported'}:item),progress:['math-reasoning','logic-reasoning'].map((itemId,index)=>({itemId,stage:'probe',attempt:index+1,total:3,startedAt:new Date().toISOString()}))});
  await startReport(snapshot);
  expect(screen.getByText('已完成 2 项 / 本次 4 项')).toBeVisible();
  const active = screen.getByRole('list',{name:'当前请求'});
  expect(active).toHaveTextContent(new RegExp('数学推理.*第 1/3 轮'));
  expect(active).toHaveTextContent(new RegExp('逻辑推理.*第 2/3 轮'));
  const results = screen.getByRole('region',{name:'已完成结果'});
  expect(results).toHaveTextContent('智商测试');
  expect(results).toHaveTextContent('第 1 轮答案无效。');
  expect(results).toHaveTextContent('暂不支持');
  expect(results).not.toHaveTextContent('基础连通性');
  expect(screen.getByText(/已耗时 7 秒/)).toBeVisible();
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(createdAt) + 10000);
  await waitFor(()=>expect(screen.getByText(/已耗时 10 秒/)).toBeVisible(), {timeout:1800});
});

test('risk retest submits all risk IDs only after credentials are refilled', async () => {
  const snapshot = report('ai','completed',{items:report().items.map(item=>item.id==='math-reasoning'?{...item,status:'risk',score:30}:item)});
  const calls = await startReport(snapshot);
  fireEvent.click(screen.getByRole('button', { name: '重测风险项' }));
  expect(calls.filter(call => call.url.endsWith('/retest'))).toHaveLength(0);
  expect(screen.getByLabelText('API Key', { exact: true })).toHaveValue('');
  fireEvent.change(screen.getByLabelText('API Key', { exact: true }), { target: { value: 'new-local-key' } });
  fireEvent.click(screen.getByRole('button', { name: '开始风险重测' }));
  await waitFor(() => expect(calls.find(call => call.url.endsWith('/retest'))?.body).toMatchObject({
    itemIds: snapshot.items.filter(item => item.status === 'risk').map(item => item.id),
    input: { apiKey: 'new-local-key' },
  }));
  expect(screen.getByLabelText('API Key', { exact: true })).toHaveValue('');
});

test('retained results are disclosed without implying every card used the current runs', async () => {
  const snapshot = report('ai','completed',{configuration:{runs:1,mode:'quick',selected:['tool-calling']},items:report().items.map(item=>item.id==='tool-calling'?{...item,evidence:{attempts:[{run:1,outcome:'timeout'}]}}:item)});
  await startReport(snapshot);
  const overview = screen.getByRole('region',{name:'检测概览'});
  expect(overview).toHaveTextContent('本次 1 次');
  expect(overview).toHaveTextContent('检测范围 1 项');
  expect(overview).toHaveTextContent('报告累计 13 项');
  expect(within(overview).getByLabelText('覆盖率 100%')).toBeVisible();
  expect(overview).toHaveTextContent(/保留.*既有结果.*此前检测/);
});

test('checks outside the report scope can be selected in the drawer for a new report', async () => {
  const calls = await startReport(report());
  fireEvent.click(screen.getByRole('button',{name:'展开检测项目'}));
  fireEvent.click(screen.getByRole('checkbox',{name:/长上下文/}));
  fireEvent.click(screen.getByRole('button',{name:/应用/}));
  expect(calls.filter(call=>call.url==='/api/quality/tasks')).toHaveLength(1);
  expect(screen.getByLabelText('API Key',{exact:true})).toHaveValue('');
  fireEvent.change(screen.getByLabelText('API Key',{exact:true}),{target:{value:'refilled-key'}});
  fireEvent.click(screen.getByRole('button',{name:'开始检测'}));
  await waitFor(()=>expect(calls.filter(call=>call.url==='/api/quality/tasks')).toHaveLength(2));
  expect(calls.filter(call=>call.url==='/api/quality/tasks')[1].body.items).toContain('long-context');
  expect(calls.filter(call=>call.url.endsWith('/retest'))).toHaveLength(0);
});

test('IP risk batch retest waits for fresh SOCKS credentials and sends only risk IDs', async () => {
  const snapshot = report('ip','completed',{target:'socks5://proxy.example:1080'});
  const calls = await startReport(snapshot, 'socks5://user:secret@proxy.example:1080');
  fireEvent.click(screen.getByRole('button',{name:'重测风险项'}));
  expect(screen.getByLabelText('IP 地址或 SOCKS5 地址')).toHaveValue('');
  expect(calls.some(call=>call.url.endsWith('/retest'))).toBe(false);
  fireEvent.change(screen.getByLabelText('IP 地址或 SOCKS5 地址'),{target:{value:'socks5://user:new-secret@proxy.example:1080'}});
  fireEvent.click(screen.getByRole('button',{name:'开始风险重测'}));
  await waitFor(()=>expect(calls.find(call=>call.url.endsWith('/retest'))?.body).toMatchObject({itemIds:['risk-score'],input:{target:'socks5://user:new-secret@proxy.example:1080'}}));
  expect(screen.getByLabelText('IP 地址或 SOCKS5 地址')).toHaveValue('');
});

test.each([['fingerprint-match','指纹一致性']])('uncovered %s never asks customers for an official key',async(id,label)=>{
  const base=report();
  await startReport(report('ai','completed',{items:base.items.map(item=>item.id===id?{id,status:'unrun',score:null,reason:'unsupported',summary:'内置指纹库暂未覆盖此模型。'}:item)}));
  const overview = screen.getByRole('region', {name:'检测概览'});
  expect(within(overview).getByLabelText('未测试 1 项')).toBeVisible();
  expect(within(overview).getByLabelText('覆盖率 92%')).toBeVisible();
  const uncovered = screen.getByRole('region', {name:'未覆盖项目'});
  expect(screen.getByRole('region', {name:'风险项'}).compareDocumentPosition(uncovered) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(uncovered).getAllByRole('button')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button',{name:new RegExp(label)}));
  const dialog=screen.getByRole('dialog');
  expect(dialog).toHaveTextContent('内置指纹库尚未覆盖目标模型');
  expect(within(dialog).queryByRole('button',{name:/重新测试|加入.*检测|配置/})).not.toBeInTheDocument();
  expect(document.body).not.toHaveTextContent(/官方.*Key|真实性基准|平台基准/);
});
