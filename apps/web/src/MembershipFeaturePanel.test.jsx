import React from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TagExtractionPanel from './TagExtractionPanel.jsx';

beforeEach(() => { vi.unstubAllGlobals(); vi.stubGlobal('EventSource', undefined); });
const shops = { items: [{ id: '1', name: '测试店' }] };
const classification = { kind: 'account', reason: 'full_subscription_promise', durationSource: 'default', requiredWarrantyDays: 28 };
const accepted = { name: 'warranty_scope', value: 'subscription', proposalIndex: 0, evidence: [{ path: 'name', quote: '保订阅' }] };

test.each([
  ['rental', '租号', 'rental_or_shared_account', '租用或共享账号'],
  ['rental', '租号', 'rental_or_shared_account', '租用或共享账号', 'explicit'],
  ['short_term', '短期', 'ownership_invalid_or_conflicting', '账号归属不明确或存在冲突'],
])('特性任务显示 %s 分类原因', async (kind, label, reason, reasonLabel, durationSource = 'default') => {
  installApi({ handle: call => call.path.endsWith('/feature-results') ? Response.json({
    items: [{ id: '3', name: '待核对会员', outcome: 'updated', acceptedCount: 1, rejectedCount: 0,
      classification: { ...classification, kind, reason, durationSource, requiredWarrantyDays: kind === 'rental' ? null : 28 } }],
  }) : undefined });
  render(<TagExtractionPanel taskKind="membership_features" shops={shops} view="history" />);
  await userEvent.click(await screen.findByRole('button', { name: '查看特性任务 #8' }));
  expect(await screen.findByText(`会员分类：${label} · 原因：${reasonLabel}`)).toBeInTheDocument();
  if (kind === 'rental') expect(screen.queryByText(/^分类周期：/)).not.toBeInTheDocument();
  else expect(screen.getByText('分类周期：默认一个月（非商家承诺）')).toBeInTheDocument();
});

function installApi({ state = 'succeeded', handle } = {}) {
  const calls = [];
  let status = state;
  vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
    const url = new URL(input, 'http://localhost');
    const call = { path: url.pathname, query: url.searchParams, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const custom = await handle?.(call);
    if (custom) return custom;
    if (url.pathname.endsWith('/task-queue')) return Response.json({
      items: [{ id: '8', status, model: 'feature-model', processed: 1, total: 1 }], summary: { total: 1, pendingProducts: 0 },
    });
    if (url.pathname === '/api/ai/feature-jobs/preview') return Response.json({
      previewDigest: 'a'.repeat(64), model: 'feature-model',
      counts: { selected: 1, missing: 0, protected: 0, eligible: 1, oversized: 0, uniqueInputs: 1, requestBatches: 1 },
    });
    if (url.pathname === '/api/ai/feature-jobs') return Response.json({ id: '8' });
    if (/\/(pause|resume|cancel)$/.test(url.pathname)) {
      status = { pause: 'paused', resume: 'running', cancel: 'cancelled' }[url.pathname.split('/').at(-1)];
      return Response.json({ id: '8', status });
    }
    if (url.pathname.endsWith('/feature-results')) return Response.json({
      items: [{ id: '3', name: '待核对会员', outcome: 'updated', acceptedCount: 1, rejectedCount: 0, classification }],
    });
    if (url.pathname.endsWith('/feature-results/3')) return Response.json({
      job: { model: 'feature-model' },
      member: { content_version: '1', standardization_revision: '2', fingerprint: 'feature-source',
        payload: { name: '保订阅' }, output: { outcome: 'updated', classification, acceptedTags: [accepted], rejectedTags: [],
          review: { mode: 'per_tag_binary', decisions: [true] }, diff: [] } },
      batches: [{ id: '4', stage: 'extract', proposals: [accepted] },
        { id: '5', stage: 'review', extraction_batch_id: '4', review_decisions: [true] }],
    });
    if (url.pathname.endsWith('/jobs/8')) return Response.json({
      job: { id: '8', status, model: 'feature-model', job_type: 'membership_features' },
      progress: { rawProductCount: 1, processed: status === 'running' ? 0 : 1, tagResults: { updated: 1 },
        tagAcceptance: { acceptedTags: 1, rejectedTags: 0 }, tagStages: { extractionCompleted: 1, reviewCompleted: 1 } },
    });
    throw new Error(`Unexpected request: ${call.path}`);
  }));
  return calls;
}

test('特性识别范围预览与费用确认使用专用接口，任务详情保留识别语义', async () => {
  const calls = installApi();
  const user = userEvent.setup();
  render(<TagExtractionPanel taskKind="membership_features" shops={shops} />);
  await user.click(screen.getByRole('button', { name: '新建特性任务' }));
  const dialog = screen.getByRole('dialog', { name: '创建特性任务' });
  await user.type(within(dialog).getByRole('textbox', { name: /商品 ID/ }), '3');
  await user.click(within(dialog).getByRole('button', { name: '预览特性范围' }));
  expect(await within(dialog).findByText('模型：feature-model')).toBeInTheDocument();
  const create = within(dialog).getByRole('button', { name: '确认创建特性任务' });
  expect(create).toBeDisabled();
  expect(dialog).not.toHaveTextContent('标签');
  await user.click(within(dialog).getByRole('checkbox', { name: '我确认可能消耗模型额度或产生费用' }));
  await user.click(create);
  await screen.findByRole('dialog', { name: '特性任务详情' });
  const request = calls.find(call => call.path === '/api/ai/feature-jobs');
  expect(request.body).toMatchObject({ productIds: ['3'], previewDigest: 'a'.repeat(64), acknowledgePossibleCharge: true });
  expect(request.body.model).toBeUndefined();
  expect(calls.filter(call => call.path.endsWith('/task-queue')).every(call => call.query.get('jobType') === 'membership_features')).toBe(true);
});

