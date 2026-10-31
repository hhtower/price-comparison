import React from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { emptyShoppingNeeds } from '@price-comparison/catalog/assistant-contract';
import AssistantPage from './AssistantPage.jsx';
import App from './App.jsx';

const sessionId = '11111111-1111-4111-8111-111111111111';
const credentials = { sessionId, accessToken: 'private-token' };
const turn = overrides => ({
  id: '1', sessionId, clientMessageId: '22222222-2222-4222-8222-222222222222', inputText: '写代码',
  expectedRevision: 0, eventVersion: 1, status: 'queued', phase: 'queued', reply: null, errorCode: null, ...overrides,
});
const reply = { kind: 'question', text: '预算大概是多少？', options: ['50元以内', '暂不限制'], needs: emptyShoppingNeeds(), cards: [] };
const done = turn({ status: 'succeeded', phase: 'succeeded', eventVersion: 2, reply });
function mockApi(overrides = {}) {
  return {
    status: vi.fn(async () => ({ enabled: true })),
    createSession: vi.fn(async () => ({ ...credentials, revision: 0 })),
    readSession: vi.fn(async () => ({ id: sessionId, revision: 0, needs: emptyShoppingNeeds(), turns: [] })),
    sendTurn: vi.fn(async (_credentials, input) => ({ snapshot: turn({ clientMessageId: input.clientMessageId, inputText: input.text }), created: true })),
    subscribeTurn: vi.fn(async (_credentials, active, onSnapshot) => {
      const result = { ...done, clientMessageId: active.clientMessageId, inputText: active.inputText };
      onSnapshot(result); return result;
    }),
    cancelTurn: vi.fn(async () => turn({ status: 'cancelled', phase: 'cancelled', eventVersion: 2 })),
    deleteSession: vi.fn(async () => {}),
    ...overrides,
  };
}
afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });

test('connecting lets users type and retains the draft when the conversation becomes ready', async () => {
  let connect;
  const api = mockApi({ createSession: vi.fn(() => new Promise(resolve => { connect = resolve; })) });
  render(<AssistantPage api={api} enabled />);
  const input = screen.getByRole('textbox', { name: '先写下需求' });
  fireEvent.change(input, { target: { value: '每月50元，写代码用' } });
  expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
  expect(screen.getByRole('heading', { name: '想用来做什么？' })).toBeVisible();
  await act(async () => connect({ ...credentials, revision: 0 }));
  expect(await screen.findByRole('textbox', { name: '告诉助手你的需求' })).toHaveValue('每月50元，写代码用');
  expect(api.sendTurn).not.toHaveBeenCalled();
});

test('connection failure preserves draft and the retry stays within the welcome surface', async () => {
  let fail;
  const api = mockApi({ createSession: vi.fn().mockImplementationOnce(() => new Promise((_resolve, reject) => {
    fail = reject;
  })).mockResolvedValue({ ...credentials, revision: 0 }) });
  render(<AssistantPage api={api} enabled />);
  fireEvent.change(screen.getByRole('textbox', { name: '先写下需求' }), { target: { value: '预算50元' } });
  await act(async () => fail(new Error('连接失败')));
  expect(screen.getByRole('textbox', { name: '先写下需求' })).toHaveValue('预算50元');
  expect(screen.getByRole('heading', { name: '想用来做什么？' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '重试连接' }));
  expect(await screen.findByRole('textbox', { name: '告诉助手你的需求' })).toHaveValue('预算50元');
});

