import React from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { VirtuosoMockContext } from 'react-virtuoso';
import userEvent from '@testing-library/user-event';
import PublicPage from './PublicPage.jsx';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function openFilters(tagFacets, product = {}) {
  const requests = [];
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/analytics/collect') return new Response(null, { status: 204 });
    requests.push(url);
    const params = url.searchParams;
    let detail;
    if (params.has('detailKind')) {
      const groups = Map.groupBy(params.getAll('tag').map(JSON.parse), tag => tag.name);
      const offers = (product.offers || []).filter(offer =>
        [...groups].every(([name, tags]) => offer.tags?.some(tag => tag.name === name && tags.some(selected => selected.value === tag.value)))
        && (!params.has('warrantyDaysMin') || offer.tags?.some(tag => tag.name === 'warranty_days' && Number(tag.value) >= Number(params.get('warrantyDaysMin')))));
      const page = Number(params.get('detailPage'));
      const pageSize = Number(params.get('detailPageSize'));
      detail = { kind: params.get('detailKind'), page, pageSize, total: offers.length, entries: offers.slice(page * pageSize, (page + 1) * pageSize) };
    }
    return Response.json(url.pathname === '/api/catalog/facets' ? { tagFacets } : {
      total: 1, platformFacets: ['openai', 'google'],
      items: [{ id: '1', name: '筛选测试商品', platform: 'openai', ...product, offers: (product.offers || []).slice(0, 4), ...(detail ? { detail } : {}) }],
    });
  }));
  render(<VirtuosoMockContext.Provider value={{ viewportHeight: 900, itemHeight: 300 }}><PublicPage /></VirtuosoMockContext.Provider>);
  await screen.findByRole('heading', { name: /筛选测试商品/ });
  fireEvent.click(screen.getByRole('button', { name: /^筛选(?:（\d+）)?$/ }));
  await screen.findByRole('group', { name: tagFacets.some(tag => tag.name === 'duration') ? '订阅时长' : '质保要求', exact: true });
  return requests;
}

test('shows minimum days only for period coverage and custom input only when requested', async () => {
  await openFilters([
    { name: 'warranty', value: 'covered' }, { name: 'warranty', value: 'none' },
    { name: 'warranty_scope', value: 'first_login' }, { name: 'warranty_days', value: '30' },
  ]);
  const group = within(screen.getByRole('group', { name: '质保要求', exact: true }));
  expect(group.getByRole('radio', { name: '质保要求不限' })).toBeChecked();
  expect(group.queryByRole('checkbox')).not.toBeInTheDocument();
  expect(screen.queryByRole('group', { name: '售后保障', exact: true })).not.toBeInTheDocument();
  expect(group.queryByRole('group', { name: '最低质保天数' })).not.toBeInTheDocument();
  fireEvent.click(group.getByRole('radio', { name: '按质保时长' }));
  expect(group.getByRole('group', { name: '最低质保天数' })).toBeInTheDocument();
  expect(group.queryByRole('textbox')).not.toBeInTheDocument();
  fireEvent.click(group.getByRole('radio', { name: '自定义最低质保天数' }));
  const input = group.getByRole('textbox', { name: '自定义最低质保天数' });
  expect(input).not.toHaveAttribute('aria-describedby');
  fireEvent.change(input, { target: { value: '-1' } });
  expect(group.getByRole('alert')).toHaveTextContent('1至36500');
  expect(document.getElementById(input.getAttribute('aria-describedby'))).toBe(group.getByRole('alert'));
  fireEvent.change(input, { target: { value: '30' } });
  expect(group.queryByRole('alert')).not.toBeInTheDocument();
  expect(input).not.toHaveAttribute('aria-describedby');
  expect(group.getByRole('radio', { name: '自定义最低质保天数' })).toBeChecked();
  expect(group.getByRole('radio', { name: '至少30天' })).not.toBeChecked();
  fireEvent.click(group.getByRole('radio', { name: '至少7天' }));
  expect(group.queryByRole('textbox')).not.toBeInTheDocument();
  fireEvent.click(group.getByRole('radio', { name: '仅保首次登录' }));
  expect(group.queryByRole('group', { name: '最低质保天数' })).not.toBeInTheDocument();
});

