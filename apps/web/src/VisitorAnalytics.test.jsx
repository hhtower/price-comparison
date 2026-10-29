import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { render, screen, cleanup, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import VisitorAnalytics from './VisitorAnalytics.jsx';

const summary = { period: { timezone: 'Asia/Shanghai' }, overview: { pageViews: 12, visitors: 5, sessions: 7, avgActiveMs: 45000, actions: 8 }, trend: [{ date: '2026-09-26', pageViews: 4, visitors: 2, sessions: 3 }, { date: '2026-09-27', pageViews: 8, visitors: 4, sessions: 4 }], pages: [{ key: 'catalog', count: 12 }], devices: [{ key: 'desktop', count: 12 }], browsers: [{ key: 'chrome', count: 12 }], sources: [{ key: 'direct', count: 12 }], actions: [{ key: 'search', count: 8 }] };
const visits = { items: [{ id: 'one', visitorId: 'visitor-one', sessionId: 'session-one', page: 'catalog', device: 'desktop', browser: 'chrome', source: 'direct', activeMs: 45000, actions: 2, startedAt: '2026-09-27T01:00:00Z' }], total: 21, page: 1, pageSize: 20 };
const json = data => ({ ok: true, status: 200, json: async () => data });
const exclusions = { ips: ['127.0.0.1', '192.0.2.6', '::1'], currentIp: '1.1.1.1' };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('shows server-observed IP, geographic and ISP distributions and honest missing locations', async () => {
  const geoSummary = { ...summary, countries: [{ key: '中国', count: 12 }], regions: [{ key: '中国 / 广东省', count: 12 }], cities: [{ key: '中国 / 广东省 / 深圳市', count: 12 }], isps: [{ key: '中国电信', count: 12 }] };
  const geoVisits = { ...visits, items: [
    { ...visits.items[0], ip: '8.8.8.8', country: '中国', region: '广东省', city: '深圳市', isp: '中国电信', geoStatus: 'resolved', geoFromCache: true },
    { ...visits.items[0], id: 'legacy', ip: null, country: null, region: null, city: null, isp: null, geoStatus: 'unknown' },
    { ...visits.items[0], id: 'ipv6', ip: '2001:4860:4860::8888', country: null, region: null, city: null, isp: null, geoStatus: 'unavailable' },
    { ...visits.items[0], id: 'local', ip: '127.0.0.1', country: null, region: null, city: null, isp: null, geoStatus: 'local' },
  ] };
  vi.stubGlobal('fetch', vi.fn(async url => json(String(url).includes('/excluded-ips') ? exclusions : String(url).includes('/summary') ? geoSummary : geoVisits)));
  render(<VisitorAnalytics />);
  expect(await screen.findByText('8.8.8.8')).toBeInTheDocument();
  expect(screen.getByText('2001:4860:4860::8888')).toBeInTheDocument();
  expect(within(screen.getByRole('region', { name: '国家 / 地区分布' })).getByText('中国')).toBeInTheDocument();
  expect(within(screen.getByRole('region', { name: '省份分布' })).getByText('中国 / 广东省')).toBeInTheDocument();
  expect(within(screen.getByRole('region', { name: '城市分布' })).getByText('中国 / 广东省 / 深圳市')).toBeInTheDocument();
  expect(within(screen.getByRole('region', { name: '运营商分布' })).getByText('中国电信')).toBeInTheDocument();
  expect(screen.getByText('未记录 IP')).toBeInTheDocument();
  expect(screen.getByText('归属地暂不可用')).toBeInTheDocument();
  expect(screen.getByText('内网 / 保留地址')).toBeInTheDocument();
  expect(screen.getByText('IP 缓存补充')).toBeInTheDocument();
});

it('ranks features by usage or visitors and displays anonymous visitor activity in the same period', async () => {
  const data = { ...summary, actions: [{ key: 'search', count: 8, visitors: 2 }, { key: 'ai_test', count: 3, visitors: 3 }], visitorRanking: [
    { visitorId: 'active-visitor-one', pageViews: 4, actions: 8, activeMs: 90000, lastSeenAt: '2026-09-29T01:00:00Z' },
    { visitorId: 'active-visitor-two', pageViews: 2, actions: 3, activeMs: 30000, lastSeenAt: '2026-09-29T02:00:00Z' },
  ] };
  vi.stubGlobal('fetch', vi.fn(async url => json(String(url).includes('/excluded-ips') ? exclusions : String(url).includes('/summary') ? data : visits)));
  const user = userEvent.setup(); render(<VisitorAnalytics />);
  const features = await screen.findByRole('region', { name: '功能使用排行' });
  expect(within(features).getAllByRole('row')[1]).toHaveTextContent('商品搜索');
  expect(within(features).getAllByRole('row')[1]).toHaveTextContent('72.7%');
  await user.selectOptions(within(features).getByLabelText('功能排行排序'), 'visitors');
  expect(within(features).getAllByRole('row')[1]).toHaveTextContent('发起 AI 检测');
  const people = screen.getByRole('region', { name: '访客活跃排行' });
  expect(within(people).getAllByRole('row')[1]).toHaveTextContent('1.5 分钟');
  expect(within(people).getByTitle('active-visitor-one')).toBeInTheDocument();
  expect(within(people).getByTitle('active-visitor-two')).toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText('统计范围'), '30');
  await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/summary?days=30'), expect.anything()));
});
it('shows real metrics, accessible charts and paginated visits while date changes reset pagination', async () => {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async url => { calls.push(String(url)); return json(String(url).includes('/excluded-ips') ? exclusions : String(url).includes('/summary') ? summary : { ...visits, page: Number(new URL(String(url), 'http://localhost').searchParams.get('page')) }); }));
  const user = userEvent.setup(); render(<VisitorAnalytics />);
  expect(await screen.findByRole('heading', { name: '访问统计' })).toBeInTheDocument();
  expect(await screen.findByRole('img', { name: '访问趋势：浏览量与独立访客' })).toBeInTheDocument();
  expect(within(screen.getByLabelText('浏览量 PV')).getByText('12')).toBeInTheDocument();
  expect(within(screen.getByLabelText('独立访客 UV')).getByText('5')).toBeInTheDocument();
  expect(screen.getByText('visitor-')).toBeInTheDocument();
  await user.click(within(screen.getByLabelText('访问明细分页')).getByRole('button', { name: '下一页' }));
  await waitFor(() => expect(calls.some(url => url.includes('page=2'))).toBe(true));
  await user.selectOptions(screen.getByLabelText('统计范围'), '30');
  await waitFor(() => expect(calls.some(url => url.includes('days=30') && url.includes('page=1'))).toBe(true));
});
it('shows empty data honestly and permits retry after a failed request', async () => {
  const empty = { ...summary, overview: { pageViews: 0, visitors: 0, sessions: 0, avgActiveMs: 0, actions: 0 }, trend: [], pages: [], devices: [], browsers: [], sources: [], actions: [] };
  let failed = true;
  vi.stubGlobal('fetch', vi.fn(async url => { if (failed) throw new Error('网络不可用'); return json(String(url).includes('/excluded-ips') ? exclusions : String(url).includes('/summary') ? empty : { ...visits, items: [], total: 0 }); }));
  const user = userEvent.setup(); render(<VisitorAnalytics />);
  expect(await screen.findByRole('alert')).toHaveTextContent('网络不可用');
  failed = false; await user.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByText('所选时段暂无访问记录')).toBeInTheDocument();
  expect(within(screen.getByLabelText('浏览量 PV')).getByText('0')).toBeInTheDocument();
});

