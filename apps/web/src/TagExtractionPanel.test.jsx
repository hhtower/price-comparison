import React from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TagExtractionPanel from './TagExtractionPanel.jsx';

beforeEach(() => { vi.unstubAllGlobals(); vi.stubGlobal('EventSource', undefined); });

function installStreams() {
  const streams = [];
  vi.stubGlobal('EventSource', class extends EventTarget {
    constructor() { super(); streams.push(this); }
    close() {}
  });
  return streams;
}

function emitProgress(source, progress) {
  source.dispatchEvent(new MessageEvent('progress', { data: JSON.stringify(progress) }));
}

test.each(['expand-first', 'refresh-first'])('终态刷新期间切回缓存商品读取当前版本依据（%s）', async order => {
  const streams = installStreams();
  let finished = false;
  const pending = {};
  const calls = installApi({ state: 'running', handle(call, job) {
    if (call.path.endsWith('/jobs/8')) return Response.json({ job: { ...job, status: finished ? 'succeeded' : 'running' },
      progress: { rawProductCount: 2, processed: finished ? 2 : 0 } });
    if (/tag-results\/[34]$/.test(call.path)) {
      const id = call.path.split('/').at(-1);
      const data = { member: { status: finished ? 'succeeded' : 'processing', fingerprint: `${id}-${finished ? 'final' : 'old'}`,
        ...(finished ? { output: { outcome: 'updated', acceptedTags: [], rejectedTags: [], diff: [] } } : {}) }, batches: [] };
      return finished ? new Promise(resolve => { pending[id] = () => resolve(Response.json(data)); }) : Response.json(data);
    }
  } });
  const user = userEvent.setup();
  render(<TagExtractionPanel shops={shops} view="history" />);
  await user.click(await screen.findByRole('button', { name: '查看标签任务 #8' }));
  await user.click(await screen.findByRole('button', { name: '查看商品 #3 依据' }));
  await screen.findByText('输入指纹：3-old');
  await user.click(screen.getByRole('button', { name: '查看商品 #4 依据' }));
  await screen.findByText('输入指纹：4-old');
  finished = true;
  await act(async () => emitProgress(streams.at(-1), { status: 'succeeded', processed: 2 }));
  await user.click(screen.getByRole('button', { name: '查看商品 #3 依据' }));
  expect(screen.queryByText('输入指纹：3-old')).not.toBeInTheDocument();
  expect(calls.filter(call => call.path.endsWith('/tag-results/3'))).toHaveLength(2);
  if (order === 'expand-first') {
    await act(async () => pending['3']());
    expect(screen.getByText('输入指纹：3-final')).toBeInTheDocument();
    await act(async () => pending['4']());
  } else {
    await act(async () => pending['4']());
    expect(screen.getByText('正在读取商品依据…')).toBeInTheDocument();
    await act(async () => pending['3']());
  }
  expect(screen.getByText('输入指纹：3-final')).toBeInTheDocument();
  expect(screen.queryByText('商品最终发布审计尚未生成。')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '查看商品 #3 依据' })).toHaveAttribute('aria-expanded', 'true');
});

test('相同结果版本切换或收起再展开复用依据缓存，关闭展开项刷新后可重读', async () => {
  const calls = installApi({ state: 'running', handle(call) {
    if (/tag-results\/[34]$/.test(call.path)) return Response.json({
      member: { fingerprint: call.path.split('/').at(-1) }, batches: [],
    });
  } });
  const user = userEvent.setup();
  render(<TagExtractionPanel shops={shops} view="history" />);
  await user.click(await screen.findByRole('button', { name: '查看标签任务 #8' }));
  for (const id of ['3', '4', '3']) {
    await user.click(await screen.findByRole('button', { name: `查看商品 #${id} 依据` }));
    expect(screen.getByText(`输入指纹：${id}`)).toBeInTheDocument();
  }
  await user.click(screen.getByRole('button', { name: '查看商品 #3 依据' }));
  await user.click(screen.getByRole('button', { name: '查看商品 #3 依据' }));
  expect(screen.getByText('输入指纹：3')).toBeInTheDocument();
  expect(calls.filter(call => /tag-results\/[34]$/.test(call.path))).toHaveLength(2);
  await user.click(screen.getByRole('button', { name: '查看商品 #3 依据' }));
  await user.click(screen.getByRole('button', { name: '刷新详情' }));
  expect(screen.queryByText('输入指纹：3')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '查看商品 #3 依据' }));
  expect(screen.getByText('输入指纹：3')).toBeInTheDocument();
  expect(calls.filter(call => call.path.endsWith('/tag-results/3'))).toHaveLength(2);
});

test('新结果轮次尚未发起依据读取时，旧版本的展开响应也不能写缓存', async () => {
  const streams = installStreams();
  let refreshing = false;
  let finishSnapshot;
  let finishOldAudit;
  installApi({ state: 'running', handle(call, job) {
    if (refreshing && call.path.endsWith('/jobs/8')) return new Promise(resolve => {
      finishSnapshot = () => resolve(Response.json({ job, progress: { rawProductCount: 2, processed: 1 } }));
    });
    if (call.path.endsWith('/tag-results/3')) {
      const data = { member: { fingerprint: refreshing ? 'current-version' : 'old-version' }, batches: [] };
      return refreshing ? Response.json(data) : new Promise(resolve => {
        finishOldAudit = () => resolve(Response.json(data));
      });
    }
  } });
  const user = userEvent.setup();
  render(<TagExtractionPanel shops={shops} view="history" />);
  await user.click(await screen.findByRole('button', { name: '查看标签任务 #8' }));
  await user.click(await screen.findByRole('button', { name: '查看商品 #3 依据' }));
  refreshing = true;
  await act(async () => streams.at(-1).dispatchEvent(new Event('open')));
  await act(async () => finishOldAudit());
  expect(screen.queryByText('输入指纹：old-version')).not.toBeInTheDocument();
  expect(screen.getByText('正在读取商品依据…')).toBeInTheDocument();
  await act(async () => finishSnapshot());
  expect(screen.getByText('输入指纹：current-version')).toBeInTheDocument();
});

test('刷新依据延迟时切走再切回同一商品，保留较新展开请求的当前版本依据', async () => {
  const streams = installStreams();
  let refreshing = false;
  let finishOldRefresh;
  let refreshReads = 0;
  installApi({ state: 'running', handle(call) {
    if (/tag-results\/[34]$/.test(call.path)) {
      const id = call.path.split('/').at(-1);
      const data = { member: { fingerprint: `${id}-${refreshing ? 'current' : 'old'}` }, batches: [] };
      if (refreshing && id === '4' && ++refreshReads === 1) return new Promise(resolve => {
        finishOldRefresh = () => resolve(Response.json({ member: { fingerprint: 'stale-refresh' }, batches: [] }));
      });
      return Response.json(data);
    }
  } });
  const user = userEvent.setup();
  render(<TagExtractionPanel shops={shops} view="history" />);
  await user.click(await screen.findByRole('button', { name: '查看标签任务 #8' }));
  await user.click(await screen.findByRole('button', { name: '查看商品 #3 依据' }));
  await user.click(screen.getByRole('button', { name: '查看商品 #4 依据' }));
  refreshing = true;
  await act(async () => streams.at(-1).dispatchEvent(new Event('open')));
  await user.click(screen.getByRole('button', { name: '查看商品 #3 依据' }));
  await user.click(screen.getByRole('button', { name: '查看商品 #4 依据' }));
  expect(screen.getByText('输入指纹：4-current')).toBeInTheDocument();
  await act(async () => finishOldRefresh());
  expect(screen.getByText('输入指纹：4-current')).toBeInTheDocument();
  expect(screen.queryByText('输入指纹：stale-refresh')).not.toBeInTheDocument();
});

test('终态刷新后的最终依据不会被先前展开请求的未发布响应覆盖', async () => {
  const streams = installStreams();
  let finished = false;
  let finishOldAudit;
  const calls = installApi({ state: 'running', handle(call, job) {
    if (call.path.endsWith('/jobs/8')) return Response.json({ job: { ...job, status: finished ? 'succeeded' : 'running' },
      progress: { rawProductCount: 2, processed: finished ? 2 : 0 } });
    if (call.path.endsWith('/tag-results/3')) {
      if (!finished) return new Promise(resolve => {
        finishOldAudit = () => resolve(Response.json({ member: { status: 'processing', fingerprint: 'old-audit' }, batches: [] }));
      });
      return Response.json({ member: { fingerprint: 'final-audit',
        output: { outcome: 'updated', acceptedTags: [], rejectedTags: [], diff: [] } }, batches: [] });
    }
  } });
  const user = userEvent.setup();
  render(<TagExtractionPanel shops={shops} view="history" />);
  await user.click(await screen.findByRole('button', { name: '查看标签任务 #8' }));
  await user.click(await screen.findByRole('button', { name: '查看商品 #3 依据' }));
  finished = true;
  await act(async () => emitProgress(streams.at(-1), { status: 'succeeded', processed: 2 }));
  expect(screen.getByText('输入指纹：final-audit')).toBeInTheDocument();
  await act(async () => finishOldAudit());
  expect(screen.getByText('输入指纹：final-audit')).toBeInTheDocument();
  expect(screen.queryByText('商品最终发布审计尚未生成。')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '查看商品 #3 依据' })).toHaveAttribute('aria-expanded', 'true');
  expect(calls.filter(call => call.path.endsWith('/tag-results/3'))).toHaveLength(2);
});

test.each([false, true])('终态刷新丢弃旧的未加载分页并保留游标可重试（尾随刷新：%s）', async trailing => {
  const streams = installStreams();
  let finished = false;
  let slowSnapshot = false;
  let finishSnapshot;
  let finishOldPage;
  const calls = installApi({ state: 'running', handle(call, job) {
    if (call.path.endsWith('/jobs/8')) {
      const data = { job: { ...job, status: finished ? 'succeeded' : 'running' },
        progress: { rawProductCount: 2, processed: finished ? 2 : 0 } };
      if (slowSnapshot) {
        slowSnapshot = false;
        return new Promise(resolve => { finishSnapshot = () => resolve(Response.json(data)); });
      }
      return Response.json(data);
    }
    if (call.path.endsWith('/tag-results')) {
      if (!call.query.has('cursor')) return Response.json({ items: [{ id: '3', name: '首页商品' }], nextCursor: 'page-2' });
      if (!finished) return new Promise(resolve => {
        finishOldPage = () => resolve(Response.json({ items: [{ id: '4', name: '第二页旧商品', status: 'processing' }], nextCursor: null }));
      });
      return Response.json({ items: [{ id: '4', name: '第二页最终商品', outcome: 'updated' }], nextCursor: null });
    }
  } });
  const user = userEvent.setup();
  render(<TagExtractionPanel shops={shops} view="history" />);
  await user.click(await screen.findByRole('button', { name: '查看标签任务 #8' }));
  await screen.findByText('首页商品');
  const source = streams.at(-1);
  if (trailing) {
    slowSnapshot = true;
    await act(async () => source.dispatchEvent(new Event('open')));
  }
  await user.click(screen.getByRole('button', { name: '加载更多商品结果' }));
  finished = true;
  await act(async () => emitProgress(source, { status: 'succeeded', processed: 2 }));
  if (trailing) await act(async () => finishSnapshot());
  expect(screen.getByText('处理结束')).toBeInTheDocument();
  await act(async () => finishOldPage());
  expect(screen.queryByText('第二页旧商品')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '加载更多商品结果' }));
  expect(screen.getByText('第二页最终商品')).toBeInTheDocument();
  expect(calls.filter(call => call.query.get('cursor') === 'page-2')).toHaveLength(2);
  await user.click(screen.getByRole('button', { name: '刷新详情' }));
  expect(screen.getByText('第二页最终商品')).toBeInTheDocument();
});

test('详情进度立即合并，密集事件限频且慢结果刷新单飞并尾随最后一次事件', async () => {
  const streams = installStreams();
  let slow = false;
  const pending = [];
  let revision = 0;
  const calls = installApi({ state: 'running', handle(call, job) {
    if (call.path.endsWith('/jobs/8')) return Response.json({ job, progress: { rawProductCount: 10, processed: revision } });
    if (call.path.endsWith('/tag-results')) {
      const result = { items: [{ id: '3', name: `商品版本${revision}`, status: 'processing' }] };
      return slow ? new Promise(resolve => pending.push(() => resolve(Response.json(result)))) : Response.json(result);
    }
  } });
  const user = userEvent.setup();
  const view = render(<TagExtractionPanel shops={shops} view="history" />);
  await user.click(await screen.findByRole('button', { name: '查看标签任务 #8' }));
  await screen.findByText('商品版本0');
  vi.useFakeTimers();
  try {
    slow = true;
    const source = streams.at(-1);
    const before = calls.length;
    await act(async () => {
      for (let processed = 1; processed <= 3; processed++) emitProgress(source, { status: 'running', processed, rawProductCount: 10 });
    });
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '3');
    expect(calls).toHaveLength(before);
    revision = 3;
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(pending).toHaveLength(1);
    revision = 4;
    await act(async () => emitProgress(source, { status: 'running', processed: 4 }));
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(pending).toHaveLength(1);
    await act(async () => pending[0]());
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '4');
    expect(pending).toHaveLength(2);
    await act(async () => pending[1]());
    expect(screen.getByText('商品版本4')).toBeInTheDocument();
    expect(streams).toHaveLength(1);
  } finally { view.unmount(); vi.useRealTimers(); }
});

