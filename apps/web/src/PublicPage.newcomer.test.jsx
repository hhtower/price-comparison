import React from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { VirtuosoMockContext } from 'react-virtuoso';
import PublicPage from './PublicPage.jsx';
import App from './App.jsx';

const storageKey = 'catalog-browsing-mode';
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function mount(productId, viewportHeight = 900) {
  return render(<VirtuosoMockContext.Provider value={{ viewportHeight, itemHeight: 300 }}>
    <PublicPage productId={productId} />
  </VirtuosoMockContext.Provider>);
}

function mockCatalog() {
  const requests = [];
  const offer = { productId: '11', shopId: '1', shop: '会员店', name: '月付代充', price: '99',
    currency: 'CNY', inStock: true, priceStatus: 'verified', capturedAt: '2026-10-24T00:00:00Z',
    priceExpiresAt: '2099-01-01T00:00:00Z', tags: [{ name: 'delivery', value: 'top_up' }, { name: 'warranty_days', value: '30' }] };
  const item = { id: '1', name: 'ChatGPT Plus', platform: 'openai', shopCount: 1, productCount: 1,
    offers: [offer] };
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

test('first visit defaults to browse with collapsed membership kinds and four offers when expanded', async () => {
  localStorage.removeItem(storageKey);
  const requests = mockMembershipCatalog({ offersPerKind: 4 });
  mount(undefined, 2400);
  for (const kind of ['成品号', '代充', '租号', '短期']) {
    const link = await screen.findByRole('button', { name: 'ChatGPT Plus · ' + kind });
    expect(link.closest('article').querySelectorAll('.shop-offer')).toHaveLength(0);
    fireEvent.click(link);
    expect(link.closest('article').querySelectorAll('.shop-offer')).toHaveLength(4);
  }
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  const toggle = screen.getByRole('switch', { name: '新手', exact: true });
  const sort = screen.getByRole('combobox', { name: '商品排序' });
  expect(toggle.closest('.catalog-actions')).toBe(sort.closest('.catalog-actions'));
  expect(toggle.closest('label').textContent).toBe('新手');
  expect(screen.queryByText('排序', { exact: true })).not.toBeInTheDocument();
  expect(toggle).not.toBeChecked();
  expect(localStorage.getItem(storageKey)).toBe('browse');
  expect(requests.filter(url => url.pathname === '/api/catalog').every(url => url.searchParams.get('newcomer') !== 'true')).toBe(true);
});

test('the newcomer switch remembers its mode and carries it into facets, previews and offer details', async () => {
  localStorage.setItem(storageKey, 'browse');
  const requests = mockCatalog();
  mount();
  fireEvent.click(screen.getByRole('switch', { name: '新手' }));
  await waitFor(() => expect(localStorage.getItem(storageKey)).toBe('newcomer'));
  expect(screen.getByRole('switch', { name: '新手' })).toBeChecked();
  const link = await screen.findByRole('button', { name: 'ChatGPT Plus' });
  expect(link).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(screen.getByRole('button', { name: /^筛选$/ }));
  await waitFor(() => expect(requests.some(url => url.pathname.endsWith('/facets') && url.searchParams.get('newcomer') === 'true')).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: /应用筛选/ }));
  fireEvent.click(screen.getByRole('button', { name: '1 条报价' }));
  await waitFor(() => expect(requests.some(url => url.searchParams.get('detailKind') === 'offers'
    && url.searchParams.get('newcomer') === 'true')).toBe(true));
});

