import React from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from './App.jsx';

const measurement = vi.hoisted(() => ({ automatic: true, callback: null }));
vi.mock('react-virtuoso', () => ({ Virtuoso: ({ data, itemContent, totalListHeightChanged }) => {
  React.useEffect(() => { measurement.callback = totalListHeightChanged; if (measurement.automatic) totalListHeightChanged?.(data.length * 500); }, [totalListHeightChanged, data.length]);
  return <>{data.map((item, index) => <React.Fragment key={item.id}>{itemContent(index, item)}</React.Fragment>)}</>;
} }));
const product = { id: '42', name: 'Codex 手机接码', platform: 'openai', kind: '手机接码' };
const quote = { productId: '9', shop: '示例店', name: '接码服务', spec: '月付 · 独享 · 质保30天', price: '12.50', listedPrice: '9.00', currency: 'CNY',
  priceStatus: 'verified', priceVerifiedAt: new Date().toISOString(), priceExpiresAt: new Date(Date.now() + 3600000).toISOString(),
  inventoryExpiresAt: new Date(Date.now() + 3600000).toISOString(), paymentMethod: '支付宝', productUrl: 'https://example.com/buy', tags: [], capturedAt: new Date().toISOString() };
function mockApi({ status = 200, merged = false, expires = false, inventoryExpiresAt = quote.inventoryExpiresAt, priceStatus = quote.priceStatus, tags = [], settlementQuantity, paymentMethod = quote.paymentMethod, price = quote.price, listedPrice = quote.listedPrice, facets = [{ name: 'delivery', value: 'top_up' }], products = [product, { id: '43', name: 'Claude Max 20x', platform: 'anthropic', kind: '账号与订阅' }] } = {}) {
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
        ...(url.searchParams.has('detailKind') ? { detail: { entries: [offer], total: 25 } } : {}) }] });
    }
    return new Response(null, { status: 204 });
  }));
  return calls;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/'); });
beforeEach(() => { vi.stubGlobal('scrollTo', vi.fn()); measurement.automatic = true; measurement.callback = null; });

test('estimated payment prices visibly identify their assumption while remaining available for comparison', async () => {
  mockApi({priceStatus:'estimated',listedPrice:'12.50',paymentMethod:'支付价（预估：售价）'}); render(<App />);
  expect((await screen.findAllByText('预估')).length).toBeGreaterThan(0);
  expect(screen.getAllByLabelText(/结算价.*预估.*售价/).length).toBeGreaterThan(0);
  expect(screen.getAllByText('¥12.5').length).toBeGreaterThan(0);
  fireEvent.click(screen.getAllByRole('checkbox', { name: /对比报价/ })[0]);
  fireEvent.click(screen.getAllByRole('button', { name: '对比（1）' })[0]);
  expect(within(screen.getByRole('dialog', { name: '报价对比' })).getByText('预估')).toBeInTheDocument();
});

test.each(['/', '/products/42'])('expired payment quotes remain estimated and comparable on %s', async path => {
  window.history.replaceState({}, '', path);
  mockApi({ priceStatus: 'expired' }); render(<App />);
  await screen.findAllByText('预估');
  expect(screen.getAllByLabelText(/结算价.*历史金额预估/).length).toBeGreaterThan(0);
  expect(screen.getAllByText('¥12.5').length).toBeGreaterThan(0);
  fireEvent.click(screen.getAllByRole('checkbox', { name: /对比报价/ })[0]);
  fireEvent.click(screen.getAllByRole('button', { name: '对比（1）' })[0]);
  expect(within(screen.getByRole('dialog', { name: '报价对比' })).getByText('预估')).toBeInTheDocument();
});

test.each(['/', '/products/42'])('inventory expiry removes the merchant listing even when the refresh hangs on %s', async path => {
  window.history.replaceState({}, '', path);
  mockApi({ inventoryExpiresAt: new Date(Date.now() + 400).toISOString() });
  const fetchMock = globalThis.fetch;
  let reads = 0;
  vi.stubGlobal('fetch', vi.fn(input => {
    if (new URL(input, 'http://localhost').pathname === '/api/catalog' && ++reads > 1) return new Promise(() => {});
    return fetchMock(input);
  }));
  render(<App />); await screen.findAllByText('¥12.5');
  await waitFor(() => expect(screen.queryByText('¥12.5')).not.toBeInTheDocument());
  expect(document.querySelector('.tile-price.best')).toBeNull();
  expect(screen.queryByText('预估')).not.toBeInTheDocument();
  expect(screen.queryAllByText('接码服务')).toHaveLength(0);
  expect(screen.queryAllByRole('link', { name: '去商家' })).toHaveLength(0);
});

test.each(['/', '/products/42'])('inventory still expires after payment expiry when the first refresh hangs on %s', async path => {
  window.history.replaceState({}, '', path);
  mockApi({ expires: true, inventoryExpiresAt: new Date(Date.now() + 800).toISOString() });
  const fetchMock = globalThis.fetch;
  let reads = 0;
  vi.stubGlobal('fetch', vi.fn(input => {
    if (new URL(input, 'http://localhost').pathname === '/api/catalog' && ++reads > 1) return new Promise(() => {});
    return fetchMock(input);
  }));
  render(<App />); await screen.findAllByText('¥12.5');
  await screen.findAllByText('预估');
  await waitFor(() => expect(screen.queryByText('¥12.5')).not.toBeInTheDocument());
  expect(document.querySelector('.tile-price.best')).toBeNull();
});

