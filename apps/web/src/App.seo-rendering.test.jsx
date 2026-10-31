import React from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { VirtuosoMockContext } from 'react-virtuoso';
import { registerPublicPages } from '../../api/src/seo/public-pages.ts';
import App from './App.jsx';

const originalHead = document.head.innerHTML;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); document.head.innerHTML = originalHead; window.history.replaceState({}, '', '/'); });

// This fixture interprets the emitted single wildcard group using robots longest-match rules.
function allowedByRobots(text, url) {
  const matches = text.split('\n').flatMap(line => {
    const rule = /^(Allow|Disallow): (.+)$/u.exec(line);
    if (!rule) return [];
    const exact = rule[2].endsWith('$');
    const path = exact ? rule[2].slice(0, -1) : rule[2];
    return (exact ? url === path : url.startsWith(path)) ? [{ allow: rule[1] === 'Allow', length: path.length }] : [];
  }).sort((a, b) => b.length - a.length || Number(b.allow) - Number(a.allow));
  return matches[0]?.allow ?? true;
}

test('real client retains readable quotes after replacing server HTML under its own robots policy', async () => {
  const catalog = { total: 1, platformFacets: ['openai'], items: [{ id: '42', standardProductId: '42', name: 'ChatGPT Plus', platform: 'openai',
    shopCount: 1, productCount: 1, minPrice: '12.50', offers: [{ shopId: '7', productId: '9', name: 'Plus 月付', shop: '示例商铺',
      price: '12.50', currency: 'CNY', productUrl: 'https://shop.example/product/9', spec: '一个月', tags: [],
      capturedAt: '2026-09-27T00:00:00Z', stale: false, inStock: true }] }] };
  const adapter = new FastifyAdapter();
  registerPublicPages(adapter, { template: '<html><head><title>Site</title></head><body><div id="root"></div></body></html>', getCatalog: async () => catalog,
    getProducts: async () => ({ items: [] }), getProduct: async () => null });
  const app = adapter.getInstance();
  let robots, html;
  try { robots = (await app.inject('/robots.txt')).body; html = (await app.inject('/')).body; }
  finally { await app.close(); }
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const container = document.createElement('div');
  container.innerHTML = parsed.getElementById('root').innerHTML;
  document.body.appendChild(container);
  expect(container).toHaveTextContent('ChatGPT Plus');
  const serverGuide = container.querySelector('.purchase-guide-brief');
  expect(serverGuide).toHaveTextContent('第一次购买？');
  expect(serverGuide.querySelector('ol')).toBeNull();
  expect(container.querySelectorAll('a[href="/guide"]')).toHaveLength(1);
  window.history.replaceState({}, '', '/');
  vi.stubGlobal('fetch', vi.fn(async (input, options) => {
    const url = String(input);
    if (url === '/api/assistant/status' && options?.method === 'GET') return Response.json({ enabled: false });
    if (!allowedByRobots(robots, url)) throw new Error('Blocked by robots.txt');
    if (url.startsWith('/api/catalog?')) return Response.json(catalog);
    throw new Error('Unexpected request');
  }));
  render(<VirtuosoMockContext.Provider value={{ viewportHeight: 900, itemHeight: 300 }}><App /></VirtuosoMockContext.Provider>, { container });
  expect(await screen.findByText('ChatGPT Plus')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /查看选购说明/ })).toHaveAttribute('href', '/guide');
  const inlineGuide = container.querySelector('.purchase-guide-brief');
  expect(inlineGuide).toHaveTextContent('第一次购买？');
  expect(inlineGuide.querySelector('ol')).toBeNull();
  expect(inlineGuide.querySelector('h2')).toBeNull();
  expect(inlineGuide.querySelector('details')).toBeNull();
  expect(inlineGuide.querySelector('a')).toHaveAttribute('href', '/guide');
  expect(container.querySelectorAll('a[href="/guide"]')).toHaveLength(1);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(allowedByRobots(robots, '/api/quality/catalog')).toBe(true);
  expect(allowedByRobots(robots, '/api/quality/tasks/private')).toBe(false);
  expect(allowedByRobots(robots, '/api/catalog-admin')).toBe(false);
  expect(allowedByRobots(robots, '/api/catalog/products')).toBe(true);
  expect(allowedByRobots(robots, '/api/catalog/products?x=1')).toBe(true);
  expect(allowedByRobots(robots, '/api/catalog/products/42')).toBe(true);
  expect(allowedByRobots(robots, '/api/catalog/products-private')).toBe(false);
});

