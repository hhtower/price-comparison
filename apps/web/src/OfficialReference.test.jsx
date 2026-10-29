import React from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import OfficialReference from './OfficialReference.jsx';
import { REFERENCE_REGIONS } from '../../api/src/official-reference/official-reference.catalog.ts';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); document.body.style.overflow = ''; });

const price = { country: 'us', countryName: '美国', currency: 'USD', amount: 19.99, formatted: '$19.99', cnyAmount: 139.93, sourceUrl: 'https://apps.apple.com/us/app/id6448311069', capturedAt: '2026-09-27T08:00:00Z', stale: false };
const monthly = { id: 'plus-month', name: 'ChatGPT Plus', kind: 'subscription', period: 'P1M', prices: [price] };
const catalog = {
  updatedAt: '2026-09-27T08:00:00Z', exchangeDate: '2026-09-26',
  apps: [
    { id: 'empty', name: '未收录产品', website: 'https://example.com', totalRegions: 23, availableRegions: 0, plans: [] },
    { id: '6448311069', name: 'ChatGPT', website: 'https://chatgpt.com/pricing/', totalRegions: 23, availableRegions: 1, plans: [
      { id: 'app', name: '软件本体', kind: 'app', period: null, prices: [{ ...price, amount: 0, formatted: '免费', cnyAmount: 0 }] },
      monthly,
      { id: 'plus-year', name: 'ChatGPT Plus', kind: 'subscription', period: 'P1Y', prices: [{ ...price, amount: 199.99, formatted: '$199.99', cnyAmount: 1399.93 }] },
    ] },
    { id: '1232780281', name: 'Notion', website: 'https://www.notion.com/pricing', totalRegions: 23, availableRegions: 1, plans: [{ ...monthly, id: 'notion-plus', name: 'Notion Plus', prices: [{ ...price, formatted: '$9.99', cnyAmount: 69.93 }] }] },
  ],
};
const open = () => fireEvent.click(screen.getByRole('button', { name: '官网正价参考' }));
function respondWith(value = catalog) {
  const fetcher = vi.fn(async () => Response.json(value));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

test('opening loads the saved catalog and selects the first populated app and subscription', async () => {
  const fetcher = respondWith();
  render(<OfficialReference />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(fetcher).not.toHaveBeenCalled();
  open();
  expect(screen.getByRole('dialog', { name: '官网正价参考' })).toHaveClass('official-reference-dialog');
  expect(await screen.findByRole('tab', { name: 'ChatGPT Plus · 每月' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('button', { name: 'ChatGPT', pressed: true })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '未收录产品' })).not.toBeInTheDocument();
  expect(screen.getByText('139.93')).toBeInTheDocument();
  expect(screen.getByText('$19.99')).toBeInTheDocument();
  expect(within(screen.getByRole('tabpanel')).queryByRole('link')).not.toBeInTheDocument();
  const card = screen.getByRole('article', { name: '美国官方价格' });
  expect(card).not.toHaveAttribute('href');
  expect(card).not.toHaveAttribute('title');
  expect(card.tabIndex).toBe(-1);
  fireEvent.click(card);
  expect(screen.getByRole('dialog', { name: '官网正价参考' })).toBeInTheDocument();
  expect(screen.getByText(/2026-09-26/)).toBeInTheDocument();
  expect(screen.queryByRole('tab', { name: '软件本体' })).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { level: 3 })).not.toBeInTheDocument();
  const footnote = screen.getByText(/汇率日期/).closest('footer');
  expect(footnote).toHaveTextContent(/更新于.*汇率日期 2026-09-26/);
  expect(footnote.querySelector('time')).toHaveAttribute('dateTime', catalog.updatedAt);
  expect(screen.queryByText(/仅展示公开套餐/)).not.toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledWith('/api/official-reference/catalog', expect.objectContaining({ credentials: 'omit', signal: expect.any(AbortSignal) }));
  expect(screen.getByRole('searchbox', { name: '搜索国家或地区' })).toBeInTheDocument();
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /官网定价/ })).not.toBeInTheDocument();
});

