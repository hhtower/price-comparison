import { expect, test, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import StandardProductPicker, { StandardProductFilter } from './StandardProductPicker.jsx';

beforeEach(() => vi.unstubAllGlobals());

test('绑定选择器请求未合并标准，翻页后搜索 Pro 500 重置页码并可选择', async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  const requests = [];
  vi.stubGlobal('fetch', vi.fn(async input => {
    if (new URL(input, 'http://localhost').pathname.endsWith('/platforms')) return Response.json({ items: [] });
    const params = Object.fromEntries(new URL(input, 'http://localhost').searchParams);
    requests.push(params);
    return Response.json({ items: params.keyword ? [{ id: '5335', name: 'ChatGPT Pro 500' }] : [{ id: '1', name: '初始标准' }], total: params.keyword ? 1 : 11 });
  }));
  render(<StandardProductPicker onSelect={onSelect} onClose={() => {}} />);
  await screen.findByText('初始标准');
  expect(requests[0].status).toBe('unmerged');
  await user.click(screen.getByRole('button', { name: '下一页' }));
  await waitFor(() => expect(requests.at(-1).page).toBe('2'));
  await user.type(screen.getByRole('textbox', { name: '搜索标准商品名' }), 'Chatgpt Pro 500');
  await user.click(await screen.findByRole('button', { name: /ChatGPT Pro 500/ }));
  expect(requests.at(-1)).toMatchObject({ keyword: 'Chatgpt Pro 500', page: '1', status: 'unmerged' });
  expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: '5335' }));
});

test('归属筛选仍可查看所有历史标准', async () => {
  const user = userEvent.setup();
  const fetch = vi.fn(async () => Response.json({ items: [], total: 0 }));
  vi.stubGlobal('fetch', fetch);
  render(<StandardProductFilter value={null} onChange={() => {}} />);
  await user.click(screen.getByRole('button', { name: '标准商品筛选' }));
  await within(screen.getByRole('dialog')).findByText('没有匹配的标准商品名');
  expect(new URL(fetch.mock.calls.find(([input]) => input.startsWith('/api/admin/standard-products?'))[0], 'http://localhost').searchParams.get('status')).toBe('all');
});

test('使用标准实际平台分类，切换分类重置页码且搜索保持分类，全部分类可恢复浏览', async () => {
  const user = userEvent.setup();
  const requests = [];
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = new URL(input, 'http://localhost');
    const params = Object.fromEntries(url.searchParams);
    if (url.pathname.endsWith('/platforms')) return Response.json({ items: ['openai', 'email'] });
    requests.push(params);
    return Response.json({ items: [{ id: '5335', name: 'ChatGPT Pro 500', platform: 'openai' }], total: 11 });
  }));
  render(<StandardProductPicker onSelect={() => {}} onClose={() => {}} />);
  await screen.findByRole('option', { name: '邮箱' });
  await screen.findByText('ChatGPT Pro 500');
  await user.click(screen.getByRole('button', { name: '下一页' }));
  await waitFor(() => expect(requests.at(-1).page).toBe('2'));
  await user.selectOptions(screen.getByRole('combobox', { name: '平台分类' }), 'openai');
  await waitFor(() => expect(requests.at(-1)).toMatchObject({ platform: 'openai', page: '1' }));
  await user.type(screen.getByRole('textbox', { name: '搜索标准商品名' }), 'Pro500');
  await waitFor(() => expect(requests.at(-1)).toMatchObject({ platform: 'openai', keyword: 'Pro500', page: '1' }));
  await user.selectOptions(screen.getByRole('combobox', { name: '平台分类' }), '');
  await waitFor(() => expect(requests.at(-1).platform).toBeUndefined());
});

test('分类加载失败仍可搜索和选择标准商品', async () => {
  vi.stubGlobal('fetch', vi.fn(async input => input.includes('/platforms')
    ? Response.json({ message: '网络异常' }, { status: 503 })
    : Response.json({ items: [{ id: '5335', name: 'ChatGPT Pro 500' }], total: 1 })));
  const onSelect = vi.fn();
  render(<StandardProductPicker onSelect={onSelect} onClose={() => {}} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('分类加载失败');
  await userEvent.click(await screen.findByRole('button', { name: /ChatGPT Pro 500/ }));
  expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: '5335' }));
});