test('comparison changes an existing estimate only once then removes its amount at inventory expiry', async () => {
  mockApi({ paymentMethod: '支付宝（预估）', inventoryExpiresAt: new Date(Date.now() + 800).toISOString() });
  render(<App />); await screen.findAllByText('¥12.5');
  fireEvent.click(screen.getAllByRole('checkbox', { name: /对比报价/ })[0]);
  fireEvent.click(screen.getAllByRole('button', { name: '对比（1）' })[0]);
  const comparison = within(screen.getByRole('dialog', { name: '报价对比' }));
  expect(comparison.getAllByText('预估')).toHaveLength(1);
  await waitFor(() => expect(comparison.queryByText('¥12.5')).not.toBeInTheDocument());
  expect(comparison.queryByRole('link', { name: '去商家' })).not.toBeInTheDocument();
});

test('keeps history off the homepage and offers both aggregate and individual history in product details', async () => {
  const calls = mockApi(); render(<App />);
  await screen.findByRole('link', { name: product.name });
  expect(screen.queryByRole('region', { name: '商品价格历史' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /价格历史/ })).not.toBeInTheDocument();
  expect(calls.some(url => url.pathname.endsWith('/price-history'))).toBe(false);
  fireEvent.click(screen.getByRole('link', { name: product.name }));
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
    { name: 'delivery', value: 'top_up' },
  ] });
  render(<App />);
  const facts = await screen.findByRole('group', { name: '商品标签' });
  expect(within(facts).getAllByText('5件起购')).toHaveLength(1);
  expect(facts).toHaveTextContent('代充');
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
  render(<App />);
  await screen.findByRole('link', { name: product.name });
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
  render(<App />);
  await screen.findByRole('link', { name: product.name });
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
  mockApi({ tags: [{ name: 'delivery', value: 'top_up' }] });
  render(<App />);
  await screen.findByRole('link', { name: product.name });
  const facts = screen.getByRole('group', { name: '商品标签' });
  expect(facts).toHaveTextContent('代充');
  expect(facts).toHaveAttribute('tabindex', '0');
  expect(facts).not.toHaveAttribute('aria-hidden');
  expect(document.querySelectorAll('.offer-facts')).toHaveLength(2);
});

test('keeps inline filters below the sticky toolbar without scrolling an already visible panel', async () => {
  mockApi(); render(<App />);
  await screen.findByRole('link', { name: product.name });
  const toolbar = screen.getByRole('region', { name: '搜索和筛选' });
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
    await within(panel).findByRole('checkbox', { name: /代充/ });
    fireEvent.keyDown(window, { key: 'Escape' });
  }
});

test('uses main search and purchase filters without fetching or displaying the product directory', async () => {
  const calls = mockApi(); render(<App />);
  await screen.findByRole('link', { name: product.name });
  fireEvent.change(screen.getByRole('textbox', { name: '搜索商品' }), { target: { value: 'Plus' } });
  await waitFor(() => expect(calls.some(url => url.pathname === '/api/catalog' && url.searchParams.get('q') === 'Plus')).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: '筛选', exact: true }));
  const panel = within(screen.getByRole('region', { name: '筛选报价' }));
  fireEvent.click(await panel.findByRole('checkbox', { name: /代充/ }));
  expect(panel.queryByRole('searchbox')).not.toBeInTheDocument();
  expect(panel.queryByRole('group', { name: '商品平台' })).not.toBeInTheDocument();
  expect(panel.queryByRole('radio')).not.toBeInTheDocument();
  expect(calls.some(url => url.pathname === '/api/catalog/products')).toBe(false);
  fireEvent.click(panel.getByRole('button', { name: '应用筛选（1）' }));
  await waitFor(() => expect(calls.some(url => url.pathname === '/api/catalog' && url.searchParams.get('limit') === '20'
    && url.searchParams.get('q') === 'Plus' && url.searchParams.getAll('tag').includes('{"name":"delivery","value":"top_up"}'))).toBe(true));
  expect(new URLSearchParams(window.location.search).has('standardProductId')).toBe(false);
  fireEvent.click(within(screen.getByLabelText('已选筛选条件')).getByRole('button', { name: /代充/ }));
  expect(screen.queryByLabelText('已选筛选条件')).not.toBeInTheDocument();
});

test('keeps old product links clearable without the picker and discards unapplied edits', async () => {
  window.history.replaceState({}, '', '/?platform=openai&standardProductId=42');
  const calls = mockApi(); render(<App />);
  await screen.findByRole('button', { name: /Codex 手机接码/ });
  fireEvent.click(screen.getByRole('button', { name: '筛选（1）' }));
  const panel = within(screen.getByRole('region', { name: '筛选报价' }));
  fireEvent.click(await panel.findByRole('checkbox', { name: /代充/ }));
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(new URLSearchParams(window.location.search).get('standardProductId')).toBe('42');
  fireEvent.click(screen.getByRole('button', { name: '筛选（1）' }));
  expect(screen.getByRole('checkbox', { name: /代充/ })).not.toBeChecked();
  expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  expect(calls.some(url => url.pathname === '/api/catalog/products')).toBe(false);
  fireEvent.click(within(screen.getByRole('region', { name: '筛选报价' })).getByRole('button', { name: '清除全部' }));
  fireEvent.click(screen.getByRole('button', { name: '应用筛选', exact: true }));
  expect(new URLSearchParams(window.location.search).has('standardProductId')).toBe(false);
});