test('platform chip and settings share state, track catalog changes, and control sent context', async () => {
  const api = mockApi();
  const view = render(<AssistantPage api={api} embedded catalogPlatform="anthropic" />);
  await screen.findByRole('textbox', { name: '告诉助手你的需求' });
  fireEvent.click(screen.getByRole('button', { name: '不参考 Claude' }));
  fireEvent.click(screen.getByRole('button', { name: '设置' }));
  expect(screen.getByRole('checkbox', { name: '识别当前筛选' })).not.toBeChecked();
  fireEvent.click(screen.getByRole('checkbox', { name: '识别当前筛选' }));
  expect(screen.getByRole('button', { name: '不参考 Claude' })).toBeVisible();
  view.rerender(<AssistantPage api={api} embedded catalogPlatform="google" />);
  expect(screen.queryByRole('button', { name: '不参考 Claude' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '不参考 Gemini / Google' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '写代码', exact: true }));
  await waitFor(() => expect(api.sendTurn).toHaveBeenCalledTimes(1));
  expect(api.sendTurn.mock.calls[0][1].text).toBe('当前页面筛选：Gemini / Google\n写代码');
});

test('status resolving after unmount cannot start session initialization', async () => {
  let resolveStatus;
  const api = mockApi({ status: vi.fn(() => new Promise(resolve => { resolveStatus = resolve; })) });
  const view = render(<AssistantPage api={api} />);
  view.unmount();
  await act(async () => { resolveStatus({ enabled: true }); });
  expect(api.createSession).not.toHaveBeenCalled();
  expect(api.readSession).not.toHaveBeenCalled();
  expect(sessionStorage.getItem('shopping-assistant')).toBeNull();
});

test('create resolving after unmount cannot overwrite a later conversations credentials', async () => {
  let resolveCreation;
  const api = mockApi({ createSession: vi.fn(() => new Promise(resolve => { resolveCreation = resolve; })) });
  const view = render(<AssistantPage api={api} enabled />);
  expect(api.createSession).toHaveBeenCalledTimes(1);
  const signal = api.createSession.mock.calls[0][0];
  view.unmount();
  const replacement = { sessionId: '33333333-3333-4333-8333-333333333333', accessToken: 'new-token' };
  sessionStorage.setItem('shopping-assistant', JSON.stringify(replacement));
  await act(async () => { resolveCreation({ ...credentials, revision: 0 }); });
  expect(signal.aborted).toBe(true);
  expect(JSON.parse(sessionStorage.getItem('shopping-assistant'))).toEqual(replacement);
});

test('superseded initialization cannot overwrite the currently mounted session', async () => {
  let resolveCreation;
  const previousApi = mockApi({ createSession: vi.fn(() => new Promise(resolve => { resolveCreation = resolve; })) });
  const replacement = { sessionId: '33333333-3333-4333-8333-333333333333', accessToken: 'new-token' };
  const nextApi = mockApi({ createSession: vi.fn(async () => ({ ...replacement, revision: 0 })) });
  const view = render(<AssistantPage api={previousApi} enabled />);
  view.rerender(<AssistantPage api={nextApi} enabled />);
  await screen.findByRole('textbox', { name: '告诉助手你的需求' });
  await act(async () => { resolveCreation({ ...credentials, revision: 0 }); });
  expect(JSON.parse(sessionStorage.getItem('shopping-assistant'))).toEqual(replacement);
  expect(nextApi.createSession).toHaveBeenCalledTimes(1);
});

test('disabled assistant has guide and catalog fallback without creating a session', async () => {
  const api = mockApi({ status: vi.fn(async () => ({ enabled: false })) });
  render(<AssistantPage api={api} />);
  expect(await screen.findByText(/导购助手暂未启用/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '查看选购指南' })).toHaveAttribute('href', '/guide');
  expect(api.createSession).not.toHaveBeenCalled();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
});

test('real assistant-ui composer sends only current text and quick options as the next user message', async () => {
  const api = mockApi();
  render(<AssistantPage api={api} />);
  const input = await screen.findByRole('textbox', { name: '告诉助手你的需求' });
  expect(input).toHaveAttribute('maxlength', '2000');
  fireEvent.change(input, { target: { value: '写代码' } });
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
  expect(await screen.findByText('预算大概是多少？')).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: '想用来做什么？' })).not.toBeInTheDocument();
  expect(api.sendTurn.mock.calls[0][1]).toEqual({ clientMessageId: expect.any(String), expectedRevision: 0, text: '写代码' });
  fireEvent.click(screen.getByRole('button', { name: '50元以内' }));
  await waitFor(() => expect(api.sendTurn).toHaveBeenCalledTimes(2));
  expect(api.sendTurn.mock.calls[1][1]).toMatchObject({ text: '50元以内', expectedRevision: 1 });
  expect(sessionStorage.getItem('shopping-assistant')).not.toMatch(/写代码|预算|needs|revision/);
});

