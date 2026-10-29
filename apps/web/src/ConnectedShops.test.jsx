import { beforeEach, expect, test, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminPage from './AdminPage.jsx';

const shop = (id, name) => ({ id, name, url: `https://shop${id}.example/`, platform: '测试平台', enabled: true });
const paged = (items, total = items.length, page = 1) => ({ items, total, page, pageSize: 10 });
beforeEach(() => vi.unstubAllGlobals());

test('shop search resets pagination and persists across pages and recycle bin', async () => {
  const user = userEvent.setup();
  const requests = [];
  const active = [...Array.from({ length: 11 }, (_, i) => shop(i + 1, `日常商铺${i + 1}`)), ...Array.from({ length: 12 }, (_, i) => shop(i + 12, `速启商铺${i + 1}`))];
  const deleted = [shop(30, '速启归档'), shop(31, '其他归档')];
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname !== '/api/admin/shops') return Response.json({ ok: true, ...paged([]) });
    const params = url.searchParams;
    requests.push(Object.fromEntries(params));
    const items = (params.get('status') === 'deleted' ? deleted : active).filter(item => item.name.includes(params.get('keyword') || ''));
    const page = Number(params.get('page'));
    return Response.json(paged(items.slice((page - 1) * 10, page * 10), items.length, page));
  }));
  render(<AdminPage initialAuthenticated />);
  await user.click(await screen.findByRole('button', { name: '商铺管理' }));
  await screen.findByText('日常商铺1');
  await user.click(screen.getByRole('button', { name: '下一页' }));
  await screen.findByText('第 2 / 3 页，共 23 条');
  const search = screen.getByRole('textbox', { name: '搜索商铺' });
  await user.type(search, ' 速启 ');
  await screen.findByText('第 1 / 2 页，共 12 条');
  expect(requests.at(-1)).toMatchObject({ keyword: '速启', page: '1', status: 'active' });
  expect(screen.queryByText('日常商铺11')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '下一页' }));
  await screen.findByText('第 2 / 2 页，共 12 条');
  expect(requests.at(-1)).toMatchObject({ keyword: '速启', page: '2' });
  await user.click(screen.getByRole('checkbox', { name: '回收站' }));
  await screen.findByText('速启归档');
  expect(requests.at(-1)).toMatchObject({ keyword: '速启', page: '1', status: 'deleted' });
  expect(screen.queryByText('其他归档')).not.toBeInTheDocument();
  await user.clear(search);
  await screen.findByText('其他归档');
  expect(requests.at(-1)).not.toHaveProperty('keyword');
  await user.type(search, '不存在');
  expect(await screen.findByText('没有匹配的商铺')).toBeInTheDocument();
});

test('older shop search responses cannot replace the current results', async () => {
  const user = userEvent.setup();
  let resolveOld;
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname !== '/api/admin/shops') return Response.json({ ok: true, ...paged([]) });
    if (url.searchParams.get('keyword') === '旧') return new Promise(resolve => { resolveOld = resolve; });
    return Response.json(paged([shop(1, url.searchParams.get('keyword') === '新' ? '新结果商铺' : '初始商铺')]));
  }));
  render(<AdminPage initialAuthenticated />);
  await user.click(await screen.findByRole('button', { name: '商铺管理' }));
  await screen.findByText('初始商铺');
  const search = screen.getByRole('textbox', { name: '搜索商铺' });
  await user.type(search, '旧');
  await waitFor(() => expect(resolveOld).toBeTypeOf('function'));
  await user.clear(search);
  await user.type(search, '新');
  await screen.findByText('新结果商铺');
  await act(async () => { resolveOld(Response.json(paged([shop(2, '旧结果商铺')]))); });
  expect(screen.getByText('新结果商铺')).toBeInTheDocument();
  expect(screen.queryByText('旧结果商铺')).not.toBeInTheDocument();
});
