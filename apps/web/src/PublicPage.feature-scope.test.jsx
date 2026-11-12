import React from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from './App.jsx';

// Drive pagination explicitly without depending on jsdom's missing layout.
vi.mock('react-virtuoso', () => ({ Virtuoso: ({ data, itemContent }) =>
  <>{data.map((item, index) => <React.Fragment key={index}>{itemContent(index, item)}</React.Fragment>)}</> }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const kinds = ['account', 'top_up', 'rental', 'short_term', 'unclassified'];
const labels = ['成品号', '代充', '租号', '短期', '未分类'];
const regions = ['us', 'ph', 'jp', 'hk', 'us'];
const regionLabels = ['美国', '菲律宾', '日本', '中国香港特别行政区', '美国'];
const identity = { id: '42', name: 'ChatGPT GO', platform: 'openai', isAiMembership: true };
const offers = kinds.flatMap((kind, group) => Array.from({ length: 13 + group }, (_, index) => ({
  productId: `${kind}-${index}`, membershipKind: kind === 'unclassified' ? null : kind,
  name: index === 1 ? `原商家${group} · ${labels[group]}` : `商家原名${group}-${index}`,
  shopId: `${kind}-${index < 12 ? 'main' : 'other'}`, shop: `${labels[group]}店${index < 12 ? '甲' : '乙'}`,
  price: String((group + 1) * 100 + index), currency: 'CNY', priceStatus: 'verified', inStock: true,
  tags: [{ name: 'region', value: regions[group] }],
})));
const featureOffers = kind => offers.filter(offer => (offer.membershipKind || 'unclassified') === kind);
const catalogItem = {
  ...identity, offers: offers.slice(0, 4), productCount: offers.length, shopCount: 8,
  membershipGroups: kinds.map(kind => {
    const values = featureOffers(kind);
    return { kind, offers: values.slice(0, 4), productCount: values.length, shopCount: 2,
      minPrice: values[0].price, maxPrice: values.at(-1).price };
  }),
};

function mockCatalog() {
  const requests = [];
  const control = { pause: null, failFacets: false };
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = new URL(input, 'http://localhost');
    requests.push(url);
    const selected = url.searchParams.getAll('membershipKind');
    const scoped = offers.filter(offer => !selected.length || selected.includes(offer.membershipKind || 'unclassified'));
    if (control.pause && (url.pathname.endsWith('/facets') || url.pathname.endsWith('/price-history') || url.searchParams.has('detailKind'))) {
      await control.pause;
    }
    if (url.pathname === '/api/catalog/products/42') return Response.json(catalogItem);
    if (url.pathname.endsWith('/price-history')) {
      const sku = url.searchParams.get('productId');
      const source = sku ? scoped.find(offer => offer.productId === sku) : scoped[0];
      return Response.json({ startDate: '2026-11-01', endDate: '2026-11-30', points: source ? [{
        ...source, date: '2026-11-10', price: String(Number(source.price) + (sku ? 0.5 : 0.25)),
        name: `历史-${source.name}`, quantity: 1, paymentMethod: '支付宝', verifiedAt: '2026-11-10T10:00:00Z',
      }] : [] });
    }
    if (url.pathname.endsWith('/facets')) return control.failFacets
      ? new Response(null, { status: 503 }) : Response.json({ tagFacets: scoped.flatMap(offer => offer.tags) });
    if (url.pathname === '/api/catalog') {
      if (!url.searchParams.has('detailKind')) return Response.json({ items: [catalogItem], total: 1 });
      const values = scoped.filter(offer => !url.searchParams.get('shopId') || offer.shopId === url.searchParams.get('shopId'));
      const shops = [...new Set(values.map(offer => offer.shopId))].map(key => {
        const group = values.filter(offer => offer.shopId === key);
        return { key, name: group[0].shop, count: group.length, offer: group[0] };
      });
      const entries = url.searchParams.get('detailKind') === 'shops' ? shops : values;
      const page = Number(url.searchParams.get('detailPage'));
      const size = Number(url.searchParams.get('detailPageSize'));
      return Response.json({ items: [{ ...identity, offers: values.slice(0, 4),
        detail: { total: entries.length, page, pageSize: size, entries: entries.slice(page * size, (page + 1) * size) } }] });
    }
    return Response.json({ items: [], enabled: false });
  }));
  return { requests, control };
}