test.each(['search', 'platform'])('clears a legacy product restriction when changing %s', async mode => {
  window.history.replaceState({}, '', '/?standardProductId=42');
  const calls = mockApi(); render(<App />);
  await screen.findByRole('link', { name: product.name });
  if (mode === 'search') fireEvent.change(screen.getByRole('textbox', { name: '搜索商品' }), { target: { value: 'Claude' } });
  else fireEvent.click(screen.getByRole('button', { name: 'Claude', exact: true }));
  await waitFor(() => expect(new URLSearchParams(window.location.search).has('standardProductId')).toBe(false));
  await waitFor(() => expect(calls.some(url => url.pathname === '/api/catalog' && !url.searchParams.has('standardProductId')
    && (mode === 'search' ? url.searchParams.get('q') === 'Claude' : url.searchParams.get('platform') === 'anthropic'))).toBe(true));
});

test.each([
  ['credentials', '有', ['账密', '含2FA']],
  ['cdk', '无', ['卡密', '无2FA']],
  ['json', 'unknown', ['JSON']],
  ['refresh_token', 'unspecified', ['刷新令牌']],
  ['token', '有', ['令牌', '含2FA']],
  ['cookie', '无', ['Cookie', '无2FA']],
  ['link', '有', ['兑换链接', '含2FA']],
  ['sms_link', '有', ['接码链接', '含2FA']],
  ['email_api', '有', ['邮箱接口', '含2FA']],
  ['pdf', '无', ['PDF', '无2FA']],
])('shows compact delivery %s and 2FA %s badges', async (format, twoFactor, expected) => {
  mockApi({ tags: [{ name: 'delivery_format', value: format }, { name: '2fa', value: twoFactor }] });
  render(<App />); await screen.findByRole('link', { name: product.name });
  const facts = screen.getByLabelText('商品标签');
  expect([...facts.querySelectorAll('span')].map(tag => tag.textContent)).toEqual(expected);
  expect(facts).not.toHaveTextContent(/交付资料：|双重验证：/);
});

test('shows distinct badges with warranty in the same strip and no prefix', async () => {
  mockApi({ tags: [
    { name: 'delivery', value: 'account' }, { name: 'access', value: 'dedicated' },
    { name: 'intended_use', value: 'rapid' }, { name: 'intended_use', value: 'rapid' },
    { name: 'duration', value: '1 month' }, { name: 'intended_use', value: 'rapid' },
    { name: 'account_type', value: '黑号' }, { name: 'warranty', value: 'covered' },
    { name: 'warranty_scope', value: 'period' }, { name: 'warranty_days', value: '30' },
  ] }); render(<App />);
  await screen.findByRole('link', { name: product.name });
  const facts = screen.getByLabelText('商品标签');
  expect([...facts.querySelectorAll('span')].map(tag => tag.textContent)).toEqual(['质保30天', '独享', '成品账号']);
  expect(facts).toHaveTextContent('另 3 个标签');
  expect(within(facts).queryByText('速刷')).not.toBeInTheDocument();
  expect(within(facts).queryByText('日抛')).not.toBeInTheDocument();
  expect(facts).not.toHaveTextContent(/售后：|商家标注|未说明/);
  fireEvent.click(screen.getAllByRole('button', { name: '商品说明', exact: true })[0]);
  expect(within(screen.getByRole('dialog', { name: quote.name })).getAllByText('速刷')).toHaveLength(1);
});

test.each(['personal', 'enterprise'])('shows duration in cards and comparison while keeping %s account types compact', async accountType => {
  mockApi({ tags: [
    { name: 'duration', value: '1 month' },
    { name: 'account_type', value: accountType },
  ] }); render(<App />);
  await screen.findByRole('link', { name: product.name });
  expect(screen.getByLabelText('商品标签')).toHaveTextContent('1个月');
  fireEvent.click(screen.getAllByRole('checkbox', { name: /对比报价/ })[0]);
  fireEvent.click(screen.getByRole('button', { name: '对比（1）' }));
  const comparison = within(screen.getByRole('dialog', { name: '报价对比' }));
  const row = comparison.getByRole('rowheader', { name: '使用期限', exact: true }).closest('tr');
  expect(within(row).getByRole('cell')).toHaveTextContent('1个月');
});

test('detail badges distinguish usage duration from warranty duration', async () => {
  window.history.replaceState({}, '', '/products/42');
  mockApi({ tags: [
    { name: 'duration', value: '30 days' }, { name: 'account_type', value: 'seat' },
    { name: 'account_type', value: 'personal' }, { name: 'warranty_days', value: '7' },
  ] }); render(<App />);
  await screen.findByText('¥12.5');
  expect([...screen.getByLabelText('商品标签').children].map(tag => tag.textContent)).toEqual(['质保7天', '席位', '30天']);
});

test.each(['/', '/products/42'])('shows both dedicated and shared access explicitly on %s', async path => {
  window.history.replaceState({}, '', path);
  mockApi({ tags: [{ name: 'access', value: 'dedicated' }] });
  const view = render(<App />);
  await screen.findAllByText('¥12.5');
  expect(within(screen.getByLabelText('商品标签')).getByText('独享')).toBeInTheDocument();
  view.unmount();
  mockApi({ tags: [{ name: 'access', value: 'shared' }] });
  render(<App />);
  await screen.findAllByText('¥12.5');
  expect(within(screen.getByLabelText('商品标签')).getByText('共享')).toBeInTheDocument();
});

