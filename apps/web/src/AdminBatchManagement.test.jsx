import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminPage from './AdminPage.jsx';

describe.each([
  { tab: '标准商品', path: 'standard-products', batch: 'batch-visibility', field: 'ids', status: 'active', inactive: 'hidden', filter: '标准商品状态', action: '批量隐藏', restore: '批量展示', pageLabel: '选择当前页标准商品', check: '选择 ', payload: { hidden: true }, items: [{ id: '11', name: '标准甲', hidden: false }, { id: '12', name: '标准乙', hidden: false }] },
  { tab: '商品平台', path: 'platforms', batch: 'batch-status', field: 'names', status: 'enabled', inactive: 'disabled', filter: '商品平台状态', action: '批量停用', restore: '批量启用', pageLabel: '选择当前页商品平台', check: '选择商品平台 ', payload: { enabled: false }, items: [{ id: '平台甲', name: '平台甲', enabled: true }, { id: '平台乙', name: '平台乙', enabled: true }] },
])('$tab 批量管理', config => {
  beforeEach(() => { vi.unstubAllGlobals(); vi.stubGlobal('confirm', vi.fn(() => true)); });
  function install(onBatch = async () => ({ success: [config.items[0].id], skipped: [], conflicts: [{ id: config.items[1].id, reason: '状态已变化' }] })) {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      const url = new URL(input, 'http://localhost');
      if (url.pathname === `/api/admin/${config.path}/${config.batch}`) {
        const body = JSON.parse(init.body); calls.push(body);
        return onBatch(body);
      }
      if (url.pathname === `/api/admin/${config.path}`) {
        const status = url.searchParams.get('status');
        const keyword = url.searchParams.get('keyword');
        return Response.json({ items: status === config.status ? (keyword ? [config.items[1]] : [config.items[0]]) : [], total: keyword ? 1 : 11, page: Number(url.searchParams.get('page') || 1), pageSize: 10 });
      }
      if (url.pathname === '/api/auth/me') return Response.json({ ok: true });
      return Response.json({ items: [], total: 0, page: 1, pageSize: 10 });
    }));
    return calls;
  }
  async function open(user) {
    render(<AdminPage initialAuthenticated />);
    await user.click(await screen.findByRole('button', { name: '商品管理' }));
    await user.click(screen.getByRole('button', { name: config.tab }));
    await screen.findByRole('checkbox', { name: config.check + config.items[0].name });
  }
  test('默认在用筛选，跨搜索保留选择，一次提交且保留失败项供重试', async () => {
    const user = userEvent.setup();
    const calls = install(async () => Response.json({ success: [config.items[0].id], skipped: [], conflicts: [{ id: config.items[1].id, reason: '状态已变化' }] }));
    await open(user);
    expect(screen.getByLabelText(config.filter)).toHaveValue(config.status);
    await user.click(screen.getByRole('checkbox', { name: config.pageLabel }));
    await user.type(screen.getByRole('textbox', { name: `搜索${config.tab}` }), '乙');
    await user.click(await screen.findByRole('checkbox', { name: config.check + config.items[1].name }));
    await user.click(screen.getByRole('button', { name: config.action }));
    expect(await screen.findByText(/成功 1.*失败 1.*状态已变化/)).toBeInTheDocument();
    expect(calls).toEqual([{ [config.field]: config.items.map(item => item.id), ...config.payload }]);
    expect(screen.getByRole('checkbox', { name: config.check + config.items[1].name })).toBeChecked();
    await user.click(screen.getByRole('button', { name: config.action }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1][config.field]).toEqual([config.items[1].id]);
    await user.selectOptions(screen.getByLabelText(config.filter), config.inactive);
    expect(await screen.findByText(`暂无${config.tab}`)).toBeInTheDocument();
  });
  test('取消不提交，请求进行中禁止重复操作，失败后保留选择', async () => {
    const user = userEvent.setup();
    let reject;
    const calls = install(() => new Promise((_, rejectRequest) => { reject = rejectRequest; }));
    await open(user);
    await user.click(screen.getByRole('checkbox', { name: config.pageLabel }));
    window.confirm.mockReturnValueOnce(false);
    await user.click(screen.getByRole('button', { name: config.action }));
    expect(calls).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: config.action }));
    expect(screen.getByRole('button', { name: config.restore })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: config.pageLabel })).toBeDisabled();
    expect(screen.getByLabelText(config.filter)).toBeDisabled();
    expect(calls).toHaveLength(1);
    reject(new Error('网络断开'));
    expect(await screen.findByText(/网络断开/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: config.check + config.items[0].name })).toBeChecked();
    expect(screen.getByRole('button', { name: config.action })).toBeEnabled();
  });
});

test('已停用平台列表不污染标准商品编辑选项，仍可保留原平台或选择启用平台', async () => {
  vi.unstubAllGlobals();
  const user = userEvent.setup(), writes = [];
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/auth/me') return Response.json({ ok: true });
    if (init?.method === 'PATCH') { writes.push(JSON.parse(init.body)); return Response.json({ ok: true }); }
    let items = [];
    if (url.pathname === '/api/admin/platforms') items = url.searchParams.get('status') === 'disabled' ? [{ id: '停用平台', name: '停用平台', enabled: false }] : [{ id: '启用平台', name: '启用平台', enabled: true }];
    if (url.pathname === '/api/admin/standard-products') items = [{ id: '11', name: '已有商品', platform: '历史平台', hidden: false }];
    return Response.json({ items, total: items.length, page: 1, pageSize: 10 });
  }));
  render(<AdminPage initialAuthenticated />);
  await user.click(await screen.findByRole('button', { name: '商品管理' }));
  await user.click(screen.getByRole('button', { name: '商品平台' }));
  await user.selectOptions(await screen.findByLabelText('商品平台状态'), 'disabled');
  await screen.findByRole('checkbox', { name: '选择商品平台 停用平台' });
  await user.click(screen.getByRole('button', { name: '标准商品' }));
  const row = (await screen.findByLabelText('标准商品名称 已有商品')).closest('.standard-product-row');
  const select = within(row).getByRole('combobox');
  expect(await within(select).findByRole('option', { name: '启用平台' })).toBeInTheDocument();
  expect(within(select).queryByRole('option', { name: '停用平台' })).not.toBeInTheDocument();
  expect(select).toHaveValue('历史平台');
  await user.selectOptions(select, '启用平台');
  await user.click(within(row).getByRole('button', { name: '保存' }));
  await waitFor(() => expect(writes).toEqual([{ name: '已有商品', platform: '启用平台' }]));
});
