import React from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VirtuosoMockContext } from 'react-virtuoso';
import PublicPage from './PublicPage.jsx';

vi.mock('react-virtuoso', async importOriginal => {
  const original = await importOriginal();
  return { ...original, Virtuoso: props => <original.Virtuoso {...props} endReached={undefined} /> };
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function mount(membership = false, latestCapturedAt, inStock = true, stockQuantity, priceStatus = 'estimated') {
  const offers = Array.from({ length: 5 }, (_, index) => ({
    productId: String(index), shopId: String(index), shop: `商家${index}`, name: `报价${index}`,
    price: String(index + 10), priceStatus, currency: 'CNY',
    productUrl: `https://example.com/${index}`, tags: [], inStock, stockQuantity,
  }));
  const item = { id: '1', name: 'ChatGPT Plus', platform: 'openai', shopCount: 5, productCount: 9, offers, latestCapturedAt,
    ...(membership ? { isAiMembership: true, membershipGroups: [
      { kind: 'top_up', shopCount: 5, productCount: 9, minPrice: '10', maxPrice: '14', offers, latestCapturedAt },
    ] } : {}) };
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/analytics/collect') return new Response(null, { status: 204 });
    return Response.json({ items: url.searchParams.has('detailKind')
      ? [{ ...item, detail: { entries: url.searchParams.get('detailKind') === 'shops'
        ? offers.map(offer => ({ key: offer.shopId, name: offer.shop, count: 1, offer })) : offers, total: 5 } }]
      : [item, { ...item, id: '2', name: 'ChatGPT Go' }], platformFacets: ['openai'] });
  }));
  return render(<VirtuosoMockContext.Provider value={{ viewportHeight: 1600, itemHeight: 100 }}>
    <PublicPage />
  </VirtuosoMockContext.Provider>);
}

test('platform icon belongs to the product title and clicking it expands quotes without repeating icons', async () => {
  mount();
  const trigger = await screen.findByRole('button', { name: 'ChatGPT Plus' });
  const icon = trigger.querySelector('.product-platform-icon');
  expect(icon).toHaveAttribute('alt', '');
  expect(icon).toHaveAttribute('aria-hidden', 'true');
  fireEvent.click(icon);
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const card = trigger.closest('article');
  expect(card.querySelectorAll('.product-platform-icon')).toHaveLength(1);
  expect(card.querySelectorAll('.shop-offer')).toHaveLength(4);
});

test.each([false, true])('expanded quotes show stock status in previews and details (membership: %s)', async membership => {
  mount(membership);
  const trigger = await screen.findByRole('button', { name: membership ? 'ChatGPT Plus · 代充' : 'ChatGPT Plus' });
  fireEvent.click(trigger);
  const card = within(trigger.closest('article'));
  expect(card.getAllByText('有货')).toHaveLength(4);
  expect(card.getAllByText('有货')[0]).toHaveAttribute('title', '采集时显示有货，实际库存以商家页面为准');
  fireEvent.click(card.getByRole('button', { name: '9 条报价' }));
  const dialog = await screen.findByRole('dialog', { name: membership ? 'ChatGPT Plus · 代充 · 报价' : 'ChatGPT Plus · 报价' });
  expect(await within(dialog).findAllByText('有货')).toHaveLength(5);
});

test('quotes without a collected quantity show the availability status', async () => {
  mount(false, undefined, null);
  const trigger = await screen.findByRole('button', { name: 'ChatGPT Plus' });
  fireEvent.click(trigger);
  const card = within(trigger.closest('article'));
  expect(card.getAllByText('有货')).toHaveLength(4);
  expect(card.queryByText('库存未知')).not.toBeInTheDocument();
});

test.each([false, true])('expanded previews and details show the collected stock quantity (membership: %s)', async membership => {
  mount(membership, undefined, true, 16);
  const trigger = await screen.findByRole('button', { name: membership ? 'ChatGPT Plus · 代充' : 'ChatGPT Plus' });
  fireEvent.click(trigger);
  const card = within(trigger.closest('article'));
  expect(card.getAllByText('库存 16')).toHaveLength(4);
  fireEvent.click(card.getByRole('button', { name: '9 条报价' }));
  const dialog = await screen.findByRole('dialog', { name: membership ? 'ChatGPT Plus · 代充 · 报价' : 'ChatGPT Plus · 报价' });
  expect(await within(dialog).findAllByText('库存 16')).toHaveLength(5);
});