test('refresh restores server history and safe product cards without reading catalog query filters', async () => {
  sessionStorage.setItem('shopping-assistant', JSON.stringify(credentials));
  window.history.replaceState({}, '', '/assistant?q=secret&newcomer=true');
  const card = { standardProductId: '42', productId: '9', shopId: '7', title: 'ChatGPT Plus',
    price: '49.00', currency: 'CNY', capturedAt: '2020-01-01T00:00:00Z', priceExpiresAt: '2020-01-02T00:00:00Z',
    detailPath: '/products/42', reasons: ['本次候选中价格较低', '补充报价依据'], caveats: ['下单前确认库存'], evidenceIds: ['e1'] };
  const api = mockApi({ readSession: vi.fn(async () => ({ id: sessionId, revision: 1, needs: emptyShoppingNeeds(),
    turns: [{ ...done, reply: { ...reply, kind: 'recommendation', text: '本次推荐的完整说明', options: [], cards: [card] } }] })) });
  render(<AssistantPage api={api} />);
  await screen.findByRole('textbox', { name: '告诉助手你的需求' });
  expect(screen.getByText('写代码', { selector: 'span' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /查看商品详情/ })).toHaveAttribute('href', '/products/42');
  expect(screen.getByText(/¥49/)).toBeInTheDocument();
  expect(screen.getByText('下单前确认库存')).toBeVisible();
  expect(screen.getByText('报价已过期，请重新核对')).toBeVisible();
  expect(screen.getByText('补充报价依据')).not.toBeVisible();
  expect(screen.getByText('本次推荐的完整说明')).not.toBeVisible();
  fireEvent.click(screen.getByText('报价依据'));
  expect(screen.getByText('补充报价依据')).toBeVisible();
  fireEvent.click(screen.getByText('推荐说明'));
  expect(screen.getByText('本次推荐的完整说明')).toBeVisible();
  expect(screen.queryByRole('link', { name: '按条件浏览商品' })).not.toBeInTheDocument();
  expect(api.sendTurn).not.toHaveBeenCalled();
});

test('stop synchronizes server completion when completion wins cancellation', async () => {
  let complete;
  const api = mockApi({
    subscribeTurn: vi.fn((_credentials, _turn, _onSnapshot, signal) => new Promise((resolve, reject) => {
      complete = resolve;
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })),
    cancelTurn: vi.fn(async () => done),
    readSession: vi.fn(async () => ({ id: sessionId, revision: 1, needs: emptyShoppingNeeds(), turns: [done] })),
  });
  render(<AssistantPage api={api} />);
  fireEvent.change(await screen.findByRole('textbox', { name: '告诉助手你的需求' }), { target: { value: '写代码' } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(api.subscribeTurn).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: '停止' }));
  expect(await screen.findByText('预算大概是多少？')).toBeInTheDocument();
  expect(api.cancelTurn).toHaveBeenCalledWith(expect.objectContaining(credentials), '1');
  expect(api.readSession).toHaveBeenCalled();
  complete?.(done);
});

