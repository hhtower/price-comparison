import React, { StrictMode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import McpPage from './McpPage.jsx';

const USER = { id: 'account-1', email: 'dev@example.com' };
const APPLICATION = { id: 'application-1', name: '报价助手', email: USER.email, purpose: '比较报价', expectedUsage: '每天 100 次', status: 'pending', canClaim: false };
const KEY = { apiKey: 'mcp_once-only-secret', expiresAt: '2027-02-02T00:00:00.000Z', requestsPerMinute: 60, endpoint: '/api/mcp' };
const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const calls = [];
let account, application, enabled, handler;
beforeEach(() => {
  calls.length = 0;
  account = null; application = null; enabled = true; handler = null;
  vi.stubGlobal('fetch', vi.fn(async (path, options) => {
    const body = options?.body && JSON.parse(options.body);
    calls.push({ path, body, method: options?.method || 'GET', signal: options?.signal });
    const response = handler?.(path, body, options);
    if (response) return response;
    if (path === '/api/mcp/config') return Response.json({ enabled, endpoint: '/api/mcp' });
    if (path === '/api/account/session') return Response.json({ user: account });
    if (path === '/api/mcp/captcha') return Response.json({ id: 'a'.repeat(43), image: IMAGE, expiresInSeconds: 300 });
    if (path === '/api/account/login') { account = USER; return Response.json({ user: USER }); }
    if (path === '/api/account/logout') { account = null; return Response.json({ ok: true }); }
    if (path === '/api/mcp/application') return Response.json({ application });
    if (path === '/api/mcp/applications') { application = APPLICATION; return Response.json({ ok: true }); }
    if (path.endsWith('/claim')) { application = { ...APPLICATION, status: 'approved', canClaim: false }; return Response.json(KEY); }
    if (path.endsWith('/verify')) return Response.json({ status: 'pending' });
    throw new Error(`Unexpected request: ${path}`);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function fillApplication(user) {
  await user.type(await screen.findByLabelText('名称'), '报价助手');
  await user.type(screen.getByLabelText('使用用途'), '比较报价');
  await user.type(screen.getByLabelText('预计使用量'), '每天 100 次');
}

test('anonymous visitors authenticate before applying; login updates the page and uses session email only', async () => {
  const user = userEvent.setup();
  render(<McpPage />);
  await user.type(await screen.findByLabelText('邮箱'), USER.email);
  expect(screen.queryByLabelText('使用用途')).not.toBeInTheDocument();
  expect(calls.some(call => call.path === '/api/mcp/application')).toBe(false);
  expect(screen.queryByLabelText('图形验证码')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '密码登录' }));
  await user.type(screen.getByLabelText('密码'), 'saved-password-123');
  await user.click(screen.getByRole('button', { name: '登录' }));
  await screen.findByRole('dialog', { name: '登录前安全验证' });
  await user.type(screen.getByLabelText('图形验证码'), '12345');
  await user.click(screen.getByRole('button', { name: '验证并登录' }));
  await fillApplication(user);
  expect(screen.getByLabelText('申请邮箱')).toHaveValue(USER.email);
  expect(screen.getByLabelText('申请邮箱')).toHaveAttribute('readonly');
  await user.click(screen.getByRole('button', { name: '提交申请' }));
  expect(await screen.findByText('等待管理员审核')).toBeInTheDocument();
  expect(calls.find(call => call.path === '/api/mcp/applications')?.body).toEqual({
    name: '报价助手', purpose: '比较报价', expectedUsage: '每天 100 次',
  });
  expect(screen.queryByRole('button', { name: /重发申请|重发邮件/ })).not.toBeInTheDocument();
});

test('an authenticated application failure preserves fields and offers a retry without requesting captcha', async () => {
  account = USER;
  let fail = true;
  handler = path => path === '/api/mcp/applications' && fail && Response.json({ message: 'secret backend data' }, { status: 503 });
  const user = userEvent.setup();
  render(<McpPage />);
  await fillApplication(user);
  await user.click(screen.getByRole('button', { name: '提交申请' }));
  expect(await screen.findByRole('alert')).not.toHaveTextContent('secret backend data');
  expect(screen.getByLabelText('名称')).toHaveValue('报价助手');
  expect(screen.getByLabelText('使用用途')).toHaveValue('比较报价');
  expect(screen.getByLabelText('预计使用量')).toHaveValue('每天 100 次');
  expect(calls.some(call => call.path === '/api/mcp/captcha')).toBe(false);
  fail = false;
  await user.click(screen.getByRole('button', { name: '提交申请' }));
  expect(await screen.findByText('等待管理员审核')).toBeInTheDocument();
});

test.each([
  ['pending', null, '等待管理员审核'], ['rejected', null, '申请未通过'], ['approved', 'active', '申请已通过'],
  ['approved', 'revoked', '接入已撤销'], ['approved', 'expired', '密钥已过期'],
])('shows the %s/%s record and refreshes status without another application', async (status, keyStatus, title) => {
  account = USER; application = { ...APPLICATION, status, key: keyStatus ? {
    prefix: 'mcp_example', status: keyStatus, expiresAt: '2027-02-02T00:00:00.000Z',
    lastUsedAt: null, requestsPerMinute: 60, requestCount: '0',
  } : null, reviewNote: '请补充使用场景' };
  const user = userEvent.setup();
  render(<McpPage />);
  expect(await screen.findByText(title)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '提交申请' })).not.toBeInTheDocument();
  application = { ...APPLICATION, status: 'approved', canClaim: true };
  await user.click(screen.getByRole('button', { name: '刷新状态' }));
  expect(await screen.findByRole('button', { name: '领取密钥' })).toBeInTheDocument();
  expect(calls.filter(call => call.path === '/api/mcp/application')).toHaveLength(2);
});

test('claims once through the authenticated endpoint, copies the memory-only key, and logout clears it', async () => {
  account = USER; application = { ...APPLICATION, status: 'approved', canClaim: true };
  const user = userEvent.setup();
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  const persist = vi.spyOn(Storage.prototype, 'setItem');
  render(<McpPage />);
  await user.click(await screen.findByRole('button', { name: '领取密钥' }));
  expect(await screen.findByLabelText('API 密钥')).toHaveValue(KEY.apiKey);
  expect(screen.queryByRole('button', { name: '领取密钥' })).not.toBeInTheDocument();
  expect(calls.find(call => call.path === '/api/mcp/application/claim')?.body).toEqual({});
  expect(screen.getByLabelText('MCP 地址')).toHaveValue(window.location.origin + '/api/mcp');
  await user.click(screen.getByRole('button', { name: '复制密钥' }));
  expect(copy).toHaveBeenCalledWith(KEY.apiKey);
  expect(persist).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '退出登录' }));
  expect(await screen.findByLabelText('邮箱')).toBeInTheDocument();
  expect(screen.queryByLabelText('API 密钥')).not.toBeInTheDocument();
  expect(calls.find(call => call.path === '/api/account/logout')?.method).toBe('POST');
});