test('groups subscription units, orders them numerically and deduplicates aliases without merging months and days', async () => {
  const requests = await openFilters([
    { name: 'duration', value: '12 months', priority: 100 },
    { name: 'duration', value: '30 days', priority: 30 },
    { name: 'duration', value: '1 months', priority: 20 },
    { name: 'duration', value: '1 month', priority: 10 },
    { name: 'duration', value: '7 days', priority: 1 },
    { name: 'duration', value: '3 months', priority: 1 },
    { name: 'duration', value: '1 days', priority: 1 },
    { name: 'duration', value: '5 days', priority: 1000 },
    { name: 'duration', value: '25 days', priority: 1000 },
    { name: 'duration', value: '4 months', priority: 1000 },
    { name: 'duration', value: '10 months', priority: 1000 },
  ]);
  const group = screen.getByRole('group', { name: '订阅时长' });
  const labels = scope => within(scope).getAllByRole('checkbox').map(input => input.closest('label').textContent);
  expect(labels(within(group).getByRole('group', { name: '按天' }))).toEqual(['1天', '7天', '30天']);
  expect(labels(within(group).getByRole('group', { name: '按月' }))).toEqual(['1个月', '3个月', '12个月']);
  fireEvent.click(within(group).getByRole('checkbox', { name: /1个月$/ }));
  fireEvent.click(within(group).getByRole('checkbox', { name: /30天$/ }));
  fireEvent.click(screen.getByRole('button', { name: '应用筛选（2）' }));
  await waitFor(() => expect(requests.at(-1).searchParams.getAll('tag').map(JSON.parse)).toEqual([
    { name: 'duration', value: '1 month' }, { name: 'duration', value: '30 days' },
  ]));
});