test('unmount disconnects the subscription without cancelling the backend task', async () => {
  let subscriptionSignal;
  const api = mockApi({ subscribeTurn: vi.fn((_credentials, _turn, _onSnapshot, signal) => {
    subscriptionSignal = signal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
  }) });
  const view = render(<AssistantPage api={api} />);
  fireEvent.change(await screen.findByRole('textbox', { name: '告诉助手你的需求' }), { target: { value: '写代码' } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(api.subscribeTurn).toHaveBeenCalled());
  view.unmount();
  expect(subscriptionSignal.aborted).toBe(true);
  expect(api.cancelTurn).not.toHaveBeenCalled();
});

test('uncertain acceptance blocks new sends and retries the identical UUID, input and revision', async () => {
  const api = mockApi();
  api.sendTurn.mockRejectedValueOnce(new Error('连接中断'));
  render(<AssistantPage api={api} />);
  fireEvent.change(await screen.findByRole('textbox', { name: '告诉助手你的需求' }), { target: { value: '写代码' } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  expect(await screen.findByRole('button', { name: '重新连接' })).toBeInTheDocument();
  expect(screen.getByRole('textbox')).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '重新连接' }));
  expect(await screen.findByText('预算大概是多少？')).toBeInTheDocument();
  expect(api.sendTurn.mock.calls[1][1]).toEqual(api.sendTurn.mock.calls[0][1]);
});

test('clearing a conversation requires confirmation before deleting its session', async () => {
  sessionStorage.setItem('shopping-assistant', JSON.stringify(credentials));
  const api = mockApi({ readSession: vi.fn(async () => ({ id: sessionId, revision: 1,
    needs: emptyShoppingNeeds(), turns: [done] })) });
  render(<AssistantPage api={api} />);
  await screen.findByRole('textbox', { name: '告诉助手你的需求' });
  fireEvent.click(screen.getByRole('button', { name: '设置' }));
  fireEvent.click(screen.getByRole('button', { name: '清空对话' }));
  expect(api.deleteSession).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(api.deleteSession).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '设置' }));
  fireEvent.click(screen.getByRole('button', { name: '清空对话' }));
  fireEvent.click(screen.getByRole('button', { name: '确认清空' }));
  await waitFor(() => expect(api.deleteSession).toHaveBeenCalledWith(expect.objectContaining(credentials)));
  await waitFor(() => expect(api.createSession).toHaveBeenCalled());
  expect(api.deleteSession.mock.invocationCallOrder[0]).toBeLessThan(api.createSession.mock.invocationCallOrder[0]);
});

test('assistant route applies client noindex and its own title', async () => {
  window.history.replaceState({}, '', '/assistant/');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ enabled: false })));
  render(<App />);
  expect(await screen.findByRole('heading', { name: '选购' })).toBeInTheDocument();
  expect(document.title).toMatch(/导购助手/);
  expect(document.querySelector('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
});

test('expired session asks for a new conversation instead of silently replacing the credential', async () => {
  sessionStorage.setItem('shopping-assistant', JSON.stringify(credentials));
  const api = mockApi({ readSession: vi.fn(async () => { throw Object.assign(new Error('会话已失效'), { status: 404 }); }) });
  render(<AssistantPage api={api} />);
  expect(await screen.findByRole('alert')).toHaveTextContent(/失效/);
  expect(api.createSession).not.toHaveBeenCalled();
  expect(screen.queryByRole('textbox', { name: '告诉助手你的需求' })).not.toBeInTheDocument();
});

test.each([
  ['cancelled', null, /已停止本轮/],
  ['failed', 'deadline_exceeded', /等待超时/],
])('restored %s turn exposes a readable terminal state and permits a new message', async (status, errorCode, expected) => {
  sessionStorage.setItem('shopping-assistant', JSON.stringify(credentials));
  const api = mockApi({ readSession: vi.fn(async () => ({ id: sessionId, revision: 0, needs: emptyShoppingNeeds(),
    turns: [turn({ status, phase: status, errorCode })] })) });
  render(<AssistantPage api={api} />);
  expect(await screen.findByText(expected)).toBeInTheDocument();
  expect(screen.getByRole('textbox')).not.toBeDisabled();
});