test('clearing a claimed key does not offer a second claim', async () => {
  account = USER; application = { ...APPLICATION, status: 'approved', canClaim: true };
  const user = userEvent.setup();
  render(<McpPage />);
  await user.click(await screen.findByRole('button', { name: '领取密钥' }));
  await screen.findByLabelText('API 密钥');
  await user.click(screen.getByRole('button', { name: '清除页面密钥' }));
  expect(screen.queryByLabelText('API 密钥')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '领取密钥' })).not.toBeInTheDocument();
});

test.each(['verify', 'claim'])('clears legacy #%s synchronously and requires an explicit button before posting', async action => {
  window.history.replaceState({ previous: true }, '', `/mcp?source=email#${action}=secret-token`);
  render(<StrictMode><McpPage /></StrictMode>);
  expect(window.location.hash).toBe('');
  expect(window.location.search).toBe('?source=email');
  expect(window.history.state).toEqual({ previous: true });
  const button = await screen.findByRole('button', { name: action === 'verify' ? '验证邮箱' : '领取密钥' });
  expect(calls.filter(call => call.method === 'POST')).toHaveLength(0);
  expect(calls.some(call => call.path === '/api/mcp/captcha')).toBe(false);
  await userEvent.setup().click(button);
  expect(calls.find(call => call.path === `/api/mcp/applications/${action}`)?.body).toEqual({ token: 'secret-token' });
  if (action === 'claim') expect(await screen.findByLabelText('API 密钥')).toHaveValue(KEY.apiKey);
  else expect(await screen.findByRole('status')).toHaveTextContent('等待管理员审核');
});