test.each([false, true])('guide preserves no-script content and requests only assistant status GET (enabled=%s)', async enabled => {
  const adapter = new FastifyAdapter();
  const noData = async () => { throw new Error('guide must not request data'); };
  registerPublicPages(adapter, { template: '<html><head><title>Site</title></head><body><div id="root"></div></body></html>',
    getCatalog: noData, getProducts: noData, getProduct: noData });
  let html;
  try { html = (await adapter.getInstance().inject('/guide')).body; }
  finally { await adapter.getInstance().close(); }
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const normalize = value => value.replace(/\s+/gu, ' ').trim();
  const expectedText = normalize(parsed.querySelector('main').textContent);
  const expectedIds = [...parsed.querySelectorAll('main [id]')].map(node => node.id);
  let resolveStatus;
  const status = new Promise(resolve => { resolveStatus = resolve; });
  const fetch = vi.fn((input, options) => {
    if (input === '/api/assistant/status' && options?.method === 'GET') return status;
    throw new Error('guide must request only assistant status GET');
  });
  vi.stubGlobal('fetch', fetch);
  window.history.replaceState({}, '', '/guide#duration');
  const { container } = render(<App />);
  expect(normalize(container.querySelector('main').textContent)).toBe(expectedText);
  expect([...container.querySelectorAll('main [id]')].map(node => node.id)).toEqual(expectedIds);
  expect(document.title).toBe(parsed.title);
  expect(document.querySelector('link[rel="canonical"]').href).toBe('https://price.yufu.pub/guide');
  expect(screen.queryByRole('button', { name: '打开导购助手' })).not.toBeInTheDocument();
  await act(async () => { resolveStatus(Response.json({ enabled })); });
  expect(Boolean(screen.queryByRole('button', { name: '打开导购助手' }))).toBe(enabled);
  expect(normalize(container.querySelector('main').textContent)).toBe(expectedText);
  expect([...container.querySelectorAll('main [id]')].map(node => node.id)).toEqual(expectedIds);
  expect(document.title).toBe(parsed.title);
  expect(document.querySelector('link[rel="canonical"]').href).toBe('https://price.yufu.pub/guide');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith('/api/assistant/status', expect.objectContaining({ method: 'GET', cache: 'no-store' }));
});

test('product client retains server structured offers and removes them when quotes expire', async () => {
  const product = { id: '42', name: 'ChatGPT Plus', platform: 'openai', kind: '账号与订阅' };
  const offer = { shopId: '7', productId: '9', shop: '示例商铺', name: '月付报价', price: '12.50', settlementQuantity: 1,
    currency: 'CNY', priceStatus: 'verified', priceExpiresAt: '2099-01-01T00:00:00Z', inventoryExpiresAt: '2099-01-01T00:00:00Z',
    productUrl: 'https://shop.example/product/9', capturedAt: '2026-10-30T00:00:00Z', inStock: true, tags: [] };
  const catalog = () => ({ items: [{ ...product, standardProductId: '42', offers: [offer],
    detail: { kind: 'offers', entries: [offer], total: 1, page: 0, pageSize: 12 } }], total: 1, platformFacets: [] });
  const adapter = new FastifyAdapter();
  registerPublicPages(adapter, { template: '<html><head><title>Site</title></head><body><div id="root"></div></body></html>',
    getCatalog: async () => catalog(), getProducts: async () => ({ items: [product] }), getProduct: async () => product });
  let html;
  try { html = (await adapter.getInstance().inject('/products/42')).body; }
  finally { await adapter.getInstance().close(); }
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.head.innerHTML = parsed.head.innerHTML;
  const expected = JSON.parse(document.querySelector('#page-structured-data').textContent);
  expect(expected.offers).toHaveLength(1);
  window.history.replaceState({}, '', '/products/42');
  vi.stubGlobal('fetch', vi.fn(async (input, options) => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/assistant/status' && options?.method === 'GET') return Response.json({ enabled: false });
    if (url.pathname === '/api/catalog/products/42') return Response.json(product);
    if (url.pathname === '/api/catalog') return Response.json(catalog());
    return new Response(null, { status: 204 });
  }));
  render(<VirtuosoMockContext.Provider value={{ viewportHeight: 900, itemHeight: 300 }}><App /></VirtuosoMockContext.Provider>);
  await screen.findByRole('heading', { level: 1, name: product.name });
  await screen.findByText('月付报价');
  expect(JSON.parse(document.querySelector('#page-structured-data').textContent)).toEqual(expected);
  offer.priceExpiresAt = '2000-01-01T00:00:00Z';
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  await waitFor(() => expect(JSON.parse(document.querySelector('#page-structured-data').textContent).offers).toBeUndefined());
});

