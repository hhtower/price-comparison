import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createProgressEventSource, formatTime, requestJson } from './api.js';
import { EmptyState, Pagination } from './components/AdminControls.jsx';
import ModalDialog from './components/ModalDialog.jsx';
import { PURCHASE_GUIDE_FIELDS } from '@price-comparison/catalog/purchase-guide-content';
import { displayPurchaseTagValue } from './purchase-tag-values.js';

const OUTCOMES = { updated: '实际更新', unchanged: '无变化', empty: '无可确认标签', review: '待复核', skipped: '跳过', failed: '失败', cancelled: '取消', unrecorded: '未记录（未经验证）' };
const STATES = { queued: '排队中', running: '运行中', processing: '处理中', paused: '已暂停', ready: '待继续', interrupted: '已中断', succeeded: '处理结束', ready_with_errors: '部分完成', failed: '失败', cancelled: '已取消' };
const TERMINAL = new Set(['succeeded', 'ready_with_errors', 'failed', 'cancelled']);
const PAGE_SIZE = 10;
const REASONS = {
  tag_evidence_rejected: '有标签未通过校验，请查看商品依据',
  evidence_invalid: '商品证据引用无效', citation_missing: '缺少商品证据', citation_path_invalid: '证据位置无效',
  citation_quote_mismatch: '证据引文与商品资料不符', citation_type_invalid: '证据未引用原始文本或数值字段',
  tag_name_unknown: '标签名称不在规范词表中', tag_value_invalid: '标签值格式或枚举不符',
  tag_value_conflict: '标签值与商品证据冲突', tag_single_value_conflict: '同一字段存在互斥标签',
  tag_subject_mismatch: '标签不属于当前商品', tag_duplicate: '重复标签已去重', warranty_group_invalid: '质保条件不完整或冲突，整组待复核',
  review_unsupported: 'LLM复核：证据不足', review_conflict: 'LLM复核：证据冲突', review_wrong_subject: 'LLM复核：不属于当前商品',
  review_incomplete_terms: 'LLM复核：条件不完整', review_citation_invalid: 'LLM复核：证据引用无效', review_not_applicable: 'LLM复核：标签不适用',
  review_rejected: 'LLM 对该标签判定为否',
  tag_review_conflict: '复核同时通过和拒绝同一标签事实',
  input_too_large: '商品资料过长，请精简后重试', invalid_response: '模型结果格式异常',
  provider_error: '模型服务调用失败', provider_policy_rejection: '模型服务策略拒绝，请核对商品资料',
  request_outcome_unknown: '模型请求结果未知，请查看请求诊断', result_not_saved: '模型结果保存失败',
  manual_decision_preserved: '已保留人工决定', source_changed: '商品资料已变化，请按最新资料重试',
  source_unavailable: '商品或店铺已不可用', not_published: '商品尚未发布，请先核对身份归类',
  human_assignment: '已保留人工归类', product_locked: '商品已锁定，未应用标签', revision_changed: '商品修订已变化，请按最新资料重试',
  manual_decision: '已保留人工决定', missing_id: '模型未返回该商品',
  job_cancelled: '任务已取消', cancelled: '任务已取消', unrecorded: '历史未记录审计结果',
};
const reasonTitle = code => code ? REASONS[code] || `未识别原因（${code}），请查看商品依据` : '无诊断原因';
const fieldTitle = name => PURCHASE_GUIDE_FIELDS[name]?.label || name;
function resultTitle(outcome, accepted = 0, rejected = 0) {
  if (outcome === 'updated' && rejected > 0) return accepted > 0 ? '部分采纳，已更新' : '已更新，仍需复核';
  if (outcome === 'review' && accepted > 0) return '部分采纳，待复核';
  return OUTCOMES[outcome] || STATES[outcome] || OUTCOMES.unrecorded;
}
function jobTitle(job, attention) {
  if (job?.phase === 'preparing' && ['queued', 'running'].includes(job.status)) return '准备中';
  if (job?.status === 'succeeded' && attention) return '处理结束（需关注结果）';
  return STATES[job?.status] || job?.status;
}
const versions = value => value ? Object.entries(value).map(([key, version]) => `${key}: ${typeof version === 'object' ? JSON.stringify(version) : version}`).join(' · ') : '未记录';
const indexed = index => Number.isInteger(index) && index >= 0;
const voteTitle = vote => vote === true ? 'YES (true)' : vote === false ? 'NO (false)' : 'LLM 原始投票未记录';
const metadata = (value, keys) => versions(Object.fromEntries(keys.filter(key => value?.[key] != null && ['string', 'number', 'boolean'].includes(typeof value[key])).map(key => [key, value[key]]))) || '未记录';
function programDisposition(output, index) {
  if (!output) return '发布尚未完成';
  if (!indexed(index)) return '程序处置索引未记录';
  const rejected = output.rejectedTags?.find(tag => tag.proposalIndex === index);
  if (rejected) return rejected.reasonCode === 'review_rejected' ? reasonTitle(rejected.reasonCode) : `程序拒绝：${reasonTitle(rejected.reasonCode)}`;
  return output.acceptedTags?.some(tag => tag.proposalIndex === index) ? '程序采纳' : '程序处置索引未记录';
}
function CandidateTable({ proposals, decisions, output, publicationRecorded, label }) {
  return Array.isArray(proposals) ? proposals.length ? <div className="data-table-wrap"><table aria-label={label}>
    <thead><tr><th>原候选索引（从 0 开始）</th><th>提取候选与原始证据</th><th>LLM 原始判定</th><th>最终程序处置</th></tr></thead>
    <tbody>{proposals.map((tag, index) => <tr key={index}>
      <td>{indexed(tag.proposalIndex) ? `#${tag.proposalIndex}` : '未记录'}</td>
      <td><strong>{fieldTitle(tag.name)}：{displayPurchaseTagValue(tag)}</strong><p>{tag.name} = {tag.value}</p>{tag.evidence?.length ? <ul>{tag.evidence.map((evidence, i) => <li key={i}>{evidence.path}：<q>{evidence.quote}</q></li>)}</ul> : <p>原始证据未记录</p>}</td>
      <td>{voteTitle(indexed(tag.proposalIndex) ? decisions?.[tag.proposalIndex] : undefined)}</td>
      <td>{publicationRecorded && !output ? '最终处置来源关联未记录' : programDisposition(output, tag.proposalIndex)}</td>
    </tr>)}</tbody>
  </table></div> : <p>原始候选为空（0 条）</p> : <p>来源候选未记录</p>;
}
function BatchAudit({ batch, data, outputSource }) {
  const review = batch.stage === 'review';
  const source = review ? data.batches?.find(item => item.stage === 'extract' && batch.extraction_batch_id != null && String(item.id) === String(batch.extraction_batch_id)) : batch;
  const output = data.member?.output;
  const linkedOutput = source?.id != null && String(source.id) === outputSource ? output : undefined;
  const diagnostic = batch.response_diagnostic;
  return <details><summary><span>{review ? '复核' : batch.stage === 'extract' ? '提取' : '阶段未记录'}批次 #{batch.id ?? '未记录'} 详情</span><small>{review ? '复核' : batch.stage === 'extract' ? '提取' : '阶段未记录'} · 第 {batch.batch_index == null ? '未记录' : Number(batch.batch_index) + 1} 批 · {batch.round ?? '未记录'} · {batch.status ?? '未记录'} · 耗时 {batch.response_ms == null ? '不可用' : `${batch.response_ms} 毫秒`} · token {batch.response_usage ? versions(batch.response_usage) : '用量不可用'}</small></summary>
    <p>阶段：{batch.stage ?? '未记录'} · 步骤：{batch.step ?? '未记录'} · 状态：{batch.status ?? '未记录'}</p>
    <p>任务模型：{data.job?.model ?? '未记录'} · 请求模型（冻结配置）：{data.job?.pipeline_versions?.requestedModel ?? data.job?.model ?? '未记录'}</p>
    <p>实际响应模型：{batch.response_model ?? '未记录'} · 响应 ID：{batch.response_id ?? '未记录'}</p>
    <p>请求预算：{batch.request_budget_used ?? '未记录'} / {batch.request_budget_limit ?? '未记录'} · 尝试次数：{batch.attempts ?? '未记录'} · 已确认请求：{batch.confirmed_requests ?? '未记录'} · 结果未知请求：{batch.unknown_requests ?? '未记录'}</p>
    <p>批次输入数（共享）：{batch.product_count ?? '未记录'} · 输入字节：{batch.input_bytes ?? '未记录'} · 估算 token：{batch.estimated_tokens ?? '未记录'}</p>
    <p>请求估算：{metadata(batch.request_estimate, ['requestBytes', 'estimatedInputTokens', 'outputReserveTokens', 'estimatedTotalTokens', 'oversized'])}</p>
    <p>{[['入队时间', 'queued_at'], ['规划时间', 'planned_at'], ['开始时间', 'started_at'], ['首内容时间', 'first_content_at'], ['响应完成时间', 'response_completed_at'], ['判定保存时间', 'decision_saved_at'], ['结束时间', 'finished_at']].map(([label, key]) => <React.Fragment key={key}>{label}：{batch[key] ? formatTime(batch[key]) : '未记录'} · </React.Fragment>)}</p>
    <p>判定 SHA-256：{batch.decision_hash ?? '未记录'}</p>
    <p>错误来源：{batch.error_source ?? '未记录'} · 重试分类：{batch.retry_class ?? '未记录'} · 错误：{batch.error ?? '未记录'}</p>
    <details><summary>安全响应诊断</summary>
      <p>{metadata(diagnostic, ['version', 'phase', 'code', 'fieldPath', 'contentSha256', 'outputBytes', 'outputChars', 'chunkCount', 'contentChunks', 'firstContentMs', 'finishReason', 'inputCount', 'returnedItemCount', 'rejectedItemCount', 'missingItemCount', 'issuesTruncated'])}</p>
      {diagnostic?.constraint ? <p>约束：{metadata(diagnostic.constraint, ['expectedType', 'actualType', 'actualCount', 'maxCount'])}</p> : null}
      {diagnostic?.issues?.length ? <ul>{diagnostic.issues.map((issue, index) => <li key={index}>{metadata(issue, ['stage', 'code', 'fieldPath', 'expectedType', 'actualType', 'actualCount', 'maxCount'])}</li>)}</ul> : null}
    </details>
    {review ? <>
      <p>来源提取批次：{batch.extraction_batch_id == null ? '未记录' : `#${batch.extraction_batch_id}`}</p>
      <p>持久化原始投票：{Array.isArray(batch.review_decisions) ? JSON.stringify(batch.review_decisions) : '未记录（不能按最终采纳或拒绝反推）'}</p>
    </> : null}
    <CandidateTable proposals={source?.proposals} decisions={review ? batch.review_decisions ?? (linkedOutput?.review?.mode === 'per_tag_binary' ? linkedOutput.review.decisions : undefined) : undefined} output={linkedOutput} publicationRecorded={Boolean(output)} label={`${review ? '复核' : '提取'}批次 #${batch.id ?? '未记录'} 候选判定`} />
  </details>;
}
function Metrics({ values, className = 'ai-standardization-summary' }) { return <dl className={className}>{Object.entries(values).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ?? '未记录'}</dd></div>)}</dl>; }
function taskTone(job, attention) {
  if (job?.status === 'failed') return 'danger';
  if (job?.status === 'cancelled') return 'neutral';
  if (attention || ['ready_with_errors', 'interrupted', 'paused', 'ready'].includes(job?.status)) return 'attention';
  return job?.status === 'succeeded' ? 'success' : 'progress';
}
function TagTaskOverview({ snapshot, item, shops, actions, title = '任务运行概览' }) {
  const job = snapshot?.job || item;
  const progress = snapshot?.progress || {};
  const results = progress.tagResults || {};
  const acceptance = progress.tagAcceptance || {};
  const stages = progress.tagStages || {};
  const total = Number(progress.rawProductCount || 0);
  const processed = Math.min(total, Number(progress.processed || 0));
  const attention = acceptance.rejectedTags > 0 || results.review > 0 || results.failed > 0 || results.unrecorded > 0;
  const shopId = job?.scope_shop_id ?? job?.scopeShopId;
  const shop = shops?.items?.find(entry => String(entry.id) === String(shopId))?.name;
  const parentId = job?.parent_identity_job_id ?? job?.parentIdentityJobId;
  const completed = job?.status === 'succeeded';
  const outdated = item?.configurationCurrent === false && !TERMINAL.has(job?.status);
  const stopped = outdated || ['failed', 'interrupted', 'cancelled', 'ready_with_errors'].includes(job?.status);
  const phase = Number(stages.reviewQueued || 0) + Number(stages.reviewRunning || 0) > 0 ? 1
    : Number(stages.publicationQueued || 0) + Number(progress.publication?.totalUnits || 0) > 0 ? 2 : 0;
  const extra = Object.fromEntries([
    ['无变化', results.unchanged], ['无可确认标签', results.empty], ['跳过', results.skipped],
    ['已取消', results.cancelled], ['未记录', results.unrecorded ?? '历史审计不可用'],
    ['部分采纳商品', acceptance.partialProducts],
  ].filter(([, value]) => typeof value === 'string' || Number(value) > 0));
  return <section className="ai-task-card ai-overview" aria-label="标签任务运行概览">
    <header className="ai-card-header">
      <div><h3>{title}</h3>{job ? <p>任务 #{job.id} · {shopId ? shop || `店铺 #${shopId}` : '所选商品范围'} · {parentId ? `来源身份任务 #${parentId}` : '手动创建'} · {job.model || '模型未记录'}</p> : null}</div>
      <div className="ai-header-actions">{job ? <span className={`ai-status-badge is-${outdated ? 'attention' : taskTone(job, attention)}`}>{outdated ? '版本已过期' : jobTitle(job, attention)}</span> : null}{actions}</div>
    </header>
    {!snapshot ? <p role="status">正在读取任务详情…</p> : <>
      <div className="ai-progress-heading"><div><span className="ai-progress-label">已处理商品</span><strong>{processed}<small> / {total}</small></strong></div><span className="ai-progress-percent">{total ? (processed / total * 100).toFixed(1) : '0.0'}%</span></div>
      <progress aria-label="标签商品处理进度" max={Math.max(1, total)} value={processed} />
      <Metrics values={{ 实际更新: results.updated, 待复核: results.review, 失败商品: results.failed,
        '通过标签（条）': acceptance.acceptedTags, '拒绝标签（条）': acceptance.rejectedTags, 失败批次: progress.requests?.failedBatches }} />
      {Object.keys(extra).length ? <Metrics className="tag-result-notes" values={extra} /> : null}
      <ol className="ai-pipeline-stages" aria-label="标签抽取阶段">
        {[
          ['提取标签', `${Number(stages.extractionCompleted || 0)} 批已提取`],
          ['LLM 二元复核', [
            `${Number(stages.reviewCompleted || 0)} 批已完成`,
            stages.reviewQueued > 0 ? `${stages.reviewQueued} 批排队` : null,
            stages.reviewRunning > 0 ? `${stages.reviewRunning} 批进行中` : null,
          ].filter(Boolean).join(' · ')],
          ['本地发布', `${Number(stages.publicationQueued || 0)} 批待发布`],
        ].map(([label, detail], index) => <li key={label}
          className={completed || !stopped && index < phase ? 'is-past' : !stopped && index === phase ? 'is-current' : ''}
          aria-current={!completed && !stopped && index === phase ? 'step' : undefined}>
          <span aria-hidden="true">{index + 1}</span><div><strong>{label}</strong><small>{detail}</small></div>
        </li>)}
      </ol>
      {job?.error && !snapshot.errors?.length ? <p className="ai-error" role="alert">{job.error}</p> : null}
      {snapshot.errors?.length ? <section className="ai-diagnostics" aria-label="标签任务处理记录">
        <div className="ai-diagnostic-group"><h4>失败批次</h4><ul className="ai-failure-list">{snapshot.errors.map((error, index) => <li key={index}>
          <div className="ai-failure-heading"><strong>第 {Number(error.batchIndex || 0) + 1} 批</strong><span>{error.step === 'request' ? '模型请求' : error.step || '未知阶段'}</span></div>
          <p className="ai-failure-message">{error.error}</p>
        </li>)}</ul></div>
      </section> : null}
    </>}
  </section>;
}
function Audit({ data }) {
  const output = data.member?.output;
  const hasReviewVotes = data.batches?.some(batch => batch.stage === 'review' && Array.isArray(batch.review_decisions));
  const reviewSources = [...new Set(data.batches?.filter(batch => batch.stage === 'review').map(batch => batch.extraction_batch_id == null ? null : String(batch.extraction_batch_id)))];
  const outputSource = reviewSources.length === 1 ? reviewSources[0] : undefined;
  return <div className="tag-audit">
    <p>结果：{resultTitle(output?.outcome, output?.acceptedTags?.length, output?.rejectedTags?.length)} · 原因：{reasonTitle(data.member?.reason_code || output?.reasonCode)}</p>
    <p>{output?.review?.mode === 'per_tag_binary' ? `逐标签二元复核 · 通过 ${output.acceptedTags?.length ?? 0} · 拒绝 ${output.rejectedTags?.length ?? 0}` : output?.review ? `历史 LLM 复核：${output.review.status === 'approved' ? '已通过' : '待复核'} · 原因：${output.review.reason || '未记录'}` : hasReviewVotes ? '逐标签二元复核：已保存原始判定，发布尚未完成' : 'LLM 复核未记录（不能确认历史执行状态）'}</p>
    {output?.review?.mode === 'per_tag_binary' ? <p>商品原始投票：{Array.isArray(output.review.decisions) ? JSON.stringify(output.review.decisions) : '未记录（不能按最终采纳或拒绝反推）'}</p> : null}
    {!output && (hasReviewVotes || ['queued', 'processing'].includes(data.member?.status)) ? <p>发布尚未完成，不能视为已写入。</p> : ['skipped', 'failed', 'cancelled'].includes(output?.outcome) ? <p>发布结果：{OUTCOMES[output.outcome]}，本次未写入商品标签；程序采纳候选不代表发布成功。</p> : null}
    <p>内容版本：{data.member?.content_version ?? '未记录'} · 修订：{data.member?.standardization_revision ?? '未记录'}</p>
    <p>输入指纹：{data.member?.fingerprint ?? output?.versions?.fingerprint ?? '未记录'}</p>
    <p>任务模型：{data.job?.model ?? '未记录'} · 抽取版本：{versions(output?.versions?.pipeline ?? data.job?.pipeline_versions)}</p>
    <details><summary>冻结输入 JSON</summary>{data.member?.payload != null ? <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}><code>{JSON.stringify(data.member.payload, null, 2)}</code></pre> : <p>冻结输入未记录，不能用实时商品资料还原。</p>}</details>
    {!output ? <p>{hasReviewVotes || ['queued', 'processing'].includes(data.member?.status) ? '商品最终发布审计尚未生成。' : '历史未记录审计结果，不能视为已验证完成。'}</p> : <>
      {['acceptedTags', 'rejectedTags'].map(key => <section key={key}><h5>{key === 'acceptedTags' ? '通过标签与证据' : '拒绝标签与诊断'}</h5>{output[key]?.length ? <ul>{output[key].map((tag, index) => <li key={index}><strong>{fieldTitle(tag.name)}：{displayPurchaseTagValue(tag)}</strong><p>原候选索引：{indexed(tag.proposalIndex) ? `#${tag.proposalIndex}` : '未记录'} · {voteTitle(output.review?.mode === 'per_tag_binary' && indexed(tag.proposalIndex) ? output.review.decisions?.[tag.proposalIndex] : undefined)} · {key === 'acceptedTags' ? '程序采纳' : '程序拒绝'}</p>{tag.reason || tag.reasonCode ? <p title={tag.reasonCode}>{reasonTitle(tag.reasonCode)}{tag.reason && tag.reasonCode !== 'review_rejected' ? `：${tag.reason}` : ''}</p> : null}<ul>{tag.evidence?.map((evidence, i) => <li key={i}>{evidence.path}：<q>{evidence.quote}</q></li>)}</ul></li>)}</ul> : <p>无</p>}</section>)}
      <h5>写入差异</h5>{output.diff?.length ? <ul>{output.diff.map((change, i) => <li key={i}>{fieldTitle(change.name)}：{change.before.map(value => displayPurchaseTagValue({ name: change.name, value })).join('、') || '无'} → {change.after.map(value => displayPurchaseTagValue({ name: change.name, value })).join('、') || '无'}</li>)}</ul> : <p>无字段变化</p>}
      {output.retainedUnconfirmed?.length ? <p>保留但本次未确认：{output.retainedUnconfirmed.map(tag => `${fieldTitle(tag.name)}：${displayPurchaseTagValue(tag)}`).join('；')}</p> : null}
    </>}
    <h5>关联请求用量（可能与其他商品共享，不累计为商品用量）</h5>
    {data.batches?.length ? <ul>{data.batches.map((batch, i) => <li key={batch.id ?? i}><BatchAudit batch={batch} data={data} outputSource={outputSource} /></li>)}</ul> : <p>耗时与 token 用量不可用</p>}
  </div>;
}