test('重连、筛选 effect 重建和最终事件刷新保留商品分页及展开依据', async () => {
  const streams = installStreams();
  let phase = 'running';
  let revision = 0;
  const calls = installApi({ state: 'running', handle(call, job) {
    if (call.path.endsWith('/jobs/8')) return Response.json({ job: { ...job, status: phase },
      progress: { rawProductCount: 10, processed: revision } });
    if (call.path.endsWith('/tag-results')) return Response.json({
      items: [{ id: call.query.has('cursor') ? '4' : '3', name: call.query.has('cursor') ? '第二页商品' : `第一页版本${revision}` }],
      nextCursor: call.query.has('cursor') ? null : 'more',
    });
  } });
  const user = userEvent.setup();
  const view = render(<TagExtractionPanel shops={shops} view="history" />);
  await user.click(await screen.findByRole('button', { name: '查看标签任务 #8' }));
  await user.click(await screen.findByRole('button', { name: '加载更多商品结果' }));
  await user.click(screen.getByRole('button', { name: '查看商品 #3 依据' }));
  await screen.findByText('一个月');
  await act(async () => streams.at(-1).dispatchEvent(new Event('open')));
  expect(screen.getByText('第二页商品')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '查看商品 #3 依据' })).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByText('一个月')).toBeInTheDocument();
  vi.useFakeTimers();
  try {
    revision = 1;
    await act(async () => emitProgress(streams.at(-1), { status: 'running', processed: 1 }));
    // Queue filters rebuild the stream; the scheduled result refresh must survive.
    fireEvent.change(screen.getByRole('combobox', { name: '任务筛选' }), { target: { value: 'attention' } });
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(screen.getByText('第一页版本1')).toBeInTheDocument();
    expect(screen.getByText('第二页商品')).toBeInTheDocument();
    phase = 'succeeded'; revision = 10;
    await act(async () => emitProgress(streams.at(-1), { status: 'succeeded', processed: 10 }));
    expect(screen.getByText('第一页版本10')).toBeInTheDocument();
    expect(screen.getByText('第二页商品')).toBeInTheDocument();
    expect(screen.getByText('一个月')).toBeInTheDocument();
    const count = calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(calls).toHaveLength(count);
  } finally { view.unmount(); vi.useRealTimers(); }
});

test('终态事件在慢刷新期间尾随读取最终结果，卸载后不继续读分页或依据', async () => {
  const streams = installStreams();
  let slow = false;
  let finished = false;
  const pending = [];
  const calls = installApi({ state: 'running', handle(call, job) {
    if (call.path.endsWith('/jobs/8')) {
      const data = { job: { ...job, status: finished ? 'succeeded' : 'running' }, progress: { rawProductCount: 2, processed: finished ? 2 : 0 } };
      return slow ? new Promise(resolve => pending.push(() => resolve(Response.json(data)))) : Response.json(data);
    }
    if (call.path.endsWith('/tag-results')) return Response.json({ items: [{ id: '3', name: finished ? '最终商品' : '旧商品' }], nextCursor: 'more' });
  } });
  const user = userEvent.setup();
  const view = render(<TagExtractionPanel shops={shops} view="history" />);
  await user.click(await screen.findByRole('button', { name: '查看标签任务 #8' }));
  await screen.findByText('旧商品');
  slow = true;
  await act(async () => streams.at(-1).dispatchEvent(new Event('open')));
  finished = true;
  await act(async () => emitProgress(streams.at(-1), { status: 'succeeded', processed: 2 }));
  expect(pending).toHaveLength(1);
  await act(async () => pending[0]());
  expect(pending).toHaveLength(2);
  await act(async () => pending[1]());
  expect(screen.getByRole('progressbar')).toHaveAttribute('value', '2');
  expect(screen.getByText('最终商品')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '加载更多商品结果' }));
  await user.click(screen.getByRole('button', { name: '刷新详情' }));
  view.unmount();
  const count = calls.length;
  await act(async () => pending[2]());
  expect(calls).toHaveLength(count);
});

test('后台刷新等待依据时加载下一页，不把新增分页重置回首页', async () => {
  const streams = installStreams();
  let slowAudit = false;
  let finishAudit;
  installApi({ state: 'running', handle(call) {
    if (call.path.endsWith('/tag-results')) return Response.json({
      items: [{ id: call.query.has('cursor') ? '4' : '3', name: call.query.has('cursor') ? '新增第二页' : '首页商品' }],
      nextCursor: call.query.has('cursor') ? null : 'more',
    });
    if (call.path.endsWith('/tag-results/3') && slowAudit) return new Promise(resolve => {
      finishAudit = () => resolve(Response.json({ member: { fingerprint: 'refreshed-audit' }, batches: [] }));
    });
  } });
  const user = userEvent.setup();
  render(<TagExtractionPanel shops={shops} view="history" />);
  await user.click(await screen.findByRole('button', { name: '查看标签任务 #8' }));
  await user.click(await screen.findByRole('button', { name: '查看商品 #3 依据' }));
  await screen.findByText('一个月');
  slowAudit = true;
  await act(async () => streams.at(-1).dispatchEvent(new Event('open')));
  await user.click(screen.getByRole('button', { name: '加载更多商品结果' }));
  expect(screen.getByText('新增第二页')).toBeInTheDocument();
  slowAudit = false;
  await act(async () => finishAudit());
  expect(screen.getByText('新增第二页')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '查看商品 #3 依据' })).toHaveAttribute('aria-expanded', 'true');
});

test('换任务和卸载丢弃旧刷新及尾随任务，新任务不等待旧请求', async () => {
  const streams = installStreams();
  let slow = false;
  const pending = [];
  const onChanged = vi.fn();
  const calls = installApi({ state: 'running', handle(call) {
    if (call.path.endsWith('task-queue')) return Response.json({ items: [{ id: '8' }, { id: '9' }] });
    if (slow && call.path.endsWith('/jobs/8')) return new Promise(resolve => pending.push(() =>
      resolve(Response.json({ job: { id: '8', status: 'running', model: 'STALE' } }))));
  } });
  const user = userEvent.setup();
  const view = render(<TagExtractionPanel shops={shops} view="history" onProductsChanged={onChanged} />);
  await user.click(await screen.findByRole('button', { name: '查看标签任务 #8' }));
  await screen.findByRole('button', { name: '查看商品 #3 依据' });
  slow = true;
  const oldSource = streams.at(-1);
  await act(async () => oldSource.dispatchEvent(new Event('open')));
  await act(async () => oldSource.dispatchEvent(new Event('open')));
  await user.click(screen.getByRole('button', { name: '关闭标签任务详情' }));
  await user.click(screen.getByRole('button', { name: '查看标签任务 #9' }));
  await screen.findByRole('button', { name: '暂停标签任务' });
  const count = calls.length;
  const notifications = onChanged.mock.calls.length;
  await act(async () => pending.forEach(finish => finish()));
  expect(calls).toHaveLength(count);
  expect(onChanged).toHaveBeenCalledTimes(notifications);
  expect(screen.queryByText(/STALE/)).not.toBeInTheDocument();
  vi.useFakeTimers();
  try {
    await act(async () => emitProgress(streams.at(-1), { status: 'running', processed: 1 }));
    view.unmount();
    const after = calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(calls).toHaveLength(after);
  } finally { view.unmount(); vi.useRealTimers(); }
});

test('旧筛选队列慢响应不会压住新筛选的请求和后续轮询', async () => {
  let finishOld;
  const calls = installApi({ handle(call) {
    if (!call.path.endsWith('task-queue')) return;
    if (call.query.get('status') === 'all') return new Promise(resolve => {
      finishOld = () => resolve(Response.json({ items: [{ id: 'old' }] }));
    });
    return Response.json({ items: [{ id: '9' }] });
  } });
  vi.useFakeTimers();
  const view = render(<TagExtractionPanel shops={shops} view="history" />);
  try {
    fireEvent.change(screen.getByRole('combobox', { name: '任务筛选' }), { target: { value: 'attention' } });
    await act(async () => {});
    expect(screen.getByRole('button', { name: '查看标签任务 #9' })).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(calls.filter(call => call.query.get('status') === 'attention')).toHaveLength(2);
    await act(async () => finishOld());
    expect(screen.queryByRole('button', { name: '查看标签任务 #old' })).not.toBeInTheDocument();
  } finally { view.unmount(); vi.useRealTimers(); }
});

test('终态推送关闭流后仍显示结果刷新错误，手动刷新可恢复', async () => {
  const streams = installStreams();
  let failed = false;
  installApi({ state: 'running', handle(call) {
    if (failed && call.path.endsWith('/tag-results')) return Response.json({ message: '最终结果暂不可用' }, { status: 503 });
  } });
  const user = userEvent.setup();
  render(<TagExtractionPanel shops={shops} view="history" />);
  await user.click(await screen.findByRole('button', { name: '查看标签任务 #8' }));
  await screen.findByRole('button', { name: '查看商品 #3 依据' });
  failed = true;
  await act(async () => emitProgress(streams.at(-1), { status: 'succeeded', processed: 2 }));
  expect(screen.getByRole('alert')).toHaveTextContent('最终结果暂不可用');
  failed = false;
  await user.click(screen.getByRole('button', { name: '刷新详情' }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '查看商品 #3 依据' })).toBeInTheDocument();
});

test('刷新结果保留当前展开依据并使收起的旧依据缓存失效', async () => {
  const streams = installStreams();
  let revision = 0;
  installApi({ state: 'running', handle(call) {
    if (/tag-results\/[34]$/.test(call.path)) return Response.json({
      member: { fingerprint: `audit-${call.path.split('/').at(-1)}-${revision}` }, batches: [],
    });
  } });
  const user = userEvent.setup();
  render(<TagExtractionPanel shops={shops} view="history" />);
  await user.click(await screen.findByRole('button', { name: '查看标签任务 #8' }));
  await user.click(await screen.findByRole('button', { name: '查看商品 #3 依据' }));
  await screen.findByText('输入指纹：audit-3-0');
  await user.click(screen.getByRole('button', { name: '查看商品 #4 依据' }));
  await screen.findByText('输入指纹：audit-4-0');
  revision = 1;
  await act(async () => streams.at(-1).dispatchEvent(new Event('open')));
  expect(screen.getByText('输入指纹：audit-4-1')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '查看商品 #3 依据' }));
  expect(await screen.findByText('输入指纹：audit-3-1')).toBeInTheDocument();
});

test('标签抽取看板只汇总当前执行任务，不显示历史覆盖统计', async () => {
  const calls = installApi({ handle(call, job) {
    if (call.path.endsWith('task-queue')) return Response.json({ items: [job], summary: {
      total: 6, pendingProducts: 30, queued: 3, running: 1, paused: 2, reviewProducts: 2, failedProducts: 1, coveredProducts: 20,
      currentReasons: { provider_error: 1 },
    } });
    if (call.path.endsWith('/jobs/8')) return Response.json({ job, progress: {
      rawProductCount: 2, processed: 2, requests: { failedBatches: 0 },
      tagResults: { updated: 1, unchanged: 1, review: 0, failed: 0, unrecorded: 0 },
      tagAcceptance: { acceptedTags: 3, rejectedTags: 0, partialProducts: 0 },
      tagStages: { extractionCompleted: 1, reviewCompleted: 1, publicationQueued: 0 },
    } });
  } });
  render(<TagExtractionPanel shops={shops} />);
  const monitor = screen.getByRole('region', { name: '标签抽取监控' });
  expect(await within(monitor).findByText('30')).toBeInTheDocument();
  expect(monitor).toHaveTextContent('当前任务6');
  expect(monitor).toHaveTextContent('排队任务3');
  expect(monitor).toHaveTextContent('暂停任务2');
  expect(within(monitor).getAllByRole('term').map(term => term.textContent))
    .toEqual(['当前任务', '排队任务', '运行任务', '暂停任务', '待处理商品']);
  expect(calls.filter(call => call.path.endsWith('task-queue')).every(call => call.query.get('status') === 'unfinished')).toBe(true);
  const overview = await screen.findByRole('region', { name: '标签任务运行概览' });
  expect(await within(overview).findByRole('progressbar', { name: '标签商品处理进度' })).toHaveAttribute('value', '2');
  expect(within(overview).getByRole('list', { name: '标签抽取阶段' })).toHaveTextContent('提取标签');
  expect(overview).toHaveTextContent('通过标签（条）3');
  expect(within(overview).getAllByRole('term').filter(item => item.textContent === '失败批次')).toHaveLength(1);
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  expect(screen.queryByRole('combobox', { name: '任务筛选' })).not.toBeInTheDocument();
  expect(screen.queryByRole('combobox', { name: '店铺筛选' })).not.toBeInTheDocument();
  expect(screen.queryByText(/标签数量按已记录审计结果统计/)).not.toBeInTheDocument();
  expect(calls.some(call => call.path.endsWith('/tag-results'))).toBe(false);
});

