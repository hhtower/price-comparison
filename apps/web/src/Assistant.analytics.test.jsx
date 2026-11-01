import React, { StrictMode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { emptyShoppingNeeds } from '@price-comparison/catalog/assistant-contract';
import AssistantPage from './AssistantPage.jsx';
import AssistantWidget from './AssistantWidget.jsx';
import { usePageAnalytics } from './usePageAnalytics.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const needs = emptyShoppingNeeds();
const card = { standardProductId: '42', productId: '9', shopId: '7', title: 'ChatGPT Plus', price: '99', currency: 'CNY',
  capturedAt: '2026-11-01T00:00:00Z', priceExpiresAt: null, detailPath: '/products/42', reasons: ['private reason'], caveats: [], evidenceIds: ['e1'],
  offer: { name: 'private product', shop: 'private shop', spec: '', productUrl: 'https://private.example/buy', tags: [] } };
const reply = { kind: 'recommendation', text: 'private answer', options: [], needs, cards: [card] };
const terminal = { id: '1', sessionId, clientMessageId: '22222222-2222-4222-8222-222222222222', inputText: 'private question',
  expectedRevision: 0, eventVersion: 2, status: 'succeeded', phase: 'succeeded', errorCode: null, reply };
function apiFor(status = 'succeeded') {
  return {
    status: vi.fn(async () => ({ enabled: true })),
    createSession: vi.fn(async () => ({ sessionId, accessToken: 'private-token', revision: 0 })),
    readSession: vi.fn(async () => ({ id: sessionId, revision: 0, needs, turns: [] })),
    sendTurn: vi.fn(async (_credentials, input) => ({ created: true, snapshot: { ...terminal,
      clientMessageId: input.clientMessageId, inputText: input.text, status: 'running', phase: 'understanding', reply: null } })),
    subscribeTurn: vi.fn(async (_credentials, turn, update) => {
      const result = { ...turn, status, phase: status, reply: status === 'succeeded' ? reply : null,
        errorCode: status === 'failed' ? 'MODEL_INVALID_RESPONSE' : null };
      update(result); update(result); return result;
    }),
  };
}
const collected = () => fetch.mock.calls.filter(([url]) => url === '/api/analytics/collect').map(([, options]) => JSON.parse(options.body));
const events = () => collected().flatMap(payload => payload.actions).map(action => action.name);
function server(offline = false) {
  vi.stubGlobal('fetch', vi.fn(async url => {
    if (url === '/api/analytics/collect') { if (offline) throw new Error('offline'); return new Response(null, { status: 204 }); }
    if (url === '/api/official-reference/catalog') return Response.json({ apps: [] });
    throw new Error('Unexpected request');
  }));
}
async function ask() {
  fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'private question' } });
  fireEvent.click(screen.getByRole('button', { name: '发送', exact: true }));
}
afterEach(() => { cleanup(); sessionStorage.clear(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test.each([['succeeded', 'assistant_reply'], ['failed', 'assistant_failure'], ['cancelled', 'assistant_cancelled']])(
  'records one question and one %s result without private content', async (status, event) => {
  server(); const api = apiFor(status);
  render(<StrictMode><AssistantPage api={api} /></StrictMode>);
  await waitFor(() => expect(events()).toEqual(['assistant_open']));
  fireEvent.click(screen.getByRole('button', { name: '发送', exact: true }));
  expect(events()).toEqual(['assistant_open']);
  await ask();
  await waitFor(() => expect(events()).toEqual(['assistant_open', 'assistant_ask', event]));
  expect(collected().every(payload => payload.page === 'assistant')).toBe(true);
  expect(new Set(collected().map(payload => payload.visitId)).size).toBe(1);
  expect(JSON.stringify(collected())).not.toMatch(/private|MODEL_INVALID_RESPONSE|22222222/);
});

test('records quote details and merchant clicks without replaying restored results', async () => {
  server(); sessionStorage.setItem('shopping-assistant', JSON.stringify({ sessionId, accessToken: 'private-token' }));
  const api = apiFor(); api.readSession.mockResolvedValue({ id: sessionId, revision: 1, needs, turns: [terminal] });
  render(<AssistantPage api={api} />);
  await waitFor(() => expect(events()).toEqual(['assistant_open']));
  fireEvent.click(await screen.findByRole('button', { name: '查看报价详情' }));
  const dialog = screen.getByRole('dialog');
  const link = within(dialog).getByRole('link', { name: '前往商家核对报价' });
  link.addEventListener('click', event => event.preventDefault());
  fireEvent.click(link);
  fireEvent.click(within(dialog).getByRole('button', { name: '确认' }));
  expect(events()).toEqual(['assistant_open', 'assistant_quote_detail', 'assistant_outbound']);
  expect(JSON.stringify(collected())).not.toMatch(/private|https:/);
});

function Host({ api, page }) { usePageAnalytics(page); return <AssistantWidget api={api} />; }
test.each(['catalog', 'guide', 'tools_ai', 'tools_ip'])('widget events stay on the %s visit, including replies while collapsed', async page => {
  server(); const api = apiFor(); let complete;
  api.subscribeTurn.mockImplementation((_credentials, turn) => new Promise(resolve => { complete = () => resolve({ ...turn, ...terminal }); }));
  Object.defineProperty(HTMLDialogElement.prototype, 'show', { configurable: true, value: function () { this.open = true; } });
  render(<Host api={api} page={page} />);
  await waitFor(() => expect(collected()).toHaveLength(1));
  expect(events()).toEqual([]);
  const launcher = await screen.findByRole('button', { name: '打开导购助手' });
  fireEvent.click(launcher);
  await ask();
  await waitFor(() => expect(complete).toBeTypeOf('function'));
  fireEvent.click(screen.getByRole('button', { name: '收起导购助手' }));
  await act(async () => complete());
  expect(events()).toEqual(['assistant_open', 'assistant_ask', 'assistant_reply']);
  fireEvent.click(launcher);
  expect(events()).toEqual(['assistant_open', 'assistant_ask', 'assistant_reply', 'assistant_open']);
  expect(collected().every(payload => payload.page === page)).toBe(true);
  expect(new Set(collected().map(payload => payload.visitId)).size).toBe(1);
});

test('reconnecting records the recovered result without another question', async () => {
  server(); const api = apiFor(); api.subscribeTurn.mockRejectedValueOnce(new Error('private connection error'));
  render(<AssistantPage api={api} />);
  await waitFor(() => expect(events()).toEqual(['assistant_open']));
  await ask();
  await waitFor(() => expect(events()).toEqual(['assistant_open', 'assistant_ask', 'assistant_connection']));
  api.readSession.mockResolvedValue({ id: sessionId, revision: 1, needs,
    turns: [{ ...terminal, clientMessageId: api.sendTurn.mock.calls[0][1].clientMessageId }] });
  fireEvent.click(await screen.findByRole('button', { name: '重新连接' }));
  await waitFor(() => expect(events()).toEqual(['assistant_open', 'assistant_ask', 'assistant_connection', 'assistant_reply']));
  expect(api.sendTurn).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(collected())).not.toContain('private');
});

test('stopping an active reply records cancellation without a connection error', async () => {
  server(); const api = apiFor();
  const cancelled = { ...terminal, status: 'cancelled', phase: 'cancelled', reply: null };
  api.subscribeTurn.mockImplementation((_credentials, _turn, _update, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }));
  api.cancelTurn = vi.fn(async () => cancelled);
  render(<AssistantPage api={api} />);
  await waitFor(() => expect(events()).toEqual(['assistant_open']));
  await ask();
  await waitFor(() => expect(api.subscribeTurn).toHaveBeenCalledOnce());
  api.readSession.mockResolvedValue({ id: sessionId, revision: 0, needs, turns: [cancelled] });
  fireEvent.click(screen.getByRole('button', { name: '停止', exact: true }));
  await waitFor(() => expect(events()).toEqual(['assistant_open', 'assistant_ask', 'assistant_cancelled']));
  expect(api.cancelTurn).toHaveBeenCalledOnce();
});

test('analytics delivery failure does not interrupt the answer or quote dialog', async () => {
  server(true); render(<AssistantPage api={apiFor()} />);
  await ask();
  fireEvent.click(await screen.findByRole('button', { name: '查看报价详情' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('private product');
});