test('browse mode is remembered across returning visits', async () => {
  localStorage.setItem(storageKey, 'browse');
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
  await screen.findByRole('button', { name: 'ChatGPT Plus' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('switch', { name: '新手' }).checked).toBe(mode === 'true');
  expect(localStorage.getItem(storageKey)).toBe(mode === 'true' ? 'newcomer' : 'browse');
});

test('another tab changing the preference does not change the current list mode in offer details', async () => {
  localStorage.setItem(storageKey, 'browse');
  const requests = mockCatalog();
  mount();
  expect(await screen.findByRole('button', { name: 'ChatGPT Plus' })).toHaveAttribute('aria-expanded', 'false');
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
  await screen.findByRole('button', { name: 'ChatGPT Plus' });
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
  expect(screen.getByRole('switch', { name: '新手' })).not.toBeChecked();
  fireEvent.click(screen.getByRole('switch', { name: '新手' }));
  expect(screen.getByRole('switch', { name: '新手' })).toBeChecked();
});

function mockMembershipCatalog({ onlyKind, emptyKind, offersPerKind = 1 } = {}) {
  const requests = [];
  const products = [
    { id: '10', name: 'ChatGPT Plus', platform: 'openai', isAiMembership: true, kind: '账号与订阅' },
    { id: '4', name: 'YouTube Premium', platform: 'google', isAiMembership: false },
    { id: '5', name: 'ChatGPT 接码', platform: 'openai', isAiMembership: false },
  ];
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/analytics/collect') return new Response(null, { status: 204 });
    requests.push(url);
    if (url.pathname.endsWith('/coverage')) return Response.json({ shopCount: 1, productCount: products.length });
    if (url.pathname.endsWith('/price-history')) return Response.json({ points: [] });
    if (url.pathname === '/api/catalog/products') return Response.json({ items: products });
    if (url.pathname.startsWith('/api/catalog/products/')) return Response.json(products.find(item => url.pathname.endsWith('/' + item.id)));
    if (url.pathname.endsWith('/facets')) return Response.json({ tagFacets: [{ name: 'warranty_days', value: '30' }, { name: 'delivery', value: 'top_up' }] });
    const kinds = url.searchParams.getAll('membershipKind');
    const selected = url.searchParams.get('standardProductId');
    const query = url.searchParams.get('q')?.toLowerCase().replace(/代充|成品号|短期/gu, '').trim();
    const items = products.filter(product => (!selected || product.id === selected)
      && (!url.searchParams.get('platform') || product.platform === url.searchParams.get('platform'))
      && (!query || product.name.toLowerCase().includes(query))
      && (!onlyKind || product.isAiMembership))
      .map(product => {
        const groups = (product.isAiMembership ? [['account', '1'], ['top_up', '2'], ['short_term', '3'], ['rental', '6'], ['unclassified', '7']] : [[null, product.id]])
          .filter(([kind]) => (!onlyKind || kind === onlyKind) && (!product.isAiMembership || (kinds.length ? kinds.includes(kind)
            : url.searchParams.get('newcomer') !== 'true' || ['account', 'top_up'].includes(kind))))
          .map(([kind, id]) => {
            const offers = Array.from({ length: kind === emptyKind ? 0 : offersPerKind }, (_, index) => ({
              productId: 'p' + id + '-' + index, shopId: '1', shop: '会员店', name: '报价' + id + (index ? '-' + index : ''),
              membershipKind: kind === 'unclassified' ? null : kind, currency: 'CNY', price: '30', inStock: true, tags: [],
            }));
            return { kind, shopCount: offers.length ? 1 : 0, productCount: offers.length, offers };
          });
        const offers = groups.flatMap(group => group.offers);
        const page = Number(url.searchParams.get('detailPage') || 0);
        const pageSize = Number(url.searchParams.get('detailPageSize') || 12);
        const entries = url.searchParams.get('detailKind') === 'shops'
          ? offers.length ? [{ key: '1', name: '会员店', count: offers.length, offer: offers[0] }] : [] : offers;
        return { ...product, shopCount: offers.length ? 1 : 0, productCount: offers.length, offers: offers.slice(0, 4),
          ...(product.isAiMembership ? { membershipGroups: groups.map(group => ({ ...group, offers: group.offers.slice(0, 4) })) } : {}),
          ...(url.searchParams.has('detailKind') ? { detail: { kind: url.searchParams.get('detailKind'), entries: entries.slice(page * pageSize, (page + 1) * pageSize), total: entries.length, page, pageSize } } : {}) };
      });
    return Response.json({ items, total: items.length, offerTotal: items.reduce((sum, item) => sum + item.productCount, 0), platformFacets: ['openai', 'google'] });
  }));
  return requests;
}