it('shows reference usage and distinguishes popular billing periods using the published catalog', async () => {
  const monthly = '["6744120541","subscription","P1M"]';
  const yearly = '["6744120541","subscription","P1Y"]';
  const data = { ...summary, actions: [{ key: 'reference_open', count: 8, visitors: 3 }], reference: {
    opens: 8, visitors: 3, products: [{ key: '6448311069', count: 5, visitors: 2 }], plans: [
      { appId: '6448311069', planId: monthly, count: 4, visitors: 2 },
      { appId: '6448311069', planId: yearly, count: 2, visitors: 1 },
    ],
  } };
  vi.stubGlobal('fetch', vi.fn(async url => json(String(url).includes('/excluded-ips') ? exclusions : String(url).includes('/summary') ? data
    : String(url).includes('/official-reference/catalog') ? { apps: [{ id: '6448311069', plans: [{ id: monthly, name: 'ChatGPT Plus', period: 'P1M' }, { id: yearly, name: 'ChatGPT Plus', period: 'P1Y' }] }] } : visits)));
  render(<VisitorAnalytics />);
  const reference = await screen.findByRole('region', { name: '官网正价参考使用情况' });
  expect(within(reference).getByLabelText('打开次数')).toHaveTextContent('8');
  expect(within(reference).getByLabelText('使用访客')).toHaveTextContent('3');
  expect(within(reference).getByRole('region', { name: '产品切换排行' })).toHaveTextContent('ChatGPT');
  expect(await within(reference).findAllByRole('cell', { name: 'ChatGPT Plus' })).toHaveLength(2);
  const rows = within(reference).getAllByRole('row');
  expect(rows.some(row => row.textContent.includes('每月') && row.textContent.includes('6744120541'))).toBe(true);
  expect(rows.some(row => row.textContent.includes('每年') && row.textContent.includes('6744120541'))).toBe(true);
  expect(screen.getByText('打开官网正价参考')).toBeInTheDocument();
});

it('keeps reference counts readable when current catalog labels cannot be loaded', async () => {
  const data = { ...summary, reference: { opens: 1, visitors: 1, products: [], plans: [{ appId: '6473753684', planId: '["6744120541","subscription","P1M"]', count: 1, visitors: 1 }] } };
  vi.stubGlobal('fetch', vi.fn(async url => {
    if (String(url).includes('/official-reference/catalog')) throw new Error('offline');
    return json(String(url).includes('/excluded-ips') ? exclusions : String(url).includes('/summary') ? data : visits);
  }));
  render(<VisitorAnalytics />);
  const reference = await screen.findByRole('region', { name: '官网正价参考使用情况' });
  expect(within(reference).getByLabelText('打开次数')).toHaveTextContent('1');
  expect(within(reference).getByText('SKU 6744120541')).toBeInTheDocument();
  expect(within(reference).getByText('Claude')).toBeInTheDocument();
  expect(await within(reference).findByText(/套餐名称暂不可用/)).toBeInTheDocument();
});