test('plan and product selection display snapshot prices without requesting external lookups', async () => {
  const fetcher = respondWith();
  render(<OfficialReference />); open();
  const panel = await screen.findByRole('tabpanel', { name: 'ChatGPT Plus · 每月' });
  panel.scrollTop = 160;
  fireEvent.click(await screen.findByRole('tab', { name: 'ChatGPT Plus · 每年' }));
  expect(screen.getByRole('tabpanel', { name: 'ChatGPT Plus · 每年' }).scrollTop).toBe(0);
  expect(screen.getByText('1,399.93')).toBeInTheDocument();
  expect(screen.queryByText('$19.99')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Notion' }));
  expect(screen.getByRole('tab', { name: 'Notion Plus · 每月', selected: true })).toBeInTheDocument();
  expect(screen.getByText('69.93')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '未收录产品' })).not.toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('plan tabs support keyboard navigation and expose their labelled panel', async () => {
  respondWith(); render(<OfficialReference />); open();
  const month = await screen.findByRole('tab', { name: 'ChatGPT Plus · 每月' });
  month.focus();
  fireEvent.keyDown(month, { key: 'ArrowRight' });
  const year = screen.getByRole('tab', { name: 'ChatGPT Plus · 每年', selected: true });
  expect(year).toHaveFocus();
  expect(screen.getByRole('tabpanel', { name: 'ChatGPT Plus · 每年' })).toBeInTheDocument();
  fireEvent.keyDown(year, { key: 'Home' });
  expect(screen.getByRole('tab', { name: 'ChatGPT Plus · 每月', selected: true })).toHaveFocus();
  expect(screen.getByText('139.93')).toBeInTheDocument();
  fireEvent.keyDown(document.activeElement, { key: 'End' });
  expect(year).toHaveFocus();
});

test('country search matches names and codes, preserves global lowest prices and clears empty results', async () => {
  const prices = [
    { ...price, country: 'cn', countryName: '中国大陆', cnyAmount: 80 },
    price,
    { ...price, country: 'jp', countryName: '日本', cnyAmount: null },
    { ...price, country: 'in', countryName: '印度', cnyAmount: 20, stale: true },
  ];
  respondWith({ ...catalog, apps: [{ ...catalog.apps[1], plans: [{ ...monthly, prices }] }] });
  render(<OfficialReference />); open();
  const search = await screen.findByRole('searchbox', { name: '搜索国家或地区' });
  expect(screen.getByRole('status')).toHaveTextContent('4 / 4 个地区');
  fireEvent.change(search, { target: { value: '中国' } });
  expect(screen.getAllByRole('article')).toHaveLength(1);
  expect(screen.getByRole('article', { name: '中国大陆官方价格' })).toBeInTheDocument();
  fireEvent.change(search, { target: { value: ' US ' } });
  expect(screen.getByRole('status')).toHaveTextContent('1 / 4 个地区');
  expect(screen.getByRole('article', { name: '美国官方价格' })).toBeInTheDocument();
  expect(screen.queryByText('最低')).not.toBeInTheDocument();
  fireEvent.change(search, { target: { value: '不存在' } });
  expect(screen.queryByRole('article')).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('0 / 4 个地区');
  expect(screen.getByText('没有匹配的国家或地区')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '清除筛选' }));
  expect(search).toHaveValue('');
  expect(screen.getAllByRole('article')).toHaveLength(4);
  const shortcuts = screen.getByRole('group', { name: '常用地区' });
  expect(within(shortcuts).queryByRole('button', { name: '香港' })).not.toBeInTheDocument();
  fireEvent.click(within(shortcuts).getByRole('button', { name: '日本' }));
  expect(screen.getAllByRole('article')).toHaveLength(1);
  expect(screen.getByRole('button', { name: '日本', pressed: true })).toBeInTheDocument();
  expect(screen.getByText('暂无折算')).toBeInTheDocument();
  expect(screen.queryByText('最低')).not.toBeInTheDocument();
  fireEvent.click(within(shortcuts).getByRole('button', { name: '全部' }));
  expect(screen.getAllByRole('article')).toHaveLength(4);
  const stale = screen.getByRole('article', { name: '印度官方价格' });
  expect(within(stale).getByText('待更新')).toBeInTheDocument();
  expect(within(stale).queryByText('最低')).not.toBeInTheDocument();
});

