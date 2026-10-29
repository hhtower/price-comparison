import React from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App.jsx';

const virtual = vi.hoisted(() => ({ endReached: null }));
vi.mock('react-virtuoso', () => ({ Virtuoso: ({ data, itemContent, endReached, totalListHeightChanged }) => {
  virtual.endReached = endReached;
  React.useEffect(() => { totalListHeightChanged?.(data.length * 200); }, [data.length, totalListHeightChanged]);
  return <>{data.map((item, index) => <React.Fragment key={index}>{itemContent(index, item)}</React.Fragment>)}</>;
} }));

const product = { id: '42', name: 'ChatGPT Pro 100', platform: 'openai', kind: '账号与订阅' };
function mockApi({ failNext = false } = {}) {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input, options) => {
    const url = new URL(input, 'http://localhost');
    calls.push({ url, signal: options?.signal });
    if (url.pathname === '/api/catalog/products/42') return Response.json(product);
    if (url.pathname === '/api/catalog/facets') return Response.json({ tagFacets: [] });
    if (url.pathname === '/api/catalog') {
      const page = Number(url.searchParams.get('detailPage'));
      if (failNext && page === 1) { failNext = false; return new Response(null, { status: 503 }); }
      const filtered = Boolean(url.searchParams.get('q') || url.searchParams.get('shopId'));
      const total = filtered ? 2 : 25;
      const size = Number(url.searchParams.get('detailPageSize'));
      const entries = Array.from({ length: Math.max(0, Math.min(size, total - page * size)) }, (_, index) => {
        const id = page * size + index;
        return { productId: String(id), shopId: String(id), shop: '商铺' + id, name: (filtered ? '筛选' : '报价') + id,
          price: id + 10, currency: 'CNY', priceStatus: 'verified', priceExpiresAt: '2099-01-01T00:00:00Z', tags: [] };
      });
      const values = url.searchParams.get('detailKind') === 'shops' ? entries.map(offer => ({ key: offer.shopId, name: offer.shop, count: 2, offer })) : entries;
      return Response.json({ items: [{ ...product, offers: [], detail: { page, pageSize: size, entries: values, total } }] });
    }
    return new Response(null, { status: 204 });
  }));
  window.history.replaceState({}, '', '/products/42');
  return calls;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('compact product page hides site navigation and appends quotes until all are loaded', async () => {
  const calls = mockApi(); render(<App />);
  await screen.findByText('报价0');
  expect(screen.queryByRole('link', { name: '检测工具' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '提交商铺' })).not.toBeInTheDocument();
  expect(screen.queryByText(/本站展示第三方/)).not.toBeInTheDocument();
  expect(screen.queryByRole('navigation', { name: '报价分页' })).not.toBeInTheDocument();
  expect(calls.some(({ url }) => url.pathname === '/api/catalog/coverage')).toBe(false);
  await act(async () => virtual.endReached());
  await screen.findByText('报价12');
  expect(screen.getByText('报价0')).toBeInTheDocument();
  await act(async () => virtual.endReached());
  await screen.findByText('报价24');
  await screen.findByText('已显示全部 25 条报价');
  await act(async () => virtual.endReached());
  expect(calls.filter(({ url }) => url.searchParams.has('detailKind')).map(({ url }) => url.searchParams.get('detailPage'))).toEqual(['0', '1', '2']);
});

test('filtering resets continuous results and keeps filters in the URL', async () => {
  const calls = mockApi(); render(<App />);
  await screen.findByText('报价0');
  await act(async () => virtual.endReached());
  await screen.findByText('报价12');
  fireEvent.change(screen.getByRole('textbox', { name: '搜索商铺或报价' }), { target: { value: '筛选' } });
  fireEvent.submit(screen.getByRole('form', { name: '详情查询' }));
  await screen.findByText('筛选0');
  expect(screen.queryByText('报价12')).not.toBeInTheDocument();
  expect(calls.at(-1).url.searchParams.get('detailPage')).toBe('0');
  expect(new URLSearchParams(window.location.search).get('q')).toBe('筛选');
  expect(new URLSearchParams(window.location.search).has('detailPage')).toBe(false);
});