test.each([
  ['ph', '菲律宾'], ['us', '美国'], ['in', '印度'], ['tr', '土耳其'],
  ['eu', '欧洲'], ['global', '全球'], ['random', '随机地区'], ['sea', '东南亚'],
  ['美区', '美区'], ['unknown', null],
])('retains %s region in details while prioritizing warranty, access and recharge', async (region, label) => {
  mockApi({ tags: [
    { name: 'delivery', value: 'top_up' }, { name: 'region', value: region },
    { name: 'region', value: region }, { name: 'duration', value: '1 month' },
    { name: 'access', value: 'dedicated' }, { name: 'warranty_days', value: '30' },
  ] }); render(<App />);
  await screen.findByRole('link', { name: product.name });
  expect([...screen.getByLabelText('商品标签').querySelectorAll('span')].map(tag => tag.textContent))
    .toEqual(['质保30天', '独享', '代充']);
  expect(screen.getByLabelText('商品标签')).toHaveTextContent(`另 ${label ? 2 : 1} 个标签`);
  fireEvent.click(screen.getAllByRole('button', { name: '商品说明', exact: true })[0]);
  const details = screen.getByRole('dialog', { name: quote.name });
  if (label) expect(within(details).getAllByText(label, { exact: true })).toHaveLength(1);
  else expect(details).not.toHaveTextContent('unknown');
});

test('shows the same region in detail badges and quote comparison', async () => {
  window.history.replaceState({}, '', '/products/42');
  mockApi({ tags: [{ name: 'delivery', value: 'top_up' }, { name: 'region', value: 'ph' }] });
  render(<App />);
  await screen.findByText('¥12.5');
  expect(within(screen.getByLabelText('商品标签')).getByText('菲律宾')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('checkbox', { name: /对比报价/ }));
  fireEvent.click(screen.getAllByRole('button', { name: '对比（1）' })[0]);
  const comparison = within(screen.getByRole('dialog', { name: '报价对比' }));
  const row = comparison.getByRole('rowheader', { name: '地区', exact: true }).closest('tr');
  expect(within(row).getByRole('cell')).toHaveTextContent('菲律宾');
});

test.each([
  ['empty', [], null],
  ['unknown', [{ name: 'warranty', value: 'unknown' }, { name: 'warranty_scope', value: 'unspecified' }], null],
  ['first login', [{ name: 'warranty', value: 'covered' }, { name: 'warranty_scope', value: 'first_login' }, { name: 'warranty_days', value: '1' }], '仅保首登'],
  ['activation', [{ name: 'warranty', value: 'covered' }, { name: 'warranty_scope', value: 'activation' }], '仅保激活'],
  ['subscription days', [{ name: 'warranty_scope', value: 'subscription' }, { name: 'warranty_window', value: '30 days' }, { name: 'warranty_exclusion', value: 'ban' }], '质保30天（仅保掉订阅；不保封号）'],
  ['period months', [{ name: 'warranty_scope', value: 'period' }, { name: 'warranty_window', value: '1 month' }], '质保1个月'],
  ['subscription unknown term', [{ name: 'warranty_scope', value: 'subscription' }], '仅保掉订阅（时长未注明）'],
  ['period unknown term', [{ name: 'warranty_scope', value: 'period' }], '有质保（时长未注明）'],
  ['none', [{ name: 'warranty', value: 'none' }], '无质保'],
])('renders %s warranty without unknown placeholders in cards and comparison', async (_name, tags, warranty) => {
  mockApi({ tags }); render(<App />);
  await screen.findByRole('link', { name: product.name });
  if (warranty) expect(within(screen.getByLabelText('商品标签')).getByText(warranty)).toBeInTheDocument();
  else expect(screen.queryByLabelText('商品标签')).not.toBeInTheDocument();
  expect(screen.queryByText(/^售后：/)).not.toBeInTheDocument();
  for (const tile of document.querySelectorAll('.shop-tile')) expect(tile).not.toHaveTextContent(/未说明/);
  fireEvent.click(screen.getAllByRole('checkbox', { name: /对比报价/ })[0]);
  fireEvent.click(screen.getAllByRole('checkbox', { name: /对比报价/ })[1]);
  fireEvent.click(screen.getByRole('button', { name: '对比（2）' }));
  const comparison = within(screen.getByRole('dialog', { name: '报价对比' }));
  if (warranty) {
    const row = comparison.getByRole('rowheader', { name: '售后', exact: true }).closest('tr');
    expect(within(row).getAllByRole('cell').map(cell => cell.textContent)).toEqual([warranty, '—']);
  } else expect(comparison.queryByRole('rowheader', { name: '售后' })).not.toBeInTheDocument();
});

