import React from 'react';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { emptyShoppingNeeds } from '@price-comparison/catalog/assistant-contract';
import AssistantWidget from './AssistantWidget.jsx';
import App from './App.jsx';

vi.mock('./PublicPage.jsx', () => ({ default: () => <main>商品目录</main> }));
vi.mock('./PurchaseGuidePage.jsx', () => ({ default: () => <main>选购指南正文</main> }));
vi.mock('./QualityToolsPage.jsx', () => ({ default: () => <main>工具正文</main> }));
vi.mock('./AdminPage.jsx', () => ({ default: () => <main>管理正文</main> }));
vi.mock('./OfficialReference.jsx', () => ({ default: () => null }));

const sessionId = '11111111-1111-4111-8111-111111111111';
const reply = { kind: 'question', text: '预算大概是多少？', options: ['50元以内'], needs: emptyShoppingNeeds(), cards: [] };
function mockApi(enabled = true) {
  return {
    status: vi.fn(async () => ({ enabled })),
    createSession: vi.fn(async () => ({ sessionId, accessToken: 'token', revision: 0 })),
    readSession: vi.fn(async () => ({ id: sessionId, revision: 0, needs: emptyShoppingNeeds(), turns: [] })),
    sendTurn: vi.fn(async (_credentials, input) => ({ created: true, snapshot: {
      id: '1', sessionId, clientMessageId: input.clientMessageId, inputText: input.text, expectedRevision: 0,
      eventVersion: 1, status: 'running', phase: 'understanding', reply: null, errorCode: null,
    } })),
    subscribeTurn: vi.fn(async (_credentials, turn, onSnapshot) => {
      const done = { ...turn, status: 'succeeded', phase: 'succeeded', eventVersion: 2, reply };
      onSnapshot(done); return done;
    }),
    cancelTurn: vi.fn(),
    deleteSession: vi.fn(async () => {}),
  };
}
beforeAll(async () => { await import('./AssistantPage.jsx'); });
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'show', { configurable: true, value: function () { this.open = true; } });
});
afterEach(() => { cleanup(); sessionStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('disabled status hides the launcher and does not create a session', async () => {
  const api = mockApi(false);
  render(<AssistantWidget api={api} />);
  await waitFor(() => expect(api.status).toHaveBeenCalled());
  expect(screen.queryByRole('button', { name: '打开导购助手' })).not.toBeInTheDocument();
  expect(api.createSession).not.toHaveBeenCalled();
  expect(document.querySelector('dialog[open]')).toBeNull();
});

test('launcher opens an accessible dialog and Escape collapses it with focus returned', async () => {
  const api = mockApi();
  render(<AssistantWidget api={api} />);
  const launcher = await screen.findByRole('button', { name: '打开导购助手' });
  expect(launcher).toHaveAttribute('aria-expanded', 'false');
  expect(api.createSession).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(launcher); });
  const dialog = await screen.findByRole('dialog', { name: '导购助手' });
  await within(dialog).findByRole('textbox', { name: '告诉助手你的需求' });
  expect(within(dialog).getAllByRole('heading', { level: 1 })).toHaveLength(1);
  expect(within(dialog).getByRole('heading', { name: '选购' })).toBeVisible();
  expect(within(dialog).queryByText('对话选项')).not.toBeInTheDocument();
  expect(screen.getByRole('textbox')).toHaveFocus();
  expect(launcher).toHaveAttribute('aria-expanded', 'true');
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(launcher).toHaveFocus();
  expect(launcher).toHaveAttribute('aria-expanded', 'false');
  expect(api.cancelTurn).not.toHaveBeenCalled();
});

test('collapse and reopen preserve runtime, draft and completed conversation', async () => {
  const api = mockApi();
  render(<AssistantWidget api={api} />);
  const launcher = await screen.findByRole('button', { name: '打开导购助手' });
  await act(async () => { fireEvent.click(launcher); });
  fireEvent.change(await screen.findByRole('textbox', { name: '告诉助手你的需求' }), { target: { value: '读论文' } });
  fireEvent.click(screen.getByRole('button', { name: '收起导购助手' }));
  fireEvent.click(launcher);
  expect(screen.getByRole('textbox')).toHaveValue('读论文');
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  expect(await screen.findByText(reply.text)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '收起导购助手' }));
  fireEvent.click(launcher);
  expect(screen.getByText('读论文', { selector: 'span' })).toBeInTheDocument();
  expect(screen.getByText(reply.text)).toBeInTheDocument();
  expect(api.createSession).toHaveBeenCalledTimes(1);
  expect(api.sendTurn).toHaveBeenCalledTimes(1);
});

test('collapsing inflight chat leaves its subscription alive and completion is visible on reopen', async () => {
  const api = mockApi();
  let finish, signal;
  api.subscribeTurn.mockImplementation((_credentials, turn, onSnapshot, abortSignal) => {
    signal = abortSignal;
    return new Promise(resolve => { finish = () => {
      const done = { ...turn, status: 'succeeded', phase: 'succeeded', eventVersion: 2, reply };
      onSnapshot(done); resolve(done);
    }; });
  });
  render(<AssistantWidget api={api} />);
  const launcher = await screen.findByRole('button', { name: '打开导购助手' });
  await act(async () => { fireEvent.click(launcher); });
  fireEvent.change(await screen.findByRole('textbox', { name: '告诉助手你的需求' }), { target: { value: '写代码' } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(api.subscribeTurn).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: '收起导购助手' }));
  expect(launcher).toHaveTextContent('正在查找');
  expect(signal.aborted).toBe(false);
  expect(api.cancelTurn).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(launcher).toHaveTextContent('有新回复');
  fireEvent.click(launcher);
  expect(launcher).not.toHaveTextContent('有新回复');
  expect(screen.getByText(reply.text)).toBeInTheDocument();
  expect(api.sendTurn).toHaveBeenCalledTimes(1);
});

test('mobile opens in the native modal top layer while desktop uses a nonmodal side panel', async () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  const modal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
  render(<AssistantWidget api={mockApi()} />);
  const launcher = await screen.findByRole('button', { name: '打开导购助手' });
  await act(async () => { fireEvent.click(launcher); });
  const dialog = await screen.findByRole('dialog', { name: '导购助手' });
  await within(dialog).findByRole('textbox', { name: '告诉助手你的需求' });
  expect(screen.getByRole('textbox')).not.toHaveFocus();
  expect(dialog).toHaveAttribute('aria-modal', 'true');
  expect(modal).toHaveBeenCalled();
  fireEvent(dialog, new Event('cancel', { cancelable: true }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('App mounts a single launcher on public routes and omits it on admin and standalone', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ enabled: true })));
  const view = render(<App />);
  for (const path of ['/', '/products/42', '/guide', '/tools']) {
    window.history.pushState({}, '', path);
    fireEvent(window, new PopStateEvent('popstate'));
    expect(await screen.findAllByRole('button', { name: '打开导购助手' })).toHaveLength(1);
  }
  window.history.pushState({}, '', '/admin');
  fireEvent(window, new PopStateEvent('popstate'));
  expect(screen.queryByRole('button', { name: '打开导购助手' })).not.toBeInTheDocument();
  await screen.findByText('管理正文');
  window.history.pushState({}, '', '/assistant');
  fireEvent(window, new PopStateEvent('popstate'));
  await screen.findByRole('heading', { name: '选购' });
  expect(screen.queryByRole('button', { name: '打开导购助手' })).not.toBeInTheDocument();
  view.unmount();
});
