import React from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import McpAdmin from './McpAdmin.jsx';
import AdminPage from './AdminPage.jsx';

const calls = [];
let application;
let failAction;
const secret = 'mcp_full_secret_for_admin';
const openDetails = async (user = userEvent.setup()) => {
  await user.click(await screen.findByRole('button', { name: '查看详情' }));
  return screen.getByRole('dialog');
};
const approveApplication = () => {
  application = { ...application, status: 'approved',
    key: { prefix: 'mcp_1234', status: 'active', canReveal: true, expiresAt: '2027-02-02T00:00:00Z',
      lastUsedAt: null, requestsPerMinute: 240, requestCount: 12 } };
};
function deferRequest(match) {
  const fetch = globalThis.fetch;
  let resolve;
  let signal;
  vi.stubGlobal('fetch', vi.fn((input, options) => {
    if (match(input, options)) {
      signal = options?.signal;
      return new Promise(done => { resolve = done; });
    }
    return fetch(input, options);
  }));
  return { get signal() { return signal; }, finish: async (body, status = 200) => {
    await act(async () => { resolve(Response.json(body, { status })); });
  } };
}
beforeEach(() => {
  calls.length = 0;
  failAction = false;
  application = {
    id: '42', name: '报价助手', email: 'dev@example.com', purpose: '比较订阅报价', expectedUsage: '每天 100 次',
    status: 'pending', createdAt: '2026-11-04T00:00:00Z', emailVerifiedAt: '2026-11-04T00:00:00Z',
    reviewedAt: null, reviewNote: null, notificationStatus: 'sent', key: null,
  };
  vi.stubGlobal('confirm', vi.fn(() => true));
  vi.stubGlobal('fetch', vi.fn(async (input, options) => {
    const url = new URL(input, 'http://localhost');
    calls.push({ url, method: options?.method || 'GET', body: options?.body && JSON.parse(options.body), options });
    if (options?.method === 'POST') return Response.json(failAction ? { message: '审核失败' } : { ok: true }, { status: failAction ? 500 : 200 });
    if (url.pathname.endsWith('/key')) return Response.json({ apiKey: secret });
    if (url.pathname === '/api/admin/mcp/applications') return Response.json({ items: [application], total: 11, page: Number(url.searchParams.get('page')), pageSize: 10 });
    return Response.json({ items: [], total: 0, page: 1, pageSize: 10 });
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('admin sidebar opens MCP review with status filtering and pagination', async () => {
  const user = userEvent.setup();
  render(<AdminPage initialAuthenticated />);
  await user.click(screen.getByRole('button', { name: 'Skill / MCP 接入' }));
  expect(await screen.findByText('dev@example.com')).toBeInTheDocument();
  expect(calls.find(call => call.url.pathname === '/api/admin/mcp/applications')?.url.search).toBe('?page=1&pageSize=10');
  await user.click(screen.getByRole('button', { name: '下一页' }));
  await waitFor(() => expect(calls.some(call => call.url.searchParams.get('page') === '2')).toBe(true));
  await user.selectOptions(screen.getByLabelText('申请状态'), 'approved');
  await waitFor(() => expect(calls.some(call => call.url.search === '?page=1&pageSize=10&status=approved')).toBe(true));
});

test.each(['approve', 'reject'])('reviews with %s and sends the documented payload', async action => {
  const user = userEvent.setup();
  render(<McpAdmin />);
  await openDetails(user);
  expect(screen.getByLabelText('有效期（天）')).toHaveValue(90);
  expect(screen.getByLabelText('每分钟请求数')).toHaveValue(60);
  expect(screen.getByLabelText('有效期（天）')).toHaveAttribute('min', '1');
  expect(screen.getByLabelText('有效期（天）')).toHaveAttribute('max', '365');
  expect(screen.getByLabelText('每分钟请求数')).toHaveAttribute('max', '1000');
  await user.type(screen.getByLabelText('审核备注'), '用于报价比较');
  await user.click(screen.getByRole('button', { name: action === 'approve' ? '通过申请' : '拒绝申请' }));
  await waitFor(() => expect(calls.find(call => call.url.pathname.endsWith(`/${action}`))?.body).toEqual(
    action === 'approve' ? { expiresInDays: 90, requestsPerMinute: 60, reviewNote: '用于报价比较' } : { reviewNote: '用于报价比较' },
  ));
  expect(await screen.findByRole('status')).toHaveTextContent('已');
});

test.each(['resend', 'revoke', 'reissue'])('approved applications support %s and show failed notification', async action => {
  application = { ...application, status: 'approved', notificationStatus: 'failed',
    key: { prefix: action === 'resend' ? null : 'mcp_1234', status: action === 'resend' ? 'unclaimed' : 'active', expiresAt: '2027-02-02T00:00:00Z', lastUsedAt: null, requestsPerMinute: 60, requestCount: 12 } };
  const user = userEvent.setup();
  render(<McpAdmin />);
  await openDetails(user);
  expect(await screen.findByText(/通知发送失败/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: { resend: '重发通知', revoke: '撤销密钥', reissue: '重新发放' }[action] }));
  await waitFor(() => expect(calls.find(call => call.url.pathname.endsWith(`/${action}`))?.body).toEqual(
    action === 'reissue' ? { expiresInDays: 90, requestsPerMinute: 60, reviewNote: '' } : {},
  ));
});

test('a failed review is visible and can be retried', async () => {
  failAction = true;
  const user = userEvent.setup();
  render(<McpAdmin />);
  await openDetails(user);
  await user.click(await screen.findByRole('button', { name: '通过申请' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('审核失败');
  expect(screen.getByRole('button', { name: '通过申请' })).toBeEnabled();
  failAction = false;
  await user.click(screen.getByRole('button', { name: '通过申请' }));
  expect(await screen.findByText('申请已通过，已尝试发送领取通知。')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('an application awaiting claim can be revoked before any key is issued', async () => {
  application = { ...application, status: 'approved',
    key: { prefix: null, status: 'unclaimed', expiresAt: '2027-02-02T00:00:00Z', lastUsedAt: null, requestsPerMinute: 60, requestCount: '0' } };
  render(<McpAdmin />);
  await openDetails();
  expect(within(screen.getByRole('dialog')).getByText('待领取')).toBeInTheDocument();
  expect(screen.queryByText(/null/)).not.toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole('button', { name: '撤销密钥' }));
  await waitFor(() => expect(calls.some(call => call.url.pathname.endsWith('/revoke'))).toBe(true));
});

test('rejected applications can resend failed review notifications', async () => {
  application = { ...application, status: 'rejected', reviewNote: '用途不明确', notificationStatus: 'failed' };
  render(<McpAdmin />);
  await openDetails();
  await userEvent.setup().click(await screen.findByRole('button', { name: '重发通知' }));
  await waitFor(() => expect(calls.some(call => call.url.pathname.endsWith('/resend'))).toBe(true));
});

test('rejecting an application requires a reason', async () => {
  const user = userEvent.setup();
  render(<McpAdmin />);
  await openDetails(user);
  await user.click(await screen.findByRole('button', { name: '拒绝申请' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('拒绝原因');
  expect(calls.filter(call => call.method === 'POST')).toHaveLength(0);
});

test('approval sends edited expiry and request limits', async () => {
  const user = userEvent.setup();
  render(<McpAdmin />);
  await openDetails(user);
  const expiry = await screen.findByLabelText('有效期（天）');
  await user.clear(expiry);
  await user.type(expiry, '365');
  const limit = screen.getByLabelText('每分钟请求数');
  await user.clear(limit);
  await user.type(limit, '1000');
  await user.click(screen.getByRole('button', { name: '通过申请' }));
  await waitFor(() => expect(calls.find(call => call.url.pathname.endsWith('/approve'))?.body).toEqual({
    expiresInDays: 365, requestsPerMinute: 1000, reviewNote: '',
  }));
});

test('a failed application list can be loaded again', async () => {
  const fetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ message: '列表暂不可用' }, { status: 503 })));
  render(<McpAdmin />);
  expect(await screen.findByRole('alert')).toHaveTextContent('列表暂不可用');
  vi.stubGlobal('fetch', fetch);
  await userEvent.setup().click(screen.getByRole('button', { name: '重新加载申请' }));
  expect(await screen.findByText('dev@example.com')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('each applicant occupies one compact row and review fields appear only in details', async () => {
  render(<McpAdmin />);
  const row = (await screen.findByText('dev@example.com')).closest('tr');
  expect(row).not.toBeNull();
  expect(within(row).getByText('报价助手')).toBeInTheDocument();
  expect(screen.getAllByRole('row')).toHaveLength(2);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('审核备注')).not.toBeInTheDocument();
  expect(screen.queryByText('比较订阅报价')).not.toBeInTheDocument();
  const dialog = await openDetails();
  expect(within(dialog).getByLabelText('审核备注')).toBeInTheDocument();
  expect(within(dialog).getByText('比较订阅报价')).toBeInTheDocument();
});

test('revealing is explicit, bypasses cache, copies and forgets the secret on hide or close', async () => {
  approveApplication();
  const user = userEvent.setup();
  const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  render(<McpAdmin />);
  await openDetails(user);
  expect(screen.getByLabelText('每分钟请求数')).toHaveValue(240);
  expect(calls.some(call => call.url.pathname.endsWith('/key'))).toBe(false);
  await user.click(screen.getByRole('button', { name: '查看完整密钥' }));
  expect(await screen.findByLabelText('完整密钥')).toHaveValue(secret);
  expect(calls.find(call => call.url.pathname.endsWith('/key')).options).toMatchObject({ cache: 'no-store', signal: expect.any(AbortSignal) });
  await user.click(screen.getByRole('button', { name: '复制密钥' }));
  expect(clipboard).toHaveBeenCalledWith(secret);
  await user.click(screen.getByRole('button', { name: '隐藏密钥' }));
  expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '查看完整密钥' }));
  expect(await screen.findByLabelText('完整密钥')).toHaveValue(secret);
  expect(calls.filter(call => call.url.pathname.endsWith('/key'))).toHaveLength(2);
  await user.click(screen.getByRole('button', { name: '关闭详情' }));
  await openDetails(user);
  expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument();
  expect(calls.filter(call => call.url.pathname.endsWith('/key'))).toHaveLength(2);
});

test.each(['unclaimed', 'revoked', 'expired'])('unavailable keys show the current action without requesting a secret (%s)', async status => {
  approveApplication();
  application.key = { ...application.key, status, canReveal: false, prefix: status === 'unclaimed' ? null : 'mcp_1234' };
  render(<McpAdmin />);
  const dialog = await openDetails();
  expect(within(dialog).getByText(status === 'unclaimed' ? '用户领取后即可查看完整密钥。' : '请重新发放并由用户领取新密钥。')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '查看完整密钥' })).not.toBeInTheDocument();
  expect(calls.some(call => call.url.pathname.endsWith('/key'))).toBe(false);
});

test('reveal errors stay inside details and an explicit retry succeeds', async () => {
  approveApplication();
  const fetch = globalThis.fetch;
  let failed = true;
  vi.stubGlobal('fetch', vi.fn((input, options) => input.endsWith('/key') && failed
    ? Promise.resolve(Response.json({ message: '暂时无法读取密钥' }, { status: 503 })) : fetch(input, options)));
  const user = userEvent.setup();
  render(<McpAdmin />);
  const dialog = await openDetails(user);
  await user.click(screen.getByRole('button', { name: '查看完整密钥' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('暂时无法读取密钥');
  failed = false;
  await user.click(screen.getByRole('button', { name: '查看完整密钥' }));
  expect(await screen.findByLabelText('完整密钥')).toHaveValue(secret);
  expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
});

test.each(['close', 'escape', 'pagehide', 'unmount', 'filter', 'page'])('aborts reveal and ignores a late response after %s', async exit => {
  approveApplication();
  const pending = deferRequest(input => input.endsWith('/key'));
  const user = userEvent.setup();
  const view = render(<McpAdmin />);
  await openDetails(user);
  await user.click(screen.getByRole('button', { name: '查看完整密钥' }));
  if (exit === 'close') await user.click(screen.getByRole('button', { name: '关闭详情' }));
  if (exit === 'escape') fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
  if (exit === 'pagehide') act(() => window.dispatchEvent(new Event('pagehide')));
  if (exit === 'unmount') view.unmount();
  if (exit === 'filter') fireEvent.change(screen.getByLabelText('申请状态'), { target: { value: 'approved' } });
  if (exit === 'page') fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  expect(pending.signal.aborted).toBe(true);
  if (exit !== 'unmount') await openDetails(user);
  await pending.finish({ apiKey: secret });
  expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument();
});

test('pagehide clears a displayed secret', async () => {
  approveApplication();
  const user = userEvent.setup();
  render(<McpAdmin />);
  await openDetails(user);
  await user.click(screen.getByRole('button', { name: '查看完整密钥' }));
  expect(await screen.findByLabelText('完整密钥')).toHaveValue(secret);
  act(() => window.dispatchEvent(new Event('pagehide')));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await openDetails(user);
  expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument();
});

test.each(['revoke', 'reissue'])('%s confirms and clears revealed secrets, retaining the real RPM for reissue', async action => {
  approveApplication();
  const user = userEvent.setup();
  render(<McpAdmin />);
  await openDetails(user);
  await user.click(screen.getByRole('button', { name: '查看完整密钥' }));
  await screen.findByLabelText('完整密钥');
  const button = screen.getByRole('button', { name: action === 'revoke' ? '撤销密钥' : '重新发放' });
  window.confirm.mockReturnValueOnce(false);
  await user.click(button);
  expect(screen.getByLabelText('完整密钥')).toHaveValue(secret);
  expect(calls.filter(call => call.method === 'POST')).toHaveLength(0);
  await user.click(button);
  await waitFor(() => expect(calls.some(call => call.url.pathname.endsWith(`/${action}`))).toBe(true));
  expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument();
  if (action === 'reissue') expect(calls.find(call => call.url.pathname.endsWith('/reissue')).body.requestsPerMinute).toBe(240);
});

test.each(['revoke', 'reissue'])('%s aborts a pending reveal and ignores its late response', async action => {
  approveApplication();
  const pending = deferRequest(input => input.endsWith('/key'));
  const user = userEvent.setup();
  render(<McpAdmin />);
  await openDetails(user);
  await user.click(screen.getByRole('button', { name: '查看完整密钥' }));
  await user.click(screen.getByRole('button', { name: action === 'revoke' ? '撤销密钥' : '重新发放' }));
  expect(pending.signal.aborted).toBe(true);
  await pending.finish({ apiKey: secret });
  expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument();
});

test('mutation finishing after close refreshes the row without reopening details', async () => {
  approveApplication();
  const pending = deferRequest((input, options) => options?.method === 'POST');
  const user = userEvent.setup();
  render(<McpAdmin />);
  await openDetails(user);
  await user.click(screen.getByRole('button', { name: '查看完整密钥' }));
  await screen.findByLabelText('完整密钥');
  await user.click(screen.getByRole('button', { name: '撤销密钥' }));
  await user.click(screen.getByRole('button', { name: '关闭详情' }));
  application = { ...application, key: { ...application.key, status: 'revoked', canReveal: false } };
  await pending.finish({ ok: true });
  expect(await screen.findByText('已撤销')).toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument();
});

test('a refreshed row updates details and disappearance closes the modal', async () => {
  const user = userEvent.setup();
  render(<McpAdmin />);
  await openDetails(user);
  approveApplication();
  await user.click(screen.getByRole('button', { name: '通过申请' }));
  expect(await screen.findByRole('button', { name: '重新发放' })).toBeInTheDocument();
  expect(screen.getByLabelText('每分钟请求数')).toHaveValue(240);
  const fetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn((input, options) => !options?.method && input.startsWith('/api/admin/mcp/applications?')
    ? Promise.resolve(Response.json({ items: [], total: 0 })) : fetch(input, options)));
  await user.click(screen.getByRole('button', { name: '撤销密钥' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(await screen.findByText('暂无符合条件的申请')).toBeInTheDocument();
});

test('switching applicants aborts the prior reveal and cannot show its result in another detail', async () => {
  approveApplication();
  const fetch = globalThis.fetch;
  const other = { ...application, id: '43', name: '另一位用户', email: 'other@example.com' };
  vi.stubGlobal('fetch', vi.fn((input, options) => input.startsWith('/api/admin/mcp/applications?')
    ? Promise.resolve(Response.json({ items: [application, other], total: 2 })) : fetch(input, options)));
  const pending = deferRequest(input => input.endsWith('/42/key'));
  const user = userEvent.setup();
  render(<McpAdmin />);
  const firstRow = (await screen.findByText('dev@example.com')).closest('tr');
  await user.click(within(firstRow).getByRole('button', { name: '查看详情' }));
  await user.click(screen.getByRole('button', { name: '查看完整密钥' }));
  const secondRow = screen.getByText('other@example.com').closest('tr');
  fireEvent.click(within(secondRow).getByRole('button', { name: '查看详情' }));
  expect(pending.signal.aborted).toBe(true);
  expect(within(screen.getByRole('dialog')).getByText('other@example.com')).toBeInTheDocument();
  await pending.finish({ apiKey: secret });
  expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument();
});

test.each([200, 500])('a mutation finishing after reopening cannot restore stale feedback (%s)', async status => {
  const pending = deferRequest((input, options) => options?.method === 'POST');
  const user = userEvent.setup();
  render(<McpAdmin />);
  await openDetails(user);
  await user.click(screen.getByRole('button', { name: '通过申请' }));
  await user.click(screen.getByRole('button', { name: '关闭详情' }));
  await openDetails(user);
  await pending.finish(status === 200 ? { ok: true } : { message: '旧操作失败' }, status);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.queryByText('申请已通过，已尝试发送领取通知。')).not.toBeInTheDocument();
});

test('a malformed reveal response never displays a secret and remains retryable', async () => {
  approveApplication();
  const fetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn((input, options) => input.endsWith('/key')
    ? Promise.resolve(Response.json({ apiKey: null })) : fetch(input, options)));
  const user = userEvent.setup();
  render(<McpAdmin />);
  await openDetails(user);
  await user.click(screen.getByRole('button', { name: '查看完整密钥' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('未能读取完整密钥');
  expect(screen.queryByLabelText('完整密钥')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '查看完整密钥' })).toBeEnabled();
});

test('clipboard failure leaves the revealed key available for manual copying', async () => {
  approveApplication();
  const user = userEvent.setup();
  vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
  render(<McpAdmin />);
  await openDetails(user);
  await user.click(screen.getByRole('button', { name: '查看完整密钥' }));
  await user.click(await screen.findByRole('button', { name: '复制密钥' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('请手动复制密钥');
  expect(screen.getByLabelText('完整密钥')).toHaveValue(secret);
});

test('automatic pagination fallback closes details even if the applicant appears on the previous page', async () => {
  approveApplication();
  const fetch = globalThis.fetch;
  let shrink = false;
  vi.stubGlobal('fetch', vi.fn((input, options) => shrink && input.includes('applications?page=2')
    ? Promise.resolve(Response.json({ items: [], total: 1 })) : fetch(input, options)));
  const user = userEvent.setup();
  render(<McpAdmin />);
  await screen.findByText('dev@example.com');
  await user.click(screen.getByRole('button', { name: '下一页' }));
  await openDetails(user);
  shrink = true;
  await user.click(screen.getByRole('button', { name: '撤销密钥' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled());
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
