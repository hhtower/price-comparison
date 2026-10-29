import React from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AiWorkbench from './AiWorkbench.jsx';

function response(value, status = 200) {
  return Response.json(value, { status });
}

const shops = { items: [{ id: '1', name: '测试店' }] };
const progress = {
  version: '7', rawProductCount: 12, uniqueInputCount: 9, processed: 12,
  requests: { totalBatches: 3, queuedBatches: 0, runningBatches: 0, succeededBatches: 2, failedBatches: 1, cancelledBatches: 0, confirmed: 2, unknown: 1, budgetUsed: 3, budgetLimit: 4 },
  publication: { totalUnits: 4, queuedUnits: 0, runningUnits: 0, succeededUnits: 3, blockedUnits: 1, failedUnits: 0, cancelledUnits: 0, publishedMembers: 8, pendingMembers: 1 },
  results: { classified: 8, unclassified: 4, unclassifiedReasons: { missing_identity: 3, publication_blocked: 1 }, standardProducts: 2 },
  missing: { scheduledInputs: 3, reprocessedInputs: 3 },
};
const job = { id: '8', status: 'succeeded', model: 'test-model', scopeShopId: '1', promptVersion: 'identity-v1', createdAt: '2026-09-20T08:00:00Z', finishedAt: '2026-09-20T08:01:00Z' };
const status = { configured: true, configError: '', model: 'test-model', job, progress, currentBatches: [], errors: [] };

function installFetch(handler) {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
    const url = new URL(String(input), 'http://localhost');
    calls.push({ path: url.pathname, search: url.search, method: init.method || 'GET', body: init.body && JSON.parse(init.body) });
    return handler(url, init);
  }));
  return calls;
}