test('offers one canonical rapid purchase condition and hides unknown facets', async () => {
  const facets = [
    { name: 'account_lifecycle', value: 'disposable' }, { name: 'intended_use', value: 'rapid' },
    { name: 'warranty_scope', value: 'activation' }, { name: 'warranty_scope', value: 'first_login' },
    { name: 'warranty', value: 'unknown' }, { name: 'warranty_scope', value: 'unspecified' },
  ];
  const calls = mockApi({ facets }); render(<App />);
  await screen.findByRole('link', { name: product.name });
  fireEvent.click(screen.getByRole('button', { name: '筛选', exact: true }));
  const panel = within(screen.getByRole('region', { name: '筛选报价' }));
  fireEvent.click(await panel.findByRole('checkbox', { name: /速刷/ }));
  expect(panel.queryByRole('checkbox', { name: /日抛/ })).not.toBeInTheDocument();
  expect(panel.getAllByRole('checkbox', { name: /速刷/ })).toHaveLength(1);
  fireEvent.click(panel.getByRole('radio', { name: '仅保激活' }));
  expect(panel.getByText('速刷')).toBeInTheDocument();
  expect(panel.getByRole('radio', { name: '仅保首次登录' })).toBeInTheDocument();
  expect(panel.queryByText(/未说明|商家标注/)).not.toBeInTheDocument();
  fireEvent.click(panel.getByRole('button', { name: '应用筛选（2）' }));
  await waitFor(() => expect(calls.some(url => url.pathname === '/api/catalog' && url.searchParams.get('limit') === '20'
    && url.searchParams.getAll('tag').includes('{"name":"intended_use","value":"rapid"}')
    && url.searchParams.getAll('tag').includes('{"name":"warranty_scope","value":"activation"}'))).toBe(true));
});

test('preserves the canonical rapid filter in comparison without creating an account type', async () => {
  window.history.replaceState({}, '', '/?' + new URLSearchParams({ tag: '{"name":"intended_use","value":"rapid"}' }));
  const calls = mockApi({ tags: [{ name: 'intended_use', value: 'rapid' }] });
  render(<App />);
  await screen.findByRole('link', { name: product.name });
  expect(within(screen.getByLabelText('已选筛选条件')).getByRole('button', { name: /速刷/ })).toBeInTheDocument();
  expect(calls.some(url => url.searchParams.getAll('tag').includes('{"name":"intended_use","value":"rapid"}'))).toBe(true);
  fireEvent.click(screen.getAllByRole('checkbox', { name: /对比报价/ })[0]);
  fireEvent.click(screen.getByRole('button', { name: '对比（1）' }));
  const comparison = within(screen.getByRole('dialog', { name: '报价对比' }));
  expect(comparison.getByRole('cell', { name: '速刷', exact: true })).toBeInTheDocument();
  expect(comparison.queryByRole('rowheader', { name: '账号类型' })).not.toBeInTheDocument();
});

test('removing the rapid intent clears every daily synonym while keeping product search text', async () => {
  window.history.replaceState({}, '', '/?' + new URLSearchParams({ q: 'Claude 日抛 速刷' }));
  mockApi(); render(<App />);
  const intents = await screen.findByLabelText('已识别购买条件');
  expect(within(intents).getAllByRole('button', { name: '移除速刷' })).toHaveLength(1);
  fireEvent.click(within(intents).getByRole('button', { name: '移除速刷' }));
  expect(screen.getByRole('textbox', { name: '搜索商品' })).toHaveValue('Claude');
  expect(screen.queryByLabelText('已识别购买条件')).not.toBeInTheDocument();
});

test.each([
  ['first_login', '仅保首次登录'], ['activation', '仅保激活'], ['first_code', '仅保首次接码'], ['subscription', '仅保掉订阅'],
])('keeps %s and full-period minimum days mutually exclusive in detail filters', async (scope, label) => {
  window.history.replaceState({}, '', '/products/42');
  const calls = mockApi({ facets: [{ name: 'warranty_days', value: '30' }, { name: 'warranty_scope', value: scope }] });
  render(<App />);
  await screen.findByText('¥12.5');
  fireEvent.click(screen.getByRole('button', { name: '筛选', exact: true }));
  const option = await screen.findByRole('radio', { name: label });
  const warrantyGroup = screen.getByRole('group', { name: '质保要求', exact: true });
  expect(warrantyGroup).toContainElement(option);
  expect(within(warrantyGroup).queryByRole('group', { name: '最低质保天数' })).not.toBeInTheDocument();
  fireEvent.click(option);
  fireEvent.click(screen.getByRole('radio', { name: '按质保时长' }));
  fireEvent.click(screen.getByRole('radio', { name: '至少30天' }));
  expect(option).not.toBeChecked();
  fireEvent.click(option);
  expect(screen.queryByRole('group', { name: '最低质保天数' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /应用筛选/ }));
  await waitFor(() => expect(calls.some(url => url.searchParams.has('detailKind')
    && !url.searchParams.has('warrantyDaysMin')
    && url.searchParams.getAll('tag').includes(JSON.stringify({ name: 'warranty_scope', value: scope })))).toBe(true));
});

