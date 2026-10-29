import { describe, expect, test, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PublicPage from './PublicPage.jsx';
import { VirtuosoMockContext } from 'react-virtuoso';
import React from 'react';

const virtualListEvents = vi.hoisted(() => ({ endReached: null, autoEndReached: false }));
vi.mock('react-virtuoso', async importOriginal => {
  const original = await importOriginal();
  return { ...original, Virtuoso: props => {
    virtualListEvents.endReached = props.endReached;
    return <original.VirtuosoMockContext.Provider value={{ viewportHeight: 900, itemHeight: 300 }}><original.Virtuoso {...props} endReached={virtualListEvents.autoEndReached ? props.endReached : undefined} /></original.VirtuosoMockContext.Provider>;
  } };
});

// jsdom has no window layout; drive the library event boundary explicitly.
// Browser smoke checks cover actual scrolling and bounded mounted card counts.
async function reachCatalogEnd() {
  await act(async () => virtualListEvents.endReached());
}

function jsonResponse(value, status = 200) {
  return Response.json(value, { status });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  virtualListEvents.endReached = null;
  virtualListEvents.autoEndReached = false;
});

test('shows IP instead of Microsoft and Apple navigation and requests the IP product group', async () => {
  const user = userEvent.setup();
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/analytics/collect') return new Response(null, { status: 204 });
    calls.push(url);
    return jsonResponse({ total: 1, platformFacets: ['microsoft', 'apple', 'ip', 'email'], tagFacets: [],
      items: [{ id: 'ip-product', name: '住宅 IP', platform: 'network', offers: [] }] });
  }));
  render(<PublicPage />);
  await screen.findByRole('heading', { name: /住宅 IP/ });
  const tabs = within(screen.getByRole('group', { name: '商品平台' }));
  expect(tabs.queryByRole('button', { name: 'Microsoft' })).not.toBeInTheDocument();
  expect(tabs.queryByRole('button', { name: 'Apple' })).not.toBeInTheDocument();
  expect(tabs.getByRole('button', { name: '邮箱' })).toBeInTheDocument();
  await user.click(tabs.getByRole('button', { name: 'IP', exact: true }));
  await waitFor(() => expect(calls.some(url => url.pathname === '/api/catalog' && url.searchParams.get('platform') === 'ip')).toBe(true));
  expect(tabs.getByRole('button', { name: 'IP', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test.each(['x', 'cursor'])('old %s bookmarks select the combined Grok / X / Cursor navigation', async platform => {
  window.history.replaceState({}, '', `/?platform=${platform}`);
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/analytics/collect') return new Response(null, { status: 204 });
    calls.push(url);
    return jsonResponse({
      total: 1, platformFacets: ['x', 'cursor'], tagFacets: [], items: [{ id: 'x-product', name: 'X 商品', platform: 'x', offers: [] }],
    });
  }));
  render(<PublicPage />);
  await screen.findByRole('heading', { name: /X 商品/ });
  const tabs = within(screen.getByRole('group', { name: '商品平台' }));
  expect(tabs.getByRole('button', { name: 'Grok / X / Cursor', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(tabs.queryByRole('button', { name: 'Cursor', exact: true })).not.toBeInTheDocument();
  expect(tabs.queryByRole('button', { name: 'X/Twitter', exact: true })).not.toBeInTheDocument();
  expect(tabs.queryByRole('button', { name: 'github', exact: true })).not.toBeInTheDocument();
  await waitFor(() => expect(calls.at(-1)?.searchParams.get('platform')).toBe('xai'));
});

test('keeps platform, sorting and filters together and expands a nonmodal desktop panel', async () => {
  const user = userEvent.setup();
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ total: 387, offerTotal: 5876, platformFacets: ['openai'], tagFacets: [{ name: 'access', value: 'dedicated' }], items: [{ id: '1', name: '桌面商品', offers: [] }] })));
  render(<PublicPage />);
  await screen.findByRole('heading', { name: /桌面商品/ });
  const toolbar = within(screen.getByRole('group', { name: '平台与排序' }));
  expect(toolbar.getByRole('button', { name: 'ChatGPT / Codex' })).toBeInTheDocument();
  expect(toolbar.getByRole('combobox', { name: '商品排序' })).toBeInTheDocument();
  expect(screen.queryByText(/个标准商品|条符合条件报价/)).not.toBeInTheDocument();
  const trigger = toolbar.getByRole('button', { name: '筛选', exact: true });
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await user.click(trigger);
  const panel = screen.getByRole('region', { name: '筛选报价' });
  expect(panel).not.toHaveAttribute('aria-modal');
  expect(within(panel).queryByRole('heading')).not.toBeInTheDocument();
  expect(within(panel).queryByRole('searchbox')).not.toBeInTheDocument();
  expect(within(panel).queryByRole('button', { name: '收起筛选' })).not.toBeInTheDocument();
  expect(panel).toHaveFocus();
  expect(screen.queryByRole('dialog', { name: '筛选报价' })).not.toBeInTheDocument();
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  within(panel).getByRole('button', { name: '应用筛选' }).focus();
  await user.tab();
  expect(panel.contains(document.activeElement)).toBe(false);
  await user.click(trigger);
  expect(screen.queryByRole('region', { name: '筛选报价' })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

test('mobile platform picker applies immediately, preserves search and sorting, and can return to all platforms', async () => {
  const user = userEvent.setup();
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  window.history.replaceState({}, '', '/?q=Plus&sort=price');
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = new URL(input, 'http://localhost');
    calls.push(url);
    return jsonResponse({ total: 1, platformFacets: ['openai', 'anthropic', 'google', 'xai', 'ip', 'email', 'other'], tagFacets: [], items: [{ id: '1', name: '手机平台商品', offers: [] }] });
  }));
  render(<PublicPage />);
  await screen.findByRole('heading', { name: /手机平台商品/ });
  expect(screen.queryByRole('group', { name: '商品平台' })).not.toBeInTheDocument();
  const trigger = screen.getByRole('button', { name: '选择平台：全部平台' });
  await user.click(trigger);
  const picker = within(screen.getByRole('dialog', { name: '选择平台' }));
  expect(picker.getByRole('button', { name: '全部平台' })).toHaveAttribute('aria-pressed', 'true');
  expect(picker.getAllByRole('button', { pressed: false })).toHaveLength(7);
  await user.click(picker.getByRole('button', { name: 'Grok / X / Cursor', exact: true }));
  expect(screen.queryByRole('dialog', { name: '选择平台' })).not.toBeInTheDocument();
  expect(trigger).toHaveAccessibleName('选择平台：Grok / X / Cursor');
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(trigger).toHaveFocus();
  await waitFor(() => expect(calls.some(url => url.pathname === '/api/catalog' && url.searchParams.get('platform') === 'xai' && url.searchParams.get('q') === 'Plus' && url.searchParams.get('sort') === 'price')).toBe(true));
  await user.click(trigger);
  expect(within(screen.getByRole('dialog', { name: '选择平台' })).getByRole('button', { name: 'Grok / X / Cursor', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await user.click(within(screen.getByRole('dialog', { name: '选择平台' })).getByRole('button', { name: '全部平台' }));
  expect(trigger).toHaveAccessibleName('选择平台：全部平台');
  await waitFor(() => expect(window.location.search).not.toContain('platform='));
});

test('mobile platform picker cancels without changing selection and closes when switching to desktop', async () => {
  const user = userEvent.setup();
  let onChange;
  const media = { matches: false, addEventListener: vi.fn((_name, listener) => { onChange = listener; }), removeEventListener: vi.fn() };
  vi.stubGlobal('matchMedia', vi.fn(() => media));
  window.history.replaceState({}, '', '/?platform=anthropic');
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ total: 1, platformFacets: ['openai', 'anthropic'], tagFacets: [], items: [{ id: '1', name: '手机平台商品', offers: [] }] })));
  render(<PublicPage />);
  await screen.findByRole('heading', { name: /手机平台商品/ });
  const trigger = screen.getByRole('button', { name: '选择平台：Claude' });
  await user.click(trigger);
  await user.click(screen.getByRole('button', { name: '关闭平台选择' }));
  expect(trigger).toHaveFocus();
  expect(trigger).toHaveAccessibleName('选择平台：Claude');
  await user.click(trigger);
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog', { name: '选择平台' })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  await user.click(trigger);
  await act(async () => { media.matches = true; onChange({ matches: true }); });
  expect(screen.queryByRole('dialog', { name: '选择平台' })).not.toBeInTheDocument();
  expect(within(screen.getByRole('group', { name: '商品平台' })).getByRole('button', { name: 'Claude' })).toHaveAttribute('aria-pressed', 'true');
  await act(async () => { media.matches = false; onChange({ matches: false }); });
  expect(screen.queryByRole('dialog', { name: '选择平台' })).not.toBeInTheDocument();
});