describe('AiWorkbench', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal('EventSource', undefined);
  });

  test('六个入口按任务与记录成对排列，支持键盘切换并关联面板', async () => {
    installFetch(url => url.pathname.endsWith('/task-queue') ? response({ items: [] }) : response(status));
    const user = userEvent.setup();
    render(<AiWorkbench shops={shops} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map(tab => tab.textContent)).toEqual(['抓取', '抓取记录', '标准化', '标准化记录', '标签抽取', '标签抽取记录']);
    expect(screen.queryByRole('button', { name: '新建任务' })).not.toBeInTheDocument();
    tabs[0].focus();
    await user.keyboard('{ArrowRight}');
    expect(tabs[1]).toHaveFocus();
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: '抓取记录' })).toHaveAttribute('id', tabs[1].getAttribute('aria-controls'));
    await user.keyboard('{End}');
    expect(tabs[5]).toHaveFocus();
    expect(screen.getByRole('tabpanel', { name: '标签抽取记录' })).toBeInTheDocument();
    await user.keyboard('{ArrowRight}');
    expect(tabs[0]).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(tabs[5]).toHaveFocus();
    await user.keyboard('{Home}');
    expect(tabs[0]).toHaveFocus();
    expect(tabs.filter(tab => tab.tabIndex === 0)).toEqual([tabs[0]]);
  });

  test('标签监控展示最近任务，记录默认全部并保留筛选，详情用弹窗查看', async () => {
    const calls = installFetch(url => {
      if (url.pathname === '/api/admin/ai/task-queue') return response({ items: [{ id: '8', status: 'succeeded' }], summary: {} });
      if (url.pathname.endsWith('/tag-results')) return response({ items: [] });
      return response(status);
    });
    const user = userEvent.setup();
    render(<AiWorkbench shops={shops} />);
    await user.click(screen.getByRole('tab', { name: '标签抽取' }));
    expect(screen.queryByRole('combobox', { name: '任务筛选' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: '查看标签任务 #8' }));
    await screen.findByRole('heading', { name: '标签任务 #8' });
    expect(screen.getByRole('dialog', { name: '标签任务详情' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('tab', { name: '标签抽取记录' }));
    expect(screen.getByRole('combobox', { name: '任务筛选' })).toHaveValue('all');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('AI 服务已配置')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '新建标签任务' })).not.toBeInTheDocument();
    await screen.findByRole('button', { name: '查看标签任务 #8' });
    expect(calls.some(call => call.search.includes('jobType=tag_extraction') && call.search.includes('status=all'))).toBe(true);
    await user.selectOptions(screen.getByRole('combobox', { name: '任务筛选' }), 'attention');
    await user.click(screen.getByRole('tab', { name: '标签抽取' }));
    expect(screen.queryByRole('combobox', { name: '任务筛选' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新建标签任务' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: '标签抽取记录' }));
    expect(screen.getByRole('combobox', { name: '任务筛选' })).toHaveValue('attention');
  });

  test('标签抽取配置由服务端状态传入，关闭后保留记录入口', async () => {
    installFetch(url => url.pathname.endsWith('/task-queue') ? response({ items: [] }) : response({ ...status, tagExtractionEnabled: false }));
    const user = userEvent.setup();
    render(<AiWorkbench shops={shops} />);
    await user.click(screen.getByRole('tab', { name: '标签抽取' }));
    expect(await screen.findByText(/标签抽取功能未启用/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新建标签任务' })).toBeDisabled();
    await user.click(screen.getByRole('tab', { name: '标签抽取记录' }));
    expect(screen.getByRole('region', { name: '标签抽取记录' })).toBeInTheDocument();
  });

  test('标签页面不加载或轮询无关的标准化队列', async () => {
    const calls = installFetch(url => {
      if (url.pathname.endsWith('/task-queue')) return response({ items: [], summary: { total: 0 } });
      return response(status);
    });
    render(<AiWorkbench shops={shops} />);
    await userEvent.setup().click(screen.getByRole('tab', { name: '标签抽取' }));
    await screen.findByText('暂无标签抽取任务');
    const queueReads = calls.filter(call => call.path === '/api/admin/ai/task-queue');
    expect(queueReads.length).toBeGreaterThan(0);
    expect(queueReads.every(call => call.search.includes('jobType=tag_extraction'))).toBe(true);
  });

  test('刷新标签状态同步开关配置，无需刷新页面即可重新开启创建', async () => {
    let enabled = false;
    installFetch(url => url.pathname.endsWith('/task-queue') ? response({ items: [] }) : response({ ...status, tagExtractionEnabled: enabled }));
    const user = userEvent.setup();
    render(<AiWorkbench shops={shops} />);
    await user.click(screen.getByRole('tab', { name: '标签抽取' }));
    expect(await screen.findByText(/标签抽取功能未启用/)).toBeInTheDocument();
    enabled = true;
    await user.click(screen.getByRole('button', { name: '刷新标签状态' }));
    expect(screen.getByRole('button', { name: '新建标签任务' })).toBeEnabled();
    expect(screen.queryByText(/标签抽取功能未启用/)).not.toBeInTheDocument();
    enabled = false;
    await user.click(screen.getByRole('button', { name: '刷新标签状态' }));
    expect(screen.getByRole('button', { name: '新建标签任务' })).toBeDisabled();
  });

  test('新建标准化任务说明生成和复核两阶段的模型用量', async () => {
    installFetch(url => url.pathname.endsWith('/task-queue') ? response({ items: [] }) : response(status));
    render(<AiWorkbench shops={shops} />);
    await userEvent.setup().click(screen.getByRole('tab', { name: '标准化' }));
    await userEvent.setup().click(screen.getByRole('button', { name: '新建任务' }));
    expect(within(screen.getByRole('dialog', { name: '新建任务' })).getByText(/一次生成和一次 LLM 二元复核/)).toBeInTheDocument();
  });

  test('标准化监控集中展示统计和操作，任务运行概览不再显示运行详情', async () => {
    installFetch(url => url.pathname.endsWith('/task-queue') ? response({
      items: [], summary: { unfinished: 8, queued: 5, running: 2, paused: 1, attention: 3, pendingProducts: 120, pendingEvents: 4 },
    }) : response(status));
    const user = userEvent.setup();
    render(<AiWorkbench shops={shops} />);
    await user.click(screen.getByRole('tab', { name: '标准化' }));
    const queue = await screen.findByRole('region', { name: '标准化队列' });
    expect(within(queue).getByRole('heading', { name: '标准化监控' })).toBeInTheDocument();
    expect(within(queue).getByRole('button', { name: '新建任务' })).toBeInTheDocument();
    expect(within(queue).getByRole('button', { name: '刷新状态' })).toBeInTheDocument();
    for (const metric of ['排队中5', '进行中2', '已暂停 / 待继续1', '异常任务3', '未处理商品120', '待建任务商品4']) {
      expect(queue).toHaveTextContent(metric);
    }
    expect(screen.queryByRole('region', { name: '未完成标准化任务' })).not.toBeInTheDocument();
    expect(within(queue).queryByText('未完成任务')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText(/一次爬取对应一个标准化任务/)).not.toBeInTheDocument();
    expect(screen.queryByText(/统计覆盖全部任务/)).not.toBeInTheDocument();
    expect(screen.queryByText(/执行异常可在重试任务中处理/)).not.toBeInTheDocument();
    const region = screen.getByRole('region', { name: '任务运行概览' });
    expect(within(region).getByRole('heading', { name: '任务运行概览' })).toBeInTheDocument();
    expect(region).toHaveTextContent('任务 #8');
    expect(within(region).getByRole('progressbar', { name: '商品处理进度' })).toHaveAttribute('value', '12');
    expect(within(region).queryByText('运行详情')).not.toBeInTheDocument();
    expect(within(region).queryByText('唯一输入')).not.toBeInTheDocument();
    expect(within(region).getByText(/未识别商品身份/)).toBeVisible();
  });

  test('失败批次可查看结构化诊断，历史缺失不伪装为已记录', async () => {
    installFetch(url => {
      if (url.pathname === '/api/admin/ai/status') return response({ ...status, errors: [
        { batchIndex: 2, step: 'request', error: 'AI items 无效', responseId: 'response-audit-1', responseModel: 'actual-model',
          responseMs: 42, responseUsage: { totalTokens: 30 }, diagnostic: {
            phase: 'schema', code: 'items_limit_exceeded', fieldPath: 'items', inputCount: 1, returnedItemCount: null,
            rejectedItemCount: 0, missingItemCount: 0, outputBytes: 100, chunkCount: 3, finishReason: 'stop',
            constraint: { maxCount: 1, actualCount: 2 }, issues: [{ stage: 'schema', code: 'items_limit_exceeded', fieldPath: 'items' }],
            contentSha256: 'a'.repeat(64),
          } },
        { batchIndex: 1, step: 'request', error: 'AI response JSON is invalid' },
      ] });
      if (url.pathname === '/api/admin/ai/task-queue') return response({ items: [job] });
      return response({}, 404);
    });
    const user = userEvent.setup();
    render(<AiWorkbench shops={shops} />);
    await user.click(screen.getByRole('tab', { name: '标准化' }));
    const records = await screen.findByRole('region', { name: '任务处理记录' });
    expect(within(records).getByRole('list', { name: '失败批次记录' })).toBeInTheDocument();
    const summary = within(records).getByText('查看诊断');
    expect(summary.closest('details')).not.toHaveAttribute('open');
    await user.click(summary);
    expect(screen.getByText(/响应：response-audit-1/)).toBeInTheDocument();
    expect(screen.getByText(/原因：items_limit_exceeded/)).toHaveTextContent('字段：items');
    expect(screen.getByText(/约束：/)).toHaveTextContent('"actualCount":2');
    expect(screen.getByText('历史批次未记录结构化响应诊断')).toBeInTheDocument();
  });

  test('全局统计独立于最近任务，刷新后更新统计和执行情况而不加载队列分页', async () => {
    let pendingProducts = 3070;
    let latestId = '8';
    const calls = installFetch(url => {
      if (url.pathname === '/api/admin/ai/status') return response({ ...status, job: { ...job, id: latestId } });
      if (url.pathname === '/api/admin/ai/task-queue') return response({
        summary: { unfinished: 104, queued: 100, running: 3, paused: 1, attention: 2, pendingProducts, pendingEvents: 65,
          currentReasons: { evidence_invalid: 7, attribute_conflict: 9 } },
        items: [{ ...job, id: url.searchParams.has('cursor') ? '6' : '9', status: 'queued', sourceFetchRunId: '81', total: 97, processed: 32, remaining: 65 }],
        nextCursor: url.searchParams.has('cursor') ? null : 'next-page',
      });
      return response({}, 404);
    });
    const user = userEvent.setup();
    render(<AiWorkbench shops={shops} />);
    await user.click(screen.getByRole('tab', { name: '标准化' }));
    const overview = await screen.findByRole('region', { name: '标准化队列' });
    await within(overview).findByText('3,070');
    expect(overview).toHaveTextContent('未处理商品3,070');
    expect(overview).toHaveTextContent('待建任务商品65');
    expect(within(overview).queryByText('当前待处理原因')).not.toBeInTheDocument();
    expect(overview).not.toHaveTextContent('商品证据引用无效 · 7 件');
    expect(overview).not.toHaveTextContent('商品属性与证据冲突 · 9 件');
    const task = screen.getByRole('region', { name: '任务运行概览' });
    expect(task).toHaveTextContent('任务 #8');
    expect(task).toHaveTextContent('已分类8');
    pendingProducts = 3000;
    latestId = '10';
    await user.click(screen.getByRole('button', { name: '刷新状态' }));
    await vi.waitFor(() => expect(overview).toHaveTextContent('未处理商品3,000'));
    await vi.waitFor(() => expect(task).toHaveTextContent('任务 #10'));
    const queueCalls = calls.filter(call => call.search.includes('status=unfinished'));
    expect(queueCalls).toHaveLength(2);
    expect(queueCalls.every(call => call.search.includes('limit=1') && !call.search.includes('cursor='))).toBe(true);
  });

  test('重试任务提交全部待重试商品，断连后复用同一请求标识', async () => {
    const posts = [];
    installFetch((url, init) => {
      if (url.pathname === '/api/admin/ai/status') return response({ ...status, job: { ...job, id: '13', status: 'running' } });
      if (url.pathname === '/api/admin/ai/task-queue') return response({ items: [job] });
      if (url.pathname === '/api/admin/ai/retry-pool' && init.method !== 'POST') return response({ items: [], total: 1, nextCursor: null });
      if (url.pathname === '/api/ai/retry-pool' && init.method === 'POST') {
        posts.push(JSON.parse(init.body));
        if (posts.length === 1) throw new Error('connection lost');
        return response({ id: '14', total: '1' });
      }
      if (url.pathname === '/api/admin/ai/jobs/14') return response({ ...status, job: { ...job, id: '14', retry_request_id: 'submission' } });
      return response({}, 404);
    });
    const user = userEvent.setup();
    render(<AiWorkbench shops={shops} />);
    await user.click(screen.getByRole('tab', { name: '标准化' }));
    await screen.findByText(/任务 #13 ·/);
    await user.click(screen.getByRole('button', { name: '新建任务' }));
    await user.click(await screen.findByRole('button', { name: '重试任务（1 条）' }));
    await screen.findByText('connection lost');
    await user.click(screen.getByRole('button', { name: '重试任务（1 条）' }));
    await screen.findByText(/任务 #14 ·/);
    expect(posts).toHaveLength(2);
    expect(posts[0]).toEqual(posts[1]);
    expect(posts[0]).toMatchObject({ acknowledgePossibleCharge: true, requestId: expect.any(String) });
    expect(posts[0].productIds).toBeUndefined();
  });

  test('未分类原因以中文展示，不提供跳转到全局商品的待处理入口', async () => {
    installFetch(url => {
      if (url.pathname === '/api/admin/ai/status') return response({ ...status, progress: { ...progress, results: { ...progress.results, unclassified: 4, unclassifiedReasons: { source_changed: 4 } } } });
      if (url.pathname === '/api/admin/ai/task-queue') return response({ items: [job] });
      return response({}, 404);
    });
    const user = userEvent.setup();
    render(<AiWorkbench shops={shops} />);
    await user.click(screen.getByRole('tab', { name: '标准化' }));
    const region = await screen.findByRole('region', { name: '任务运行概览' });
    expect(region).toHaveTextContent('商品资料已变化 · 4 件');
    expect(region).toHaveTextContent('处理结束 · 有待处理商品');
    expect(screen.queryByRole('button', { name: '查看待处理商品' })).not.toBeInTheDocument();
    expect(region.querySelector('.ai-pending-callout')).toBeNull();
  });

  test('引用、属性、身份和目录发布失败按实际原因展示', async () => {
    installFetch(url => {
      if (url.pathname === '/api/admin/ai/status') return response({ ...status, progress: { ...progress,
        results: { ...progress.results, unclassifiedReasons: { evidence_invalid: 2, attribute_conflict: 3, identity_conflict: 4, publication_blocked: 5 } } } });
      if (url.pathname === '/api/admin/ai/task-queue') return response({ items: [job] });
      return response({}, 404);
    });
    render(<AiWorkbench shops={shops} />);
    await userEvent.setup().click(screen.getByRole('tab', { name: '标准化' }));
    const region = await screen.findByRole('region', { name: '任务运行概览' });
    for (const reason of ['商品证据引用无效 · 2 件', '商品属性与证据冲突 · 3 件', '标准商品身份冲突 · 4 件', '商品交付或目录需审核 · 5 件']) expect(region).toHaveTextContent(reason);
  });

  test('明确不能处理的商品不显示为待人工处理或任务异常', async () => {
    installFetch(url => {
      if (url.pathname === '/api/admin/ai/status') return response({ ...status, progress: { ...progress,
        results: { ...progress.results, unclassifiedReasons: { not_sellable: 1, insufficient_evidence: 3 } } } });
      if (url.pathname === '/api/admin/ai/task-queue') return response({ items: [] });
      return response({}, 404);
    });
    render(<AiWorkbench shops={shops} />);
    await userEvent.setup().click(screen.getByRole('tab', { name: '标准化' }));
    const region = await screen.findByRole('region', { name: '任务运行概览' });
    expect(region).toHaveTextContent('不能处理4');
    expect(region).not.toHaveTextContent('有待处理商品');
    expect(screen.queryByRole('button', { name: '查看待处理商品' })).not.toBeInTheDocument();
  });

  test('标准化记录用弹窗查看详情，关闭后保留筛选、分页与最新任务', async () => {
    const calls = installFetch(url => {
      if (url.pathname === '/api/admin/ai/status') return response(status);
      if (url.pathname === '/api/admin/ai/task-queue') return response({
        items: [{ ...job, id: url.searchParams.has('cursor') ? '7' : '9', scopeShopId: '2' }],
        nextCursor: url.searchParams.has('cursor') ? null : 'next-page',
        summary: { total: 11 },
      });
      if (url.pathname === '/api/admin/ai/jobs/7') return response({ job: { ...job, id: '7', scope_shop_id: '2', scopeShopId: undefined }, progress });
      return response({}, 404);
    });
    const user = userEvent.setup();
    render(<AiWorkbench shops={shops} />);
    await user.click(screen.getByRole('tab', { name: '标准化记录' }));
    await user.selectOptions(screen.getByRole('combobox', { name: '任务筛选' }), 'attention');
    await user.click(await screen.findByRole('button', { name: '下一页' }));
    await screen.findByRole('button', { name: '查看任务 #7' });
    const trigger = screen.getByRole('button', { name: '查看任务 #7' });
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: '标准化任务详情' });
    expect(showModal.mock.contexts).toContain(dialog);
    expect(within(dialog).getByText(/商铺 #2/)).toBeInTheDocument();
    expect(within(dialog).getByRole('progressbar', { name: '商品处理进度' })).toBeInTheDocument();
    expect(within(dialog).getByRole('list', { name: '标准化阶段' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '标准化记录' })).toHaveAttribute('aria-selected', 'true');
    expect(calls.some(call => call.path === '/api/admin/ai/jobs/7')).toBe(true);
    await user.click(within(dialog).getByRole('button', { name: '关闭任务详情' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(screen.getByRole('tab', { name: '标准化记录' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('combobox', { name: '任务筛选' })).toHaveValue('attention');
    expect(screen.getByLabelText('标准化记录分页')).toHaveTextContent('第 2 / 2 页，共 11 条');
    expect(screen.queryByRole('button', { name: '查看任务 #9' })).not.toBeInTheDocument();
    await user.click(trigger);
    await screen.findByRole('dialog', { name: '标准化任务详情' });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: '标准化' }));
    expect(screen.getByRole('region', { name: '任务运行概览' })).toHaveTextContent('任务 #8');
    await user.click(screen.getByRole('button', { name: '新建任务' }));
    expect(await screen.findByRole('button', { name: '全量任务' })).toBeEnabled();
    showModal.mockRestore();
  });

  test('标准化记录使用统一分页，翻页替换列表，刷新保留页码，切换筛选回到首页', async () => {
    const calls = installFetch(url => {
      if (url.pathname === '/api/admin/ai/task-queue') {
        const attention = url.searchParams.get('status') === 'attention';
        const secondPage = url.searchParams.has('cursor');
        return response({
          items: attention ? [{ ...job, id: '8' }] : secondPage ? [{ ...job, id: '10' }]
            : Array.from({ length: 10 }, (_, index) => ({ ...job, id: String(20 - index) })),
          summary: { total: attention ? 1 : 11 }, nextCursor: attention || secondPage ? null : 'next-page',
        });
      }
      return response(status);
    });
    const user = userEvent.setup();
    render(<AiWorkbench shops={shops} />);
    await user.click(screen.getByRole('tab', { name: '标准化记录' }));
    const pagination = screen.getByLabelText('标准化记录分页');
    expect(pagination).toHaveClass('pagination');
    expect(pagination).toHaveTextContent('第 1 / 2 页，共 11 条');
    expect(within(pagination).getByRole('button', { name: '上一页' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '加载更多任务' })).not.toBeInTheDocument();
    await user.click(within(pagination).getByRole('button', { name: '下一页' }));
    await screen.findByRole('button', { name: '查看任务 #10' });
    expect(pagination).toHaveTextContent('第 2 / 2 页，共 11 条');
    expect(within(pagination).getByRole('button', { name: '下一页' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '查看任务 #20' })).not.toBeInTheDocument();
    await user.click(within(pagination).getByRole('button', { name: '上一页' }));
    await screen.findByRole('button', { name: '查看任务 #20' });
    expect(pagination).toHaveTextContent('第 1 / 2 页，共 11 条');
    await user.click(within(pagination).getByRole('button', { name: '下一页' }));
    await screen.findByRole('button', { name: '查看任务 #10' });
    await user.click(screen.getByRole('button', { name: '刷新状态' }));
    expect(pagination).toHaveTextContent('第 2 / 2 页，共 11 条');
    await user.selectOptions(screen.getByRole('combobox', { name: '任务筛选' }), 'attention');
    await screen.findByRole('button', { name: '查看任务 #8' });
    expect(pagination).toHaveTextContent('第 1 / 1 页，共 1 条');
    expect(within(pagination).getByRole('button', { name: '下一页' })).toBeDisabled();
    const historyCalls = calls.filter(call => call.path === '/api/admin/ai/task-queue' && !call.search.includes('status=unfinished'));
    expect(historyCalls.every(call => new URLSearchParams(call.search).get('limit') === '10')).toBe(true);
    expect(historyCalls.at(-2).search).toContain('cursor=next-page');
    expect(historyCalls.at(-1).search).not.toContain('cursor=');
  });

  test('标准化记录翻页失败保留原页，重试可继续翻页', async () => {
    let unavailable = true;
    let finish;
    installFetch(url => {
      if (url.pathname === '/api/admin/ai/task-queue') {
        if (url.searchParams.has('cursor') && unavailable) return new Promise(resolve => {
          finish = () => resolve(response({ message: '分页查询失败' }, 500));
        });
        return response({ items: [{ ...job, id: url.searchParams.has('cursor') ? '6' : '7' }],
          summary: { total: 11 }, nextCursor: url.searchParams.has('cursor') ? null : 'next-page' });
      }
      return response(status);
    });
    const user = userEvent.setup();
    render(<AiWorkbench shops={shops} />);
    await user.click(screen.getByRole('tab', { name: '标准化记录' }));
    await user.click(screen.getByRole('button', { name: '下一页' }));
    expect(screen.getByRole('region', { name: '标准化记录' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '查看任务 #7' })).toBeInTheDocument();
    await act(async () => finish());
    expect(await screen.findByRole('alert')).toHaveTextContent('分页查询失败');
    expect(screen.getByLabelText('标准化记录分页')).toHaveTextContent('第 1 / 2 页，共 11 条');
    expect(screen.getByRole('button', { name: '查看任务 #7' })).toBeInTheDocument();
    unavailable = false;
    await user.click(screen.getByRole('button', { name: '下一页' }));
    await screen.findByRole('button', { name: '查看任务 #6' });
    expect(screen.getByLabelText('标准化记录分页')).toHaveTextContent('第 2 / 2 页，共 11 条');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test.each([0, 1])('刷新后记录总数减至 %s 时返回有效页，不显示越界页码', async totalAfterRefresh => {
    let total = 11;
    installFetch(url => {
      if (url.pathname === '/api/admin/ai/task-queue') {
        const secondPage = url.searchParams.has('cursor');
        return response({
          items: total === 0 || secondPage && total <= 10 ? [] : [{ ...job, id: secondPage ? '6' : '7' }],
          summary: { total }, nextCursor: !secondPage && total > 10 ? 'next-page' : null,
        });
      }
      return response(status);
    });
    const user = userEvent.setup();
    render(<AiWorkbench shops={shops} />);
    await user.click(screen.getByRole('tab', { name: '标准化记录' }));
    await user.click(screen.getByRole('button', { name: '下一页' }));
    await screen.findByRole('button', { name: '查看任务 #6' });
    total = totalAfterRefresh;
    await user.click(screen.getByRole('button', { name: '刷新状态' }));
    if (total) {
      expect(await screen.findByRole('button', { name: '查看任务 #7' })).toBeInTheDocument();
      expect(screen.getByLabelText('标准化记录分页')).toHaveTextContent('第 1 / 1 页，共 1 条');
    } else {
      expect(await screen.findByText('暂无符合条件的任务。')).toBeInTheDocument();
      expect(screen.queryByLabelText('标准化记录分页')).not.toBeInTheDocument();
    }
  });

  test('历史任务弹窗读取失败留在记录页，仍可重新打开', async () => {
    let failed = true;
    installFetch(url => {
      if (url.pathname === '/api/admin/ai/task-queue') return response({ items: [{ ...job, id: '7' }] });
      if (url.pathname === '/api/admin/ai/jobs/7') return failed
        ? response({ message: '任务读取失败' }, 500)
        : response({ ...status, job: { ...job, id: '7' } });
      return response(status);
    });
    const user = userEvent.setup();
    render(<AiWorkbench shops={shops} />);
    await user.click(screen.getByRole('tab', { name: '标准化记录' }));
    await user.click(await screen.findByRole('button', { name: '查看任务 #7' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('任务读取失败');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '标准化记录' })).toHaveAttribute('aria-selected', 'true');
    failed = false;
    await user.click(screen.getByRole('button', { name: '查看任务 #7' }));
    expect(await screen.findByRole('dialog', { name: '标准化任务详情' })).toHaveTextContent('任务 #7');
  });

  test.each([false, true])('标准化记录不显示重复的配置状态和模型（已配置：%s）', async configured => {
    installFetch(url => response(url.pathname.endsWith('/task-queue') ? { items: [] }
      : { ...status, configured, configError: '缺少 API 密钥', model: 'glm-5.3-flash' }));
    render(<AiWorkbench shops={shops} />);
    await userEvent.setup().click(screen.getByRole('tab', { name: '标准化记录' }));
    expect(screen.queryByText(/AI 服务/)).not.toBeInTheDocument();
    expect(screen.queryByText(/模型：glm-5.3-flash/)).not.toBeInTheDocument();
    expect(screen.queryByText('缺少 API 密钥')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '刷新状态' })).toBeInTheDocument();
  });

  test('弹窗保留实时进度和任务操作，关闭后不会污染最新任务', async () => {
    const streams = [];
    vi.stubGlobal('EventSource', class extends EventTarget {
      constructor(url) { super(); this.url = url; streams.push(this); }
      close() {}
    });
    let detail = { ...status, job: { ...job, id: '7', status: 'running' } };
    const calls = installFetch((url, init) => {
      if (url.pathname === '/api/admin/ai/task-queue') return response({ items: [detail.job] });
      if (url.pathname === '/api/admin/ai/jobs/7') return response(detail);
      if (url.pathname === '/api/ai/jobs/7/pause' && init.method === 'POST') {
        detail = { ...detail, job: { ...detail.job, status: 'paused' } };
        return response(detail.job);
      }
      return response(status);
    });
    const user = userEvent.setup();
    render(<AiWorkbench shops={shops} />);
    await user.click(screen.getByRole('tab', { name: '标准化记录' }));
    await user.click(await screen.findByRole('button', { name: '查看任务 #7' }));
    const dialog = await screen.findByRole('dialog', { name: '标准化任务详情' });
    const stream = streams.find(item => item.url.includes('/jobs/7/events'));
    act(() => stream.dispatchEvent(new MessageEvent('progress', { data: JSON.stringify({
      version: '8', results: { classified: 6, unclassified: 0 },
    }) })));
    expect(dialog).toHaveTextContent('已分类6');
    await user.click(within(dialog).getByRole('button', { name: '暂停任务' }));
    expect(await within(dialog).findByRole('button', { name: '恢复任务' })).toBeEnabled();
    expect(calls.some(call => call.path === '/api/ai/jobs/7/pause' && call.method === 'POST')).toBe(true);
    await user.click(within(dialog).getByRole('button', { name: '关闭任务详情' }));
    await user.click(screen.getByRole('tab', { name: '标准化' }));
    const latest = screen.getByRole('region', { name: '任务运行概览' });
    expect(latest).toHaveTextContent('任务 #8');
    expect(latest).toHaveTextContent('已分类8');
  });

  test('关闭弹窗后忽略尚未返回的刷新结果', async () => {
    let finish;
    let reads = 0;
    installFetch(url => {
      if (url.pathname === '/api/admin/ai/task-queue') return response({ items: [{ ...job, id: '7' }] });
      if (url.pathname === '/api/admin/ai/jobs/7') {
        if (++reads === 1) return response({ ...status, job: { ...job, id: '7' } });
        return new Promise(resolve => { finish = () => resolve(response({ ...status, job: { ...job, id: '7', status: 'failed' } })); });
      }
      return response(status);
    });
    const user = userEvent.setup();
    render(<AiWorkbench shops={shops} />);
    await user.click(screen.getByRole('tab', { name: '标准化记录' }));
    await user.click(await screen.findByRole('button', { name: '查看任务 #7' }));
    const dialog = await screen.findByRole('dialog', { name: '标准化任务详情' });
    await user.click(within(dialog).getByRole('button', { name: '刷新任务' }));
    await user.click(within(dialog).getByRole('button', { name: '关闭任务详情' }));
    await act(async () => finish());
    await user.click(screen.getByRole('tab', { name: '标准化' }));
    expect(screen.getByRole('region', { name: '任务运行概览' })).toHaveTextContent('任务 #8');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('首页状态延迟返回不会覆盖弹窗详情，关闭后显示最新任务', async () => {
    let finish;
    installFetch(url => {
      if (url.pathname === '/api/admin/ai/status') return new Promise(resolve => { finish = () => resolve(response(status)); });
      if (url.pathname === '/api/admin/ai/task-queue') return response({ items: [{ ...job, id: '7' }] });
      if (url.pathname === '/api/admin/ai/jobs/7') return response({ ...status, job: { ...job, id: '7' } });
      return response({});
    });
    const user = userEvent.setup();
    render(<AiWorkbench shops={shops} />);
    await user.click(screen.getByRole('tab', { name: '标准化记录' }));
    await user.click(await screen.findByRole('button', { name: '查看任务 #7' }));
    const dialog = await screen.findByRole('dialog', { name: '标准化任务详情' });
    await act(async () => finish());
    expect(dialog).toHaveTextContent('任务 #7');
    await user.click(within(dialog).getByRole('button', { name: '关闭任务详情' }));
    await user.click(screen.getByRole('tab', { name: '标准化' }));
    expect(screen.getByRole('region', { name: '任务运行概览' })).toHaveTextContent('任务 #8');
  });

  test('任务运行概览只保留商品结果与失败统计，不重复展示运行内部计数', async () => {
    const user = userEvent.setup();
    installFetch((url) => {
      if (url.pathname === '/api/admin/ai/status') return response(status);
      if (url.pathname === '/api/admin/ai/task-queue') return response({ items: [job], nextCursor: null });
      return response({ error: 'unexpected' }, 404);
    });
    render(<AiWorkbench shops={shops} />);
    await user.click(screen.getByRole('tab', { name: '标准化' }));
    const region = await screen.findByRole('region', { name: '任务运行概览' });
    expect(region).toHaveTextContent('原始商品12');
    expect(region).toHaveTextContent('已分类8');
    expect(region).toHaveTextContent('不能处理0');
    expect(region).toHaveTextContent('待处理4');
    expect(region).toHaveTextContent('标准商品2');
    expect(region).toHaveTextContent('失败批次1');
    for (const label of ['唯一输入', '确认请求', '未知发送', '请求预算', '已保存处理结果', '待发布成员', '补处理', '运行详情']) {
      expect(within(region).queryByText(label)).not.toBeInTheDocument();
    }
    expect(within(region).getByRole('list', { name: '标准化阶段' })).toBeVisible();
    expect(within(region).getAllByRole('term')).toHaveLength(6);
  });

  test('成功任务没有运行详情或空的诊断区域', async () => {
    installFetch(url => url.pathname.endsWith('/task-queue') ? response({ items: [] }) : response({
      ...status, progress: { ...progress, requests: { failedBatches: 0 },
        results: { classified: 12, unclassified: 0, standardProducts: 2 } },
    }));
    render(<AiWorkbench shops={shops} />);
    await userEvent.setup().click(screen.getByRole('tab', { name: '标准化' }));
    const region = await screen.findByRole('region', { name: '任务运行概览' });
    expect(region).toHaveTextContent('已完成');
    expect(region.querySelector('details, .ai-diagnostics')).toBeNull();
    const steps = within(region).getAllByRole('listitem');
    expect(steps).toHaveLength(3);
    for (const step of steps) expect(step).toHaveClass('is-past');
    expect(within(region).queryByRole('button', { name: '查看待处理商品' })).not.toBeInTheDocument();
  });

  test.each([
    ['failed', '失败', 'is-danger'],
    ['ready_with_errors', '部分完成', 'is-attention'],
    ['cancelled', '已取消', 'is-neutral'],
  ])('%s 的状态标记不显示为成功', async (jobStatus, label, tone) => {
    installFetch(url => response(url.pathname.endsWith('/task-queue') ? { items: [] } : {
      ...status, job: { ...job, status: jobStatus }, progress: { ...progress, results: {} },
    }));
    render(<AiWorkbench shops={shops} />);
    await userEvent.setup().click(screen.getByRole('tab', { name: '标准化' }));
    const region = screen.getByRole('region', { name: '任务运行概览' });
    expect(within(region).getByText(label)).toHaveClass(tone);
  });

  test.each([
    ['generation', { generationCompleted: 1 }, {}, 0],
    ['review', { generationCompleted: 3, reviewQueued: 1, reviewRunning: 1 }, {}, 1],
    ['publication', { generationCompleted: 3, reviewCompleted: 2, publicationQueued: 1 }, {}, 2],
    ['failed task', { generationCompleted: 3 }, { status: 'failed' }, null],
    ['partially completed', { generationCompleted: 1 }, { status: 'ready_with_errors' }, null],
  ])('%s 保留三步流程且不将阶段完成批次误计为已处理商品', async (_name, stages, jobState, phase) => {
    installFetch(url => {
      if (url.pathname === '/api/admin/ai/status') return response({
        ...status, job: { ...job, status: 'running', ...jobState },
        progress: { ...progress, processed: 12, standardizationStages: stages,
          publication: {}, results: { classified: 0, unclassified: 0 } },
      });
      if (url.pathname === '/api/admin/ai/task-queue') return response({ items: [] });
      return response({}, 404);
    });
    render(<AiWorkbench shops={shops} />);
    await userEvent.setup().click(screen.getByRole('tab', { name: '标准化' }));
    const pipeline = await screen.findByRole('list', { name: '标准化阶段' });
    const steps = within(pipeline).getAllByRole('listitem');
    expect(steps).toHaveLength(3);
    expect(steps[0]).toHaveTextContent(`生成身份提议${stages.generationCompleted} 批已生成`);
    expect(steps[1]).toHaveTextContent(`LLM 二元复核${stages.reviewCompleted || 0} 批已完成`);
    expect(steps[2]).toHaveTextContent(`本地发布${stages.publicationQueued || 0} 批待发布`);
    if (phase == null) {
      for (const step of steps) {
        expect(step).not.toHaveClass('is-past');
        expect(step).not.toHaveAttribute('aria-current');
      }
    } else expect(steps[phase]).toHaveAttribute('aria-current', 'step');
    expect(pipeline).not.toHaveTextContent('件已分类');
    if (stages.reviewQueued) expect(steps[1]).toHaveTextContent('1 批排队 · 1 批进行中');
    else expect(steps[1]).not.toHaveTextContent('批排队');
    expect(screen.getByRole('progressbar', { name: '商品处理进度' })).toHaveAttribute('value', '0');
    expect(within(screen.getByRole('region', { name: '任务运行概览' })).getByText('已分类').nextElementSibling).toHaveTextContent('0');
  });

  test('review rejection stays pending and displays a fixed verdict without a model explanation', async () => {
    installFetch(url => {
      if (url.pathname === '/api/admin/ai/status') return response({ ...status,
        progress: { ...progress, results: { classified: 0, unclassified: 1, unclassifiedReasons: { review_rejected: 1 } } },
      });
      if (url.pathname === '/api/admin/ai/task-queue') return response({ items: [] });
      return response({}, 404);
    });
    render(<AiWorkbench shops={shops} />);
    await userEvent.setup().click(screen.getByRole('tab', { name: '标准化' }));
    const region = await screen.findByRole('region', { name: '任务运行概览' });
    expect(region).toHaveTextContent('LLM 对该身份提议判定为否 · 1 件');
    expect(region).toHaveTextContent('待处理1');
    expect(region).toHaveTextContent('不能处理0');
  });

  test('暂停和恢复任务使用生命周期接口', async () => {
    let currentStatus = { ...status, job: { ...job, status: 'running' } };
    const calls = installFetch((url, init) => {
      if (url.pathname === '/api/admin/ai/status') return response(currentStatus);
      if (url.pathname === '/api/admin/ai/jobs/8') return response(currentStatus);
      if (url.pathname === '/api/admin/ai/task-queue') return response({ items: [job], nextCursor: null });
      if (url.pathname === '/api/ai/jobs/8/pause' && init.method === 'POST') {
        currentStatus = { ...currentStatus, job: { ...job, status: 'paused' } };
        return response(currentStatus.job);
      }
      if (url.pathname === '/api/ai/jobs/8/resume' && init.method === 'POST') {
        currentStatus = { ...currentStatus, job: { ...job, status: 'running' } };
        return response(currentStatus.job);
      }
      return response({ error: 'unexpected' }, 404);
    });
    const user = userEvent.setup();
    render(<AiWorkbench shops={shops} />);
    await user.click(screen.getByRole('tab', { name: '标准化' }));
    await user.click(await screen.findByRole('button', { name: '暂停任务' }));
    expect(calls.some(call => call.path === '/api/ai/jobs/8/pause' && call.method === 'POST')).toBe(true);
    await user.click(await screen.findByRole('button', { name: '恢复任务' }));
    expect(calls.some(call => call.path === '/api/ai/jobs/8/resume' && call.method === 'POST')).toBe(true);
  });

  test('没有任务时可以按当前配置创建任务', async () => {
    const emptyStatus = { ...status, job: null, progress: null };
    const calls = installFetch((url, init) => {
      if (url.pathname === '/api/admin/ai/status') return response(emptyStatus);
      if (url.pathname === '/api/admin/ai/task-queue') return response({ items: [], nextCursor: null });
      if (url.pathname === '/api/ai/jobs' && init.method === 'POST') return response(job);
      return response({ error: 'unexpected' }, 404);
    });
    const user = userEvent.setup();
    render(<AiWorkbench shops={shops} />);
    await user.click(screen.getByRole('tab', { name: '标准化' }));
    await user.click(screen.getByRole('button', { name: '新建任务' }));
    await user.click(await screen.findByRole('button', { name: '全量任务' }));
    expect(calls.find(call => call.path === '/api/ai/jobs' && call.method === 'POST').body).toEqual({ model: 'test-model' });
  });

  test('没有任务时可发起全量任务，请求不携带商铺范围', async () => {
    const calls = installFetch((url, init) => {
      if (url.pathname === '/api/admin/ai/status') return response({ ...status, job: null, progress: null });
      if (url.pathname === '/api/admin/ai/task-queue') return response({ items: [] });
      if (url.pathname === '/api/admin/ai/retry-pool' && init.method !== 'POST') return response({ items: [], total: 0, nextCursor: null });
      if (url.pathname === '/api/ai/jobs' && init.method === 'POST') return response(job);
      return response({}, 404);
    });
    const user = userEvent.setup();
    render(<AiWorkbench shops={shops} />);
    await user.click(screen.getByRole('tab', { name: '标准化' }));
    const region = await screen.findByRole('region', { name: '任务运行概览' });
    expect(region).toHaveTextContent('尚无标准化任务');
    expect(screen.getByRole('tab', { name: '标准化' })).toBeInTheDocument();
    expect(screen.queryByText('AI 商品标准化任务')).not.toBeInTheDocument();
    expect(screen.queryByText('查看任务状态、处理进度、失败批次和历史记录。')).not.toBeInTheDocument();
    expect(screen.queryByText('选择商品范围，开始一次新的商品标准化。')).not.toBeInTheDocument();
    expect(screen.queryByText(/按服务商规则计费/)).not.toBeInTheDocument();
    expect(screen.queryByText(/完整分类结果自动应用/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '新建任务' }));
    const dialog = await screen.findByRole('dialog', { name: '新建任务' });
    expect(await within(dialog).findByRole('button', { name: '全量任务' })).toBeEnabled();
    expect(within(dialog).queryByRole('button', { name: /重试任务/ })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '全量任务' }));
    expect(calls.find(call => call.method === 'POST').body).toEqual({ model: 'test-model' });
    await user.click(screen.getByRole('tab', { name: '标准化记录' }));
    expect(await screen.findByText('暂无符合条件的任务。')).toBeInTheDocument();
  });

  test('抓取首屏展示关键指标、补采状态与域名负载，不再显示诊断和多余控件', async () => {
    installFetch(url => {
      if (url.pathname === '/api/admin/ai/status') return response(status);
      if (url.pathname === '/api/admin/ai/task-queue') return response({ items: [job], nextCursor: null });
      if (url.pathname === '/api/admin/tasks/crawler/status') return response({
        counters: { proxy_request: 1024, direct_request: 56, proxy_connection_failure: 3, response_blocked: 7,
          proxy_cooldown_count: 2, proxy_recovery_probe: 3, proxy_recovery_success: 1,
          proxy_recovery_failure: 2, proxy_auth_failure: 0, proxy_unavailable_ms: 5200 },
        workerCount: 1,
        lastReportAt: new Date('2026-09-25T08:00:00Z').getTime(),
        instances: { queued: 12, running: 2, failedRecent: 1 },
        diagnostics: {
          oldestQueuedMs: 150000, deferred: 4, windowRuns: 10, listSucceeded: 8, listFailed: 2,
          requests: 80, retries: 12, leaseFailures: 1,
          durations: { list: 1000, settlement: 250, transaction: 300, rate_wait: 400, proxy_wait: 50, network: 900, total: 1600 },
          coverage: { eligible: 20, verified: 15 },
          settlementQueue: { queued: 2, running: 1, deferred: 1, failedRecent: 1 },
          intervals: { listMs: 3600000, settlementMs: 3600000 },
          budgets: [{ host: 'example.com', shops: 4, sampledShops: 2, requests: 20, retries: 3, list: 10, channel: 5, settlement: 5, estimatedMs: 30000, recommendedIntervalMs: 45000 }],
        },
      });
      return response({}, 404);
    });
    render(<AiWorkbench shops={shops} />);
    expect(screen.getByRole('tab', { name: '抓取' })).toHaveAttribute('aria-selected', 'true');
    const region = await screen.findByRole('region', { name: '抓取任务' });
    await within(region).findByText('1 个进程在线');
    expect(region).toHaveTextContent('待执行12');
    expect(region).toHaveTextContent('1 个进程在线');
    expect(region).toHaveTextContent('心跳');
    expect(region).toHaveTextContent('最长排队2 分 30 秒');
    expect(region).toHaveTextContent('等待重试4');
    expect(region).toHaveTextContent('成功率（近1小时）80%8 / 10');
    expect(region).toHaveTextContent('近1小时失败1');
    expect(region).toHaveTextContent('报价覆盖率（当前）75%15 / 20');
    expect(region).not.toHaveTextContent('仅统计已发布且有库存的商品');
    expect(within(region).queryByText('阶段耗时')).not.toBeInTheDocument();
    expect(screen.queryByText('AI 服务已配置')).not.toBeInTheDocument();
    expect(screen.queryByText(/模型：test-model/)).not.toBeInTheDocument();
    expect(within(region).queryByText('运行诊断')).not.toBeInTheDocument();
    expect(region.querySelector('details')).toBeNull();
    const supplement = within(region).getByRole('region', { name: '报价补采' });
    expect(supplement).toHaveTextContent('待执行2');
    expect(supplement).toHaveTextContent('进行中1');
    expect(supplement).toHaveTextContent('等待重试1');
    expect(supplement).toHaveTextContent('近1小时失败1');
    const user = userEvent.setup();
    const table = within(region).getByRole('table', { name: '域名抓取负载' });
    expect(table).toHaveTextContent('example.com');
    expect(within(table).getAllByRole('columnheader')).toHaveLength(3);
    expect(table).toHaveTextContent('30 秒');
    await user.click(screen.getByRole('tab', { name: '抓取记录' }));
    expect(screen.getByRole('tab', { name: '抓取记录' })).toHaveAttribute('aria-selected', 'true');
  });

  test('抓取状态失败不显示虚假零值，刷新状态后可恢复', async () => {
    let unavailable = true;
    installFetch(url => {
      if (url.pathname === '/api/admin/ai/status') return response(status);
      if (url.pathname === '/api/admin/ai/task-queue') return response({ items: [] });
      if (url.pathname === '/api/admin/tasks/crawler/status') return unavailable
        ? response({ message: '统计查询超时' }, 500)
        : response({ counters: { proxy_request: 8 }, workerCount: 1, lastReportAt: Date.now(),
          instances: { queued: 12, running: 2, failedRecent: 0 } });
      return response({}, 404);
    });
    const user = userEvent.setup();
    render(<AiWorkbench shops={shops} />);
    const region = screen.getByRole('region', { name: '抓取任务' });
    expect(await within(region).findByRole('alert')).toHaveTextContent('统计查询超时');
    expect(region).toHaveTextContent('待执行未知');
    expect(region).toHaveTextContent('状态未知');
    unavailable = false;
    await user.click(screen.getByRole('button', { name: '刷新状态' }));
    await within(region).findByText('12');
    expect(region).toHaveTextContent('1 个进程在线');
    expect(region).not.toHaveTextContent('直连请求');
    expect(within(region).queryByText('运行诊断')).not.toBeInTheDocument();
    expect(within(region).queryByRole('alert')).not.toBeInTheDocument();
  });

  test('抓取实时连接失败保留已有统计并提示，后续推送恢复状态', async () => {
    const streams = [];
    vi.stubGlobal('EventSource', class extends EventTarget {
      constructor(url) { super(); this.url = url; streams.push(this); }
      close() {}
    });
    installFetch(url => {
      if (url.pathname === '/api/admin/ai/status') return response(status);
      if (url.pathname === '/api/admin/ai/task-queue') return response({ items: [] });
      if (url.pathname === '/api/admin/tasks/crawler/status') return response({
        counters: {}, workerCount: 1, lastReportAt: 9000,
        instances: { queued: 12, running: 2, failedRecent: 0 },
      });
      return response({}, 404);
    });
    render(<AiWorkbench shops={shops} />);
    const region = screen.getByRole('region', { name: '抓取任务' });
    await within(region).findByText('12');
    const stream = streams.find(item => item.url.includes('/crawler/events'));
    act(() => stream.dispatchEvent(new Event('error')));
    expect(within(region).getByRole('alert')).toHaveTextContent('实时连接中断');
    expect(region).toHaveTextContent('待执行12');
    act(() => stream.dispatchEvent(new MessageEvent('progress', { data: JSON.stringify({
      counters: {}, workerCount: 1, lastReportAt: 9100,
      instances: { queued: 5, running: 1, failedRecent: 0 },
    }) })));
    expect(region).toHaveTextContent('待执行5');
    expect(within(region).queryByRole('alert')).not.toBeInTheDocument();
  });

  test('抓取 tab 无上报时显示未上报与暂无时间', async () => {
    installFetch(url => {
      if (url.pathname === '/api/admin/ai/status') return response(status);
      if (url.pathname === '/api/admin/ai/task-queue') return response({ items: [job], nextCursor: null });
      if (url.pathname === '/api/admin/tasks/crawler/status') return response({
        counters: {}, workerCount: 0, lastReportAt: null, instances: { queued: 3, running: 0, failedRecent: 0 },
      });
      return response({}, 404);
    });
    render(<AiWorkbench shops={shops} />);
    expect(screen.getByRole('tab', { name: '抓取' })).toHaveAttribute('aria-selected', 'true');
    const region = await screen.findByRole('region', { name: '抓取任务' });
    expect(region).toHaveTextContent('暂无进程上报');
    expect(region).toHaveTextContent('暂无心跳');
    expect(await within(region).findByText('3')).toBeInTheDocument();
  });

  test('空队列与无样本明确显示空态，当前覆盖与近期结果不伪造百分比', async () => {
    installFetch(url => {
      if (url.pathname === '/api/admin/tasks/crawler/status') return response({
        workerCount: 0, lastReportAt: null, counters: {},
        instances: { queued: 0, running: 0, failedRecent: 0 },
        diagnostics: { oldestQueuedMs: null, deferred: 0, windowRuns: 0, listSucceeded: 0,
          coverage: { eligible: 0, verified: 0 }, budgets: [], intervals: {},
          settlementQueue: { queued: 0, running: 0, deferred: 0, failedRecent: 0 } },
      });
      return response(url.pathname.endsWith('/task-queue') ? { items: [] } : status);
    });
    render(<AiWorkbench shops={shops} />);
    await screen.findByText('暂无进程上报');
    const region = screen.getByRole('region', { name: '抓取任务' });
    expect(region).toHaveTextContent('最长排队无排队');
    expect(region).toHaveTextContent('暂无完成记录');
    expect(region).toHaveTextContent('暂无在售商品');
    expect(region).not.toHaveTextContent('0%');
    expect(within(region).getByRole('region', { name: '报价补采' })).toHaveTextContent('暂无补采任务');
    expect(within(region).queryByText(/域名抓取负载/)).not.toBeInTheDocument();
  });

  test('AI 服务读取失败不干扰独立的抓取状态', async () => {
    installFetch(url => {
      if (url.pathname === '/api/admin/ai/status') return response({ message: 'AI 服务不可用' }, 500);
      if (url.pathname.includes('/crawler/status')) return response({
        workerCount: 1, lastReportAt: 1000, counters: {},
        instances: { queued: 0, running: 0, failedRecent: 0 },
      });
      return response({ items: [] });
    });
    render(<AiWorkbench shops={shops} />);
    await screen.findByText('1 个进程在线');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('tab', { name: '标准化' }));
    expect(screen.getByRole('alert')).toHaveTextContent('AI 服务不可用');
  });

  test.each([false, true])('抓取记录不显示 AI 配置、模型或无关错误（AI 读取失败：%s）', async unavailable => {
    installFetch(url => {
      if (url.pathname === '/api/admin/ai/status') return unavailable
        ? response({ message: 'AI 服务不可用' }, 500)
        : response({ ...status, configured: false, model: 'glm-5.3-flash' });
      return response({ items: [] });
    });
    render(<AiWorkbench shops={shops} />);
    await userEvent.setup().click(screen.getByRole('tab', { name: '抓取记录' }));
    await screen.findByText('暂无抓取记录');
    expect(screen.queryByText('AI 服务需要配置')).not.toBeInTheDocument();
    expect(screen.queryByText(/模型：/)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('首次加载和刷新均显示忙碌状态，刷新保留统计并阻止重复点击', async () => {
    const snapshot = { workerCount: 1, lastReportAt: 1000, counters: {},
      instances: { queued: 12, running: 2, failedRecent: 0 } };
    let finish;
    const calls = installFetch(url => {
      if (url.pathname.includes('/crawler/status')) return new Promise(resolve => {
        finish = value => resolve(response(value));
      });
      return response(url.pathname.endsWith('/task-queue') ? { items: [] } : status);
    });
    const user = userEvent.setup();
    render(<AiWorkbench shops={shops} />);
    const region = screen.getByRole('region', { name: '抓取任务' });
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(within(region).getByRole('status', { name: '读取抓取状态' })).toBeInTheDocument();
    expect(within(region).getByRole('button', { name: '刷新中…' })).toBeDisabled();
    await act(async () => finish(snapshot));
    expect(region).toHaveAttribute('aria-busy', 'false');
    await user.click(within(region).getByRole('button', { name: '刷新状态' }));
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(region).toHaveTextContent('待执行12');
    await user.click(within(region).getByRole('button', { name: '刷新中…' }));
    expect(calls.filter(call => call.path.includes('/crawler/status'))).toHaveLength(2);
    await act(async () => finish({ ...snapshot, instances: { ...snapshot.instances, queued: 5 } }));
    expect(region).toHaveAttribute('aria-busy', 'false');
    expect(region).toHaveTextContent('待执行5');
    expect(within(region).getByRole('button', { name: '刷新状态' })).toBeEnabled();
  });

  test('域名负载按耗时降序只显示前10条样本，实时更新时直接替换', async () => {
    const streams = [];
    vi.stubGlobal('EventSource', class extends EventTarget {
      constructor(url) { super(); this.url = url; streams.push(this); }
      close() {}
    });
    const snapshot = {
      workerCount: 1, lastReportAt: 1000, counters: {},
      instances: { queued: 1, running: 1, failedRecent: 0 },
      diagnostics: { budgets: Array.from({ length: 13 }, (_, index) => ({
        host: `host-${String(index).padStart(2, '0')}.example`, shops: 1, sampledShops: index === 0 ? 0 : 1,
        requests: index * 10, estimatedMs: index === 0 ? null : index * 1000,
      })) },
    };
    const calls = installFetch(url => response(url.pathname.includes('/crawler/status') ? snapshot
      : url.pathname.endsWith('/task-queue') ? { items: [] } : status));
    const user = userEvent.setup();
    render(<AiWorkbench shops={shops} />);
    const table = await screen.findByRole('table', { name: '域名抓取负载' });
    expect(within(table).getAllByRole('row')).toHaveLength(11);
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('host-12.example');
    expect(table).not.toHaveTextContent('host-00.example');
    expect(table).not.toHaveTextContent('host-02.example');
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '下一页' })).not.toBeInTheDocument();
    const stream = streams.find(item => item.url.includes('/crawler/events'));
    act(() => stream.dispatchEvent(new MessageEvent('progress', { data: JSON.stringify({
      ...snapshot, diagnostics: { budgets: snapshot.diagnostics.budgets.slice(12) },
    }) })));
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(table).toHaveTextContent('host-12.example');
    const beforeRefresh = calls.length;
    await user.click(screen.getByRole('button', { name: '刷新状态' }));
    expect(calls.slice(beforeRefresh).map(call => call.path)).toEqual(['/api/admin/tasks/crawler/status']);
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('host-12.example');
  });
});


test('标签抽取页签挂载独立管理面板并隐藏身份创建入口', async () => {
  installFetch(url => url.pathname.endsWith('/task-queue') ? response({ items: [], summary: {} }) : response(status));
  render(<AiWorkbench shops={shops} />);
  await userEvent.setup().click(screen.getByRole('tab', { name: '标签抽取' }));
  expect(await screen.findByRole('region', { name: '标签抽取管理' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '新建标签任务' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '新建任务' })).not.toBeInTheDocument();
});