test('keeps common durations sorted and selected uncommon durations visible after collapsing', async () => {
  await openFilters(Array.from({ length: 9 }, (_, i) => ({ name: 'duration', value: `${i + 1} months`, priority: i === 8 ? 100 : 1 })));
  const group = screen.getByRole('group', { name: '按月' });
  const values = () => within(group).getAllByRole('checkbox').map(input => Number.parseInt(input.closest('label').textContent));
  expect(values()).toEqual([1, 3, 9]);
  fireEvent.click(within(group).getByRole('button', { name: '更多期限（按月）' }));
  expect(values()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  fireEvent.click(within(group).getByRole('checkbox', { name: /8个月$/ }));
  fireEvent.click(within(group).getByRole('button', { name: '收起（按月）' }));
  expect(values()).toEqual([1, 3, 8, 9]);
  expect(within(group).getByRole('checkbox', { name: /8个月$/ })).toBeChecked();
});

test('only offers available durations and omits expansion when every option is visible', async () => {
  await openFilters([{ name: 'duration', value: '5 days' }, { name: 'duration', value: '25 days' }]);
  const group = within(screen.getByRole('group', { name: '订阅时长' }));
  expect(group.getAllByRole('checkbox').map(input => input.closest('label').textContent)).toEqual(['5天', '25天']);
  expect(group.queryByRole('group', { name: '按月' })).not.toBeInTheDocument();
  expect(group.queryByRole('button', { name: /更多/ })).not.toBeInTheDocument();
  expect(group.getByRole('status')).toHaveTextContent('不限');
  expect(group.queryByRole('button', { name: '清除订阅时长' })).not.toBeInTheDocument();
});

test('clears only duration drafts across units, allows cancellation and preserves other applied filters', async () => {
  const requests = await openFilters([
    { name: 'duration', value: '1 month' }, { name: 'duration', value: '30 days' },
    { name: 'delivery', value: 'top_up' }, { name: 'warranty_days', value: '90' },
  ]);
  const group = () => within(screen.getByRole('group', { name: '订阅时长' }));
  const catalog = () => requests.filter(url => url.pathname === '/api/catalog' && url.searchParams.get('limit') === '20').at(-1);
  expect(group().getByRole('status')).toHaveTextContent('不限');
  fireEvent.click(group().getByRole('checkbox', { name: /1个月$/ }));
  fireEvent.click(group().getByRole('checkbox', { name: /30天$/ }));
  expect(group().getByRole('status')).toHaveTextContent('已选 2 项');
  fireEvent.click(screen.getByRole('checkbox', { name: '交付方式：代充' }));
  fireEvent.click(screen.getByRole('radio', { name: '按质保时长' }));
  fireEvent.click(screen.getByRole('radio', { name: '至少90天' }));
  fireEvent.click(screen.getByRole('button', { name: '应用筛选（4）' }));
  await waitFor(() => expect(catalog().searchParams.getAll('tag')).toHaveLength(3));
  fireEvent.click(screen.getByRole('button', { name: '筛选（4）' }));
  fireEvent.click(await screen.findByRole('button', { name: '清除订阅时长' }));
  expect(group().getByRole('status')).toHaveTextContent('不限');
  expect(group().getAllByRole('checkbox').every(input => !input.checked)).toBe(true);
  expect(screen.getByRole('checkbox', { name: '交付方式：代充' })).toBeChecked();
  expect(screen.getByRole('radio', { name: '至少90天' })).toBeChecked();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(catalog().searchParams.getAll('tag')).toHaveLength(3);
  fireEvent.click(screen.getByRole('button', { name: '筛选（4）' }));
  expect(await screen.findByRole('checkbox', { name: '订阅时长：1个月' })).toBeChecked();
  expect(group().getByRole('status')).toHaveTextContent('已选 2 项');
  fireEvent.click(screen.getByRole('button', { name: '清除订阅时长' }));
  fireEvent.click(screen.getByRole('button', { name: '应用筛选（2）' }));
  await waitFor(() => expect(catalog().searchParams.getAll('tag').map(JSON.parse)).toEqual([{ name: 'delivery', value: 'top_up' }]));
  expect(catalog().searchParams.get('warrantyDaysMin')).toBe('90');
});

test('clears both duration units in quote details without clearing the delivery filter', async () => {
  const facets = [
    { name: 'duration', value: '1 month' }, { name: 'duration', value: '30 days' }, { name: 'duration', value: '7 days' },
    { name: 'delivery', value: 'top_up' }, { name: 'delivery', value: 'account' },
  ];
  const offers = [
    { name: '月付代充', tags: [facets[0], facets[3]] }, { name: '三十天代充', tags: [facets[1], facets[3]] },
    { name: '七天代充', tags: [facets[2], facets[3]] }, { name: '月付账号', tags: [facets[0], facets[4]] },
  ].map((offer, index) => ({ ...offer, productId: String(index), shopId: '1', shop: '测试店铺', currency: 'CNY', productUrl: 'https://example.com/' + index }));
  await openFilters(facets, { offers, productCount: 4 });
  fireEvent.keyDown(window, { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: '4 条报价' }));
  const dialog = within(screen.getByRole('dialog', { name: /筛选测试商品/ }));
  await dialog.findByText('月付代充');
  fireEvent.click(dialog.getByRole('button', { name: '筛选', exact: true }));
  fireEvent.click(await dialog.findByRole('checkbox', { name: '订阅时长：1个月' }));
  fireEvent.click(dialog.getByRole('checkbox', { name: '订阅时长：30天' }));
  fireEvent.click(dialog.getByRole('checkbox', { name: '交付方式：代充' }));
  fireEvent.click(dialog.getByRole('button', { name: /应用筛选/ }));
  expect(await dialog.findByText('月付代充')).toBeInTheDocument();
  expect(dialog.getByText('三十天代充')).toBeInTheDocument();
  expect(dialog.queryByText('七天代充')).not.toBeInTheDocument();
  expect(dialog.queryByText('月付账号')).not.toBeInTheDocument();
  fireEvent.click(dialog.getByRole('button', { name: '筛选（3）' }));
  fireEvent.click(await dialog.findByRole('button', { name: '清除订阅时长' }));
  expect(within(dialog.getByRole('group', { name: '订阅时长' })).getByRole('status')).toHaveTextContent('不限');
  fireEvent.click(dialog.getByRole('button', { name: /应用筛选/ }));
  expect(await dialog.findByText('七天代充')).toBeInTheDocument();
  expect(dialog.getByText('月付代充')).toBeInTheDocument();
  expect(dialog.getByText('三十天代充')).toBeInTheDocument();
  expect(dialog.queryByText('月付账号')).not.toBeInTheDocument();
});

