import React from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VirtuosoMockContext } from 'react-virtuoso';
import PublicPage from './PublicPage.jsx';

// Drive batch loading explicitly; real scrolling is verified in the browser.
vi.mock('react-virtuoso', async importOriginal => {
  const original = await importOriginal();
  return { ...original, Virtuoso: props => <original.Virtuoso {...props} endReached={undefined} /> };
});

const tags = [{ name: 'access', value: 'dedicated' }, { name: 'duration', value: '1 month' }];
const offers = Array.from({ length: 15 }, (_, i) => ({ productId: String(i + 1), shopId: String(i % 2 + 1), shop: i % 2 ? '乙店' : '甲店', name: `报价${i + 1}`, spec: '完整规格：独享、月付、含售后', price: String(i + 10), currency: 'CNY', productUrl: `https://example.com/${i + 1}`, tags, capturedAt: '2026-10-02T00:00:00Z' }));
const item = { id: '42', name: 'ChatGPT Plus', platform: 'openai', shopCount: 2, productCount: 15, offers: offers.slice(0, 4) };
let requests;
beforeEach(() => {
  requests = [];
  vi.unstubAllGlobals();
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/analytics/collect') return new Response(null, { status: 204 });
    requests.push(url);
    if (url.pathname.endsWith('/facets')) return Response.json({ tagFacets: tags });
    if (url.searchParams.has('standardProductId')) {
      if (url.searchParams.get('shopQuery') === '不存在' || url.searchParams.get('q') === '不存在') return Response.json({ items: [], total: 0, offerTotal: 0 });
      const page = Number(url.searchParams.get('detailPage') || 0);
      const pageSize = Number(url.searchParams.get('detailPageSize') || 4);
      const entries = url.searchParams.get('detailKind') === 'shops'
        ? [{ key: '1', name: '甲店', count: 8, offer: offers[0] }, { key: '2', name: '乙店', count: 7, offer: offers[1] }]
        : url.searchParams.has('shopId') ? [offers[0]] : offers.slice(page * pageSize, (page + 1) * pageSize);
      return Response.json({ items: [{ ...item, detail: { page, pageSize, total: url.searchParams.get('detailKind') === 'shops' ? 2 : url.searchParams.has('shopId') ? 1 : 15, entries } }], total: 1, offerTotal: 15 });
    }
    return Response.json({ items: [item], total: 1, offerTotal: url.searchParams.has('tag') ? 7 : 15, platformFacets: ['openai', 'google'] });
  }));
});
function mount() {
  return render(<VirtuosoMockContext.Provider value={{ viewportHeight: 3000, itemHeight: 300 }}><PublicPage /></VirtuosoMockContext.Provider>);
}

