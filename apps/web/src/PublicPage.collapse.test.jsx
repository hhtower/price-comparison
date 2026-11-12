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

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mount(membership = false) {
  const offers = Array.from({ length: 5 }, (_, index) => ({
    productId: String(index), shopId: String(index), shop: `商家${index}`, name: `报价${index}`,
    price: String(index + 10), priceStatus: 'estimated', currency: 'CNY',
    productUrl: `https://example.com/${index}`, tags: [],
  }));
  const item = { id: '1', name: 'ChatGPT Plus', platform: 'openai', shopCount: 5, productCount: 9, offers,
    ...(membership ? { isAiMembership: true, membershipGroups: [
      { kind: 'top_up', shopCount: 5, productCount: 9, minPrice: '10', maxPrice: '14', offers },
    ] } : {}) };
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/analytics/collect') return new Response(null, { status: 204 });
    return Response.json({ items: url.searchParams.has('detailKind')
      ? [{ ...item, detail: { entries: offers, total: 5 } }]
      : [item, { ...item, id: '2', name: 'ChatGPT Go' }], platformFacets: ['openai'] });
  }));
  return render(<VirtuosoMockContext.Provider value={{ viewportHeight: 1600, itemHeight: 100 }}>
    <PublicPage />
  </VirtuosoMockContext.Provider>);
}

test('all products start collapsed with prices and counts, then independently show at most four quotes', async () => {
  const user = userEvent.setup();
  mount();
  const first = await screen.findByRole('button', { name: '查看报价：ChatGPT Plus' });
  const second = screen.getByRole('button', { name: '查看报价：ChatGPT Go' });
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
  expect(first).toHaveAccessibleName('收起报价：ChatGPT Plus');
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

test('keyboard toggles quotes while count buttons keep their independent detail action', async () => {
  const user = userEvent.setup();
  mount();
  const trigger = await screen.findByRole('button', { name: '查看报价：ChatGPT Plus' });
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
  await user.click(within(trigger.closest('article')).getByRole('button', { name: '查看全部 9 条报价' }));
  expect(await screen.findByRole('dialog', { name: 'ChatGPT Plus · 报价' })).toBeInTheDocument();
});

test('summary whitespace and price toggle quotes without navigating away', async () => {
  mount();
  const trigger = await screen.findByRole('button', { name: '查看报价：ChatGPT Plus' });
  const header = trigger.closest('header');
  fireEvent.click(header);
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  fireEvent.click(header.querySelector('.lowest-note'));
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(window.location.pathname).toBe('/');
});

test('collapsed membership groups identify estimated starting prices', async () => {
  mount(true);
  const trigger = await screen.findByRole('button', { name: '查看报价：ChatGPT Plus · 代充' });
  const card = trigger.closest('article');
  expect(card.querySelector('.lowest-note')).toHaveTextContent('¥10预估 起');
  expect(within(card).queryByRole('link', { name: '去商家' })).not.toBeInTheDocument();
});