test('applies one minimum warranty threshold to catalog and facet requests and clears it from the selected chip', async () => {
  const requests = await openFilters([{ name: 'warranty_days', value: '30' }, { name: 'warranty_days', value: '90' }]);
  fireEvent.click(screen.getByRole('radio', { name: '按质保时长' }));
  fireEvent.click(screen.getByRole('radio', { name: '至少7天' }));
  fireEvent.click(screen.getByRole('radio', { name: '至少30天' }));
  expect(screen.getByRole('radio', { name: '至少7天' })).not.toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: '应用筛选（1）' }));
  await waitFor(() => expect(requests.at(-1).searchParams.get('warrantyDaysMin')).toBe('30'));
  expect(requests.at(-1).searchParams.getAll('tag')).toEqual([]);
  expect(screen.getByRole('button', { name: /质保至少30天/ })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /^筛选（1）/ }));
  await waitFor(() => expect(requests.some(url => url.pathname.endsWith('/facets') && url.searchParams.get('warrantyDaysMin') === '30')).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: /质保至少30天/ }));
  expect(screen.queryByRole('button', { name: /质保至少30天/ })).not.toBeInTheDocument();
  expect(screen.getByRole('radio', { name: '质保要求不限' })).toBeChecked();
  expect(screen.queryByRole('group', { name: '最低质保天数' })).not.toBeInTheDocument();
});

test('validates custom warranty days, discards unapplied edits and preserves the threshold on a platform change', async () => {
  const requests = await openFilters([{ name: 'warranty_days', value: '25' }]);
  const catalogRequests = () => requests.filter(url => url.pathname === '/api/catalog' && url.searchParams.get('limit') === '20');
  fireEvent.click(screen.getByRole('radio', { name: '按质保时长' }));
  fireEvent.click(screen.getByRole('radio', { name: '自定义最低质保天数' }));
  const input = screen.getByRole('textbox', { name: '自定义最低质保天数' });
  for (const value of ['0', '-1', '1.5', '36501']) {
    fireEvent.change(input, { target: { value } });
    expect(screen.getByRole('button', { name: /应用筛选/ })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('1至36500');
  }
  fireEvent.change(input, { target: { value: '25' } });
  fireEvent.click(screen.getByRole('button', { name: '应用筛选（1）' }));
  await waitFor(() => expect(catalogRequests().at(-1).searchParams.get('warrantyDaysMin')).toBe('25'));
  fireEvent.click(screen.getByRole('button', { name: /^筛选（1）/ }));
  fireEvent.click(await screen.findByRole('radio', { name: '至少90天' }));
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(catalogRequests().at(-1).searchParams.get('warrantyDaysMin')).toBe('25');
  fireEvent.click(screen.getByRole('button', { name: /^筛选（1）/ }));
  expect(await screen.findByRole('textbox', { name: '自定义最低质保天数' })).toHaveValue('25');
  fireEvent.click(screen.getByRole('button', { name: 'Gemini / Google', exact: true }));
  await waitFor(() => expect(catalogRequests().at(-1).searchParams.get('platform')).toBe('google'));
  expect(catalogRequests().at(-1).searchParams.get('warrantyDaysMin')).toBe('25');
  expect(await screen.findByRole('textbox', { name: '自定义最低质保天数' })).toHaveValue('25');
  expect(screen.getByRole('button', { name: /质保至少25天/ })).toBeVisible();
});

test.each([
  ['first_login', '仅保首次登录'], ['activation', '仅保激活'], ['first_code', '仅保首次接码'], ['subscription', '仅保掉订阅'],
])('switching between minimum days and %s warranty replaces the previous query condition', async (scope, label) => {
  const requests = await openFilters([{ name: 'warranty_days', value: '30' }, { name: 'warranty_scope', value: scope }, { name: 'warranty', value: 'none' }]);
  const option = screen.getByRole('radio', { name: label });
  fireEvent.click(option);
  fireEvent.click(screen.getByRole('radio', { name: '按质保时长' }));
  fireEvent.click(screen.getByRole('radio', { name: '至少30天' }));
  expect(option).not.toBeChecked();
  fireEvent.click(option);
  expect(screen.queryByRole('group', { name: '最低质保天数' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '应用筛选（1）' }));
  await waitFor(() => expect(requests.at(-1).searchParams.getAll('tag').map(JSON.parse)).toEqual([{ name: 'warranty_scope', value: scope }]));
  expect(requests.at(-1).searchParams.has('warrantyDaysMin')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: /^筛选（1）/ }));
  fireEvent.click(await screen.findByRole('radio', { name: '无质保' }));
  fireEvent.click(screen.getByRole('button', { name: '应用筛选（1）' }));
  await waitFor(() => expect(requests.at(-1).searchParams.getAll('tag').map(JSON.parse)).toEqual([{ name: 'warranty', value: 'none' }]));
  expect(requests.at(-1).searchParams.has('warrantyDaysMin')).toBe(false);
});