test('membership categories without available offers are hidden while non-AI products remain', async () => {
  mockMembershipCatalog({ emptyKind: 'rental' });
  mount(undefined, 2400);
  await screen.findByRole('button', { name: 'YouTube Premium' });
  expect(screen.getByRole('button', { name: 'ChatGPT Plus · 成品号' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'ChatGPT Plus · 代充' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'ChatGPT Plus · 短期' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'ChatGPT Plus · 租号' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'YouTube Premium' })).toBeInTheDocument();
});

test.each([['short_term', '短期'], ['rental', '租号']])('default browse shows %s until newcomer is explicitly enabled', async (kind, label) => {
  localStorage.removeItem(storageKey);
  const requests = mockMembershipCatalog({ onlyKind: kind });
  mount();
  expect(await screen.findByRole('button', { name: 'ChatGPT Plus · ' + label })).toBeInTheDocument();
  expect(requests.filter(url => url.pathname === '/api/catalog').every(url => url.searchParams.get('newcomer') !== 'true')).toBe(true);
  fireEvent.click(screen.getByRole('switch', { name: '新手' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'ChatGPT Plus · ' + label })).not.toBeInTheDocument());
  expect(requests.filter(url => url.pathname === '/api/catalog').at(-1)?.searchParams.get('newcomer')).toBe('true');
});

test.each([['short_term', '短期', '短期', '10'], ['rental', '租号（共享）', '租号', '10']])('membership %s overrides newcomer, reaches previews and details, survives history and clears with filters', async (kind, choice, label, id) => {
  localStorage.removeItem(storageKey);
  const requests = mockMembershipCatalog();
  mount(undefined, 2400);
  await screen.findByRole('button', { name: 'YouTube Premium' });
  expect(await screen.findByRole('button', { name: 'ChatGPT Plus · 租号' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'ChatGPT Plus · 短期' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '筛选', exact: true }));
  const kinds = within(await screen.findByRole('group', { name: 'AI会员类型' }));
  expect(kinds.queryByRole('checkbox', { name: '未分类' })).not.toBeInTheDocument();
  fireEvent.click(kinds.getByRole('checkbox', { name: choice, exact: true }));
  await waitFor(() => expect(requests.some(url => url.searchParams.get('limit') === '1' && url.searchParams.get('membershipKind') === kind)).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: '应用筛选（1）' }));
  const selectedTitle = await screen.findByRole('button', { name: 'ChatGPT Plus · ' + label });
  fireEvent.click(selectedTitle);
  expect(within(selectedTitle.closest('article')).getByRole('link', { name: '更多报价：ChatGPT Plus · ' + label })).toHaveAttribute('href', `/products/${id}/features/${kind}`);
  expect(screen.getByRole('switch', { name: '新手' })).not.toBeChecked();
  const saved = window.location.search;
  expect(new URLSearchParams(saved).getAll('membershipKind')).toEqual([kind]);
  fireEvent.change(screen.getByRole('combobox', { name: '商品排序' }), { target: { value: 'price' } });
  fireEvent.click(screen.getByRole('button', { name: '筛选（1）' }));
  await waitFor(() => expect(requests.some(url => url.pathname.endsWith('/facets') && url.searchParams.get('membershipKind') === kind)).toBe(true));
  fireEvent.click(within(screen.getByRole('group', { name: 'AI会员类型' })).getByRole('checkbox', { name: '成品号', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: '应用筛选（2）' }));
  await waitFor(() => expect(new URLSearchParams(window.location.search).getAll('membershipKind')).toEqual(['account', kind]));
  window.history.replaceState({}, '', '/' + saved);
  fireEvent(window, new PopStateEvent('popstate'));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'ChatGPT Plus · 成品号' })).not.toBeInTheDocument());
  fireEvent.click(within(screen.getByLabelText('已选筛选条件')).getByRole('button', { name: '清除全部' }));
  await waitFor(() => expect(new URLSearchParams(window.location.search).has('membershipKind')).toBe(false));
});