test('homepage shows compact settlement and listed prices with expiry in a hint and one click merchant links', async () => {
  mockApi(); render(<App />);
  expect(await screen.findByRole('link', { name: 'Codex 手机接码' })).toHaveAttribute('href', '/products/42?newcomer=false');
  expect(screen.getAllByText('¥12.5')).toHaveLength(2);
  expect(document.querySelector('.tile-price')).toHaveTextContent('¥12.5 / 标价 9');
  expect(document.querySelector('.lowest-note')).toHaveTextContent('¥12.5 起');
  expect(document.querySelector('.lowest-note')).not.toHaveTextContent('标价');
  expect(screen.getByLabelText(/结算价.*预估.*售价/).closest('.tile-price')).toHaveTextContent('¥18预估 / 标价 18');
  expect(document.querySelector('.tile-price.price-unavailable')).not.toBeInTheDocument();
  expect(screen.queryByText(/核验|有效至|支付宝/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /展开报价|收起报价/ })).not.toBeInTheDocument();
  expect(screen.queryByText(quote.spec)).not.toBeInTheDocument();
  expect(screen.getAllByTitle(/支付宝.*有效至/)).toHaveLength(2);
  expect(screen.queryByText('¥0')).not.toBeInTheDocument();
  expect(screen.getAllByRole('link', { name: '去商家' })[0]).toHaveAttribute('href', 'https://example.com/buy');
});

test.each([
  ['15.10', '15.1'], ['15.00', '15'], ['15.05', '15.05'], ['15.126', '15.13'], ['0.00', '0'],
])('formats both prices %s with at most two decimals and no trailing zeros', async (price, expected) => {
  mockApi({ price, listedPrice: price }); render(<App />);
  await screen.findByRole('link', { name: product.name });
  expect(document.querySelector('.tile-price')).toHaveTextContent(`¥${expected} / 标价 ${expected}`);
});

test.each([
  ['12.50', '12.5'], ['350.00', '350'], ['350.10', '350.1'], ['350.05', '350.05'],
  ['0', '0'], [null, '—'], ['', '—'], [' ', '—'], ['invalid', '—'], ['Infinity', '—'], ['-1', '—'],
])('compact listed price %j displays as %s without replacing settlement', async (listedPrice, expected) => {
  mockApi({ listedPrice }); render(<App />);
  await screen.findByRole('link', { name: product.name });
  expect(document.querySelector('.tile-price')).toHaveTextContent(`¥12.5 / 标价 ${expected}`);
});

test('direct product page is nonmodal, defaults to CNY and loads batches with dedicated SEO', async () => {
  window.history.replaceState({}, '', '/products/42'); const calls = mockApi(); render(<App />);
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

test('refresh keeps product page filters and starts continuous loading from the first batch', async () => {
  const params = new URLSearchParams({ detailPage: '1', detailPageSize: '12', currency: 'USD', offerSort: 'updated', shopQuery: '示例' });
  window.history.replaceState({}, '', '/products/42?' + params); const calls = mockApi(); render(<App />);
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
  window.history.replaceState({}, '', '/products/42'); mockApi({ status: 404 }); const view = render(<App />);
  expect(await screen.findByRole('heading', { name: '商品不存在或已下架' })).toBeInTheDocument();
  expect(document.querySelector('meta[name="robots"]').content).toContain('noindex');
  view.unmount(); mockApi({ status: 503 }); render(<App />);
  expect(await screen.findByRole('heading', { name: '商品暂时无法加载' })).toBeInTheDocument();
  mockApi(); fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByRole('heading', { level: 1, name: 'Codex 手机接码' })).toBeInTheDocument();
});

test('merged product replaces URL and a list return restores filters and scroll position', async () => {
  window.history.replaceState({}, '', '/products/41'); mockApi({ merged: true }); const view = render(<App />);
  await screen.findByRole('heading', { level: 1, name: product.name });
  expect(window.location.pathname).toBe('/products/42'); view.unmount();
  window.history.replaceState({}, '', '/?platform=openai&sort=price'); mockApi();
  const scrollTo = vi.fn(); vi.stubGlobal('scrollTo', scrollTo); Object.defineProperty(window, 'scrollY', { configurable: true, value: 420 });
  render(<App />); fireEvent.click(await screen.findByRole('link', { name: product.name }));
  await screen.findByRole('heading', { level: 1, name: product.name });
  fireEvent.click(screen.getByRole('link', { name: '返回商品列表' }));
  await waitFor(() => expect(window.location.pathname).toBe('/'));
  expect(new URLSearchParams(window.location.search).get('platform')).toBe('openai');
  expect(new URLSearchParams(window.location.search).get('sort')).toBe('price');
  await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(0, 420));
});

test('restores list scroll only after the virtual rows have measurable height', async () => {
  measurement.automatic = false;
  window.history.replaceState({ catalogScroll: 250 }, '', '/?platform=openai&standardProductId=42');
  const scrollTo = vi.fn(); vi.stubGlobal('scrollTo', scrollTo); mockApi(); render(<App />);
  await screen.findByRole('link', { name: product.name });
  expect(scrollTo).not.toHaveBeenCalled();
  await act(async () => measurement.callback(0));
  expect(scrollTo).not.toHaveBeenCalled();
  await act(async () => measurement.callback(1500));
  await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(0, 250));
});

test('payment expiry retains an estimated minimum while rereading and visibility restoration rechecks', async () => {
  const calls = mockApi({ expires: true }); render(<App />);
  await screen.findAllByText('¥12.5');
  await screen.findAllByText('预估');
  await waitFor(() => expect(document.querySelector('.tile-price.best')).toHaveTextContent('¥12.5预估'));
  expect(document.querySelector('.lowest-note')).toHaveTextContent('¥12.5预估');
  expect(screen.queryByText('¥0')).not.toBeInTheDocument();
  const before = calls.filter(url => url.pathname === '/api/catalog').length;
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  await waitFor(() => expect(calls.filter(url => url.pathname === '/api/catalog').length).toBeGreaterThan(before));
});