test('does not treat incomplete number entry as clearing an applied warranty minimum', async () => {
  const user = userEvent.setup();
  await openFilters([{ name: 'warranty_days', value: '30' }]);
  await user.click(screen.getByRole('radio', { name: '按质保时长' }));
  await user.click(screen.getByRole('radio', { name: '至少30天' }));
  await user.click(screen.getByRole('button', { name: '应用筛选（1）' }));
  await user.click(screen.getByRole('button', { name: /^筛选（1）/ }));
  await user.click(await screen.findByRole('radio', { name: '自定义最低质保天数' }));
  const input = screen.getByRole('textbox', { name: '自定义最低质保天数' });
  for (const value of ['1e', '-', '+']) {
    await user.clear(input);
    await user.type(input, value);
    expect(input).toHaveDisplayValue(value);
    expect(screen.getByRole('button', { name: /应用筛选/ })).toBeDisabled();
    expect(screen.getByRole('radio', { name: '最低质保天数不限' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: /质保至少30天/ })).toBeInTheDocument();
  }
  await user.clear(input);
  await user.click(screen.getByRole('radio', { name: '最低质保天数不限' }));
  expect(screen.getByRole('radio', { name: '最低质保天数不限' })).toBeChecked();
  await user.click(screen.getByRole('button', { name: '应用筛选（1）' }));
  expect(screen.queryByRole('button', { name: /质保至少30天/ })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /按质保时长/ })).toBeInTheDocument();
});

test('keeps any coverage distinct from period coverage and clears only warranty conditions', async () => {
  const requests = await openFilters([
    { name: 'warranty', value: 'covered' }, { name: 'warranty_scope', value: 'period' },
    { name: 'delivery', value: 'top_up' },
  ]);
  fireEvent.click(screen.getByRole('checkbox', { name: '交付方式：代充' }));
  fireEvent.click(screen.getByRole('radio', { name: '按质保时长' }));
  fireEvent.click(screen.getByRole('radio', { name: '至少30天' }));
  fireEvent.click(screen.getByRole('radio', { name: '有质保（不限类型）' }));
  expect(screen.queryByRole('group', { name: '最低质保天数' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '应用筛选（2）' }));
  await waitFor(() => expect(requests.at(-1).searchParams.getAll('tag').map(JSON.parse)).toEqual([
    { name: 'delivery', value: 'top_up' }, { name: 'warranty', value: 'covered' },
  ]));
  expect(requests.at(-1).searchParams.has('warrantyDaysMin')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: /^筛选（2）/ }));
  fireEvent.click(await screen.findByRole('radio', { name: '质保要求不限' }));
  fireEvent.click(screen.getByRole('button', { name: '应用筛选（1）' }));
  await waitFor(() => expect(requests.at(-1).searchParams.getAll('tag').map(JSON.parse)).toEqual([{ name: 'delivery', value: 'top_up' }]));
});

