import React from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SITE_NAME } from '@price-comparison/catalog/site-brand';
import App from './App.jsx';

const measurement = vi.hoisted(() => ({ automatic: true, callback: null }));
vi.mock('react-virtuoso', () => ({ Virtuoso: ({ data, itemContent, totalListHeightChanged }) => {
  React.useEffect(() => { measurement.callback = totalListHeightChanged; if (measurement.automatic) totalListHeightChanged?.(data.length * 500); }, [totalListHeightChanged, data.length]);
  return <>{data.map((item, index) => <React.Fragment key={item.key || item.id}>{itemContent(index, item)}</React.Fragment>)}</>;
} }));
const product = { id: '42', name: 'Codex 手机接码', platform: 'openai', kind: '手机接码' };
const quote = { productId: '9', shop: '示例店', name: '接码服务', spec: '月付 · 已接码 · 质保30天', price: '12.50', listedPrice: '9.00', currency: 'CNY',
  priceStatus: 'verified', priceVerifiedAt: new Date().toISOString(), priceExpiresAt: new Date(Date.now() + 3600000).toISOString(),
  inventoryExpiresAt: new Date(Date.now() + 3600000).toISOString(), paymentMethod: '支付宝', productUrl: 'https://example.com/buy', tags: [], capturedAt: new Date().toISOString() };