test('当前任务结束后看板归零并清除运行概览，历史记录仍可单独查看', async () => {
  let finished = false;
  const calls = installApi({ state: 'running', handle(call, job) {
    if (call.path.endsWith('task-queue')) {
      const activeOnly = call.query.get('status') === 'unfinished';
      return Response.json({
        items: activeOnly && finished ? [] : [{ ...job, status: finished ? 'succeeded' : 'running' }],
        summary: { total: activeOnly && finished ? 0 : 1, queued: 0, running: finished ? 0 : 1, paused: 0, pendingProducts: finished ? 0 : 2 },
      });
    }
  } });
  const user = userEvent.setup();
  const panel = render(<TagExtractionPanel shops={shops} />);
  await screen.findByRole('button', { name: '查看标签任务 #8' });
  finished = true;
  await user.click(screen.getByRole('button', { name: '刷新标签状态' }));
  expect(await screen.findByText('暂无执行中的标签抽取任务')).toBeInTheDocument();
  const monitor = screen.getByRole('region', { name: '标签抽取监控' });
  expect(within(monitor).getAllByRole('definition').every(value => value.textContent === '0')).toBe(true);
  expect(screen.queryByRole('region', { name: '标签任务运行概览' })).not.toBeInTheDocument();
  panel.rerender(<TagExtractionPanel shops={shops} view="history" />);
  expect(await screen.findByRole('button', { name: '查看标签任务 #8' })).toBeInTheDocument();
  expect(calls.filter(call => call.path.endsWith('task-queue')).at(-1).query.get('status')).toBe('all');
});

test('监控统计和最近任务不继承记录页的店铺范围', async () => {
  const calls = installApi();
  const user = userEvent.setup();
  const panel = render(<TagExtractionPanel shops={shops} view="history" />);
  await user.selectOptions(screen.getByRole('combobox', { name: '店铺筛选' }), '1');
  await vi.waitFor(() => expect(calls.at(-1).query.get('scopeShopId')).toBe('1'));
  const before = calls.length;
  panel.rerender(<TagExtractionPanel shops={shops} view="tasks" />);
  await screen.findByRole('button', { name: '查看标签任务 #8' });
  const monitorCalls = calls.slice(before).filter(call => call.path.endsWith('task-queue'));
  expect(monitorCalls.length).toBeGreaterThan(0);
  expect(monitorCalls.every(call => !call.query.has('scopeShopId') && call.query.get('limit') === '1')).toBe(true);
  expect(screen.queryByRole('combobox', { name: '店铺筛选' })).not.toBeInTheDocument();
});

test('标签抽取记录使用统一分页和弹窗，关闭后保留筛选与当前页', async () => {
  installApi({ handle(call, job) {
    if (call.path.endsWith('task-queue')) return Response.json({
      items: [{ ...job, id: call.query.has('cursor') ? '7' : '8' }], summary: { total: 11 },
      nextCursor: call.query.has('cursor') ? null : 'next-page',
    });
  } });
  const user = userEvent.setup();
  render(<TagExtractionPanel shops={shops} view="history" />);
  await user.selectOptions(screen.getByRole('combobox', { name: '任务筛选' }), 'attention');
  await user.click(await screen.findByRole('button', { name: '下一页' }));
  await user.click(await screen.findByRole('button', { name: '查看标签任务 #7' }));
  const dialog = await screen.findByRole('dialog', { name: '标签任务详情' });
  expect(await within(dialog).findByRole('progressbar', { name: '标签商品处理进度' })).toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: '关闭标签任务详情' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: '任务筛选' })).toHaveValue('attention');
  expect(screen.getByLabelText('标签抽取记录分页')).toHaveTextContent('第 2 / 2 页，共 11 条');
  expect(screen.getByRole('button', { name: '查看标签任务 #7' })).toHaveFocus();
  expect(screen.queryByRole('button', { name: '新建标签任务' })).not.toBeInTheDocument();
});

test('标签记录翻页失败保留原页和记录，重试后只展示新页', async () => {
  let unavailable = true;
  installApi({ handle(call, job) {
    if (!call.path.endsWith('task-queue')) return;
    if (call.query.has('cursor') && unavailable) return Response.json({ message: '列表读取失败' }, { status: 500 });
    return Response.json({ items: [{ ...job, id: call.query.has('cursor') ? '7' : '8' }],
      summary: { total: 11 }, nextCursor: call.query.has('cursor') ? null : 'next-page' });
  } });
  const user = userEvent.setup();
  render(<TagExtractionPanel shops={shops} view="history" />);
  await user.click(await screen.findByRole('button', { name: '下一页' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('列表读取失败');
  expect(screen.getByLabelText('标签抽取记录分页')).toHaveTextContent('第 1 / 2 页');
  expect(screen.getByRole('button', { name: '查看标签任务 #8' })).toBeInTheDocument();
  unavailable = false;
  await user.click(screen.getByRole('button', { name: '下一页' }));
  expect(await screen.findByRole('button', { name: '查看标签任务 #7' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '查看标签任务 #8' })).not.toBeInTheDocument();
});

test('关闭标签详情后忽略迟到的任务快照', async () => {
  let finish;
  installApi({ handle(call, job) {
    if (call.path.endsWith('/jobs/8')) return new Promise(resolve => {
      finish = () => resolve(Response.json({ job: { ...job, model: 'STALE_MODEL' } }));
    });
  } });
  const user = userEvent.setup();
  render(<TagExtractionPanel shops={shops} view="history" />);
  await user.click(await screen.findByRole('button', { name: '查看标签任务 #8' }));
  await user.click(await screen.findByRole('button', { name: '关闭标签任务详情' }));
  await act(async () => finish());
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByText(/STALE_MODEL/)).not.toBeInTheDocument();
});

test('部分完成的标签任务不标成全流程成功，拒绝标签与失败批次分别统计', async () => {
  installApi({ state: 'ready_with_errors', handle(call, job) {
    if (call.path.endsWith('/jobs/8')) return Response.json({ job, progress: {
      rawProductCount: 2, processed: 2, requests: { failedBatches: 1 },
      tagResults: { updated: 1, review: 1, failed: 0 }, tagAcceptance: { acceptedTags: 2, rejectedTags: 1 },
      tagStages: { extractionCompleted: 1, reviewCompleted: 0 },
    } });
  } });
  render(<TagExtractionPanel shops={shops} />);
  const overview = await screen.findByRole('region', { name: '标签任务运行概览' });
  expect(await within(overview).findByRole('progressbar')).toHaveAttribute('value', '2');
  expect(within(overview).getByText('部分完成')).toHaveClass('is-attention');
  expect(overview).toHaveTextContent('拒绝标签（条）1');
  expect(overview).toHaveTextContent('失败批次1');
  for (const step of within(overview).getAllByRole('listitem')) expect(step).not.toHaveClass('is-past');
});

test('监控直接使用进度推送，不为每次进度重复查询全局队列，结束时同步最终快照', async () => {
  const streams = [];
  vi.stubGlobal('EventSource', class extends EventTarget {
    constructor() { super(); streams.push(this); }
    close() {}
  });
  let finished = false;
  let deferRefresh = false;
  let finishRefresh;
  const calls = installApi({ state: 'running', handle(call, job) {
    if (!call.path.endsWith('/jobs/8')) return;
    const snapshot = {
      job: { ...job, status: finished ? 'succeeded' : 'running' },
      progress: { rawProductCount: 2, processed: finished ? 2 : 0, tagResults: { updated: finished ? 2 : 0 } },
    };
    return deferRefresh ? new Promise(resolve => { finishRefresh = () => resolve(Response.json(snapshot)); })
      : Response.json(snapshot);
  } });
  render(<TagExtractionPanel shops={shops} />);
  const progress = await screen.findByRole('progressbar', { name: '标签商品处理进度' });
  expect(progress).toHaveAttribute('value', '0');
  await vi.waitFor(() => expect(streams.length).toBeGreaterThan(0));
  const source = streams.at(-1);
  deferRefresh = true;
  await act(async () => source.dispatchEvent(new Event('open')));
  const before = calls.length;
  await act(async () => source.dispatchEvent(new MessageEvent('progress', { data: JSON.stringify({
    jobId: '8', version: '2', status: 'running', rawProductCount: 2, processed: 1, tagResults: { updated: 1 },
  }) })));
  expect(progress).toHaveAttribute('value', '1');
  expect(calls).toHaveLength(before);
  await act(async () => finishRefresh());
  expect(progress).toHaveAttribute('value', '1');
  deferRefresh = false;
  finished = true;
  const queueBeforeTerminal = calls.filter(call => call.path.endsWith('task-queue')).length;
  await act(async () => source.dispatchEvent(new MessageEvent('progress', { data: JSON.stringify({
    jobId: '8', version: '3', status: 'succeeded', rawProductCount: 2, processed: 2,
  }) })));
  await vi.waitFor(() => expect(progress).toHaveAttribute('value', '2'));
  expect(calls.filter(call => call.path.endsWith('task-queue')).length).toBeGreaterThan(queueBeforeTerminal);
});

test('标签队列独立过滤，历史无记录不会显示已验证', async () => {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = String(input); calls.push(url);
    if (url.includes('task-queue')) return Response.json({ items: [{ id: '8', status: 'succeeded', total: 1 }], summary: { pendingProducts: 2 } });
    if (url.endsWith('tag-results')) return Response.json({ items: [{ id: '3', name: '商品', status: 'unclassified' }] });
    return Response.json({ job: { id: '8', status: 'succeeded', job_type: 'tag_extraction' }, progress: { rawProductCount: 1, tagResults: { unrecorded: 1 } } });
  }));
  render(<TagExtractionPanel shops={{ items: [] }} />);
  await userEvent.setup().click(await screen.findByRole('button', { name: '查看标签任务 #8' }));
  expect(await screen.findByText('商品')).toBeInTheDocument();
  expect(screen.getAllByText(/未记录/).length).toBeGreaterThan(0);
  expect(calls.some(url => url.includes('jobType=tag_extraction'))).toBe(true);
});

function installApi({ state = 'succeeded', handle } = {}) {
  const calls = [];
  const job = { id: '8', status: state, model: 'test-model', job_type: 'tag_extraction', parent_identity_job_id: '7', pipeline_versions: { tags: 'v3' }, created_at: '2026-10-15T00:00:00Z', finished_at: state === 'succeeded' ? '2026-10-15T00:00:02Z' : null };
  vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
    const url = new URL(String(input), 'http://localhost');
    const call = { path: url.pathname, query: url.searchParams, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const handled = await handle?.(call, job);
    if (handled) return handled;
    if (url.pathname.endsWith('task-queue')) return Response.json({ items: [{ ...job, parentIdentityJobId: '7', pipelineVersions: { tags: 'v3' }, processed: 2, total: 2, uniqueInputCount: 1 }], summary: { pendingProducts: 4, reviewProducts: 1, failedProducts: 1, coveredProducts: 8 } });
    if (/tag-results$/.test(url.pathname)) return Response.json({ items: [{ id: '3', name: '失败商品', status: 'unclassified', outcome: 'failed', changedFields: 0 }, { id: '4', name: '复核商品', outcome: 'review', changedFields: 1 }] });
    if (/tag-results\/3$/.test(url.pathname)) return Response.json({ member: { content_version: '2', standardization_revision: '1', output: { outcome: 'updated', acceptedTags: [{ name: 'duration', value: 30, evidence: [{ path: 'spec', quote: '一个月' }] }], rejectedTags: [{ name: 'renewable', value: 'yes', evidence: [], reason: '证据不足', reasonCode: 'evidence_invalid' }], diff: [{ name: 'duration', before: [], after: [30] }], retainedUnconfirmed: [{ name: 'warranty', value: 'covered' }] } }, batches: [{ batch_index: 0, round: 'initial', status: 'succeeded', response_ms: 500, response_usage: { total_tokens: 42 } }] });
    if (/jobs\/\d+$/.test(url.pathname)) return Response.json({ job: { ...job, id: url.pathname.split('/').at(-1) }, progress: { rawProductCount: 2, processed: '2', uniqueInputCount: 1, tagResults: { failed: 1, review: 1 }, requests: { totalBatches: 1 } } });
    return Response.json({}, { status: 404 });
  }));
  return calls;
}
const shops = { items: [{ id: '1', name: '测试店' }] };

test('标签详情只展示商品结果和依据，不再提供勾选与定向重试入口', async () => {
  installApi();
  const user = userEvent.setup();
  render(<TagExtractionPanel shops={shops} view="history" />);
  await user.click(await screen.findByRole('button', { name: '查看标签任务 #8' }));
  const dialog = await screen.findByRole('dialog', { name: '标签任务详情' });
  await within(dialog).findByRole('button', { name: '查看商品 #3 依据' });
  expect(within(dialog).getByRole('heading', { name: '商品结果', exact: true })).toBeInTheDocument();
  expect(within(dialog).queryByRole('button', { name: /预览定向重试/ })).not.toBeInTheDocument();
  expect(within(dialog).queryByRole('checkbox', { name: /选择商品/ })).not.toBeInTheDocument();
});

