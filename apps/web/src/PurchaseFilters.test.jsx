import React from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { VirtuosoMockContext } from 'react-virtuoso';
import userEvent from '@testing-library/user-event';
import PublicPage from './PublicPage.jsx';

afterEach(() => { window.history.replaceState({}, '', '/'); cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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
        [...groups].every(([name, tags]) => offer.tags?.some(tag => tag.name === name && tags.some(selected => selected.value === tag.value))));
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
  await screen.findByRole('group', { name: tagFacets.some(tag => tag.name === 'duration') ? '使用期限' : '地区', exact: true });
  return requests;
}


test('groups numeric days into years, months and days without conflating 360 and 365', async () => {
  const requests = await openFilters([30, 90, 365, 360, 31, 0.5].map(value => ({ name: 'duration', value })));
  for (const label of ['1个月', '3个月', '1年', '12个月', '31天', '12小时']) expect(screen.getByRole('checkbox', { name: '使用期限：' + label })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('checkbox', { name: '使用期限：1年' }));
  fireEvent.click(screen.getByRole('checkbox', { name: '使用期限：12个月' }));
  fireEvent.click(screen.getByRole('button', { name: '应用筛选（2）' }));
  await waitFor(() => expect(requests.at(-1).searchParams.getAll('tag').map(JSON.parse)).toEqual([{ name: 'duration', value: 360 }, { name: 'duration', value: 365 }]));
});

test('keeps common durations sorted and selected uncommon durations visible when collapsed', async () => {
  await openFilters(Array.from({ length: 9 }, (_, i) => ({ name: 'duration', value: (i + 1) * 30, priority: i === 8 ? 100 : 1 })));
  const group = within(screen.getByRole('group', { name: '按月' }));
  const values = () => group.getAllByRole('checkbox').map(input => input.closest('label').textContent);
  expect(values()).toEqual(['1个月', '3个月', '9个月']);
  fireEvent.click(group.getByRole('button', { name: '更多期限（按月）' }));
  expect(values()).toHaveLength(9);
  fireEvent.click(group.getByRole('checkbox', { name: '使用期限：8个月' }));
  fireEvent.click(group.getByRole('button', { name: '收起（按月）' }));
  expect(values()).toEqual(['1个月', '3个月', '8个月', '9个月']);
  expect(group.getByRole('checkbox', { name: '使用期限：8个月' })).toBeChecked();
});

test('clears durations only, cancels drafts, and preserves multiple selected regions', async () => {
  const requests = await openFilters([{ name: 'duration', value: 30 }, { name: 'duration', value: 365 }, { name: 'region', value: 'us' }, { name: 'region', value: 'jp' }]);
  for (const name of ['使用期限：1个月', '使用期限：1年', '地区：美区', '地区：日区']) fireEvent.click(screen.getByRole('checkbox', { name }));
  fireEvent.click(screen.getByRole('button', { name: '应用筛选（4）' }));
  await waitFor(() => expect(requests.at(-1).searchParams.getAll('tag')).toHaveLength(4));
  fireEvent.click(screen.getByRole('button', { name: '筛选（4）' }));
  fireEvent.click(await screen.findByRole('button', { name: '清除使用期限' }));
  expect(screen.getByRole('checkbox', { name: '地区：美区' })).toBeChecked();
  fireEvent.keyDown(window, { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: '筛选（4）' }));
  expect(await screen.findByRole('checkbox', { name: '使用期限：1个月' })).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: '清除使用期限' }));
  fireEvent.click(screen.getByRole('button', { name: '应用筛选（2）' }));
  await waitFor(() => expect(requests.at(-1).searchParams.getAll('tag').map(JSON.parse)).toEqual([{ name: 'region', value: 'jp' }, { name: 'region', value: 'us' }]));
});

test.each([{ kind: 'range', min: 30, max: 90 }, { kind: 'min', days: 30 }, { kind: 'max', days: 90 }, { kind: 'approx', days: 365 }, { kind: 'permanent' }])('round trips qualified duration %j as a structured value', async value => {
  const requests = await openFilters([{ name: 'duration', value }]);
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: '应用筛选（1）' }));
  await waitFor(() => expect(requests.at(-1).searchParams.getAll('tag').map(JSON.parse)).toEqual([{ name: 'duration', value }]));
});

test.each(['warrantyDaysMin=30', 'tag=' + encodeURIComponent(JSON.stringify({ name: 'warranty_days', value: '30' })), 'tag=' + encodeURIComponent(JSON.stringify({ name: 'duration', value: '1 month' }))])('invalidates obsolete bookmark %s explicitly without sending hidden conditions', async query => {
  window.history.replaceState({}, '', '/?' + query);
  const requests = await openFilters([{ name: 'region', value: 'us' }]);
  expect(screen.getByRole('alert')).toHaveTextContent('旧筛选条件已失效');
  expect(requests.every(url => !url.searchParams.has('warrantyDaysMin') && !url.searchParams.getAll('tag').length)).toBe(true);
  expect(screen.queryByRole('group', { name: '最低质保天数' })).not.toBeInTheDocument();
  expect(screen.queryByRole('slider')).not.toBeInTheDocument();
});

test('groups tools with access channels and keeps warranty descriptions as ordinary filters', async () => {
  const warranty = '购买后1小时内仅保首登，封号不保';
  const requests = await openFilters([{ name: 'region', value: 'us' }, { name: 'access_channel', value: 'web' }, { name: 'supported_client', value: 'codex' }, { name: 'warranty', value: warranty }, { name: 'bulk_purchase', value: 'supported' }]);
  const usage = within(screen.getByRole('group', { name: '使用入口/支持工具' }));
  expect(usage.getAllByRole('checkbox')).toHaveLength(2);
  fireEvent.click(screen.getByRole('checkbox', { name: '售后保障：' + warranty }));
  fireEvent.click(screen.getByRole('checkbox', { name: '批量购买：支持批量购买' }));
  fireEvent.click(screen.getByRole('button', { name: '应用筛选（2）' }));
  await waitFor(() => expect(requests.at(-1).searchParams.getAll('tag').map(JSON.parse)).toEqual([{ name: 'bulk_purchase', value: 'supported' }, { name: 'warranty', value: warranty }]));
  expect(requests.every(url => !url.searchParams.has('warrantyDaysMin'))).toBe(true);
});

test('restored structured durations match facets regardless of JSON property order', async () => {
  window.history.replaceState({}, '', '/?' + new URLSearchParams({ tag: JSON.stringify({ name: 'duration', value: { days: 30, kind: 'min' } }) }));
  const requests = await openFilters([{ name: 'duration', value: { kind: 'min', days: 30 } }]);
  expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  expect(screen.getByRole('checkbox', { name: '使用期限：至少1个月' })).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: '应用筛选（1）' }));
  expect(requests.filter(url => url.pathname === '/api/catalog').at(-1).searchParams.getAll('tag').map(JSON.parse)).toEqual([{ name: 'duration', value: { kind: 'min', days: 30 } }]);
});
