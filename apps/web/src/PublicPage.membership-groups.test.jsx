import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { VirtuosoMockContext } from 'react-virtuoso';
import PublicPage from './PublicPage.jsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
    shopCount: 12,
    productCount: 30,
    offers: [{ ...accountOffers[0], membershipKind: null }],
    membershipGroups: [
      { kind: 'account', shopCount: 5, productCount: 11, minPrice: '0.50', maxPrice: '80', latestCapturedAt: '2026-11-10T10:00:00Z', offers: accountOffers },
      { kind: 'top_up', shopCount: 1, productCount: 2, minPrice: '12', maxPrice: '12.00', offers: [{ ...accountOffers[0], currency: 'USD', productId: 'top-up', membershipKind: 'top_up', name: '代充报价' }] },
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

  const link = await screen.findByRole('link', { name: 'ChatGPT Plus · 成品号' });
  expect(link).toHaveAttribute('href', '/products/standard-1/features/account');
  expect(link.closest('article')).toHaveTextContent('5 家商铺');
  expect(link.closest('article')).toHaveTextContent('11 条报价');
  expect(link.closest('article').querySelectorAll('.shop-offer')).toHaveLength(0);
  fireEvent.click(within(link.closest('article')).getByRole('button', { name: /^查看报价：/ }));
  expect(link.closest('article').querySelectorAll('.shop-offer')).toHaveLength(4);
  const topUp = screen.getByRole('link', { name: 'ChatGPT Plus · 代充' });
  expect(topUp).toHaveAttribute('href', '/products/standard-1/features/top_up');
  expect(topUp.closest('article').getAttribute('aria-labelledby')).not.toBe(link.closest('article').getAttribute('aria-labelledby'));
  expect(screen.queryByRole('link', { name: 'ChatGPT Plus', exact: true })).not.toBeInTheDocument();
  const summary = link.closest('article').querySelector('.standard-product-summary');
  expect(summary).toHaveTextContent('¥0.5 起');
  expect(summary).toHaveTextContent('¥0.5 – ¥80');
  expect(link.closest('article').querySelector('.product-counts time')).toHaveAttribute('dateTime', '2026-11-10T10:00:00Z');
  const topUpSummary = topUp.closest('article').querySelector('.standard-product-summary');
  expect(topUpSummary).toHaveTextContent('$12 起');
  expect(topUpSummary).not.toHaveTextContent('–');
  const shortTerm = screen.getByRole('link', { name: 'ChatGPT Plus · 短期' }).closest('article');
  fireEvent.click(within(shortTerm).getByRole('button', { name: /^查看报价：/ }));
  expect(shortTerm).toHaveTextContent('6 家商铺');
  expect(shortTerm).toHaveTextContent('17 条报价');
  expect(shortTerm.querySelectorAll('.shop-offer')).toHaveLength(1);
  expect(shortTerm.querySelector('.standard-product-summary')).toHaveTextContent('¥0.1 – ¥90');
  expect(screen.queryByRole('link', { name: 'ChatGPT Plus · 租号' })).not.toBeInTheDocument();
  const unclassified = screen.getByRole('link', { name: 'ChatGPT Plus · 未分类' });
  fireEvent.click(within(unclassified.closest('article')).getByRole('button', { name: /^查看报价：/ }));
  expect(unclassified).toHaveAttribute('href', '/products/standard-1/features/unclassified');
  expect(unclassified.closest('article').querySelectorAll('.shop-offer')).toHaveLength(1);
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
  fireEvent.click(within(link.closest('article')).getByRole('button', { name: '5 家商铺' }));
  await waitFor(() => {
    const request = requests.find(url => url.searchParams.get('detailKind') === 'shops');
    expect(request?.searchParams.get('standardProductId')).toBe('standard-1');
    expect(request.searchParams.getAll('membershipKind')).toEqual(['account']);
  });
});