test('restored no-match keeps the authoritative hard budget and displays no invented cards', async () => {
  sessionStorage.setItem('shopping-assistant', JSON.stringify(credentials));
  const needs = { ...emptyShoppingNeeds(), budget: { amount: '50', currency: 'CNY', basis: 'month' } };
  const api = mockApi({ readSession: vi.fn(async () => ({ id: sessionId, revision: 1, needs,
    turns: [{ ...done, reply: { ...reply, kind: 'no_match', text: '当前没有符合条件的报价。', options: [], needs } }] })) });
  render(<AssistantPage api={api} />);
  expect(await screen.findByText('当前没有符合条件的报价。')).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /查看商品详情/ })).not.toBeInTheDocument();
  expect(screen.getByLabelText('已确认条件')).toHaveTextContent('每月 ≤ ¥50');
  expect(screen.queryByRole('link', { name: '按条件浏览商品' })).not.toBeInTheDocument();
});

test('starter choices send a short message immediately and update the conversation title', async () => {
  const api = mockApi();
  render(<AssistantPage api={api} />);
  await screen.findByRole('textbox', { name: '告诉助手你的需求' });
  fireEvent.click(screen.getByRole('button', { name: '写代码', exact: true }));
  await waitFor(() => expect(api.sendTurn).toHaveBeenCalledTimes(1));
  expect(api.sendTurn.mock.calls[0][1].text).toBe('写代码');
  expect(screen.getByRole('heading', { name: '写代码' })).toBeVisible();
  expect(screen.queryByRole('heading', { name: '想用来做什么？' })).not.toBeInTheDocument();
});

test('standalone mobile page does not automatically focus the input', async () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
  render(<AssistantPage api={mockApi()} />);
  expect(await screen.findByRole('textbox', { name: '告诉助手你的需求' })).not.toHaveFocus();
});

test('starter shortcut does not overwrite an existing draft', async () => {
  const api = mockApi();
  render(<AssistantPage api={api} />);
  const input = await screen.findByRole('textbox', { name: '告诉助手你的需求' });
  fireEvent.change(input, { target: { value: '我自己的需求' } });
  fireEvent.click(screen.getByRole('button', { name: '写代码', exact: true }));
  await waitFor(() => expect(api.sendTurn).toHaveBeenCalledTimes(1));
  expect(api.sendTurn.mock.calls[0][1].text).toBe('写代码');
  expect(input).toHaveValue('我自己的需求');
});

test('cancelling clear returns focus to the options menu when input autofocus is off', async () => {
  render(<AssistantPage api={mockApi()} focusInput={false} />);
  await screen.findByRole('textbox', { name: '告诉助手你的需求' });
  fireEvent.click(screen.getByRole('button', { name: '写代码', exact: true }));
  await screen.findByText('预算大概是多少？');
  const menu = screen.getByRole('button', { name: '设置' });

  fireEvent.click(screen.getByRole('button', { name: '设置' }));
  fireEvent.click(screen.getByRole('button', { name: '清空对话' }));
  expect(screen.getByRole('button', { name: '取消' })).toHaveFocus();
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(menu).toHaveFocus();
});

test('empty conversation disables clearing and settings dismisses outside or on Escape', async () => {
  const onCollapse = vi.fn();
  render(<AssistantPage api={mockApi()} embedded catalogPlatform="anthropic" onCollapse={onCollapse} />);
  const input = await screen.findByRole('textbox', { name: '告诉助手你的需求' });
  expect(input).toHaveAttribute('placeholder', '说说你的需求…');
  expect(input.closest('.assistant-composer')).toContainElement(screen.getByRole('button', { name: '不参考 Claude' }));
  expect(screen.getByRole('button', { name: '日常办公' })).toBeVisible();
  const settings = screen.getByRole('button', { name: '设置' });
  fireEvent.click(settings);
  expect(screen.getByRole('button', { name: '清空对话' })).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: '识别当前筛选' }));
  expect(settings).toHaveAttribute('aria-expanded', 'true');
  fireEvent.pointerDown(input);
  expect(settings).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(settings);
  fireEvent.keyDown(screen.getByRole('checkbox', { name: '识别当前筛选' }), { key: 'Escape' });
  expect(settings).toHaveAttribute('aria-expanded', 'false');
  expect(settings).toHaveFocus();
  expect(onCollapse).not.toHaveBeenCalled();
});