test('choosing a standard keeps feature selection independent and names plain', async () => {
  localStorage.removeItem(storageKey);
  const requests = mockMembershipCatalog();
  mount();
  await screen.findByRole('button', { name: 'ChatGPT Plus · 成品号' });
  fireEvent.click(screen.getByRole('button', { name: '筛选', exact: true }));
  const selector = await screen.findByRole('combobox', { name: '标准商品' });
  expect(within(selector).getByRole('option', { name: 'ChatGPT Plus', exact: true })).toHaveValue('10');
  fireEvent.change(selector, { target: { value: '10' } });
  const choices = within(screen.getByRole('group', { name: 'AI会员类型' })).getAllByRole('checkbox');
  for (const choice of choices) expect(choice).not.toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: /应用筛选/ }));
  await waitFor(() => {
    const request = requests.filter(url => url.pathname === '/api/catalog' && url.searchParams.get('limit') === '20').at(-1);
    expect(request.searchParams.get('standardProductId')).toBe('10');
    expect(request.searchParams.getAll('membershipKind')).toEqual([]);
  });
});

test('rental URL restores filters and carries the class into offer details', async () => {
  localStorage.setItem(storageKey, 'newcomer');
  window.history.replaceState({}, '', '/?membershipKind=rental');
  const requests = mockMembershipCatalog();
  mount();
  const rentalTitle = await screen.findByRole('button', { name: 'ChatGPT Plus · 租号' });
  expect(screen.getByRole('switch', { name: '新手' })).not.toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: '筛选（1）' }));
  expect(within(await screen.findByRole('group', { name: 'AI会员类型' })).getByRole('checkbox', { name: '租号（共享）' })).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: '应用筛选（1）' }));
  const rental = rentalTitle.closest('article');
  fireEvent.click(within(rental).getByRole('button', { name: '1 条报价' }));
  await waitFor(() => {
    const request = requests.filter(url => url.searchParams.has('detailKind')).at(-1);
    expect(request?.searchParams.getAll('membershipKind')).toEqual(['rental']);
    expect(request.searchParams.get('newcomer')).toBe('false');
  });
});

test.each([
  ['membershipKind=rental', ''],
  ['q=ChatGPT+Plus+共享', 'chatgpt plus'],
  ['q=不要租号&searchMode=literal', '不要租号', []],
  ['q=不要租号（共享）', '不要租号（共享）', []],
  ['q=不要共享', '不要共享', []],
  ['q=没有共享', '没有共享', []],
  ['q=共享状态未知', '共享状态未知', []],
  ['q=未说明共享', '未说明共享', []],
  ['q=未明确租号', '未明确租号', []],
  ['q=ChatGPT+Plus+租号(合租)', 'chatgpt plus'],
  ['q=ChatGPT+Plus+租号（合租）', 'chatgpt plus'],
])('AI detail restores rental scope or preserves literal search: %s', async (query, keyword, kinds = ['rental']) => {
  window.history.replaceState({}, '', '/products/10?newcomer=true&' + query);
  const requests = mockMembershipCatalog();
  mount('10');
  await waitFor(() => {
    const request = requests.filter(url => url.searchParams.has('detailKind')).at(-1);
    expect(request?.searchParams.get('q')).toBe(keyword);
    expect(request.searchParams.getAll('membershipKind')).toEqual(kinds);
    expect(request.searchParams.getAll('tag')).toEqual([]);
    expect(request.searchParams.get('newcomer')).toBe(kinds.length ? 'false' : 'true');
  });
});