test('特性历史详情显示分类原因、引用、复核与进度', async () => {
  installApi();
  const user = userEvent.setup();
  render(<TagExtractionPanel taskKind="membership_features" shops={shops} view="history" />);
  await user.click(await screen.findByRole('button', { name: '查看特性任务 #8' }));
  const dialog = screen.getByRole('dialog', { name: '特性任务详情' });
  expect(await within(dialog).findByText(/会员分类：成品号/)).toBeInTheDocument();
  expect(within(dialog).getByText(/明确保障完整订阅期/)).toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: '查看商品 #3 依据' }));
  expect(await within(dialog).findByText('输入指纹：feature-source')).toBeInTheDocument();
  expect(within(dialog).getAllByText('保订阅').length).toBeGreaterThan(0);
  expect(within(dialog).getAllByText('YES (true)').length).toBeGreaterThan(0);
  expect(within(dialog).getByRole('progressbar', { name: '特性商品处理进度' })).toHaveAttribute('value', '1');
  expect(dialog).not.toHaveTextContent('标签');
});

test('特性失败记录保留诊断，缺少分类时不默认成短期', async () => {
  installApi({ state: 'failed', handle: call => {
    if (call.path.endsWith('/feature-results')) return Response.json({
      items: [{ id: '3', name: '失败商品', outcome: 'failed', reason_code: 'request_outcome_unknown' }],
    });
    if (call.path.endsWith('/feature-results/3')) return Response.json({
      member: { output: { outcome: 'failed', reasonCode: 'request_outcome_unknown', acceptedTags: [], rejectedTags: [] } }, batches: [],
    });
  } });
  const user = userEvent.setup();
  render(<TagExtractionPanel taskKind="membership_features" shops={shops} view="history" />);
  await user.click(await screen.findByRole('button', { name: '查看特性任务 #8' }));
  await user.click(await screen.findByRole('button', { name: '查看商品 #3 依据' }));
  const dialog = screen.getByRole('dialog', { name: '特性任务详情' });
  expect(await within(dialog).findByText(/本次未写入商品特性/)).toBeInTheDocument();
  expect(dialog).toHaveTextContent('模型请求结果未知');
  expect(dialog).not.toHaveTextContent('会员分类');
  expect(dialog).not.toHaveTextContent('短期');
  expect(dialog).not.toHaveTextContent('标签');
});

test('特性任务复用暂停继续取消和实时事件，历史开关禁用不阻止取消', async () => {
  const streams = [];
  vi.stubGlobal('EventSource', class extends EventTarget { constructor() { super(); streams.push(this); } close() {} });
  const calls = installApi({ state: 'running' });
  const user = userEvent.setup();
  const view = render(<TagExtractionPanel taskKind="membership_features" shops={shops} view="history" />);
  await user.click(await screen.findByRole('button', { name: '查看特性任务 #8' }));
  await screen.findByRole('button', { name: '暂停特性任务' });
  await act(async () => streams.at(-1).dispatchEvent(new MessageEvent('progress', { data: JSON.stringify({ processed: 1 }) })));
  expect(screen.getByRole('progressbar')).toHaveAttribute('value', '1');
  await user.click(screen.getByRole('button', { name: '暂停特性任务' }));
  await screen.findByRole('button', { name: '继续特性任务' });
  view.rerender(<TagExtractionPanel taskKind="membership_features" shops={shops} view="history" enabled={false} />);
  expect(screen.getByRole('button', { name: '继续特性任务' })).toBeDisabled();
  view.rerender(<TagExtractionPanel taskKind="membership_features" shops={shops} view="history" />);
  await user.click(await screen.findByRole('button', { name: '继续特性任务' }));
  await screen.findByRole('button', { name: '暂停特性任务' });
  view.rerender(<TagExtractionPanel taskKind="membership_features" shops={shops} view="history" enabled={false} />);
  await user.click(screen.getByRole('button', { name: '取消特性任务' }));
  await screen.findAllByText('已取消');
  expect(calls.filter(call => /\/(pause|resume|cancel)$/.test(call.path)).map(call => call.path)).toEqual([
    '/api/ai/jobs/8/pause', '/api/ai/jobs/8/resume', '/api/ai/jobs/8/cancel',
  ]);
});

test('特性批量创建不需要预览，失败后保留费用确认和请求 ID', async () => {
  let attempts = 0;
  const calls = installApi({ handle: call => call.path === '/api/ai/feature-jobs' && ++attempts === 1
    ? Response.json({ message: '暂不可用' }, { status: 503 }) : null });
  const user = userEvent.setup();
  render(<TagExtractionPanel taskKind="membership_features" shops={shops} />);
  await user.click(screen.getByRole('button', { name: '批量新建特性任务' }));
  const dialog = screen.getByRole('dialog', { name: '创建特性任务' });
  await user.click(within(dialog).getByRole('checkbox', { name: '我确认可能消耗模型额度或产生费用' }));
  await user.click(within(dialog).getByRole('button', { name: '确认创建特性任务' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('暂不可用');
  await user.click(within(dialog).getByRole('button', { name: '确认创建特性任务' }));
  await screen.findByRole('dialog', { name: '特性任务详情' });
  const submissions = calls.filter(call => call.path === '/api/ai/feature-jobs');
  expect(submissions).toHaveLength(2);
  expect(submissions[0].body).toEqual(submissions[1].body);
  expect(submissions[0].body).toMatchObject({ allPending: true, acknowledgePossibleCharge: true });
  expect(submissions[0].body.previewDigest).toBeUndefined();
  expect(calls.some(call => call.path.endsWith('/feature-jobs/preview'))).toBe(false);
});