test('detail search and sort apply directly while filter drafts stay isolated', async () => {
  mount();
  fireEvent.click(await screen.findByRole('button', { name: '15 条报价' }));
  const dialog = within(screen.getByRole('dialog'));
  await dialog.findByText('报价12');
  expect(dialog.queryByRole('button', { name: '查询', exact: true })).not.toBeInTheDocument();
  expect(dialog.queryByRole('spinbutton', { name: '最低价格' })).not.toBeInTheDocument();
  fireEvent.click(dialog.getByRole('button', { name: '筛选', exact: true }));
  fireEvent.change(dialog.getByRole('spinbutton', { name: '最低价格' }), { target: { value: '1.111' } });
  fireEvent.click(await dialog.findByRole('checkbox', { name: /独享/ }));
  fireEvent.change(dialog.getByRole('textbox', { name: '搜索商铺或报价' }), { target: { value: '甲店' } });
  await waitFor(() => expect(requests.some(url => url.searchParams.get('q') === '甲店' && url.searchParams.has('detailKind'))).toBe(true));
  fireEvent.change(dialog.getByRole('combobox', { name: '报价排序' }), { target: { value: 'updated' } });
  await waitFor(() => expect(requests.filter(url => url.searchParams.has('detailKind')).at(-1).searchParams.get('offerSort')).toBe('updated'));
  const params = requests.filter(url => url.searchParams.has('detailKind')).at(-1).searchParams;
  expect(params.has('priceMin')).toBe(false);
  expect(params.has('tag')).toBe(false);
  fireEvent.click(dialog.getByRole('button', { name: /应用筛选/ }));
  expect(dialog.getByRole('alert')).toHaveTextContent('最多两位小数');
  fireEvent.change(dialog.getByRole('spinbutton', { name: '最低价格' }), { target: { value: '10' } });
  fireEvent.click(dialog.getByRole('button', { name: /应用筛选/ }));
  await waitFor(() => expect(dialog.getByRole('button', { name: '筛选（2）' })).toBeInTheDocument());
  fireEvent.click(dialog.getByRole('button', { name: '筛选（2）' }));
  fireEvent.click(dialog.getByRole('button', { name: '清除全部', exact: true }));
  expect(dialog.getByRole('button', { name: '筛选（2）' })).toBeInTheDocument();
  fireEvent.keyDown(dialog.getByRole('region', { name: '筛选报价' }), { key: 'Escape' });
  fireEvent.click(dialog.getByRole('button', { name: '筛选（2）' }));
  expect(dialog.getByRole('spinbutton', { name: '最低价格' })).toHaveValue(10);
  fireEvent.click(dialog.getByRole('button', { name: '清除全部', exact: true }));
  fireEvent.click(dialog.getByRole('button', { name: /应用筛选/ }));
  await waitFor(() => expect(dialog.getByRole('button', { name: '筛选', exact: true })).toBeInTheDocument());
  expect(dialog.getByRole('textbox', { name: '搜索商铺或报价' })).toHaveValue('甲店');
  expect(dialog.getByRole('combobox', { name: '报价排序' })).toHaveValue('updated');
});

test('homepage Enter searches immediately without a second debounced request and ignores IME Enter', async () => {
  mount();
  await screen.findByRole('heading', { name: /ChatGPT Plus/ });
  const input = screen.getByRole('textbox', { name: '搜索商品' });
  fireEvent.change(input, { target: { value: '即时查询' } });
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
  expect(requests.some(url => url.searchParams.get('q') === '即时查询')).toBe(false);
  await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
  expect(requests.some(url => url.searchParams.get('q') === '即时查询')).toBe(true);
  await act(async () => new Promise(resolve => setTimeout(resolve, 300)));
  expect(requests.filter(url => url.pathname === '/api/catalog' && url.searchParams.get('q') === '即时查询')).toHaveLength(1);
});