test('reopening remembers the selected product and plan without reloading and refresh keeps a valid selection', async () => {
  const value = { ...catalog, apps: [catalog.apps[1], { ...catalog.apps[2], plans: [
    catalog.apps[2].plans[0], { ...catalog.apps[2].plans[0], id: 'notion-year', period: 'P1Y' },
  ] }] };
  const fetcher = respondWith(value);
  render(<OfficialReference />); open();
  fireEvent.click(await screen.findByRole('button', { name: 'Notion' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Notion Plus · 每年' }));
  fireEvent.click(screen.getByRole('button', { name: '关闭官网正价参考' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '官网正价参考' })).toHaveFocus();
  open();
  expect(screen.getByRole('button', { name: 'Notion', pressed: true })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'Notion Plus · 每年', selected: true })).toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockResolvedValueOnce(Response.json({ ...value, apps: value.apps.map(app => ({ ...app, plans: app.plans.map(plan => ({
    ...plan, prices: [{ ...price, cnyAmount: 99.5 }],
  })) })) }));
  fireEvent.click(screen.getByRole('button', { name: '刷新参考价' }));
  expect(await screen.findByRole('tab', { name: 'Notion Plus · 每年', selected: true })).toBeInTheDocument();
  expect(screen.getByText('99.50')).toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledTimes(2);
  fetcher.mockResolvedValueOnce(Response.json(catalog));
  fireEvent.click(screen.getByRole('button', { name: '刷新参考价' }));
  expect(await screen.findByRole('tab', { name: 'Notion Plus · 每月', selected: true })).toBeInTheDocument();
  fetcher.mockResolvedValueOnce(Response.json({ ...catalog, apps: [catalog.apps[1]] }));
  fireEvent.click(screen.getByRole('button', { name: '刷新参考价' }));
  expect(await screen.findByRole('button', { name: 'ChatGPT', pressed: true })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'ChatGPT Plus · 每月', selected: true })).toBeInTheDocument();
});

const manyPlans = [
  monthly,
  { ...monthly, id: 'plus-month-2', name: 'ChatGPT Plus #2', prices: [{ ...price, cnyAmount: 125.25 }] },
  catalog.apps[1].plans[2],
  { ...monthly, id: 'pro-month', name: 'ChatGPT Pro' },
  { ...monthly, id: 'plus-quarter', period: 'P3M' },
  { ...monthly, id: 'unknown-period', name: 'Special subscription', period: null },
  { ...monthly, id: 'credits-100', name: '100 credits', kind: 'purchase', period: null },
  { ...monthly, id: 'credits-1000', name: '1000 credits', kind: 'purchase', period: null },
];
function respondWithManyPlans() {
  return respondWith({ ...catalog, apps: [{ ...catalog.apps[1], plans: manyPlans }, catalog.apps[2]] });
}

