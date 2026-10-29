import React from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import PublicPage from './PublicPage.jsx';

const virtual = vi.hoisted(() => ({ endReached: null, parent: null, windowScroll: null }));
vi.mock('react-virtuoso', () => ({ Virtuoso: ({ data, itemContent, endReached, totalListHeightChanged, customScrollParent, useWindowScroll }) => {
  if (customScrollParent) { virtual.endReached = endReached; virtual.parent = customScrollParent; virtual.windowScroll = useWindowScroll; }
  React.useEffect(() => { totalListHeightChanged?.(data.length * 200); }, [data.length, totalListHeightChanged]);
  return <>{data.map((item, index) => <React.Fragment key={index}>{itemContent(index, item)}</React.Fragment>)}</>;
} }));

const quote = id => ({ productId: String(id), shopId: String(id), shop: '商铺' + id, name: '报价' + id,
  shopScore: id === 0 ? '0.00' : id === 1 || id === 3 ? '33.75' : id === 4 ? 0 : id === 5 ? '12.50' : id === 6 ? '20.00' : null,
  shopScoreDetails: id === 0 ? { deposit: { amountMinor: 0, currency: 'CNY', contribution: '0.00' }, volume: null }
    : id === 1 ? { deposit: { amountMinor: 10000, currency: 'CNY', contribution: '18.75' }, volume: { count: 1000, unit: 'people', contribution: '15.00' } }
      : id === 5 ? { deposit: null, volume: null, text: { reviewed: 2, total: 4, disclosureContribution: '11.50', consistencyContribution: '1.00' } } : null,
  shopScoreExpiresAt: id === 3 ? '2000-01-01T00:00:00Z' : null,
  price: id + 10, currency: 'CNY', priceStatus: 'verified', priceExpiresAt: '2099-01-01T00:00:00Z', tags: [] });
const item = { id: '42', name: '商品', platform: 'openai', productCount: 25, shopCount: 25, offersTruncated: true, offers: [quote(0)] };
function mockApi({ failNext = false } = {}) {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input, options) => {
    const url = new URL(input, 'http://localhost');
    if (!url.searchParams.has('detailKind')) return Response.json({ items: [item], total: 1 });
    calls.push({ url, signal: options?.signal });
    const page = Number(url.searchParams.get('detailPage'));
    if (failNext && page === 1) { failNext = false; return new Response(null, { status: 503 }); }
    const total = url.searchParams.get('q') || url.searchParams.get('shopId') ? 2 : 25;
    const size = Number(url.searchParams.get('detailPageSize'));
    const offers = Array.from({ length: Math.max(0, Math.min(size, total - page * size)) }, (_, index) => quote(page * size + index));
    const entries = url.searchParams.get('detailKind') === 'shops' ? offers.map(offer => ({ key: offer.shopId, name: offer.shop, count: 2, offer })) : offers;
    return Response.json({ items: [{ ...item, detail: { total, entries } }] });
  }));
  return calls;
}
async function open(kind = 'offers') {
  render(<PublicPage />);
  fireEvent.click(await screen.findByRole('button', { name: kind === 'shops' ? '25 家商铺' : '25 条报价' }));
  const modal = screen.getByRole('dialog', { name: /商品/ });
  await within(modal).findByText(kind === 'shops' ? '商铺0' : '报价0');
  return modal;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test.each(['offers', 'shops'])('%s label shop scores and omit absent scores without a placeholder', async kind => {
  mockApi(); const modal = await open(kind);
  expect([...modal.querySelectorAll('.shop-score')].map(node => node.textContent)).toEqual(['评分 0', '评分 33.75', '评分 0', '评分 12.5', '评分 20']);
  expect(modal.querySelector('.shop-score')).not.toHaveAttribute('title');
  expect(within(modal).getByText('商铺2').closest(kind === 'shops' ? 'strong' : '.offer-shop-identity').querySelector('.shop-score')).toBeNull();
  expect(within(modal).getByText('商铺3').closest(kind === 'shops' ? 'strong' : '.offer-shop-identity').querySelector('.shop-score')).toBeNull();
  expect(within(modal).queryByText(/商铺评分|暂无评分|\/100/)).not.toBeInTheDocument();
});

test('text score dialog shows actual reviewed scope and separate contributions', async () => {
  mockApi(); const modal = await open();
  fireEvent.click(within(modal).getByRole('button', { name: '商铺评分 12.5' }));
  const dialog = screen.getByRole('dialog', { name: '商铺评分说明' });
  expect(within(dialog).getByRole('row', { name: '信息披露 已审核 2 / 4 件商品 11.5 分' })).toBeInTheDocument();
  expect(within(dialog).getByRole('row', { name: '描述一致性 已审核 2 / 4 件商品 1 分' })).toBeInTheDocument();
  expect(within(dialog).queryByText(/销售数据未经/)).not.toBeInTheDocument();
});

test.each(['offers', 'shops'])('%s score badges explain the score without opening the shop and restore focus on close', async kind => {
  const calls = mockApi(); const modal = await open(kind);
  const score = modal.querySelector('.shop-score');
  expect(score).toHaveAttribute('tabindex', '0');
  const requests = calls.length;
  fireEvent.click(score);
  let explanation = screen.getByRole('dialog', { name: '商铺评分说明' });
  expect(within(explanation).getByText('0 / 100')).toBeInTheDocument();
  expect(within(explanation).getByRole('row', { name: '押金 0 元 0 分' })).toBeInTheDocument();
  expect(within(explanation).getByRole('row', { name: '公示销量 未取得 —' })).toBeInTheDocument();
  expect(within(explanation).getByRole('row', { name: '信息披露 未取得 —' })).toBeInTheDocument();
  expect(within(explanation).getByRole('row', { name: '描述一致性 未取得 —' })).toBeInTheDocument();
  expect(within(explanation).queryByText(/商品说明披露|履约保证|分数越高/)).not.toBeInTheDocument();
  fireEvent.click(within(explanation).getByRole('button', { name: '关闭评分说明' }));
  expect(screen.queryByRole('dialog', { name: '商铺评分说明' })).not.toBeInTheDocument();
  expect(score).toHaveFocus();
  for (const key of ['Enter', ' ']) {
    fireEvent.keyDown(score, { key });
    explanation = screen.getByRole('dialog', { name: '商铺评分说明' });
    expect(score).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(explanation, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '商铺评分说明' })).not.toBeInTheDocument();
    expect(score).toHaveAttribute('aria-expanded', 'false');
    expect(score).toHaveFocus();
  }
  expect(score).toHaveTextContent(/^评分 0$/);
  fireEvent.click(within(modal).getByRole('button', { name: '商铺评分 33.75' }));
  explanation = screen.getByRole('dialog', { name: '商铺评分说明' });
  expect(within(explanation).getByRole('row', { name: '押金 100 元 18.75 分' })).toBeInTheDocument();
  expect(within(explanation).getByRole('row', { name: '公示销量 1,000 15 分' })).toBeInTheDocument();
  expect(within(explanation).queryByText(/人付款/)).not.toBeInTheDocument();
  fireEvent.click(within(explanation).getByRole('button', { name: '关闭评分说明' }));
  expect(calls).toHaveLength(requests);
  expect(within(modal).queryByText(/商铺评分|暂无评分|\/100/)).not.toBeInTheDocument();
});

