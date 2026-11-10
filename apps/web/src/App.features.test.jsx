import React from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { VirtuosoMockContext } from 'react-virtuoso';
import App from './App.jsx';

const originalHead = document.head.innerHTML;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); document.head.innerHTML = originalHead; });
const product = { id: '42', name: 'ChatGPT GO', platform: 'openai', isAiMembership: true };
const offer = { productId: 'sku', shopId: '7', shop: '会员店', name: '租号报价', membershipKind: 'rental', price: '10', currency: 'CNY', inStock: true, tags: [] };
function mockApi({ ai = true, merged = false } = {}) {
  const requests = [];
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = new URL(input, 'http://localhost');
    requests.push(url);
    if (url.pathname.endsWith('/price-history')) return Response.json({ points: [] });
    if (url.pathname === '/api/catalog/products/41' && merged) return Response.json({ id: '41', mergedIntoId: '42' });
    if (url.pathname === '/api/catalog/products/42') return Response.json({ ...product, isAiMembership: ai });
    if (url.pathname === '/api/catalog/facets') return Response.json({ tagFacets: [] });
    if (url.pathname === '/api/catalog') {
      const page = Number(url.searchParams.get('detailPage') || 0);
      const shops = url.searchParams.get('detailKind') === 'shops';
      return Response.json({ total: 1, platformFacets: ['openai'], items: [{ ...product, offers: [offer], shopCount: 1, productCount: 25,
        membershipGroups: [{ kind: 'rental', shopCount: 1, productCount: 25, minPrice: '10', maxPrice: '10', offers: [offer] }],
        ...(url.searchParams.has('detailKind') ? { detail: { total: 25, page, pageSize: 12,
          entries: shops ? [{ key: '7', name: '会员店', count: 25, offer }] : [{ ...offer, name: '租号报价' + page }] } } : {}) }] });
    }
    if (url.pathname === '/api/assistant/status') return Response.json({ enabled: false });
    return Response.json({ items: [], enabled: false });
  }));
  return requests;
}
function mount(path) {
  window.history.replaceState({}, '', path);
  return render(<VirtuosoMockContext.Provider value={{ viewportHeight: 900, itemHeight: 300 }}><App /></VirtuosoMockContext.Provider>);
}
function expectScope(requests, kind = 'rental') {
  const scoped = requests.filter(url => url.searchParams.has('detailKind') || url.pathname.endsWith('/price-history') || url.pathname.endsWith('/facets'));
  expect(scoped.length).toBeGreaterThan(0);
  for (const url of scoped) {
    expect(url.searchParams.getAll('membershipKind')).toEqual([kind]);
    expect(url.searchParams.get('newcomer')).toBe('false');
  }
}

test('homepage feature link opens a fixed feature page and feature modal cannot reset its scope', async () => {
  const requests = mockApi();
  mount('/');
  const link = await screen.findByRole('link', { name: 'ChatGPT GO · 租号' });
  expect(link).toHaveAttribute('href', '/products/42/features/rental');
  fireEvent.click(within(link.closest('article')).getByRole('button', { name: '25 条报价' }));
  const dialog = await screen.findByRole('dialog', { name: 'ChatGPT GO · 租号 · 报价' });
  fireEvent.click(within(dialog).getByRole('button', { name: '重置' }));
  expect(within(dialog).queryByRole('switch', { name: '新手' })).not.toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: '筛选', exact: true })).toBeInTheDocument();
  await within(dialog).findByText(/^租号报价0/);
  expectScope(requests);
  fireEvent.click(within(dialog).getByRole('button', { name: '关闭报价详情' }));
  fireEvent.click(link);
  await screen.findByRole('heading', { name: 'ChatGPT GO · 租号', level: 1 });
  expect(window.location.pathname).toBe('/products/42/features/rental');
});

test('route kind overrides malicious query and stays fixed after reset, clear, search, sort and shop navigation', async () => {
  const requests = mockApi();
  mount('/products/42/features/rental?membershipKind=account&membershipKind=top_up&newcomer=true&priceMax=50');
  await screen.findByRole('heading', { name: 'ChatGPT GO · 租号', level: 1 });
  await screen.findByText(/^租号报价0/);
  expect(screen.queryByRole('switch', { name: '新手' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '筛选（1）' }));
  expect(screen.queryByRole('group', { name: 'AI会员类型' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '清除全部', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: '应用筛选', exact: true }));
  expect(screen.getByRole('button', { name: '筛选', exact: true })).toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox', { name: '搜索商铺或报价' }), { target: { value: '成品号' } });
  fireEvent.submit(screen.getByRole('form', { name: '详情查询' }));
  await waitFor(() => expect(requests.some(url => url.searchParams.get('q') === '成品号')).toBe(true));
  fireEvent.change(screen.getByRole('combobox', { name: '报价排序' }), { target: { value: 'updated' } });
  fireEvent.click(screen.getByRole('button', { name: '重置', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: '按商铺', exact: true }));
  fireEvent.click(await screen.findByRole('button', { name: /会员店.*25 条报价/ }));
  await waitFor(() => expect(requests.some(url => url.searchParams.get('shopId') === '7')).toBe(true));
  expectScope(requests);
});

test.each(['42', '41'])('refresh and merge preserve feature canonical, schema and pagination: %s', async id => {
  const requests = mockApi({ merged: true });
  mount('/products/' + id + '/features/rental?page=2&membershipKind=short_term&newcomer=true');
  await screen.findByRole('heading', { name: 'ChatGPT GO · 租号', level: 1 });
  await screen.findByText(/^租号报价1/);
  expect(window.location.pathname).toBe('/products/42/features/rental');
  expect(document.title).toContain('租号');
  expect(new URL(document.head.querySelector('link[rel="canonical"]').href).pathname).toBe('/products/42/features/rental');
  expect(new URL(document.head.querySelector('link[rel="canonical"]').href).search).toBe('?page=2');
  expect(screen.getByRole('link', { name: '上一页报价' })).toHaveAttribute('href', '/products/42/features/rental');
  expect(screen.getByRole('link', { name: '下一页报价' })).toHaveAttribute('href', '/products/42/features/rental?page=3');
  expect(document.getElementById('page-structured-data').textContent).toContain('租号');
  expect(requests.some(url => url.searchParams.get('detailPage') === '1')).toBe(true);
  expectScope(requests);
});

test.each([['/products/42/features/unknown', true], ['/products/42/features/rental/extra', true], ['/products/42/features/rental', false]])('rejects invalid or non-AI feature routes: %s', async (path, ai) => {
  const requests = mockApi({ ai });
  mount(path);
  expect(await screen.findByRole('alert')).toHaveTextContent('商品特性不存在');
  expect(requests.some(url => url.searchParams.has('detailKind') || url.pathname.endsWith('/price-history'))).toBe(false);
  expect(document.head.querySelector('meta[name="robots"]').content).toBe('noindex, nofollow');
});