test('confirmed needs stay visible without a separate modify action', async () => {
  sessionStorage.setItem('shopping-assistant', JSON.stringify(credentials));
  const needs = { ...emptyShoppingNeeds(), platform: 'OpenAI', purpose: '写代码',
    budget: { amount: '50', currency: 'CNY', basis: 'month' } };
  const api = mockApi({ readSession: vi.fn(async () => ({ id: sessionId, revision: 1, needs,
    turns: [{ ...done, reply: { ...reply, needs } }] })) });
  render(<AssistantPage api={api} />);
  await screen.findByRole('textbox', { name: '告诉助手你的需求' });
  expect(screen.queryByRole('button', { name: '修改需求' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('已确认条件')).toHaveTextContent('每月 ≤ ¥50');
  fireEvent.click(screen.getByText('浏览更多商品'));
  expect(screen.getByRole('link', { name: '按条件浏览商品' }).getAttribute('href')).toContain('platform=');
  expect(screen.getByText('预算、用途与偏好未带入')).toBeInTheDocument();
  expect(api.sendTurn).not.toHaveBeenCalled();
});

test('while a reply is pending users can prepare a draft but cannot submit another turn', async () => {
  let finish;
  const api = mockApi({ subscribeTurn: vi.fn((_credentials, active) => new Promise(resolve => {
    finish = () => resolve({ ...done, clientMessageId: active.clientMessageId });
  })) });
  render(<AssistantPage api={api} />);
  const input = await screen.findByRole('textbox', { name: '告诉助手你的需求' });
  fireEvent.change(input, { target: { value: '写代码' } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(api.subscribeTurn).toHaveBeenCalled());
  expect(input).not.toBeDisabled();
  fireEvent.change(input, { target: { value: '预算每月50元' } });
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
  fireEvent.submit(input.closest('form'));
  expect(api.sendTurn).toHaveBeenCalledTimes(1);
  await act(async () => finish());
  expect(input).toHaveValue('预算每月50元');
});

test('initialization retry restores the existing conversation without deleting it', async () => {
  sessionStorage.setItem('shopping-assistant', JSON.stringify(credentials));
  const api = mockApi();
  api.readSession.mockRejectedValueOnce(new Error('连接中断'));
  render(<AssistantPage api={api} />);
  fireEvent.click(await screen.findByRole('button', { name: '重试连接' }));
  await screen.findByRole('textbox', { name: '告诉助手你的需求' });
  expect(api.readSession).toHaveBeenCalledTimes(2);
  expect(api.deleteSession).not.toHaveBeenCalled();
  expect(api.createSession).not.toHaveBeenCalled();
});

test('failed clearing preserves history and allows retrying the deletion', async () => {
  sessionStorage.setItem('shopping-assistant', JSON.stringify(credentials));
  const api = mockApi({ readSession: vi.fn(async () => ({ id: sessionId, revision: 1,
    needs: emptyShoppingNeeds(), turns: [done] })) });
  api.deleteSession.mockRejectedValueOnce(new Error('连接中断'));
  render(<AssistantPage api={api} />);
  await screen.findByText('预算大概是多少？');
  fireEvent.click(screen.getByRole('button', { name: '设置' }));
  fireEvent.click(screen.getByRole('button', { name: '清空对话' }));
  fireEvent.click(screen.getByRole('button', { name: '确认清空' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('连接中断');
  expect(screen.getByText('预算大概是多少？')).toBeInTheDocument();
  expect(JSON.parse(sessionStorage.getItem('shopping-assistant'))).toEqual(credentials);
  fireEvent.click(screen.getByRole('button', { name: '确认清空' }));
  await waitFor(() => expect(api.createSession).toHaveBeenCalled());
});

test('refresh recovers a pending accepted message by UUID without sending again', async () => {
  sessionStorage.setItem('shopping-assistant', JSON.stringify({ ...credentials, pendingMessageId: done.clientMessageId }));
  const api = mockApi({ readSession: vi.fn(async () => ({ id: sessionId, revision: 0, needs: emptyShoppingNeeds(), turns: [turn()] })) });
  render(<AssistantPage api={api} />);
  expect(await screen.findByText('预算大概是多少？')).toBeInTheDocument();
  expect(api.sendTurn).not.toHaveBeenCalled();
  expect(api.createSession).not.toHaveBeenCalled();
  expect(JSON.parse(sessionStorage.getItem('shopping-assistant'))).toEqual(credentials);
});

test('unknown pending UUID without server input never invents a replay after reload', async () => {
  sessionStorage.setItem('shopping-assistant', JSON.stringify({ ...credentials, pendingMessageId: done.clientMessageId }));
  const api = mockApi();
  render(<AssistantPage api={api} />);
  expect(await screen.findByRole('alert')).toHaveTextContent(/无法确认/);
  expect(screen.getByRole('textbox')).toBeDisabled();
  expect(api.sendTurn).not.toHaveBeenCalled();
  expect(api.createSession).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '设置' }));
  expect(screen.getByRole('button', { name: '清空对话' })).not.toBeDisabled();
});

test('version conflict restores authoritative history and allows a new message at its revision', async () => {
  const api = mockApi({ readSession: vi.fn(async () => ({ id: sessionId, revision: 1, needs: emptyShoppingNeeds(), turns: [done] })) });
  api.sendTurn.mockRejectedValueOnce(Object.assign(new Error('会话版本已变化'), { status: 409 }));
  render(<AssistantPage api={api} />);
  fireEvent.change(await screen.findByRole('textbox', { name: '告诉助手你的需求' }), { target: { value: '更便宜' } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(api.readSession).toHaveBeenCalled());
  expect(await screen.findByText('预算大概是多少？')).toBeInTheDocument();
  expect(screen.getByRole('textbox')).not.toBeDisabled();
  expect(api.sendTurn).toHaveBeenCalledTimes(1);
});


test('new embedded conversation defaults to checked platform context without filling the draft', async () => {
  window.history.replaceState({}, '', '/?platform=anthropic');
  const api = mockApi();
  render(<AssistantPage api={api} embedded />);
  const input = await screen.findByRole('textbox', { name: '告诉助手你的需求' });
  expect(input).toHaveValue('');
  fireEvent.click(screen.getByRole('button', { name: '设置' }));
  expect(screen.getByRole('checkbox', { name: '识别当前筛选' })).toBeChecked();
  expect(api.sendTurn).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '设置' }));
  fireEvent.click(screen.getByRole('button', { name: '写代码' }));
  expect(input).toHaveValue('');
  await waitFor(() => expect(api.sendTurn).toHaveBeenCalledTimes(1));
  expect(api.sendTurn.mock.calls[0][1].text).toContain('Claude');
  expect(await screen.findByText('预算大概是多少？')).toBeInTheDocument();
  expect(input).toHaveValue('');
  fireEvent.click(screen.getByRole('button', { name: '设置' }));
  expect(screen.getByRole('checkbox', { name: '识别当前筛选' })).toBeChecked();
  fireEvent.change(input, { target: { value: '预算50元' } });
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
  await waitFor(() => expect(api.sendTurn).toHaveBeenCalledTimes(2));
  expect(api.sendTurn.mock.calls[1][1].text).toBe('当前页面筛选：Claude\n预算50元');
  expect(screen.getByText('内容由AI生成，仅供参考')).toBeVisible();
  expect(screen.getByRole('button', { name: '设置' })).toBeVisible();
  expect(screen.queryByText('说明')).not.toBeInTheDocument();

});

test('restored conversation ignores catalog platform and clearing reads the current platform', async () => {
  sessionStorage.setItem('shopping-assistant', JSON.stringify(credentials));
  window.history.replaceState({}, '', '/?platform=anthropic');
  const api = mockApi({ readSession: vi.fn(async () => ({ id: sessionId, revision: 1,
    needs: emptyShoppingNeeds(), turns: [done] })) });
  render(<AssistantPage api={api} embedded />);
  expect(await screen.findByRole('textbox', { name: '告诉助手你的需求' })).toHaveValue('');
  window.history.replaceState({}, '', '/?platform=google');
  fireEvent.click(screen.getByRole('button', { name: '设置' }));
  fireEvent.click(screen.getByRole('button', { name: '清空对话' }));
  fireEvent.click(screen.getByRole('button', { name: '确认清空' }));
  await screen.findByRole('button', { name: '写代码' });
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '找报价' } });
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', code: 'Enter' });
  await waitFor(() => expect(api.sendTurn).toHaveBeenCalledTimes(1));
  expect(api.sendTurn.mock.calls[0][1].text).toBe('当前页面筛选：Gemini / Google\n找报价');
  expect(screen.getByRole('textbox')).toHaveValue('');
});

