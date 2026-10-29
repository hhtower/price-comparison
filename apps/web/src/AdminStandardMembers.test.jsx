import { beforeEach, expect, test, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminPage from './AdminPage.jsx';

const paged = (items, total = items.length, page = 1) => ({ items, total, page, pageSize: 10 });
const standard = { id: '11', name: '标准甲', memberCount: '12', shopCount: '2' };
const product = { id: '21', name: '原始甲', shopId: '31', shopName: '商铺甲', standardProductName: '标准甲', url: 'https://shop.example/product', tags: [] };
const shop = { id: '31', name: '商铺甲', url: 'https://shop.example', platform: '平台甲', enabled: false };
beforeEach(() => vi.unstubAllGlobals());

for (const initialConflict of ['当前属于标准商品 10', '发布证据冲突：套餐不一致']) {
  test(`确认${initialConflict}后仍提示目标不会在前台展示`, async () => {
    const user = userEvent.setup();
    const notice = '目标标准商品未通过身份验证或已隔离，绑定后不会在前台展示';
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      const url = new URL(input, 'http://localhost');
      if (url.pathname === '/api/admin/products') return Response.json(paged([product]));
      if (url.pathname === '/api/admin/standard-products') return Response.json(paged([standard]));
      if (url.pathname.endsWith('/standard-products/bind')) {
        const body = JSON.parse(init.body);
        return Response.json(body.confirmOwnershipChange
          ? { success: ['21'], skipped: [], conflicts: [], notice }
          : { success: [], skipped: [], conflicts: [{ id: '21', reason: initialConflict }], notice });
      }
      return Response.json(paged([]));
    }));
    render(<AdminPage initialAuthenticated />);
    await user.click(await screen.findByRole('button', { name: '商品管理' }));
    await user.click(await screen.findByRole('button', { name: '选择标准商品' }));
    await user.click(await within(screen.getByRole('dialog')).findByRole('button', { name: /标准甲/ }));
    expect(await screen.findByText(`绑定完成：成功 1，跳过 0，冲突 0。${notice}`)).toBeVisible();
  });
}

test('绑定弹窗显示接口提供的成员数和店铺数，包括真实零值', async () => {
  const user = userEvent.setup();
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/admin/products') return Response.json(paged([product]));
    if (url.pathname === '/api/admin/standard-products') return Response.json(paged([standard, { id: '12', name: '空标准', memberCount: '0', shopCount: '0' }]));
    return Response.json(paged([]));
  }));
  render(<AdminPage initialAuthenticated />);
  await user.click(await screen.findByRole('button', { name: '商品管理' }));
  await user.click(await screen.findByRole('button', { name: '选择标准商品' }));
  const dialog = screen.getByRole('dialog', { name: '选择标准商品' });
  expect(await within(dialog).findByRole('button', { name: /标准甲.*12 件商品.*2 家商铺/ })).toBeVisible();
  expect(within(dialog).getByRole('button', { name: /空标准.*0 件商品.*0 家商铺/ })).toBeVisible();
});