function mockApi({ status = 200, merged = false, expires = false, inventoryExpiresAt = quote.inventoryExpiresAt, priceStatus = quote.priceStatus, tags = [], settlementQuantity, paymentMethod = quote.paymentMethod, price = quote.price, listedPrice = quote.listedPrice, facets = [{ name: 'bulk_purchase', value: 'supported' }], products = [product, { id: '43', name: 'Claude Max 20x', platform: 'anthropic', kind: '账号与订阅' }] } = {}) {
  let reads = 0;
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = new URL(input, 'http://localhost'); calls.push(url);
    if (url.pathname === '/api/catalog/products') return Response.json({ items: products });
    if (url.pathname.endsWith('/price-history')) return Response.json({ currency: 'CNY', days: 30, points: [] });
    if (url.pathname.startsWith('/api/catalog/products/')) return Response.json(merged && url.pathname.endsWith('/41') ? { ...product, id: '41', mergedIntoId: '42' } : product, { status });
    if (url.pathname === '/api/catalog/facets') return Response.json({ tagFacets: facets });
    if (url.pathname === '/api/catalog') {
      reads++;
      if (url.searchParams.has('detailKind') && url.searchParams.get('standardProductId') !== product.id) return Response.json({ error: 'standardProductId required for detail' }, { status: 400 });
      const offer = expires ? { ...quote, inventoryExpiresAt, priceExpiresAt: new Date(Date.now() + (reads === 1 ? 200 : -1)).toISOString() } : { ...quote, inventoryExpiresAt, priceStatus, tags, settlementQuantity, price, listedPrice, paymentMethod };
      return Response.json({ nextExpiryAt: expires && reads === 1 ? offer.priceExpiresAt : offer.inventoryExpiresAt, total: 1, platformFacets: ['openai', 'anthropic'], items: [{ ...product, offers: [offer, { ...quote, inventoryExpiresAt, productId: '10', price: '18.00', listedPrice: '18.00', priceStatus: 'estimated', paymentMethod: '支付价（预估：售价）' }], minPrice: '12.50', productCount: 25, shopCount: 2,
        ...(url.searchParams.has('detailKind') ? { detail: { kind: url.searchParams.get('detailKind'), page: Number(url.searchParams.get('detailPage')),
          pageSize: Number(url.searchParams.get('detailPageSize')), entries: [offer], total: 25 } } : {}) }] });
    }
    return new Response(null, { status: 204 });
  }));
  return calls;
}
async function renderWithOffers() {
  const result = render(<App />);
  if (window.location.pathname === '/') {
    fireEvent.click(await screen.findByRole('button', { name: product.name }));
  }
  return result;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/'); });
beforeEach(() => { vi.stubGlobal('scrollTo', vi.fn()); measurement.automatic = true; measurement.callback = null; });

test('estimated payment prices visibly identify their assumption while remaining available for comparison', async () => {
  mockApi({priceStatus:'estimated',listedPrice:'12.50',paymentMethod:'支付价（预估：售价）'}); await renderWithOffers();
  expect((await screen.findAllByText('预估')).length).toBeGreaterThan(0);
  expect(screen.getAllByLabelText(/结算价.*预估.*售价/).length).toBeGreaterThan(0);
  expect(screen.getAllByText('¥12.5').length).toBeGreaterThan(0);
  fireEvent.click(screen.getAllByRole('checkbox', { name: /对比报价/ })[0]);
  fireEvent.click(screen.getAllByRole('button', { name: '对比（1）' })[0]);
  expect(within(screen.getByRole('dialog', { name: '报价对比' })).getByText('预估')).toBeInTheDocument();
});

test.each(['/', '/products/42'])('observed quotes with no expiry remain visible and comparable on %s', async path => {
  window.history.replaceState({}, '', path);
  mockApi({ inventoryExpiresAt: null }); await renderWithOffers();
  await screen.findAllByText('¥12.5');
  fireEvent.click(screen.getAllByRole('checkbox', { name: /对比报价/ })[0]);
  fireEvent.click(screen.getAllByRole('button', { name: '对比（1）' })[0]);
  const comparison = within(screen.getByRole('dialog', { name: '报价对比' }));
  expect(comparison.getByText('¥12.5')).toBeInTheDocument();
  expect(comparison.getByRole('link', { name: '去商家' })).toBeInTheDocument();
});

test.each(['/', '/products/42'])('elapsed quote and stock deadlines never remove listings or trigger SQL rereads on %s', async path => {
  window.history.replaceState({}, '', path);
  const calls = mockApi({ expires: true, inventoryExpiresAt: new Date(Date.now() + 200).toISOString() });
  await renderWithOffers(); await screen.findAllByText('¥12.5');
  fireEvent.click(screen.getAllByRole('checkbox', { name: /对比报价/ })[0]);
  fireEvent.click(screen.getAllByRole('button', { name: '对比（1）' })[0]);
  const before = calls.filter(url => url.pathname === '/api/catalog').length;
  await act(async () => new Promise(resolve => setTimeout(resolve, 250)));
  expect(screen.getAllByText('¥12.5').length).toBeGreaterThan(0);
  expect(within(screen.getByRole('dialog', { name: '报价对比' })).getByRole('link', { name: '去商家' })).toBeInTheDocument();
  expect(calls.filter(url => url.pathname === '/api/catalog')).toHaveLength(before);
});

test('keeps history off the homepage and offers both aggregate and individual history in product details', async () => {
  const calls = mockApi(); await renderWithOffers();
  await screen.findByRole('button', { name: product.name });
  expect(screen.queryByRole('region', { name: '商品价格历史' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /价格历史/ })).not.toBeInTheDocument();
  expect(calls.some(url => url.pathname.endsWith('/price-history'))).toBe(false);
  const title = screen.getByRole('button', { name: product.name });
  if (title.getAttribute('aria-expanded') !== 'true') fireEvent.click(title);
  fireEvent.click(within(title.closest('article')).getByRole('link', { name: `更多报价：${product.name}` }));
  const overall = await screen.findByRole('region', { name: '商品价格历史' });
  expect(await within(overall).findByText(/暂无已记录的结算价格/)).toBeInTheDocument();
  expect(screen.getByRole('region', { name: '商家报价价格历史' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /价格历史/ }));
  expect(await within(screen.getByRole('region', { name: '商家报价价格历史' })).findByText(/暂无已记录的结算价格/)).toBeInTheDocument();
});

test.each(['/', '/products/42'])('shows database minimum quantity once in cards and comparison on %s', async path => {
  window.history.replaceState({}, '', path);
  mockApi({ settlementQuantity: 5, price: '2.002', tags: [
    { name: 'minimum_quantity', value: '10' }, { name: 'minimum_quantity', value: '5' },
    { name: 'bulk_purchase', value: 'supported' },
  ] });
  await renderWithOffers();
  const facts = await screen.findByRole('group', { name: '商品标签' });
  expect(within(facts).getAllByText('5件起购')).toHaveLength(1);
  expect(facts).toHaveTextContent('支持批量购买');
  expect(screen.queryByText(/10件起购|1件起购|¥10\.01/)).not.toBeInTheDocument();
  const tile = facts.closest('.shop-tile');
  expect(within(tile).getByText('¥2', { exact: true })).toBeInTheDocument();
  fireEvent.click(within(tile).getByRole('checkbox', { name: /对比报价/ }));
  fireEvent.click(screen.getAllByRole('button', { name: '对比（1）' })[0]);
  const comparison = within(screen.getByRole('dialog', { name: '报价对比' }));
  expect(comparison.getAllByText('5件起购')).toHaveLength(1);
  expect(comparison.getByText('¥2', { exact: true })).toBeInTheDocument();
  expect(comparison.queryByText(/10件起购|1件起购|¥10\.01/)).not.toBeInTheDocument();
});

test.each([
  [5, '0.002', '¥0'],
  [3, '0.333333333333', '¥0.33'],
  [5, '0.000000000002', '¥0'],
  [5, '12.500000000000', '¥12.5'],
  [5, '2.006', '¥2.01'],
  [1, '12.50', '¥12.5'],
  [undefined, '12.50', '¥12.5'],
])('formats quantity %s unit price %s with at most two decimals and no trailing zeros in cards and comparison', async (settlementQuantity, price, expected) => {
  mockApi({ settlementQuantity, price, tags: [{ name: 'minimum_quantity', value: '10' }] });
  await renderWithOffers();
  await screen.findByRole('button', { name: product.name });
  const tile = screen.getAllByRole('link', { name: '去商家' })[0].closest('.shop-tile');
  expect(within(tile).getByText(expected, { exact: true })).toBeInTheDocument();
  expect(document.querySelector('.lowest-note')).toHaveTextContent(`${expected} 起`);
  expect(tile.querySelector('.offer-listed-price')).toHaveTextContent('标价 9');
  expect(screen.queryByText(/10件起购|1件起购/)).not.toBeInTheDocument();
  if (!(settlementQuantity > 1)) expect(within(tile).queryByRole('group', { name: '商品标签' })).not.toBeInTheDocument();
  fireEvent.click(within(tile).getByRole('checkbox', { name: /对比报价/ }));
  fireEvent.click(screen.getByRole('button', { name: '对比（1）' }));
  const comparison = within(screen.getByRole('dialog', { name: '报价对比' }));
  expect(comparison.getByText(expected, { exact: true })).toBeInTheDocument();
  expect(comparison.queryByText(/10件起购|1件起购/)).not.toBeInTheDocument();
  if (!(settlementQuantity > 1)) expect(comparison.queryByRole('rowheader', { name: '起购数量' })).not.toBeInTheDocument();
});

test.each([{ tags: [] }, { tags: [{ name: 'access', value: 'unknown' }] }])('reserves a non-focusable tag row when no offer facts are visible: $tags', async ({ tags }) => {
  mockApi({ tags });
  await renderWithOffers();
  await screen.findByRole('button', { name: product.name });
  const tile = screen.getAllByRole('link', { name: '去商家' })[0].closest('.shop-tile');
  const facts = tile.querySelector('.offer-facts');
  expect(facts).toBeInTheDocument();
  expect(facts).toBeEmptyDOMElement();
  expect(facts).toHaveAttribute('aria-hidden', 'true');
  expect(facts).not.toHaveAttribute('tabindex');
  expect(facts.previousElementSibling).toHaveClass('offer-name');
  expect(facts.nextElementSibling).toHaveClass('offer-footer');
  expect(within(tile).queryByRole('group', { name: '商品标签' })).not.toBeInTheDocument();
});

test('keeps visible offer facts accessible beside an empty tag row', async () => {
  mockApi({ tags: [{ name: 'bulk_purchase', value: 'supported' }] });
  await renderWithOffers();
  await screen.findByRole('button', { name: product.name });
  const facts = screen.getByRole('group', { name: '商品标签' });
  expect(facts).toHaveTextContent('支持批量购买');
  expect(facts).toHaveAttribute('tabindex', '0');
  expect(facts).not.toHaveAttribute('aria-hidden');
  expect(document.querySelectorAll('.offer-facts')).toHaveLength(2);
});

test('keeps inline filters below the sticky toolbar without scrolling an already visible panel', async () => {
  mockApi(); await renderWithOffers();
  await screen.findByRole('button', { name: product.name });
  const toolbar = screen.getByRole('region', { name: '搜索和筛选' }).closest('.catalog-sticky-header');
  const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
  const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
  const focus = vi.spyOn(HTMLElement.prototype, 'focus');
  const trigger = screen.getByRole('button', { name: '筛选', exact: true });
  for (const [panelTop, toolbarBottom, adjustment] of [[265, 265, 0], [-800, 136.5, -936.5], [60, 180, -120]]) {
    bounds.mockImplementation(function () { return this === toolbar ? { bottom: toolbarBottom } : { top: panelTop }; });
    scrollBy.mockClear();
    fireEvent.click(trigger);
    const panel = screen.getByRole('region', { name: '筛选报价' });
    expect(panel).toHaveFocus();
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
    if (adjustment) expect(scrollBy).toHaveBeenCalledExactlyOnceWith(0, adjustment);
    else expect(scrollBy).not.toHaveBeenCalled();
    await within(panel).findByRole('checkbox', { name: /支持批量购买/ });
    fireEvent.keyDown(window, { key: 'Escape' });
  }
});

test('keeps main search and delivery filters independent of the standard product selector', async () => {
  const calls = mockApi(); await renderWithOffers();
  await screen.findByRole('button', { name: product.name });
  fireEvent.change(screen.getByRole('textbox', { name: '搜索商品' }), { target: { value: 'Plus' } });
  await waitFor(() => expect(calls.some(url => url.pathname === '/api/catalog' && url.searchParams.get('q') === 'Plus')).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: '筛选', exact: true }));
  const panel = within(screen.getByRole('region', { name: '筛选报价' }));
  fireEvent.click(await panel.findByRole('checkbox', { name: /支持批量购买/ }));
  expect(panel.queryByRole('searchbox')).not.toBeInTheDocument();
  expect(panel.queryByRole('group', { name: '商品平台' })).not.toBeInTheDocument();
  expect(panel.queryByRole('radio')).not.toBeInTheDocument();
  expect(calls.filter(url => url.pathname === '/api/catalog/products')).toHaveLength(1);
  expect(panel.getByRole('combobox', { name: '标准商品' })).toHaveValue('');
  fireEvent.click(panel.getByRole('button', { name: '应用筛选（1）' }));
  await waitFor(() => expect(calls.some(url => url.pathname === '/api/catalog' && url.searchParams.get('limit') === '20'
    && url.searchParams.get('q') === 'Plus' && url.searchParams.getAll('tag').includes('{"name":"bulk_purchase","value":"supported"}'))).toBe(true));
  expect(new URLSearchParams(window.location.search).has('standardProductId')).toBe(false);
  fireEvent.click(within(screen.getByLabelText('已选筛选条件')).getByRole('button', { name: /支持批量购买/ }));
  expect(screen.queryByLabelText('已选筛选条件')).not.toBeInTheDocument();
});

