import React from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TagExtractionPanel from './TagExtractionPanel.jsx';

beforeEach(() => { vi.unstubAllGlobals(); vi.stubGlobal('EventSource', undefined); });
const shops = { items: [{ id: '1', name: '测试店' }] };
const classification = { kind: 'account', reason: 'full_subscription_promise', durationSource: 'default', requiredWarrantyDays: 28 };

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
      items: [{ id: '3', name: '待核对会员', outcome: 'updated', acceptedCount: 1, rejectedCount: 0, classification, classificationReviewed: true }],
    });
    if (url.pathname.endsWith('/feature-results/3')) return Response.json({
      job: { model: 'feature-model' },
      member: { content_version: '1', standardization_revision: '2', fingerprint: 'feature-source',
        payload: { name: '保订阅' }, output: { outcome: 'updated', classification, proposedMembershipKind: 'account',
          review: { mode: 'membership_binary', decision: true }, diff: [] } },
      batches: [{ id: '4', stage: 'generate', reviewRepairRound: 0, proposed_membership_kind: 'account' },
        { id: '5', stage: 'review', reviewRepairRound: 0, proposal_batch_id: '4', proposed_membership_kind: 'account', classification_decision: true }],
    });
    if (url.pathname.endsWith('/jobs/8')) return Response.json({
      job: { id: '8', status, model: 'feature-model', job_type: 'membership_features' },
      progress: { rawProductCount: 1, processed: status === 'running' ? 0 : 1, tagResults: { updated: 1 },
        featureAcceptance: { acceptedProducts: 1, rejectedProducts: 0 }, reviewStages: { generationCompleted: 1, reviewCompleted: 1 } },
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
  expect(dialog).toHaveTextContent('仅处理已完成标准化、通过身份验证并已发布的 AI 会员报价');
  expect(dialog).toHaveTextContent('分类属于单件报价，同一标准商品可包含成品号、代充、租号和短期');
  expect(dialog).not.toHaveTextContent('标签');
  expect(dialog).toHaveTextContent('每件商品只提出一个分类');
  expect(dialog).not.toHaveTextContent('多个候选特性');
  await user.click(within(dialog).getByRole('checkbox', { name: '我确认可能消耗模型额度或产生费用' }));
  await user.click(create);
  await screen.findByRole('dialog', { name: '特性任务详情' });
  const request = calls.find(call => call.path === '/api/ai/feature-jobs');
  expect(request.body).toMatchObject({ productIds: ['3'], previewDigest: 'a'.repeat(64), acknowledgePossibleCharge: true });
  expect(request.body.model).toBeUndefined();
  expect(calls.filter(call => call.path.endsWith('/task-queue')).every(call => call.query.get('jobType') === 'membership_features')).toBe(true);
});

test('特性详情显示单分类原因、冻结输入、复核与进度', async () => {
  installApi();
  const user = userEvent.setup();
  render(<TagExtractionPanel taskKind="membership_features" shops={shops} view="history" />);
  await user.click(await screen.findByRole('button', { name: '查看特性任务 #8' }));
  const dialog = screen.getByRole('dialog', { name: '特性任务详情' });
  expect(await within(dialog).findByText(/会员分类：成品号/)).toBeInTheDocument();
  expect(within(dialog).getByText(/明确保障完整订阅期/)).toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: '查看商品 #3 依据' }));
  expect(await within(dialog).findByText('输入指纹：feature-source')).toBeInTheDocument();
  await user.click(within(dialog).getByText('冻结输入 JSON'));
  expect(within(dialog).getByText(/"name": "保订阅"/)).toBeInTheDocument();
  expect(within(dialog).getAllByText('分类复核：通过（true）')).toHaveLength(3);
  expect(dialog).not.toHaveTextContent('历史分类依据');
  expect(dialog).not.toHaveTextContent('历史原始投票');
  expect(dialog).not.toHaveTextContent('逐特性二元复核');
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
  expect(within(dialog).getAllByText('提议分类：未记录')).toHaveLength(2);
  expect(within(dialog).getAllByText('分类复核：未记录')).toHaveLength(2);
});