test('modal reset clears applied filters, invalid drafts, pagination and a pending search in one click', async () => {
  window.history.replaceState({}, '', '/?' + new URLSearchParams({ q: 'Plus', tag: JSON.stringify(tags[0]), warrantyDaysMin: '30' }));
  mount();
  fireEvent.click(await screen.findByRole('button', { name: '15 条报价' }));
  const dialog = within(screen.getByRole('dialog'));
  await dialog.findByText('报价12');
  fireEvent.change(dialog.getByRole('combobox', { name: '报价排序' }), { target: { value: 'updated' } });
  fireEvent.click(dialog.getByRole('button', { name: '筛选（2）' }));
  fireEvent.change(dialog.getByRole('spinbutton', { name: '最低价格' }), { target: { value: '10' } });
  fireEvent.click(dialog.getByRole('button', { name: /应用筛选/ }));
  await waitFor(() => expect(dialog.getByRole('button', { name: '加载更多报价' })).toBeEnabled());
  fireEvent.click(await dialog.findByRole('button', { name: '加载更多报价' }));
  await dialog.findByText('报价15');
  fireEvent.change(dialog.getByRole('textbox', { name: '搜索商铺或报价' }), { target: { value: '不存在' } });
  fireEvent.click(dialog.getByRole('button', { name: '筛选（3）' }));
  fireEvent.change(dialog.getByRole('spinbutton', { name: '最低价格' }), { target: { value: '1.111' } });
  fireEvent.click(dialog.getByRole('button', { name: /应用筛选/ }));
  expect(dialog.getByRole('alert')).toBeInTheDocument();
  await act(async () => fireEvent.click(dialog.getByRole('button', { name: '重置', exact: true })));
  expect(dialog.getByRole('textbox', { name: '搜索商铺或报价' })).toHaveValue('');
  expect(dialog.getByRole('combobox', { name: '报价排序' })).toHaveValue('price');
  expect(dialog.queryByRole('navigation', { name: '报价分页' })).not.toBeInTheDocument();
  expect(dialog.queryByRole('region', { name: '筛选报价' })).not.toBeInTheDocument();
  await dialog.findByText('报价12');
  await act(async () => new Promise(resolve => setTimeout(resolve, 300)));
  expect(requests.some(url => url.searchParams.get('q') === '不存在')).toBe(false);
  const params = requests.filter(url => url.searchParams.has('detailKind')).at(-1).searchParams;
  expect(params.get('q')).toBe('');
  expect(params.has('priceMin')).toBe(false);
  expect(params.has('tag')).toBe(false);
  expect(params.has('warrantyDaysMin')).toBe(false);
  fireEvent.click(dialog.getByRole('button', { name: '筛选', exact: true }));
  expect(dialog.getByRole('spinbutton', { name: '最低价格' })).toHaveValue(null);
  expect(await dialog.findByRole('checkbox', { name: /独享/ })).not.toBeChecked();
  expect(dialog.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: '搜索商品' })).toHaveValue('Plus');
});

test('reset scrolls an unchanged first-page modal back to the top', async () => {
  mount();
  fireEvent.click(await screen.findByRole('button', { name: '15 条报价' }));
  const modal = screen.getByRole('dialog');
  await within(modal).findByText('报价12');
  const list = modal.querySelector('.detail-scroll');
  list.scrollTop = 180;
  fireEvent.click(within(modal).getByRole('button', { name: '重置', exact: true }));
  expect(list.scrollTop).toBe(0);
});

test('restores URL filters, preserves them across platform clicks and follows browser history', async () => {
  const params = new URLSearchParams({ q: 'Plus', platform: 'openai', sort: 'price', tag: JSON.stringify(tags[0]) });
  window.history.replaceState(null, '', '/?' + params);
  mount();
  await screen.findByRole('heading', { name: /ChatGPT Plus/ });
  expect(screen.getByRole('textbox', { name: '搜索商品' })).toHaveValue('Plus');
  expect(screen.getByRole('combobox', { name: '商品排序' })).toHaveValue('price');
  fireEvent.click(screen.getByRole('button', { name: 'ChatGPT / Codex', exact: true }));
  expect(screen.getByLabelText('已选筛选条件')).toHaveTextContent('独享');
  fireEvent.click(screen.getByRole('button', { name: 'Gemini / Google', exact: true }));
  await waitFor(() => expect(new URLSearchParams(window.location.search).get('platform')).toBe('google'));
  expect(screen.getByLabelText('已选筛选条件')).toHaveTextContent('独享');
  act(() => { window.history.replaceState(null, '', '/?q=Gemini'); window.dispatchEvent(new PopStateEvent('popstate')); });
  expect(screen.getByRole('textbox', { name: '搜索商品' })).toHaveValue('Gemini');
  expect(screen.queryByLabelText('已选筛选条件')).not.toBeInTheDocument();
});

test('previews draft filter result count before applying it', async () => {
  mount();
  fireEvent.click(await screen.findByRole('button', { name: '筛选', exact: true }));
  fireEvent.click(await screen.findByRole('checkbox', { name: /独享/ }));
  expect(await screen.findByText('1 款 · 7 条报价')).toBeInTheDocument();
  expect(screen.queryByLabelText('已选筛选条件')).not.toBeInTheDocument();
});