function assertOnlyFeature(container, kind) {
  const names = [...container.querySelectorAll('.offer-name')].map(node => node.textContent);
  expect(names.length).toBeGreaterThan(4);
  const expected = featureOffers(kind);
  for (const name of names) expect(expected.map(offer => offer.name)).toContain(name);
  expect(names).toContain(expected[0].name);
  expect(names).toContain(expected[1].name); // Merchant-supplied feature words stay verbatim.
  for (const other of kinds.filter(value => value !== kind)) {
    expect(container).not.toHaveTextContent(featureOffers(other)[0].name);
  }
}

test.each(kinds.filter(kind => kind !== 'unclassified'))('%s cards, both dialogs and dedicated page show only that feature data', async kind => {
  const { requests } = mockCatalog();
  render(<App />);
  const group = kinds.indexOf(kind);
  const values = featureOffers(kind);
  const title = `ChatGPT GO · ${labels[group]}`;
  const link = await screen.findByRole('button', { name: `ChatGPT GO · ${labels[group]}` });
  const card = link.closest('article');
  fireEvent.click(link);
  expect(card.querySelectorAll('.shop-offer')).toHaveLength(4);
  expect(card.querySelector('.standard-product-summary')).toHaveTextContent(`¥${values[0].price} 起`);
  expect(card.querySelector('.standard-product-summary')).not.toHaveTextContent('–');
  fireEvent.click(within(card).getByRole('button', { name: `${values.length} 条报价` }));
  const dialog = await screen.findByRole('dialog', { name: `${title} · 报价` });
  const modal = within(dialog);
  await modal.findByText(values[0].name, { selector: '.offer-name' });
  assertOnlyFeature(dialog, kind);
  expect(dialog.querySelector('.dialog-header p')).toHaveTextContent(`${values.length} 条报价`);
  const history = modal.getByRole('region', { name: '商品价格历史' });
  await within(history).findByText(`¥${Number(values[0].price) + 0.25}`, { selector: 'strong' });
  expect(history).toHaveTextContent(`历史-${values[0].name}`);
  fireEvent.click(modal.getByRole('button', { name: '加载更多报价' }));
  await modal.findByText(values.at(-1).name, { selector: '.offer-name' });
  expect(dialog.querySelectorAll('.shop-offer')).toHaveLength(values.length);
  assertOnlyFeature(dialog, kind);
  fireEvent.click(modal.getByRole('button', { name: '筛选', exact: true }));
  const filters = modal.getByRole('region', { name: '筛选报价' });
  await within(filters).findByRole('checkbox', { name: `地区：${regionLabels[group]}` });
  for (const label of regionLabels.filter(value => value !== regionLabels[group])) {
    expect(within(filters).queryByRole('checkbox', { name: `地区：${label}` })).not.toBeInTheDocument();
  }
  fireEvent.click(modal.getByRole('button', { name: '应用筛选', exact: true }));
  const first = modal.getByText(values[0].name, { selector: '.offer-name' }).closest('.shop-offer');
  expect(within(first).getByLabelText(/^结算价/)).toHaveTextContent(`¥${values[0].price}`);
  fireEvent.click(within(first).getByRole('button', { name: /价格历史/ }));
  await within(first).findByText(`¥${Number(values[0].price) + 0.5}`, { selector: 'strong' });
  expect(requests.some(url => url.searchParams.get('productId') === values[0].productId
    && url.searchParams.get('membershipKind') === kind)).toBe(true);
  fireEvent.click(within(first).getByRole('button', { name: '商品说明' }));
  const description = await screen.findByRole('dialog', { name: values[0].name });
  expect(description).toHaveTextContent(regionLabels[group]);
  fireEvent.click(within(description).getByRole('button', { name: '关闭商品说明' }));
  fireEvent.click(modal.getByRole('button', { name: '关闭报价详情' }));

  fireEvent.click(within(card).getByRole('button', { name: '2 家商铺' }));
  const shopDialog = await screen.findByRole('dialog', { name: `${title} · 商铺` });
  const shop = await within(shopDialog).findByRole('button', { name: new RegExp(`${labels[group]}店甲.*12 条报价`) });
  expect(shop).toHaveTextContent(`¥${values[0].price}`);
  expect(shopDialog.querySelectorAll('.catalog-shop-entry')).toHaveLength(2);
  expect(shopDialog.querySelector('.dialog-header p')).toHaveTextContent('2 家商铺');
  fireEvent.click(shop);
  await within(shopDialog).findByText(values[0].name, { selector: '.offer-name' });
  assertOnlyFeature(shopDialog, kind);
  expect(shopDialog.querySelectorAll('.shop-offer')).toHaveLength(12);
  fireEvent.click(within(shopDialog).getByRole('button', { name: '重置' }));
  assertOnlyFeature(shopDialog, kind);
  fireEvent.click(within(shopDialog).getByRole('button', { name: '关闭报价详情' }));

  fireEvent.click(within(card).getByRole('link', { name: `更多报价：${title}` }));
  await screen.findByRole('heading', { name: title, level: 1 });
  await screen.findByText(values[0].name, { selector: '.offer-name' });
  assertOnlyFeature(document.querySelector('.product-page-details'), kind);
  await within(screen.getByRole('region', { name: '商品价格历史' })).findByText(`¥${Number(values[0].price) + 0.25}`, { selector: 'strong' });
  fireEvent.click(screen.getByRole('button', { name: '加载更多报价' }));
  await screen.findByText(`已显示全部 ${values.length} 条报价`);
  expect(document.querySelectorAll('.product-page-details .shop-offer')).toHaveLength(values.length);
  fireEvent.click(screen.getByRole('button', { name: '按商铺' }));
  await screen.findByRole('button', { name: new RegExp(`${labels[group]}店甲.*12 条报价`) });
  expect(document.querySelectorAll('.catalog-shop-entry')).toHaveLength(2);
});

