import React from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { VirtuosoMockContext } from 'react-virtuoso';
import PublicPage from './PublicPage.jsx';

const storageKey = 'catalog-browsing-mode';
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function mount(productId) {
  return render(<VirtuosoMockContext.Provider value={{ viewportHeight: 900, itemHeight: 300 }}>
    <PublicPage productId={productId} />
  </VirtuosoMockContext.Provider>);
}

function mockCatalog() {
  const requests = [];
  const offer = { productId: '11', shopId: '1', shop: '会员店', name: '月付代充', price: '99',
    currency: 'CNY', inStock: true, priceStatus: 'verified', capturedAt: '2026-10-24T00:00:00Z',
    priceExpiresAt: '2099-01-01T00:00:00Z', tags: [{ name: 'delivery', value: 'top_up' }, { name: 'warranty_days', value: '30' }] };
  const item = { id: '1', name: 'ChatGPT Plus', platform: 'openai', shopCount: 1, productCount: 1,
    offers: [offer], offersTruncated: true };
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/analytics/collect') return new Response(null, { status: 204 });
    requests.push(url);
    if (url.pathname === '/api/catalog/coverage') return Response.json({ shopCount: 1, productCount: 1 });
    if (url.pathname === '/api/catalog/products/1') return Response.json({ id: '1', name: item.name, platform: 'openai', kind: '账号与订阅' });
    if (url.pathname === '/api/catalog/facets') return Response.json({ tagFacets: [{ name: 'warranty_days', value: '30' }] });
    return Response.json({ total: 1, offerTotal: 1, platformFacets: ['openai'],
      items: [{ ...item, ...(url.searchParams.has('detailKind')
        ? { detail: { kind: 'offers', entries: [offer], total: 1, page: 0, pageSize: 12 } } : {}) }] });
  }));
  return requests;
}

test('first visit opens the catalog directly and places only 新手 before the sorting select', async () => {
  localStorage.removeItem(storageKey);
  mockCatalog();
  mount();
  await screen.findByRole('link', { name: 'ChatGPT Plus' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  const toggle = screen.getByRole('switch', { name: '新手', exact: true });
  const sort = screen.getByRole('combobox', { name: '商品排序' });
  expect(toggle.closest('.catalog-actions')).toBe(sort.closest('.catalog-actions'));
  expect(toggle.closest('label').textContent).toBe('新手');
  expect(screen.queryByText('排序', { exact: true })).not.toBeInTheDocument();
  expect(toggle).not.toBeChecked();
  expect(localStorage.getItem(storageKey)).toBe('browse');
});

test('the newcomer switch remembers its mode and carries it into facets, previews and offer details', async () => {
  localStorage.removeItem(storageKey);
  const requests = mockCatalog();
  mount();
  fireEvent.click(screen.getByRole('switch', { name: '新手' }));
  await waitFor(() => expect(localStorage.getItem(storageKey)).toBe('newcomer'));
  expect(screen.getByRole('switch', { name: '新手' })).toBeChecked();
  const link = await screen.findByRole('link', { name: 'ChatGPT Plus' });
  expect(link).toHaveAttribute('href', '/products/1?newcomer=true');
  fireEvent.click(screen.getByRole('button', { name: /^筛选$/ }));
  await waitFor(() => expect(requests.some(url => url.pathname.endsWith('/facets') && url.searchParams.get('newcomer') === 'true')).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: /应用筛选/ }));
  fireEvent.click(screen.getByRole('button', { name: '1 条报价' }));
  await waitFor(() => expect(requests.some(url => url.searchParams.get('detailKind') === 'offers'
    && url.searchParams.get('newcomer') === 'true')).toBe(true));
});

test('browse mode is remembered across returning visits', async () => {
  localStorage.removeItem(storageKey);
  mockCatalog();
  const first = mount();
  expect(localStorage.getItem(storageKey)).toBe('browse');
  expect(screen.getByRole('switch', { name: '新手' })).not.toBeChecked();
  first.unmount();
  mount();
  expect(screen.getByRole('switch', { name: '新手' })).not.toBeChecked();
});

