import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { VirtuosoMockContext } from 'react-virtuoso';
import PublicPage from './PublicPage.jsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test.each(['clear', 'switch', 'remove-chip'])('changing product scope via %s preserves top-up selection', async action => {
  window.history.replaceState({}, '', '/?standardProductId=17&membershipKind=top_up_half_price');
  const requests = [];
  const items = [
    { id: '17', name: 'ChatGPT Plus', platform: 'openai', identity: { family: 'openai', product: 'chatgpt', tier: 'plus' } },
    { id: '18', name: 'Grok Plus', platform: 'xai', identity: { family: 'xai', product: 'grok', tier: 'plus' } },
  ].map((product, index) => {
    const kind = index ? 'top_up' : 'top_up_half_price';
    const offer = { productId: `offer-${index}`, shopId: '1', shop: '商家', name: '报价', price: '20',
      currency: 'CNY', inStock: true, membershipKind: kind, tags: [] };
    return { ...product, isAiMembership: true, offers: [offer], shopCount: 1, productCount: 1,
      membershipGroups: [{ kind, offers: [offer], shopCount: 1, productCount: 1, minPrice: '20' }] };
  });
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = new URL(input, 'http://localhost');
    requests.push(url);
    if (url.pathname === '/api/analytics/collect') return new Response(null, { status: 204 });
    if (url.pathname.endsWith('/facets')) return Response.json({ tagFacets: [] });
    if (url.pathname.endsWith('/coverage')) return Response.json({ shopCount: 1, productCount: 2 });
    if (url.pathname === '/api/catalog/products') return Response.json({ items });
    if (url.pathname.startsWith('/api/catalog/products/')) return Response.json(items.find(item => url.pathname.endsWith('/' + item.id)));
    return Response.json({ items, total: 2, offerTotal: 2, platformFacets: ['openai', 'xai'] });
  }));
  render(<VirtuosoMockContext.Provider value={{ viewportHeight: 1600, itemHeight: 300 }}><PublicPage /></VirtuosoMockContext.Provider>);
  await screen.findByRole('button', { name: 'ChatGPT Plus · 代充 · 半价资格' });
  if (action === 'remove-chip') {
    fireEvent.click(screen.getByRole('button', { name: 'ChatGPT Plus ×' }));
    fireEvent.click(screen.getByRole('button', { name: /^筛选/ }));
  } else {
    fireEvent.click(screen.getByRole('button', { name: /^筛选/ }));
    const picker = await screen.findByRole('combobox', { name: '标准商品' });
    if (action === 'clear') fireEvent.click(within(picker.closest('fieldset')).getByRole('button', { name: '不限' }));
    else {
      fireEvent.change(picker, { target: { value: 'Grok' } });
      fireEvent.click(await screen.findByRole('option', { name: 'Grok Plus' }));
    }
  }
  expect(await screen.findByRole('checkbox', { name: '代充', exact: true })).toBeChecked();
  expect(screen.queryByRole('checkbox', { name: '代充 · 半价资格' })).not.toBeInTheDocument();
  if (action === 'clear') expect(screen.getByRole('button', { name: '应用筛选（1）' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /^应用筛选/ }));
  await waitFor(() => {
    const request = requests.filter(url => url.pathname === '/api/catalog').at(-1);
    expect(request.searchParams.get('standardProductId')).toBe(action === 'switch' ? '18' : null);
    expect(request.searchParams.getAll('membershipKind')).toEqual(action === 'switch' ? ['top_up'] : ['top_up', 'top_up_half_price']);
  });
  if (action === 'clear') {
    expect(screen.queryByRole('button', { name: 'AI会员：代充 · 半价资格 ×' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'AI会员：代充 ×' }));
    await waitFor(() => expect(requests.filter(url => url.pathname === '/api/catalog').at(-1)
      .searchParams.getAll('membershipKind')).toEqual([]));
  }
});