test('a large plan catalog opens grouped choices and preserves distinct SKUs when selecting', async () => {
  const fetcher = respondWithManyPlans();
  render(<OfficialReference />); open();
  const trigger = await screen.findByRole('button', { name: /切换套餐/ });
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(trigger).toHaveTextContent('ChatGPT Plus · 每月');
  expect(screen.queryByRole('region', { name: 'ChatGPT全部套餐' })).not.toBeInTheDocument();
  const prices = screen.getByRole('region', { name: 'ChatGPT Plus · 每月' });
  prices.scrollTop = 150;
  fireEvent.click(trigger);
  const choices = screen.getByRole('region', { name: 'ChatGPT全部套餐' });
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  expect(within(choices).getAllByRole('button')).toHaveLength(8);
  expect(within(screen.getByRole('group', { name: '月付' })).getAllByRole('button')).toHaveLength(3);
  expect(within(screen.getByRole('group', { name: '月付' })).getByRole('button', { name: 'ChatGPT Plus · 每月' }).textContent).toBe('ChatGPT Plus');
  expect(within(screen.getByRole('group', { name: '年付' })).getByRole('button', { name: 'ChatGPT Plus · 每年' })).toBeInTheDocument();
  expect(within(screen.getByRole('group', { name: '每3个月' })).getByRole('button', { name: 'ChatGPT Plus · 每3个月' })).toBeInTheDocument();
  expect(within(screen.getByRole('group', { name: '周期未注明' })).getByRole('button', { name: 'Special subscription' })).toBeInTheDocument();
  expect(within(screen.getByRole('group', { name: '一次性购买' })).getAllByRole('button')).toHaveLength(2);
  expect(within(choices).getByRole('button', { name: 'ChatGPT Plus · 每月', pressed: true })).toHaveFocus();
  fireEvent.click(within(choices).getByRole('button', { name: 'ChatGPT Plus #2 · 每月' }));
  expect(screen.queryByRole('region', { name: 'ChatGPT全部套餐' })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(trigger).toHaveTextContent('ChatGPT Plus #2 · 每月');
  expect(screen.getByText('125.25')).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'ChatGPT Plus #2 · 每月' }).scrollTop).toBe(0);
  fireEvent.click(trigger);
  expect(screen.getByRole('button', { name: 'ChatGPT Plus #2 · 每月', pressed: true })).toHaveFocus();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('Escape dismisses only the plan picker and outside clicks preserve the selection', async () => {
  respondWithManyPlans(); render(<OfficialReference />); open();
  const trigger = await screen.findByRole('button', { name: /切换套餐/ });
  fireEvent.click(trigger);
  expect(fireEvent.keyDown(document.activeElement, { key: 'Escape' })).toBe(false);
  expect(screen.queryByRole('region', { name: 'ChatGPT全部套餐' })).not.toBeInTheDocument();
  expect(screen.getByRole('dialog', { name: '官网正价参考' })).toBeInTheDocument();
  expect(trigger).toHaveFocus();
  fireEvent.click(trigger);
  fireEvent.pointerDown(screen.getByRole('heading', { name: '官网正价参考' }));
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(screen.getByText('139.93')).toBeInTheDocument();
  fireEvent.click(trigger);
  fireEvent.click(trigger);
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

test('WebKit focus parking on the dialog must not dismiss the picker before a tap selects a plan', async () => {
  respondWithManyPlans(); render(<OfficialReference />); open();
  const trigger = await screen.findByRole('button', { name: /切换套餐/ });
  fireEvent.click(trigger);
  const choices = screen.getByRole('region', { name: 'ChatGPT全部套餐' });
  const option = within(choices).getByRole('button', { name: 'ChatGPT Plus #2 · 每月' });
  // iOS/WebKit 在 touchend 后把焦点停在 <dialog> 上而不是按钮；该 focusin 不是用户移动焦点，不能收起
  fireEvent.focusIn(screen.getByRole('dialog', { name: '官网正价参考' }));
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  fireEvent.click(option);
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(trigger).toHaveTextContent('ChatGPT Plus #2 · 每月');
});

test('switching products resets the picker and tabbing outside dismisses it without stealing focus', async () => {
  const fetcher = respondWithManyPlans(); render(<OfficialReference />); open();
  let trigger = await screen.findByRole('button', { name: /切换套餐/ });
  fireEvent.click(trigger);
  const product = screen.getByRole('button', { name: 'Notion' });
  act(() => product.focus());
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(product).toHaveFocus();
  fireEvent.click(trigger);
  fireEvent.click(product);
  expect(screen.queryByRole('region', { name: 'ChatGPT全部套餐' })).not.toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'Notion Plus · 每月', selected: true })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'ChatGPT' }));
  trigger = screen.getByRole('button', { name: /切换套餐/ });
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(trigger).toHaveTextContent('ChatGPT Plus · 每月');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('only fresh converted prices share the lowest badge while stale and unknown prices stay explicit', async () => {
  const prices = [
    { ...price, country: 'in', countryName: '印度', cnyAmount: 28.57, stale: true },
    { ...price, country: 'ph', countryName: '菲律宾', cnyAmount: 33.12 },
    { ...price, country: 'br', countryName: '巴西', cnyAmount: 33.12 },
    { ...price, country: 'jp', countryName: '日本', cnyAmount: null, currency: 'JPY', formatted: '¥3,000' },
  ];
  respondWith({ ...catalog, apps: [{ ...catalog.apps[1], plans: [{ ...monthly, prices }] }] });
  render(<OfficialReference />); open();
  const india = await screen.findByRole('article', { name: '印度官方价格' });
  expect(within(india).getByText('待更新')).toBeInTheDocument();
  expect(within(india).queryByText('最低')).not.toBeInTheDocument();
  expect(within(screen.getByRole('article', { name: '菲律宾官方价格' })).getByText('最低')).toBeInTheDocument();
  expect(within(screen.getByRole('article', { name: '巴西官方价格' })).getByText('最低')).toBeInTheDocument();
  const japan = screen.getByRole('article', { name: '日本官方价格' });
  expect(within(japan).getByText('暂无折算')).toBeInTheDocument();
  expect(within(japan).getByText('¥3,000')).toBeInTheDocument();
  expect(within(japan).queryByText('最低')).not.toBeInTheDocument();
  expect(screen.getAllByRole('article').map(card => card.getAttribute('aria-label'))).toEqual(['印度官方价格', '菲律宾官方价格', '巴西官方价格', '日本官方价格']);
});