test('keeps a modal drawer on mobile and preserves draft choices across a breakpoint change', async () => {
  const user = userEvent.setup();
  let onChange;
  const media = { matches: false, addEventListener: vi.fn((_name, listener) => { onChange = listener; }), removeEventListener: vi.fn() };
  vi.stubGlobal('matchMedia', vi.fn(() => media));
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ total: 1, tagFacets: [{ name: 'access', value: 'dedicated' }], items: [{ id: '1', name: '手机商品', offers: [] }] })));
  render(<PublicPage />);
  await screen.findByRole('heading', { name: /手机商品/ });
  const trigger = screen.getByRole('button', { name: '筛选', exact: true });
  await user.click(trigger);
  expect(screen.getByRole('dialog', { name: '筛选报价' })).toHaveAttribute('aria-modal', 'true');
  expect(document.body.style.overflow).toBe('hidden');
  await user.click(screen.getByRole('checkbox', { name: /独享/ }));
  await act(async () => { media.matches = true; onChange({ matches: true }); });
  expect(screen.getByRole('region', { name: '筛选报价' })).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: /独享/ })).toBeChecked();
  expect(document.body.style.overflow).not.toBe('hidden');
  screen.getByRole('textbox', { name: '搜索商品' }).focus();
  await act(async () => { media.matches = false; onChange({ matches: false }); });
  const drawer = within(screen.getByRole('dialog', { name: '筛选报价' }));
  expect(screen.getByRole('dialog', { name: '筛选报价' })).toHaveFocus();
  expect(drawer.queryByRole('heading')).not.toBeInTheDocument();
  expect(drawer.queryByRole('searchbox')).not.toBeInTheDocument();
  const apply = drawer.getByRole('button', { name: '应用筛选（1）' });
  await user.tab({ shift: true });
  expect(apply).toHaveFocus();
  await user.tab();
  expect(drawer.getByRole('checkbox', { name: /独享/ })).toHaveFocus();
  await user.tab({ shift: true });
  expect(apply).toHaveFocus();
  await user.click(drawer.getByRole('button', { name: '取消筛选' }));
  expect(screen.queryByRole('dialog', { name: '筛选报价' })).not.toBeInTheDocument();
  expect(document.body.style.overflow).not.toBe('hidden');
  expect(trigger).toHaveFocus();
  await user.click(trigger);
  expect(screen.getByRole('checkbox', { name: /独享/ })).not.toBeChecked();
  expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  await user.keyboard('{Escape}');
});

test('keeps focus in quote details across a mobile breakpoint and resumes the draft drawer after closing', async () => {
  const user = userEvent.setup();
  let onChange;
  const media = { matches: true, addEventListener: vi.fn((_name, listener) => { onChange = listener; }), removeEventListener: vi.fn() };
  vi.stubGlobal('matchMedia', vi.fn(() => media));
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ tagFacets: [{ name: 'access', value: 'dedicated' }], items: [{ id: '1', name: '弹层商品', productCount: 2, offers: [] }] })));
  render(<PublicPage />);
  await screen.findByRole('heading', { name: /弹层商品/ });
  await user.click(screen.getByRole('button', { name: '筛选', exact: true }));
  await user.click(screen.getByRole('checkbox', { name: /独享/ }));
  await user.click(screen.getByRole('button', { name: '2 条报价' }));
  const closeDetails = screen.getByRole('button', { name: '关闭报价详情' });
  closeDetails.focus();
  await act(async () => { media.matches = false; onChange({ matches: false }); });
  expect(closeDetails).toHaveFocus();
  expect(screen.queryByRole('dialog', { name: '筛选报价' })).not.toBeInTheDocument();
  await user.keyboard('{Escape}');
  const drawer = within(screen.getByRole('dialog', { name: '筛选报价' }));
  expect(screen.getByRole('dialog', { name: '筛选报价' })).toHaveFocus();
  expect(drawer.getByRole('checkbox', { name: /独享/ })).toBeChecked();
  expect(document.body.style.overflow).toBe('hidden');
  await user.keyboard('{Escape}');
  expect(document.body.style.overflow).not.toBe('hidden');
});

test('applies desktop draft filters once while preserving keywords, purchase intent and platform', async () => {
  const user = userEvent.setup();
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async input => {
    if (String(input) === '/api/analytics/collect') return new Response(null, { status: 204 });
    calls.push(new URL(input, 'http://localhost'));
    return jsonResponse({ platformFacets: ['openai'], tagFacets: [{ name: 'access', value: 'dedicated' }, { name: 'duration', value: '1 month' }, { name: 'duration', value: '12 months' }], items: [{ id: '1', name: '组合条件商品', offers: [] }] });
  }));
  render(<PublicPage />);
  await screen.findByRole('heading', { name: /组合条件商品/ });
  await user.click(screen.getByRole('button', { name: 'ChatGPT / Codex' }));
  await user.type(screen.getByRole('textbox', { name: '搜索商品' }), 'ChatGPT Plus 已接码 质保至少30天');
  await waitFor(() => expect(calls.at(-1).searchParams.get('q')).toBe('ChatGPT Plus 已接码 质保至少30天'));
  await user.click(screen.getByRole('button', { name: '筛选', exact: true }));
  const panel = within(screen.getByRole('region', { name: '筛选报价' }));
  const catalogCalls = () => calls.filter(url => url.pathname === '/api/catalog' && url.searchParams.get('limit') === '20');
  const beforeSelection = catalogCalls().length;
  await user.click(panel.getByRole('checkbox', { name: /独享/ }));
  await user.click(panel.getByRole('checkbox', { name: '订阅时长：1个月' }));
  await user.click(panel.getByRole('checkbox', { name: '订阅时长：12个月' }));
  expect(catalogCalls()).toHaveLength(beforeSelection);
  await user.click(panel.getByRole('button', { name: '应用筛选（3）' }));
  await waitFor(() => expect(catalogCalls().at(-1).searchParams.getAll('tag')).toHaveLength(3));
  expect(catalogCalls()).toHaveLength(beforeSelection + 1);
  expect(catalogCalls().at(-1).searchParams.get('q')).toBe('ChatGPT Plus 已接码 质保至少30天');
  expect(catalogCalls().at(-1).searchParams.get('platform')).toBe('openai');
  expect(screen.getByLabelText('已选筛选条件')).toHaveTextContent('独享');
});