export default function TagExtractionPanel({ shops, onProductsChanged, onRefreshRuntime, view = 'tasks', enabled = true }) {
  const isHistory = view === 'history';
  const [historyFilter, setHistoryFilter] = useState('all');
  const filter = isHistory ? historyFilter : 'all';
  const [shop, setShop] = useState('');
  const [queue, setQueue] = useState(null);
  const [jobId, setJobId] = useState(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [snapshot, setSnapshot] = useState(null);
  const [members, setMembers] = useState(null);
  const [audits, setAudits] = useState({});
  const [expanded, setExpanded] = useState(null);
  const [error, setError] = useState('');
  const [connection, setConnection] = useState('');
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [scopeShop, setScopeShop] = useState('');
  const [ids, setIds] = useState('');
  const [preview, setPreview] = useState(null);
  const [ack, setAck] = useState(false);
  const queueSequence = useRef(0);
  const queuePending = useRef(null);
  const detailSequence = useRef(0);
  const auditSequence = useRef(0);
  const resultVersion = useRef(0);
  const detailPending = useRef(null);
  const detailTimer = useRef(null);
  const latestProgress = useRef(null);
  const selection = useRef(null);
  const draftSequence = useRef(0);
  const submission = useRef(null);
  const onChanged = useRef(onProductsChanged);
  onChanged.current = onProductsChanged;
  const alive = useRef(true);
  const queuePage = useRef(1);
  const queueCursors = useRef([null]);
  const memberPages = useRef(1);
  const expandedRef = useRef(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; ++queueSequence.current; ++detailSequence.current; ++draftSequence.current; }; }, []);

  const loadQueue = useCallback(async (requestedPage = queuePage.current) => {
    const sequence = ++queueSequence.current;
    queuePending.current = sequence;
    const cursor = isHistory ? queueCursors.current[requestedPage - 1] : null;
    const query = new URLSearchParams({ jobType: 'tag_extraction', status: filter, limit: isHistory ? String(PAGE_SIZE) : '1' });
    if (isHistory && shop) query.set('scopeShopId', shop);
    if (cursor) query.set('cursor', cursor);
    try {
      if (isHistory && requestedPage > 1 && !cursor) throw new Error('分页信息已变化，请刷新记录后重试。');
      const data = await requestJson('/api/admin/ai/task-queue?' + query);
      if (sequence !== queueSequence.current) return;
      const items = [...(data.items || [])];
      const total = Number(data.summary?.total ?? items.length);
      const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
      if (isHistory && requestedPage > lastPage) return loadQueue(lastPage);
      queuePage.current = isHistory ? requestedPage : 1;
      queueCursors.current = [...queueCursors.current.slice(0, queuePage.current), data.nextCursor || null];
      setQueue({ ...data, items, total, page: queuePage.current });
    } catch (reason) { if (sequence === queueSequence.current) throw reason; }
    finally { if (queuePending.current === sequence) queuePending.current = null; }
  }, [filter, shop, isHistory]);
  useEffect(() => { queuePage.current = 1; queueCursors.current = [null]; setQueue(null); setError(''); loadQueue(1).catch(reason => setError(reason.message)); return () => { ++queueSequence.current; }; }, [loadQueue]);
  useEffect(() => {
    const latest = queue?.items?.[0]?.id;
    if (!isHistory && !detailOpen && latest != null && selection.current !== String(latest)) selectJob(latest, false);
    if (!isHistory && !detailOpen && queue && latest == null && selection.current !== null) closeDetail();
  }, [queue, isHistory, detailOpen]);
  useEffect(() => {
    setDetailOpen(false); selection.current = null; setJobId(null); ++detailSequence.current;
  }, [view]);
  useEffect(() => {
    if (busy) return;
    const timer = setInterval(() => { if (!document.hidden && queuePending.current === null) loadQueue().catch(reason => { if (alive.current) setError(reason.message); }); }, 10000);
    return () => clearInterval(timer);
  }, [busy, loadQueue]);

  const loadDetail = useCallback(async () => {
    if (!jobId || !alive.current || selection.current !== jobId) return;
    if (detailPending.current?.sequence === detailSequence.current) {
      detailPending.current.again = true;
      return detailPending.current.promise;
    }
    const pending = { sequence: detailSequence.current, again: false, promise: null };
    const active = () => alive.current && pending.sequence === detailSequence.current && selection.current === jobId;
    pending.promise = (async () => {
      do {
        pending.again = false;
        const version = ++resultVersion.current;
        const progressBefore = latestProgress.current;
        try {
          const [next, first] = await Promise.all([requestJson(`/api/admin/ai/jobs/${jobId}`),
            detailOpen ? requestJson(`/api/admin/ai/jobs/${jobId}/tag-results`) : Promise.resolve(null)]);
          if (!active()) return;
          const openId = detailOpen ? expandedRef.current : null;
          const auditRequest = openId ? ++auditSequence.current : null;
          const audit = openId ? await requestJson(`/api/admin/ai/jobs/${jobId}/tag-results/${openId}`) : null;
          if (!active()) return;
          let results = first; let pages = 1;
          const items = [...(first?.items || [])];
          while (first && pages < memberPages.current && results.nextCursor) {
            results = await requestJson(`/api/admin/ai/jobs/${jobId}/tag-results?cursor=${encodeURIComponent(results.nextCursor)}`);
            if (!active()) return;
            items.push(...results.items); pages++;
          }
          // A slower snapshot must not roll back progress received while it was loading.
          const progress = latestProgress.current !== progressBefore ? latestProgress.current : null;
          setSnapshot(progress ? { ...next,
            job: { ...next.job, ...(progress.status ? { status: progress.status } : {}), ...(progress.phase ? { phase: progress.phase } : {}) },
            progress: { ...next.progress, ...progress },
          } : next);
          if (first) {
            memberPages.current = pages;
            setMembers({ ...results, items });
            setAudits(current => {
              const id = expandedRef.current;
              const value = id === openId && auditRequest === auditSequence.current && version === resultVersion.current
                ? { version, data: audit } : current[id];
              return value?.version === resultVersion.current ? { [id]: value } : {};
            });
          }
        } catch (reason) {
          if (!active()) return;
          if (!pending.again) throw reason;
        }
      } while (pending.again && active());
    })().finally(() => { if (detailPending.current === pending) detailPending.current = null; });
    detailPending.current = pending;
    return pending.promise;
  }, [jobId, detailOpen]);
  useEffect(() => {
    if (!jobId) return;
    setConnection('');
    loadDetail().catch(reason => { if (alive.current && selection.current === jobId) setError(reason.message); });
    return () => { ++detailSequence.current; clearTimeout(detailTimer.current); detailTimer.current = null; };
  }, [jobId, loadDetail]);
  useEffect(() => {
    if (!jobId || !snapshot || TERMINAL.has(snapshot.job?.status)) return;
    const controller = new AbortController();
    const refresh = () => {
      if (controller.signal.aborted) return;
      const sequence = detailSequence.current;
      const active = () => alive.current && selection.current === jobId && sequence === detailSequence.current;
      Promise.all([loadDetail(), loadQueue()]).then(() => { if (active()) { setConnection(''); onChanged.current?.(); } }).catch(reason => { if (active()) setError(reason.message); });
    };
    const refreshResults = () => {
      if (!detailOpen || detailTimer.current !== null) return;
      detailTimer.current = setTimeout(() => {
        detailTimer.current = null;
        loadDetail().catch(reason => { if (alive.current && selection.current === jobId) setError(reason.message); });
      }, 1000);
    };
    const stream = createProgressEventSource(`/api/admin/ai/jobs/${jobId}/events`, {
      signal: controller.signal, onOpen: refresh,
      onProgress: progress => {
        if (controller.signal.aborted) return;
        setConnection('');
        latestProgress.current = { ...latestProgress.current, ...progress };
        setSnapshot(current => current && String(current.job?.id) === jobId ? {
          ...current,
          job: { ...current.job, ...(progress.status ? { status: progress.status } : {}), ...(progress.phase ? { phase: progress.phase } : {}) },
          progress: { ...current.progress, ...progress },
        } : current);
        onChanged.current?.();
        if (TERMINAL.has(progress.status)) {
          clearTimeout(detailTimer.current); detailTimer.current = null;
          refresh();
        } else refreshResults();
      },
      onError: () => { if (!controller.signal.aborted) setConnection('实时连接中断，正在重连；可刷新读取服务端快照。'); },
    });
    if (!stream) setConnection('实时连接不可用，请刷新读取最新状态。');
    return () => { controller.abort(); stream?.close(); };
  }, [jobId, Boolean(snapshot), snapshot?.job?.status, detailOpen, loadDetail, loadQueue]);

  async function run(action) {
    setBusy(true); setError('');
    try { await action(); } catch (reason) { if (alive.current) setError(reason.message); }
    finally { if (alive.current) setBusy(false); }
  }
  function selectJob(id, open = true) {
    setDetailOpen(open);
    if (String(id) === jobId) { if (open === detailOpen) run(loadDetail); return; }
    selection.current = String(id); ++detailSequence.current; memberPages.current = 1; latestProgress.current = null; setSnapshot(null); setMembers(null); setAudits({}); expandedRef.current = null; setExpanded(null); setJobId(String(id)); setError('');
  }
  function closeDetail() {
    ++detailSequence.current; selection.current = null; setDetailOpen(false); setJobId(null);
    setSnapshot(null); setMembers(null); setError(''); setConnection('');
  }
  function invalidateDraft() { ++draftSequence.current; setPreview(null); setAck(false); submission.current = null; }
  function openCreate() {
    invalidateDraft(); setScopeShop(''); setIds(''); setDialog({}); setError('');
  }
  async function openAllPending() {
    invalidateDraft(); setDialog({ allPending: true }); setError('');
  }
  async function makePreview(requestScope) {
    const productIds = [...new Set(ids.split(/[\s,，]+/).filter(Boolean))];
    if (!requestScope && productIds.length > 500) throw new Error('一次最多选择 500 件商品。');
    if (!requestScope && ((!scopeShop && !productIds.length) || (scopeShop && productIds.length) || productIds.some(id => !/^[1-9]\d*$/.test(id)))) throw new Error('请选择一家店铺，或输入商品 ID（不能同时使用）。');
    const scope = requestScope || (scopeShop ? { scopeShopId: scopeShop } : { productIds });
    const sequence = ++draftSequence.current;
    const data = await requestJson('/api/ai/tag-jobs/preview', { method: 'POST', body: JSON.stringify(scope) });
    if (sequence !== draftSequence.current || !alive.current) return;
    setPreview({ ...data, requestScope: scope }); setAck(false); submission.current = null;
  }
  async function create() {
    if ((!dialog?.allPending && !preview) || !ack) return;
    submission.current ||= { ...(dialog?.allPending ? {allPending:true} : {...preview.requestScope,previewDigest:preview.previewDigest}), requestId: crypto.randomUUID(), acknowledgePossibleCharge: true };
    const created = await requestJson('/api/ai/tag-jobs', { method: 'POST', body: JSON.stringify(submission.current) });
    if (!alive.current) return;
    setDialog(null); invalidateDraft(); selectJob(created.id); await loadQueue();
  }
  async function expand(id) {
    expandedRef.current = expandedRef.current === id ? null : id;
    setExpanded(expandedRef.current);
    if (audits[id]?.version === resultVersion.current || expandedRef.current === null) return;
    const forJob = jobId; const sequence = detailSequence.current;
    const version = resultVersion.current;
    const request = ++auditSequence.current;
    const data = await requestJson(`/api/admin/ai/jobs/${jobId}/tag-results/${id}`);
    if (selection.current === forJob && sequence === detailSequence.current && version === resultVersion.current && request === auditSequence.current && alive.current) setAudits(current => ({ ...current, [id]: { version, data } }));
  }
  async function moreMembers() {
    const forJob = jobId; const sequence = detailSequence.current;
    const version = resultVersion.current;
    const next = await requestJson(`/api/admin/ai/jobs/${jobId}/tag-results?cursor=${encodeURIComponent(members.nextCursor)}`);
    if (alive.current && selection.current === forJob && sequence === detailSequence.current && version === resultVersion.current) { memberPages.current++; setMembers(current => ({ ...next, items: [...current.items, ...next.items] })); }
  }
  const job = snapshot?.job;
  const latest = queue?.items?.[0];
  const current = queue?.items?.find(item => String(item.id) === jobId);
  const refresh = () => run(() => Promise.all([loadQueue(), loadDetail(), onRefreshRuntime?.()]));
  return <section className={`tag-extraction-panel${isHistory ? ' ai-history-panel' : ''}`} aria-label={isHistory ? '标签抽取记录' : '标签抽取管理'}>
    {!isHistory ? <div className="ai-task-panel is-standardization">
      <section className="ai-task-card" aria-label="标签抽取监控">
        <header className="ai-card-header">
          <div className="ai-standardization-heading"><h3>标签抽取监控</h3><span className={`ai-status-badge is-${enabled ? 'success' : 'attention'}`}>{enabled ? '已启用' : '已关闭'}</span></div>
          <div className="ai-header-actions">
            <button type="button" disabled={busy} aria-label="刷新标签状态" onClick={refresh}>刷新状态</button>
            <button type="button" disabled={busy || !enabled} aria-label="创建全部未完成任务" onClick={() => run(openAllPending)}>全部待处理</button>
            <button type="button" className="primary" disabled={busy || !enabled} aria-label="新建标签任务" onClick={() => openCreate()}>新建任务</button>
          </div>
        </header>
        {!enabled ? <p className="ai-config-notice" role="status">标签抽取功能未启用，现有记录仍可查看。</p> : null}
        {!queue ? <p role="status">{error ? '标签状态暂不可用，请刷新重试。' : '正在读取标签任务…'}</p> : <Metrics values={{
          待处理商品: queue.summary?.pendingProducts, 排队任务: queue.summary?.queued, 运行任务: queue.summary?.running,
          待复核商品: queue.summary?.reviewProducts, 失败商品: queue.summary?.failedProducts, 已覆盖商品: queue.summary?.coveredProducts,
        }} />}
      </section>
      {!detailOpen && latest ? <TagTaskOverview snapshot={snapshot} item={latest} shops={shops} actions={
        <button type="button" disabled={busy} aria-label={`查看标签任务 #${latest.id}`} onClick={() => selectJob(latest.id)}>查看详情</button>
      } /> : !detailOpen && queue ? <section className="ai-task-card"><EmptyState>暂无标签抽取任务</EmptyState></section> : null}
    </div> : <>
      <header className="ai-card-header">
        <div className="tag-panel-filters">
          <label>任务筛选<select value={historyFilter} disabled={busy} onChange={event => setHistoryFilter(event.target.value)}><option value="all">全部任务</option><option value="attention">仅异常任务</option><option value="unfinished">仅未完成任务</option></select></label>
          <label>店铺筛选<select value={shop} disabled={busy} onChange={event => setShop(event.target.value)}><option value="">全部店铺</option>{shops?.items?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        </div>
        <button type="button" disabled={busy} aria-label="刷新标签状态" onClick={refresh}>刷新记录</button>
      </header>
      {!queue ? <p role="status">正在读取标签任务…</p> : !queue.items.length ? <EmptyState>暂无匹配的标签任务</EmptyState> : <div className="data-table-wrap"><table className="tag-task-table">
        <thead><tr><th>任务</th><th>来源</th><th>店铺</th><th>状态</th><th>已处理 / 商品数</th><th>待处理</th><th>创建时间</th></tr></thead>
        <tbody>{queue.items.map(item => {
          const outdated = item.configurationCurrent === false && !TERMINAL.has(item.status);
          const attention = item.unclassified > 0;
          return <tr key={item.id}>
            <td><button type="button" disabled={busy} aria-label={`查看标签任务 #${item.id}`} onClick={() => selectJob(item.id)}>查看任务 #{item.id}</button></td>
            <td>{item.parentIdentityJobId ? `身份任务 #${item.parentIdentityJobId}` : '手动创建'}{item.retryOfJobId ? <small>重试 #{item.retryOfJobId}</small> : null}
              {outdated ? <details><summary>版本信息</summary><small>{versions(item.pipelineVersions)}</small></details> : null}</td>
            <td>{item.scopeShopId ? shops?.items?.find(entry => String(entry.id) === String(item.scopeShopId))?.name || `店铺 #${item.scopeShopId}` : '所选商品范围'}</td>
            <td><span className={`ai-status-badge is-${outdated ? 'attention' : taskTone(item, attention)}`}>{outdated ? '版本已过期' : jobTitle(item, attention)}</span>{attention ? <small>需关注商品：{item.unclassified}</small> : null}</td>
            <td>{item.processed ?? 0} / {item.total ?? 0}</td><td>{item.remaining ?? 0}</td><td>{formatTime(item.createdAt)}</td>
          </tr>;
        })}</tbody>
      </table></div>}
      <Pagination total={queue?.total || 0} page={queue?.page || 1} pageSize={PAGE_SIZE} disabled={busy}
        onChange={page => run(() => loadQueue(page))} label="标签抽取记录" />
    </>}
    {error && !dialog && !detailOpen ? <p className="ai-error" role="alert">{error}</p> : null}
    {connection && !detailOpen ? <p role="status">{connection}</p> : null}
    {detailOpen && jobId ? <ModalDialog open onClose={closeDetail} aria-label="标签任务详情" className="management-dialog tag-task-dialog">
      <div className="dialog-body">
        <section className="ai-task-panel is-standardization" aria-label="标签任务详情">
          <TagTaskOverview snapshot={snapshot} item={current} shops={shops} title={`标签任务 #${jobId}`} actions={<>
            <button type="button" disabled={busy} onClick={() => run(loadDetail)}>刷新详情</button>
            <button type="button" aria-label="关闭标签任务详情" onClick={closeDetail}>关闭</button>
          </>} />
          {error && !dialog ? <p className="ai-error" role="alert">{error}</p> : null}
          {connection ? <p role="status">{connection}</p> : null}
          {snapshot ? <div className="tag-panel-actions">
            {['queued', 'running'].includes(job?.status) ? <button type="button" disabled={busy} onClick={() => run(async () => { await requestJson(`/api/ai/jobs/${jobId}/pause`, { method: 'POST' }); await Promise.all([loadDetail(), loadQueue()]); })}>暂停标签任务</button> : null}
            {job?.status === 'paused' ? <button type="button" disabled={busy || !enabled} onClick={() => run(async () => { await requestJson(`/api/ai/jobs/${jobId}/resume`, { method: 'POST' }); await Promise.all([loadDetail(), loadQueue()]); })}>继续标签任务</button> : null}
            {!TERMINAL.has(job?.status) ? <button type="button" disabled={busy} onClick={() => run(async () => { await requestJson(`/api/ai/jobs/${jobId}/cancel`, { method: 'POST' }); await Promise.all([loadDetail(), loadQueue()]); })}>取消标签任务</button> : null}
          </div> : null}
          {snapshot ? <details className="tag-execution-record"><summary>任务信息</summary>
            <p>创建：{formatTime(job?.created_at)} · 完成：{formatTime(job?.finished_at)} · 版本：{versions(job?.pipeline_versions)}</p>
            {snapshot.currentBatches?.length ? <ul>{snapshot.currentBatches.filter(batch => Number(batch.batch_index ?? batch.batchIndex) >= 0).map((batch, index) => <li key={index}>在途批次 {Number(batch.batch_index ?? batch.batchIndex) + 1} · {batch.round} · {batch.step} · {batch.product_count ?? batch.productCount} 份输入</li>)}</ul> : null}
          </details> : null}
      <header className="ai-card-header tag-member-heading"><h4>商品结果</h4></header>
      {!members ? <p role="status">正在读取商品结果…</p> : members.items.length ? <ul className="tag-member-list">{members.items.map(member => { const id = String(member.id); return <li key={id}><strong>{member.name}</strong><p>{member.shop_name} · {member.spec} · {resultTitle(member.outcome || (['queued', 'processing'].includes(member.status) ? member.status : 'unrecorded'), member.acceptedCount, member.rejectedCount)} · {reasonTitle(member.reason_code)}</p><p>通过 {member.acceptedCount ?? '未记录'} · 拒绝 {member.rejectedCount ?? '未记录'} · 变化字段 {member.changedFields ?? '未记录'}</p><button type="button" aria-expanded={expanded === id} onClick={() => run(() => expand(id))}>查看商品 #{id} 依据</button>{expanded === id ? audits[id]?.version === resultVersion.current ? <Audit data={audits[id].data} /> : <p role="status">正在读取商品依据…</p> : null}</li>; })}</ul> : <EmptyState>暂无商品结果</EmptyState>}
      {members?.nextCursor ? <button type="button" disabled={busy} onClick={() => run(moreMembers)}>加载更多商品结果</button> : null}

        </section>
      </div>
    </ModalDialog> : null}
    {dialog ? <ModalDialog open onClose={() => { if (!busy) { setDialog(null); invalidateDraft(); } }} aria-label="创建标签任务" className="management-dialog tag-create-dialog"><div className="dialog-body">
      <h3>{dialog.allPending ? '创建全部未完成任务' : '创建标签任务'}</h3>
      {!dialog.allPending ? <>
        <label>范围店铺<select disabled={busy} value={scopeShop} onChange={event => { setScopeShop(event.target.value); invalidateDraft(); }}><option value="">使用商品 ID</option>{shops?.items?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>商品 ID（空格或逗号分隔）<textarea disabled={busy} value={ids} onChange={event => { setIds(event.target.value); invalidateDraft(); }} /></label>
      </> : null}
      {!dialog.allPending ? <button type="button" disabled={busy || !enabled} onClick={() => run(() => makePreview())}>预览标签范围</button> : null}
      {preview ? <>
        <p>模型：{preview.model}</p>
        <Metrics values={{ 选定商品: preview.counts.selected, 缺失商品: preview.counts.missing, 受保护商品: preview.counts.protected, 可处理商品: preview.counts.eligible, 超限商品: preview.counts.oversized, 唯一输入: preview.counts.uniqueInputs, 初始提取批次: preview.counts.requestBatches, '预计模型调用（正常两阶段）': preview.counts.requestBatches == null ? null : preview.counts.requestBatches * 2 }} />
      </> : null}
      {dialog.allPending || preview ? <>
        <p className="ai-field-help">提取与复核两阶段均可能消耗模型额度或产生费用。</p>
        <details><summary>调用与重试说明</summary>
        <p>提取 LLM → 复核 LLM → 原子发布。每批可包含多个商品及其多个候选标签，复核逐标签只判 YES/NO，不纠正或补充标签。每个初始批次通常调用模型 2 次（一次提取、一次批量复核），提取和复核两个阶段均可能产生费用；拆批及重试可能增加调用次数。</p>
        {dialog.allPending ? <p>资料和流水线版本未变化时，已完成的部分采纳及待复核结果不会自动重新入队。</p> : null}
        </details>
        <label className="tag-charge-confirmation"><input type="checkbox" checked={ack} disabled={busy} onChange={event => setAck(event.target.checked)} />我确认可能消耗模型额度或产生费用</label>
        <button type="button" className="primary" disabled={busy || !enabled || !ack || (!dialog.allPending && !preview.counts.eligible)} onClick={() => run(create)}>确认创建标签任务</button>
      </> : null}
      {error ? <p role="alert">{error}</p> : null}
      <button type="button" disabled={busy} onClick={() => { setDialog(null); invalidateDraft(); }}>关闭</button>
    </div></ModalDialog> : null}
  </section>;
}