test('非 AI 会员跳过原因在商品列表和最终审计中显示明确诊断', async () => {
  installApi({ handle: call => {
    if (call.path.endsWith('/feature-results')) return Response.json({
      items: [{ id: '3', name: '非会员报价', outcome: 'skipped', reason_code: 'not_ai_membership' }],
    });
    if (call.path.endsWith('/feature-results/3')) return Response.json({
      member: { output: { outcome: 'skipped', reasonCode: 'not_ai_membership', acceptedTags: [], rejectedTags: [] } }, batches: [],
    });
  } });
  const user = userEvent.setup();
  render(<TagExtractionPanel taskKind="membership_features" shops={shops} view="history" />);
  await user.click(await screen.findByRole('button', { name: '查看特性任务 #8' }));
  const member = (await screen.findByText('非会员报价')).closest('li');
  expect(member).toHaveTextContent('当前标准商品不属于 AI 会员');
  await user.click(within(member).getByRole('button', { name: '查看商品 #3 依据' }));
  const audit = (await screen.findByText('输入指纹：未记录')).closest('.tag-audit');
  expect(audit).toHaveTextContent('结果：跳过 · 原因：当前标准商品不属于 AI 会员');
  expect(audit).toHaveTextContent('本次未写入商品特性');
  expect(audit).not.toHaveTextContent('未识别原因');
});