test('关闭标签抽取后禁用创建，历史与商品依据仍可查看', async () => {
  const calls = installApi();
  const user = userEvent.setup();
  render(<TagExtractionPanel shops={shops} enabled={false} />);
  expect(screen.getByText(/标签抽取功能未启用/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '新建标签任务' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '批量新建标签任务' })).toBeDisabled();
  await user.click(await screen.findByRole('button', { name: '查看标签任务 #8' }));
  await user.click(await screen.findByRole('button', { name: '查看商品 #3 依据' }));
  expect(await screen.findByText('冻结输入 JSON')).toBeInTheDocument();
  expect(calls.filter(call => call.method === 'POST')).toEqual([]);
});

async function openAudit(data) {
  installApi({ handle(call) {
    if (call.path.endsWith('/tag-results/3')) return Response.json(data);
  } });
  const user = userEvent.setup();
  render(<TagExtractionPanel shops={shops} />);
  await user.click(await screen.findByRole('button', { name: '查看标签任务 #8' }));
  await user.click(await screen.findByRole('button', { name: '查看商品 #3 依据' }));
  return (await screen.findByText(/^结果：/)).closest('.tag-audit');
}

test('部分成功显示标签计数、顶层完整性和实际写入，空证据不渲染引用', async () => {
  const accepted = { name: 'duration', value: 30, proposalIndex: 0, evidence: [] };
  const rejected = { name: 'region', value: 'invalid', proposalIndex: 1, evidence: [], reasonCode: 'tag_value_invalid' };
  const audit = await openAudit({ member: { output: {
    outcome: 'partial_success', successfulCount: 1, failedCount: 1, complete: false,
    review: { mode: 'per_tag_binary', decisions: [true, false], complete: true },
    acceptedTags: [accepted], rejectedTags: [rejected],
    diff: [{ name: 'duration', before: [], after: [30] }],
    retainedUnconfirmed: [{ name: 'region', value: 'US' }],
  } }, batches: [{ id: '21', stage: 'extract', proposals: [accepted, rejected] }] });
  expect(audit).toHaveTextContent('结果：部分成功 · 成功 1 条标签 · 失败 1 条标签');
  expect(audit).toHaveTextContent('完整性：不完整');
  expect(audit).not.toHaveTextContent('完整性：完整');
  expect(audit).toHaveTextContent('使用期限：无 → 1个月');
  expect(audit).not.toHaveTextContent('保留但本次未确认');
  expect(audit).toHaveTextContent('标签值格式或枚举不符');
  expect(audit).not.toHaveTextContent('本次未写入');
  expect(audit).not.toHaveTextContent('原始证据未记录');
  expect(audit.querySelectorAll('q, ul:empty')).toHaveLength(0);
});

test.each([
  ['updated', 1, 0, true, '实际更新'],
  ['unchanged', 1, 0, true, '无变化'],
  ['failed', 0, 1, false, '失败'],
  ['empty', 0, 0, true, '无可确认标签'],
])('新协议 %s 与部分成功区分并展示零计数', async (outcome, successfulCount, failedCount, complete, title) => {
  const audit = await openAudit({ member: { output: {
    outcome, successfulCount, failedCount, complete, acceptedTags: [], rejectedTags: [],
    review: { mode: 'per_tag_binary', decisions: [] }, diff: [],
  } }, batches: [] });
  expect(audit).toHaveTextContent(`结果：${title}`);
  expect(audit).toHaveTextContent(`成功 ${successfulCount} 条标签 · 失败 ${failedCount} 条标签`);
  expect(audit).toHaveTextContent(`完整性：${complete ? '完整' : '不完整'}`);
  expect(audit).not.toHaveTextContent('部分成功');
});

test('旧review完整性不冒充当前完整性，失败带实际diff时不声称没有写入', async () => {
  const audit = await openAudit({ member: { output: {
    outcome: 'failed', review: { mode: 'per_tag_binary', decisions: [], complete: false },
    acceptedTags: [], rejectedTags: [], diff: [{ name: 'duration', before: [30], after: [60] }],
  } }, batches: [] });
  expect(audit).not.toHaveTextContent('完整性：');
  expect(audit).toHaveTextContent('使用期限：1个月 → 2个月');
  expect(audit).not.toHaveTextContent('本次未写入');
});

test('两轮修正历史保留各轮候选、布尔票和完整性，不按最终合并索引反推', async () => {
  const initial = { name: 'duration', value: 30, proposalIndex: 0, evidence: [] };
  const repaired = { name: 'region', value: 'US', proposalIndex: 0, evidence: [] };
  const audit = await openAudit({ member: { output: {
    outcome: 'partial_success', successfulCount: 1, failedCount: 1, complete: false,
    acceptedTags: [initial], rejectedTags: [{ ...repaired, proposalIndex: 1, reasonCode: 'review_rejected' }],
    review: { mode: 'per_tag_binary', decisions: [true, false] },
    attempts: [
      { round: 1, tags: [initial], rejectedTags: [], complete: false, reviewDecisions: [true] },
      { round: 2, tags: [], rejectedTags: [{ ...repaired, reasonCode: 'review_rejected' }], complete: false, reviewDecisions: [false] },
    ],
  } }, batches: [
    { id: '21', reference_snapshot: { tagStage: 'extract' }, proposals: [initial] },
    { id: '31', stage: 'review', extraction_batch_id: '21', review_decisions: [true] },
    { id: '22', reference_snapshot: { tagStage: 'repair', tagRepairRound: 1 }, proposals: [repaired] },
    { id: '32', reference_snapshot: { tagStage: 'review', tagRepairRound: 1 }, extraction_batch_id: '22', review_decisions: [false] },
  ] });
  await userEvent.setup().click(within(audit).getByText('提取与修正历史'));
  const history = within(audit).getByText('提取与修正历史').closest('details');
  const first = within(history).getByRole('table', { name: '第 1 轮候选判定' });
  const second = within(history).getByRole('table', { name: '第 2 轮候选判定' });
  expect(first).toHaveTextContent('YES (true)');
  expect(first).not.toHaveTextContent('NO (false)');
  expect(second).toHaveTextContent('NO (false)');
  expect(second).not.toHaveTextContent('YES (true)');
  expect(second).toHaveTextContent('本轮程序处置');
  expect(within(history).getAllByText('完整性：不完整')).toHaveLength(2);
  await userEvent.setup().click(within(audit).getByText('修正复核批次 #32 详情'));
  const batch = within(audit).getByRole('table', { name: '修正复核批次 #32 候选判定' });
  expect(batch).toHaveTextContent('US');
  expect(batch).toHaveTextContent('NO (false)');
  expect(batch).not.toHaveTextContent('程序采纳');
  expect(within(audit).getByText('修正提取批次 #22 详情')).toBeInTheDocument();
});

test.each([true, false])('批次按本轮索引显示duration通过、warranty拒绝，修正索引0不关联最终duration（批次票：%s）', async recorded => {
  const duration = { name: 'duration', value: 30, proposalIndex: 0, evidence: [] };
  const warranty = { name: 'warranty', value: 'covered', proposalIndex: 1, evidence: [] };
  const repaired = { ...warranty, proposalIndex: 0 };
  const audit = await openAudit({ member: { output: {
    outcome: 'partial_success', successfulCount: 1, failedCount: 1, complete: false,
    acceptedTags: [duration], rejectedTags: [{ ...warranty, reasonCode: 'review_rejected' }],
    review: { mode: 'per_tag_binary', decisions: [true, false] },
    attempts: [
      { round: 1, tags: [duration], rejectedTags: [{ ...warranty, reasonCode: 'review_rejected' }], complete: false, reviewDecisions: [true, false] },
      { round: 2, tags: [], rejectedTags: [{ ...repaired, reasonCode: 'review_rejected' }], complete: false, reviewDecisions: [false] },
    ],
  } }, batches: [
    { id: '21', stage: 'extract', tagRepairRound: 0, proposals: [duration, warranty] },
    { id: '31', stage: 'review', tagRepairRound: 0, extraction_batch_id: '21', review_decisions: recorded ? [true, false] : null },
    { id: '22', stage: 'repair', tagRepairRound: 1, proposals: [repaired] },
    { id: '32', stage: 'review', tagRepairRound: 1, extraction_batch_id: '22', review_decisions: recorded ? [false] : null },
  ] });
  const user = userEvent.setup();
  await user.click(within(audit).getByText('复核批次 #31 详情'));
  const first = within(audit).getByRole('table', { name: '复核批次 #31 候选判定' });
  const durationRow = within(first).getByText('duration = 30').closest('tr');
  const warrantyRow = within(first).getByText('warranty = covered').closest('tr');
  expect(first).toHaveTextContent('本轮程序处置');
  expect(durationRow).toHaveTextContent('YES (true)');
  expect(durationRow).toHaveTextContent('程序采纳');
  expect(warrantyRow).toHaveTextContent('NO (false)');
  expect(warrantyRow).toHaveTextContent('LLM 对该标签判定为否');
  await user.click(within(audit).getByText('修正复核批次 #32 详情'));
  const repair = within(audit).getByRole('table', { name: '修正复核批次 #32 候选判定' });
  expect(repair).toHaveTextContent('#0');
  expect(repair).toHaveTextContent('warranty = covered');
  expect(repair).toHaveTextContent('本轮程序处置');
  expect(repair).toHaveTextContent('NO (false)');
  expect(repair).toHaveTextContent('LLM 对该标签判定为否');
  expect(repair).not.toHaveTextContent('程序采纳');
  expect(repair).not.toHaveTextContent('YES (true)');
  expect(repair).not.toHaveTextContent('关联未记录');
  await user.click(within(audit).getByText('修正提取批次 #22 详情'));
  const extraction = within(audit).getByRole('table', { name: '修正提取批次 #22 候选判定' });
  expect(extraction).toHaveTextContent('本轮程序处置');
  expect(extraction).toHaveTextContent('LLM 对该标签判定为否');
});

test.each(['missing-round', 'duplicate-attempt', 'missing-attempt'])('修正轮关联不确定时不借用最终合并索引及投票（%s）', async scenario => {
  const repaired = { name: 'warranty', value: 'covered', proposalIndex: 0, evidence: [] };
  const attempt = { round: 2, tags: [], rejectedTags: [{ ...repaired, reasonCode: 'review_rejected' }], complete: false, reviewDecisions: [false] };
  const audit = await openAudit({ member: { output: {
    outcome: 'partial_success', review: { mode: 'per_tag_binary', decisions: [true, false] },
    acceptedTags: [{ name: 'duration', value: 30, proposalIndex: 0, evidence: [] }],
    rejectedTags: [{ ...repaired, proposalIndex: 1, reasonCode: 'review_rejected' }],
    ...(scenario === 'missing-attempt' ? {} : { attempts: scenario === 'duplicate-attempt' ? [attempt, attempt] : [attempt] }),
  } }, batches: [
    { id: '22', stage: 'repair', ...(scenario === 'missing-round' ? {} : { tagRepairRound: 1 }), proposals: [repaired] },
    { id: '32', stage: 'review', tagRepairRound: 1, extraction_batch_id: '22', review_decisions: null },
  ] });
  await userEvent.setup().click(within(audit).getByText('修正复核批次 #32 详情'));
  const table = within(audit).getByRole('table', { name: '修正复核批次 #32 候选判定' });
  expect(table).toHaveTextContent('LLM 原始投票未记录');
  expect(table).toHaveTextContent('最终处置来源关联未记录');
  expect(table).not.toHaveTextContent('程序采纳');
  expect(table).not.toHaveTextContent('YES (true)');
  expect(table).not.toHaveTextContent('NO (false)');
});

test('部分完成任务的商品列表和汇总呈现部分成功及标签数', async () => {
  installApi({ state: 'ready_with_errors', handle(call, job) {
    if (call.path.endsWith('/jobs/8')) return Response.json({ job, progress: {
      rawProductCount: 1, processed: 1, tagResults: { partial_success: 1 },
    } });
    if (call.path.endsWith('/tag-results')) return Response.json({ items: [{
      id: '3', name: '部分商品', outcome: 'partial_success',
      successfulCount: 2, failedCount: 1, complete: false, changedFields: 1,
    }] });
  } });
  const user = userEvent.setup();
  render(<TagExtractionPanel shops={shops} view="history" />);
  await user.click(await screen.findByRole('button', { name: '查看标签任务 #8' }));
  const member = (await screen.findByText('部分商品')).closest('li');
  expect(member).toHaveTextContent('部分成功 · 成功 2 条标签 · 失败 1 条标签');
  expect(member).toHaveTextContent('完整性：不完整');
  const overview = screen.getByRole('region', { name: '标签任务运行概览' });
  expect(overview).toHaveTextContent('部分成功商品1');
  expect(overview).toHaveTextContent('部分完成');
});