test('legacy link errors hide backend details and allow an explicit retry', async () => {
  window.history.replaceState({}, '', '/mcp#claim=secret-token');
  handler = path => path.endsWith('/claim') && Response.json({ message: 'invalid secret-token' }, { status: 400 });
  render(<McpPage />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '领取密钥' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('链接无效');
  expect(screen.getByRole('alert')).not.toHaveTextContent('secret-token');
  handler = null;
  await user.click(screen.getByRole('button', { name: '领取密钥' }));
  expect(await screen.findByLabelText('API 密钥')).toHaveValue(KEY.apiKey);
});

test('a same-document legacy credential aborts the previous request and ignores its late result', async () => {
  account = USER; application = { ...APPLICATION, status: 'approved', canClaim: true };
  let resolve;
  handler = path => path === '/api/mcp/application/claim' && new Promise(done => { resolve = done; });
  render(<McpPage />);
  await userEvent.setup().click(await screen.findByRole('button', { name: '领取密钥' }));
  const pending = calls.find(call => call.path === '/api/mcp/application/claim');
  window.history.pushState({}, '', '/mcp#verify=new-verify-token');
  fireEvent(window, new HashChangeEvent('hashchange'));
  expect(pending.signal.aborted).toBe(true);
  expect(window.location.hash).toBe('');
  await act(async () => resolve(Response.json(KEY)));
  expect(screen.queryByLabelText('API 密钥')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '验证邮箱' })).toBeInTheDocument();
});

test('pagehide clears the displayed key and pageshow only reloads the session and application', async () => {
  account = USER; application = { ...APPLICATION, status: 'approved', canClaim: true };
  render(<McpPage />);
  await userEvent.setup().click(await screen.findByRole('button', { name: '领取密钥' }));
  await screen.findByLabelText('API 密钥');
  fireEvent(window, new PageTransitionEvent('pagehide', { persisted: true }));
  expect(screen.queryByLabelText('API 密钥')).not.toBeInTheDocument();
  fireEvent(window, new PageTransitionEvent('pageshow', { persisted: true }));
  expect(await screen.findByText('申请已通过')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '领取密钥' })).not.toBeInTheDocument();
  expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
});

test('session expiration clears the application and returns to login', async () => {
  account = USER; application = APPLICATION;
  render(<McpPage />);
  await screen.findByText('等待管理员审核');
  handler = path => path === '/api/mcp/application' && Response.json({ error: {} }, { status: 401 });
  await userEvent.setup().click(screen.getByRole('button', { name: '刷新状态' }));
  expect(await screen.findByLabelText('邮箱')).toBeInTheDocument();
  expect(screen.queryByText('等待管理员审核')).not.toBeInTheDocument();
});

test.each(['/api/mcp/config', '/api/account/session', '/api/mcp/application'])('failed %s fetch offers a retry without showing the wrong form', async path => {
  account = USER;
  handler = request => request === path && Promise.reject(new Error('offline'));
  render(<McpPage />);
  expect(await screen.findByRole('alert')).toHaveTextContent('重试');
  expect(screen.queryByRole('button', { name: '提交申请' })).not.toBeInTheDocument();
  handler = null;
  await userEvent.setup().click(screen.getByRole('button', { name: /重新检查服务|重试登录状态|刷新状态/ }));
  expect(await screen.findByRole('button', { name: '提交申请' })).toBeInTheDocument();
});

test('disabled mail preserves password login and authenticated records', async () => {
  enabled = false;
  const { unmount } = render(<McpPage />);
  expect(await screen.findByText(/暂不可用/)).toBeInTheDocument();
  expect(await screen.findByLabelText('邮箱')).toBeInTheDocument();
  expect(screen.getByLabelText('密码')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '发送验证码' })).not.toBeInTheDocument();
  unmount();
  account = USER; application = APPLICATION;
  render(<McpPage />);
  expect(await screen.findByText('等待管理员审核')).toBeInTheDocument();
});

test('authenticated users can apply while email delivery is disabled', async () => {
  account = USER; enabled = false;
  const user = userEvent.setup();
  render(<McpPage />);
  await fillApplication(user);
  await user.click(screen.getByRole('button', { name: '提交申请' }));
  expect(await screen.findByText('等待管理员审核')).toBeInTheDocument();
  expect(calls.some(call => call.path === '/api/mcp/captcha')).toBe(false);
});