test('payment expiry keeps the estimated minimum even when rereading fails', async () => {
  const api = mockApi({ expires: true });
  const fetchMock = globalThis.fetch;
  let release;
  vi.stubGlobal('fetch', vi.fn(async input => {
    if (new URL(input, 'http://localhost').pathname === '/api/catalog' && api.some(url => url.pathname === '/api/catalog')) {
      return new Promise(resolve => { release = resolve; });
    }
    return fetchMock(input);
  }));
  render(<App />); await screen.findAllByText('¥12.5');
  await screen.findAllByText('预估');
  await waitFor(() => expect(document.querySelector('.tile-price.best')).toHaveTextContent('¥12.5预估'));
  expect(document.querySelector('.lowest-note')).toHaveTextContent('¥12.5预估');
  await waitFor(() => expect(release).toBeTypeOf('function'));
  await act(async () => release(Response.json({}, { status: 503 })));
  expect(await screen.findByRole('alert')).toHaveTextContent('商品加载失败');
  expect(document.querySelector('.tile-price.best')).toHaveTextContent('¥12.5预估');
});

test.each(['/', '/products/42'])('opens SKU details without requests and keeps nested report and comparison layers on %s', async path => {
  window.history.replaceState({}, '', path);
  const calls = mockApi({ tags: [{ name: 'delivery', value: 'top_up' }, { name: 'access', value: 'shared' }, { name: 'duration', value: '30 days' }, { name: 'usage_restriction', value: '禁止改密' }] });
  render(<App />); await screen.findAllByText('¥12.5');
  expect(screen.queryByRole('button', { name: '举报此报价' })).not.toBeInTheDocument();
  const trigger = screen.getAllByRole('button', { name: '商品说明', exact: true })[0]; trigger.focus();
  const before = calls.length; fireEvent.click(trigger);
  let details = screen.getByRole('dialog', { name: quote.name });
  expect(details).toHaveTextContent(quote.spec);
  expect(details).toHaveTextContent('禁止改密'); expect(details).toHaveTextContent('30天');
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
  mockApi({ tags: [{ name: 'usage_restriction', value: '禁止改密' }] }); render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: '25 条报价' }));
  const parent = await screen.findByRole('dialog', { name: /报价/ });
  const trigger = within(parent).getAllByRole('button', { name: '商品说明', exact: true })[0]; trigger.focus(); fireEvent.click(trigger);
  const details = screen.getByRole('dialog', { name: quote.name });
  expect(details).toHaveTextContent('禁止改密'); expect(details).toHaveTextContent(quote.spec);
  fireEvent.keyDown(details, { key: 'Escape' });
  expect(parent).toBeInTheDocument(); expect(trigger).toHaveFocus();
});

test('switching merchant products never carries conditions from the previous SKU', async () => {
  mockApi({ tags: [{ name: 'usage_restriction', value: '禁止改密' }] }); render(<App />);
  await screen.findByRole('link', { name: product.name });
  const triggers = screen.getAllByRole('button', { name: '商品说明', exact: true });
  fireEvent.click(triggers[0]); expect(screen.getByRole('dialog', { name: quote.name })).toHaveTextContent('禁止改密');
  fireEvent.click(screen.getByRole('button', { name: '关闭商品说明' })); fireEvent.click(triggers[1]);
  expect(screen.getByRole('dialog', { name: quote.name })).not.toHaveTextContent('禁止改密');
});

test.each(['/', '/products/42'])('prioritizes warranty, account access and delivery in the three visible tags on %s', async path => {
  window.history.replaceState({}, '', path);
  mockApi({ settlementQuantity: 5, tags: [
    { name: 'usage_restriction', value: '禁止改密' }, { name: 'delivery_mode', value: 'automatic' },
    { name: 'login_method', value: 'email_code' }, { name: 'delivery', value: 'top_up' },
    { name: 'access', value: 'shared' }, { name: 'warranty', value: 'covered' },
    { name: 'warranty_scope', value: 'period' }, { name: 'warranty_days', value: '30' },
  ] });
  render(<App />); await screen.findAllByText('¥12.5');
  const facts = screen.getByLabelText('商品标签');
  expect([...facts.querySelectorAll('span')].map(element => element.textContent)).toEqual(['质保30天', '共享', '代充']);
  expect(facts).toHaveTextContent('另 4 个标签');
  fireEvent.click(screen.getAllByRole('button', { name: '商品说明', exact: true })[0]);
  const details = screen.getByRole('dialog', { name: quote.name });
  for (const text of ['5件起购', '禁止改密', '自动发货', '邮箱验证码登录']) expect(details).toHaveTextContent(text);
});

test.each([
  [[{ name: 'warranty', value: 'none' }], ['无质保', '独享', '代充']],
  [[{ name: 'warranty_scope', value: 'first_login' }, { name: 'warranty_window', value: '24 hours' }], ['仅保首登（24小时内）', '独享', '代充']],
  [[{ name: 'warranty', value: 'unknown' }], ['独享', '代充', '禁止改密']],
])('keeps warranty limits and unknown handling when prioritizing %j', async (warrantyTags, expected) => {
  mockApi({ tags: [
    { name: 'usage_restriction', value: '禁止改密' }, { name: 'delivery_mode', value: 'automatic' },
    { name: 'delivery', value: 'top_up' }, { name: 'access', value: 'dedicated' }, ...warrantyTags,
  ] });
  render(<App />); await screen.findByRole('link', { name: product.name });
  expect([...screen.getByLabelText('商品标签').querySelectorAll('span')].map(element => element.textContent)).toEqual(expected);
});

