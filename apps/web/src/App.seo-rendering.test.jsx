import React from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = String(input);
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

test('guide client and no-script HTML have identical text and anchors without fetching data', async () => {
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
  const fetch = vi.fn(() => { throw new Error('no fetch'); });
  vi.stubGlobal('fetch', fetch);
  window.history.replaceState({}, '', '/guide#duration');
  const { container } = render(<App />);
  expect(normalize(container.querySelector('main').textContent)).toBe(expectedText);
  expect([...container.querySelectorAll('main [id]')].map(node => node.id)).toEqual(expectedIds);
  expect(fetch).not.toHaveBeenCalled();
});