test('replaces warranty conditions in the quote detail panel and displays filtered detail entries', async () => {
  const facets = [{ name: 'warranty', value: 'none' }, { name: 'warranty_scope', value: 'first_login' }, { name: 'warranty_scope', value: 'period' }, { name: 'warranty_days', value: '90' }];
  const offers = [
    { name: '首登报价', tags: [facets[1]] },
    { name: '长周期报价', tags: [facets[2], facets[3]] },
    { name: '无保报价', tags: [facets[0]] },
  ].map((offer, index) => ({ ...offer, productId: String(index), shopId: '1', shop: '测试店铺', currency: 'CNY', productUrl: 'https://example.com/' + index }));
  await openFilters(facets, { offers, productCount: 3 });
  fireEvent.keyDown(window, { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: '3 条报价' }));
  const dialog = within(screen.getByRole('dialog', { name: /筛选测试商品/ }));
  await dialog.findByText('首登报价');
  fireEvent.click(dialog.getByRole('button', { name: '筛选', exact: true }));
  fireEvent.click(await dialog.findByRole('radio', { name: '按质保时长' }));
  fireEvent.click(dialog.getByRole('radio', { name: '至少30天' }));
  fireEvent.click(dialog.getByRole('button', { name: /应用筛选/ }));
  expect(await dialog.findByText('长周期报价')).toBeInTheDocument();
  expect(dialog.queryByText('首登报价')).not.toBeInTheDocument();
  expect(dialog.queryByText('无保报价')).not.toBeInTheDocument();
  fireEvent.click(dialog.getByRole('button', { name: '筛选（1）' }));
  fireEvent.click(await dialog.findByRole('radio', { name: '无质保' }));
  fireEvent.click(dialog.getByRole('button', { name: /应用筛选/ }));
  expect(await dialog.findByText('无保报价')).toBeInTheDocument();
  expect(dialog.queryByText('长周期报价')).not.toBeInTheDocument();
  fireEvent.click(dialog.getByRole('button', { name: '筛选（1）' }));
  fireEvent.click(await dialog.findByRole('radio', { name: '质保要求不限' }));
  fireEvent.click(dialog.getByRole('button', { name: /应用筛选/ }));
  expect(await dialog.findByText('首登报价')).toBeInTheDocument();
  expect(dialog.getByText('长周期报价')).toBeInTheDocument();
  expect(dialog.getByText('无保报价')).toBeInTheDocument();
});

test.each(['', '30'])('restores legacy multi-warranty URLs as one visible requirement (minimum=%s)', async minimum => {
  const facets = [
    { name: 'warranty_scope', value: 'first_login' }, { name: 'warranty_scope', value: 'activation' },
    { name: 'warranty', value: 'none' }, { name: 'delivery', value: 'top_up' },
  ];
  const params = new URLSearchParams({ warrantyDaysMin: minimum });
  facets.forEach(tag => params.append('tag', JSON.stringify(tag)));
  window.history.replaceState(null, '', '/?' + params);
  const requests = await openFilters(facets);
  expect(screen.getByRole('radio', { name: minimum ? '按质保时长' : '仅保首次登录' })).toBeChecked();
  expect(screen.getByRole('radio', { name: '仅保激活' })).not.toBeChecked();
  expect(screen.getByRole('radio', { name: '无质保' })).not.toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: '应用筛选（2）' }));
  const catalog = requests.filter(url => url.pathname === '/api/catalog' && url.searchParams.get('limit') === '20').at(-1);
  expect(catalog.searchParams.getAll('tag').map(JSON.parse)).toEqual(minimum
    ? [{ name: 'delivery', value: 'top_up' }]
    : [{ name: 'delivery', value: 'top_up' }, { name: 'warranty_scope', value: 'first_login' }]);
  expect(catalog.searchParams.get('warrantyDaysMin')).toBe(minimum || null);
});