test('不完整但未拒绝候选仍显示部分成功和零失败数，并展示程序原因', async () => {
  const audit = await openAudit({ member: { output: {
    outcome: 'partial_success', successfulCount: 1, failedCount: 0, complete: false,
    reasonCode: 'tag_review_incomplete', review: { mode: 'per_tag_binary', decisions: [true] },
    acceptedTags: [{ name: 'region', value: 'US', proposalIndex: 0, evidence: [] }], rejectedTags: [],
  } }, batches: [] });
  expect(audit).toHaveTextContent('部分成功 · 成功 1 条标签 · 失败 0 条标签');
  expect(audit).toHaveTextContent('标签复核仍有遗漏');
  expect(audit).toHaveTextContent('完整性：不完整');
  expect(audit).not.toHaveTextContent('未识别原因');
});

test.each(['repair', 'review'])('在途批次读取冻结的修正阶段（%s）', async stage => {
  installApi({ state: 'running', handle(call, job) {
    if (call.path.endsWith('/jobs/8')) return Response.json({ job, progress: { rawProductCount: 1 }, currentBatches: [{
      batch_index: 2, step: 'request', product_count: 1, reference_snapshot: { tagStage: stage, tagRepairRound: 1 },
    }] });
  } });
  const user = userEvent.setup();
  render(<TagExtractionPanel shops={shops} />);
  await user.click(await screen.findByRole('button', { name: '查看标签任务 #8' }));
  const info = screen.getByText('任务信息').closest('details');
  expect(info).toHaveTextContent(`在途批次 3 · ${stage === 'repair' ? '修正提取' : '修正复核'}`);
});

const textReview = {
  answers: { L1: true, L2: false, L3: true, R1: false, R2: true, R3: false, A1: true, A2: false },
  consistency: { C1: false, C2: true, C3: false, C4: true, C5: false, C6: true },
};

test('标签任务不解释内嵌文案审查结果', async () => {
  const audit = await openAudit({ member: { output: {
    outcome: 'empty', acceptedTags: [], rejectedTags: [], textReview,
    review: { mode: 'per_tag_binary', decisions: [] },
  } }, batches: [] });
  expect(within(audit).queryByRole('region', { name: '文案审查结果' })).not.toBeInTheDocument();
  expect(within(audit).queryByRole('table', { name: '信息披露（8项）' })).not.toBeInTheDocument();
  expect(within(audit).queryByRole('table', { name: '描述一致性（6项）' })).not.toBeInTheDocument();
});

test.each([
  ['布尔值', textReview,
    ['已披露', '未披露', '已披露', '未披露', '已披露', '未披露', '已披露', '未披露'],
    ['未发现冲突', '存在冲突', '未发现冲突', '存在冲突', '未发现冲突', '存在冲突']],
  ['缺字段', { answers: { L1: false } },
    ['未披露', ...Array(7).fill('未记录')], Array(6).fill('未记录')],
  ['历史格式', {
    answers: { L1: { value: true, reason: '明确说明套餐', evidence: [{ field: 'name', quote: '完整标题中的套餐' }] } },
    consistency: { C3: { value: null, reason: '历史未知判定', evidence: [] } },
  }, Array(8).fill('未记录'), Array(6).fill('未记录')],
])('独立文案任务以两列显示8+6审查，不显示标签复核及写入：%s', async (_name, review, answers, conflicts) => {
  const calls = installApi({ handle(call, job) {
    if (call.path.endsWith('/jobs/8')) return Response.json({ job: { ...job, job_type: 'text_review' }, progress: {
      rawProductCount: 1, processed: 1, textReviewResults: { updated: 1, failed: 0 },
    } });
    if (call.path.endsWith('/text-review-results')) return Response.json({ items: [{ id: '3', name: '文案商品', outcome: 'updated' }] });
    if (call.path.endsWith('/text-review-results/3')) return Response.json({ member: {
      output: { outcome: 'updated', textReview: review },
    }, batches: [{ id: '21', stage: 'extract', status: 'succeeded', response_ms: 100 }] });
  } });
  const user = userEvent.setup();
  render(<TagExtractionPanel shops={shops} taskKind="text_review" view="history" />);
  await user.click(await screen.findByRole('button', { name: '查看文案任务 #8' }));
  const overview = screen.getByRole('region', { name: '文案任务运行概览' });
  expect(within(overview).getByText('实际更新').nextElementSibling).toHaveTextContent('1');
  expect(within(overview).getByText('失败商品').nextElementSibling).toHaveTextContent('0');
  await user.click(await screen.findByRole('button', { name: '查看商品 #3 依据' }));
  expect(await screen.findByRole('table', { name: '信息披露（8项）' })).toBeInTheDocument();
  const dialog = screen.getByRole('dialog', { name: '文案任务详情' });
  expect(dialog).toHaveTextContent('文案审查批次 #21 详情');
  const disclosure = within(dialog).getByRole('table', { name: '信息披露（8项）' });
  const consistency = within(dialog).getByRole('table', { name: '描述一致性（6项）' });
  expect(within(disclosure).getAllByRole('row')).toHaveLength(9);
  expect(within(consistency).getAllByRole('row')).toHaveLength(7);
  expect(within(disclosure).getAllByRole('cell').map(cell => cell.textContent)).toEqual(answers);
  expect(within(consistency).getAllByRole('cell').map(cell => cell.textContent)).toEqual(conflicts);
  for (const table of [disclosure, consistency]) {
    expect(within(table).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['项目', '判定']);
    expect(table).not.toHaveTextContent(/说明与原文|无法判断|unknown|明确说明套餐|完整标题中的套餐|历史未知判定/);
    expect(table.querySelector('q')).not.toBeInTheDocument();
  }
  expect(dialog).not.toHaveTextContent('标签');
  expect(dialog).not.toHaveTextContent('LLM 二元复核');
  expect(dialog).not.toHaveTextContent('写入差异');
  expect(calls.some(call => call.path.endsWith('/text-review-results'))).toBe(true);
  expect(calls.some(call => call.path.includes('/tag-results'))).toBe(false);
});

test.each([false, true])('文案任务创建使用专用接口并只说明独立审查费用（全站：%s）', async allPending => {
  const calls = installApi({ handle(call) {
    if (call.path === '/api/ai/text-review-jobs/preview') return Response.json({
      previewDigest: 'text-preview', model: 'text-model',
      counts: { eligible: 1, selected: 1, uniqueInputs: 1, requestBatches: 1 },
    });
    if (call.path === '/api/ai/text-review-jobs') return Response.json({ id: '9' });
    if (call.path.endsWith('/text-review-results')) return Response.json({ items: [] });
  } });
  const user = userEvent.setup();
  render(<TagExtractionPanel shops={shops} taskKind="text_review" />);
  await user.click(screen.getByRole('button', { name: allPending ? '批量新建文案任务' : '新建文案任务' }));
  if (!allPending) {
    await user.type(screen.getByRole('textbox', { name: '商品 ID（空格或逗号分隔）' }), '3');
    await user.click(screen.getByRole('button', { name: '预览文案范围' }));
    await screen.findByText('模型：text-model');
  }
  const dialog = screen.getByRole('dialog', { name: '创建文案任务' });
  expect(dialog).toHaveTextContent('8 项信息披露与 6 项一致性');
  expect(dialog).not.toHaveTextContent('提取与复核两阶段');
  expect(dialog).not.toHaveTextContent('标签');
  if (!allPending) expect(within(dialog).getByText('预计模型调用').closest('div')).toHaveTextContent('1');
  await user.click(within(dialog).getByRole('checkbox', { name: /我确认可能消耗模型额度/ }));
  await user.click(within(dialog).getByRole('button', { name: '确认创建文案任务' }));
  expect(await screen.findByRole('dialog', { name: '文案任务详情' })).toBeInTheDocument();
  expect(calls.find(call => call.path === '/api/ai/text-review-jobs')?.body).toEqual({
    ...(allPending ? { allPending: true } : { productIds: ['3'], previewDigest: 'text-preview' }),
    requestId: expect.any(String), acknowledgePossibleCharge: true,
  });
});

test('复盘展开冻结 JSON，保留当时版本而不拿实时商品代替', async () => {
  const payload = { name: '冻结商品', spec: '冻结规格', sourceData: { evidence: '原始正文\n第二段' } };
  const audit = await openAudit({
    job: { model: 'frozen-job-model', pipeline_versions: { tagPrompt: 'frozen-prompt' } },
    member: { payload, fingerprint: 'frozen-fingerprint', content_version: '4', standardization_revision: '2', output: null },
    batches: [],
  });
  const frozen = within(audit).getByText('冻结输入 JSON').closest('details');
  expect(frozen).not.toHaveAttribute('open');
  expect(JSON.parse(frozen.querySelector('code').textContent)).toEqual(payload);
  expect(frozen).not.toHaveTextContent('失败商品');
  expect(audit).toHaveTextContent('frozen-fingerprint');
  expect(audit).toHaveTextContent('frozen-prompt');
  expect(audit).toHaveTextContent('frozen-job-model');
});

test('候选按实际提取来源和索引对应重复标签、原始布尔票与程序拒绝', async () => {
  const proposals = [
    { proposalIndex: 0, name: 'duration', value: 30, evidence: [{ path: 'spec', quote: '第一个月' }] },
    { proposalIndex: 1, name: 'duration', value: 30, evidence: [{ path: 'sourceData.evidence', quote: '另一个月' }] },
    { proposalIndex: 2, name: 'unknown_field', value: 'x', evidence: [{ path: 'spec', quote: '原始候选' }] },
    { proposalIndex: 3, name: 'region', value: 'US', evidence: [{ path: 'spec', quote: '引文不符' }] },
  ];
  const audit = await openAudit({ member: { payload: { spec: '第一个月' }, output: {
    outcome: 'updated', review: { mode: 'per_tag_binary', decisions: [false, true, true, true] },
    acceptedTags: [{ proposalIndex: 1, name: 'duration', value: 30, evidence: [] }],
    rejectedTags: [
      { proposalIndex: 3, name: 'region', value: 'US', reasonCode: 'citation_quote_mismatch', evidence: [] },
      { proposalIndex: 0, name: 'duration', value: 30, reasonCode: 'review_rejected', evidence: [] },
      { proposalIndex: 2, name: 'unknown_field', value: 'x', reasonCode: 'tag_name_unknown', evidence: [] },
    ],
  } }, batches: [
    { id: '21', stage: 'extract', proposals },
    { id: '99', stage: 'extract', proposals: [{ proposalIndex: 0, name: 'region', value: 'US', evidence: [{ path: 'name', quote: '较新但无关的提取' }] }] },
    { id: '31', stage: 'review', extraction_batch_id: '21', review_decisions: [false, true, true, true], step: 'done', status: 'succeeded' },
  ] });
  await userEvent.setup().click(within(audit).getByText('复核批次 #31 详情'));
  const table = within(audit).getByRole('table', { name: '复核批次 #31 候选判定' });
  const rows = within(table).getAllByRole('row').slice(1);
  expect(rows).toHaveLength(4);
  expect(rows[0]).toHaveTextContent('#0');
  expect(rows[0]).toHaveTextContent('NO (false)');
  expect(rows[0]).toHaveTextContent('LLM 对该标签判定为否');
  expect(rows[1]).toHaveTextContent('#1');
  expect(rows[1]).toHaveTextContent('YES (true)');
  expect(rows[1]).toHaveTextContent('程序采纳');
  expect(rows[1]).toHaveTextContent('sourceData.evidence');
  expect(rows[1]).toHaveTextContent('另一个月');
  expect(rows[2]).toHaveTextContent('YES (true)');
  expect(rows[2]).toHaveTextContent('程序拒绝：标签名称不在规范词表中');
  expect(rows[3]).toHaveTextContent('YES (true)');
  expect(rows[3]).toHaveTextContent('程序拒绝：证据引文与商品资料不符');
  expect(table).not.toHaveTextContent('较新但无关');
});

test('无发布结果时仍展示持久化复核票，拆分复核各自关联提取批次', async () => {
  const audit = await openAudit({ member: { status: 'processing', output: null }, batches: [
    { id: '21', stage: 'extract', proposals: [{ proposalIndex: 0, name: 'duration', value: 30, evidence: [{ path: 'spec', quote: '来源甲' }] }] },
    { id: '22', stage: 'extract', proposals: [{ proposalIndex: 0, name: 'region', value: 'US', evidence: [{ path: 'name', quote: '来源乙' }] }] },
    { id: '31', stage: 'review', extraction_batch_id: '21', review_decisions: [true], step: 'publish', status: 'queued' },
    { id: '32', stage: 'review', extraction_batch_id: '22', review_decisions: [false], step: 'publish', status: 'queued' },
  ] });
  const user = userEvent.setup();
  await user.click(within(audit).getByText('复核批次 #31 详情'));
  await user.click(within(audit).getByText('复核批次 #32 详情'));
  const first = within(audit).getByRole('table', { name: '复核批次 #31 候选判定' });
  const second = within(audit).getByRole('table', { name: '复核批次 #32 候选判定' });
  expect(first).toHaveTextContent('来源甲');
  expect(first).toHaveTextContent('YES (true)');
  expect(first).not.toHaveTextContent('来源乙');
  expect(second).toHaveTextContent('来源乙');
  expect(second).toHaveTextContent('NO (false)');
  expect(second).not.toHaveTextContent('来源甲');
  expect(first).toHaveTextContent('发布尚未完成');
  expect(audit).not.toHaveTextContent('未进行LLM复核');
  expect(audit).not.toHaveTextContent('已通过');
});