test.each(['click', 'enter'])('unchecked platform context is omitted on %s send', async method => {
  window.history.replaceState({}, '', '/?platform=anthropic');
  const api = mockApi();
  render(<AssistantPage api={api} embedded />);
  const input = await screen.findByRole('textbox', { name: '告诉助手你的需求' });
  fireEvent.click(screen.getByRole('button', { name: '设置' }));
  fireEvent.click(screen.getByRole('checkbox', { name: '识别当前筛选' }));
  fireEvent.change(input, { target: { value: '帮我选写代码的商品' } });
  if (method === 'enter') fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
  else fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(api.sendTurn).toHaveBeenCalledTimes(1));
  expect(api.sendTurn.mock.calls[0][1].text).toBe('帮我选写代码的商品');
});

test('context exceeding the request limit preserves draft and can be disabled to send it', async () => {
  window.history.replaceState({}, '', '/?platform=anthropic');
  const api = mockApi();
  render(<AssistantPage api={api} embedded />);
  const input = await screen.findByRole('textbox', { name: '告诉助手你的需求' });
  const draft = '字'.repeat(2000);
  fireEvent.change(input, { target: { value: draft } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  expect(api.sendTurn).not.toHaveBeenCalled();
  expect(input).toHaveValue(draft);
  expect(screen.getByRole('alert')).toHaveTextContent('2,000');
  fireEvent.click(screen.getByRole('button', { name: '设置' }));
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(api.sendTurn).toHaveBeenCalledTimes(1));
  expect(api.sendTurn.mock.calls[0][1].text).toBe(draft);
});

test('checked context reads the latest platform at send time and reconnect reuses the original request', async () => {
  window.history.replaceState({}, '', '/?platform=anthropic');
  const api = mockApi();
  api.sendTurn.mockRejectedValueOnce(new Error('连接中断'));
  render(<AssistantPage api={api} embedded />);
  const input = await screen.findByRole('textbox', { name: '告诉助手你的需求' });
  fireEvent.change(input, { target: { value: '帮我选' } });
  window.history.replaceState({}, '', '/?platform=google');
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
  await screen.findByRole('button', { name: '重新连接' });
  expect(api.sendTurn.mock.calls[0][1].text).toBe('当前页面筛选：Gemini / Google\n帮我选');
  window.history.replaceState({}, '', '/?platform=anthropic');
  fireEvent.click(screen.getByRole('button', { name: '重新连接' }));
  await screen.findByText('预算大概是多少？');
  expect(api.sendTurn.mock.calls[1][1]).toEqual(api.sendTurn.mock.calls[0][1]);
});

test.each(['/?platform=other', '/?platform=unknown', '/guide?platform=anthropic', '/products/42?platform=anthropic'])(
  'does not invent a platform context for %s', async path => {
    window.history.replaceState({}, '', path);
    render(<AssistantPage api={mockApi()} embedded />);
    expect(await screen.findByRole('textbox', { name: '告诉助手你的需求' })).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
  expect(screen.getByRole('checkbox', { name: '识别当前筛选' })).toBeChecked();
  },
);