test.each([null, -1, 0, 1.5, '16', Number.MAX_SAFE_INTEGER + 1])('missing or invalid quantities show the availability status: %s', async quantity => {
  mount(false, undefined, true, quantity);
  const trigger = await screen.findByRole('button', { name: 'ChatGPT Plus' });
  fireEvent.click(trigger);
  expect(within(trigger.closest('article')).getAllByText('有货')).toHaveLength(4);
});

test('all products start collapsed with prices and counts, then independently show at most four quotes', async () => {
  const user = userEvent.setup();
  mount();
  const first = await screen.findByRole('button', { name: 'ChatGPT Plus' });
  const second = screen.getByRole('button', { name: 'ChatGPT Go' });
  const card = first.closest('article');
  expect(first).toHaveAttribute('aria-expanded', 'false');
  expect(second).toHaveAttribute('aria-expanded', 'false');
  expect(within(card).getByText('¥10')).toBeInTheDocument();
  expect(within(card).getByText('预估')).toBeInTheDocument();
  expect(within(card).getByRole('button', { name: '5 家商铺' })).toBeInTheDocument();
  expect(within(card).getByRole('button', { name: '9 条报价' })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: '去商家' })).not.toBeInTheDocument();

  await user.click(first);
  expect(first).toHaveAttribute('aria-expanded', 'true');
  expect(first).toHaveAccessibleName('ChatGPT Plus');
  const panel = document.getElementById(first.getAttribute('aria-controls'));
  expect(panel).toBeVisible();
  expect(within(panel).getAllByRole('link', { name: '去商家' })).toHaveLength(4);
  expect(within(panel).queryByText('报价4')).not.toBeInTheDocument();

  await user.click(second);
  expect(second).toHaveAttribute('aria-expanded', 'true');
  expect(first).toHaveAttribute('aria-expanded', 'true');
  await user.click(first);
  expect(first).toHaveAttribute('aria-expanded', 'false');
  expect(panel).not.toBeInTheDocument();
  expect(second).toHaveAttribute('aria-expanded', 'true');
});

test.each([false, true])('collapsed summaries show the latest collection time with counts (membership: %s)', async membership => {
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const capturedAt = new Date(now - 6 * 60 * 1000).toISOString();
  mount(membership, capturedAt);
  const trigger = await screen.findByRole('button', { name: membership ? 'ChatGPT Plus · 代充' : 'ChatGPT Plus' });
  const card = trigger.closest('article');
  const timestamp = within(card).getByText('6 分钟前更新');
  expect(timestamp).toHaveAttribute('dateTime', capturedAt);
  expect(timestamp).toHaveAttribute('title', '最近采集：' + new Date(capturedAt).toLocaleString('zh-CN'));
  expect(timestamp.closest('p')).toContainElement(within(card).getByRole('button', { name: '9 条报价' }));
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(trigger);
  expect(within(card).getAllByText('6 分钟前更新')).toHaveLength(1);
});

test.each([undefined, 'invalid-date'])('missing or invalid collection time stays explicit: %s', async capturedAt => {
  mount(false, capturedAt);
  const trigger = await screen.findByRole('button', { name: 'ChatGPT Plus' });
  const card = trigger.closest('article');
  expect(within(card).getByText('更新时间未知')).toBeInTheDocument();
  expect(card.querySelector('time')).not.toBeInTheDocument();
});

test('keyboard toggles quotes while count buttons keep their independent detail action', async () => {
  const user = userEvent.setup();
  mount();
  const trigger = await screen.findByRole('button', { name: 'ChatGPT Plus' });
  trigger.focus();
  await user.keyboard('{Enter}');
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await user.keyboard(' ');
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(within(trigger.closest('article')).getByRole('button', { name: '9 条报价' }));
  expect(await screen.findByRole('dialog', { name: 'ChatGPT Plus · 报价' })).toBeInTheDocument();
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await user.click(screen.getByRole('button', { name: '关闭报价详情' }));
  await user.click(trigger);
  await user.click(within(trigger.closest('article')).getByRole('button', { name: '5 家商铺' }));
  expect(await screen.findByRole('dialog', { name: 'ChatGPT Plus · 商铺' })).toBeInTheDocument();
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
});

test('summary whitespace and price toggle quotes without navigating away', async () => {
  mount();
  const trigger = await screen.findByRole('button', { name: 'ChatGPT Plus' });
  const header = trigger.closest('header');
  fireEvent.click(header);
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  fireEvent.click(header.querySelector('.lowest-note'));
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(window.location.pathname).toBe('/');
});