test('filters the complete quote query but resets conditions and pagination when reopened', async () => {
  mount();
  fireEvent.click(await screen.findByRole('button', { name: '15 条报价' }));
  const dialog = within(screen.getByRole('dialog', { name: /ChatGPT Plus/ }));
  await dialog.findByText('报价12');
  fireEvent.change(dialog.getByRole('textbox', { name: '搜索商铺或报价' }), { target: { value: '甲店 独享' } });
  fireEvent.submit(dialog.getByRole('form', { name: '详情查询' }));
  fireEvent.click(dialog.getByRole('button', { name: '筛选', exact: true }));
  fireEvent.change(dialog.getByRole('spinbutton', { name: '最低价格' }), { target: { value: '10' } });
  fireEvent.change(dialog.getByRole('spinbutton', { name: '最高价格' }), { target: { value: '20' } });
  fireEvent.click(dialog.getByRole('button', { name: /应用筛选/ }));
  await waitFor(() => expect(requests.some(url => !url.searchParams.has('shopQuery') && url.searchParams.get('priceMin') === '10' && url.searchParams.get('priceMax') === '20' && url.searchParams.get('q') === '甲店 独享')).toBe(true));
  fireEvent.change(dialog.getByRole('combobox', { name: '报价排序' }), { target: { value: 'updated' } });

  await waitFor(() => expect(requests.at(-1).searchParams.get('offerSort')).toBe('updated'));
  fireEvent.click(dialog.getByRole('button', { name: '筛选（1）' }));
  await waitFor(() => expect(requests.some(url => url.pathname.endsWith('/facets') && url.searchParams.get('q') === '甲店 独享' && url.searchParams.get('priceMin') === '10' && url.searchParams.get('priceMax') === '20')).toBe(true));
  fireEvent.click(await dialog.findByRole('checkbox', { name: /独享/ }));
  expect(dialog.getAllByRole('textbox')).toHaveLength(1);
  fireEvent.click(dialog.getByRole('button', { name: /应用筛选/ }));
  await waitFor(() => expect(dialog.getByRole('button', { name: '筛选（2）' })).toBeInTheDocument());
  fireEvent.click(await dialog.findByRole('button', { name: '加载更多报价' }));
  await dialog.findByText('报价15');
  fireEvent.click(dialog.getByRole('button', { name: '关闭报价详情' }));
  fireEvent.click(screen.getByRole('button', { name: '15 条报价' }));
  const reopened = within(screen.getByRole('dialog'));
  expect(await reopened.findByText('报价12')).toBeInTheDocument();
  expect(reopened.queryByRole('navigation', { name: '报价分页' })).not.toBeInTheDocument();
  expect(reopened.getByRole('textbox', { name: '搜索商铺或报价' })).toHaveValue('');
  expect(reopened.queryByRole('spinbutton', { name: '最低价格' })).not.toBeInTheDocument();
  expect(reopened.queryByRole('spinbutton', { name: '最高价格' })).not.toBeInTheDocument();
  expect(reopened.getByRole('combobox', { name: '报价排序' })).toHaveValue('price');
  expect(reopened.getByRole('button', { name: '筛选', exact: true })).toBeInTheDocument();
  expect(reopened.queryByRole('spinbutton', { name: '跳转页码' })).not.toBeInTheDocument();
  fireEvent.click(reopened.getByRole('button', { name: '筛选', exact: true }));
  expect(reopened.getByRole('spinbutton', { name: '最低价格' })).toHaveValue(null);
  expect(reopened.getByRole('spinbutton', { name: '最高价格' })).toHaveValue(null);
});