test('changing feature clears old quotes, counts, history and facets during loading and facet failure', async () => {
  const { control } = mockCatalog();
  window.history.replaceState({}, '', '/products/42/features/account');
  render(<App />);
  await screen.findByText('商家原名0-0', { selector: '.offer-name' });
  await screen.findByText('¥100.25', { selector: 'strong' });
  fireEvent.click(screen.getByRole('button', { name: '筛选', exact: true }));
  await screen.findByRole('checkbox', { name: '地区：美国' });
  let resume;
  control.pause = new Promise(resolve => { resume = resolve; });
  control.failFacets = true;
  window.history.pushState({}, '', '/products/42/features/short_term');
  fireEvent(window, new PopStateEvent('popstate'));
  await screen.findByRole('heading', { name: 'ChatGPT GO · 短期', level: 1 });
  fireEvent.click(screen.getByRole('button', { name: '筛选', exact: true }));
  expect(screen.getByText('正在加载筛选条件…')).toBeInTheDocument();
  expect(screen.queryByText('商家原名0-0')).not.toBeInTheDocument();
  expect(screen.queryByText('¥100.25')).not.toBeInTheDocument();
  expect(screen.queryByRole('checkbox', { name: '地区：美国' })).not.toBeInTheDocument();
  expect(document.querySelector('.product-page-details .dialog-header p')).toHaveTextContent('… 条报价');
  await act(async () => { resume(); });
  await screen.findByText('筛选条件加载失败');
  const filters = screen.getByRole('region', { name: '筛选报价' });
  expect(within(filters).queryByRole('checkbox')).not.toBeInTheDocument();
  await screen.findByText('商家原名3-0', { selector: '.offer-name' });
  await screen.findByText('¥400.25', { selector: 'strong' });
  assertOnlyFeature(document.querySelector('.product-page-details'), 'short_term');
  control.failFacets = false;
  fireEvent.click(within(filters).getByRole('button', { name: '重试筛选' }));
  await within(filters).findByRole('checkbox', { name: '地区：中国香港特别行政区' });
  await waitFor(() => expect(within(filters).queryByText('筛选条件加载失败')).not.toBeInTheDocument());
  expect(within(filters).queryByRole('checkbox', { name: '地区：美国' })).not.toBeInTheDocument();
});
