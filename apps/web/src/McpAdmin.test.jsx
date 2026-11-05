import React from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import McpAdmin from './McpAdmin.jsx';
import AdminPage from './AdminPage.jsx';

const calls = [];
let application;
let failAction;
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
    calls.push({ url, method: options?.method || 'GET', body: options?.body && JSON.parse(options.body) });
    if (options?.method === 'POST') return Response.json(failAction ? { message: '审核失败' } : { ok: true }, { status: failAction ? 500 : 200 });
    if (url.pathname === '/api/admin/mcp/applications') return Response.json({ items: [application], total: 11, page: Number(url.searchParams.get('page')), pageSize: 10 });
    return Response.json({ items: [], total: 0, page: 1, pageSize: 10 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('admin sidebar opens MCP review with status filtering and pagination', async () => {
  const user = userEvent.setup();
  render(<AdminPage initialAuthenticated />);
  await user.click(screen.getByRole('button', { name: 'MCP 接入' }));
  expect(await screen.findByText('dev@example.com')).toBeInTheDocument();
  expect(calls.find(call => call.url.pathname === '/api/admin/mcp/applications')?.url.search).toBe('?page=1&pageSize=10&status=pending');
  await user.click(screen.getByRole('button', { name: '下一页' }));
  await waitFor(() => expect(calls.some(call => call.url.searchParams.get('page') === '2')).toBe(true));
  await user.selectOptions(screen.getByLabelText('申请状态'), 'approved');
  await waitFor(() => expect(calls.some(call => call.url.search === '?page=1&pageSize=10&status=approved')).toBe(true));
});

test.each(['approve', 'reject'])('reviews with %s and sends the documented payload', async action => {
  const user = userEvent.setup();
  render(<McpAdmin />);
  await screen.findByText('dev@example.com');
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
  expect(await screen.findByText(/通知发送失败/)).toBeInTheDocument();
  if (action !== 'resend') expect(screen.getByText(/mcp_1234/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: { resend: '重发通知', revoke: '撤销密钥', reissue: '重新发放' }[action] }));
  await waitFor(() => expect(calls.find(call => call.url.pathname.endsWith(`/${action}`))?.body).toEqual(
    action === 'reissue' ? { expiresInDays: 90, requestsPerMinute: 60, reviewNote: '' } : {},
  ));
});

test('a failed review is visible and can be retried', async () => {
  failAction = true;
  const user = userEvent.setup();
  render(<McpAdmin />);
  await user.click(await screen.findByRole('button', { name: '通过申请' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('审核失败');
  expect(screen.getByRole('button', { name: '通过申请' })).toBeEnabled();
});

test('an application awaiting claim can be revoked before any key is issued', async () => {
  application = { ...application, status: 'approved',
    key: { prefix: null, status: 'unclaimed', expiresAt: '2027-02-02T00:00:00Z', lastUsedAt: null, requestsPerMinute: 60, requestCount: '0' } };
  render(<McpAdmin />);
  expect(await screen.findByText(/待领取/)).toBeInTheDocument();
  expect(screen.queryByText(/null/)).not.toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole('button', { name: '撤销密钥' }));
  await waitFor(() => expect(calls.some(call => call.url.pathname.endsWith('/revoke'))).toBe(true));
});

test('rejected applications can resend failed review notifications', async () => {
  application = { ...application, status: 'rejected', reviewNote: '用途不明确', notificationStatus: 'failed' };
  render(<McpAdmin />);
  await userEvent.setup().click(await screen.findByRole('button', { name: '重发通知' }));
  await waitFor(() => expect(calls.some(call => call.url.pathname.endsWith('/resend'))).toBe(true));
});

test('rejecting an application requires a reason', async () => {
  const user = userEvent.setup();
  render(<McpAdmin />);
  await user.click(await screen.findByRole('button', { name: '拒绝申请' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('拒绝原因');
  expect(calls.filter(call => call.method === 'POST')).toHaveLength(0);
});

test('approval sends edited expiry and request limits', async () => {
  const user = userEvent.setup();
  render(<McpAdmin />);
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