test('opens a shop quote list, recovers from an empty filter and reopens the full shop list', async () => {
  mount();
  fireEvent.click(await screen.findByRole('button', { name: '2 家商铺' }));
  fireEvent.click(await within(screen.getByRole('dialog')).findByRole('button', { name: /甲店/ }));
  await waitFor(() => expect(requests.some(url => url.searchParams.get('shopId') === '1' && url.searchParams.get('detailKind') === 'offers')).toBe(true));
  expect(await within(screen.getByRole('dialog')).findByText('报价1')).toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox', { name: '搜索商铺或报价' }), { target: { value: '不存在' } });
  fireEvent.change(screen.getByRole('combobox', { name: '报价排序' }), { target: { value: 'updated' } });
  fireEvent.submit(within(screen.getByRole('dialog')).getByRole('form', { name: '详情查询' }));
  expect(await screen.findByText('没有匹配的报价')).toBeInTheDocument();
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '重置', exact: true }));
  expect(await within(screen.getByRole('dialog')).findByText('报价1')).toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: '报价排序' })).toHaveValue('price');
  expect(screen.getByRole('textbox', { name: '搜索商铺或报价' })).toHaveValue('');
  expect(within(screen.getByRole('dialog')).getByRole('heading')).toHaveTextContent('甲店');
  expect(within(screen.getByRole('dialog')).queryByText('报价2')).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox', { name: '搜索商铺或报价' }), { target: { value: '甲店' } });
  fireEvent.submit(within(screen.getByRole('dialog')).getByRole('form', { name: '详情查询' }));
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: '2 家商铺' }));
  const reopened = within(screen.getByRole('dialog', { name: 'ChatGPT Plus · 商铺' }));
  expect(await reopened.findByRole('button', { name: /乙店/ })).toBeInTheDocument();
  expect(reopened.getByRole('textbox', { name: '搜索商铺或报价' })).toHaveValue('');
  expect(reopened.queryByRole('combobox', { name: '每页数量' })).not.toBeInTheDocument();
  expect(reopened.queryByRole('button', { name: '← 返回商铺列表' })).not.toBeInTheDocument();
});

test('shows offer information without expansion and compares up to three offers', async () => {
  const user = userEvent.setup();
  mount();
  await screen.findByRole('heading', { name: /ChatGPT Plus/ });
  expect(screen.getByText('报价1')).toHaveAttribute('title', '报价1');
  expect(screen.queryByRole('button', { name: /展开报价|收起报价/ })).not.toBeInTheDocument();
  expect(screen.getAllByRole('link', { name: '去商家' })[0]).toHaveAttribute('href', 'https://example.com/1');
  const choices = screen.getAllByRole('checkbox', { name: /对比报价/ });
  await user.click(choices[0]); await user.click(choices[1]); await user.click(choices[2]);
  expect(choices[3]).toBeDisabled();
  await user.click(screen.getByRole('button', { name: '对比（3）' }));
  const comparison = within(screen.getByRole('dialog', { name: '报价对比' }));
  expect(comparison.getByRole('table')).toHaveTextContent('独享');
  expect(comparison.getByRole('table')).toHaveTextContent('1个月');
  expect(comparison.getByRole('rowheader', { name: '价格', exact: true })).toBeInTheDocument();
  expect(comparison.queryByRole('rowheader', { name: '来源标价' })).not.toBeInTheDocument();
  await user.click(comparison.getByRole('button', { name: '移除报价1' }));
  expect(comparison.queryByText('报价1')).not.toBeInTheDocument();
});

