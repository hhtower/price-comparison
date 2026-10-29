import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import App from './App.jsx';

const adminChunk = vi.hoisted(() => {
  let resolve;
  const ready = new Promise(done => { resolve = done; });
  return { ready, resolve };
});
vi.mock('./PublicPage.jsx', () => ({ default: () => <main>公开报价页面</main> }));
vi.mock('./AdminPage.jsx', async () => {
  await adminChunk.ready;
  return { default: () => <main><h1>管理端内容</h1></main> };
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/'); });

test('tools route preserves the active tool title on mount and keyboard switching', () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  window.history.replaceState({}, '', '/tools');
  render(<App />);
  expect(document.title).toBe('知途 · 拾价 · AI检测');
  const aiTab = screen.getByRole('tab', { name: 'AI检测' });
  const ipTab = screen.getByRole('tab', { name: 'IP检测' });
  aiTab.focus();
  fireEvent.keyDown(aiTab, { key: 'ArrowRight' });
  expect(ipTab).toHaveFocus();
  expect(ipTab).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('tabpanel', { name: 'IP检测' })).toBeInTheDocument();
  expect(document.title).toBe('知途 · 拾价 · IP检测');
  fireEvent.keyDown(ipTab, { key: 'Home' });
  expect(aiTab).toHaveFocus();
  expect(document.title).toBe('知途 · 拾价 · AI检测');
});

test('public route stays usable before the admin chunk loads and history navigation updates the shell', async () => {
  window.history.replaceState({}, '', '/');
  render(<App />);
  expect(screen.getByText('公开报价页面')).toBeInTheDocument();
  expect(document.body).toHaveClass('public-shell');
  expect(screen.getByRole('button', { name: '官网正价参考' })).toBeInTheDocument();

  window.history.pushState({}, '', '/admin/');
  fireEvent(window, new PopStateEvent('popstate'));
  expect(screen.getByRole('status')).toHaveTextContent('正在加载管理端');
  expect(document.body).toHaveClass('admin-shell');
  expect(screen.queryByRole('button', { name: '官网正价参考' })).not.toBeInTheDocument();
  expect(document.title).toBe('知途 · 拾价 · 管理端');

  await act(async () => { adminChunk.resolve(); });
  expect(await screen.findByRole('heading', { name: '管理端内容' })).toBeInTheDocument();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();

  window.history.pushState({}, '', '/');
  fireEvent(window, new PopStateEvent('popstate'));
  expect(screen.getByText('公开报价页面')).toBeInTheDocument();
  expect(document.body).toHaveClass('public-shell');
  expect(document.title).toBe('知途 · 拾价 - AI 商品价格比较');
});