test.each(['offers', 'shops'])('modal %s append batches inside its own scroll container and stop at the end', async kind => {
  const calls = mockApi(); const modal = await open(kind);
  expect(within(modal).queryByRole('navigation', { name: /分页/ })).not.toBeInTheDocument();
  expect(within(modal).queryByRole('combobox', { name: '每页数量' })).not.toBeInTheDocument();
  expect(virtual.parent).toBe(modal.querySelector('.detail-scroll'));
  expect(virtual.windowScroll).toBe(false);
  await act(async () => virtual.endReached());
  await within(modal).findByText(kind === 'shops' ? '商铺12' : '报价12');
  expect(within(modal).getByText(kind === 'shops' ? '商铺0' : '报价0')).toBeInTheDocument();
  await act(async () => virtual.endReached());
  await within(modal).findByText(kind === 'shops' ? '商铺24' : '报价24');
  await within(modal).findByText(kind === 'shops' ? '已显示全部 25 家商铺' : '已显示全部 25 条报价');
  await act(async () => virtual.endReached());
  expect(calls.map(({ url }) => url.searchParams.get('detailPage'))).toEqual(['0', '1', '2']);
});

test('failed modal batches preserve loaded quotes and retry the same batch', async () => {
  const calls = mockApi({ failNext: true }); const modal = await open();
  await act(async () => virtual.endReached());
  await within(modal).findByText('更多报价加载失败');
  expect(within(modal).getByText('报价0')).toBeInTheDocument();
  fireEvent.click(within(modal).getByRole('button', { name: '重试加载' }));
  await within(modal).findByText('报价12');
  expect(calls.filter(({ url }) => url.searchParams.get('detailPage') === '1')).toHaveLength(2);
});

test('a new modal search cancels a pending batch and starts again at the top', async () => {
  mockApi(); const base = globalThis.fetch; let signal;
  globalThis.fetch = vi.fn((input, options) => {
    const params = new URL(input, 'http://localhost').searchParams;
    if (params.get('detailPage') === '1' && !params.get('q')) {
      signal = options.signal;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
    }
    return base(input, options);
  });
  const modal = await open();
  await act(async () => virtual.endReached());
  expect(signal.aborted).toBe(false);
  modal.querySelector('.detail-scroll').scrollTop = 180;
  fireEvent.change(within(modal).getByRole('textbox', { name: '搜索商铺或报价' }), { target: { value: '筛选' } });
  fireEvent.submit(within(modal).getByRole('form', { name: '详情查询' }));
  await within(modal).findByText('已显示全部 2 条报价');
  expect(signal.aborted).toBe(true);
  expect(modal.querySelector('.detail-scroll').scrollTop).toBe(0);
  expect(within(modal).queryByText('报价12')).not.toBeInTheDocument();
});

test('returning from a modal shop restores loaded batches and the inner scroll position', async () => {
  const calls = mockApi(); const modal = await open('shops');
  await act(async () => virtual.endReached());
  await within(modal).findByText('商铺12');
  const before = calls.length;
  modal.querySelector('.detail-scroll').scrollTop = 500;
  fireEvent.click(within(modal).getByText('商铺12'));
  await within(modal).findByText('报价0');
  fireEvent.click(within(modal).getByRole('button', { name: '← 返回商铺列表' }));
  await within(modal).findByText('商铺12');
  await waitFor(() => expect(modal.querySelector('.detail-scroll').scrollTop).toBe(500));
  expect(calls).toHaveLength(before + 1);
});