test('shop search uses shop names and Escape dismisses only the condition popover', async () => {
  const user = userEvent.setup();
  mount();
  await user.click(await screen.findByRole('button', { name: '2 家商铺' }));
  const detail = screen.getByRole('dialog');
  const dialog = within(detail);
  await dialog.findByRole('button', { name: /甲店/ });
  expect(dialog.queryByRole('textbox', { name: '搜索报价' })).not.toBeInTheDocument();
  await user.type(dialog.getByRole('textbox', { name: '搜索商铺或报价' }), '甲店{Enter}');
  await waitFor(() => expect(requests.some(url => url.searchParams.get('detailKind') === 'shops' && url.searchParams.get('q') === '甲店' && url.searchParams.get('searchMode') === 'literal' && !url.searchParams.has('shopQuery'))).toBe(true));
  const trigger = dialog.getByRole('button', { name: '筛选', exact: true });
  await user.click(trigger);
  await dialog.findByRole('checkbox', { name: /独享/ });
  await user.keyboard('{Escape}');
  expect(dialog.queryByRole('region', { name: '筛选报价' })).not.toBeInTheDocument();
  expect(detail).toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

test.each(['offers', 'shops'])('opening %s inherits list filters and restores them when reopened', async kind => {
  window.history.replaceState(null, '', '/?' + new URLSearchParams({ q: 'Plus 已接码', platform: 'openai', tag: JSON.stringify(tags[0]), warrantyDaysMin: '30' }));
  const matching = { ...offers[0], name: 'Plus 匹配报价', shop: '匹配店', tags: [...tags, { name: 'sms_verification', value: 'verified' }, { name: 'warranty_days', value: '30' }] };
  const excluded = { ...offers[1], name: 'Plus 未匹配报价', shop: '未匹配店', tags: [] };
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname !== '/api/catalog') return new Response(null, { status: 204 });
    requests.push(url);
    const filtered = url.searchParams.getAll('tag').includes(JSON.stringify(tags[0])) && url.searchParams.get('warrantyDaysMin') === '30';
    const selected = filtered ? [matching] : [matching, excluded];
    const entries = url.searchParams.get('detailKind') === 'shops'
      ? selected.map(offer => ({ key: offer.shopId, name: offer.shop, count: 1, offer })) : selected;
    return Response.json({ items: [{ ...item, shopCount: selected.length, productCount: selected.length, offers: selected,
      ...(url.searchParams.has('detailKind') ? { detail: { total: entries.length, entries } } : {}) }], total: 1, platformFacets: ['openai'] });
  }));
  mount();
  const trigger = kind === 'shops' ? '1 家商铺' : '1 条报价';
  fireEvent.click(await screen.findByRole('button', { name: trigger }));
  const dialog = within(screen.getByRole('dialog'));
  expect(await dialog.findByText(kind === 'shops' ? '匹配店' : 'Plus 匹配报价')).toBeInTheDocument();
  expect(dialog.queryByText(kind === 'shops' ? '未匹配店' : 'Plus 未匹配报价')).not.toBeInTheDocument();
  expect(dialog.getByRole('textbox', { name: '搜索商铺或报价' })).toHaveValue('plus');
  expect(dialog.getByRole('button', { name: '筛选（3）' })).toBeInTheDocument();
  await waitFor(() => {
    const params = requests.filter(url => url.searchParams.has('detailKind')).at(-1).searchParams;
    expect(params.get('q')).toBe('plus');
    expect(params.getAll('tag')).toEqual([JSON.stringify(tags[0]), '{"name":"sms_verification","value":"verified"}']);
    expect(params.get('warrantyDaysMin')).toBe('30');
    expect(params.get('platform')).toBe('openai');
    expect(params.get('standardProductId')).toBe('42');
    expect(params.get('currency')).toBe('CNY');
  });
  fireEvent.click(dialog.getByRole('button', { name: /^筛选/ }));
  fireEvent.click(dialog.getByRole('button', { name: '清除全部', exact: true }));
  fireEvent.click(dialog.getByRole('button', { name: /应用筛选/ }));
  expect(await dialog.findByText(kind === 'shops' ? '未匹配店' : 'Plus 未匹配报价')).toBeInTheDocument();
  fireEvent.click(dialog.getByRole('button', { name: kind === 'shops' ? '关闭商铺详情' : '关闭报价详情' }));
  expect(screen.getByRole('textbox', { name: '搜索商品' })).toHaveValue('Plus 已接码');
  expect(screen.getByLabelText('已选筛选条件')).toHaveTextContent('独享');
  expect(screen.getByLabelText('已选筛选条件')).toHaveTextContent('至少30天');
  fireEvent.click(screen.getByRole('button', { name: trigger }));
  const reopened = within(screen.getByRole('dialog'));
  expect(await reopened.findByText(kind === 'shops' ? '匹配店' : 'Plus 匹配报价')).toBeInTheDocument();
  expect(reopened.queryByText(kind === 'shops' ? '未匹配店' : 'Plus 未匹配报价')).not.toBeInTheDocument();
  expect(reopened.getByRole('button', { name: '筛选（3）' })).toBeInTheDocument();
});