test.each([
  ['Renamed Plus', { family: 'openai', product: 'chatgpt', tier: 'plus' }, '代充 · 通用', true],
  ['ChatGPT Pro', { family: 'openai', product: 'chatgpt', tier: 'pro_5x' }, '代充', false],
  ['Grok Plus', { family: 'xai', product: 'grok', tier: 'plus' }, '代充', false],
])('%s labels and filter options follow canonical identity', async (name, identity, label, split) => {
  window.history.replaceState({}, '', '/?standardProductId=17');
  const offer = { productId: 'offer', shopId: '1', name: '代充报价', shop: '商家', price: '20',
    currency: 'CNY', inStock: true, membershipKind: 'top_up', tags: [] };
  const item = { id: '17', name, identity, platform: identity.family, isAiMembership: true,
    offers: [offer], shopCount: 1, productCount: 1,
    membershipGroups: [{ kind: 'top_up', offers: [offer], shopCount: 1, productCount: 1, minPrice: '20' }] };
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/analytics/collect') return new Response(null, { status: 204 });
    if (url.pathname.endsWith('/price-history')) return Response.json({ points: [] });
    if (url.pathname.endsWith('/facets')) return Response.json({ tagFacets: [] });
    if (url.pathname.endsWith('/coverage')) return Response.json({ shopCount: 1, productCount: 1 });
    if (url.pathname === '/api/catalog/products') return Response.json({ items: [item] });
    if (url.pathname === '/api/catalog/products/17') return Response.json(item);
    return Response.json({ items: [item], total: 1, offerTotal: 1, platformFacets: [identity.family] });
  }));
  render(<VirtuosoMockContext.Provider value={{ viewportHeight: 1600, itemHeight: 300 }}><PublicPage /></VirtuosoMockContext.Provider>);
  await screen.findByRole('button', { name: `${name} · ${label}` });
  fireEvent.click(screen.getByRole('button', { name: /^筛选/ }));
  await screen.findByRole('checkbox', { name: label, exact: true });
  expect(Boolean(screen.queryByRole('checkbox', { name: '代充 · 半价资格' }))).toBe(split);
  if (!split) expect(screen.queryByRole('checkbox', { name: '代充 · 通用' })).not.toBeInTheDocument();
});

