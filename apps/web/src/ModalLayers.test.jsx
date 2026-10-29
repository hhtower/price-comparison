import React from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminPage from './AdminPage.jsx';
import PublicPage from './PublicPage.jsx';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/admin/shops') return Response.json({ items: [{ id: '1', name: '测试商铺', url: 'https://shop.example/', platform: '测试平台', enabled: true }], total: 1, page: 1 });
    if (url.pathname === '/api/admin/products') return Response.json({ items: [{ id: '3', name: '测试商品', shopName: '测试商铺', tags: [] }], total: 1, page: 1 });
    if (url.pathname === '/api/admin/tags') return Response.json({ items: [{ id: '1', name: '地区', value: '美国', productCount: 1 }, { id: '2', name: '地区', value: '加拿大', productCount: 1 }], total: 2, page: 1 });
    return Response.json({ items: [], total: 0, page: 1, platforms: [], configured: true, job: null });
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test.each(['新增商铺', '编辑商铺'])('%s enters the native modal layer and can reopen after Escape', async title => {
  const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
  const user = userEvent.setup();
  render(<AdminPage initialAuthenticated />);
  await user.click(screen.getByRole('button', { name: '商铺管理' }));
  const trigger = await screen.findByRole('button', { name: title === '新增商铺' ? title : '编辑', exact: true });
  await user.click(trigger);
  const dialog = screen.getByRole('dialog', { name: title });
  expect(showModal.mock.contexts).toContain(dialog);
  fireEvent(dialog, new Event('cancel', { cancelable: true }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await user.click(trigger);
  expect(screen.getByRole('dialog', { name: title })).toHaveAttribute('open');
  await user.click(within(dialog).getByRole('button', { name: '取消' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test.each([
  ['商品平台', '新增商品平台', '新增商品平台'],
  ['标准商品', '新增标准商品', '新增标准商品'],
  ['任务台', '新建任务', '新建任务'],
])('%s opens %s in the native modal layer', async (tab, trigger, title) => {
  const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
  const user = userEvent.setup();
  render(<AdminPage initialAuthenticated />);
  await user.click(screen.getByRole('button', { name: '商品管理' }));
  await user.click(screen.getByRole('button', { name: tab, exact: true }));
  if (tab === '任务台') await user.click(screen.getByRole('tab', { name: '标准化' }));
  await user.click(await screen.findByRole('button', { name: trigger, exact: true }));
  const dialog = screen.getByRole('dialog', { name: title });
  expect(showModal.mock.contexts).toContain(dialog);
  fireEvent(dialog, new Event('cancel', { cancelable: true }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('public shop submission enters the native modal layer and closes on Escape', async () => {
  const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
  const user = userEvent.setup();
  render(<PublicPage />);
  await user.click(screen.getByRole('button', { name: '提交商铺', exact: true }));
  const dialog = screen.getByRole('dialog', { name: '提交商铺地址' });
  expect(showModal.mock.contexts).toContain(dialog);
  fireEvent(dialog, new Event('cancel', { cancelable: true }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test.each([
  ['编辑标签', '编辑商品标签'],
  ['绑定标签', '绑定标签'],
  ['绑定标准商品', '选择标准商品'],
])('%s opens a modal for the selected product', async (trigger, title) => {
  const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
  const user = userEvent.setup();
  render(<AdminPage initialAuthenticated />);
  await user.click(screen.getByRole('button', { name: '商品管理' }));
  await user.click(screen.getByRole('button', { name: '待处理', exact: true }));
  await user.click(await screen.findByRole('checkbox', { name: '选择 测试商品', exact: true }));
  await user.click(screen.getByRole('button', { name: trigger, exact: true }));
  const dialog = await screen.findByRole('dialog', { name: title });
  expect(showModal.mock.contexts).toContain(dialog);
  fireEvent(dialog, new Event('cancel', { cancelable: true }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('tag merging opens a modal and releases it when the page unmounts', async () => {
  const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
  const close = vi.spyOn(HTMLDialogElement.prototype, 'close');
  const user = userEvent.setup();
  const { unmount } = render(<AdminPage initialAuthenticated />);
  await user.click(screen.getByRole('button', { name: '商品管理' }));
  await user.click(screen.getByRole('button', { name: '标签', exact: true }));
  await user.click(await screen.findByRole('checkbox', { name: '选择标签 地区：美国' }));
  await user.click(screen.getByRole('checkbox', { name: '选择标签 地区：加拿大' }));
  await user.click(screen.getByRole('button', { name: '合并标签值', exact: true }));
  const dialog = screen.getByRole('dialog', { name: '合并标签值' });
  expect(showModal.mock.contexts).toContain(dialog);
  unmount();
  expect(close.mock.contexts).toContain(dialog);
  expect(dialog.open).toBe(false);
});