test('来源批次未记录时保留原始票但不拿最新提取冒充来源', async () => {
  const audit = await openAudit({ member: { output: null }, batches: [
    { id: '22', stage: 'extract', proposals: [{ proposalIndex: 0, name: 'region', value: 'US', evidence: [{ path: 'name', quote: '不能挪用的候选' }] }] },
    { id: '31', stage: 'review', extraction_batch_id: 'missing', review_decisions: [true, false] },
  ] });
  const review = within(audit).getByText('复核批次 #31 详情').closest('details');
  expect(review).toHaveTextContent('来源提取批次：#missing');
  expect(review).toHaveTextContent('来源候选未记录');
  expect(review).toHaveTextContent('[true,false]');
  expect(review).not.toHaveTextContent('不能挪用的候选');
});

test('商品已保存的原始票可用于关联来源，缺失批次票不等于投票丢失', async () => {
  const audit = await openAudit({ member: { output: {
    outcome: 'updated', review: { mode: 'per_tag_binary', decisions: [true] },
    acceptedTags: [{ proposalIndex: 0, name: 'duration', value: 30, evidence: [] }], rejectedTags: [],
  } }, batches: [
    { id: '21', stage: 'extract', proposals: [{ proposalIndex: 0, name: 'duration', value: 30, evidence: [{ path: 'spec', quote: '原始引用' }] }] },
    { id: '31', stage: 'review', extraction_batch_id: '21', review_decisions: null },
  ] });
  await userEvent.setup().click(within(audit).getByText('复核批次 #31 详情'));
  const table = within(audit).getByRole('table', { name: '复核批次 #31 候选判定' });
  expect(table).toHaveTextContent('YES (true)');
  expect(table).toHaveTextContent('程序采纳');
  expect(table).toHaveTextContent('原始引用');
});

test('多个提取来源时最终处置不凭相同索引归给某个复核批次', async () => {
  const audit = await openAudit({ member: { output: {
    outcome: 'updated', review: { mode: 'per_tag_binary', decisions: [true] },
    acceptedTags: [{ proposalIndex: 0, name: 'duration', value: 30, evidence: [] }], rejectedTags: [],
  } }, batches: [
    { id: '21', stage: 'extract', proposals: [{ proposalIndex: 0, name: 'duration', value: 30, evidence: [] }] },
    { id: '22', stage: 'extract', proposals: [{ proposalIndex: 0, name: 'region', value: 'US', evidence: [] }] },
    { id: '31', stage: 'review', extraction_batch_id: '21', review_decisions: [true] },
    { id: '32', stage: 'review', extraction_batch_id: '22', review_decisions: [true] },
  ] });
  await userEvent.setup().click(within(audit).getByText('复核批次 #32 详情'));
  const table = within(audit).getByRole('table', { name: '复核批次 #32 候选判定' });
  expect(table).toHaveTextContent('最终处置来源关联未记录');
  expect(table).not.toHaveTextContent('程序采纳');
  expect(table).toHaveTextContent('YES (true)');
});

test('历史缺少输入、索引和原始投票时明确未记录，不按最终去向反推原始票', async () => {
  const audit = await openAudit({ member: { output: {
    outcome: 'review', review: { mode: 'per_tag_binary' }, acceptedTags: [],
    rejectedTags: [{ name: 'duration', value: 30, reasonCode: 'review_rejected', evidence: [] }],
  } }, batches: [
    { id: '21', stage: 'extract', proposals: [{ proposalIndex: 0, name: 'duration', value: 30, evidence: [{ path: 'spec', quote: '历史原文' }] }] },
    { id: '31', stage: 'review', extraction_batch_id: '21', review_decisions: null },
  ] });
  await userEvent.setup().click(within(audit).getByText('复核批次 #31 详情'));
  expect(within(audit).getByText('冻结输入未记录，不能用实时商品资料还原。')).toBeInTheDocument();
  const table = within(audit).getByRole('table', { name: '复核批次 #31 候选判定' });
  expect(table).toHaveTextContent('LLM 原始投票未记录');
  expect(table).toHaveTextContent('程序处置索引未记录');
  expect(table).not.toHaveTextContent('NO (false)');
  expect(audit).toHaveTextContent('原候选索引：未记录');
});

test.each(['skipped', 'failed', 'cancelled'])('发布 %s 即便存在采纳候选也明确未写入', async outcome => {
  const audit = await openAudit({ member: { output: {
    outcome, review: { mode: 'per_tag_binary', decisions: [true] },
    acceptedTags: [{ proposalIndex: 0, name: 'duration', value: 30, evidence: [] }], rejectedTags: [],
  } }, batches: [] });
  expect(audit).toHaveTextContent('本次未写入商品标签');
  expect(audit).toHaveTextContent('YES (true)');
  expect(audit).not.toHaveTextContent('已通过');
});

test('请求详情展示模型、预算、时间和白名单诊断，不展示同批其他商品或响应正文', async () => {
  const audit = await openAudit({
    job: { model: 'requested-audit-model' }, member: { output: null }, batches: [{
      id: '31', stage: 'review', extraction_batch_id: '21', batch_index: 1, round: 1,
      step: 'request', status: 'failed', attempts: 2, request_budget_used: 2, request_budget_limit: 2,
      confirmed_requests: 1, unknown_requests: 1, product_count: 8, input_bytes: 99, estimated_tokens: 33,
      queued_at: '2026-10-25T01:00:00Z', started_at: '2026-10-25T01:00:01Z',
      first_content_at: '2026-10-25T01:00:02Z', response_completed_at: '2026-10-25T01:00:03Z',
      decision_saved_at: '2026-10-25T01:00:04Z', finished_at: '2026-10-25T01:00:05Z',
      response_model: 'actual-response-model', response_id: 'response-31', response_ms: 2500,
      response_usage: { total_tokens: 84 }, decision_hash: 'decision-sha256',
      request_estimate: { requestBytes: 999, estimatedInputTokens: 123, outputReserveTokens: 456, estimatedTotalTokens: 579 },
      error_source: 'model_response', retry_class: 'invalid_response', error: '安全错误摘要',
      response_diagnostic: {
        phase: 'schema', code: 'invalid_response', contentSha256: 'response-sha256', outputBytes: 100,
        chunkCount: 4, finishReason: 'stop', inputCount: 8,
        issues: [{ itemId: '777', code: 'invalid_type', fieldPath: 'items[0].decisions', actualType: 'string', quote: '其他商品秘密' }],
        rawResponse: '禁止展示的响应正文', apiKey: '禁止展示的密钥', secret: '其他商品秘密',
      },
    }],
  });
  const request = within(audit).getByText('复核批次 #31 详情').closest('details');
  expect(request).not.toHaveAttribute('open');
  for (const value of ['requested-audit-model', 'actual-response-model', 'response-31', 'request', 'failed',
    '2500 毫秒', 'total_tokens: 84', '请求预算：2 / 2', '尝试次数：2', '已确认请求：1', '结果未知请求：1',
    'estimatedTotalTokens: 579', 'model_response', 'invalid_response', '安全错误摘要',
    'schema', 'response-sha256', 'decision-sha256', 'invalid_type', 'items[0].decisions']) {
    expect(request).toHaveTextContent(value);
  }
  for (const label of ['入队时间', '开始时间', '首内容时间', '响应完成时间', '判定保存时间', '结束时间']) {
    expect(request).toHaveTextContent(label);
  }
  expect(request).not.toHaveTextContent('禁止展示');
  expect(request).not.toHaveTextContent('其他商品秘密');
  expect(request).not.toHaveTextContent('777');
});

test.each([
  ['review_rejected', 'LLM 对该标签判定为否'],
  ['tag_name_unknown', '标签名称不在规范词表中'],
  ['tag_value_invalid', '标签值格式或枚举不符'],
  ['tag_single_value_conflict', '单值字段返回了多个不同值'],
  ['tag_duplicate', '重复标签已去重'],
])('当前标签诊断 %s 保留程序原因并独立展示原始布尔判定', async (reasonCode, label) => {
  const vote = reasonCode !== 'review_rejected';
  const audit = await openAudit({ member: { reason_code: reasonCode, output: {
    outcome: 'failed', complete: true, review: { mode: 'per_tag_binary', decisions: [vote] },
    acceptedTags: [], rejectedTags: [{ proposalIndex: 0, name: 'bulk_purchase', value: 'supported', reasonCode, evidence: [] }],
  } }, batches: [] });
  expect(within(audit).getAllByText(new RegExp(label)).length).toBeGreaterThan(0);
  expect(audit).toHaveTextContent(vote ? 'YES (true)' : 'NO (false)');
  expect(audit).toHaveTextContent('程序拒绝');
  expect(audit).not.toHaveTextContent('历史 LLM 复核');
  expect(audit).not.toHaveTextContent('已通过');
});

test.each([
  null,
  { outcome: 'updated', acceptedTags: [], rejectedTags: [] },
  { outcome: 'unchanged', review: { status: 'approved', reason: '旧聚合批准不能作为投票' } },
  { outcome: 'review', review: { status: 'review', reason: '旧聚合原因不能作为投票' } },
  { outcome: 'updated', review: { mode: 'per_tag_binary' }, acceptedTags: [{ proposalIndex: 0, name: 'duration', value: 30 }] },
  { outcome: 'updated', review: { mode: 'per_tag_binary', decisions: [{ tagId: '3:0', accepted: true }] }, acceptedTags: [{ tagId: '3:0', name: 'duration', value: 30 }] },
])('标签复核缺少有效布尔票时不把旧状态或程序采纳解释为批准（%j）', async output => {
  const audit = await openAudit({ member: { output }, batches: [] });
  expect(audit).toHaveTextContent('LLM 复核未记录');
  expect(audit).not.toHaveTextContent('已通过');
  expect(audit).not.toHaveTextContent('YES (true)');
  expect(audit).not.toHaveTextContent('逐标签二元复核 · 通过');
  expect(audit).not.toHaveTextContent('旧聚合');
});

test.each([true, false])('逐标签二元复核只按显式布尔票计数，含通过标签：%s', async accepted => {
  const audit = await openAudit({ member: { output: {
    outcome: accepted ? 'partial_success' : 'failed', complete: true,
    review: { mode: 'per_tag_binary', decisions: accepted ? [true, false] : [false] },
    acceptedTags: accepted ? [{ proposalIndex: 0, name: 'duration', value: 30, evidence: [] }] : [],
    rejectedTags: [{ proposalIndex: accepted ? 1 : 0, name: 'bulk_purchase', value: 'supported', reasonCode: 'review_rejected', evidence: [] }],
  } }, batches: [] });
  expect(within(audit).getByText('逐标签二元复核 · 通过 ' + (accepted ? 1 : 0) + ' · 拒绝 1')).toBeInTheDocument();
  expect(audit).toHaveTextContent('LLM 对该标签判定为否');
  expect(audit).toHaveTextContent('NO (false)');
  expect(audit).not.toHaveTextContent('历史 LLM 复核');
  expect(audit.querySelectorAll('q')).toHaveLength(0);
  if (accepted) {
    expect(audit).toHaveTextContent('使用期限：1个月');
    expect(audit).toHaveTextContent('YES (true)');
    expect(audit).toHaveTextContent('结果：部分成功');
  } else {
    expect(audit).toHaveTextContent('结果：失败');
    expect(audit).not.toHaveTextContent('YES (true)');
  }
});

test('提取和复核请求分别展示用量，阶段进度按批次计数', async () => {
  installApi({ handle(call) {
    if (call.path.endsWith('/jobs/8')) return Response.json({ job: { id: '8', status: 'succeeded' }, progress: {
      rawProductCount: 1, processed: '1',
      tagStages: { extractionCompleted: 3, reviewQueued: 2, reviewRunning: 1, reviewCompleted: 4, publicationQueued: 5 },
    } });
    if (call.path.endsWith('/tag-results/3')) return Response.json({ member: { output: { outcome: 'updated', review: { mode: 'per_tag_binary', decisions: [] } } }, batches: [
      { stage: 'extract', batch_index: 0, round: 0, status: 'succeeded', response_ms: 120, response_usage: { total_tokens: 42 } },
      { stage: 'review', batch_index: 1, round: 0, status: 'succeeded', response_ms: 230, response_usage: { total_tokens: 84 } },
      { batch_index: 2, round: 0, status: 'succeeded', response_ms: null, response_usage: null },
    ] });
  } });
  const user = userEvent.setup(); render(<TagExtractionPanel shops={shops} />);
  await user.click(await screen.findByRole('button', { name: '查看标签任务 #8' }));
  const detail = screen.getByRole('region', { name: '标签任务详情' });
  const stages = within(detail).getByRole('list', { name: '标签抽取阶段' });
  expect(stages).toHaveTextContent('提取标签3 批已提取');
  expect(stages).toHaveTextContent('LLM 二元复核4 批已完成 · 2 批排队 · 1 批进行中');
  expect(stages).toHaveTextContent('本地发布5 批待发布');
  await user.click(await screen.findByRole('button', { name: '查看商品 #3 依据' }));
  const extract = await screen.findByText(/提取 · 第 1 批/);
  expect(extract).toHaveTextContent('120 毫秒 · token total_tokens: 42');
  expect(extract).not.toHaveTextContent('84');
  const review = screen.getByText(/复核 · 第 2 批/);
  expect(review).toHaveTextContent('230 毫秒 · token total_tokens: 84');
  expect(review).not.toHaveTextContent('42');
  expect(screen.getByText(/阶段未记录 · 第 3 批/)).toHaveTextContent('耗时 不可用 · token 用量不可用');
});