test.each([false, true])('estimated starting prices are labeled in the counts row (membership: %s)', async membership => {
  mount(membership);
  const trigger = await screen.findByRole('button', { name: membership ? 'ChatGPT Plus · 代充' : 'ChatGPT Plus', exact: true });
  const card = trigger.closest('article');
  expect(card.querySelector('.lowest-note')).toHaveTextContent('¥10 起');
  expect(card.querySelector('.lowest-note')).not.toHaveTextContent('预估');
  expect(card.querySelector('.product-counts')).toHaveTextContent('预估');
  expect(within(card).queryByRole('link', { name: '去商家' })).not.toBeInTheDocument();
  fireEvent.click(trigger);
  expect(card.querySelector('.product-counts')).toHaveTextContent('预估');
  expect(card.querySelector('.tile-price')).toHaveTextContent('¥10预估');
});

test.each([false, true])('verified starting prices have no estimate label in the counts row (membership: %s)', async membership => {
  mount(membership, undefined, true, undefined, 'verified');
  const trigger = await screen.findByRole('button', { name: membership ? 'ChatGPT Plus · 代充' : 'ChatGPT Plus', exact: true });
  expect(trigger.closest('header')).not.toHaveTextContent('预估');
});

test('product names toggle the preview and keep a separate detail link', async () => {
  const user = userEvent.setup();
  mount();
  const title = await screen.findByRole('button', { name: 'ChatGPT Plus', exact: true });
  const card = title.closest('article');
  expect(title).toHaveAttribute('aria-expanded', 'false');
  await user.click(title);
  expect(title).toHaveAttribute('aria-expanded', 'true');
  expect(window.location.pathname).toBe('/');
  expect(within(card).getAllByRole('link', { name: '去商家' })).toHaveLength(4);
  expect(within(card).getByRole('link', { name: '更多报价：ChatGPT Plus' })).toHaveAttribute('href', '/products/1?newcomer=false');
  title.focus();
  await user.keyboard(' ');
  expect(title).toHaveAttribute('aria-expanded', 'false');
});

test('membership titles read as one product name and previews keep one page entry', async () => {
  mount(true);
  const title = await screen.findByRole('button', { name: 'ChatGPT Plus · 代充', exact: true });
  expect(title).toHaveTextContent('ChatGPT Plus · 代充');
  expect(title.querySelector('.product-kind')).toBeNull();
  fireEvent.click(title);
  const card = within(title.closest('article'));
  expect(card.queryByRole('button', { name: /^查看全部/ })).not.toBeInTheDocument();
  expect(card.queryByText(/^展示前/)).not.toBeInTheDocument();
  const link = card.getByRole('link', { name: '更多报价：ChatGPT Plus · 代充' });
  expect(link).toHaveTextContent(/^更多$/);
  expect(link).toHaveAttribute('href', '/products/1/features/top_up');
});

test('the row indicator is decorative while the title and count actions remain available', async () => {
  mount();
  const title = await screen.findByRole('button', { name: 'ChatGPT Plus', exact: true });
  const header = title.closest('header');
  const indicator = header.querySelector('.product-offers-indicator');
  expect(indicator).toHaveAttribute('aria-hidden', 'true');
  expect(indicator.tagName).toBe('svg');
  expect(indicator).toHaveAttribute('width', '12');
  expect(indicator).toHaveAttribute('height', '12');
  expect(indicator.querySelectorAll('path')).toHaveLength(1);
  expect(indicator.querySelector('.filter-chevron')).toBeNull();
  expect(within(header).getAllByRole('button')).toHaveLength(3);
  expect(title).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(indicator);
  expect(title).toHaveAttribute('aria-expanded', 'true');
  fireEvent.click(header);
  expect(title).toHaveAttribute('aria-expanded', 'false');
});

test.each([false, true])('expanded quotes follow the summary directly without a preview label or price range (membership: %s)', async membership => {
  mount(membership);
  const title = await screen.findByRole('button', { name: membership ? 'ChatGPT Plus · 代充' : 'ChatGPT Plus', exact: true });
  const card = title.closest('article');
  expect(within(card).queryByText('报价预览')).not.toBeInTheDocument();
  fireEvent.click(title);
  const panel = card.querySelector('.product-offers-panel');
  expect(within(card).queryByText('报价预览')).not.toBeInTheDocument();
  expect(within(card).queryByText(/区间/)).not.toBeInTheDocument();
  expect(card.querySelector('.product-price-range')).toBeNull();
  expect(panel.firstElementChild).toHaveClass('shop-grid');
  expect(within(panel).getAllByRole('link', { name: '去商家' })).toHaveLength(4);
});