test('an entirely stale snapshot never advertises a lowest price', async () => {
  respondWith({ ...catalog, apps: [{ ...catalog.apps[1], plans: [{ ...monthly, prices: [{ ...price, stale: true }] }] }] });
  render(<OfficialReference />); open();
  expect(await screen.findByText('待更新')).toBeInTheDocument();
  expect(screen.queryByText('最低')).not.toBeInTheDocument();
});

test('all supported regions render decorative local SVG flags instead of platform emoji', async () => {
  const countries = REFERENCE_REGIONS.map(([country]) => country);
  const prices = countries.map(country => ({ ...price, country, countryName: country.toUpperCase() }));
  respondWith({ ...catalog, apps: [{ ...catalog.apps[1], plans: [{ ...monthly, prices }] }] });
  render(<OfficialReference />); open();
  await screen.findByRole('article', { name: 'US官方价格' });
  for (const country of countries) {
    const card = screen.getByRole('article', { name: country.toUpperCase() + '官方价格' });
    const flag = card.querySelector('img');
    expect(flag).not.toBeNull();
    const source = flag.getAttribute('src');
    if (source.startsWith('data:image/svg+xml,')) {
      expect(decodeURIComponent(source)).toContain('flag-icons-' + country);
    } else {
      expect(source).toContain('/reference-flags/' + country + '.svg');
      expect(new URL(source, window.location.origin).origin).toBe(window.location.origin);
    }
    expect(flag).toHaveAttribute('alt', '');
    expect(flag).toHaveAttribute('aria-hidden', 'true');
  }
});

