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
  await screen.findByRole('textbox');
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
  expect(screen.queryByRole('heading', { name: '你想用 AI 做些什么？' })).not.toBeInTheDocument();
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
    price: '49.00', currency: 'CNY', capturedAt: '2026-10-31T00:00:00Z', priceExpiresAt: '2099-01-01T00:00:00Z',
    detailPath: '/products/42', reasons: ['本次候选中价格较低'], caveats: ['下单前确认库存'], evidenceIds: ['e1'] };
  const api = mockApi({ readSession: vi.fn(async () => ({ id: sessionId, revision: 1, needs: emptyShoppingNeeds(),
    turns: [{ ...done, reply: { ...reply, kind: 'recommendation', options: [], cards: [card] } }] })) });
  render(<AssistantPage api={api} />);
  expect(await screen.findByText('写代码')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /查看商品详情/ })).toHaveAttribute('href', '/products/42');
  expect(screen.getByText(/49.00/)).toBeInTheDocument();
  expect(screen.getByText('下单前确认库存')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '在商品列表中查看' }).getAttribute('href')).not.toMatch(/secret|newcomer=true/);
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
  fireEvent.change(await screen.findByRole('textbox'), { target: { value: '写代码' } });
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
  fireEvent.change(await screen.findByRole('textbox'), { target: { value: '写代码' } });
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
  fireEvent.change(await screen.findByRole('textbox'), { target: { value: '写代码' } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  expect(await screen.findByRole('button', { name: '重新连接' })).toBeInTheDocument();
  expect(screen.getByRole('textbox')).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '重新连接' }));
  expect(await screen.findByText('预算大概是多少？')).toBeInTheDocument();
  expect(api.sendTurn.mock.calls[1][1]).toEqual(api.sendTurn.mock.calls[0][1]);
});

test('new conversation deletes old server session before replacing its credentials', async () => {
  sessionStorage.setItem('shopping-assistant', JSON.stringify(credentials));
  const api = mockApi();
  render(<AssistantPage api={api} />);
  await screen.findByRole('textbox');
  fireEvent.click(screen.getByRole('button', { name: '新对话' }));
  await waitFor(() => expect(api.deleteSession).toHaveBeenCalledWith(expect.objectContaining(credentials)));
  await waitFor(() => expect(api.createSession).toHaveBeenCalled());
  expect(api.deleteSession.mock.invocationCallOrder[0]).toBeLessThan(api.createSession.mock.invocationCallOrder[0]);
});

test('assistant route applies client noindex and its own title', async () => {
  window.history.replaceState({}, '', '/assistant/');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ enabled: false })));
  render(<App />);
  expect(await screen.findByRole('heading', { name: '导购助手' })).toBeInTheDocument();
  expect(document.title).toMatch(/导购助手/);
  expect(document.querySelector('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
});

test('expired session asks for a new conversation instead of silently replacing the credential', async () => {
  sessionStorage.setItem('shopping-assistant', JSON.stringify(credentials));
  const api = mockApi({ readSession: vi.fn(async () => { throw Object.assign(new Error('会话已失效'), { status: 404 }); }) });
  render(<AssistantPage api={api} />);
  expect(await screen.findByRole('alert')).toHaveTextContent(/失效/);
  expect(api.createSession).not.toHaveBeenCalled();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
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
  expect(screen.getByText(/预算、用途与偏好未带入/)).toBeInTheDocument();
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
});

test('version conflict restores authoritative history and allows a new message at its revision', async () => {
  const api = mockApi({ readSession: vi.fn(async () => ({ id: sessionId, revision: 1, needs: emptyShoppingNeeds(), turns: [done] })) });
  api.sendTurn.mockRejectedValueOnce(Object.assign(new Error('会话版本已变化'), { status: 409 }));
  render(<AssistantPage api={api} />);
  fireEvent.change(await screen.findByRole('textbox'), { target: { value: '更便宜' } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(api.readSession).toHaveBeenCalled());
  expect(await screen.findByText('预算大概是多少？')).toBeInTheDocument();
  expect(screen.getByRole('textbox')).not.toBeDisabled();
  expect(api.sendTurn).toHaveBeenCalledTimes(1);
});