test('renders nonempty membership groups as same-standard cards with four offers each', async () => {
  const requests = [];
  const accountOffers = Array.from({ length: 5 }, (_, index) => ({
    productId: `account-${index}`,
    shopId: String(index),
    shop: `账号店${index}`,
    name: `成品号报价${index}`,
    membershipKind: 'account',
    price: String(index + 1),
    currency: 'CNY',
    inStock: true,
  }));
  const item = {
    id: 'standard-1',
    name: 'ChatGPT Plus',
    platform: 'openai',
    isAiMembership: true,
    identity: { family: 'openai', product: 'chatgpt', tier: 'plus' },
    shopCount: 12,
    productCount: 30,
    offers: [{ ...accountOffers[0], membershipKind: null }],
    membershipGroups: [
      { kind: 'account', shopCount: 5, productCount: 11, minPrice: '0.50', maxPrice: '80', latestCapturedAt: '2026-11-10T10:00:00Z', offers: accountOffers },
      { kind: 'top_up', shopCount: 1, productCount: 2, minPrice: '12', maxPrice: '12.00', offers: [{ ...accountOffers[0], currency: 'USD', productId: 'top-up', membershipKind: 'top_up', name: '代充报价' }] },
      { kind: 'top_up_half_price', shopCount: 1, productCount: 1, minPrice: '6', maxPrice: '6', offers: [{ ...accountOffers[0], productId: 'half-price', membershipKind: 'top_up_half_price', name: '半价资格代充报价' }] },
      { kind: 'rental', shopCount: 0, productCount: 0, offers: [] },
      { kind: 'short_term', shopCount: 6, productCount: 17, minPrice: '0.10', maxPrice: '90', offers: [{ ...accountOffers[0], currency: undefined, productId: 'short', membershipKind: 'short_term' }] },
      { kind: 'unclassified', shopCount: 1, productCount: 1, minPrice: '2', maxPrice: '2', offers: [{ ...accountOffers[0], productId: 'unknown', membershipKind: null }] },
    ],
  };
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = new URL(input, 'http://localhost');
    requests.push(url);
    if (url.pathname === '/api/analytics/collect') return new Response(null, { status: 204 });
    if (url.pathname.endsWith('/price-history')) return Response.json({ points: [] });
    if (url.pathname === '/api/catalog/coverage') return Response.json({ shopCount: 1, productCount: 1 });
    if (url.pathname === '/api/catalog/products') return Response.json({ items: [item] });
    if (url.pathname.startsWith('/api/catalog/products/')) return Response.json(item);
    if (url.pathname.endsWith('/facets')) return Response.json({ tagFacets: [] });
    return Response.json({ items: [item], total: 1, offerTotal: 5, platformFacets: ['openai'] });
  }));

  render(<VirtuosoMockContext.Provider value={{ viewportHeight: 1600, itemHeight: 300 }}><PublicPage /></VirtuosoMockContext.Provider>);

  const link = await screen.findByRole('button', { name: 'ChatGPT Plus · 成品号' });
  const accountCard = link.closest('article');
  expect(link.closest('article')).toHaveTextContent('5 家商铺');
  expect(link.closest('article')).toHaveTextContent('11 条报价');
  expect(link.closest('article').querySelectorAll('.shop-offer')).toHaveLength(0);
  fireEvent.click(link);
  expect(within(accountCard).getByRole('link', { name: '更多报价：ChatGPT Plus · 成品号' })).toHaveAttribute('href', '/products/standard-1/features/account');
  expect(link.closest('article').querySelectorAll('.shop-offer')).toHaveLength(4);
  const topUp = screen.getByRole('button', { name: 'ChatGPT Plus · 代充 · 通用' });
  const halfPrice = screen.getByRole('button', { name: 'ChatGPT Plus · 代充 · 半价资格' });
  fireEvent.click(halfPrice);
  expect(within(halfPrice.closest('article')).getByRole('link', { name: '更多报价：ChatGPT Plus · 代充 · 半价资格' }))
    .toHaveAttribute('href', '/products/standard-1/features/top_up_half_price');
  expect(halfPrice.closest('article')).toHaveTextContent('商家保订阅');
  expect(topUp.closest('article').getAttribute('aria-labelledby')).not.toBe(link.closest('article').getAttribute('aria-labelledby'));
  expect(screen.queryByRole('button', { name: 'ChatGPT Plus', exact: true })).not.toBeInTheDocument();
  const summary = accountCard.querySelector('.standard-product-summary');
  expect(summary).toHaveTextContent('¥0.5 起');
  expect(summary).not.toHaveTextContent('–');
  expect(accountCard.querySelector('.product-counts time')).toHaveAttribute('dateTime', '2026-11-10T10:00:00Z');
  const topUpCard = topUp.closest('article');
  fireEvent.click(topUp);
  expect(within(topUpCard).getByRole('link', { name: '更多报价：ChatGPT Plus · 代充 · 通用' })).toHaveAttribute('href', '/products/standard-1/features/top_up');
  const topUpSummary = topUpCard.querySelector('.standard-product-summary');
  expect(topUpSummary).toHaveTextContent('$12 起');
  expect(topUpSummary).not.toHaveTextContent('–');
  const shortTerm = screen.getByRole('button', { name: 'ChatGPT Plus · 短期' }).closest('article');
  fireEvent.click(within(shortTerm).getByRole('button', { name: 'ChatGPT Plus · 短期' }));
  expect(shortTerm).toHaveTextContent('6 家商铺');
  expect(shortTerm).toHaveTextContent('17 条报价');
  expect(shortTerm.querySelectorAll('.shop-offer')).toHaveLength(1);
  expect(shortTerm.querySelector('.standard-product-summary')).toHaveTextContent('¥0.1 起');
  expect(shortTerm.querySelector('.standard-product-summary')).not.toHaveTextContent('–');
  expect(screen.queryByRole('button', { name: 'ChatGPT Plus · 租号' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'ChatGPT Plus · 未分类' })).not.toBeInTheDocument();
  fireEvent.click(within(topUp.closest('article')).getByRole('button', { name: '2 条报价' }));
  await waitFor(() => {
    const request = requests.find(url => url.searchParams.get('detailKind') === 'offers');
    expect(request?.searchParams.get('standardProductId')).toBe('standard-1');
    expect(request.searchParams.getAll('membershipKind')).toEqual(['top_up']);
    const history = requests.filter(url => url.pathname.endsWith('/price-history')).at(-1);
    expect(history?.searchParams.getAll('membershipKind')).toEqual(['top_up']);
    expect(history.searchParams.get('newcomer')).toBe('false');
  });
  fireEvent.click(screen.getByRole('button', { name: '关闭报价详情' }));
  fireEvent.click(within(accountCard).getByRole('button', { name: '5 家商铺' }));
  await waitFor(() => {
    const request = requests.find(url => url.searchParams.get('detailKind') === 'shops');
    expect(request?.searchParams.get('standardProductId')).toBe('standard-1');
    expect(request.searchParams.getAll('membershipKind')).toEqual(['account']);
  });
});