test('keeps old product links in the selector and discards unapplied edits', async () => {
  window.history.replaceState({}, '', '/?platform=openai&standardProductId=42');
  const calls = mockApi(); await renderWithOffers();
  await screen.findByRole('button', { name: 'Codex 手机接码 ×' });
  fireEvent.click(screen.getByRole('button', { name: '筛选（1）' }));
  const panel = within(screen.getByRole('region', { name: '筛选报价' }));
  fireEvent.click(await panel.findByRole('checkbox', { name: /支持批量购买/ }));
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(new URLSearchParams(window.location.search).get('standardProductId')).toBe('42');
  fireEvent.click(screen.getByRole('button', { name: '筛选（1）' }));
  expect(screen.getByRole('checkbox', { name: /支持批量购买/ })).not.toBeChecked();
  expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  expect(calls.filter(url => url.pathname === '/api/catalog/products')).toHaveLength(1);
  expect(screen.getByRole('combobox', { name: '标准商品' })).toHaveValue('42');
  fireEvent.click(within(screen.getByRole('region', { name: '筛选报价' })).getByRole('button', { name: '清除全部' }));
  fireEvent.click(screen.getByRole('button', { name: '应用筛选', exact: true }));
  expect(new URLSearchParams(window.location.search).has('standardProductId')).toBe(false);
});

test.each(['search', 'platform'])('clears a legacy product restriction when changing %s', async mode => {
  window.history.replaceState({}, '', '/?standardProductId=42');
  const calls = mockApi(); await renderWithOffers();
  await screen.findByRole('button', { name: product.name });
  if (mode === 'search') fireEvent.change(screen.getByRole('textbox', { name: '搜索商品' }), { target: { value: 'Claude' } });
  else fireEvent.click(screen.getByRole('button', { name: 'Claude', exact: true }));
  await waitFor(() => expect(new URLSearchParams(window.location.search).has('standardProductId')).toBe(false));
  await waitFor(() => expect(calls.some(url => url.pathname === '/api/catalog' && !url.searchParams.has('standardProductId')
    && (mode === 'search' ? url.searchParams.get('q') === 'Claude' : url.searchParams.get('platform') === 'anthropic'))).toBe(true));
});

test.each(['delivery_format', '2fa', 'rental', 'access', 'delivery', 'payment_region', 'usage_restriction', 'minimum_quantity'])('retired %s never becomes a purchase badge', async name => {
  mockApi({ tags: [{ name, value: '有' }] }); await renderWithOffers(); await screen.findByRole('button', { name: product.name });
  expect(screen.queryByLabelText('商品标签')).not.toBeInTheDocument();
  fireEvent.click(screen.getAllByRole('button', { name: '商品说明', exact: true })[0]);
  expect(screen.getByRole('dialog', { name: quote.name })).toHaveTextContent(quote.spec);
});

test('all seven dimensions remain available with one combined usage group and complete warranty', async () => {
  const warranty = '购买后1小时内仅保首登，封号不保';
  mockApi({ tags: [{ name: 'sms_verification', value: 'verified' }, { name: 'region', value: 'us' }, { name: 'duration', value: 30 },
    { name: 'access_channel', value: 'web' }, { name: 'supported_client', value: 'codex' }, { name: 'subscription_override', value: '无' },
    { name: 'bulk_purchase', value: 'supported' }, { name: 'warranty', value: warranty }] });
  await renderWithOffers(); await screen.findByRole('button', { name: product.name });
  const facts = screen.getByLabelText('商品标签');
  expect([...facts.querySelectorAll('span')].map(tag => tag.textContent)).toEqual([warranty, '不可覆盖订阅']);
  fireEvent.click(within(facts).getByRole('button', { name: '查看全部商品条件，另有 6 项' }));
  const dialog = screen.getByRole('dialog', { name: quote.name });
  expect(dialog.querySelectorAll('.offer-tag-details-groups section')).toHaveLength(7);
  for (const text of [warranty, '已接码', '美区', '1个月', '网页', '支持Codex', '不可覆盖订阅', '支持批量购买']) expect(dialog).toHaveTextContent(text);
});

