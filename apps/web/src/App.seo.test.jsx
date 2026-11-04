import React from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { SITE_NAME } from '@price-comparison/catalog/site-brand';
import App from './App.jsx';

vi.mock('./PublicPage.jsx', () => ({ default: () => <main>商品比价</main> }));
vi.mock('./QualityToolsPage.jsx', () => ({ default: () => <main>检测工具</main> }));
vi.mock('./AdminPage.jsx', () => ({ default: () => <main>管理</main> }));
const originalHead = document.head.innerHTML;
afterEach(() => { cleanup(); document.head.innerHTML = originalHead; window.history.replaceState({}, '', '/'); });
const meta = name => document.querySelector('meta[name="' + name + '"]')?.content;
const canonical = () => document.querySelector('link[rel="canonical"]')?.getAttribute('href');
function navigate(path) { window.history.pushState({}, '', path); fireEvent(window, new PopStateEvent('popstate')); }

test('client navigation keeps metadata aligned and removes private page structured data', () => {
  window.history.replaceState({}, '', '/');
  render(<App />);
  expect(document.title).toBe('AI 订阅与账号价格比较 - ' + SITE_NAME);
  expect(canonical()).toBe('https://price.yufu.pub/');
  expect(meta('robots')).toContain('index, follow');
  navigate('/tools');
  expect(document.title).toBe('AI 与 IP 检测工具 - ' + SITE_NAME);
  expect(document.querySelector('meta[property="og:title"]').content).toBe(document.title);
  expect(meta('twitter:title')).toBe(document.title);
  expect(canonical()).toBe('https://price.yufu.pub/tools');
  expect(meta('description')).toContain('IP');
  expect(document.querySelector('meta[property="og:url"]')?.content).toBe('https://price.yufu.pub/tools');
  navigate('/admin/');
  expect(meta('robots')).toContain('noindex');
  expect(document.querySelector('#page-structured-data')).toBeNull();
  navigate('/');
  expect(meta('robots')).not.toContain('noindex');
  expect(canonical()).toBe('https://price.yufu.pub/');
  expect(document.querySelectorAll('meta[name="description"]')).toHaveLength(1);
  expect(document.querySelectorAll('#page-structured-data')).toHaveLength(1);
});

test('client preserves server configured canonical origin rather than browser host and tracking query', () => {
  document.head.insertAdjacentHTML('beforeend', '<link rel="canonical" href="https://comparison.example/">');
  window.history.replaceState({}, '', '/tools?utm_source=example');
  render(<App />);
  expect(canonical()).toBe('https://comparison.example/tools');
  expect(document.title).toBe('AI 与 IP 检测工具 - ' + SITE_NAME);
});