test('keeps desktop draft choices visible after changing the search and refreshing facets', async () => {
  const user = userEvent.setup();
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/analytics/collect') return new Response(null, { status: 204 });
    calls.push(url);
    return jsonResponse({ tagFacets: url.searchParams.get('q') ? [] : [{ name: 'access', value: 'dedicated' }], items: [{ id: '1', name: '搜索商品结果', offers: [] }] });
  }));
  render(<PublicPage />);
  await screen.findByRole('heading', { name: /搜索商品结果/ });
  await user.click(screen.getByRole('button', { name: '筛选', exact: true }));
  await user.click(screen.getByRole('checkbox', { name: /独享/ }));
  await user.type(screen.getByRole('textbox', { name: '搜索商品' }), 'Gemini');
  await waitFor(() => expect(calls.some(url => url.searchParams.get('q') === 'Gemini' && url.pathname === '/api/catalog/facets')).toBe(true));
  expect(await screen.findByRole('checkbox', { name: /独享/ })).toBeChecked();
  await user.click(screen.getByRole('button', { name: '应用筛选（1）' }));
  await waitFor(() => expect(calls.at(-1).searchParams.getAll('tag')).toEqual(['{"name":"access","value":"dedicated"}']));
  expect(calls.at(-1).searchParams.get('q')).toBe('Gemini');
});

test('dismisses quote details before the open desktop filter panel on Escape', async () => {
  const user = userEvent.setup();
  const item = { id: '42', name: '报价测试商品', productCount: 2, offers: [], offersTruncated: true };
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ items: [item], tagFacets: [{ name: 'access', value: 'dedicated' }] })));
  render(<PublicPage />);
  await screen.findByRole('heading', { name: /报价测试商品/ });
  await user.click(screen.getByRole('button', { name: '筛选', exact: true }));
  await user.click(screen.getByRole('checkbox', { name: /独享/ }));
  const details = screen.getByRole('button', { name: '2 条报价' });
  await user.click(details);
  expect(screen.getByRole('dialog', { name: /报价测试商品/ })).toBeInTheDocument();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('region', { name: '筛选报价' })).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: /独享/ })).toBeChecked();
  expect(details).toHaveFocus();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('region', { name: '筛选报价' })).not.toBeInTheDocument();
});

test('loads delivery facets independently, supports retry and keeps them alive when closing filters', async () => {
  const user = userEvent.setup();
  const calls = [];
  let attempts = 0;
  let resolveFacets;
  let signal;
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/analytics/collect') return new Response(null, { status: 204 });
    calls.push(url);
    if (url.pathname === '/api/catalog') return jsonResponse({ items: [{ id: '1', name: '立即展示的商品', offers: [] }], total: 1, tagFacets: [] });
    if (url.pathname === '/api/catalog/products') return jsonResponse({ items: [] });
    if (url.pathname === '/api/catalog/coverage') return jsonResponse({ shopCount: 10, productCount: 100 });
    attempts += 1;
    if (attempts === 1) return jsonResponse({}, 503);
    signal = init.signal;
    return new Promise(resolve => { resolveFacets = resolve; });
  }));
  render(<PublicPage />);
  await screen.findByRole('heading', { name: /立即展示的商品/ });
  expect(calls.filter(url => url.pathname === '/api/catalog')).toHaveLength(1);
  expect(calls.find(url => url.pathname === '/api/catalog').searchParams.has('facets')).toBe(false);
  await user.click(screen.getByRole('button', { name: '筛选' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('筛选条件加载失败');
  await user.click(screen.getByRole('button', { name: '重试筛选' }));
  expect(await screen.findByText('正在加载筛选条件…')).toHaveAttribute('role', 'status');
  await user.click(screen.getByRole('button', { name: '筛选', exact: true }));
  expect(signal.aborted).toBe(false);
  await act(async () => resolveFacets(jsonResponse({ tagFacets: [{ name: 'access', value: 'dedicated', priority: 2 }] })));
  expect(screen.queryByRole('region', { name: '筛选报价' })).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /立即展示的商品/ })).toBeInTheDocument();
});

test('keeps raw merchant values out of purchase filters and shows readable conditions in the panel', async () => {
  const user = userEvent.setup();
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ total: 1, items: [{ id: '1', name: 'ChatGPT Plus', offers: [] }], tagFacets: [
    { name: 'sms_verification', value: 'can be used twice', priority: 1 },
    { name: 'sms_verification', value: 'verified', priority: 10 },
    { name: 'duration', value: '100刀', priority: 2 },
    { name: 'duration', value: '30 days', priority: 5 },
    { name: 'access', value: '10-open', priority: 1 },
    { name: 'access', value: 'dedicated', priority: 7 },
  ] })));
  render(<PublicPage />);
  await screen.findByRole('heading', { name: /ChatGPT Plus/ });
  expect(screen.queryAllByRole('button', { name: /can be used twice|100刀|10-open/ })).toHaveLength(0);
  // A compact entry replaces the six rows of globally unrelated facet chips.
  expect(screen.queryByLabelText('常用购买条件')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '筛选' }));
  const drawer = within(screen.getByRole('region', { name: '筛选报价' }));
  expect(drawer.getByRole('checkbox', { name: /已接码/ })).toBeInTheDocument();
  expect(drawer.getByRole('checkbox', { name: /30天/ })).toBeInTheDocument();
  expect(drawer.getByText(/1 款 · \d+ 条报价/)).toHaveAttribute('role', 'status');
  expect(drawer.queryByRole('checkbox', { name: /条报价/ })).not.toBeInTheDocument();
  expect(drawer.queryByText(/can be used twice|100刀|10-open/)).not.toBeInTheDocument();
  await user.click(drawer.getByRole('checkbox', { name: /独享/ }));
  await user.click(drawer.getByRole('button', { name: '应用筛选（1）' }));
  expect(await screen.findByLabelText('已选筛选条件')).toHaveTextContent('独享');
});

test('loads full quotes with the current purchase filters when a summary card is opened', async () => {
  const user = userEvent.setup();
  const calls = [];
  const quote = { productId: '1', shopId: '1', name: '首条报价', shop: '商铺', price: '10', productUrl: 'https://example.com/1', independentShop: true, tags: [] };
  const item = { id: '42', name: 'ChatGPT Plus', shopCount: 1, productCount: 2, offers: [quote], offersTruncated: true };
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/analytics/collect') return new Response(null, { status: 204 });
    calls.push({ url, signal: init?.signal });
    return jsonResponse({ total: 1, items: [url.searchParams.has('standardProductId') ? { ...item, allOffers: [quote, { ...quote, productId: '2', name: '按需加载的报价' }], offersTruncated: false } : item], tagFacets: [] });
  }));
  render(<PublicPage />);
  await screen.findByRole('heading', { name: /ChatGPT Plus/ });
  const badge = screen.getByRole('button', { name: '自建站' });
  expect(badge).toHaveAttribute('title', '风险相对更高');
  await user.click(badge);
  expect(badge).toHaveTextContent(/^风险相对更高$/);
  expect(badge).toHaveAttribute('aria-expanded', 'true');
  await user.keyboard('{Escape}');
  expect(badge).toHaveTextContent(/^自建站$/);
  await user.keyboard(' ');
  expect(badge).toHaveTextContent(/^风险相对更高$/);
  await user.click(badge);
  expect(badge).toHaveTextContent(/^自建站$/);
  expect(calls.filter(call => call.url.pathname === '/api/catalog')).toHaveLength(1);
  expect(calls.find(call => call.url.pathname === '/api/catalog').url.searchParams.get('view')).toBe('summary');
  await user.type(screen.getByRole('textbox', { name: '搜索商品' }), 'Plus 已接码');
  await waitFor(() => expect(calls.at(-1).url.searchParams.get('q')).toBe('Plus 已接码'));
  await user.click(await screen.findByRole('button', { name: '2 条报价' }));
  expect(await within(screen.getByRole('dialog')).findByText('按需加载的报价')).toBeInTheDocument();
  const detail = screen.getByRole('dialog');
  expect(within(detail).getAllByRole('button', { name: '自建站' })).toHaveLength(2);
  await user.click(within(detail).getAllByRole('button', { name: '自建站' })[0]);
  await user.keyboard('{Escape}');
  expect(within(detail).getAllByRole('button', { name: '自建站' })).toHaveLength(2);
  expect(detail).toBeInTheDocument();
  expect(calls.at(-1).url.searchParams.get('standardProductId')).toBe('42');
  expect(calls.at(-1).url.searchParams.get('view')).toBe('full');
  expect(calls.at(-1).url.searchParams.get('q')).toBe('plus');
  expect(calls.at(-1).url.searchParams.getAll('tag')).toContain(JSON.stringify({ name: 'sms_verification', value: 'verified' }));
  expect(calls.at(-1).url.searchParams.get('searchMode')).toBe('literal');
  await user.click(screen.getByRole('button', { name: '关闭报价详情' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: '搜索商品' })).toHaveValue('Plus 已接码');
});