test.each(['personal', 'enterprise'])('shows duration in cards and comparison while keeping %s account types compact', async accountType => {
  mockApi({ tags: [
    { name: 'duration', value: 30 },
    { name: 'account_type', value: accountType },
  ] }); await renderWithOffers();
  await screen.findByRole('button', { name: product.name });
  expect(screen.getByLabelText('商品标签')).toHaveTextContent('1个月');
  fireEvent.click(screen.getAllByRole('checkbox', { name: /对比报价/ })[0]);
  fireEvent.click(screen.getByRole('button', { name: '对比（1）' }));
  const comparison = within(screen.getByRole('dialog', { name: '报价对比' }));
  const row = comparison.getByRole('rowheader', { name: '使用期限', exact: true }).closest('tr');
  expect(within(row).getByRole('cell')).toHaveTextContent('1个月');
});

test('detail badges distinguish use duration from a complete warranty promise', async () => {
  window.history.replaceState({}, '', '/products/42');
  mockApi({ tags: [{ name: 'duration', value: 30 }, { name: 'warranty', value: '购买后7天内保订阅，封号不保' }] });
  await renderWithOffers(); await screen.findByText('¥12.5');
  expect(screen.getByLabelText('商品标签')).toHaveTextContent('购买后7天内保订阅，封号不保1个月');
  fireEvent.click(screen.getByRole('button', { name: '商品说明', exact: true }));
  expect(screen.getByRole('dialog')).toHaveTextContent('1个月');
});

test.each(['/', '/products/42'])('shows both dedicated and shared access explicitly on %s', async path => {
  window.history.replaceState({}, '', path);
  mockApi({ tags: [{ name: 'sms_verification', value: 'verified' }] });
  const view = await renderWithOffers();
  await screen.findAllByText('¥12.5');
  expect(within(screen.getByLabelText('商品标签')).getByText('已接码')).toBeInTheDocument();
  view.unmount();
  mockApi({ tags: [{ name: 'sms_verification', value: 'unverified' }] });
  await renderWithOffers();
  await screen.findAllByText('¥12.5');
  expect(within(screen.getByLabelText('商品标签')).getByText('未接码')).toBeInTheDocument();
});

test.each([
  ['ph', '菲区'], ['us', '美区'], ['in', '印度'], ['tr', '土区'],
  ['eu', '欧洲'], ['global', '全球'], ['random', '随机地区'], ['sea', '东南亚'],
  ['美区', '美区'], ['unknown', null],
])('retains %s region in details while prioritizing warranty and access', async (region, label) => {
  mockApi({ tags: [
    { name: 'bulk_purchase', value: 'supported' }, { name: 'region', value: region },
    { name: 'region', value: region }, { name: 'duration', value: 30 },
    { name: 'sms_verification', value: 'verified' }, { name: 'warranty', value: '质保30天' },
  ] }); await renderWithOffers();
  await screen.findByRole('button', { name: product.name });
  expect([...screen.getByLabelText('商品标签').querySelectorAll('span')].map(tag => tag.textContent))
    .toEqual(['质保30天', '已接码']);
  expect(within(screen.getByLabelText('商品标签')).getByRole('button', { name: `查看全部商品条件，另有 ${label ? 3 : 2} 项` })).toHaveTextContent(`+${label ? 3 : 2}`);
  fireEvent.click(screen.getAllByRole('button', { name: '商品说明', exact: true })[0]);
  const details = screen.getByRole('dialog', { name: quote.name });
  if (label) expect(within(details).getAllByText(label, { exact: true })).toHaveLength(1);
  else expect(details).not.toHaveTextContent('unknown');
});

test('shows the same region in detail badges and quote comparison', async () => {
  window.history.replaceState({}, '', '/products/42');
  mockApi({ tags: [{ name: 'bulk_purchase', value: 'supported' }, { name: 'region', value: 'ph' }] });
  await renderWithOffers();
  await screen.findByText('¥12.5');
  expect(within(screen.getByLabelText('商品标签')).getByText('菲区')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('checkbox', { name: /对比报价/ }));
  fireEvent.click(screen.getAllByRole('button', { name: '对比（1）' })[0]);
  const comparison = within(screen.getByRole('dialog', { name: '报价对比' }));
  const row = comparison.getByRole('rowheader', { name: '地区', exact: true }).closest('tr');
  expect(within(row).getByRole('cell')).toHaveTextContent('菲区');
});

test.each([
  [[], null], [[{ name: 'warranty', value: 'unknown' }], null], [[{ name: 'warranty', value: 'none' }], null], [[{ name: 'warranty', value: 'covered' }], null],
  [[{ name: 'warranty', value: '购买后1小时内仅保首登' }], '购买后1小时内仅保首登'],
  [[{ name: 'warranty', value: '激活后24小时内仅保首次接码' }], '激活后24小时内仅保首次接码'],
  [[{ name: 'warranty', value: '保订阅30天，封号不保' }], '保订阅30天，封号不保'],
])('warranty %j stays complete in cards and comparison', async (tags, warranty) => {
  mockApi({ tags }); await renderWithOffers(); await screen.findByRole('button', { name: product.name });
  if (warranty) expect(screen.getByLabelText('商品标签')).toHaveTextContent(warranty);
  else expect(screen.queryByLabelText('商品标签')).not.toBeInTheDocument();
  fireEvent.click(screen.getAllByRole('checkbox', { name: /对比报价/ })[0]);
  fireEvent.click(screen.getAllByRole('checkbox', { name: /对比报价/ })[1]);
  fireEvent.click(screen.getByRole('button', { name: '对比（2）' }));
  const comparison = within(screen.getByRole('dialog', { name: '报价对比' }));
  if (warranty) expect(within(comparison.getByRole('rowheader', { name: '售后保障' }).closest('tr')).getAllByRole('cell').map(cell => cell.textContent)).toEqual([warranty, '—']);
  else expect(comparison.queryByRole('rowheader', { name: '售后保障' })).not.toBeInTheDocument();
});

test('retired rapid and warranty-scope facets never appear as selectable conditions', async () => {
  mockApi({ facets: [{ name: 'intended_use', value: 'rapid' }, { name: 'warranty_scope', value: 'first_login' }, { name: 'region', value: 'us' }] });
  await renderWithOffers(); fireEvent.click(screen.getByRole('button', { name: '筛选', exact: true }));
  expect(await screen.findByRole('checkbox', { name: '地区：美区' })).toBeInTheDocument();
  expect(screen.queryByRole('checkbox', { name: /速刷|首登/ })).not.toBeInTheDocument();
});