test('a failed next batch keeps loaded quotes and can retry the same batch', async () => {
  const calls = mockApi({ failNext: true }); render(<App />);
  await screen.findByText('报价0');
  await act(async () => virtual.endReached());
  await screen.findByText('更多报价加载失败');
  expect(screen.getByText('报价0')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '重试加载', exact: true }));
  await screen.findByText('报价12');
  expect(screen.getByText('报价0')).toBeInTheDocument();
  expect(calls.filter(({ url }) => url.searchParams.get('detailPage') === '1')).toHaveLength(2);
});

test('detail Enter searches immediately once and keeps applied price filters when sorting', async () => {
  const calls = mockApi(); render(<App />);
  await screen.findByText('报价0');
  fireEvent.click(screen.getByRole('button', { name: '筛选', exact: true }));
  fireEvent.change(screen.getByRole('spinbutton', { name: '最低价格' }), { target: { value: '10' } });
  fireEvent.change(screen.getByRole('spinbutton', { name: '最高价格' }), { target: { value: '20' } });
  expect(calls.filter(({ url }) => url.searchParams.has('priceMin'))).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: '应用筛选（1）' }));
  await screen.findByRole('button', { name: '筛选（1）' });
  fireEvent.change(screen.getByRole('textbox', { name: '搜索商铺或报价' }), { target: { value: '筛选' } });
  await act(async () => fireEvent.submit(screen.getByRole('form', { name: '详情查询' })));
  expect(calls.some(({ url }) => url.searchParams.get('q') === '筛选')).toBe(true);
  await act(async () => new Promise(resolve => setTimeout(resolve, 300)));
  expect(calls.filter(({ url }) => url.searchParams.get('q') === '筛选')).toHaveLength(1);
  fireEvent.change(screen.getByRole('combobox', { name: '报价排序' }), { target: { value: 'updated' } });
  await waitFor(() => expect(calls.at(-1).url.searchParams.get('offerSort')).toBe('updated'));
  expect(calls.at(-1).url.searchParams.get('priceMin')).toBe('10');
  expect(calls.at(-1).url.searchParams.get('priceMax')).toBe('20');
  expect(new URLSearchParams(window.location.search).get('priceMin')).toBe('10');
});

test('old page bookmarks start from the first batch while keeping search and sort', async () => {
  const calls = mockApi();
  window.history.replaceState({}, '', '/products/42?detailPage=4&q=筛选&offerSort=updated');
  render(<App />);
  await screen.findByText('筛选0');
  await waitFor(() => expect(calls.some(({ url }) => url.searchParams.get('detailPage') === '0')).toBe(true));
  expect(screen.getByRole('combobox', { name: '报价排序' })).toHaveValue('updated');
});

test.each(['offers', 'shops'])('one-click reset keeps the current %s scope and removes URL filters immediately', async kind => {
  const calls = mockApi();
  const params = new URLSearchParams({ q: '筛选', priceMin: '10', priceMax: '20', warrantyDaysMin: '30',
    tag: JSON.stringify({ name: 'access', value: 'dedicated' }), offerSort: 'updated', detailKind: kind });
  if (kind === 'offers') params.set('shopId', '7');
  window.history.replaceState({}, '', '/products/42?' + params);
  render(<App />);
  await screen.findByText(kind === 'shops' ? '商铺0' : '筛选0');
  fireEvent.change(screen.getByRole('textbox', { name: '搜索商铺或报价' }), { target: { value: '待执行搜索' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '重置', exact: true })));
  const result = new URLSearchParams(window.location.search);
  for (const key of ['q', 'priceMin', 'priceMax', 'tag', 'warrantyDaysMin']) expect(result.has(key)).toBe(false);
  expect(result.get('offerSort')).toBe('price');
  expect(result.get('detailKind')).toBe(kind);
  expect(result.get('shopId')).toBe(kind === 'offers' ? '7' : null);
  expect(screen.getByRole('textbox', { name: '搜索商铺或报价' })).toHaveValue('');
  expect(screen.getByRole('button', { name: '筛选', exact: true })).toBeInTheDocument();
  await act(async () => new Promise(resolve => setTimeout(resolve, 300)));
  expect(calls.some(({ url }) => url.searchParams.get('q') === '待执行搜索')).toBe(false);
  expect(calls.at(-1).url.searchParams.get('detailPage')).toBe('0');
});