test.each([false, true])('prioritizes account role and lifecycle when core tags are absent (reversed: %s)', async reversed => {
  const tags = [
    { name: 'delivery_mode', value: 'automatic' }, { name: 'login_method', value: 'email_code' },
    { name: 'account_lifecycle', value: 'aged' }, { name: 'account_type', value: 'sub_account' },
    { name: 'usage_restriction', value: '禁止改密' },
  ];
  mockApi({ tags: reversed ? tags.reverse() : tags });
  render(<App />); await screen.findByRole('link', { name: product.name });
  const facts = screen.getByLabelText('商品标签');
  expect([...facts.querySelectorAll('span')].map(element => element.textContent)).toEqual(['子号', '老号', '禁止改密']);
  expect(facts).toHaveTextContent('另 2 个标签');
});

test('equal boolean values retain distinct field identities, three-item budget and overflow', async () => {
  mockApi({ tags: [
    { name: 'single_use', value: '有' }, { name: 'renewable', value: '有' },
    { name: 'sms_required', value: '有' }, { name: 'single_use', value: '有' },
    { name: 'renewal_timing', value: 'after_expiry' }, { name: 'account_age', value: '1 year' },
  ] }); render(<App />); await screen.findByRole('link', { name: product.name });
  const facts = screen.getByLabelText('商品标签');
  expect([...facts.querySelectorAll('span')].map(element => element.textContent)).toEqual(['一次性使用', '可续费', '到期后续费']);
  expect(facts).toHaveTextContent('另 2 个标签');
  fireEvent.click(screen.getAllByRole('button', { name: '商品说明', exact: true })[0]);
  const details = screen.getByRole('dialog', { name: quote.name });
  expect(details).toHaveTextContent('需接码');
  expect(details).toHaveTextContent('号龄1年');
  expect(details).toHaveTextContent('到期后续费');
});
test('canonical year duration is readable in summaries and details', async () => {
  mockApi({ tags: [{ name: 'delivery', value: 'top_up' }, { name: 'duration', value: '1 year' }, { name: 'sms_required', value: '有' }] });
  render(<App />); await screen.findByRole('link', { name: product.name });
  expect(screen.getByLabelText('商品标签')).toHaveTextContent('代充需接码1年');
  fireEvent.click(screen.getAllByRole('button', { name: '商品说明', exact: true })[0]);
  expect(screen.getByRole('dialog', { name: quote.name })).toHaveTextContent('1年');
});

test('cards and dialogs share localized delivery and login values', async () => {
  mockApi({ tags: [{ name: 'delivery_mode', value: 'automatic' }, { name: 'delivery_format', value: 'credentials' }, { name: 'login_method', value: 'email_code' }] });
  render(<App />); await screen.findByRole('link', { name: product.name });
  const facts = screen.getByLabelText('商品标签');
  expect(facts).toHaveTextContent('自动发货');
  expect(facts).toHaveTextContent('账密');
  expect(facts).toHaveTextContent('邮箱验证码登录');
  fireEvent.click(screen.getAllByRole('button', { name: '商品说明', exact: true })[0]);
  const dialog = screen.getByRole('dialog', { name: quote.name });
  expect(dialog).toHaveTextContent('自动发货');
  expect(dialog).toHaveTextContent('账密');
  expect(dialog).toHaveTextContent('邮箱验证码登录');
  expect(dialog).not.toHaveTextContent(/automatic|credentials|email.code/);
  expect(dialog.querySelector('.offer-tag-details-groups')).not.toHaveTextContent('：');
  expect(facts).not.toHaveTextContent('：');
});

test('keeps resource, region and period labels distinct after shortening', async () => {
  mockApi({ tags: [
    { name: 'region_options', value: 'us' }, { name: 'registration_region', value: 'us' },
    { name: 'token_validity_min', value: '3 months' }, { name: 'duration_approx', value: '3 months' },
    { name: 'memory', value: '8 gb' }, { name: 'storage', value: '8 gb' },
    { name: 'single_use', value: '无' }, { name: 'renewable', value: '无' },
  ] });
  render(<App />); await screen.findByRole('link', { name: product.name });
  fireEvent.click(screen.getAllByRole('button', { name: '商品说明', exact: true })[0]);
  const dialog = screen.getByRole('dialog', { name: quote.name });
  for (const label of ['可选美国', '注册地美国', '令牌至少3个月', '约3个月', '内存 8GB', '存储 8GB', '可多次使用', '不可续费']) {
    expect(within(dialog).getByText(label, { exact: true })).toBeInTheDocument();
  }
});

test('summarizes additional tags with only their count', async () => {
  mockApi({ tags: [
    { name: 'delivery', value: 'account' }, { name: 'delivery_mode', value: 'automatic' },
    { name: 'access', value: 'dedicated' }, { name: 'duration', value: '30 days' },
  ] });
  render(<App />); await screen.findByRole('link', { name: product.name });
  const facts = screen.getByLabelText('商品标签');
  expect(facts.querySelector('small')).toHaveTextContent(/^另 1 个标签$/);
  expect(facts).not.toHaveTextContent(/条件，请查看商品说明/);
});