test('范围预览显示正常两阶段调用数并沿用费用确认', async () => {
  installApi({ handle(call) {
    if (call.path.endsWith('/preview')) return Response.json({ model: 'mock', previewDigest: 'c'.repeat(64), counts: { selected: 3, eligible: 3, requestBatches: 3 } });
  } });
  const user = userEvent.setup(); render(<TagExtractionPanel shops={shops} />);
  await user.click(screen.getByRole('button', { name: '新建标签任务' }));
  await user.type(screen.getByRole('textbox', { name: /商品 ID/ }), '3,4,5');
  await user.click(screen.getByRole('button', { name: '预览标签范围' }));
  const create = await screen.findByRole('button', { name: '确认创建标签任务' });
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText('预计模型调用（正常两阶段）').nextElementSibling).toHaveTextContent(/^6$/);
  expect(within(dialog).getByText(/提取 LLM → 复核 LLM → 原子发布/)).toBeInTheDocument();
  expect(within(dialog).getByText(/每个初始批次通常调用模型 2 次/)).toBeInTheDocument();
  expect(within(dialog).getByText(/一次提取、一次批量复核/)).toBeInTheDocument();
  expect(within(dialog).getByText(/每批可包含多个商品及其多个候选标签/)).toBeInTheDocument();
  expect(within(dialog).getByText(/逐标签只判 YES\/NO，不纠正或补充标签/)).toBeInTheDocument();
  expect(within(dialog).getByText(/提取和复核两个阶段均可能产生费用/)).toBeInTheDocument();
  expect(create).toBeDisabled();
  await user.click(within(dialog).getByRole('checkbox', { name: /我确认可能消耗模型额度/ }));
  expect(create).toBeEnabled();
});

test.each([
  ['updated', 2, 5, 1, '部分采纳，已更新'],
  ['updated', 0, 1, 3, '已更新，仍需复核'],
  ['review', 2, 5, 0, '部分采纳，待复核'],
  ['review', 0, 5, 0, '待复核'],
  ['updated', 2, 0, 1, '实际更新'],
  ['unchanged', 2, 0, 0, '无变化'],
  ['empty', 0, 0, 0, '无可确认标签'],
])('商品 %s（通过 %i、拒绝 %i）在列表和依据中准确显示结果', async (outcome, acceptedCount, rejectedCount, changedFields, label) => {
  const acceptedTags = [{ name: 'duration', value: 30, evidence: [{ path: 'spec', quote: '一个月' }] }, { name: 'region', value: 'US', evidence: [{ path: 'spec', quote: '美区' }] }].slice(0, acceptedCount);
  const rejectedTags = Array.from({ length: rejectedCount }, () => ({ name: 'renewable', value: 'yes', evidence: [], reasonCode: 'evidence_invalid', reason: '证据不足' }));
  installApi({ handle(call) {
    if (call.path.endsWith('task-queue')) return Response.json({ items: [{ id: '8', status: 'succeeded', unclassified: rejectedCount ? 1 : 0 }], summary: { currentReasons: rejectedCount ? { tag_evidence_rejected: 1 } : {} } });
    if (call.path.endsWith('/tag-results')) return Response.json({ items: [{ id: '3', name: '结果商品', outcome, acceptedCount, rejectedCount, changedFields, reason_code: rejectedCount ? 'tag_evidence_rejected' : null }] });
    if (call.path.endsWith('/tag-results/3')) return Response.json({ member: { output: { outcome, acceptedTags, rejectedTags, diff: changedFields ? [{ name: 'duration', before: [], after: ['1 month'] }] : [] } }, batches: [] });
    if (call.path.endsWith('/jobs/8')) return Response.json({
      job: { id: '8', status: 'succeeded' },
      progress: { rawProductCount: 1, processed: '1', tagResults: { [outcome]: 1 }, tagAcceptance: { acceptedTags: acceptedCount, rejectedTags: rejectedCount, partialProducts: acceptedCount && rejectedCount ? 1 : 0 }, requests: { totalBatches: 1, succeededBatches: 1, failedBatches: 0 } },
    });
  } });
  const user = userEvent.setup();
  render(<TagExtractionPanel shops={shops} view="history" />);
  const jobButton = await screen.findByRole('button', { name: '查看标签任务 #8' });
  const row = jobButton.closest('tr');
  expect(within(row).getByText(rejectedCount ? '处理结束（需关注结果）' : '处理结束')).toBeInTheDocument();
  if (rejectedCount) expect(within(row).getByText('需关注商品：1')).toBeInTheDocument();
  await user.click(jobButton);
  const member = (await screen.findByRole('button', { name: '查看商品 #3 依据' })).closest('li');
  expect(within(member).getByText(new RegExp(label))).toBeInTheDocument();
  expect(within(member).getByText(`通过 ${acceptedCount} · 拒绝 ${rejectedCount} · 变化字段 ${changedFields}`)).toBeInTheDocument();
  const detail = screen.getByRole('region', { name: '标签任务详情' });
  expect(within(detail).getByText('失败批次').nextElementSibling).toHaveTextContent(/^0$/);
  expect(within(detail).getByText('通过标签（条）').nextElementSibling).toHaveTextContent(String(acceptedCount));
  expect(within(detail).getByText('拒绝标签（条）').nextElementSibling).toHaveTextContent(String(rejectedCount));
  if (rejectedCount) {
    expect(screen.getAllByText(/有标签未通过校验，请查看商品依据/).length).toBeGreaterThan(0);
    expect(within(detail).getByText(/处理结束（需关注结果）/)).toBeInTheDocument();
  } else {
    expect(within(detail).queryByText(/需关注结果/)).not.toBeInTheDocument();
    expect(within(member).queryByText(/部分采纳|待复核/)).not.toBeInTheDocument();
  }
  await user.click(within(member).getByRole('button'));
  expect(await within(member).findByText(new RegExp(`结果：${label}`))).toBeInTheDocument();
  if (acceptedCount) expect(within(member).getByText('使用期限：1个月')).toBeInTheDocument();
  if (rejectedCount) expect(within(member).getAllByText(/商品证据引用无效/).length).toBeGreaterThan(0);
});

test('历史未记录与未知原因保留不确定性和诊断线索', async () => {
  installApi({ handle(call) {
    if (call.path.endsWith('/tag-results')) return Response.json({ items: [{ id: '3', name: '旧商品', outcome: 'unrecorded', acceptedCount: 0, rejectedCount: 0, reason_code: 'future_reason' }] });
  } });
  const user = userEvent.setup(); render(<TagExtractionPanel shops={shops} />);
  await user.click(await screen.findByRole('button', { name: '查看标签任务 #8' }));
  const member = (await screen.findByRole('button', { name: '查看商品 #3 依据' })).closest('li');
  expect(within(member).getByText(/未记录（未经验证）/)).toBeInTheDocument();
  expect(within(member).getByText(/未识别原因（future_reason），请查看商品依据/)).toBeInTheDocument();
});

test('旧版本任务显示阻塞原因，版本信息默认折叠', async () => {
  installApi({ handle(call) {
    if (call.path.endsWith('task-queue')) return Response.json({ items: [{ id: '8', status: 'queued', configurationCurrent: false, pipelineVersions: { tagPrompt: 'old' } }], summary: {} });
  } });
  render(<TagExtractionPanel shops={shops} view="history" />);
  const row = (await screen.findByRole('button', { name: '查看标签任务 #8' })).closest('tr');
  expect(within(row).getByText('版本已过期')).toBeInTheDocument();
  const disclosure = within(row).getByText('版本信息').closest('details');
  expect(disclosure).not.toHaveAttribute('open');
});

test('批量新建任务明确全站选取范围且不等待证据预览', async () => {
  const calls = installApi({ handle(call) {
    if (call.path === '/api/ai/tag-jobs') return Response.json({ id: '9', phase: 'preparing' });
  } });
  const user = userEvent.setup(); render(<TagExtractionPanel shops={shops} />);
  await user.click(screen.getByRole('button', { name: '批量新建标签任务' }));
  expect(screen.getByText(/为全站符合条件、需要抽取标签的商品创建新任务/)).toBeInTheDocument();
  const dialog = screen.getByRole('dialog');
  const create = within(dialog).getByRole('button', { name: '确认创建标签任务' });
  expect(create).toBeDisabled();
  expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument();
  expect(within(dialog).queryByRole('combobox')).not.toBeInTheDocument();
  expect(calls.some(call => call.path.endsWith('/preview'))).toBe(false);
  expect(within(dialog).getByText(/资料和流水线版本未变化时，已完成的部分采纳及待复核结果不会自动重新入队/)).toBeInTheDocument();
  expect(within(dialog).queryByText(/请勾选商品后定向重试/)).not.toBeInTheDocument();
  expect(within(dialog).getByText(/提取和复核两个阶段均可能产生费用/)).toBeInTheDocument();
  expect(within(dialog).getByText(/一次提取、一次批量复核/)).toBeInTheDocument();
  expect(within(dialog).getByText(/逐标签只判 YES\/NO，不纠正或补充标签/)).toBeInTheDocument();
  await user.click(within(dialog).getByRole('checkbox', { name: /我确认可能消耗模型额度/ }));
  await user.click(create);
  await screen.findByText('标签任务 #9');
  expect(calls.find(call => call.path === '/api/ai/tag-jobs').body).toEqual({ allPending: true, requestId: expect.any(String), acknowledgePossibleCharge: true });
});

test('全部任务网络重试复用请求 ID', async () => {
  let submissions = 0;
  const calls = installApi({ handle(call) {
    if (call.path === '/api/ai/tag-jobs') return ++submissions === 1 ? Response.json({error:{message:'网络中断'}},{status:503}) : Response.json({id:'9'});
  } });
  const user = userEvent.setup(); render(<TagExtractionPanel shops={shops} />);
  await user.click(screen.getByRole('button', { name: '批量新建标签任务' }));
  await user.click(screen.getByRole('checkbox', { name: /我确认可能消耗模型额度/ }));
  await user.click(screen.getByRole('button', { name: '确认创建标签任务' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('网络中断');
  await user.click(screen.getByRole('button', { name: '确认创建标签任务' }));
  await screen.findByText('标签任务 #9');
  const posts = calls.filter(call => call.path === '/api/ai/tag-jobs');
  expect(posts[1].body).toEqual(posts[0].body);
});

test('未打开详情时列表定时刷新，卸载后停止', async () => {
  const calls = installApi({ state: 'running' });
  vi.useFakeTimers();
  const view = render(<TagExtractionPanel shops={shops} />);
  try {
    await act(async () => {});
    expect(screen.getByRole('button', { name: '查看标签任务 #8' })).toBeInTheDocument();
    const before = calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(calls.length).toBeGreaterThan(before);
    view.unmount();
    const after = calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(calls).toHaveLength(after);
  } finally { view.unmount(); vi.useRealTimers(); }
});

test('列表响应超过刷新周期时不重叠请求，结果仍能显示并继续刷新', async () => {
  const calls = installApi({ handle(call) {
    if (call.path.endsWith('task-queue')) return new Promise(resolve => setTimeout(() => resolve(Response.json({ items: [{ id: '8', processed: calls.length, total: 3 }] })), 12000));
  } });
  vi.useFakeTimers();
  const view = render(<TagExtractionPanel shops={shops} view="history" />);
  try {
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(calls).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(screen.getByRole('button', { name: '查看标签任务 #8' })).toBeInTheDocument();
    expect(screen.getByText('1 / 3')).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(18000));
    expect(calls).toHaveLength(2);
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(screen.getByText('2 / 3')).toBeInTheDocument();
  } finally { view.unmount(); vi.useRealTimers(); }
});

test('新建任务的预览绑定商品范围，网络失败复用 UUID 和摘要', async () => {
  let attempts = 0;
  const calls = installApi({ handle(call) {
    if (call.path.endsWith('/preview')) return Response.json({ previewDigest: 'a'.repeat(64), model: 'test-model', counts: { selected: 1, eligible: 1, protected: 0, missing: 0, oversized: 0, uniqueInputs: 1, requestBatches: 1 } });
    if (call.path === '/api/ai/tag-jobs') {
      if (++attempts === 1) throw new Error('network lost');
      return Response.json({ id: '9' });
    }
  } });
  const user = userEvent.setup(); render(<TagExtractionPanel shops={shops} />);
  await user.click(screen.getByRole('button', { name: '新建标签任务' }));
  await user.type(screen.getByRole('textbox', { name: /商品 ID/ }), '3');
  await user.click(screen.getByRole('button', { name: '预览标签范围' }));
  const create = await screen.findByRole('button', { name: '确认创建标签任务' });
  expect(create).toBeDisabled();
  await user.click(screen.getByRole('checkbox', { name: /我确认可能消耗模型额度/ }));
  await user.click(create);
  expect(await screen.findByRole('alert')).toHaveTextContent('network lost');
  await user.click(create);
  await screen.findByText('标签任务 #9');
  const posts = calls.filter(call => call.path === '/api/ai/tag-jobs');
  expect(posts).toHaveLength(2); expect(posts[0].body).toEqual(posts[1].body);
  expect(posts[0].body).toEqual({ productIds: ['3'], previewDigest: 'a'.repeat(64), acknowledgePossibleCharge: true, requestId: expect.any(String) });
  expect(calls.some(call => call.path.endsWith('/retry'))).toBe(false);
});

test('修改创建范围使旧预览失效，店铺范围不能混用商品 ID', async () => {
  const calls = installApi({ handle(call) { if (call.path.endsWith('/preview')) return Response.json({ previewDigest: 'b'.repeat(64), model: 'test-model', counts: { selected: 1, eligible: 1 } }); } });
  const user = userEvent.setup(); render(<TagExtractionPanel shops={shops} />);
  await user.click(screen.getByRole('button', { name: '新建标签任务' }));
  await user.selectOptions(screen.getByRole('combobox', { name: '范围店铺' }), '1');
  await user.click(screen.getByRole('button', { name: '预览标签范围' }));
  await screen.findByRole('button', { name: '确认创建标签任务' });
  expect(calls.find(call => call.path.endsWith('/preview')).body).toEqual({ scopeShopId: '1' });
  await user.type(screen.getByRole('textbox', { name: /商品 ID/ }), '3');
  expect(screen.queryByRole('button', { name: '确认创建标签任务' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '预览标签范围' }));
  expect((await screen.findAllByText(/不能同时使用/)).length).toBeGreaterThan(0);
  expect(calls.filter(call => call.path.endsWith('/preview'))).toHaveLength(1);
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '新建标签任务' })).toHaveFocus();
});