test.each(['true', 'false'])('first home visit applies a shared URL with newcomer=%s directly', async mode => {
  localStorage.removeItem(storageKey);
  window.history.replaceState({}, '', '/?newcomer=' + mode);
  mockCatalog();
  mount();
  await screen.findByRole('link', { name: 'ChatGPT Plus' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('switch', { name: '新手' }).checked).toBe(mode === 'true');
  expect(localStorage.getItem(storageKey)).toBe(mode === 'true' ? 'newcomer' : 'browse');
});

test('another tab changing the preference does not change the current list mode in offer details', async () => {
  localStorage.setItem(storageKey, 'browse');
  const requests = mockCatalog();
  mount();
  expect(await screen.findByRole('link', { name: 'ChatGPT Plus' })).toHaveAttribute('href', '/products/1?newcomer=false');
  localStorage.setItem(storageKey, 'newcomer');
  fireEvent.click(screen.getByRole('button', { name: '1 条报价' }));
  await waitFor(() => expect(requests.some(url => url.searchParams.get('detailKind') === 'offers'
    && url.searchParams.get('newcomer') === 'false')).toBe(true));
});

test('newcomer switch preserves explicit filters and history restores the previous mode', async () => {
  localStorage.setItem(storageKey, 'newcomer');
  const params = new URLSearchParams({ warrantyDaysMin: '90', newcomer: 'true' });
  params.append('tag', JSON.stringify({ name: 'region', value: 'us' }));
  window.history.replaceState({}, '', '/?' + params);
  const requests = mockCatalog();
  mount();
  await screen.findByRole('link', { name: 'ChatGPT Plus' });
  fireEvent.click(screen.getByRole('switch', { name: '新手' }));
  await waitFor(() => expect(localStorage.getItem(storageKey)).toBe('browse'));
  await waitFor(() => {
    const last = requests.filter(url => url.pathname === '/api/catalog').at(-1);
    expect(last.searchParams.get('newcomer')).not.toBe('true');
    expect(last.searchParams.get('warrantyDaysMin')).toBe('90');
    expect(last.searchParams.getAll('tag').map(JSON.parse)).toEqual([{ name: 'region', value: 'us' }]);
  });
  window.history.replaceState({}, '', '/?' + params);
  fireEvent(window, new PopStateEvent('popstate'));
  expect(screen.getByRole('switch', { name: '新手' })).toBeChecked();
});

test('a shared detail link applies its explicit newcomer mode', async () => {
  localStorage.removeItem(storageKey);
  window.history.replaceState({}, '', '/products/1?newcomer=true');
  const requests = mockCatalog();
  mount('1');
  await waitFor(() => expect(requests.some(url => url.searchParams.get('detailKind') === 'offers'
    && url.searchParams.get('newcomer') === 'true')).toBe(true));
  expect(localStorage.getItem(storageKey)).toBeNull();
});

test('history restores an unfiltered entry whose URL predates the mode choice', async () => {
  localStorage.setItem(storageKey, 'browse');
  mockCatalog();
  mount();
  const originalState = { ...window.history.state };
  expect(window.location.search).toBe('');
  fireEvent.click(screen.getByRole('switch', { name: '新手' }));
  expect(localStorage.getItem(storageKey)).toBe('newcomer');
  window.history.replaceState(originalState, '', '/');
  fireEvent(window, new PopStateEvent('popstate'));
  expect(screen.getByRole('switch', { name: '新手' })).not.toBeChecked();
});

test('returning from a product restores the history mode after the catalog remounts', async () => {
  localStorage.setItem(storageKey, 'browse');
  mockCatalog();
  const catalog = mount();
  const previousEntry = { ...window.history.state };
  catalog.unmount();
  localStorage.setItem(storageKey, 'newcomer');
  window.history.replaceState(previousEntry, '', '/');
  mount();
  expect(screen.getByRole('switch', { name: '新手' })).not.toBeChecked();
  expect(localStorage.getItem(storageKey)).toBe('browse');
});

test('explicit URL mode takes priority over a remembered preference', async () => {
  localStorage.setItem(storageKey, 'newcomer');
  window.history.replaceState({}, '', '/?newcomer=false');
  mockCatalog();
  mount();
  expect(screen.getByRole('switch', { name: '新手' })).not.toBeChecked();
});

test('the page remains usable when browser storage is unavailable', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage blocked'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage blocked'); });
  mockCatalog();
  mount();
  fireEvent.click(screen.getByRole('switch', { name: '新手' }));
  expect(screen.getByRole('switch', { name: '新手' })).toBeChecked();
});
