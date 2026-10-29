import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import VisitorAnalytics from './VisitorAnalytics.jsx';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const endpoint = '/api/admin/analytics/excluded-ips';
const json = data => ({ ok: true, status: 200, json: async () => data });
function mockAnalytics({ currentIp = '8.8.8.8', failSave = false, failRead = false } = {}) {
  const ips = new Set(['127.0.0.1', '192.0.2.6', '::1']);
  const fetch = vi.fn(async (url, options = {}) => {
    const method = options.method || 'GET';
    if (String(url).startsWith(endpoint)) {
      if (method === 'GET') {
        if (failRead) throw new Error('名单读取失败');
        return json({ ips: [...ips], currentIp });
      }
      if (failSave) throw new Error('保存失败，请重试');
      if (method === 'POST') ips.add(url.endsWith('/current') ? currentIp : JSON.parse(options.body).ip);
      if (method === 'DELETE') ips.delete(decodeURIComponent(url.slice(endpoint.length + 1)));
      return { ok: true, status: 204 };
    }
    if (String(url).includes('/summary')) return json({
      overview: { pageViews: ips.has('8.8.8.8') ? 4 : 5, visitors: 1, sessions: 1, avgActiveMs: 0, actions: 0 },
      trend: [], pages: [], devices: [], browsers: [], sources: [], actions: [],
    });
    return json({ items: [], total: 0, page: 1, pageSize: 20 });
  });
  vi.stubGlobal('fetch', fetch);
  return { ips, fetch };
}

it('adds and removes exclusions, refreshes reports, and retains the saved list after remount', async () => {
  const { fetch } = mockAnalytics();
  const user = userEvent.setup();
  const view = render(<VisitorAnalytics />);
  const panel = await screen.findByRole('region', { name: '排除 IP' });
  expect(await within(panel).findByText('192.0.2.6')).toBeInTheDocument();
  await user.type(within(panel).getByLabelText('要排除的 IP'), '8.8.8.8');
  await user.click(within(panel).getByRole('button', { name: '添加排除' }));
  expect(await within(panel).findByRole('button', { name: '移除 8.8.8.8' })).toBeInTheDocument();
  expect(within(panel).getByLabelText('要排除的 IP')).toHaveValue('');
  await waitFor(() => expect(within(screen.getByLabelText('浏览量 PV')).getByText('4')).toBeInTheDocument());
  expect(fetch).toHaveBeenCalledWith(endpoint, expect.objectContaining({ method: 'POST', body: JSON.stringify({ ip: '8.8.8.8' }) }));
  view.unmount();
  render(<VisitorAnalytics />);
  expect(await screen.findByRole('button', { name: '移除 8.8.8.8' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '移除 8.8.8.8' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: '移除 8.8.8.8' })).not.toBeInTheDocument());
  await waitFor(() => expect(within(screen.getByLabelText('浏览量 PV')).getByText('5')).toBeInTheDocument());
  expect(fetch).toHaveBeenCalledWith(endpoint + '/8.8.8.8', expect.objectContaining({ method: 'DELETE' }));
});

it('excludes the server-observed current IP without sending a browser-supplied address', async () => {
  const { fetch } = mockAnalytics({ currentIp: '2001:db8::1' });
  const user = userEvent.setup(); render(<VisitorAnalytics />);
  const button = await screen.findByRole('button', { name: '排除当前 IP' });
  await waitFor(() => expect(button).toBeEnabled());
  expect(screen.getByText(/当前 IP：2001:db8::1/)).toBeInTheDocument();
  await user.click(button);
  expect(await screen.findByRole('button', { name: '移除 2001:db8::1' })).toBeInTheDocument();
  expect(fetch).toHaveBeenCalledWith(endpoint + '/current', expect.objectContaining({ method: 'POST' }));
  expect(fetch.mock.calls.find(([url, options]) => url === endpoint + '/current' && options.method === 'POST')[1].body).toBeUndefined();
  expect(screen.getByRole('button', { name: '当前 IP 已排除' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: '移除 2001:db8::1' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '排除当前 IP' })).toBeEnabled());
  expect(fetch).toHaveBeenCalledWith(endpoint + '/' + encodeURIComponent('2001:db8::1'), expect.objectContaining({ method: 'DELETE' }));
});

it('preserves the input and saved list when an exclusion cannot be saved', async () => {
  mockAnalytics({ failSave: true });
  const user = userEvent.setup(); render(<VisitorAnalytics />);
  expect(await screen.findByRole('button', { name: '移除 192.0.2.6' })).toBeInTheDocument();
  await user.type(screen.getByLabelText('要排除的 IP'), '8.8.8.8');
  await user.click(screen.getByRole('button', { name: '添加排除' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('保存失败，请重试');
  expect(screen.getByLabelText('要排除的 IP')).toHaveValue('8.8.8.8');
  expect(screen.queryByRole('button', { name: '移除 8.8.8.8' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '移除 192.0.2.6' }));
  expect(screen.getByRole('button', { name: '移除 192.0.2.6' })).toBeInTheDocument();
});

it('disables current-IP exclusion when the address is unavailable and blocks editing a failed list', async () => {
  mockAnalytics({ currentIp: null });
  const view = render(<VisitorAnalytics />);
  expect(await screen.findByText(/无法识别当前 IP/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '排除当前 IP' })).toBeDisabled();
  view.unmount();
  mockAnalytics({ failRead: true });
  render(<VisitorAnalytics />);
  expect(await screen.findByRole('alert')).toHaveTextContent('名单读取失败');
  expect(screen.getByRole('button', { name: '添加排除' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '排除当前 IP' })).toBeDisabled();
  expect(screen.queryByText('暂无排除 IP')).not.toBeInTheDocument();
});