test('成员穿透保持精确归属筛选、分页和改绑操作，返回后刷新统计', async () => {
  const user = userEvent.setup();
  const requests = [];
  let moved = false;
  vi.stubGlobal('confirm', vi.fn(() => true));
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const url = new URL(input, 'http://localhost');
    requests.push({ path: url.pathname, params: Object.fromEntries(url.searchParams), body: init?.body && JSON.parse(init.body) });
    if (url.pathname === '/api/admin/products/standard-products/bind') {
      if (!JSON.parse(init.body).confirmOwnershipChange) return Response.json({ success: [], skipped: [], conflicts: [{ id: '21', reason: '当前属于标准商品 11' }] });
      moved = true;
      return Response.json({ success: ['21'], skipped: [], conflicts: [] });
    }
    if (url.pathname === '/api/admin/standard-products') return Response.json(paged([{ ...standard, memberCount: moved ? '11' : '12' }, { id: '12', name: '标准乙', memberCount: '4', shopCount: '1' }]));
    if (url.pathname === '/api/admin/products') {
      const scoped = url.searchParams.get('standardProductId') === '11';
      const page = Number(url.searchParams.get('page'));
      return Response.json(paged(scoped ? moved ? [] : [product] : [{ ...product, id: '99', name: '未筛选商品' }], scoped ? moved ? 0 : 12 : 1, page));
    }
    return Response.json(paged([]));
  }));
  render(<AdminPage initialAuthenticated />);
  await user.click(await screen.findByRole('button', { name: '商品管理' }));
  await user.type(screen.getByRole('textbox', { name: '搜索商品' }), '旧搜索');
  await user.click(screen.getByRole('button', { name: '标准商品', exact: true }));
  await user.click(await screen.findByRole('button', { name: '查看 标准甲 的原始商品' }));
  expect(await screen.findByRole('link', { name: '原始甲' })).toHaveAttribute('href', product.url);
  expect(screen.getByRole('button', { name: '标准商品筛选' })).toHaveTextContent('标准甲');
  expect(screen.getByRole('textbox', { name: '搜索商品' })).toHaveValue('');
  expect(screen.queryByText('未筛选商品')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '下一页' }));
  await waitFor(() => expect(requests.filter(r => r.path === '/api/admin/products').at(-1).params).toMatchObject({ standardProductId: '11', page: '2' }));
  await user.type(screen.getByRole('textbox', { name: '搜索商品' }), '原始');
  await waitFor(() => expect(requests.filter(r => r.path === '/api/admin/products').at(-1).params).toMatchObject({ standardProductId: '11', keyword: '原始', page: '1' }));
  await user.click(await screen.findByRole('button', { name: '选择标准商品' }));
  await user.click(await within(screen.getByRole('dialog', { name: '选择标准商品' })).findByRole('button', { name: /标准乙/ }));
  await screen.findByText('绑定完成：成功 1，跳过 0，冲突 0');
  expect(requests.filter(r => r.path.endsWith('/bind')).at(-1).body).toEqual({ productIds: ['21'], standardProductId: '12', confirmOwnershipChange: true });
  await waitFor(() => expect(screen.queryByRole('link', { name: '原始甲' })).not.toBeInTheDocument());
  await user.click(screen.getByRole('button', { name: '返回标准商品' }));
  expect(await screen.findByRole('button', { name: '查看 标准甲 的原始商品' })).toHaveTextContent('11 件');
  await user.click(screen.getByRole('button', { name: '原始商品', exact: true }));
  expect(await screen.findByText('未筛选商品')).toBeVisible();
  expect(requests.filter(r => r.path === '/api/admin/products').at(-1).params).not.toHaveProperty('standardProductId');
});

test('商铺穿透包含停用商铺，可编辑并继续查看该店的绑定商品', async () => {
  const user = userEvent.setup();
  const requests = [];
  let currentShop = shop;
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const url = new URL(input, 'http://localhost');
    requests.push({ path: url.pathname, params: Object.fromEntries(url.searchParams), body: init?.body && JSON.parse(init.body) });
    if (url.pathname === '/api/admin/standard-products') return Response.json(paged([standard]));
    if (url.pathname === '/api/admin/shops/31' && init?.method === 'PATCH') { currentShop = { ...shop, ...JSON.parse(init.body) }; return Response.json(currentShop); }
    if (url.pathname === '/api/admin/shops') return Response.json(paged(url.searchParams.has('standardProductId') && !url.searchParams.has('status') ? [currentShop] : []));
    if (url.pathname === '/api/admin/products') return Response.json(paged(url.searchParams.get('standardProductId') === '11' && url.searchParams.get('shopId') === '31' ? [product] : []));
    return Response.json(paged([]));
  }));
  render(<AdminPage initialAuthenticated />);
  await user.click(await screen.findByRole('button', { name: '商品管理' }));
  await user.click(screen.getByRole('button', { name: '标准商品', exact: true }));
  await user.click(await screen.findByRole('button', { name: '查看 标准甲 的商铺' }));
  expect(await screen.findByText('商铺甲')).toBeVisible();
  expect(screen.getByRole('button', { name: '标准商品筛选' })).toHaveTextContent('标准甲');
  expect(screen.getByText('停用')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '编辑', exact: true }));
  const dialog = screen.getByRole('dialog', { name: '编辑商铺' });
  await user.clear(within(dialog).getByRole('textbox', { name: '商铺名称' }));
  await user.type(within(dialog).getByRole('textbox', { name: '商铺名称' }), '商铺甲更新');
  await user.click(within(dialog).getByRole('button', { name: '保存商铺' }));
  expect(await screen.findByText('商铺甲更新')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '查看绑定商品' }));
  expect(await screen.findByRole('link', { name: '原始甲' })).toBeVisible();
  expect(requests.filter(r => r.path === '/api/admin/products').at(-1).params).toMatchObject({ standardProductId: '11', shopId: '31' });
  expect(screen.getByRole('button', { name: '标准商品筛选' })).toHaveTextContent('标准甲');
  expect(screen.getByRole('combobox', { name: '原始商品商铺' })).toHaveValue('商铺甲更新');
});

