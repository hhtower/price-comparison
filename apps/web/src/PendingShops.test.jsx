import { beforeEach, expect, test, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminPage from './AdminPage.jsx';

const shops = [
  { id: '7', name: '速启AI', url: 'https://suqiai.cc/', createdAt: '2026-10-03T08:00:00Z' },
  { id: '8', name: '新商铺', url: 'https://example.com/', createdAt: '2026-10-03T09:00:00Z' },
];

function mockApi({ items = shops, review = () => Response.json({ ok: true }) } = {}) {
  let pending = [...items];
  const reviews = [];
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/auth/me') return Response.json({ ok: true });
    if (url.pathname.endsWith('/protocols')) return Response.json({ items: [{ id: '16688', name: '16688' }, { id: 'liandong', name: '联动' }] });
    if (url.pathname === '/api/admin/shop-submissions') {
      const page = Number(url.searchParams.get('page'));
      return Response.json({ items: pending.slice((page - 1) * 10, page * 10), total: pending.length, page, pageSize: 10 });
    }
    const [, id, action] = url.pathname.match(/shop-submissions\/(\d+)\/(approve|reject)$/) ?? [];
    if (action) {
      const call = { id, action, body: JSON.parse(init.body) };
      reviews.push(call);
      const response = await review(call);
      if (response.ok) pending = pending.filter(item => item.id !== id);
      return response;
    }
    throw new Error(`Unexpected request: ${input}`);
  }));
  return reviews;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

test('lists shops without probing protocols and batch approves with server-side verification', async () => {
  const user = userEvent.setup();
  const reviews = mockApi({
    review: ({ id }) => id === '8' ? Response.json({ error: { message: '协议验证失败' } }, { status: 409 }) : Response.json({ ok: true }),
  });
  render(<AdminPage />);
  const table = await screen.findByRole('table', { name: '待审核商铺' });
  expect(within(table).getAllByRole('row')).toHaveLength(3);
  expect((await screen.findAllByRole('button', { name: '通过并抓取' })).every(button => !button.disabled)).toBe(true);
  await user.click(screen.getByRole('checkbox', { name: '选择商铺 速启AI' }));
  expect(screen.getByRole('checkbox', { name: '选择本页商铺' })).toBePartiallyChecked();
  await user.click(screen.getByRole('checkbox', { name: '选择本页商铺' }));
  await user.click(screen.getByRole('button', { name: '批量通过并抓取' }));
  expect(await screen.findByText(/批量通过完成：成功 1，失败 1/)).toHaveTextContent('新商铺：协议验证失败');
  expect(reviews).toEqual([
    { id: '7', action: 'approve', body: {} },
    { id: '8', action: 'approve', body: {} },
  ]);
  expect(screen.queryByRole('checkbox', { name: '选择商铺 速启AI' })).not.toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: '选择商铺 新商铺' })).toBeChecked();
  expect(screen.getByText('已选 1 家')).toBeInTheDocument();
});

test('single-row approval submits the manually selected protocol without prior verification', async () => {
  const user = userEvent.setup();
  const reviews = mockApi();
  render(<AdminPage />);
  const row = await screen.findByRole('row', { name: /速启AI/ });
  await user.selectOptions(within(row).getByLabelText('采集协议'), 'liandong');
  await user.click(within(row).getByRole('button', { name: '通过并抓取' }));
  expect(await screen.findByText('商铺已通过，正在抓取数据')).toBeInTheDocument();
  expect(reviews).toEqual([{ id: '7', action: 'approve', body: { protocol: 'liandong' } }]);
});

test('requires confirmation, prevents duplicate submissions and disables paging while reviewing', async () => {
  const user = userEvent.setup();
  let finishReview;
  const items = Array.from({ length: 11 }, (_, i) => ({ ...shops[0], id: String(i + 1), name: `商铺${i + 1}` }));
  const reviews = mockApi({ items, review: () => new Promise(resolve => { finishReview = resolve; }) });
  render(<AdminPage />);
  await screen.findByRole('checkbox', { name: '选择商铺 商铺1' });
  await user.click(screen.getByRole('checkbox', { name: '选择商铺 商铺1' }));
  window.confirm.mockReturnValueOnce(false);
  await user.click(screen.getByRole('button', { name: '批量拒绝' }));
  expect(reviews).toEqual([]);
  await user.click(screen.getByRole('button', { name: '批量拒绝' }));
  expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
  expect(screen.getByRole('checkbox', { name: '选择本页商铺' })).toBeDisabled();
  expect(screen.getAllByRole('button', { name: '拒绝' }).every(button => button.disabled)).toBe(true);
  expect(screen.getByRole('button', { name: '清除选择' })).toBeDisabled();
  await act(async () => finishReview(Response.json({ ok: true })));
  expect(await screen.findByText(/批量拒绝完成：成功 1，失败 0/)).toBeInTheDocument();
  expect(reviews).toEqual([{ id: '1', action: 'reject', body: {} }]);
});

test('clears selection on page changes and returns to the last populated page after a batch', async () => {
  const user = userEvent.setup();
  const items = Array.from({ length: 11 }, (_, i) => ({ ...shops[0], id: String(i + 1), name: `商铺${i + 1}` }));
  const reviews = mockApi({ items });
  render(<AdminPage />);
  await user.click(await screen.findByRole('checkbox', { name: '选择本页商铺' }));
  await user.click(screen.getByRole('button', { name: '下一页' }));
  await screen.findByRole('checkbox', { name: '选择商铺 商铺11' });
  expect(screen.queryByText('已选 10 家')).not.toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: '选择本页商铺' })).not.toBeChecked();
  await user.click(screen.getByRole('checkbox', { name: '选择本页商铺' }));
  await user.click(screen.getByRole('button', { name: '批量拒绝' }));
  await screen.findByRole('checkbox', { name: '选择商铺 商铺1' });
  expect(screen.getByText('第 1 / 1 页，共 10 条')).toBeInTheDocument();
  expect(reviews).toEqual([{ id: '11', action: 'reject', body: {} }]);
});

test('stops scheduling batch requests after leaving shop review', async () => {
  const user = userEvent.setup();
  let finishReview;
  const reviews = mockApi({ review: () => new Promise(resolve => { finishReview = resolve; }) });
  render(<AdminPage />);
  await user.click(await screen.findByRole('checkbox', { name: '选择本页商铺' }));
  await user.click(screen.getByRole('button', { name: '批量拒绝' }));
  await user.click(screen.getByRole('button', { name: '商品举报' }));
  await act(async () => finishReview(Response.json({ ok: true })));
  await waitFor(() => expect(reviews).toHaveLength(1));
  expect(screen.queryByText(/批量拒绝完成/)).not.toBeInTheDocument();
});