test('AI search type, explicit delivery and warranty constraints coexist without changing delivery semantics', async () => {
  const params = new URLSearchParams({ q: 'ChatGPT Plus 短期', warrantyDaysMin: '30', tag: JSON.stringify({ name: 'delivery', value: 'top_up' }) });
  window.history.replaceState({}, '', '/?' + params);
  const requests = mockMembershipCatalog();
  mount();
  await waitFor(() => {
    const request = requests.filter(url => url.pathname === '/api/catalog').at(-1);
    expect(request?.searchParams.getAll('membershipKind')).toEqual(['short_term']);
    expect(request.searchParams.getAll('tag').map(JSON.parse)).toEqual([{ name: 'delivery', value: 'top_up' }]);
    expect(request.searchParams.get('warrantyDaysMin')).toBe('30');
  });
});

test('AI detail filters persist and reset, and newcomer never broadens an empty result', async () => {
  localStorage.removeItem(storageKey);
  window.history.replaceState({}, '', '/products/10?newcomer=true');
  const requests = mockMembershipCatalog({ onlyKind: 'short_term' });
  mount('10');
  await screen.findByText('没有匹配的报价');
  expect(requests.filter(url => url.searchParams.has('detailKind')).every(url => url.searchParams.get('newcomer') === 'true')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '筛选', exact: true }));
  fireEvent.click(within(screen.getByRole('group', { name: 'AI会员类型' })).getByRole('checkbox', { name: '短期' }));
  fireEvent.click(screen.getByRole('button', { name: '应用筛选（1）' }));
  await screen.findByText(/^报价3/);
  expect(new URLSearchParams(window.location.search).getAll('membershipKind')).toEqual(['short_term']);
  fireEvent.change(screen.getByRole('combobox', { name: '报价排序' }), { target: { value: 'updated' } });
  expect(new URLSearchParams(window.location.search).getAll('membershipKind')).toEqual(['short_term']);
  fireEvent.click(screen.getByRole('button', { name: '重置', exact: true }));
  expect(new URLSearchParams(window.location.search).has('membershipKind')).toBe(false);
  fireEvent.click(screen.getByRole('switch', { name: '新手' }));
  await screen.findByText('没有匹配的报价');
});

test.each([
  ['ChatGPT Plus 代充', 'top_up', 'ChatGPT Plus'],
  ['ChatGPT Plus 成品号', 'account', 'ChatGPT Plus'],
  ['ChatGPT Plus 短期', 'short_term', 'ChatGPT Plus'],
  ['ChatGPT Plus 租号', 'rental', 'ChatGPT Plus'],
  ['ChatGPT Plus 租号（共享）', 'rental', 'ChatGPT Plus'],
  ['ChatGPT Plus 租号(共享)', 'rental', 'ChatGPT Plus'],
  ['ChatGPT Plus 租号(合租)', 'rental', 'ChatGPT Plus'],
  ['ChatGPT Plus 租号（合租）', 'rental', 'ChatGPT Plus'],
  ['ChatGPT Plus 共享', 'rental', 'ChatGPT Plus'],
  ['ChatGPT Plus 合租', 'rental', 'ChatGPT Plus'],
  ['ChatGPT Plus 不要租号', null, 'ChatGPT Plus 不要租号'],
  ['ChatGPT Plus 不共享', null, 'ChatGPT Plus 不共享'],
  ['ChatGPT Plus 非合租', null, 'ChatGPT Plus 非合租'],
  ['ChatGPT Plus 租号不支持', null, 'ChatGPT Plus 租号不支持'],
  ['YouTube 代充', null, 'YouTube 代充'],
  ['YouTube 共享', null, 'YouTube 共享'],
  ['YouTube 租号', null, 'YouTube 租号'],
  ['ChatGPT 接码 合租', null, 'ChatGPT 接码 合租'],
  ['ChatGPT 接码 代充', null, 'ChatGPT 接码 代充'],
  ['不要租号（共享）', null, '不要租号（共享）', '10'],
  ['不接受租号（共享）', null, '不接受租号（共享）', '10'],
  ['没有共享', null, '没有共享', '10'],
  ['共享状态未知', null, '共享状态未知', '10'],
  ['未说明共享', null, '未说明共享', '10'],
  ['未明确租号', null, '未明确租号', '10'],
  ['不合租', null, '不合租', '10'],
  ['共享不支持', null, '共享不支持', '10'],
  ['租号 不要共享', null, '租号 不要共享', '10'],
  ['租号（共享）', 'rental', '', '10'],
  ['租号', null, '租号', '4'],
])('interprets membership words only in confirmed AI scope: %s', async (q, kind, expectedQuery, standardProductId = '') => {
  const requests = mockMembershipCatalog();
  window.history.replaceState({}, '', '/?' + new URLSearchParams({ q, newcomer: 'true', standardProductId }));
  mount();
  await waitFor(() => {
    const request = requests.filter(url => url.pathname === '/api/catalog').at(-1);
    expect(request?.searchParams.get('q')).toBe(expectedQuery);
    expect(request.searchParams.getAll('membershipKind')).toEqual(kind ? [kind] : []);
  });
  if (kind) {
    expect(screen.getByRole('switch', { name: '新手' })).not.toBeChecked();
    expect(new URLSearchParams(window.location.search).get('q')).toBe(q);
    expect(screen.queryByRole('button', { name: '移除代充' })).not.toBeInTheDocument();
  }
  if (standardProductId === '10' && !kind) {
    expect(screen.queryByRole('button', { name: '移除共享' })).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: '新手' })).toBeChecked();
    expect(requests.filter(url => url.pathname === '/api/catalog').every(url => url.searchParams.get('newcomer') === 'true')).toBe(true);
  }
});

