import React from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VirtuosoMockContext } from 'react-virtuoso';
import PublicPage from './PublicPage.jsx';

afterEach(() => vi.unstubAllGlobals());

function renderPage() {
  return render(<VirtuosoMockContext.Provider value={{ viewportHeight: 900, itemHeight: 300 }}><PublicPage /></VirtuosoMockContext.Provider>);
}

function mockCatalog(coverage) {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = new URL(input, 'http://localhost');
    calls.push(url);
    if (url.pathname === '/api/catalog/coverage') return typeof coverage === 'function' ? coverage() : Response.json(coverage);
    if (url.pathname === '/api/analytics/collect') return new Response(null, { status: 204 });
    return Response.json({ total: 1, platformFacets: ['openai'], items: [{ id: '1', name: '可比价商品', offers: [] }] });
  }));
  return calls;
}

test('measures the search toolbar, updates the sticky offset on resize and disconnects on unmount', async () => {
  const observers = [];
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  });
  let height = 138;
  const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    return { top: 0, left: 0, bottom: 0, right: 0, width: 390, height: this.matches('.search-panel') ? height : 0 };
  });
  try {
    mockCatalog({ shopCount: 20, productCount: 100 });
    const mounted = renderPage();
    const toolbar = screen.getByRole('region', { name: '搜索和筛选' });
    const catalog = toolbar.closest('.compact-catalog');
    await waitFor(() => expect(catalog.style.getPropertyValue('--catalog-toolbar-height')).toBe('138px'));
    const observer = observers.find(instance => instance.observe.mock.calls.some(([element]) => element === toolbar));
    expect(observer).toBeDefined();
    expect(observer.observe).toHaveBeenCalledWith(toolbar, { box: 'border-box' });
    height = 192;
    await act(async () => observer.callback([]));
    expect(catalog.style.getPropertyValue('--catalog-toolbar-height')).toBe('192px');
    mounted.unmount();
    expect(observer.disconnect).toHaveBeenCalledOnce();
  } finally {
    bounds.mockRestore();
  }
});

test('shows static collection scale beside the brand with compact numbers and no explanation controls', async () => {
  const user = userEvent.setup();
  const calls = mockCatalog({ shopCount: 1234, productCount: 3149999 });
  renderPage();
  const summary = (await screen.findByText('条报价')).closest('.catalog-coverage');
  expect(summary).toHaveTextContent('1,234 家商铺·314.9万条报价');
  expect(within(summary).getByText('收录')).toBeInTheDocument();
  const brandRow = summary.closest('.public-brand-row');
  expect(within(brandRow).getByRole('link', { name: '知途 · 拾价' })).toBeInTheDocument();
  expect(within(brandRow).queryByRole('button')).not.toBeInTheDocument();
  expect(screen.queryByText(/数据覆盖：/)).not.toBeInTheDocument();
  expect(summary.closest('details')).toBeNull();
  expect(summary.querySelectorAll('strong')).toHaveLength(2);
  expect(summary).not.toHaveAttribute('title');
  await user.click(summary);
  expect(screen.queryByRole('dialog', { name: '数据统计口径' })).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'ChatGPT / Codex' }));
  await waitFor(() => expect(calls.some(url => url.pathname === '/api/catalog' && url.searchParams.get('platform') === 'openai')).toBe(true));
  expect(calls.filter(url => url.pathname === '/api/catalog/coverage')).toHaveLength(1);
  expect(summary).toHaveTextContent('314.9万');
});

test.each([
  [{ shopCount: 0, productCount: 0 }, '0 家商铺·0条报价'],
  [{ shopCount: 15, productCount: 9999 }, '15 家商铺·9,999条报价'],
  [{ shopCount: 15, productCount: 10000 }, '15 家商铺·1万条报价'],
])('shows genuine zeroes and small counts without inventing scale: %j', async (coverage, text) => {
  mockCatalog(coverage);
  renderPage();
  expect((await screen.findByText('条报价')).closest('.catalog-coverage')).toHaveTextContent(text);
});

test('keeps the catalog usable while coverage loads and never substitutes zeroes', async () => {
  let resolve;
  mockCatalog(() => new Promise(done => { resolve = done; }));
  renderPage();
  await screen.findByRole('heading', { name: /可比价商品/ });
  expect(screen.queryByText('条报价')).not.toBeInTheDocument();
  await act(async () => resolve(Response.json({ shopCount: 30, productCount: 20000 })));
  expect((await screen.findByText('条报价')).closest('.catalog-coverage')).toHaveTextContent('30 家商铺·2万条报价');
});

test.each([
  () => Response.json({ message: 'unavailable' }, { status: 503 }),
  () => Response.json({ shopCount: -1, productCount: 100 }),
  () => Response.json({ shopCount: '100', productCount: 100 }),
  () => Response.json({ shopCount: 100, productCount: null }),
])('hides unavailable or malformed coverage without breaking search', async response => {
  mockCatalog(response);
  renderPage();
  await screen.findByRole('heading', { name: /可比价商品/ });
  expect(screen.queryByText('条报价')).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: '搜索商品' })).toBeEnabled();
  expect(screen.getByRole('button', { name: '提交商铺' })).toBeEnabled();
});