test('retired bookmark conditions are explicitly invalidated while comparison remains available', async () => {
  window.history.replaceState({}, '', '/?' + new URLSearchParams({ tag: '{"name":"intended_use","value":"rapid"}' }));
  const calls = mockApi(); await renderWithOffers(); await screen.findByRole('button', { name: product.name });
  expect(screen.getByRole('alert')).toHaveTextContent('旧筛选条件已失效');
  expect(calls.every(url => !url.searchParams.getAll('tag').length)).toBe(true);
  fireEvent.click(screen.getAllByRole('checkbox', { name: /对比报价/ })[0]); fireEvent.click(screen.getByRole('button', { name: '对比（1）' }));
  expect(screen.getByRole('dialog', { name: '报价对比' })).toHaveTextContent('¥12.5');
});

test('rapid words stay literal search text instead of producing retired intent chips', async () => {
  window.history.replaceState({}, '', '/?' + new URLSearchParams({ q: 'Claude 日抛 速刷' }));
  mockApi(); await renderWithOffers(); await screen.findByRole('button', { name: product.name });
  expect(screen.getByRole('textbox', { name: '搜索商品' })).toHaveValue('Claude 日抛 速刷');
  expect(screen.queryByLabelText('已识别购买条件')).not.toBeInTheDocument();
});

test.each(['购买后1小时内仅保首登', '激活后24小时内仅保首次接码', '保订阅30天，封号不保'])('detail filters submit complete warranty %s without derived days', async value => {
  window.history.replaceState({}, '', '/products/42');
  const calls = mockApi({ facets: [{ name: 'warranty', value }] }); await renderWithOffers(); await screen.findByText('¥12.5');
  fireEvent.click(screen.getByRole('button', { name: '筛选', exact: true }));
  fireEvent.click(await screen.findByRole('checkbox', { name: '售后保障：' + value }));
  expect(screen.queryByRole('group', { name: '最低质保天数' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /应用筛选/ }));
  await waitFor(() => expect(calls.some(url => url.searchParams.has('detailKind') && url.searchParams.getAll('tag').includes(JSON.stringify({ name: 'warranty', value })))).toBe(true));
  expect(calls.every(url => !url.searchParams.has('warrantyDaysMin'))).toBe(true);
});