test('shows common durations first and keeps selected options visible after collapsing the full group', async () => {
  const user = userEvent.setup();
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ total: 0, items: [], tagFacets: Array.from({ length: 20 }, (_, index) => ({ name: 'duration', value: `${index + 1} days`, priority: 20 - index })) })));
  render(<PublicPage />);
  await user.click(screen.getByRole('button', { name: '筛选' }));
  const drawer = within(screen.getByRole('region', { name: '筛选报价' }));
  await waitFor(() => expect(drawer.getAllByRole('checkbox')).toHaveLength(3));
  await user.click(drawer.getByRole('button', { name: '更多期限（按天）' }));
  expect(drawer.getAllByRole('checkbox')).toHaveLength(20);
  await user.click(drawer.getByRole('checkbox', { name: /20天/ }));
  await user.click(drawer.getByRole('button', { name: '收起（按天）' }));
  expect(drawer.getAllByRole('checkbox')).toHaveLength(4);
  expect(drawer.getByRole('checkbox', { name: /20天/ })).toBeChecked();
});

test('retries failed quote details and ignores a response arriving after the dialog closes', async () => {
  const user = userEvent.setup();
  const item = { id: '42', name: 'ChatGPT Plus', productCount: 2, offers: [], offersTruncated: true };
  let attempts = 0;
  let resolveDetail;
  let detailSignal;
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/analytics/collect') return new Response(null, { status: 204 });
    if (!url.searchParams.has('standardProductId')) return jsonResponse({ items: [item], total: 1 });
    attempts += 1;
    if (attempts === 1) return jsonResponse({}, 503);
    detailSignal = init.signal;
    return new Promise(resolve => { resolveDetail = resolve; });
  }));
  render(<PublicPage />);
  await user.click(await screen.findByRole('button', { name: '2 条报价' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('报价加载失败');
  await user.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByRole('status')).toHaveTextContent('正在加载报价');
  await user.click(screen.getByRole('button', { name: '关闭报价详情' }));
  expect(detailSignal.aborted).toBe(true);
  await act(async () => resolveDetail(jsonResponse({ items: [{ ...item, allOffers: [] }] })));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /ChatGPT Plus/ })).toBeInTheDocument();
});