test.each([['20', '10'], ['-1', ''], ['', '1.111']])('rejects invalid amount bounds %s to %s without querying', async (minimum, maximum) => {
  mount();
  fireEvent.click(await screen.findByRole('button', { name: '15 条报价' }));
  const dialog = within(screen.getByRole('dialog'));
  await dialog.findByText('报价12');
  fireEvent.click(dialog.getByRole('button', { name: '筛选', exact: true }));
  fireEvent.change(dialog.getByRole('spinbutton', { name: '最低价格' }), { target: { value: minimum } });
  fireEvent.change(dialog.getByRole('spinbutton', { name: '最高价格' }), { target: { value: maximum } });
  fireEvent.click(dialog.getByRole('button', { name: /应用筛选/ }));
  expect(dialog.getByRole('alert')).toBeInTheDocument();
  expect(requests.filter(url => url.searchParams.has('detailKind'))).toHaveLength(1);
});

test('paginated offers request CNY-only prices and apply an upper-only bound with immediate sorting', async () => {
  const localOffers = [
    { ...offers[0], name: '人民币十元', price: '10', currency: 'CNY' },
    { ...offers[1], name: '人民币二十元', price: '20', currency: 'CNY' },
    { ...offers[2], name: '美元一元', price: '1', currency: 'USD' },
  ].map(offer => ({ ...offer, priceStatus: 'verified', priceExpiresAt: new Date(Date.now() + 3600000).toISOString() }));
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/analytics/collect') return new Response(null, { status: 204 });
    requests.push(url);
    if (url.pathname.endsWith('/facets')) return Response.json({ tagFacets: [] });
    const params = url.searchParams;
    const selected = params.has('priceMax') ? [localOffers[0]] : params.get('offerSort') === 'priceDesc' ? [localOffers[1], localOffers[0]] : localOffers.slice(0, 2);
    const page = Number(params.get('detailPage'));
    const pageSize = Number(params.get('detailPageSize'));
    return Response.json({ items: [{ ...item, offers: localOffers,
      ...(params.has('detailKind') ? { detail: { kind: 'offers', page, pageSize, total: selected.length, entries: selected.slice(page * pageSize, (page + 1) * pageSize) } } : {}) }], total: 1 });
  }));
  mount();
  fireEvent.click(await screen.findByRole('button', { name: '15 条报价' }));
  const dialog = within(screen.getByRole('dialog'));
  await dialog.findByText('人民币二十元');
  expect(dialog.queryByText('美元一元')).not.toBeInTheDocument();
  fireEvent.click(dialog.getByRole('button', { name: '筛选', exact: true }));
  fireEvent.change(dialog.getByRole('spinbutton', { name: '最高价格' }), { target: { value: '15' } });
  fireEvent.change(dialog.getByRole('combobox', { name: '报价排序' }), { target: { value: 'priceDesc' } });
  expect(await dialog.findByText('人民币二十元')).toBeInTheDocument();
  const sortedParams = requests.filter(url => url.searchParams.has('detailKind')).at(-1).searchParams;
  expect(sortedParams.get('currency')).toBe('CNY');
  expect(sortedParams.get('offerSort')).toBe('priceDesc');
  expect(sortedParams.has('priceMax')).toBe(false);
  fireEvent.click(dialog.getByRole('button', { name: /应用筛选/ }));
  expect(await dialog.findByText('人民币十元')).toBeInTheDocument();
  expect(dialog.queryByText('人民币二十元')).not.toBeInTheDocument();
  const filteredParams = requests.filter(url => url.searchParams.has('detailKind')).at(-1).searchParams;
  expect(filteredParams.get('priceMax')).toBe('15');
  expect(filteredParams.has('priceMin')).toBe(false);
  fireEvent.click(dialog.getByRole('button', { name: /^筛选/ }));
  fireEvent.click(dialog.getByRole('button', { name: '清除全部', exact: true }));
  fireEvent.click(dialog.getByRole('button', { name: /应用筛选/ }));
  expect(await dialog.findByText('人民币二十元')).toBeInTheDocument();
  expect(dialog.queryByText('美元一元')).not.toBeInTheDocument();
});