test('non-AI standard product selection clears membership restrictions and hides its type controls', async () => {
  const requests = mockMembershipCatalog();
  window.history.replaceState({}, '', '/?membershipKind=short_term');
  mount();
  await screen.findByRole('button', { name: 'ChatGPT Plus · 短期' });
  fireEvent.click(screen.getByRole('button', { name: '筛选（1）' }));
  fireEvent.change(await screen.findByRole('combobox', { name: '标准商品' }), { target: { value: '4' } });
  expect(screen.queryByRole('group', { name: 'AI会员类型' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '应用筛选（1）' }));
  await waitFor(() => {
    const request = requests.filter(url => url.pathname === '/api/catalog' && url.searchParams.get('limit') === '20').at(-1);
    expect(request.searchParams.get('standardProductId')).toBe('4');
    expect(request.searchParams.has('membershipKind')).toBe(false);
  });
});

test('standard details render all features and keep per-offer history on the same standard', async () => {
  const requests = mockMembershipCatalog();
  window.history.replaceState({}, '', '/products/10?newcomer=false');
  mount('10');
  for (const name of ['报价1', '报价2', '报价3', '报价6']) await screen.findByText(new RegExp('^' + name));
  const detailRequest = requests.find(url => url.searchParams.has('detailKind'));
  expect(detailRequest.searchParams.get('limit')).toBe('1');
  expect(requests.some(url => url.pathname === '/api/catalog/products/10/price-history')).toBe(true);
  for (const name of ['报价1', '报价2', '报价3', '报价6']) expect(screen.getByText(name, { selector: '.offer-name', exact: true })).toBeInTheDocument();
  const rental = within(screen.getByText(/^报价6/).closest('.shop-offer'));
  fireEvent.click(rental.getByRole('button', { name: /价格历史/ }));
  await waitFor(() => expect(requests.some(url => url.pathname === '/api/catalog/products/10/price-history'
    && url.searchParams.get('productId') === 'p6-0')).toBe(true));
});