describe('PublicPage', () => {
  test('turns purchase intent into removable chips and keeps manual filters while editing keywords', async () => {
    const user = userEvent.setup();
    const calls = [];
    const quote = { productId: '1', shopId: '1', name: 'Plus 报价', shop: '店铺', price: '12.00', currency: 'CNY', productUrl: 'https://example.com/1', capturedAt: '2026-09-25T08:00:00Z', tags: [{ name: 'sms_verification', value: 'verified' }, { name: 'warranty', value: 'covered' }] };
    vi.stubGlobal('fetch', vi.fn(async input => {
      if (String(input) === '/api/analytics/collect') return new Response(null, { status: 204 });
    calls.push(new URL(input, 'http://localhost'));
      return jsonResponse({ total: 1, offerTotal: 1, platformFacets: ['openai'], tagFacets: [{ name: 'sms_verification', value: 'verified', priority: 1 }, { name: 'warranty', value: 'covered', priority: 1 }], items: [{ id: 'plus', name: 'ChatGPT Plus', platform: 'openai', offers: [quote], allOffers: [quote] }] });
    }));
    render(<PublicPage />);
    await screen.findByRole('heading', { name: /ChatGPT Plus/ });
    const input = screen.getByRole('textbox', { name: '搜索商品' });
    await user.type(input, 'ChatGPT Plus 已接码 质保至少30天');
    expect(await screen.findByRole('button', { name: '移除已接码' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '移除质保30天' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /移除已接码/ }));
    await waitFor(() => expect(input.value).not.toContain('已接码'));
    await user.click(screen.getByRole('button', { name: '筛选' }));
    await user.click(screen.getByRole('checkbox', { name: /已接码/ }));
    await user.click(screen.getByRole('button', { name: '应用筛选（1）' }));
    await waitFor(() => expect(calls.at(-1).searchParams.getAll('tag').some(value => JSON.parse(value).name === 'sms_verification')).toBe(true));
    await user.type(input, '  中转');
    await waitFor(() => expect(calls.at(-1).searchParams.getAll('tag').some(value => JSON.parse(value).name === 'sms_verification')).toBe(true));
  });

  test('shows readable purchase conditions in the drawer and renders offer facts', async () => {
    const user = userEvent.setup();
    const calls = [];
    const quote = { productId: '1', shopId: '1', name: 'Plus 报价', shop: '店铺', price: '12.00', currency: 'CNY', productUrl: 'https://example.com/1', capturedAt: '2026-09-25T08:00:00Z', tags: [{ name: 'sms_verification', value: 'verified' }, { name: 'warranty', value: 'covered' }, { name: 'intended_use', value: 'rapid' }] };
    vi.stubGlobal('fetch', vi.fn(async input => {
      const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/analytics/collect') return new Response(null, { status: 204 });
      calls.push(url);
      return jsonResponse({ total: 1, offerTotal: 1, platformFacets: ['openai'], tagFacets: [{ name: 'sms_verification', value: 'verified', priority: 8 }, { name: 'sms_verification', value: 'unverified', priority: 2 }, { name: 'warranty', value: 'covered', priority: 4 }], items: [{ id: 'plus', name: 'ChatGPT Plus', platform: 'openai', offers: [quote], allOffers: [quote] }], appliedQuery: { text: url.searchParams.get('q') || '', tags: [] } });
    }));
    render(<PublicPage />);
    await screen.findByRole('heading', { name: /ChatGPT Plus/ });
    const facts = within(screen.getByLabelText('商品标签'));
    expect(facts.getByText('已接码')).toBeInTheDocument();
    expect(facts.getByText('速刷')).toBeInTheDocument();
    expect(facts.getByText('有质保（时长未注明）')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '筛选' }));
    await user.click(screen.getByRole('checkbox', { name: /已接码/ }));
    await user.click(screen.getByRole('button', { name: '应用筛选（1）' }));
    await waitFor(() => expect(calls.at(-1).searchParams.getAll('tag').length).toBe(1));
  });

  test('offers explicit empty-state recovery when purchase conditions have no matches', async () => {
    const user = userEvent.setup();
    let requests = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      requests += 1;
      return jsonResponse({ total: 0, offerTotal: 0, platformFacets: ['openai'], tagFacets: [{ name: 'sms_verification', value: 'verified', priority: 0 }], items: [] });
    }));
    render(<PublicPage />);
    const input = screen.getByRole('textbox', { name: '搜索商品' });
    await user.type(input, 'ChatGPT Plus 已接码');
    expect(await screen.findByText('没有同时满足这些条件的报价')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '清除已识别条件' })).toHaveLength(2);
    await user.click(screen.getAllByRole('button', { name: '清除已识别条件' })[0]);
    await waitFor(() => expect(requests).toBeGreaterThan(1));
  });

  test('always loads the real catalog API, including when a demo query is present', async () => {
    const calls = [];
    window.history.replaceState({}, '', '/?demo');
    vi.stubGlobal('fetch', vi.fn(async input => {
      if (String(input) === '/api/analytics/collect') return new Response(null, { status: 204 }); calls.push(String(input));
      return jsonResponse({ total: 1, platformFacets: ['openai'], tagFacets: [], items: [{ id: 'real-1', name: '真实商品', platform: 'openai', shopCount: 1, productCount: 1, offers: [{ productId: '1', shopId: '1', name: '真实报价', shop: '真实商铺', price: '1.00', currency: 'CNY', productUrl: 'https://example.com/real', capturedAt: '2026-09-22T08:00:00Z', stale: false, inStock: true, tags: [] }] }] });
    }));
    try {
      render(<PublicPage />);
      expect(await screen.findByRole('heading', { name: /真实商品/ })).toBeInTheDocument();
      expect(calls.filter(url => url.startsWith('/api/catalog?'))).toHaveLength(1);
    } finally {
      window.history.replaceState({}, '', '/');
    }
  });

  test('collapses long platform lists and requests all other products through the catalog API', async () => {
    const user = userEvent.setup();
    const facets = ['CODEX', 'OpenAI', 'claude', 'Google', 'email', 'Gmail', 'Outlook', ...Array.from({ length: 190 }, (_, i) => `vendor-${i}`)];
    vi.stubGlobal('fetch', vi.fn(async input => {
      const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/analytics/collect') return new Response(null, { status: 204 });
      const other = url.searchParams.get('platform') === 'other';
      return jsonResponse({ total: other ? 190 : 193, platformFacets: facets, tagFacets: [], items: [{ id: other ? 'other' : 'known', name: other ? '其它平台商品' : '知名平台商品', platform: other ? 'vendor-189' : 'openai', offers: [] }] });
    }));
    render(<PublicPage />);
    await screen.findByRole('heading', { name: /知名平台商品/ });
    const tabs = within(screen.getByRole('group', { name: '商品平台' }));
    expect(tabs.getAllByRole('button').map(button => button.textContent)).toEqual(['全部', 'ChatGPT / Codex', 'Claude', 'Gemini / Google', '邮箱', '其它']);
    await user.click(tabs.getByRole('button', { name: '其它' }));
    await screen.findByRole('heading', { name: /其它平台商品/ });
    expect(tabs.getByRole('button', { name: '其它' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('190 个标准商品')).not.toBeInTheDocument();
    await user.click(tabs.getByRole('button', { name: 'ChatGPT / Codex' }));
    await screen.findByRole('heading', { name: /知名平台商品/ });
  });

  test('animates the refresh control while a catalog request is pending', async () => {
    const user = userEvent.setup();
    let resolveRefresh;
    let requestCount = 0;
    const catalog = { total: 1, platformFacets: ['openai'], tagFacets: [], items: [{ id: 'refresh-1', name: '待刷新商品', platform: 'openai', offers: [] }] };
    vi.stubGlobal('fetch', vi.fn(async input => {
      if (new URL(input, 'http://localhost').pathname !== '/api/catalog') return jsonResponse({ items: [] });
      requestCount += 1;
      if (requestCount === 1) return jsonResponse(catalog);
      return new Promise(resolve => { resolveRefresh = resolve; });
    }));

    render(<PublicPage />);
    expect(await screen.findByRole('heading', { name: /待刷新商品/ })).toBeInTheDocument();
    const refresh = screen.getByRole('button', { name: '刷新价格' });

    await user.click(refresh);
    expect(refresh).toHaveClass('is-refreshing');
    expect(refresh).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status', { name: '正在加载商品' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /待刷新商品/ })).not.toBeInTheDocument();
    expect(screen.queryByText('正在更新价格…')).not.toBeInTheDocument();

    await act(async () => resolveRefresh(jsonResponse(catalog)));
    await waitFor(() => expect(refresh).not.toHaveClass('is-refreshing'));
  });

  test('renders catalog interactions and submits a shop for review', async () => {
    const user = userEvent.setup();
    const calls = [];
    const catalog = {
      total: 25,
      platformFacets: ['个护清洁'],
      items: [
        {
          id: 'standard:1',
          name: '洗发水',
          platform: '个护清洁',
          offers: [
            { shop: '低价店', price: 9.9, productUrl: 'https://example.com/low', capturedAt: '2026-09-07 08:00:00', inStock: true },
            { shop: '第二店', price: 12, productUrl: 'https://example.com/2', capturedAt: '2026-09-07 08:01:00', inStock: true },
            { shop: '第三店', price: 13, productUrl: 'https://example.com/3', capturedAt: '2026-09-07 08:02:00', inStock: true },
            { shop: '第四店', price: 14, productUrl: 'https://example.com/4', capturedAt: '2026-09-07 08:03:00', inStock: true },
            { shop: '第五店', price: 15, productUrl: 'https://example.com/5', capturedAt: '2026-09-07 08:04:00', inStock: true },
            { shop: '第六店', price: 16, productUrl: 'https://example.com/6', capturedAt: '2026-09-07 08:05:00', inStock: true },
            { shop: '缺货店', price: 8, productUrl: 'https://example.com/out', capturedAt: '2026-09-07 08:06:00', inStock: false },
            { shop: '旧缺货店', price: 7, productUrl: 'https://example.com/out2', capturedAt: '2026-09-07 08:07:00', inStock: false },
          ],
        },
      ],
    };
    catalog.items[0].offers = catalog.items[0].offers.filter(offer => offer.inStock);
    catalog.items[0].offers.forEach((offer, index) => Object.assign(offer, { productId: index + 1, shopId: index + 1, name: `报价 ${index + 1}`, tags: [], priceStatus: 'verified', priceExpiresAt: '2099-01-01T00:00:00Z' }));
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      const url = new URL(input, 'http://localhost:3000');
      calls.push({ path: url.pathname + url.search, init, body: init?.body ? JSON.parse(init.body) : null });
      if (url.pathname === '/api/catalog') return jsonResponse(catalog);
      if (url.pathname === '/api/shop-submissions') return jsonResponse({ id: 1, status: 'pending' }, 201);
      return jsonResponse({ error: 'Not found' }, 404);
    }));

    render(<PublicPage />);

    expect(await screen.findByRole('heading', { name: /洗发水/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '其它' })).toBeInTheDocument();
    expect(screen.queryByText('已核验起价')).not.toBeInTheDocument();
    expect(screen.getAllByText('¥9.9')).toHaveLength(2);
    expect(screen.queryByText('25 个标准商品')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '6 家商铺' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '6 条报价' })).toBeInTheDocument();
    expect(screen.queryByText('查看全部 6 条报价')).not.toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: '去商家' }).map(link => link.href)).toEqual(['https://example.com/low', 'https://example.com/2', 'https://example.com/3', 'https://example.com/4']);
    expect(screen.getByLabelText('第 1 条报价')).toHaveClass('rank-1');
    expect(screen.getByLabelText('第 2 条报价')).toHaveClass('rank-2');
    expect(screen.getByLabelText('第 3 条报价')).toHaveClass('rank-3');
    expect(screen.getByLabelText('第 4 条报价')).toHaveClass('rank-4');

    await user.click(screen.getByRole('button', { name: '6 条报价' }));
    const quotes = within(screen.getByRole('dialog', { name: '洗发水 · 报价' }));
    expect(quotes.queryByRole('combobox', { name: '每页数量' })).not.toBeInTheDocument();
    expect(quotes.getByText('已显示全部 6 条报价')).toBeInTheDocument();
    expect(quotes.getAllByRole('link', { name: '去商家' })).toHaveLength(6);
    expect(quotes.getByText(/第六店/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '关闭报价详情' }));

    await user.click(screen.getByRole('button', { name: '6 家商铺' }));
    expect(screen.getByRole('dialog', { name: '洗发水 · 商铺' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '关闭商铺详情' }));

    await user.click(screen.getByRole('button', { name: '提交商铺' }));
    await user.type(screen.getByLabelText('商铺名称'), '新商铺');
    await user.type(screen.getByLabelText('商铺地址'), 'https://wzyp.cn/shop/new');
    await user.click(screen.getByRole('button', { name: '提交审核' }));
    expect(await screen.findByText('已提交审核')).toBeInTheDocument();
  const submitted = calls.find((call) => call.path === '/api/shop-submissions');
  expect(submitted.body).toEqual({ name: '新商铺', url: 'https://wzyp.cn/shop/new' });
});

