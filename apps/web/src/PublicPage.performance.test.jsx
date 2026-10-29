import React from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render as renderComponent, screen, waitFor, within } from '@testing-library/react';
import { VirtuosoMockContext } from 'react-virtuoso';
import PublicPage from './PublicPage.jsx';

// Drive batch loading explicitly; real scrolling is verified in the browser.
vi.mock('react-virtuoso', async importOriginal => {
  const original = await importOriginal();
  return { ...original, Virtuoso: props => <original.Virtuoso {...props} endReached={undefined} /> };
});

function render(ui) {
  return renderComponent(<VirtuosoMockContext.Provider value={{ viewportHeight: 3000, itemHeight: 300 }}>{ui}</VirtuosoMockContext.Provider>);
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const quote = id => ({ productId: String(id), shopId: String(id), shop: '商铺' + id, name: '报价' + id, price: 10, priceStatus: 'verified', priceExpiresAt: '2099-01-01T00:00:00Z', currency: 'CNY', tags: [] });
const product = id => ({ id: String(id), name: '商品' + id, platform: 'openai', shopCount: 4, productCount: 8, offers: [0, 1, 2, 3].map(n => quote(id * 4 + n)), offersTruncated: true });
const response = items => Response.json({ items, platformFacets: ['openai'] });
const facetsResponse = () => Response.json({ tagFacets: [{ name: 'access', value: 'dedicated', priority: 1 }] });

test('filter options use their dedicated endpoint without requesting a product page', async () => {
  const requests = [];
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/analytics/collect') return new Response(null, { status: 204 });
    if (url.pathname === '/api/catalog/coverage') return Response.json({ shopCount: 10, productCount: 100 });
    requests.push(url);
    return url.pathname === '/api/catalog/facets'
      ? Response.json({ tagFacets: [{ name: 'access', value: 'dedicated' }] })
      : response([product(0)]);
  }));
  render(<PublicPage />);
  await screen.findByRole('heading', { name: /^商品0 / });
  expect(requests).toHaveLength(1);
  expect(requests[0].pathname).toBe('/api/catalog');
  fireEvent.click(screen.getByRole('button', { name: '筛选', exact: true }));
  await screen.findByRole('checkbox', { name: /独享/ });
  expect(requests).toHaveLength(2);
  expect(requests.some(url => url.pathname === '/api/catalog/products')).toBe(false);
  const facets = requests.find(url => url.pathname === '/api/catalog/facets');
  expect(facets).toBeTruthy();
  expect(requests[0].searchParams.has('facets')).toBe(false);
  for (const parameter of ['view', 'limit', 'cursor', 'sort', 'facets']) {
    expect(facets.searchParams.has(parameter)).toBe(false);
  }
  expect(screen.getByRole('heading', { name: /^商品0 / })).toBeInTheDocument();
});

test('keeps three common duration shortcuts before expanding all choices', async () => {
  const tagFacets = [...Array.from({ length: 8 }, (_, i) => ({ name: 'duration', value: String(i + 1) + ' days', priority: 1 })),
    { name: 'duration', value: '30 days', priority: 100 }];
  vi.stubGlobal('fetch', vi.fn(async input => String(input).includes('/catalog/facets')
    ? Response.json({ tagFacets }) : response([product(0)])));
  render(<PublicPage />);
  await screen.findByRole('heading', { name: /^商品0 / });
  fireEvent.click(screen.getByRole('button', { name: '筛选', exact: true }));
  expect(await screen.findByRole('checkbox', { name: /30/ })).toBeInTheDocument();
  const group = screen.getByRole('checkbox', { name: /30/ }).closest('fieldset');
  expect(within(group).getAllByRole('checkbox')).toHaveLength(3);
  fireEvent.click(screen.getByRole('button', { name: '更多期限（按天）' }));
  expect(within(group).getAllByRole('checkbox')).toHaveLength(9);
});

test('typing before the debounce does not rerender existing prices', async () => {
  const fetchMock = vi.fn(async () => response(Array.from({ length: 20 }, (_, i) => product(i))));
  vi.stubGlobal('fetch', fetchMock);
  render(<PublicPage />);
  await screen.findByRole('heading', { name: /^商品0 / });
  const formatting = vi.spyOn(Number.prototype, 'toFixed');
  fireEvent.change(screen.getByRole('textbox', { name: '搜索商品' }), { target: { value: 'x' } });
  expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/catalog?'))).toHaveLength(1);
  expect(formatting).not.toHaveBeenCalled();
});

test('selecting the active platform and applying unchanged filters keep the existing results', async () => {
  const fetchMock = vi.fn(async url => String(url).includes('/catalog/facets') ? facetsResponse() : response([product(0)]));
  vi.stubGlobal('fetch', fetchMock);
  render(<PublicPage />);
  await screen.findByRole('heading', { name: /^商品0 / });
  fireEvent.click(screen.getByRole('button', { name: '全部', exact: true }));
  expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/catalog?'))).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: '筛选', exact: true }));
  await screen.findByRole('checkbox', { name: /独享/ });
  fireEvent.click(screen.getByRole('button', { name: '应用筛选', exact: true }));
  expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/catalog?'))).toHaveLength(1);
  expect(screen.getByRole('heading', { name: /^商品0 / })).toBeInTheDocument();
});