test('software-only listings do not take the default selection or display free download prices', async () => {
  respondWith({ ...catalog, apps: [
    { ...catalog.apps[0], name: 'Spotify', plans: [catalog.apps[1].plans[0]] },
    catalog.apps[1],
  ] });
  render(<OfficialReference />); open();
  expect(await screen.findByRole('button', { name: 'ChatGPT', pressed: true })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Spotify' })).not.toBeInTheDocument();
  expect(screen.queryByText('0.00')).not.toBeInTheDocument();
});

test('products with only unpriced plans are hidden until comparable prices exist', async () => {
  respondWith({ ...catalog, apps: [
    { ...catalog.apps[0], name: 'Spotify', plans: [{ ...monthly, prices: [] }] },
    catalog.apps[1],
  ] });
  render(<OfficialReference />); open();
  await screen.findByRole('button', { name: 'ChatGPT', pressed: true });
  expect(screen.queryByRole('button', { name: 'Spotify' })).not.toBeInTheDocument();
});

test('Spotify appears when its catalog contains a priced subscription', async () => {
  respondWith({ ...catalog, apps: [{ ...catalog.apps[0], name: 'Spotify', plans: [{ ...monthly, name: 'Spotify Premium' }] }] });
  render(<OfficialReference />); open();
  expect(await screen.findByRole('button', { name: 'Spotify', pressed: true })).toBeInTheDocument();
  expect(screen.getByText('139.93')).toBeInTheDocument();
});

test('a catalog containing only free downloads shows no product choices', async () => {
  respondWith({ ...catalog, apps: [{ ...catalog.apps[0], name: 'Spotify', plans: [catalog.apps[1].plans[0]] }] });
  render(<OfficialReference />); open();
  expect(await screen.findByText('暂无已采集价格', { exact: true })).toBeInTheDocument();
  expect(screen.queryByRole('group', { name: '选择产品' })).not.toBeInTheDocument();
  expect(screen.queryByText('0.00')).not.toBeInTheDocument();
});

test.each([
  ['P1M', '每月'], ['P1Y', '每年'], ['P1W', '每周'],
  ['P3M', '每3个月'], ['P6M', '每6个月'], ['P12M', '每12个月'], ['P2Y', '每2年'],
  ['P1D', '每天'], ['P2W', '每2周'], ['自定义周期', '自定义周期'],
])('subscription period %s labels the tab and price panel without a repeated heading', async (period, label) => {
  respondWith({ ...catalog, apps: [{ ...catalog.apps[1], plans: [{ ...monthly, period }] }] });
  render(<OfficialReference />); open();
  expect(await screen.findByRole('tab', { name: 'ChatGPT Plus · ' + label, selected: true })).toBeInTheDocument();
  const panel = screen.getByRole('tabpanel', { name: 'ChatGPT Plus · ' + label });
  expect(within(panel).getByRole('article', { name: '美国官方价格' })).toBeInTheDocument();
  expect(within(panel).queryByRole('heading')).not.toBeInTheDocument();
});

test('Claude tiers and billing periods remain separate with no repeated English cadence', async () => {
  const plans = [
    ['Claude Max 5x - Monthly', 'P1M'],
    ['Claude Max 20x - Monthly', 'P1M'],
    ['Claude Pro - Annual', 'P1Y'],
    ['Claude Pro - Monthly', 'P1M'],
  ].map(([name, period], index) => ({ ...monthly, id: 'claude-' + index, name, period }));
  respondWith({ ...catalog, apps: [{ ...catalog.apps[1], name: 'Claude', plans }] });
  render(<OfficialReference />); open();
  await screen.findByRole('tablist', { name: 'Claude套餐' });
  expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual([
    'Claude Max 5x · 每月', 'Claude Max 20x · 每月', 'Claude Pro · 每年', 'Claude Pro · 每月',
  ]);
  fireEvent.click(screen.getByRole('tab', { name: 'Claude Pro · 每年' }));
  expect(screen.getByRole('tabpanel', { name: 'Claude Pro · 每年' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: 'Claude Pro · 每月' }));
  expect(screen.getByRole('tabpanel', { name: 'Claude Pro · 每月' })).toBeInTheDocument();
});

test.each([
  ['Claude Pro - Monthly #2', 'P1M', 'subscription', 'Claude Pro #2 · 每月'],
  ['Pro – Yearly', 'P1Y', 'subscription', 'Pro · 每年'],
  ['Notion – Plus Monthly', 'P1M', 'subscription', 'Notion – Plus · 每月'],
  ['Notion – Plus Yearly', 'P1Y', 'subscription', 'Notion – Plus · 每年'],
  ['Canva Business - Yearly #2', 'P1Y', 'subscription', 'Canva Business #2 · 每年'],
  ['Canva Pro+ – Mensal', 'P1M', 'subscription', 'Canva Pro+ · 每月'],
  ['Canva可画团队版-按年付费', 'P1Y', 'subscription', 'Canva可画团队版 · 每年'],
  ['Canva可画高级版 - 按月付费', 'P1M', 'subscription', 'Canva可画高级版 · 每月'],
  ['Canva可画高级版 - 按月付费', 'P1Y', 'subscription', 'Canva可画高级版 · 每年'],
  ['ChatGPT Plus', 'P1M', 'subscription', 'ChatGPT Plus · 每月'],
  ['Google AI Pro (5 TB) #2', 'P1M', 'subscription', 'Google AI Pro (5 TB) #2 · 每月'],
  ['YouTube Premium Family', 'P1M', 'subscription', 'YouTube Premium Family · 每月'],
  ['Super Duolingo - Family Plan', 'P1Y', 'subscription', 'Super Duolingo - Family Plan · 每年'],
  ['Annual Review', 'P1Y', 'subscription', 'Annual Review · 每年'],
  ['Claude Pro - Monthly', null, 'subscription', 'Claude Pro - Monthly'],
  ['Claude Pro - Monthly', 'P3M', 'subscription', 'Claude Pro · 每3个月'],
  ['Pro - Monthly', '官方自定义周期', 'subscription', 'Pro - Monthly · 官方自定义周期'],
  ['Monthly Credits', null, 'purchase', 'Monthly Credits'],
])('plan label preserves distinguishing text for %s (%s)', async (name, period, kind, label) => {
  respondWith({ ...catalog, apps: [{ ...catalog.apps[1], plans: [{ ...monthly, name, period, kind }] }] });
  render(<OfficialReference />); open();
  expect(await screen.findByRole('tab', { name: label, selected: true })).toBeInTheDocument();
});

test('unknown subscription periods remain unspecified instead of being guessed as monthly', async () => {
  respondWith({ ...catalog, apps: [{ ...catalog.apps[1], plans: [{ ...monthly, period: null }] }] });
  render(<OfficialReference />); open();
  expect(await screen.findByRole('tab', { name: 'ChatGPT Plus', selected: true })).toBeInTheDocument();
  expect(screen.getByRole('tabpanel', { name: 'ChatGPT Plus' })).toBeInTheDocument();
  expect(screen.queryByText('每月')).not.toBeInTheDocument();
});

test('pending catalogs show loading and closing cancels the request and restores focus', async () => {
  let signal;
  vi.stubGlobal('fetch', vi.fn((_url, options) => { signal = options.signal; return new Promise(() => {}); }));
  document.body.style.overflow = 'auto';
  render(<OfficialReference />); open();
  expect(screen.getByRole('status')).toHaveTextContent(/读取已采集价格/);
  expect(document.body.style.overflow).toBe('hidden');
  await waitFor(() => expect(signal).toBeDefined());
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
  expect(signal.aborted).toBe(true);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(document.body.style.overflow).toBe('auto');
  expect(screen.getByRole('button', { name: '官网正价参考' })).toHaveFocus();
});

test('late responses from a closed modal cannot overwrite a newly opened catalog', async () => {
  let resolveOld;
  vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockResolvedValueOnce(Response.json(catalog)));
  render(<OfficialReference />); open();
  fireEvent.click(screen.getByRole('button', { name: '关闭官网正价参考' }));
  open();
  expect(await screen.findByText('$19.99')).toBeInTheDocument();
  await act(async () => { resolveOld(Response.json({ ...catalog, apps: [] })); });
  expect(screen.getByText('$19.99')).toBeInTheDocument();
});