test('explains when a shop submission is a duplicate', async () => {
  const user = userEvent.setup();
  vi.stubGlobal('fetch', vi.fn(async (input) => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/analytics/collect') return new Response(null, { status: 204 });
    if (url.pathname === '/api/shop-submissions') return jsonResponse({ error: { code: 'SHOP_SUBMISSION_EXISTS', message: '该商铺地址已提交' } }, 409);
    return jsonResponse({ items: [{ id: 'catalog-1', name: '商品', offers: [] }], total: 1 });
  }));

  render(<PublicPage />);
  await screen.findByRole('heading', { name: /商品/ });
  await user.click(screen.getByRole('button', { name: '提交商铺' }));
  await user.type(screen.getByLabelText('商铺名称'), '重复商铺');
  await user.type(screen.getByLabelText('商铺地址'), 'https://example.com/shop');
  await user.click(screen.getByRole('button', { name: '提交审核' }));
  expect(await screen.findByText('这个商铺已经提交过了，无需重复提交')).toBeInTheDocument();
});

test('shows one winning quote per shop on the product card', async () => {
  const quote = (productId, shopId, shop, price) => ({
    productId, shopId, shop, price, name: `${shop}报价`, productUrl: `https://example.com/${productId}`,
    capturedAt: '2026-09-23T08:00:00Z', inStock: true,
  });
  const catalog = {
    total: 1,
    platformFacets: ['openai'],
    tagFacets: [],
    items: [{
      id: 'sp-1', name: 'ChatGPT Free', platform: 'openai', shopCount: 2, productCount: 5,
      offers: [quote('a1', 'shop-a', '商铺 A', 1), quote('b1', 'shop-b', '商铺 B', 2)],
      allOffers: [quote('a1', 'shop-a', '商铺 A', 1), quote('a2', 'shop-a', '商铺 A', 1.1), quote('a3', 'shop-a', '商铺 A', 1.2), quote('a4', 'shop-a', '商铺 A', 1.3), quote('b1', 'shop-b', '商铺 B', 2)],
    }],
  };
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(catalog)));

  render(<PublicPage />);
  expect(await screen.findByRole('heading', { name: /ChatGPT 普通账号/ })).toBeInTheDocument();
  const tiles = screen.getAllByRole('link', { name: '去商家' }).map(link => link.closest('.shop-tile'));
  expect(tiles).toHaveLength(2);
  expect(tiles[0]).toHaveTextContent('商铺 A');
  expect(tiles[1]).toHaveTextContent('商铺 B');
});

test.each([
  ['openai / chatgpt_card_binding_service / standard', 'ChatGPT 绑卡服务'],
  ['openai / chatgpt_reauth_card / standard', 'ChatGPT 重新授权服务'],
])('renders the historical service name %s as a readable product link', async (name, expected) => {
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
    total: 1, platformFacets: ['openai'], tagFacets: [],
    items: [{ id: '42', name, platform: 'openai', offers: [] }],
  })));
  render(<PublicPage />);
  expect(await screen.findByRole('link', { name: expected })).toHaveAttribute('href', '/products/42?newcomer=false');
  expect(screen.queryByText(name)).not.toBeInTheDocument();
});

test('opens product details from the explicit card link and records the action', async () => {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/analytics/collect') {
      calls.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    }
    return jsonResponse({ total: 1, platformFacets: ['openai'], tagFacets: [], items: [{ id: '42', name: 'ChatGPT Plus', platform: 'openai', offers: [] }] });
  }));
  render(<PublicPage />);
  await screen.findByRole('heading', { name: /ChatGPT Plus/ });
  await waitFor(() => expect(calls.some(payload => payload.page === 'catalog')).toBe(true));
  await userEvent.click(within(screen.getByRole('heading', { name: /ChatGPT Plus/ })).getByRole('link'));
  expect(window.location.pathname).toBe('/products/42');
  expect(calls.flatMap(payload => payload.actions).some(action => action.name === 'product_detail')).toBe(true);
  window.history.replaceState({}, '', '/');
});