test('one detail search displays matches in shop names, quote names or nonempty specifications', async () => {
  const localOffers = [
    { ...offers[0], name: '星河账号', shop: '甲店', spec: '旧规格关键词' },
    { ...offers[1], name: '普通账号', shop: '星河商铺' },
    { ...offers[2], name: '规格匹配账号', shop: '丙店', spec: '星河' },
    { ...offers[3], name: '不相关账号', shop: '丁店', spec: '' },
  ];
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/analytics/collect') return new Response(null, { status: 204 });
    requests.push(url);
    const params = url.searchParams;
    const selected = params.get('q') === '星河' ? localOffers.slice(0, 3) : localOffers;
    const page = Number(params.get('detailPage'));
    const pageSize = Number(params.get('detailPageSize'));
    return Response.json({ items: [{ ...item, offers: localOffers,
      ...(params.has('detailKind') ? { detail: { kind: 'offers', page, pageSize, total: selected.length, entries: selected.slice(page * pageSize, (page + 1) * pageSize) } } : {}) }], total: 1 });
  }));
  mount();
  fireEvent.click(await screen.findByRole('button', { name: '15 条报价' }));
  const dialog = within(screen.getByRole('dialog'));
  await dialog.findByText('不相关账号');
  fireEvent.change(dialog.getByRole('textbox', { name: '搜索商铺或报价' }), { target: { value: '星河' } });
  fireEvent.submit(dialog.getByRole('form', { name: '详情查询' }));
  expect(await dialog.findByText('星河账号')).toBeInTheDocument();
  expect(dialog.getByText('普通账号')).toBeInTheDocument();
  expect(dialog.getByText('规格匹配账号')).toBeInTheDocument();
  expect(dialog.queryByText('不相关账号')).not.toBeInTheDocument();
  const params = requests.filter(url => url.searchParams.has('detailKind')).at(-1).searchParams;
  expect(params.get('q')).toBe('星河');
  expect(params.get('searchMode')).toBe('literal');
});

test('nested comparison and report dialogs close without dismissing quote details', async () => {
  const user = userEvent.setup();
  mount();
  await user.click(await screen.findByRole('button', { name: '15 条报价' }));
  const detail = screen.getByRole('dialog', { name: /ChatGPT Plus/ });
  await within(detail).findByText('报价12');
  await user.click(within(detail).getAllByRole('checkbox', { name: /对比报价/ })[0]);
  await user.click(within(detail).getByRole('button', { name: '对比（1）' }));
  expect(screen.getByRole('dialog', { name: '报价对比' })).toContainElement(document.activeElement);
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog', { name: '报价对比' })).not.toBeInTheDocument();
  expect(detail).toBeInTheDocument();
  expect(within(detail).queryByRole('button', { name: '举报此报价' })).not.toBeInTheDocument();
  const explanationTrigger = within(detail).getAllByRole('button', { name: '商品说明' })[0];
  const offerName = explanationTrigger.closest('.shop-tile').querySelector('.offer-name').textContent;
  await user.click(explanationTrigger);
  const explanation = screen.getByRole('dialog', { name: offerName, exact: true });
  await user.click(within(explanation).getByRole('button', { name: '举报此报价' }));
  expect(screen.getByRole('dialog', { name: '举报此报价' })).toContainElement(document.activeElement);
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog', { name: '举报此报价' })).not.toBeInTheDocument();
  expect(explanation).toBeInTheDocument();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog', { name: offerName, exact: true })).not.toBeInTheDocument();
  expect(detail).toBeInTheDocument();
});
