import React from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import App from './App.jsx';
import PurchaseGuide from './PurchaseGuide.jsx';
import { PURCHASE_GUIDE_CONTENT, PURCHASE_GUIDE_FIELDS, PURCHASE_GUIDE_GROUPS } from '@price-comparison/catalog/purchase-guide-content';

afterEach(() => { cleanup(); window.history.replaceState({}, '', '/'); });
test('guide is directly readable with stable field anchors and ordinary navigation links', () => {
  window.history.replaceState({}, '', '/guide/?from=offer#duration');
  const { container } = render(<App />);
  expect(screen.getByRole('heading', { level: 1, name: '新手选购指南' })).toBeInTheDocument();
  expect(screen.getByRole('navigation', { name: '按购买需求阅读' })).toBeInTheDocument();
  for (const [name, field] of Object.entries(PURCHASE_GUIDE_FIELDS)) {
    expect(document.getElementById(name)).toHaveTextContent(field.explanation);
  }
  expect(document.getElementById('duration')).toBeVisible();
  expect(screen.getByRole('link', { name: '返回商品列表' })).toHaveAttribute('href', '/');
  expect(document.querySelector('link[rel="canonical"]')).toHaveAttribute('href', 'https://price.yufu.pub/guide');
});

test('guide opens the matching glossary group before scrolling to field and group anchors', () => {
  window.history.replaceState({}, '', '/guide#duration');
  const { container } = render(<App />);
  expect(document.getElementById('duration').closest('details')).toHaveAttribute('open');
  expect(document.getElementById('delivery').closest('details')).not.toHaveAttribute('open');
  const delivery = document.getElementById('delivery');
  delivery.scrollIntoView = vi.fn();
  window.history.replaceState({}, '', '/guide#delivery');
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  expect(delivery.scrollIntoView).toHaveBeenCalledOnce();
  expect(delivery).toBeVisible();
  expect(delivery.closest('details')).toHaveAttribute('open');
  window.history.replaceState({}, '', '/guide#guide-warranty');
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  expect(container.querySelector('#guide-warranty')).toHaveAttribute('open');
  expect(container.querySelector('#guide-scenarios').tagName).toBe('H2');
});


test('homepage guide stays a lightweight link without expanded instructions', () => {
  const { container } = render(<PurchaseGuide />);
  expect(container).toHaveTextContent('第一次购买？');
  expect(container.querySelector('details')).toBeNull();
  expect(container.querySelector('ol')).toBeNull();
  expect(container.querySelector('h2')).toBeNull();
  expect(screen.getByRole('link', { name: /查看选购说明/ })).toHaveAttribute('href', '/guide');
});

test('guide entry carries the product URL including search and filters', () => {
  const source = '/products/42?keyword=%E6%9C%88%E4%BB%98&offerSort=priceDesc';
  window.history.replaceState({}, '', source);
  render(<PurchaseGuide />);
  const url = new URL(screen.getByRole('link', { name: /查看选购说明/ }).href);
  expect(url.pathname).toBe('/guide');
  expect(url.searchParams.get('returnTo')).toBe(source);
});

test('guide returns to the originating product after opening a field anchor', () => {
  const source = '/products/42?keyword=%E6%9C%88%E4%BB%98&offerSort=priceDesc';
  window.history.replaceState({}, '', `/guide?returnTo=${encodeURIComponent(source)}#duration`);
  render(<App />);
  expect(screen.getByRole('link', { name: '返回商品详情' })).toHaveAttribute('href', source);
});

test('guide entry uses the latest filters when the URL changes after rendering', () => {
  window.history.replaceState({}, '', '/products/42?offerSort=price');
  render(<PurchaseGuide />);
  const source = '/products/42?offerSort=priceDesc';
  window.history.replaceState({}, '', source);
  const link = screen.getByRole('link', { name: /查看选购说明/ });
  fireEvent.contextMenu(link);
  expect(new URL(link.href).searchParams.get('returnTo')).toBe(source);
});

test('guide returns to the filtered homepage', () => {
  const source = '/?q=Plus&platform=openai';
  window.history.replaceState({}, '', `/guide?returnTo=${encodeURIComponent(source)}`);
  render(<App />);
  expect(screen.getByRole('link', { name: '返回商品列表' })).toHaveAttribute('href', source);
});

test.each(['https://example.com/products/42', '//example.com/products/42', '/admin', 'javascript:alert(1)'])('guide rejects unrelated return destinations: %s', source => {
  window.history.replaceState({}, '', `/guide?returnTo=${encodeURIComponent(source)}`);
  render(<App />);
  expect(screen.getByRole('link', { name: '返回商品列表' })).toHaveAttribute('href', '/');
});

test('guide helps choose a purchase type, compare conditions and ask concrete questions', () => {
  window.history.replaceState({}, '', '/guide');
  const { container } = render(<App />);
  expect(document.body).toHaveClass('guide-shell');
  const backLink = screen.getByRole('link', { name: '返回商品列表' });
  expect(backLink).toHaveClass('product-back-link');
  expect(backLink).toHaveAttribute('href', '/');
  expect(backLink.closest('header')).toContainElement(screen.getByRole('heading', { level: 1 }));
  expect(screen.queryByRole('navigation', { name: '网站导航' })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: '商品比价' })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: '检测工具' })).not.toBeInTheDocument();
  expect(container).toHaveTextContent(PURCHASE_GUIDE_CONTENT.introduction);
  const navigation = screen.getByRole('navigation', { name: '按购买需求阅读' });
  for (const scenario of PURCHASE_GUIDE_CONTENT.scenarios) {
    const link = navigation.querySelector(`a[href="#${scenario.id}"]`);
    expect(link).toHaveTextContent(scenario.title);
    const target = document.getElementById(scenario.id);
    expect(target).toBeVisible();
    expect(target).toHaveTextContent(scenario.question);
  }
  expect(screen.getByRole('table', { name: '同样写着一个月，为什么不能只比价格？' })).toBeVisible();
  expect(container).toHaveTextContent('以下为虚构示例，不是实时报价。');
  for (const item of PURCHASE_GUIDE_CONTENT.checklist) expect(container).toHaveTextContent(item.text);
  for (const group of PURCHASE_GUIDE_GROUPS) {
    const details = document.getElementById(`guide-${group.id}`);
    expect(details.tagName).toBe('DETAILS');
    expect(details).not.toHaveAttribute('open');
    fireEvent.click(details.querySelector('summary'));
    expect(details).toHaveAttribute('open');
  }
});