test('filters one standard product card by all selected tags', async () => {
    const user = userEvent.setup();
    const calls = [];
    const catalog = {
      platformFacets: ['ChatGPT', 'Gemini'],
      tagFacets: [
        { name: 'delivery', value: 'top_up' },
        { name: 'warranty_days', value: '25' },
      ],
      items: [{ id: 'chatgpt-plus', name: 'ChatGPT Plus', platform: 'ChatGPT', offers: [{ productId: 1, shopId: 1, name: '原始报价名', productUrl: 'https://example.com/1', shop: '店铺 A', price: 10, inStock: true, tags: [{ name: 'delivery', value: 'top_up' }, { name: 'warranty_days', value: '25' }] }] }],
    };
    vi.stubGlobal('fetch', vi.fn(async (input) => { if (String(input) === '/api/analytics/collect') return new Response(null, { status: 204 }); calls.push(String(input)); return jsonResponse(catalog); }));
    render(<PublicPage />);
    expect(await screen.findByRole('heading', { name: /ChatGPT Plus/ })).toBeInTheDocument();
    expect(screen.queryByText('交付方式：代充')).not.toBeInTheDocument();
    expect(screen.queryByText('质保时长：质保25天')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '筛选' }));
    await user.click(screen.getByRole('checkbox', { name: '交付方式：代充' }));
    await user.click(screen.getByRole('radio', { name: '按质保时长' }));
    await user.click(screen.getByRole('radio', { name: '自定义最低质保天数' }));
    await user.type(screen.getByRole('textbox', { name: '自定义最低质保天数' }), '25');
    await user.click(screen.getByRole('button', { name: '应用筛选（2）' }));
    await waitFor(() => expect(calls.some(path => {
      const selected = new URL(path, 'http://localhost').searchParams.getAll('tag').map(value => JSON.parse(value));
      return selected.length === 1 && selected.some(tag => tag.name === 'delivery' && tag.value === 'top_up') && new URL(path, 'http://localhost').searchParams.get('warrantyDaysMin') === '25';
    })).toBe(true));
    expect(screen.getByText('原始报价名')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Gemini / Google' }));
    await waitFor(() => expect(new URL(calls.at(-1), 'http://localhost').searchParams.get('platform')).toBe('google'));
    const switched = new URL(calls.at(-1), 'http://localhost').searchParams;
    expect(switched.getAll('tag').map(JSON.parse)).toEqual([{ name: 'delivery', value: 'top_up' }]);
    expect(switched.get('warrantyDaysMin')).toBe('25');
    await user.click(screen.getByRole('button', { name: '筛选（2）' }));
    expect(screen.getByRole('checkbox', { name: '交付方式：代充' })).toBeChecked();
    expect(screen.getByRole('textbox', { name: '自定义最低质保天数' })).toHaveValue('25');
  });

  test('shows the price disclaimer and lets users report a specific offer', async () => {
    const user = userEvent.setup();
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/analytics/collect') return new Response(null, { status: 204 });
      calls.push({ path: url.pathname, body: init?.body ? JSON.parse(init.body) : null });
      if (url.pathname === '/api/product-reports') return jsonResponse({ id: '8', status: 'pending' }, 201);
      return jsonResponse({ total: 1, platformFacets: ['openai'], tagFacets: [], items: [{ id: 'sp-1', name: 'ChatGPT Plus', platform: 'openai', offers: [{ productId: '42', shopId: '7', name: 'Plus 报价', shop: '可信店', price: '14.30', currency: 'CNY', independentShop: true, productUrl: 'https://example.com/plus', capturedAt: '2026-09-22T08:00:00Z', tags: [] }] }] });
    }));
    render(<PublicPage />);
    expect(await screen.findByText(/本站展示第三方商铺报价/)).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: '商品说明' }));
    expect(screen.getByRole('dialog', { name: 'Plus 报价' })).toHaveTextContent('自建站，风险相对更高');
    await user.click(within(screen.getByRole('dialog', { name: 'Plus 报价' })).getByRole('button', { name: '举报此报价' }));
    expect(screen.getByRole('dialog', { name: '举报此报价' })).toBeInTheDocument();
    const reportDialog = screen.getByRole('dialog', { name: '举报此报价' });
    await user.selectOptions(within(reportDialog).getByRole('combobox'), 'price_mismatch');
    await user.click(within(reportDialog).getByRole('button', { name: '提交举报' }));
    expect(await screen.findByText('举报已提交，我们会核查此报价')).toBeInTheDocument();
    expect(calls.find((call) => call.path === '/api/product-reports')?.body).toEqual({ productId: '42', reason: 'price_mismatch', details: '' });
  });
});

test('retains all SKU tag options and uses the server ranking after filtering', async () => {
  const user = userEvent.setup();
  const monthly = { name: 'duration', value: '1 month' };
  const yearly = { name: 'duration', value: '12 months' };
  const offer = (id, shop, price, tag) => ({ productId: id, shopId: shop, shop: `店铺${shop}`, name: `报价${id}`, spec: tag.value, price, inStock: true, tags: [tag], productUrl: `https://example.com/${id}` });
  vi.stubGlobal('fetch', vi.fn(async input => {
    const selected = new URL(input, 'http://localhost').searchParams.getAll('tag');
    return jsonResponse({ platformFacets: ['web'], tagFacets: [monthly, yearly], items: [{ id: 'product', name: 'Plus', offers: selected.length ? [offer(3, 2, 90, yearly), offer(2, 1, 100, yearly)] : [offer(1, 1, 10, monthly), offer(3, 2, 90, yearly)] }] });
  }));
  render(<PublicPage />);
  await screen.findByRole('heading', { name: /Plus/ });
  await user.click(screen.getByRole('button', { name: '筛选' }));
  await user.click(screen.getByRole('checkbox', { name: '订阅时长：12个月' }));
  await user.click(screen.getByRole('button', { name: '应用筛选（1）' }));
  await screen.findByText('报价2');
  const tiles = screen.getAllByRole('link', { name: '去商家' }).map(link => link.closest('.shop-tile'));
  expect(tiles).toHaveLength(2);
  expect(tiles[0]).toHaveTextContent('店铺2');
  expect(tiles[1]).toHaveTextContent('店铺1');
  expect(tiles[1]).toHaveTextContent('12个月');
  expect(screen.queryByText('报价1')).toBeNull();
  await user.click(screen.getByRole('button', { name: '筛选（1）' }));
  expect(screen.getByRole('checkbox', { name: '订阅时长：1个月' })).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: '订阅时长：12个月' })).toBeChecked();
});

test('pages whole products and aborts a superseded catalog request', async () => {
  const user = userEvent.setup();
  const calls = [];
  let finishOld;
  let oldSignal;
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/analytics/collect') return new Response(null, { status: 204 });
    calls.push(url);
    if (url.searchParams.get('cursor') === 'page-two') {
      oldSignal = init.signal;
      return new Promise(resolve => { finishOld = resolve; });
    }
    return jsonResponse({ platformFacets: ['web'], tagFacets: [], items: [{ id: 'one', name: 'Plus', offers: [] }], nextCursor: url.searchParams.get('q') ? null : 'page-two' });
  }));
  render(<VirtuosoMockContext.Provider value={{ viewportHeight: 600, itemHeight: 300 }}><PublicPage /></VirtuosoMockContext.Provider>);
  await screen.findByRole('heading', { name: /Plus/ });
  await reachCatalogEnd();
  await waitFor(() => expect(oldSignal).toBeTruthy());
  await user.type(screen.getByRole('textbox', { name: '搜索商品' }), 'Pro');
  await waitFor(() => expect(oldSignal.aborted).toBe(true));
  await act(async () => finishOld(jsonResponse({ items: [{ id: 'old', name: '过期页面', offers: [] }] })));
  expect(screen.queryByRole('heading', { name: '过期页面' })).not.toBeInTheDocument();
  const last = calls.filter(url => url.pathname === '/api/catalog').at(-1);
  expect(last.searchParams.has('cursor')).toBe(false);
  expect(last.searchParams.get('limit')).toBe('20');
});

test('hides aggregate totals and loads the next page when the virtual list reaches its end', async () => {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/analytics/collect') return new Response(null, { status: 204 });
    calls.push(url);
    if (url.searchParams.get('cursor')) return jsonResponse({ total: 25, items: [{ id: 'second', name: '第二页商品', offers: [] }] });
    return jsonResponse({ total: 25, items: [{ id: 'first', name: '第一页商品', offers: [] }], nextCursor: 'next-page' });
  }));
  render(<VirtuosoMockContext.Provider value={{ viewportHeight: 600, itemHeight: 300 }}><PublicPage /></VirtuosoMockContext.Provider>);
  await screen.findByRole('heading', { name: /第一页商品/ });
  await reachCatalogEnd();
  await screen.findByRole('heading', { name: /第二页商品/ });
  expect(screen.queryByText(/个标准商品|条符合条件报价/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '查看全部商品' })).not.toBeInTheDocument();
  expect(calls.at(-1).searchParams.get('cursor')).toBe('next-page');
  expect(calls.at(-1).searchParams.get('limit')).toBe('20');
});