test('特性任务复用暂停继续取消和实时事件，历史开关禁用不阻止取消', async () => {
  const streams = [];
  vi.stubGlobal('EventSource', class extends EventTarget { constructor() { super(); streams.push(this); } close() {} });
  const calls = installApi({ state: 'running' });
  const user = userEvent.setup();
  const view = render(<TagExtractionPanel taskKind="membership_features" shops={shops} view="history" />);
  await user.click(await screen.findByRole('button', { name: '查看特性任务 #8' }));
  await screen.findByRole('button', { name: '暂停特性任务' });
  await act(async () => streams.at(-1).dispatchEvent(new MessageEvent('progress', { data: JSON.stringify({
    processed: 1, featureAcceptance: { acceptedProducts: 0, rejectedProducts: 1 },
  }) })));
  expect(screen.getByRole('progressbar')).toHaveAttribute('value', '1');
  expect(screen.getByText('分类通过（件）').nextElementSibling).toHaveTextContent(/^0$/);
  expect(screen.getByText('分类拒绝（件）').nextElementSibling).toHaveTextContent(/^1$/);
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
  expect(dialog).toHaveTextContent('仅处理已完成标准化、通过身份验证并已发布的 AI 会员报价');
  expect(dialog).not.toHaveTextContent('全站符合条件、需要识别特性');
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

function installClassificationApi({ kind = 'account', decision = true, classificationReviewed = decision, batches = [] } = {}) {
  const output = {
    outcome: decision === true ? 'updated' : 'failed',
    reasonCode: decision === false ? 'classification_review_rejected' : undefined,
    classification: decision === true ? { kind, reason: 'llm_reviewed' } : null,
    proposedMembershipKind: kind,
    review: { mode: 'membership_binary', decision }, diff: [],
  };
  return installApi({ handle: call => {
    if (call.path.endsWith('/feature-results')) return Response.json({
      items: [{ id: '3', name: '单分类会员', outcome: output.outcome, reason_code: output.reasonCode,
        classification: output.classification, proposedMembershipKind: kind, classificationReviewed,
        acceptedCount: Number(decision === true), rejectedCount: Number(decision === false), changedFields: 0 }],
    });
    if (call.path.endsWith('/feature-results/3')) return Response.json({
      member: { output }, batches,
    });
    if (call.path.endsWith('/jobs/8')) return Response.json({
      job: { id: '8', status: 'succeeded', job_type: 'membership_features' },
      progress: { rawProductCount: 3, processed: 3, tagResults: { updated: 1 },
        featureAcceptance: { acceptedProducts: 1, rejectedProducts: 2 } },
    });
  } });
}

test.each([
  ['account', '成品号'], ['top_up', '代充'], ['rental', '租号'], ['short_term', '短期'],
])('新特性任务每件商品展示一个 %s 分类及一次复核', async (kind, label) => {
  installClassificationApi({ kind });
  const user = userEvent.setup();
  render(<TagExtractionPanel taskKind="membership_features" shops={shops} view="history" />);
  await user.click(await screen.findByRole('button', { name: '查看特性任务 #8' }));
  const member = (await screen.findByText('单分类会员')).closest('li');
  expect(within(member).getByText(`会员分类：${label} · 原因：LLM 分类复核通过`)).toBeInTheDocument();
  expect(within(member).getByText('分类复核：通过（true）')).toBeInTheDocument();
  expect(member).not.toHaveTextContent('变化字段');
  await user.click(within(member).getByRole('button', { name: '查看商品 #3 依据' }));
  const audit = (await screen.findByText('输入指纹：未记录')).closest('.tag-audit');
  expect(within(audit).getByText(`会员分类：${label} · 原因：LLM 分类复核通过`)).toBeInTheDocument();
  expect(within(audit).getByText('分类复核：通过（true）')).toBeInTheDocument();
  expect(audit).not.toHaveTextContent('通过特性与证据');
  expect(audit).not.toHaveTextContent('拒绝特性与诊断');
  expect(audit).not.toHaveTextContent('写入差异');
  expect(audit).not.toHaveTextContent('逐特性');
  expect(audit).not.toHaveTextContent('分类周期');
  expect(audit).not.toHaveTextContent('历史分类依据');
  expect(audit).not.toHaveTextContent('历史原始投票');
});

test.each([
  [false, false, '拒绝（false）', '拒绝（false）'],
  [null, null, '未记录', '未记录'],
  [null, false, '拒绝（false）', '未记录'],
])('分类未保存时列表和审计各自展示当前判定：%s / %s', async (decision, classificationReviewed, listVerdict, auditVerdict) => {
  installClassificationApi({ kind: 'top_up', decision, classificationReviewed });
  const user = userEvent.setup();
  render(<TagExtractionPanel taskKind="membership_features" shops={shops} view="history" />);
  await user.click(await screen.findByRole('button', { name: '查看特性任务 #8' }));
  const member = (await screen.findByText('单分类会员')).closest('li');
  expect(within(member).getByText('提议分类：代充')).toBeInTheDocument();
  expect(within(member).getByText(`分类复核：${listVerdict}`)).toBeInTheDocument();
  await user.click(within(member).getByRole('button', { name: '查看商品 #3 依据' }));
  const audit = (await screen.findByText('输入指纹：未记录')).closest('.tag-audit');
  expect(within(audit).getByText('提议分类：代充')).toBeInTheDocument();
  expect(within(audit).getByText(`分类复核：${auditVerdict}`)).toBeInTheDocument();
  expect(audit).not.toHaveTextContent('会员分类');
  expect(audit).not.toHaveTextContent('历史 LLM 复核');
  if (decision === false) expect(audit).toHaveTextContent('LLM 分类复核拒绝');
});

test('分类统计以商品为单位显示通过和拒绝', async () => {
  installClassificationApi();
  render(<TagExtractionPanel taskKind="membership_features" shops={shops} view="history" />);
  await userEvent.click(await screen.findByRole('button', { name: '查看特性任务 #8' }));
  const dialog = screen.getByRole('dialog', { name: '特性任务详情' });
  expect(await within(dialog).findByText('分类通过（件）')).toBeInTheDocument();
  expect(within(dialog).getByText('分类通过（件）').nextElementSibling).toHaveTextContent(/^1$/);
  expect(within(dialog).getByText('分类拒绝（件）').nextElementSibling).toHaveTextContent(/^2$/);
  expect(dialog).not.toHaveTextContent('通过特性（条）');
  expect(dialog).not.toHaveTextContent('拒绝特性（条）');
  expect(dialog).not.toHaveTextContent('部分采纳');
  expect(dialog).not.toHaveTextContent('通过 7');
  expect(dialog).not.toHaveTextContent('拒绝 2');
  expect(within(dialog).getByText('处理结束（需关注结果）')).toBeInTheDocument();
});

test('分类批次展示各自提议与布尔判定，不从最终结果反推缺失的票', async () => {
  installClassificationApi({ batches: [
    { id: '4', stage: 'generate', proposed_membership_kind: 'account' },
    { id: '5', stage: 'review', proposal_batch_id: '4', proposed_membership_kind: 'account', classification_decision: false },
    { id: '6', stage: 'review', proposal_batch_id: '4', proposed_membership_kind: 'rental', classification_decision: true },
    { id: '7', stage: 'review', proposal_batch_id: 'missing' },
  ] });
  const user = userEvent.setup();
  render(<TagExtractionPanel taskKind="membership_features" shops={shops} view="history" />);
  await user.click(await screen.findByRole('button', { name: '查看特性任务 #8' }));
  await user.click(await screen.findByRole('button', { name: '查看商品 #3 依据' }));
  for (const [id, kind, verdict] of [['5', '成品号', '拒绝（false）'], ['6', '租号', '通过（true）'], ['7', '未记录', '未记录']]) {
    const summary = await screen.findByText(`复核批次 #${id} 详情`);
    await user.click(summary);
    const batch = summary.closest('details');
    expect(batch).toHaveTextContent(`提议分类：${kind}`);
    expect(batch).toHaveTextContent(`分类复核：${verdict}`);
    expect(within(batch).queryByRole('table')).not.toBeInTheDocument();
    expect(batch).not.toHaveTextContent('原始候选为空');
    expect(batch).not.toHaveTextContent('持久化原始投票');
  }
});

test('特性纠错审计显示审核原因和原文行号', async () => {
  installClassificationApi({ batches: [{
    id: '5', stage: 'review', proposed_membership_kind: 'account', classification_decision: false,
    classification_feedback: { classificationDecision: false, code: 'protection_mismatch', refs: [0, 2] },
  }] });
  const user = userEvent.setup();
  render(<TagExtractionPanel taskKind="membership_features" shops={shops} view="history" />);
  await user.click(await screen.findByRole('button', { name: '查看特性任务 #8' }));
  await user.click(await screen.findByRole('button', { name: '查看商品 #3 依据' }));
  await user.click(await screen.findByText('复核批次 #5 详情'));
  expect(screen.getByText('复核原因：保障期限或范围判断错误')).toBeInTheDocument();
  expect(screen.getByText('原文行号：0、2')).toBeInTheDocument();
});

test('尚未保存分类时仍能审计批次判定，不宣称商品已写入', async () => {
  installApi({ state: 'running', handle: call => call.path.endsWith('/feature-results/3') ? Response.json({
    member: { status: 'processing' },
    batches: [{ id: '5', stage: 'review', proposed_membership_kind: 'short_term', classification_decision: false }],
  }) : undefined });
  const user = userEvent.setup();
  render(<TagExtractionPanel taskKind="membership_features" shops={shops} view="history" />);
  await user.click(await screen.findByRole('button', { name: '查看特性任务 #8' }));
  await user.click(await screen.findByRole('button', { name: '查看商品 #3 依据' }));
  const audit = (await screen.findByText('输入指纹：未记录')).closest('.tag-audit');
  expect(audit).toHaveTextContent('发布尚未完成，不能视为已写入');
  expect(audit).toHaveTextContent('商品最终发布审计尚未生成');
  await user.click(within(audit).getByText('复核批次 #5 详情'));
  const batch = within(audit).getByText('复核批次 #5 详情').closest('details');
  expect(batch).toHaveTextContent('提议分类：短期');
  expect(batch).toHaveTextContent('分类复核：拒绝（false）');
});

test.each(['queued', 'processing'])('未完成特性任务尚无分类和审计时保留空值展示（%s）', async status => {
  installApi({ state: 'running', handle: call => {
    if (call.path.endsWith('/feature-results')) return Response.json({
      items: [{ id: '3', name: '等待分类', status, classification: null, classificationReviewed: null }],
    });
    if (call.path.endsWith('/feature-results/3')) return Response.json({
      member: { status, output: null }, batches: [],
    });
  } });
  const user = userEvent.setup();
  render(<TagExtractionPanel taskKind="membership_features" shops={shops} view="history" />);
  await user.click(await screen.findByRole('button', { name: '查看特性任务 #8' }));
  const member = (await screen.findByText('等待分类')).closest('li');
  expect(member).toHaveTextContent('提议分类：未记录');
  expect(member).toHaveTextContent('分类复核：未记录');
  await user.click(within(member).getByRole('button', { name: '查看商品 #3 依据' }));
  const audit = (await screen.findByText('输入指纹：未记录')).closest('.tag-audit');
  expect(audit).toHaveTextContent('提议分类：未记录');
  expect(audit).toHaveTextContent('分类复核：未记录');
  expect(audit).toHaveTextContent('发布尚未完成，不能视为已写入');
  expect(audit).toHaveTextContent('商品最终发布审计尚未生成');
  expect(audit).not.toHaveTextContent('分类复核：通过');
  expect(audit).not.toHaveTextContent('历史未记录审计结果');
});

test.each([true, false])('特性纠错前后保留独立分类判定，最终判定为 %s', async decision => {
  installClassificationApi({ kind: 'short_term', decision, batches: [
    { id: '4', stage: 'generate', reviewRepairRound: 0, proposed_membership_kind: 'account' },
    { id: '5', stage: 'review', reviewRepairRound: 0, proposal_batch_id: '4', classification_decision: false,
      classification_feedback: { classificationDecision: false, code: 'protection_mismatch', refs: [0] } },
    { id: '6', stage: 'repair', reviewRepairRound: 1, proposed_membership_kind: 'short_term' },
    { id: '7', stage: 'review', reviewRepairRound: 1, proposal_batch_id: '6', classification_decision: decision,
      classification_feedback: decision
        ? { classificationDecision: true }
        : { classificationDecision: false, code: 'source_conflict', refs: [1, 2] } },
  ] });
  const user = userEvent.setup();
  render(<TagExtractionPanel taskKind="membership_features" shops={shops} view="history" />);
  await user.click(await screen.findByRole('button', { name: '查看特性任务 #8' }));
  await user.click(await screen.findByRole('button', { name: '查看商品 #3 依据' }));
  const audit = (await screen.findByText('输入指纹：未记录')).closest('.tag-audit');
  const verdict = decision ? '通过（true）' : '拒绝（false）';
  expect(within(audit.querySelector('.tag-classification')).getByText(`分类复核：${verdict}`)).toBeInTheDocument();
  await user.click(within(audit).getByText('复核批次 #5 详情'));
  const initial = within(audit).getByText('复核批次 #5 详情').closest('details');
  expect(initial).toHaveTextContent('提议分类：成品号');
  expect(initial).toHaveTextContent('分类复核：拒绝（false）');
  expect(initial).toHaveTextContent('复核原因：保障期限或范围判断错误');
  expect(initial).toHaveTextContent('原文行号：0');
  await user.click(within(audit).getByText('修正提取批次 #6 详情'));
  expect(within(audit).getByText('修正提取批次 #6 详情').closest('details')).toHaveTextContent('提议分类：短期');
  await user.click(within(audit).getByText('修正复核批次 #7 详情'));
  const repaired = within(audit).getByText('修正复核批次 #7 详情').closest('details');
  expect(repaired).toHaveTextContent('提议分类：短期');
  expect(repaired).toHaveTextContent(`分类复核：${verdict}`);
  if (!decision) {
    expect(repaired).toHaveTextContent('复核原因：原文存在未解决的冲突');
    expect(repaired).toHaveTextContent('原文行号：1、2');
    expect(audit).toHaveTextContent('本次未写入商品特性');
  }
  expect(within(audit).queryByRole('table')).not.toBeInTheDocument();
  expect(audit).not.toHaveTextContent('历史分类依据');
  expect(audit).not.toHaveTextContent('历史原始投票');
  expect(audit).not.toHaveTextContent('逐特性');
  expect(audit).not.toHaveTextContent('通过特性');
  expect(audit).not.toHaveTextContent('拒绝特性');
  expect(audit).not.toHaveTextContent('写入差异');
});

test('分类复核来源不匹配时不借用其他批次分类或最终判定', async () => {
  installClassificationApi({ batches: [
    { id: '4', stage: 'generate', reviewRepairRound: 0, proposed_membership_kind: 'account' },
    { id: '5', stage: 'review', reviewRepairRound: 0, proposal_batch_id: 'missing', classification_decision: null },
  ] });
  const user = userEvent.setup();
  render(<TagExtractionPanel taskKind="membership_features" shops={shops} view="history" />);
  await user.click(await screen.findByRole('button', { name: '查看特性任务 #8' }));
  await user.click(await screen.findByRole('button', { name: '查看商品 #3 依据' }));
  const batch = (await screen.findByText('复核批次 #5 详情')).closest('details');
  await user.click(within(batch).getByText('复核批次 #5 详情'));
  expect(batch).toHaveTextContent('来源提取批次：#missing');
  expect(batch).not.toHaveTextContent('YES (true)');
  expect(batch).not.toHaveTextContent('保订阅');
  expect(batch).toHaveTextContent('提议分类：未记录');
  expect(batch).not.toHaveTextContent('成品号');
  expect(batch).toHaveTextContent('分类复核：未记录');
});