test('reopening unchanged filters reuses fresh facets and refresh invalidates them', async () => {
  const fetchMock = vi.fn(async url => String(url).includes('/catalog/facets') ? facetsResponse() : response([product(0)]));
  vi.stubGlobal('fetch', fetchMock);
  render(<PublicPage />);
  await screen.findByRole('heading', { name: /^商品0 / });
  for (let i = 0; i < 2; i++) {
    fireEvent.click(screen.getByRole('button', { name: '筛选', exact: true }));
    await screen.findByRole('checkbox', { name: /独享/ });
    fireEvent.click(screen.getByRole('button', { name: '筛选', exact: true }));
  }
  const facetCalls = () => fetchMock.mock.calls.filter(([url]) => new URL(url, 'http://localhost').pathname === '/api/catalog/facets');
  expect(facetCalls()).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: '刷新价格' }));
  await screen.findByRole('heading', { name: /^商品0 / });
  fireEvent.click(screen.getByRole('button', { name: '筛选', exact: true }));
  await screen.findByRole('checkbox', { name: /独享/ });
  expect(facetCalls()).toHaveLength(2);
});

test('facet reuse expires so reopening filters can show updated conditions', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
  let facets = [{ name: 'access', value: 'dedicated', priority: 1 }];
  const fetchMock = vi.fn(async url => String(url).includes('/catalog/facets') ? Response.json({ tagFacets: facets }) : response([product(0)]));
  vi.stubGlobal('fetch', fetchMock);
  render(<PublicPage />);
  await screen.findByRole('heading', { name: /^商品0 / });
  fireEvent.click(screen.getByRole('button', { name: '筛选', exact: true }));
  await screen.findByRole('checkbox', { name: /独享/ });
  fireEvent.click(screen.getByRole('button', { name: '筛选', exact: true }));
  clock.mockReturnValue(61000);
  facets = [{ name: 'duration', value: '30 days', priority: 2 }];
  fireEvent.click(screen.getByRole('button', { name: '筛选', exact: true }));
  expect(await screen.findByRole('checkbox', { name: /30天/ })).toBeInTheDocument();
  expect(screen.queryByRole('checkbox', { name: /独享/ })).not.toBeInTheDocument();
});

test('detail batches append quotes without facets and reuse fresh batches', async () => {
  const detailCalls = [];
  const item = { ...product(0), productCount: 24 };
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/analytics/collect') return new Response(null, { status: 204 });
    if (!url.searchParams.has('standardProductId')) return response([item]);
    detailCalls.push(url);
    const page = Number(url.searchParams.get('detailPage'));
    return response([{ ...item, detail: { kind: 'offers', page, pageSize: 12, total: 24, entries: Array.from({ length: 12 }, (_, i) => quote(page * 12 + i + 100)) } }]);
  }));
  render(<PublicPage />);
  await screen.findByRole('heading', { name: /^商品0 / });
  fireEvent.click(screen.getByRole('button', { name: '24 条报价' }));
  const dialog = screen.getByRole('dialog', { name: /报价/ });
  await within(dialog).findByText('报价100');
  expect(detailCalls[0].searchParams.has('facets')).toBe(false);
  expect(detailCalls[0].searchParams.get('detailKind')).toBe('offers');
  expect(detailCalls[0].searchParams.get('detailPageSize')).toBe('12');
  expect(within(dialog).getAllByRole('checkbox', { name: /对比报价/ })).toHaveLength(12);
  fireEvent.click(within(dialog).getByRole('button', { name: '加载更多报价' }));
  await within(dialog).findByText('报价112');
  expect(within(dialog).getByText('报价100')).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole('button', { name: '关闭报价详情' }));
  fireEvent.click(screen.getByRole('button', { name: '24 条报价' }));
  await within(screen.getByRole('dialog', { name: /报价/ })).findByText('报价100');
  expect(detailCalls.map(url => url.searchParams.get('detailPage'))).toEqual(['0', '1']);
});

test('a cached quote dialog still reports refresh failures and allows retry', async () => {
  let failed = false;
  const item = { ...product(0), productCount: 24 };
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = new URL(input, 'http://localhost');
    if (!url.searchParams.has('detailKind')) return response([item]);
    return failed ? new Response(null, { status: 503 }) : response([{ ...item, detail: { entries: [quote(100)], total: 1 } }]);
  }));
  render(<PublicPage />);
  fireEvent.click(await screen.findByRole('button', { name: '24 条报价' }));
  const dialog = within(screen.getByRole('dialog', { name: /报价/ }));
  await dialog.findByText('报价100');
  failed = true;
  fireEvent(document, new Event('visibilitychange'));
  await dialog.findByText('报价刷新失败');
  expect(dialog.getByText('报价100')).toBeInTheDocument();
  failed = false;
  fireEvent.click(dialog.getByRole('button', { name: '重试加载', exact: true }));
  await dialog.findByText('报价100');
});

test('virtualization bounds mounted cards when the loaded catalog grows', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response(Array.from({ length: 200 }, (_, i) => product(i)))));
  const { container } = render(<PublicPage />);
  await screen.findByRole('heading', { name: /^商品0 / });
  expect(container.querySelectorAll('.standard-product-card').length).toBeLessThan(30);
});