test('uses the earliest expiry across loaded infinite-query pages', async () => {
  const firstExpiry = new Date(Date.now() + 1500).toISOString();
  const secondExpiry = new Date(Date.now() + 60000).toISOString();
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/analytics/collect') return new Response(null, { status: 204 });
    calls.push(url);
    const next = Boolean(url.searchParams.get('cursor'));
    return jsonResponse({ items: [{ id: next ? 'second-expiry' : 'first-expiry', name: next ? '第二页到期商品' : '第一页到期商品', offers: [] }],
      nextCursor: next ? null : 'expiry-page-two', nextExpiryAt: next ? secondExpiry : firstExpiry });
  }));
  render(<VirtuosoMockContext.Provider value={{ viewportHeight: 600, itemHeight: 300 }}><PublicPage /></VirtuosoMockContext.Provider>);
  await screen.findByRole('heading', { name: /第一页到期商品/ });
  await reachCatalogEnd();
  await screen.findByRole('heading', { name: /第二页到期商品/ });
  const firstPageCalls = () => calls.filter(url => url.pathname === '/api/catalog' && url.searchParams.get('limit') === '20' && !url.searchParams.has('cursor'));
  expect(firstPageCalls()).toHaveLength(1);
  await waitFor(() => expect(firstPageCalls().length).toBeGreaterThan(1), { timeout: 3000 });
});

test('automatically fills the viewport when the initial page contains one short product', async () => {
  virtualListEvents.autoEndReached = true;
  const fetchMock = vi.fn(async input => {
    const next = new URL(input, 'http://localhost').searchParams.has('cursor');
    return jsonResponse({ items: [{ id: next ? 'second' : 'first', name: next ? '自动续页商品' : '首屏短商品', offers: [] }], nextCursor: next ? null : 'short-next' });
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<PublicPage />);
  await screen.findByRole('heading', { name: /自动续页商品/ });
  expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/catalog?'))).toHaveLength(2);
});

test('appends pages without requesting the same next cursor twice', async () => {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/analytics/collect') return new Response(null, { status: 204 });
    calls.push(url);
    if (url.searchParams.get('cursor')) return jsonResponse({ items: [{ id: 'second', name: '第二页商品', offers: [] }], nextCursor: 'next-page' });
    return jsonResponse({ items: [{ id: 'first', name: '第一页商品', offers: [] }], nextCursor: 'next-page' });
  }));
  render(<VirtuosoMockContext.Provider value={{ viewportHeight: 600, itemHeight: 300 }}><PublicPage /></VirtuosoMockContext.Provider>);
  await screen.findByRole('heading', { name: /第一页商品/ });
  await reachCatalogEnd();
  await screen.findByRole('heading', { name: /第二页商品/ });
  expect(screen.getByRole('heading', { name: /第一页商品/ })).toBeInTheDocument();
  await reachCatalogEnd();
  expect(calls.filter(url => url.pathname === '/api/catalog')).toHaveLength(2);
});

test('requests globally sorted pages without downloading the full catalog', async () => {
  const user = userEvent.setup();
  const calls = [];
  const offer = (id, price) => ({ productId: id, shopId: id, shop: `商铺${id}`, name: `报价${id}`, price, currency: 'CNY', productUrl: `https://example.com/${id}`, capturedAt: '2026-09-09T08:00:00Z', tags: [] });
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/analytics/collect') return new Response(null, { status: 204 });
    calls.push(url);
    if (url.searchParams.get('sort') === 'price') return jsonResponse({ total: 2, platformFacets: ['web'], tagFacets: [], items: [{ id: 'low', name: '低价商品', platform: 'web', offers: [offer('low', 10)] }], nextCursor: 'sorted-next-page' });
    return jsonResponse({ total: 2, platformFacets: ['web'], tagFacets: [], items: [{ id: 'high', name: '高价商品', platform: 'web', offers: [offer('high', 20)] }], nextCursor: 'next-page' });
  }));
  render(<PublicPage />);
  expect(await screen.findByRole('heading', { name: /高价商品/ })).toBeInTheDocument();
  await user.selectOptions(screen.getByRole('combobox', { name: '商品排序' }), 'price');
  expect(await screen.findByRole('heading', { name: /低价商品/ })).toBeInTheDocument();
  expect(calls.at(-1).searchParams.get('sort')).toBe('price');
  expect(calls.at(-1).searchParams.get('limit')).toBe('20');
  expect(calls.filter(url => url.pathname === '/api/catalog')).toHaveLength(2);
});

test('sorts recent products by the newest offer, not the cheapest offer', async () => {
  const user = userEvent.setup();
  const offer = (id, price, capturedAt) => ({ productId: id, shopId: id, shop: `商铺${id}`, name: `报价${id}`, price, currency: 'CNY', productUrl: `https://example.com/${id}`, capturedAt, tags: [] });
  const items = [
    { id: 'old', name: '旧商品', platform: 'web', offers: [offer('old-low', 1, '2026-09-01T08:00:00Z')], allOffers: [offer('old-low', 1, '2026-09-01T08:00:00Z'), offer('old-new', 20, '2026-09-02T08:00:00Z')] },
    { id: 'recent', name: '新商品', platform: 'web', offers: [offer('recent-low', 2, '2026-09-01T08:00:00Z')], allOffers: [offer('recent-low', 2, '2026-09-01T08:00:00Z'), offer('recent-new', 30, '2026-09-10T08:00:00Z')] },
  ];
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/analytics/collect') return new Response(null, { status: 204 });
    calls.push(url);
    return jsonResponse({ total: 2, platformFacets: ['web'], tagFacets: [], items: url.searchParams.get('sort') === 'updated' ? [...items].reverse() : items });
  }));
  render(<PublicPage />);
  await screen.findByRole('heading', { name: /旧商品/ });
  await user.selectOptions(screen.getByRole('combobox', { name: '商品排序' }), 'updated');
  await waitFor(() => {
    const headings = screen.getAllByRole('heading').map((heading) => heading.textContent);
    expect(headings.findIndex((heading) => heading.includes('新商品'))).toBeLessThan(headings.findIndex((heading) => heading.includes('旧商品')));
  });
  expect(calls.at(-1).searchParams.get('sort')).toBe('updated');
});

test('keeps platform tabs available while a platform switch request is loading', async () => {
  const user = userEvent.setup();
  let releaseSwitched;
  const switched = new Promise(resolve => { releaseSwitched = resolve; });
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/analytics/collect') return new Response(null, { status: 204 });
    if (url.pathname !== '/api/catalog') return jsonResponse({});
    if (url.searchParams.get('platform')) {
      await switched;
      return jsonResponse({ total: 1, platformFacets: ['openai', 'google'], tagFacets: [], items: [{ id: 'openai-item', name: 'OpenAI 商品', platform: 'openai', offers: [] }] });
    }
    return jsonResponse({ total: 2, platformFacets: ['openai', 'google'], tagFacets: [], items: [{ id: 'all-item', name: '全部商品', platform: 'openai', offers: [] }] });
  }));
  render(<PublicPage />);
  await screen.findByRole('heading', { name: /全部商品/ });
  const toolbar = within(screen.getByRole('group', { name: '平台与排序' }));
  expect(toolbar.getByRole('button', { name: 'Gemini / Google' })).toBeInTheDocument();
  await user.click(toolbar.getByRole('button', { name: 'ChatGPT / Codex' }));
  // While the switched response is pending, the tabs stay and the list blanks behind the skeleton.
  expect(toolbar.getByRole('button', { name: 'Gemini / Google' })).toBeInTheDocument();
  expect(screen.getByRole('status', { name: '正在加载商品' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: /全部商品/ })).not.toBeInTheDocument();
  releaseSwitched();
  await screen.findByRole('heading', { name: /OpenAI 商品/ });
  expect(toolbar.getByRole('button', { name: 'Gemini / Google' })).toBeInTheDocument();
  expect(screen.queryByRole('status', { name: '正在加载商品' })).not.toBeInTheDocument();
});
