import React from 'react';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { requestJson } from './api.js';
import FetchRuns from './FetchRuns.jsx';

vi.mock('./api.js', () => ({
  formatTime: value => value,
  requestJson: vi.fn(async () => ({
    items: [{
      id: '1', shopName: 'Example shop', status: 'succeeded', taskType: 'list', itemCount: '12',
      settlementReport: { listStatus: 'succeeded', verified: 3, failed: 2, skipped: 7, retryable: 2, reasons: { request_failed: 2, not_selected: 7 } },
      error: 'settlement network incomplete',
    }, {
      id: '2', shopName: 'Quantity shop', status: 'succeeded', taskType: 'list', itemCount: '1',
      settlementReport: { listStatus: 'succeeded', verified: 0, failed: 0, skipped: 2, retryable: 0, reasons: { quantity_not_supported: 1, deferred: 1 } },
    }, {
      id: '3', shopName: 'Example shop', status: 'queued', taskType: 'settlement', sourceFetchRunId: '1', itemCount: '2',
      settlementReport: { listStatus: 'not_requested', verified: 1, failed: 1, skipped: 1, retryable: 1, reasons: { request_failed: 1, superseded: 1 } },
      crawlMetrics: { requests: 4, retries: 1, durations: { list: 0, settlement: 260, transaction: 20, rate_wait: 50, proxy_wait: 10, network: 180, total: 310 } },
    }, {
      id: '4', shopName: 'Exhausted shop', status: 'failed', taskType: 'settlement', sourceFetchRunId: '1', itemCount: '1',
      settlementReport: { listStatus: 'not_requested', verified: 0, failed: 1, skipped: 0, retryable: 1, reasons: { request_failed: 1 } },
    }, {
      id: '5', shopName: 'Expiry shop', status: 'queued', taskType: 'settlement', sourceFetchRunId: null,
    }], total: 5,
  })),
}));

const defaultRequest = requestJson.getMockImplementation();
beforeEach(() => { requestJson.mockReset().mockImplementation(defaultRequest); });

