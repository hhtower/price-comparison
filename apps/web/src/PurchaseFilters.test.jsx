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


const unlimited = label => within(screen.getByRole('group', { name: label })).getByRole('button', { name: '不限' });

test('each row starts unlimited; searching alone never selects a region', async () => {
  const requests = await openFilters([{ name: 'region', value: 'jp' }, { name: 'region', value: 'us' }, { name: 'duration', value: 90 }, { name: 'usage_warranty', value: '首登' }, { name: 'subscription_warranty', value: '质保 30 天' }]);
  for (const button of screen.getAllByRole('button', { name: '不限' })) expect(button).toHaveAttribute('aria-pressed', 'true');
  const region = screen.getByRole('combobox', { name: '地区' });
  expect(screen.queryByRole('option', { name: '日区' })).not.toBeInTheDocument();
  fireEvent.change(region, { target: { value: '日本' } });
  expect(unlimited('地区')).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(screen.getByRole('option', { name: '日区' }));
  fireEvent.change(region, { target: { value: 'US' } });
  fireEvent.click(screen.getByRole('option', { name: '美区' }));
  fireEvent.click(screen.getByRole('button', { name: '移除日区' }));
  for (const label of ['订阅保障', '使用保障', '使用期限']) {
    fireEvent.change(screen.getByRole('spinbutton', { name: `${label}至少天数` }), { target: { value: '30' } });
    expect(unlimited(label)).toHaveAttribute('aria-pressed', 'false');
  }
  fireEvent.click(unlimited('使用保障'));
  expect(screen.getByRole('spinbutton', { name: '使用保障至少天数' })).toHaveValue(null);
  fireEvent.click(screen.getByRole('button', { name: '应用筛选（3）' }));
  await waitFor(() => expect(requests.filter(url => url.pathname === '/api/catalog').at(-1).searchParams.getAll('tag').map(JSON.parse)).toEqual([
    { name: 'duration_min_days', value: 30 }, { name: 'region', value: 'us' }, { name: 'subscription_warranty_min_days', value: 30 },
  ]));
  fireEvent.click(screen.getByRole('button', { name: '筛选（3）' }));
  fireEvent.click(within(await screen.findByRole('group', { name: '使用期限' })).getByRole('button', { name: '不限' }));
  fireEvent.keyDown(window, { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: '筛选（3）' }));
  expect(await screen.findByRole('spinbutton', { name: '使用期限至少天数' })).toHaveValue(30);
  fireEvent.change(screen.getByRole('spinbutton', { name: '使用期限至少天数' }), { target: { value: '' } });
  expect(unlimited('使用期限')).toHaveAttribute('aria-pressed', 'true');
});

test.each(['warrantyDaysMin=30', 'tag=' + encodeURIComponent(JSON.stringify({ name: 'warranty_days', value: '30' })), 'tag=' + encodeURIComponent(JSON.stringify({ name: 'duration', value: '1 month' }))])('invalidates obsolete bookmark %s explicitly without sending hidden conditions', async query => {
  window.history.replaceState({}, '', '/?' + query);
  const requests = await openFilters([{ name: 'region', value: 'us' }]);
  expect(screen.getByRole('alert')).toHaveTextContent('旧筛选条件已失效');
  expect(requests.every(url => !url.searchParams.has('warrantyDaysMin') && !url.searchParams.getAll('tag').length)).toBe(true);
  expect(screen.queryByRole('group', { name: '最低质保天数' })).not.toBeInTheDocument();
  expect(screen.queryByRole('slider')).not.toBeInTheDocument();
});

test('legacy exact duration stays visible until explicitly replaced by a minimum', async () => {
  window.history.replaceState({}, '', '/?' + new URLSearchParams({ tag: JSON.stringify({ name: 'duration', value: { days: 30, kind: 'min' } }) }));
  const requests = await openFilters([{ name: 'duration', value: { kind: 'min', days: 30 } }]);
  expect(screen.getByRole('spinbutton', { name: '使用期限至少天数' })).toHaveValue(null);
  expect(within(screen.getByRole('group', { name: '使用期限' })).getByRole('button', { name: '至少1个月 ×' })).toBeVisible();
  fireEvent.change(screen.getByRole('spinbutton', { name: '使用期限至少天数' }), { target: { value: '31' } });
  fireEvent.click(screen.getByRole('button', { name: '应用筛选（1）' }));
  await waitFor(() => expect(requests.filter(url => url.pathname === '/api/catalog').at(-1).searchParams.getAll('tag').map(JSON.parse)).toEqual([{ name: 'duration_min_days', value: 31 }]));
});