test('home client keeps cursor pagination and resets it when searching', async () => {
  const cursor = 'eyJ2IjoyLCJzIjoiMCIsInNwIjoiNDIifQ';
  const nextCursor = 'eyJ2IjoyLCJzIjoiMCIsInNwIjoiNDMifQ';
  const calls = [];
  window.history.replaceState({}, '', '/?cursor=' + cursor);
  localStorage.setItem('catalog-browsing-mode', 'newcomer');
  vi.stubGlobal('fetch', vi.fn(async (input, options) => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/assistant/status' && options?.method === 'GET') return Response.json({ enabled: false });
    if (url.pathname !== '/api/catalog') return new Response(null, { status: 204 });
    calls.push(url);
    const searching = Boolean(url.searchParams.get('q'));
    return Response.json({ total: 60, platformFacets: [], nextCursor: searching ? undefined : nextCursor,
      items: [{ id: searching ? '44' : '43', name: searching ? '搜索结果' : '续页商品', platform: 'openai', offers: [] }] });
  }));
  render(<VirtuosoMockContext.Provider value={{ viewportHeight: 900, itemHeight: 300 }}><App /></VirtuosoMockContext.Provider>);
  await screen.findByRole('link', { name: '续页商品' });
  expect(calls[0].searchParams.get('cursor')).toBe(cursor);
  expect(document.querySelector('link[rel="canonical"]').href).toBe('https://price.yufu.pub/?cursor=' + cursor);
  expect(screen.getByRole('link', { name: '下一页商品' })).toHaveAttribute('href', '/?cursor=' + nextCursor);
  const search = screen.getByRole('textbox', { name: '搜索商品' });
  fireEvent.change(search, { target: { value: '搜索' } });
  fireEvent.keyDown(search, { key: 'Enter' });
  await screen.findByRole('link', { name: '搜索结果' });
  expect(calls.at(-1).searchParams.has('cursor')).toBe(false);
  expect(new URLSearchParams(window.location.search).has('cursor')).toBe(false);
  expect(document.querySelector('link[rel="canonical"]').href).toBe('https://price.yufu.pub/');
});

test.each([503, 200])('completed quote loading with no visible offers clears the server offers (HTTP %s)', async status => {
  const product = { id: '42', name: 'ChatGPT Plus', platform: 'openai', kind: '账号与订阅' };
  document.head.insertAdjacentHTML('beforeend', '<link rel="canonical" href="https://price.yufu.pub/products/42">'
    + '<script id="page-structured-data" type="application/ld+json">'
    + JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name: product.name,
      url: 'https://price.yufu.pub/products/42', offers: [{ '@type': 'Offer', price: '12.50', priceCurrency: 'CNY' }] }) + '</script>');
  window.history.replaceState({}, '', '/products/42');
  vi.stubGlobal('fetch', vi.fn(async (input, options) => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/assistant/status' && options?.method === 'GET') return Response.json({ enabled: false });
    if (url.pathname === '/api/catalog/products/42') return Response.json(product);
    if (url.pathname === '/api/catalog') return status === 200 ? Response.json({ items: [], total: 0, platformFacets: [] }) : new Response(null, { status });
    return new Response(null, { status: 204 });
  }));
  render(<App />);
  await screen.findByText(status === 200 ? '没有匹配的报价' : '报价加载失败，请重试');
  expect(JSON.parse(document.querySelector('#page-structured-data').textContent).offers).toBeUndefined();
});