test.each(['原始商品', '商铺管理', '穿透商铺'])('%s 可搜索切换标准商品条件，清除时保留关键词并重置分页', async view => {
  const user = userEvent.setup();
  const requests = [];
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const url = new URL(input, 'http://localhost');
    requests.push({ path: url.pathname, params: Object.fromEntries(url.searchParams), method: init?.method || 'GET' });
    if (url.pathname === '/api/admin/standard-products') return Response.json(paged([standard, { ...standard, id: '12', name: '标准乙' }]));
    if (['/api/admin/products', '/api/admin/shops'].includes(url.pathname)) {
      const scoped = url.searchParams.get('standardProductId');
      const record = url.pathname.endsWith('/shops') ? shop : product;
      return Response.json(paged([{ ...record, name: scoped === '12' ? '乙的结果' : scoped ? '甲的结果' : '全部结果' }], 21, Number(url.searchParams.get('page'))));
    }
    return Response.json(paged([]));
  }));
  render(<AdminPage initialAuthenticated />);
  await user.click(await screen.findByRole('button', { name: view === '商铺管理' ? '商铺管理' : '商品管理' }));
  if (view === '穿透商铺') {
    await user.click(screen.getByRole('button', { name: '标准商品', exact: true }));
    await user.click(await screen.findByRole('button', { name: '查看 标准甲 的商铺' }));
  }
  const search = screen.getByRole('textbox', { name: view === '原始商品' ? '搜索商品' : '搜索商铺' });
  const endpoint = view === '原始商品' ? '/api/admin/products' : '/api/admin/shops';
  await user.type(search, '保留关键词');
  await user.click(await screen.findByRole('button', { name: '下一页' }));
  await waitFor(() => expect(requests.filter(r => r.path === endpoint).at(-1).params.page).toBe('2'));
  if (view === '原始商品') await user.click(screen.getByRole('checkbox', { name: '选择 全部结果' }));
  await user.click(screen.getByRole('button', { name: '标准商品筛选' }));
  const dialog = screen.getByRole('dialog', { name: '筛选标准商品' });
  await user.type(within(dialog).getByRole('textbox', { name: '搜索标准商品名' }), '标准乙');
  await waitFor(() => expect(requests.filter(r => r.path === '/api/admin/standard-products').at(-1).params.keyword).toBe('标准乙'));
  await user.click(await within(dialog).findByRole('button', { name: /标准乙/ }));
  expect(await screen.findByText('乙的结果')).toBeVisible();
  expect(screen.getByRole('button', { name: '标准商品筛选' })).toHaveTextContent('标准乙');
  expect(search).toHaveValue('保留关键词');
  expect(requests.filter(r => r.path === endpoint).at(-1).params).toMatchObject({ standardProductId: '12', keyword: '保留关键词', page: '1' });
  expect(screen.queryByText('已选 1 件')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '标准商品筛选' }));
  await user.click(await within(screen.getByRole('dialog', { name: '筛选标准商品' })).findByRole('button', { name: /标准乙/ }));
  expect(await screen.findByText('乙的结果')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '下一页' }));
  await waitFor(() => expect(requests.filter(r => r.path === endpoint).at(-1).params.page).toBe('2'));
  await user.click(screen.getByRole('button', { name: '清除标准商品筛选' }));
  expect(await screen.findByText('全部结果')).toBeVisible();
  expect(screen.getByRole('button', { name: '标准商品筛选' })).toHaveTextContent('全部标准商品');
  expect(search).toHaveValue('保留关键词');
  expect(requests.filter(r => r.path === endpoint).at(-1).params).toMatchObject({ keyword: '保留关键词', page: '1' });
  expect(requests.filter(r => r.path === endpoint).at(-1).params).not.toHaveProperty('standardProductId');
  expect(requests.some(r => r.method !== 'GET')).toBe(false);
});