test('detail feature filters keep the route, identity and purchase constraints', async () => {
  const requests = mockMembershipCatalog();
  window.history.replaceState({}, '', '/products/10?newcomer=true&warrantyDaysMin=30&priceMax=50');
  render(<VirtuosoMockContext.Provider value={{ viewportHeight: 900, itemHeight: 300 }}><App /></VirtuosoMockContext.Provider>);
  await screen.findByRole('heading', { name: 'ChatGPT Plus', level: 1 });
  await screen.findByText(/^报价1/);
  expect(screen.getByText(/^报价2/)).toBeInTheDocument();
  expect(screen.queryByText(/^报价3/)).not.toBeInTheDocument();
  expect(screen.queryByRole('navigation', { name: '会员类型' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '筛选（2）' }));
  fireEvent.click(within(screen.getByRole('group', { name: 'AI会员类型' })).getByRole('checkbox', { name: '短期' }));
  fireEvent.click(screen.getByRole('button', { name: '应用筛选（3）' }));
  await screen.findByText(/^报价3/);
  expect(screen.queryByText(/^报价1/)).not.toBeInTheDocument();
  expect(window.location.pathname).toBe('/products/10');
  expect(screen.getByRole('heading', { name: 'ChatGPT Plus', level: 1 })).toBeInTheDocument();
  const params = new URLSearchParams(window.location.search);
  expect(params.getAll('membershipKind')).toEqual(['short_term']);
  expect(params.get('newcomer')).toBe('false');
  expect(params.get('warrantyDaysMin')).toBe('30');
  expect(params.get('priceMax')).toBe('50');
  const histories = requests.filter(url => url.pathname.endsWith('/price-history'));
  expect(histories[0].searchParams.get('newcomer')).toBe('true');
  expect(histories[0].searchParams.getAll('membershipKind')).toEqual([]);
  await waitFor(() => {
    const history = requests.filter(url => url.pathname.endsWith('/price-history')).at(-1);
    expect(history.searchParams.getAll('membershipKind')).toEqual(['short_term']);
    expect(history.searchParams.get('newcomer')).toBe('false');
  });
  fireEvent.click(within(screen.getByText(/^报价3/).closest('.shop-offer')).getByRole('button', { name: /价格历史/ }));
  await waitFor(() => {
    const history = requests.find(url => url.pathname.endsWith('/price-history') && url.searchParams.get('productId') === 'p3-0');
    expect(history?.searchParams.getAll('membershipKind')).toEqual(['short_term']);
    expect(history.searchParams.get('newcomer')).toBe('false');
  });
});

test('standard detail pagination loads offers across all features until exhausted', async () => {
  const requests = mockMembershipCatalog({ offersPerKind: 13 });
  window.history.replaceState({}, '', '/products/10?newcomer=false');
  mount('10');
  for (let page = 1; page < 6; page++) {
    fireEvent.click(await screen.findByRole('button', { name: '加载更多报价' }));
    await waitFor(() => expect(requests.filter(url => url.searchParams.has('detailKind'))).toHaveLength(page + 1));
  }
  await screen.findByText('已显示全部 65 条报价');
  const pages = requests.filter(url => url.searchParams.has('detailKind'));
  expect(pages.map(url => url.searchParams.get('detailPage'))).toEqual(['0', '1', '2', '3', '4', '5']);
  expect(pages.every(url => url.searchParams.get('standardProductId') === '10' && url.searchParams.get('limit') === '1')).toBe(true);
});

test.each([['', ['报价1', '报价2', '报价3', '报价6', '报价7']], ['&membershipKind=short_term', ['报价3']],
  ['&membershipKind=unclassified', ['报价7']]])('shop details aggregate unique merchants and retain feature scope %s', async (query, names) => {
  const requests = mockMembershipCatalog();
  window.history.replaceState({}, '', '/products/10?newcomer=false&detailKind=shops' + query);
  mount('10');
  const row = await screen.findByRole('button', { name: /会员店/ });
  expect(screen.getByText('1 家商铺')).toBeInTheDocument();
  fireEvent.click(row);
  for (const name of names) await screen.findByText(new RegExp('^' + name));
  expect(requests.filter(url => url.searchParams.has('shopId')).at(-1).searchParams.getAll('membershipKind'))
    .toEqual(new URLSearchParams(query).getAll('membershipKind'));
  if (query) expect(screen.queryByText(/^报价1/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /返回商铺列表/ }));
  await screen.findByRole('button', { name: /会员店/ });
});