test('fetch history distinguishes goods success from settlement failure and retry state', async () => {
  render(<FetchRuns setMessage={vi.fn()} />);
  expect(await screen.findAllByText(/列表已采集/)).toHaveLength(2);
  expect(screen.getByText(/核验成功 3.*失败 2.*跳过 7/)).toBeInTheDocument();
  expect(screen.getByText(/可补采 2/)).toBeInTheDocument();
  expect(screen.getByText(/补采任务 #3.*来源列表 #1.*排队中/)).toBeInTheDocument();
  expect(screen.getByText(/结算补采.*待重试 1/)).toBeInTheDocument();
  expect(screen.getByText(/商品或来源已变化 1/)).toBeInTheDocument();
  expect(screen.getByText(/请求 4.*重试 1.*源站等待 50/)).toBeInTheDocument();
  expect(screen.getByText(/请求失败.*2/)).toBeInTheDocument();
  expect(screen.getByText(/起购数量无效.*1/)).toBeInTheDocument();
  expect(screen.getByText(/待分批核验 1/)).toBeInTheDocument();
  expect(screen.getByText(/独立结算任务 #5.*排队中/)).toBeInTheDocument();
  expect(screen.queryByText(/来源列表 #未知/)).not.toBeInTheDocument();
  expect(screen.getAllByText(/待重试/)).toHaveLength(1);
  expect(screen.getByText(/结算补采.*已结束.*未恢复 1/)).toBeInTheDocument();
});

test('initial load and pagination show a spinner, retain records and commit the page only on success', async () => {
  let complete;
  requestJson.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const user = userEvent.setup();
  render(<FetchRuns />);
  const region = screen.getByRole('region', { name: '抓取记录' });
  expect(region).toHaveAttribute('aria-busy', 'true');
  expect(within(region).getByRole('status', { name: '读取抓取记录' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '刷新记录' })).toBeDisabled();
  await act(async () => complete({ items: [{ id: '1', shopName: 'First shop' }], total: 11 }));
  expect(screen.getByLabelText('抓取记录分页')).toHaveClass('pagination');
  expect(screen.getByRole('button', { name: '下一页' })).toHaveAttribute('data-page-next');
  const list = screen.getByLabelText('抓取记录列表');
  list.scrollTop = 240;
  await user.click(screen.getByRole('button', { name: '下一页' }));
  expect(list.scrollTop).toBe(240);
  expect(screen.getByText('First shop')).toBeInTheDocument();
  expect(screen.getByLabelText('抓取记录分页')).toHaveTextContent('第 1 / 2 页，共 11 条');
  expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
  expect(region).toHaveAttribute('aria-busy', 'true');
  await act(async () => complete({ items: [{ id: '11', shopName: 'Second shop' }], total: 11 }));
  expect(screen.getByLabelText('抓取记录分页')).toHaveTextContent('第 2 / 2 页，共 11 条');
  expect(screen.getByText('Second shop')).toBeInTheDocument();
  expect(screen.queryByText('First shop')).not.toBeInTheDocument();
  expect(list.scrollTop).toBe(0);
  expect(region).toHaveAttribute('aria-busy', 'false');
  await user.click(screen.getByRole('button', { name: '刷新记录' }));
  const query = new URL(requestJson.mock.calls.at(-1)[0], 'http://localhost').searchParams;
  expect(query.get('page')).toBe('2');
  expect(query.get('limit')).toBe('10');
  expect(query.has('cursor')).toBe(false);
  expect(screen.getByLabelText('抓取记录分页')).toHaveTextContent('第 2 / 2 页，共 11 条');
  await act(async () => complete({ items: [{ id: '12', shopName: 'Latest shop' }], total: 12 }));
  expect(screen.getByLabelText('抓取记录分页')).toHaveTextContent('第 2 / 2 页，共 12 条');
  expect(screen.getByText('Latest shop')).toBeInTheDocument();
});

test.each([0, 1])('refresh returns to a valid page when history shrinks to %s records', async remaining => {
  let total = 11;
  requestJson.mockImplementation(async path => {
    const page = Number(new URL(path, 'http://localhost').searchParams.get('page'));
    return { total, items: total === 0 || page > 1 && total <= 10 ? []
      : [{ id: page === 1 ? '1' : '11', shopName: page === 1 ? 'First shop' : 'Second shop' }] };
  });
  const user = userEvent.setup();
  render(<FetchRuns />);
  await screen.findByText('First shop');
  await user.click(screen.getByRole('button', { name: '下一页' }));
  await screen.findByText('Second shop');
  total = remaining;
  await user.click(screen.getByRole('button', { name: '刷新记录' }));
  if (remaining) {
    expect(await screen.findByText('First shop')).toBeInTheDocument();
    expect(screen.getByLabelText('抓取记录分页')).toHaveTextContent('第 1 / 1 页，共 1 条');
  } else {
    expect(await screen.findByText('暂无抓取记录')).toBeInTheDocument();
    expect(screen.queryByLabelText('抓取记录分页')).not.toBeInTheDocument();
  }
  expect(screen.getByRole('region', { name: '抓取记录' })).toHaveAttribute('aria-busy', 'false');
  expect(requestJson.mock.calls.map(([path]) => new URL(path, 'http://localhost').searchParams.get('page')))
    .toEqual(['1', '2', '2', '1']);
});

test('a failed page keeps the current records and page number and retries the failed page', async () => {
  requestJson.mockResolvedValueOnce({ items: [{ id: '1', shopName: 'First shop' }], total: 11 })
    .mockRejectedValueOnce(new Error('网络中断'))
    .mockResolvedValueOnce({ items: [{ id: '11', shopName: 'Recovered shop' }], total: 11 });
  const user = userEvent.setup();
  render(<FetchRuns />);
  await screen.findByText('First shop');
  await user.click(screen.getByRole('button', { name: '下一页' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('网络中断');
  expect(screen.getByText('First shop')).toBeInTheDocument();
  expect(screen.getByLabelText('抓取记录分页')).toHaveTextContent('第 1 / 2 页，共 11 条');
  expect(screen.queryByText('暂无抓取记录')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByText('Recovered shop')).toBeInTheDocument();
  expect(screen.getByLabelText('抓取记录分页')).toHaveTextContent('第 2 / 2 页，共 11 条');
  expect(requestJson.mock.calls.slice(1).map(([path]) => new URL(path, 'http://localhost').searchParams.get('page')))
    .toEqual(['2', '2']);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('an initial failure offers retry without claiming there are no records, and unmount aborts the request', async () => {
  requestJson.mockRejectedValueOnce(new Error('记录服务不可用'))
    .mockImplementationOnce(() => new Promise(() => {}));
  const user = userEvent.setup();
  const { unmount } = render(<FetchRuns />);
  expect(await screen.findByRole('alert')).toHaveTextContent('记录服务不可用');
  expect(screen.queryByText('暂无抓取记录')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '重试' }));
  const signal = requestJson.mock.calls.at(-1)[1].signal;
  unmount();
  expect(signal.aborted).toBe(true);
});