test('homepage shows compact settlement and listed prices with verification time in a hint and one click merchant links', async () => {
  mockApi(); await renderWithOffers();
  const title = await screen.findByRole('button', { name: 'Codex 手机接码' });
  if (title.getAttribute('aria-expanded') !== 'true') fireEvent.click(title);
  expect(within(title.closest('article')).getByRole('link', { name: '更多报价：Codex 手机接码' })).toHaveAttribute('href', '/products/42?newcomer=false');
  expect(screen.getAllByText('¥12.5')).toHaveLength(2);
  expect(document.querySelector('.tile-price')).toHaveTextContent('¥12.5 / 标价 9');
  expect(document.querySelector('.lowest-note')).toHaveTextContent('¥12.5 起');
  expect(document.querySelector('.lowest-note')).not.toHaveTextContent('标价');
  expect(screen.getByLabelText(/结算价.*预估.*售价/).closest('.tile-price')).toHaveTextContent('¥18预估 / 标价 18');
  expect(document.querySelector('.tile-price.price-unavailable')).not.toBeInTheDocument();
  expect(screen.queryByText(/核验|核价于|支付宝/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Codex 手机接码' })).toHaveAttribute('aria-expanded', 'true');
  expect(screen.queryByText(quote.spec)).not.toBeInTheDocument();
  expect(screen.getAllByTitle(/支付宝.*核价于/)).toHaveLength(2);
  expect(screen.queryByText('¥0')).not.toBeInTheDocument();
  expect(screen.getAllByRole('link', { name: '去商家' })[0]).toHaveAttribute('href', 'https://example.com/buy');
});

test.each([
  ['15.10', '15.1'], ['15.00', '15'], ['15.05', '15.05'], ['15.126', '15.13'], ['0.00', '0'],
])('formats both prices %s with at most two decimals and no trailing zeros', async (price, expected) => {
  mockApi({ price, listedPrice: price }); await renderWithOffers();
  await screen.findByRole('button', { name: product.name });
  expect(document.querySelector('.tile-price')).toHaveTextContent(`¥${expected} / 标价 ${expected}`);
});

test.each([
  ['12.50', '12.5'], ['350.00', '350'], ['350.10', '350.1'], ['350.05', '350.05'],
  ['0', '0'], [null, '—'], ['', '—'], [' ', '—'], ['invalid', '—'], ['Infinity', '—'], ['-1', '—'],
])('compact listed price %j displays as %s without replacing settlement', async (listedPrice, expected) => {
  mockApi({ listedPrice }); await renderWithOffers();
  await screen.findByRole('button', { name: product.name });
  expect(document.querySelector('.tile-price')).toHaveTextContent(`¥12.5 / 标价 ${expected}`);
});

test('direct product page is nonmodal, defaults to CNY and loads batches with dedicated SEO', async () => {
  window.history.replaceState({}, '', '/products/42'); const calls = mockApi(); await renderWithOffers();
  expect(await screen.findByRole('heading', { level: 1, name: 'Codex 手机接码' })).toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await screen.findByText('¥12.5');
  const request = calls.find(url => url.searchParams.has('detailKind'));
  expect(request.searchParams.get('currency')).toBe('CNY');
  expect(screen.queryByRole('combobox', { name: '价格币种' })).not.toBeInTheDocument();
  expect(screen.queryByRole('option', { name: '全部币种' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '加载更多报价' }));
  await waitFor(() => expect(calls.some(url => url.searchParams.get('detailPage') === '1')).toBe(true));
  expect(document.title).toContain('Codex 手机接码价格比较');
  expect(document.querySelector('link[rel="canonical"]').href).toContain('/products/42');
  expect(new URLSearchParams(window.location.search).has('detailPage')).toBe(false);
});

test('product search keeps the query toolbar in view after debounced SEO intro pushes it down', async () => {
  window.history.replaceState({}, '', '/products/42');
  mockApi();
  const scrollTo = vi.fn();
  vi.stubGlobal('scrollTo', scrollTo);
  vi.spyOn(window, 'scrollY', 'get').mockReturnValue(500);
  await renderWithOffers();
  const input = await screen.findByRole('textbox', { name: '搜索商铺或报价' });
  vi.spyOn(input.closest('.detail-query-panel'), 'getBoundingClientRect').mockReturnValue({ top: 120 });
  fireEvent.change(input, { target: { value: '月付' } });
  await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(0, 620));
});

test.each(['/', '/products/42'])('keeps SEO answers, facts and FAQs visible after client rendering on %s', async path => {
  window.history.replaceState({}, '', path);
  mockApi();
  await renderWithOffers();
  await screen.findAllByText('¥12.5');
  const answer = document.querySelector('.seo-answer');
  expect(answer).toBeVisible();
  expect(document.querySelectorAll('.catalog-seo-intro')).toHaveLength(1);
  expect(document.querySelectorAll('.seo-answer')).toHaveLength(1);
  const panel = document.querySelector('.catalog-seo-panel');
  expect(panel).toContainElement(document.querySelector('.catalog-seo-intro'));
  expect(panel).toContainElement(document.querySelector('.seo-faq'));
  expect([...answer.textContent].length).toBeLessThanOrEqual(50);
  expect(document.querySelectorAll('main h1')).toHaveLength(1);
  const quotes = document.getElementById('catalog-quotes');
  if (path === '/') {
    expect(quotes.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(quotes.compareDocumentPosition(document.querySelector('main h1')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(answer.closest('.catalog-seo-intro')).toContainElement(document.querySelector('main h1'));
  } else {
    expect(document.querySelector('.detail-scroll').compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
  for (const fact of document.querySelectorAll('.seo-fact')) {
    expect(within(fact).getByRole('heading', { level: 2 })).toBeVisible();
    expect(fact.textContent).toMatch(/\d/u);
  }
  const faq = document.querySelector('.seo-faq');
  expect(faq).toBeVisible();
  expect(answer.compareDocumentPosition(faq) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  for (const answer of faq.querySelectorAll('p')) expect([...answer.textContent].length).toBeLessThanOrEqual(80);
  expect(within(faq).getByRole('heading', { name: SITE_NAME + '是否销售账号或提供交易担保？' })).toBeVisible();
  expect(document.querySelector('main')).not.toHaveTextContent(/PriceAI|OpenPrice|AICheap|AIDeal/);
});

test('refresh keeps product page filters and starts continuous loading from the first batch', async () => {
  const params = new URLSearchParams({ detailPage: '1', detailPageSize: '12', currency: 'USD', offerSort: 'updated', shopQuery: '示例' });
  window.history.replaceState({}, '', '/products/42?' + params); const calls = mockApi(); await renderWithOffers();
  await screen.findByText('¥12.5');
  const request = calls.find(url => url.searchParams.has('detailKind'));
  expect(request.searchParams.get('detailPage')).toBe('0');
  expect(request.searchParams.get('currency')).toBe('CNY');
  expect(new URLSearchParams(window.location.search).get('currency')).toBe('CNY');
  expect(request.searchParams.has('shopQuery')).toBe(false);
  expect(request.searchParams.get('q')).toBe('示例');
  expect(screen.getByRole('textbox', { name: '搜索商铺或报价' })).toHaveValue('示例');
  expect(screen.getByRole('combobox', { name: '报价排序' })).toHaveValue('updated');
});

test('product 404 and service failure remain distinct and retry is available', async () => {
  window.history.replaceState({}, '', '/products/42'); mockApi({ status: 404 }); const view = await renderWithOffers();
  expect(await screen.findByRole('heading', { name: '商品不存在或已下架' })).toBeInTheDocument();
  expect(document.querySelector('meta[name="robots"]').content).toContain('noindex');
  view.unmount(); mockApi({ status: 503 }); await renderWithOffers();
  expect(await screen.findByRole('heading', { name: '商品暂时无法加载' })).toBeInTheDocument();
  mockApi(); fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByRole('heading', { level: 1, name: 'Codex 手机接码' })).toBeInTheDocument();
});

test('merged product replaces URL and a list return restores filters and scroll position', async () => {
  window.history.replaceState({}, '', '/products/41'); mockApi({ merged: true }); const view = await renderWithOffers();
  await screen.findByRole('heading', { level: 1, name: product.name });
  expect(window.location.pathname).toBe('/products/42'); view.unmount();
  window.history.replaceState({}, '', '/?platform=openai&sort=price'); mockApi();
  const scrollTo = vi.fn(); vi.stubGlobal('scrollTo', scrollTo); Object.defineProperty(window, 'scrollY', { configurable: true, value: 420 });
  await renderWithOffers();
  const title = await screen.findByRole('button', { name: product.name });
  if (title.getAttribute('aria-expanded') !== 'true') fireEvent.click(title);
  fireEvent.click(within(title.closest('article')).getByRole('link', { name: `更多报价：${product.name}` }));
  await screen.findByRole('heading', { level: 1, name: product.name });
  fireEvent.click(screen.getByRole('link', { name: '返回商品列表' }));
  await waitFor(() => expect(window.location.pathname).toBe('/'));
  expect(new URLSearchParams(window.location.search).get('platform')).toBe('openai');
  expect(new URLSearchParams(window.location.search).get('sort')).toBe('price');
  await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(0, 420));
});

test('restores list scroll only after the virtual rows have measurable height', async () => {
  measurement.automatic = false;
  window.history.replaceState({}, '', '/products/42');
  const scrollTo = vi.fn(); vi.stubGlobal('scrollTo', scrollTo); mockApi(); await renderWithOffers();
  await screen.findByRole('heading', { level: 1, name: product.name });
  scrollTo.mockClear();
  act(() => {
    window.history.replaceState({ catalogScroll: 250 }, '', '/?platform=openai&standardProductId=42');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await screen.findByRole('button', { name: product.name });
  expect(scrollTo).not.toHaveBeenCalled();
  await act(async () => measurement.callback(0));
  expect(scrollTo).not.toHaveBeenCalled();
  await act(async () => measurement.callback(1500));
  await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(0, 250));
});

test('a fresh catalog load ignores an old saved position without reapplying it on refresh', async () => {
  window.history.replaceState({ catalogScroll: 900, catalogNewcomer: false }, '', '/');
  const scrollTo = vi.fn(); vi.stubGlobal('scrollTo', scrollTo);
  mockApi(); await renderWithOffers();
  await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(0, 0));
  expect(scrollTo).not.toHaveBeenCalledWith(0, 900);
  expect(window.history.state).toMatchObject({ catalogNewcomer: false });
  scrollTo.mockClear();
  fireEvent.click(screen.getByRole('button', { name: '刷新价格' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '刷新价格' })).toHaveAttribute('aria-busy', 'false'));
  expect(scrollTo).not.toHaveBeenCalled();
});

test('product pages keep official prices accessible from the product header', async () => {
  window.history.replaceState({}, '', '/products/42');
  mockApi(); await renderWithOffers();
  await screen.findByRole('heading', { level: 1, name: product.name });
  expect(screen.getByRole('button', { name: '官网正价参考' }).closest('header')).toHaveClass('product-page-heading');
});

test('out-of-range product pages keep the official price entry', async () => {
  window.history.replaceState({}, '', '/products/42?page=4');
  mockApi(); await renderWithOffers();
  await screen.findByRole('heading', { name: '商品分页不存在' });
  expect(screen.getByRole('button', { name: '官网正价参考' })).toBeInTheDocument();
});

test('an open official price panel survives product loading', async () => {
  window.history.replaceState({}, '', '/products/42');
  mockApi();
  const original = fetch;
  let resolveProduct;
  vi.stubGlobal('fetch', vi.fn((url, options) => {
    if (url === '/api/catalog/products/42') return new Promise(resolve => { resolveProduct = resolve; });
    if (url === '/api/official-reference/catalog') return Promise.resolve(Response.json({ apps: [] }));
    return original(url, options);
  }));
  await renderWithOffers();
  fireEvent.click(screen.getByRole('button', { name: '官网正价参考' }));
  await screen.findByRole('dialog', { name: '官网正价参考' });
  await act(async () => resolveProduct(Response.json(product)));
  await screen.findByRole('heading', { level: 1, name: product.name });
  expect(screen.getByRole('dialog', { name: '官网正价参考' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '关闭官网正价参考' }));
  expect(screen.getByRole('button', { name: '官网正价参考' })).toHaveFocus();
});

test('visibility restoration refreshes observed quotes without changing their price status', async () => {
  const calls = mockApi({ expires: true }); await renderWithOffers();
  await screen.findAllByText('¥12.5');
  await screen.findAllByText('预估');
  await waitFor(() => expect(document.querySelector('.tile-price.best')).toHaveTextContent('¥12.5'));
  expect(document.querySelector('.lowest-note')).toHaveTextContent('¥12.5');
  expect(screen.queryByText('¥0')).not.toBeInTheDocument();
  const before = calls.filter(url => url.pathname === '/api/catalog').length;
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  await waitFor(() => expect(calls.filter(url => url.pathname === '/api/catalog').length).toBeGreaterThan(before));
});

test('a failed visibility refresh preserves the last observed minimum', async () => {
  const api = mockApi({ expires: true });
  const fetchMock = globalThis.fetch;
  let release;
  vi.stubGlobal('fetch', vi.fn(async input => {
    if (new URL(input, 'http://localhost').pathname === '/api/catalog' && api.some(url => url.pathname === '/api/catalog')) {
      return new Promise(resolve => { release = resolve; });
    }
    return fetchMock(input);
  }));
  await renderWithOffers(); await screen.findAllByText('¥12.5');
  await screen.findAllByText('预估');
  await waitFor(() => expect(document.querySelector('.tile-price.best')).toHaveTextContent('¥12.5'));
  expect(document.querySelector('.lowest-note')).toHaveTextContent('¥12.5');
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  await waitFor(() => expect(release).toBeTypeOf('function'));
  await act(async () => release(Response.json({}, { status: 503 })));
  expect(await screen.findByRole('alert')).toHaveTextContent('商品加载失败');
  expect(document.querySelector('.tile-price.best')).toHaveTextContent('¥12.5');
});

test.each(['/', '/products/42'])('opens SKU details without requests and keeps nested report and comparison layers on %s', async path => {
  window.history.replaceState({}, '', path);
  const calls = mockApi({ tags: [{ name: 'bulk_purchase', value: 'supported' }, { name: 'sms_verification', value: 'unverified' }, { name: 'duration', value: 30 }, { name: 'warranty', value: '禁止改密，保订阅30天' }] });
  await renderWithOffers(); await screen.findAllByText('¥12.5');
  expect(screen.queryByRole('button', { name: '举报此报价' })).not.toBeInTheDocument();
  const trigger = screen.getAllByRole('button', { name: '商品说明', exact: true })[0]; trigger.focus();
  const before = calls.length; fireEvent.click(trigger);
  let details = screen.getByRole('dialog', { name: quote.name });
  expect(details).toHaveTextContent(quote.spec);
  expect(details).toHaveTextContent('禁止改密'); expect(details).toHaveTextContent('1个月');
  expect(calls).toHaveLength(before);
  fireEvent.click(within(details).getByRole('button', { name: '举报此报价' }));
  const report = screen.getByRole('dialog', { name: '举报此报价' });
  fireEvent.keyDown(report, { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: '举报此报价' })).not.toBeInTheDocument();
  expect(details).toBeInTheDocument();
  fireEvent.keyDown(details, { key: 'Escape' }); expect(trigger).toHaveFocus();
  fireEvent.click(screen.getAllByRole('checkbox', { name: /对比报价/ })[0]);
  fireEvent.click(screen.getAllByRole('button', { name: '对比（1）' })[0]);
  const comparison = screen.getByRole('dialog', { name: '报价对比' });
  fireEvent.click(within(comparison).getByRole('button', { name: '商品说明', exact: true }));
  details = screen.getByRole('dialog', { name: quote.name });
  expect(details).toHaveTextContent(quote.spec);
  fireEvent.keyDown(details, { key: 'Escape' }); expect(comparison).toBeInTheDocument();
});

test('aggregate details reuse the selected SKU and closing its explanation preserves the parent dialog', async () => {
  mockApi({ tags: [{ name: 'warranty', value: '禁止改密，保订阅30天' }] }); await renderWithOffers();
  fireEvent.click(await screen.findByRole('button', { name: '25 条报价' }));
  const parent = await screen.findByRole('dialog', { name: /报价/ });
  const trigger = (await within(parent).findAllByRole('button', { name: '商品说明', exact: true }))[0]; trigger.focus(); fireEvent.click(trigger);
  const details = screen.getByRole('dialog', { name: quote.name });
  expect(details).toHaveTextContent('禁止改密'); expect(details).toHaveTextContent(quote.spec);
  fireEvent.keyDown(details, { key: 'Escape' });
  expect(parent).toBeInTheDocument(); expect(trigger).toHaveFocus();
});

test('switching merchant products never carries conditions from the previous SKU', async () => {
  mockApi({ tags: [{ name: 'warranty', value: '禁止改密，保订阅30天' }] }); await renderWithOffers();
  await screen.findByRole('button', { name: product.name });
  const triggers = screen.getAllByRole('button', { name: '商品说明', exact: true });
  fireEvent.click(triggers[0]); expect(screen.getByRole('dialog', { name: quote.name })).toHaveTextContent('禁止改密');
  fireEvent.click(screen.getByRole('button', { name: '关闭商品说明' })); fireEvent.click(triggers[1]);
  expect(screen.getByRole('dialog', { name: quote.name })).not.toHaveTextContent('禁止改密');
});

test.each(['/', '/products/42'])('prioritizes complete warranty and actual minimum purchase on %s', async path => {
  window.history.replaceState({}, '', path);
  mockApi({ settlementQuantity: 5, tags: [{ name: 'warranty', value: '禁止改密，保订阅30天，封号不保' }, { name: 'bulk_purchase', value: 'required' }, { name: 'sms_verification', value: 'unverified' }] });
  await renderWithOffers(); await screen.findAllByText('¥12.5');
  const facts = screen.getByLabelText('商品标签');
  expect([...facts.querySelectorAll('span')].map(element => element.textContent)).toEqual(['禁止改密，保订阅30天，封号不保', '5件起购']);
  fireEvent.click(within(facts).getByRole('button', { name: '查看全部商品条件，另有 2 项' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('需批量购买');
});

test.each(['none', 'unknown', 'covered'])('obsolete warranty %s does not create unknown or negative badges', async value => {
  mockApi({ tags: [{ name: 'sms_verification', value: 'verified' }, { name: 'warranty', value }] });
  await renderWithOffers(); await screen.findByRole('button', { name: product.name });
  expect(screen.getByLabelText('商品标签')).toHaveTextContent(/^已接码$/);
});

test.each([false, true])('summary priorities do not depend on incoming tag order: %s', async reversed => {
  const tags = [{ name: 'region', value: 'us' }, { name: 'access_channel', value: 'web' }, { name: 'duration', value: 30 }, { name: 'subscription_override', value: '无' }];
  mockApi({ tags: reversed ? tags.reverse() : tags }); await renderWithOffers(); await screen.findByRole('button', { name: product.name });
  expect([...screen.getByLabelText('商品标签').querySelectorAll('span')].map(element => element.textContent)).toEqual(['不可覆盖订阅', '美区']);
});

test('identical display values in different fields retain their identities and overflow count', async () => {
  mockApi({ tags: [{ name: 'access_channel', value: 'web' }, { name: 'supported_client', value: 'web' }, { name: 'region', value: 'us' }, { name: 'region', value: 'us' }] });
  await renderWithOffers(); await screen.findByRole('button', { name: product.name });
  fireEvent.click(within(screen.getByLabelText('商品标签')).getByRole('button', { name: '查看全部商品条件，另有 1 项' }));
  const details = screen.getByRole('dialog');
  expect(details.querySelector('[data-field="access_channel"]')).toHaveTextContent('网页');
  expect(details.querySelector('[data-field="supported_client"]')).toHaveTextContent('支持web');
});

test.each([[365, '1年'], [360, '12个月'], [0.5, '12小时']])('numeric duration %s is consistent in cards and details', async (value, label) => {
  mockApi({ tags: [{ name: 'duration', value }] }); await renderWithOffers(); await screen.findByRole('button', { name: product.name });
  expect(screen.getByLabelText('商品标签')).toHaveTextContent(label);
  fireEvent.click(screen.getAllByRole('button', { name: '商品说明', exact: true })[0]);
  expect(screen.getByRole('dialog')).toHaveTextContent(label);
});

test('cards and dialogs share access and tool labels without inferring exclusive support', async () => {
  mockApi({ tags: [{ name: 'access_channel', value: 'web' }, { name: 'supported_client', value: 'codex' }, { name: 'supported_client', value: 'sub2api' }] });
  await renderWithOffers(); await screen.findByRole('button', { name: product.name });
  expect(screen.getByLabelText('商品标签')).toHaveTextContent('网页支持Codex');
  fireEvent.click(within(screen.getByLabelText('商品标签')).getByRole('button', { name: '查看全部商品条件，另有 1 项' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('支持Sub2API');
  expect(screen.getByRole('dialog')).not.toHaveTextContent('仅支持');
});

test('duration qualifiers remain visible with current product regions', async () => {
  mockApi({ tags: [{ name: 'region', value: 'us' }, { name: 'duration', value: { kind: 'approx', days: 90 } }] });
  await renderWithOffers(); await screen.findByRole('button', { name: product.name });
  fireEvent.click(screen.getAllByRole('button', { name: '商品说明', exact: true })[0]);
  const dialog = screen.getByRole('dialog'); expect(dialog).toHaveTextContent('美区'); expect(dialog).toHaveTextContent('约3个月');
});

test('summarizes additional tags with only their count', async () => {
  mockApi({ tags: [
    { name: 'bulk_purchase', value: 'required' }, { name: 'access_channel', value: 'web' },
    { name: 'sms_verification', value: 'verified' }, { name: 'duration', value: 30 },
  ] });
  await renderWithOffers(); await screen.findByRole('button', { name: product.name });
  const facts = screen.getByLabelText('商品标签');
  const more = within(facts).getByRole('button', { name: '查看全部商品条件，另有 2 项' });
  expect(more).toHaveTextContent('+2');
  expect(facts).not.toHaveTextContent(/条件，请查看商品说明/);
  fireEvent.click(more);
  const details = screen.getByRole('dialog', { name: quote.name });
  expect(details).toHaveTextContent('网页');
  expect(details).toHaveTextContent('1个月');
});

test.each(['/', '/products/42'])('resizing switches the one/two-condition budget and keeps the overflow count accurate on %s', async path => {
  window.history.replaceState({}, '', path);
  const listeners = new Set();
  const media = { matches: false, addEventListener: vi.fn((_event, listener) => listeners.add(listener)), removeEventListener: vi.fn((_event, listener) => listeners.delete(listener)) };
  vi.stubGlobal('matchMedia', vi.fn(() => media));
  mockApi({ tags: [
    { name: 'warranty', value: '禁止改密，保订阅30天' }, { name: 'subscription_override', value: '无' },
    { name: 'sms_verification', value: 'unverified' }, { name: 'bulk_purchase', value: 'supported' },
  ] });
  await renderWithOffers();
  const facts = await screen.findByRole('group', { name: '商品标签' });
  expect([...facts.querySelectorAll('span')].map(tag => tag.textContent)).toEqual(['禁止改密，保订阅30天']);
  fireEvent.click(within(facts).getByRole('button', { name: '查看全部商品条件，另有 3 项' }));
  const details = screen.getByRole('dialog', { name: quote.name });
  for (const text of ['禁止改密，保订阅30天', '不可覆盖订阅', '未接码', '支持批量购买']) expect(details).toHaveTextContent(text);
  fireEvent.click(within(details).getByRole('button', { name: '关闭商品说明' }));
  await act(async () => { media.matches = true; listeners.forEach(listener => listener({ matches: true })); });
  expect([...facts.querySelectorAll('span')].map(tag => tag.textContent)).toEqual(['禁止改密，保订阅30天', '不可覆盖订阅']);
  expect(within(facts).getByRole('button', { name: '查看全部商品条件，另有 2 项' })).toHaveTextContent('+2');
});