test('a failed catalog can retry the same snapshot endpoint', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 503 })).mockResolvedValueOnce(Response.json(catalog));
  vi.stubGlobal('fetch', fetcher); render(<OfficialReference />); open();
  expect(await screen.findByRole('alert')).toHaveTextContent(/暂时无法读取/);
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByText('$19.99')).toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test('a failed refresh hides the previous prices and retry restores the selected plan', async () => {
  const fetcher = respondWith();
  render(<OfficialReference />); open();
  fireEvent.click(await screen.findByRole('tab', { name: 'ChatGPT Plus · 每年' }));
  fetcher.mockRejectedValueOnce(new Error('offline'));
  fireEvent.click(screen.getByRole('button', { name: '刷新参考价' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/暂时无法读取/);
  expect(screen.queryByRole('article')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByRole('tab', { name: 'ChatGPT Plus · 每年', selected: true })).toBeInTheDocument();
  expect(screen.getByText('1,399.93')).toBeInTheDocument();
});

test('an empty catalog explains missing snapshots without inventing free prices', async () => {
  respondWith({ updatedAt: null, exchangeDate: null, apps: [] });
  render(<OfficialReference />); open();
  expect(await screen.findByText(/暂无已采集价格/)).toBeInTheDocument();
  expect(screen.queryByText('0.00')).not.toBeInTheDocument();
  expect(screen.queryByRole('tab')).not.toBeInTheDocument();
});

test('malformed catalog responses show a recoverable error instead of crashing', async () => {
  respondWith({ apps: [{ id: 'bad', name: 'Broken', plans: null }] });
  render(<OfficialReference />); open();
  expect(await screen.findByRole('alert')).toHaveTextContent(/暂时无法读取/);
  expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
});