test('商品展开显示通过拒绝证据、写入差异、版本和已记录用量', async () => {
  installApi(); const user = userEvent.setup(); render(<TagExtractionPanel shops={shops} />);
  await user.click(await screen.findByRole('button', { name: '查看标签任务 #8' }));
  await user.click(await screen.findByRole('button', { name: '查看商品 #3 依据' }));
  expect(await screen.findByText('一个月')).toBeInTheDocument();
  expect(screen.getByText(/证据不足/)).toBeInTheDocument();
  expect(screen.getByText(/使用期限：无 → 1个月/)).toBeInTheDocument();
  expect(screen.getByText(/total_tokens: 42/)).toBeInTheDocument();
  expect(screen.queryByText(/保留但本次未确认/)).not.toBeInTheDocument();
  expect(screen.getByText(/来源身份任务 #7/)).toBeInTheDocument();
});

test('暂停继续取消后以服务端快照更新状态，网络错误可刷新恢复', async () => {
  let fail = false;
  const calls = installApi({ state: 'running', handle(call, job) {
    if (call.path.endsWith('/pause')) { job.status = 'paused'; return Response.json({}); }
    if (call.path.endsWith('/resume')) { job.status = 'running'; return Response.json({}); }
    if (call.path.endsWith('/cancel')) { job.status = 'cancelled'; return Response.json({}); }
    if (call.path.endsWith('/jobs/8') && fail) throw new Error('snapshot unavailable');
  } });
  const user = userEvent.setup(); render(<TagExtractionPanel shops={shops} />);
  await user.click(await screen.findByRole('button', { name: '查看标签任务 #8' }));
  await user.click(await screen.findByRole('button', { name: '暂停标签任务' }));
  await user.click(await screen.findByRole('button', { name: '继续标签任务' }));
  await screen.findByRole('button', { name: '暂停标签任务' });
  fail = true; await user.click(screen.getByRole('button', { name: '刷新标签状态' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('snapshot unavailable');
  fail = false; await user.click(screen.getByRole('button', { name: '刷新标签状态' }));
  await user.click(await screen.findByRole('button', { name: '取消标签任务' }));
  await vi.waitFor(() => expect(screen.queryByRole('button', { name: '取消标签任务' })).not.toBeInTheDocument());
  expect(calls.filter(call => call.method === 'POST').map(call => call.path)).toEqual(['/api/ai/jobs/8/pause', '/api/ai/jobs/8/resume', '/api/ai/jobs/8/cancel']);
});

test('SSE 错误可见，open 重连读取权威快照并在卸载清理', async () => {
  class Source {
    static instances = [];
    listeners = new Map(); closed = false;
    constructor() { Source.instances.push(this); }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    removeEventListener(name) { this.listeners.delete(name); }
    close() { this.closed = true; }
    emit(name, data = {}) { this.listeners.get(name)?.(data); }
  }
  vi.stubGlobal('EventSource', Source);
  const calls = installApi({ state: 'running' });
  function Parent() { const [, setVersion] = React.useState(0); return <TagExtractionPanel shops={shops} view="history" onProductsChanged={() => setVersion(value => value + 1)} />; }
  const user = userEvent.setup(); const view = render(<Parent />);
  await user.click(await screen.findByRole('button', { name: '查看标签任务 #8' }));
  await screen.findByRole('button', { name: '暂停标签任务' });
  const source = Source.instances.at(-1);
  const before = calls.filter(call => call.path.endsWith('/jobs/8')).length;
  await act(async () => source.emit('error'));
  expect(screen.getByText(/实时连接中断/)).toBeInTheDocument();
  await act(async () => source.emit('open'));
  await vi.waitFor(() => expect(calls.filter(call => call.path.endsWith('/jobs/8')).length).toBeGreaterThan(before));
  await vi.waitFor(() => expect(screen.queryByText(/实时连接中断/)).not.toBeInTheDocument());
  const queueReads = calls.filter(call => call.path.endsWith('task-queue')).length;
  await act(async () => source.emit('progress', { data: JSON.stringify({ version: '2' }) }));
  expect(calls.filter(call => call.path.endsWith('task-queue'))).toHaveLength(queueReads);
  expect(Source.instances).toHaveLength(1);
  view.unmount(); expect(source.closed).toBe(true); expect(source.listeners.size).toBe(0);
});

test('切换任务忽略迟到响应，队列过滤与空态一致', async () => {
  let resolveOld;
  const old = new Promise(resolve => { resolveOld = resolve; });
  const calls = installApi({ handle(call) {
    if (call.path.endsWith('task-queue')) return Response.json({ items: call.query.get('scopeShopId') ? [] : [{ id: '8' }, { id: '9' }] });
    if (call.path.endsWith('/jobs/8')) return old;
  } });
  const user = userEvent.setup(); render(<TagExtractionPanel shops={shops} view="history" />);
  await user.click(await screen.findByRole('button', { name: '查看标签任务 #8' }));
  await screen.findByText('正在读取任务详情…');
  await user.click(screen.getByRole('button', { name: '关闭标签任务详情' }));
  await user.click(screen.getByRole('button', { name: '查看标签任务 #9' }));
  await screen.findByText(/来源身份任务 #7/);
  await act(async () => resolveOld(Response.json({ job: { id: '8', status: 'failed', model: 'STALE' } })));
  expect(screen.queryByText(/STALE/)).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '关闭标签任务详情' }));
  await user.selectOptions(screen.getByRole('combobox', { name: '任务筛选' }), 'attention');
  await user.selectOptions(screen.getByRole('combobox', { name: '店铺筛选' }), '1');
  expect(await screen.findByText('暂无匹配的标签任务')).toBeInTheDocument();
  expect(calls.some(call => call.query.get('jobType') === 'tag_extraction' && call.query.get('status') === 'attention' && call.query.get('scopeShopId') === '1')).toBe(true);
});

test('任务和商品分页在刷新详情后保留', async () => {
  const calls = installApi({ handle(call) {
    if (call.path.endsWith('task-queue')) return Response.json({ items: [{ id: call.query.has('cursor') ? '7' : '8', status: 'succeeded' }], summary: { total: 11 }, nextCursor: call.query.has('cursor') ? null : 'queue-next' });
    if (call.path.endsWith('tag-results')) return Response.json({ items: [{ id: call.query.has('cursor') ? '4' : '3', name: call.query.has('cursor') ? '第二页商品' : '第一页商品', outcome: 'failed', changedFields: 0 }], nextCursor: call.query.has('cursor') ? null : 'member-next' });
  } });
  const user = userEvent.setup(); render(<TagExtractionPanel shops={shops} view="history" />);
  await user.click(await screen.findByRole('button', { name: '下一页' }));
  await user.click(await screen.findByRole('button', { name: '查看标签任务 #7' }));
  await screen.findByText('第一页商品');
  await user.click(screen.getByRole('button', { name: '加载更多商品结果' }));
  await screen.findByText('第二页商品');
  await user.click(screen.getByRole('button', { name: '刷新详情' }));
  expect(await screen.findByText('第二页商品')).toBeInTheDocument();
  expect(screen.getByText('第一页商品')).toBeInTheDocument();
  expect(calls.filter(call => call.query.get('cursor') === 'member-next').length).toBe(2);
  await user.click(screen.getByRole('button', { name: '关闭标签任务详情' }));
  expect(screen.getByRole('button', { name: '查看标签任务 #7' })).toBeInTheDocument();
  expect(screen.getByLabelText('标签抽取记录分页')).toHaveTextContent('第 2 / 2 页，共 11 条');
});

test.each([
  ['仅旧tagId和对象票', { tagId: '3:0' }, [{ tagId: '3:0', accepted: true }]],
  ['有索引但旧对象票', { proposalIndex: 0, tagId: '3:0' }, [{ tagId: '3:0', accepted: true }]],
  ['仅旧tagId和布尔票', { tagId: '3:0' }, [true]],
  ['混合对象和布尔票', { proposalIndex: 0, tagId: '3:0' }, [true, { tagId: '3:1', accepted: true }]],
])('旧候选标识不产生原始投票或程序处置：%s', async (_name, identity, decisions) => {
  const audit = await openAudit({ member: { output: {
    outcome: 'updated', review: { status: 'approved' },
    acceptedTags: [{ tagId: '3:0', name: 'duration', value: 30 }], rejectedTags: [],
  } }, batches: [
    { id: '91', stage: 'extract', proposals: [{ ...identity, name: 'duration', value: 30, evidence: [] }] },
    { id: '92', stage: 'review', extraction_batch_id: '91', review_decisions: decisions },
  ] });
  await userEvent.setup().click(within(audit).getByText('复核批次 #92 详情'));
  const table = within(audit).getByRole('table', { name: '复核批次 #92 候选判定' });
  expect(table).toHaveTextContent('LLM 原始投票未记录');
  expect(table).toHaveTextContent('程序处置索引未记录');
  expect(table).not.toHaveTextContent('3:0');
  expect(table).not.toHaveTextContent('YES (true)');
  expect(table).not.toHaveTextContent('程序采纳');
  expect(audit).not.toHaveTextContent('已通过');
});

test('索引候选按布尔向量展示结构化值，忽略冲突的旧tagId', async () => {
  const duration = { proposalIndex: 0, tagId: 'ignored:1', name: 'duration', value: { kind: 'min', days: 30 }, evidence: [] };
  const bulk = { proposalIndex: 1, tagId: 'ignored:0', name: 'bulk_purchase', value: 'supported', evidence: [] };
  const audit = await openAudit({ member: { output: {
    outcome: 'partial_success', complete: true, review: { mode: 'per_tag_binary', decisions: [true, false] },
    acceptedTags: [{ ...duration, tagId: 'ignored:0' }], rejectedTags: [{ ...bulk, tagId: 'ignored:1', reasonCode: 'review_rejected' }],
  } }, batches: [
    { id: '91', stage: 'extract', proposals: [bulk, duration] },
    { id: '92', stage: 'review', extraction_batch_id: '91', review_decisions: [true, false] },
  ] });
  await userEvent.setup().click(within(audit).getByText('复核批次 #92 详情'));
  const table = within(audit).getByRole('table', { name: '复核批次 #92 候选判定' });
  const durationRow = within(table).getByText('使用期限：至少1个月').closest('tr');
  expect(durationRow).toHaveTextContent('#0');
  expect(durationRow).toHaveTextContent('YES (true)');
  expect(durationRow).toHaveTextContent('程序采纳');
  const bulkRow = within(table).getByText('批量购买：支持批量购买').closest('tr');
  expect(bulkRow).toHaveTextContent('#1');
  expect(bulkRow).toHaveTextContent('NO (false)');
  expect(bulkRow).toHaveTextContent('LLM 对该标签判定为否');
  expect(table).not.toHaveTextContent('ignored:');
});