test('applying an unchanged query does not leave a scroll reset pending for the next batch', async () => {
  mockApi();
  const scrollTo = vi.fn(); vi.stubGlobal('scrollTo', scrollTo);
  render(<App />);
  await screen.findByText('报价0');
  fireEvent.submit(screen.getByRole('form', { name: '详情查询' }));
  scrollTo.mockClear();
  await act(async () => virtual.endReached());
  await screen.findByText('报价12');
  expect(scrollTo).not.toHaveBeenCalled();
});

test('returning from a shop restores its cached continuous list and scroll position', async () => {
  const calls = mockApi();
  const scrollTo = vi.fn(); vi.stubGlobal('scrollTo', scrollTo);
  render(<App />);
  await screen.findByText('报价0');
  fireEvent.click(screen.getByRole('button', { name: '按商铺', exact: true }));
  await screen.findByText('商铺0');
  await act(async () => virtual.endReached());
  await screen.findByText('商铺12');
  const before = calls.filter(({ url }) => url.searchParams.get('detailKind') === 'shops').length;
  vi.spyOn(window, 'scrollY', 'get').mockReturnValue(800);
  fireEvent.click(screen.getByText('商铺12'));
  await screen.findByText('筛选0');
  fireEvent.click(screen.getByRole('button', { name: '← 返回商铺列表' }));
  await screen.findByText('商铺12');
  await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(0, 800));
  expect(calls.filter(({ url }) => url.searchParams.get('detailKind') === 'shops')).toHaveLength(before);
});

test('changing filters cancels a pending batch and discards its old results', async () => {
  const calls = mockApi();
  const base = globalThis.fetch;
  let pendingSignal;
  globalThis.fetch = vi.fn((input, options) => {
    const url = new URL(input, 'http://localhost');
    if (url.searchParams.get('detailPage') === '1' && !url.searchParams.get('q')) {
      pendingSignal = options.signal;
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
    }
    return base(input, options);
  });
  render(<App />);
  await screen.findByText('报价0');
  await act(async () => virtual.endReached());
  expect(pendingSignal.aborted).toBe(false);
  fireEvent.change(screen.getByRole('textbox', { name: '搜索商铺或报价' }), { target: { value: '筛选' } });
  fireEvent.submit(screen.getByRole('form', { name: '详情查询' }));
  await screen.findByText('筛选0');
  expect(pendingSignal.aborted).toBe(true);
  expect(screen.queryByText('报价0')).not.toBeInTheDocument();
  expect(calls.at(-1).url.searchParams.get('detailPage')).toBe('0');
});

test('visibility refresh rechecks all loaded batches and removes expired prices', async () => {
  mockApi();
  const base = globalThis.fetch;
  let expired = false;
  const pages = [];
  globalThis.fetch = vi.fn(async (input, options) => {
    const response = await base(input, options);
    const url = new URL(input, 'http://localhost');
    if (url.pathname !== '/api/catalog') return response;
    pages.push(Number(url.searchParams.get('detailPage')));
    const data = await response.json();
    if (expired) for (const offer of data.items[0].detail.entries) offer.priceExpiresAt = '2000-01-01T00:00:00Z';
    return Response.json(data);
  });
  render(<App />);
  await screen.findByText('报价0');
  await act(async () => virtual.endReached());
  await screen.findByText('报价12');
  expect(screen.getByText('¥22')).toBeInTheDocument();
  expired = true;
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  await waitFor(() => expect(screen.queryByText('¥22')).not.toBeInTheDocument());
  expect(pages).toEqual([0, 1, 0, 1]);
  expect(document.querySelector('.tile-price.best')).toBeNull();
});
