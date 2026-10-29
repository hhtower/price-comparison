import ModalDialog from './components/ModalDialog.jsx';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createProgressEventSource, formatTime, requestJson } from './api.js';
import { EmptyState, Pagination } from './components/AdminControls.jsx';
import FetchRuns from './FetchRuns.jsx';
import TagExtractionPanel from './TagExtractionPanel.jsx';
import CrawlerOverview from './CrawlerOverview.jsx';

const HISTORY_PAGE_SIZE = 10;
const WORKBENCH_TABS = [
  ['crawler', '抓取'], ['fetch-runs', '抓取记录'],
  ['task', '标准化'], ['history', '标准化记录'],
  ['tags', '标签抽取'], ['tag-history', '标签抽取记录'],
];
const STATUS_TEXT = {
  queued: '排队中', running: '进行中', paused: '已暂停', ready: '待继续', succeeded: '已完成',
  failed: '失败', cancelled: '已取消', interrupted: '已中断', ready_with_errors: '部分完成',
};
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'ready_with_errors']);
const REASONS = {
  not_processed: '尚未处理',
  unassigned: '当前未归类',
  source_changed: '商品资料已变化',
  insufficient_evidence: '商品信息不足',
  not_sellable: '非售卖商品',
  input_too_large: '商品资料过长',
  publication_too_large: '结果内容过大',
  invalid_response: '模型结果格式异常',
  evidence_invalid: '商品证据引用无效',
  attribute_conflict: '商品属性与证据冲突',
  technical_failure: '请求或处理异常',
  provider_policy_rejection: '模型服务策略拒绝',
  other_unclassified: '其他待处理原因',
  provider_error: '模型服务调用失败',
  identity_conflict: '标准商品身份冲突',
  missing_id: '模型未返回该商品',
  request_outcome_unknown: '模型请求结果未知',
  result_not_saved: '模型结果保存失败',
  publication_error: '结果应用失败',
  missing_identity: '未识别商品身份',
  publication_blocked: '商品交付或目录需审核',
  job_cancelled: '任务已取消',
  review_rejected: 'LLM 对该身份提议判定为否',
};
function reasonTitle(code) { return REASONS[code] || '暂未完成分类'; }
function cannotProcess(results) {
  const reasons = results?.unclassifiedReasons || {};
  return number(reasons.insufficient_evidence) + number(reasons.not_sellable);
}
function unresolved(results) {
  return Math.max(0, number(results?.unclassified) - cannotProcess(results));
}
function taskStatus(job, progress) {
  return job?.status === 'succeeded' && unresolved(progress?.results ?? job) > 0
    ? '处理结束 · 有待处理商品' : STATUS_TEXT[job?.status] || job?.status;
}
function number(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function jobValue(job, camel, snake = camel) {
  return job?.[camel] ?? job?.[snake];
}

function Metric({ label, value }) {
  const display = typeof value === 'string' ? value : number(value).toLocaleString('zh-CN');
  return <div><dt>{label}</dt><dd>{display}</dd></div>;
}

function taskSource(item) {
  const runId = jobValue(item, 'sourceFetchRunId', 'source_fetch_run_id');
  if (runId) return '爬取 #' + runId;
  return jobValue(item, 'jobType', 'job_type') === 'incremental' ? '商品变更（历史 / 手动）' : '手动任务';
}

function TaskList({ items, shops, busy, onSelect }) {
  return <div className="data-table-wrap"><table className="ai-history-table">
      <thead><tr><th>任务</th><th>来源批次</th><th>商铺</th><th>状态</th><th>已处理 / 商品数</th><th>剩余</th><th>创建时间</th></tr></thead>
      <tbody>{items.map(item => {
        const shopId = jobValue(item, 'scopeShopId', 'scope_shop_id');
        const shopName = item.shopName || shops?.items?.find(shop => String(shop.id) === String(shopId))?.name;
        return <tr key={item.id}>
          <td><button type="button" disabled={busy} onClick={() => onSelect(item)}>查看任务 #{item.id}</button></td>
          <td>{taskSource(item)}</td><td>{shopId ? shopName || '商铺 #' + shopId : '全部商铺'}</td>
          <td>{taskStatus(item)}</td><td>{number(item.processed)} / {number(item.total)}</td>
          <td>{number(item.remaining)}</td><td>{formatTime(jobValue(item, 'createdAt', 'created_at'))}</td>
        </tr>;
      })}</tbody>
    </table></div>;
}

function ProgressOverview({ status }) {
  const progress = status?.progress || {};
  const requests = progress.requests || {};
  const results = progress.results || {};
  const stages = progress.standardizationStages || {};
  const total = number(progress.rawProductCount);
  const processed = Math.min(total, number(results.classified) + number(results.unclassified));
  const refused = cannotProcess(results);
  const pending = unresolved(results);
  const percent = total ? processed / total * 100 : 0;
  const completed = status?.job?.status === 'succeeded';
  const stopped = ['failed', 'interrupted', 'cancelled', 'ready_with_errors'].includes(status?.job?.status);
  const phase = completed || status?.job?.phase === 'completed' ? 2
    : number(stages.reviewQueued) + number(stages.reviewRunning) > 0 ? 1
    : number(stages.publicationQueued) + number(progress.publication?.totalUnits) > 0 ? 2 : 0;
  return (
    <div>
      <div className="ai-progress-heading"><div><span className="ai-progress-label">已处理商品</span><strong>{processed}<small> / {total}</small></strong></div><span className="ai-progress-percent">{percent.toFixed(1)}%</span></div>
      <progress max={Math.max(total, 1)} value={processed} aria-label="商品处理进度" />
      <dl className="ai-standardization-summary">
        <Metric label="原始商品" value={progress.rawProductCount} />
        <Metric label="已分类" value={results.classified} />
        <Metric label="不能处理" value={refused} />
        <Metric label="待处理" value={pending} />
        <Metric label="标准商品" value={results.standardProducts} />
        <Metric label="失败批次" value={requests.failedBatches} />
      </dl>
      <ol className="ai-pipeline-stages" aria-label="标准化阶段">
        {[
          ['生成身份提议', `${number(stages.generationCompleted)} 批已生成`],
          ['LLM 二元复核', [
            `${number(stages.reviewCompleted)} 批已完成`,
            number(stages.reviewQueued) > 0 ? `${number(stages.reviewQueued)} 批排队` : null,
            number(stages.reviewRunning) > 0 ? `${number(stages.reviewRunning)} 批进行中` : null,
          ].filter(Boolean).join(' · ')],
          ['本地发布', `${number(stages.publicationQueued)} 批待发布`],
        ].map(([label, detail], index) => <li key={label}
          className={completed || !stopped && index < phase ? 'is-past' : !stopped && index === phase ? 'is-current' : ''}
          aria-current={!completed && !stopped && index === phase ? 'step' : undefined}>
          <span aria-hidden="true">{index + 1}</span><div><strong>{label}</strong><small>{detail}</small></div>
        </li>)}
      </ol>
      {Object.keys(results.unclassifiedReasons || {}).length || status?.currentBatches?.length || status?.errors?.length ? (
        <section className="ai-diagnostics" aria-label="任务处理记录">
          {Object.keys(results.unclassifiedReasons || {}).length ? (
            <ul className="ai-reason-list">{Object.entries(results.unclassifiedReasons).map(([reason, count]) => <li key={reason}><strong>{reasonTitle(reason)} · {number(count)} 件</strong></li>)}</ul>
          ) : null}
          {status?.currentBatches?.length ? (
            <div className="ai-diagnostic-group"><h4>在途批次</h4><ul>{status.currentBatches.map(batch => <li key={`${batch.round}-${batch.batchIndex}`}>第 {number(batch.batchIndex) + 1} 批 · round {batch.round} · {batch.step} · {number(batch.productCount)} 份输入</li>)}</ul></div>
          ) : null}
          {status?.errors?.length ? (
            <div className="ai-diagnostic-group"><h4>失败批次</h4><ul className="ai-failure-list" aria-label="失败批次记录">{status.errors.map((error, index) => <li key={`${error.batchIndex}-${index}`}>
              <div className="ai-failure-heading"><strong>第 {number(error.batchIndex) + 1} 批</strong><span>{error.step === 'request' ? '模型请求' : error.step === 'publish' ? '结果发布' : error.step || '未知阶段'}</span></div>
              <p className="ai-failure-message">{error.error}</p>
              {error.diagnostic ? <details><summary>查看诊断</summary>
                <div className="ai-response-data">
                <p>阶段：{error.diagnostic.phase} · 原因：{error.diagnostic.code} · 字段：{error.diagnostic.fieldPath || '未定位'}</p>
                <p>响应：{error.responseId || '未收到标识'} · 模型：{error.responseModel || '未记录'} · 耗时：{error.responseMs ?? '未记录'} 毫秒</p>
                <p>输入：{error.diagnostic.inputCount} · 返回：{error.diagnostic.returnedItemCount ?? '未解析'} · 拒绝：{error.diagnostic.rejectedItemCount} · 漏项：{error.diagnostic.missingItemCount}</p>
                <p>输出：{error.diagnostic.outputBytes} 字节 · 分块：{error.diagnostic.chunkCount} · 结束：{error.diagnostic.finishReason || '未收到'} · token：{error.responseUsage?.totalTokens ?? '未知'}</p>
                {error.diagnostic.constraint && Object.keys(error.diagnostic.constraint).length ? <p>约束：{JSON.stringify(error.diagnostic.constraint)}</p> : null}
                {error.diagnostic.issues?.length ? <ul>{error.diagnostic.issues.map((issue, i) => <li key={i}>
                  {issue.itemId ? `商品 #${issue.itemId} · ` : ''}{issue.stage} · {issue.code} · {issue.fieldPath || '未定位'}
                </li>)}</ul> : null}
                {error.diagnostic.issuesTruncated ? <p>诊断摘要已截取，完整商品问题请查看商品结果。</p> : null}
                <p>响应摘要 SHA-256：<code style={{ overflowWrap: 'anywhere' }}>{error.diagnostic.contentSha256}</code></p>
                </div>
              </details> : <small>历史批次未记录结构化响应诊断</small>}
            </li>)}</ul></div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

export default function AiWorkbench({ shops, onProductsChanged }) {
  const [tab, setTab] = useState('crawler');
  const tabId = useId();
  const isTagView = tab === 'tags' || tab === 'tag-history';
  const isFetchView = tab === 'crawler' || tab === 'fetch-runs';
  const isStandardizationView = tab === 'task' || tab === 'history';
  const [status, setStatus] = useState(null);
  const [history, setHistory] = useState({ items: [], total: 0, page: 1 });
  const historyPageRef = useRef(1);
  const historyCursorsRef = useRef([null]);
  const [historyFilter, setHistoryFilter] = useState('all');
  const historyFilterRef = useRef('all');
  const [queue, setQueue] = useState(null);
  const [queueError, setQueueError] = useState('');
  const queueRequestRef = useRef(0);
  const historyRequestRef = useRef(0);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [viewedJobId, setViewedJobId] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const previousTaskRef = useRef(null);
  const detailRequestRef = useRef(0);
  const [connectionError, setConnectionError] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const [retryTotal, setRetryTotal] = useState(0);
  const [crawlerStatus, setCrawlerStatus] = useState(null);
  const [crawlerError, setCrawlerError] = useState('');
  const [crawlerLoading, setCrawlerLoading] = useState(true);
  const retryRequestIdRef = useRef(null);
  const notifiedJobIdRef = useRef(null);
  const crawlerSinceRef = useRef(null);

  const job = status?.job;
  const jobId = job?.id == null ? null : String(job.id);
  const configuredModel = status?.model || '';
  const retrySourceJobId = jobValue(job, 'retryOfJobId', 'retry_of_job_id');
  const taskShopId = jobValue(job, 'scopeShopId', 'scope_shop_id');
  const taskShop = (shops?.items || []).find(shop => String(shop.id) === String(taskShopId));
  const loadStatus = useCallback(async () => {
    const next = await requestJson('/api/admin/ai/status');
    if (previousTaskRef.current) {
      previousTaskRef.current.status = next;
      previousTaskRef.current.viewedJobId = null;
      return next;
    }
    setStatus(next);
    setViewedJobId(null);
    return next;
  }, []);

  async function refreshRuntime() {
    const next = await requestJson('/api/admin/ai/status');
    setStatus(current => ({ ...current, configured: next.configured, configError: next.configError,
      tagExtractionEnabled: next.tagExtractionEnabled, model: next.model }));
  }

  async function refreshJob() {
    const request = detailRequestRef.current;
    const next = viewedJobId ? await requestJson(`/api/admin/ai/jobs/${viewedJobId}`) : await requestJson('/api/admin/ai/status');
    if (request !== detailRequestRef.current) return;
    setStatus(current => ({ ...current, ...next }));
    setConnectionError(false);
  }

  async function refreshView() {
    setError('');
    await Promise.all([refreshJob(), loadQueue(), loadHistory(), loadCrawlerStatus()]);
  }

  const loadHistory = useCallback(async (requestedPage = historyPageRef.current) => {
    const request = ++historyRequestRef.current;
    const cursor = historyCursorsRef.current[requestedPage - 1];
    if (requestedPage > 1 && !cursor) throw new Error('分页信息已变化，请刷新记录后重试。');
    const query = new URLSearchParams({ limit: String(HISTORY_PAGE_SIZE), status: historyFilterRef.current });
    if (cursor) query.set('cursor', cursor);
    const data = await requestJson('/api/admin/ai/task-queue?' + query);
    if (request !== historyRequestRef.current) return;
    const items = Array.isArray(data?.items) ? data.items : [];
    const total = number(data?.summary?.total ?? items.length);
    const lastPage = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE));
    if (requestedPage > lastPage) return loadHistory(lastPage);
    historyPageRef.current = requestedPage;
    historyCursorsRef.current = [...historyCursorsRef.current.slice(0, requestedPage), data?.nextCursor || null];
    setHistory({ items, total, page: requestedPage });
  }, []);

  const loadQueue = useCallback(async () => {
    const request = ++queueRequestRef.current;
    const query = new URLSearchParams({ limit: '1', status: 'unfinished' });
    try {
      const data = await requestJson('/api/admin/ai/task-queue?' + query);
      if (request !== queueRequestRef.current) return;
      setQueue(data);
      setQueueError('');
    } catch (reason) { if (request === queueRequestRef.current) setQueueError(reason.message); }
  }, []);

  async function changeHistoryPage(page = historyPageRef.current) {
    setBusy('page');
    setError('');
    try { await loadHistory(page); } catch (reason) { setError(reason.message); } finally { setBusy(''); }
  }

  const loadCrawlerStatus = useCallback(async () => {
    setCrawlerLoading(true);
    try {
      const data = await requestJson('/api/admin/tasks/crawler/status');
      crawlerSinceRef.current = data?.lastReportAt ?? null;
      setCrawlerStatus(data);
      setCrawlerError('');
    } catch (reason) {
      setCrawlerError(`抓取状态更新失败：${reason.message}`);
    } finally {
      setCrawlerLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    setError('');
    Promise.all([loadStatus(), loadCrawlerStatus().catch(() => undefined)]).catch(reason => active && setError(reason.message));
    return () => { active = false; };
  }, [loadCrawlerStatus, loadStatus]);

  useEffect(() => {
    if (!isStandardizationView) return undefined;
    let active = true;
    Promise.all([loadHistory(), loadQueue()]).catch(reason => active && setError(reason.message));
    return () => { active = false; queueRequestRef.current++; historyRequestRef.current++; };
  }, [isStandardizationView, loadHistory, loadQueue]);

  useEffect(() => {
    if (busy || !isStandardizationView) return undefined;
    const timer = setInterval(() => { if (!document.hidden) void loadQueue(); }, 10000);
    return () => clearInterval(timer);
  }, [busy, isStandardizationView, loadQueue]);

  useEffect(() => {
    if (!taskOpen) return undefined;
    let active = true;
    requestJson('/api/admin/ai/retry-pool?limit=1')
      .then(data => { if (active) setRetryTotal(number(data?.total)); })
      .catch(() => { if (active) setRetryTotal(0); });
    return () => { active = false; };
  }, [taskOpen]);

  useEffect(() => {
    if (!isStandardizationView || !jobId || TERMINAL_STATUSES.has(job?.status)) return undefined;
    const controller = new AbortController();
    const stream = createProgressEventSource(`/api/admin/ai/jobs/${jobId}/events`, {
      since: status?.progress?.version,
      signal: controller.signal,
      onProgress: snapshot => { setConnectionError(false); setStatus(current => current && String(current.job?.id) === jobId ? {
        ...current,
        job: snapshot.status ? { ...current.job, status: snapshot.status } : current.job,
        progress: { ...(current.progress || {}), ...snapshot },
      } : current); },
      onError: () => setConnectionError(true),
    });
    return () => { controller.abort(); stream?.close(); };
  }, [isStandardizationView, job?.status, jobId]);

  useEffect(() => {
    const controller = new AbortController();
    const stream = createProgressEventSource('/api/admin/tasks/crawler/events', {
      since: crawlerSinceRef.current,
      signal: controller.signal,
      onProgress: snapshot => {
        crawlerSinceRef.current = snapshot?.lastReportAt ?? null;
        setCrawlerStatus(snapshot);
        setCrawlerError('');
      },
      onError: () => setCrawlerError('抓取实时连接中断，正在重连。'),
    });
    return () => { controller.abort(); stream?.close(); };
  }, []);

  useEffect(() => {
    if (!jobId || !TERMINAL_STATUSES.has(job?.status) || number(status?.progress?.results?.classified) <= 0) return;
    if (notifiedJobIdRef.current === jobId) return;
    notifiedJobIdRef.current = jobId;
    onProductsChanged?.();
  }, [job?.status, jobId, onProductsChanged, status?.progress?.results?.classified]);

  async function selectHistory(item) {
    const request = ++detailRequestRef.current;
    setTaskOpen(false);
    setBusy('history'); setError('');
    try {
      const next = await requestJson(`/api/admin/ai/jobs/${item.id}`);
      if (request !== detailRequestRef.current) return;
      setStatus(current => {
        if (!historyOpen && !previousTaskRef.current) previousTaskRef.current = { status: current, viewedJobId, connectionError };
        return { ...current, ...next };
      });
      setViewedJobId(String(item.id));
      setConnectionError(false);
      setHistoryOpen(true);
    } catch (reason) {
      if (request === detailRequestRef.current) setError(reason.message);
    } finally {
      if (request === detailRequestRef.current) setBusy('');
    }
  }

  function closeHistory() {
    detailRequestRef.current++;
    setHistoryOpen(false);
    const previous = previousTaskRef.current;
    if (previous) {
      setStatus(previous.status);
      setViewedJobId(previous.viewedJobId);
      setConnectionError(previous.connectionError);
      previousTaskRef.current = null;
    }
    setError('');
    setBusy('');
  }

  async function lifecycle(action) {
    if (!jobId) return;
    const request = detailRequestRef.current;
    setBusy(action);
    setError('');
    try {
      await requestJson(`/api/ai/jobs/${jobId}/${action}`, { method: 'POST' });
      const next = await requestJson(`/api/admin/ai/jobs/${jobId}`);
      if (request === detailRequestRef.current) setStatus(current => ({ ...current, ...next }));
      await Promise.all([loadHistory(), loadQueue()]);
    } catch (reason) {
      if (request === detailRequestRef.current) setError(reason.message);
    } finally {
      if (request === detailRequestRef.current) setBusy('');
    }
  }

  async function viewRetryJob(created) {
    setTaskOpen(false);
    const next = await requestJson(`/api/admin/ai/jobs/${created.id}`);
    await Promise.all([loadHistory(), loadQueue()]);
    setStatus(current => ({ ...current, ...next }));
    setViewedJobId(String(created.id)); setTab('task');
  }

  async function createJob() {
    setBusy('create');
    setError('');
    try {
      await requestJson('/api/ai/jobs', { method: 'POST', body: JSON.stringify({ model: configuredModel }) });
      setTaskOpen(false);
      await Promise.all([loadStatus(), loadHistory(), loadQueue()]);
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy('');
    }
  }

  function closeTaskDialog() {
    retryRequestIdRef.current = null;
    setTaskOpen(false);
  }

  async function submitRetryAll() {
    if (!retryRequestIdRef.current) retryRequestIdRef.current = crypto.randomUUID();
    setBusy('retry');
    setError('');
    try {
      const created = await requestJson('/api/ai/retry-pool', { method: 'POST', body: JSON.stringify({ requestId: retryRequestIdRef.current, acknowledgePossibleCharge: true }) });
      retryRequestIdRef.current = null;
      setTaskOpen(false);
      await viewRetryJob(created);
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy('');
    }
  }

  function navigateTabs(event, index) {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % WORKBENCH_TABS.length;
    else if (event.key === 'ArrowLeft') next = (index + WORKBENCH_TABS.length - 1) % WORKBENCH_TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = WORKBENCH_TABS.length - 1;
    else return;
    event.preventDefault();
    setTab(WORKBENCH_TABS[next][0]);
    event.currentTarget.parentElement.querySelectorAll('[role="tab"]')[next].focus();
  }

  const taskTone = job?.status === 'failed' ? 'danger' : job?.status === 'cancelled' ? 'neutral'
    : unresolved(status?.progress?.results) || ['ready_with_errors', 'interrupted', 'paused', 'ready'].includes(job?.status) ? 'attention'
    : job?.status === 'succeeded' ? 'success' : 'progress';
  const taskOverview = <section className="ai-task-card ai-overview" aria-label="任务运行概览">
    <header className="ai-card-header">
      <div><h3>任务运行概览</h3><p>{job ? `任务 #${jobId} · ${taskShopId ? taskShop?.name || `商铺 #${taskShopId}` : '全部商铺'} · ${taskSource(job)} · ${job.model}` : '尚无标准化任务'}</p></div>
      <div className="ai-header-actions">
        {job ? <span className={`ai-status-badge is-${taskTone}`}>{taskStatus(job, status?.progress)}</span> : null}
        {historyOpen ? <>
          <button type="button" disabled={Boolean(busy)} onClick={() => refreshJob().catch(reason => setError(reason.message))}>刷新任务</button>
          <button type="button" aria-label="关闭任务详情" onClick={closeHistory}>关闭</button>
        </> : null}
      </div>
    </header>
    {historyOpen && error ? <p className="ai-error" role="alert">{error}</p> : null}
    {historyOpen && connectionError ? <p role="status">实时连接中断，正在重连。</p> : null}
    {retrySourceJobId ? <p>重试自任务 #{String(retrySourceJobId)}。<button type="button" disabled={Boolean(busy)} onClick={() => selectHistory({ id: retrySourceJobId })}>查看原任务</button></p> : null}
    {job ? <ProgressOverview status={status} /> : null}
    <div className="ai-lifecycle-actions">
      {viewedJobId && !historyOpen ? <button type="button" onClick={() => loadStatus().catch(reason => setError(reason.message))}>返回最新任务</button> : null}
      {job?.status === 'running' || job?.status === 'queued' ? <button type="button" disabled={Boolean(busy)} onClick={() => lifecycle('pause')}>暂停任务</button> : null}
      {job?.status === 'paused' ? <button type="button" disabled={Boolean(busy)} onClick={() => lifecycle('resume')}>恢复任务</button> : null}
      {job && ['failed', 'interrupted', 'ready_with_errors'].includes(job.status) && number(status?.progress?.results?.unclassifiedReasons?.publication_error) > 0 ? <button type="button" disabled={Boolean(busy)} onClick={() => lifecycle('retry')}>重试结果应用</button> : null}
      {job && !TERMINAL_STATUSES.has(job.status) ? <button type="button" disabled={Boolean(busy)} onClick={() => lifecycle('cancel')}>取消任务</button> : null}
    </div>
  </section>;

  return (
    <section className={`ai-workbench ai-workbench-embedded${tab === 'crawler' ? ' is-crawler' : tab === 'fetch-runs' ? ' is-fetch-runs' : tab === 'task' ? ' is-standardization' : tab === 'history' ? ' is-history' : tab === 'tags' ? ' is-tags' : ' is-tag-history'}`} aria-label="后台任务">
      <div className="ai-workbench-tabs" role="tablist" aria-label="工作台视图">
        {WORKBENCH_TABS.map(([id, label], index) => <button key={id} id={`${tabId}-${id}`} type="button" role="tab" aria-selected={tab === id}
          aria-controls={`${tabId}-panel`} tabIndex={tab === id ? 0 : -1} onKeyDown={event => navigateTabs(event, index)} onClick={() => setTab(id)}>{label}</button>)}
      </div>
      <div className="ai-workbench-body" id={`${tabId}-panel`} role="tabpanel" aria-labelledby={`${tabId}-${tab}`} tabIndex={0}>
        {isTagView ? <TagExtractionPanel shops={shops} onProductsChanged={onProductsChanged} onRefreshRuntime={refreshRuntime} enabled={status?.tagExtractionEnabled !== false} view={tab === 'tag-history' ? 'history' : 'tasks'} /> : null}
        {error && !taskOpen && !historyOpen && !isTagView && !isFetchView ? <p className="ai-error" role="alert">{error}</p> : null}
        {status && !status.configured && tab === 'task' ? <div className="ai-config-notice" role="status">{status.configError || 'AI 尚未配置'}</div> : null}
        {connectionError && !historyOpen && tab === 'task' ? <p role="status">实时连接中断，正在重连。</p> : null}
        {tab === 'task' ? (
          <section className="ai-task-panel standardization-panel">
            <section className="ai-task-card" aria-label="标准化队列">
              <header className="ai-card-header">
                <div className="ai-standardization-heading"><h3>标准化监控</h3>
                  <span className={`ai-status-badge is-${!status ? 'neutral' : status.configured ? 'success' : 'attention'}`}>
                    {!status ? '正在读取…' : status.configured ? 'AI 已配置' : '待配置'}
                  </span>
                </div>
                <div className="ai-header-actions">
                  <button type="button" disabled={Boolean(busy)} onClick={() => refreshView().catch(reason => setError(reason.message))}>刷新状态</button>
                  <button type="button" className="primary" disabled={Boolean(busy)} onClick={() => setTaskOpen(true)}>新建任务</button>
                </div>
              </header>
              {queueError ? <p role="alert">队列统计更新失败：{queueError}</p> : null}
              {queue?.summary ? <dl className="ai-standardization-summary">
                <Metric label="排队中" value={queue.summary.queued} />
                <Metric label="进行中" value={queue.summary.running} />
                <Metric label="已暂停 / 待继续" value={queue.summary.paused} />
                <Metric label="异常任务" value={queue.summary.attention} />
                <Metric label="未处理商品" value={queue.summary.pendingProducts} />
                <Metric label="待建任务商品" value={queue.summary.pendingEvents} />
              </dl> : <p>{queueError ? '队列数据暂不可用，请刷新重试。' : '正在读取全局队列…'}</p>}
            </section>
            {!historyOpen ? taskOverview : null}
          </section>
        ) : null}
        {tab === 'crawler' ? <CrawlerOverview status={crawlerStatus} error={crawlerError} loading={crawlerLoading}
          onRefresh={loadCrawlerStatus} /> : null}
        {tab === 'fetch-runs' ? <FetchRuns /> : null}
        {tab === 'history' ? (
          <section className="ai-history-panel" aria-label="标准化记录" aria-busy={busy === 'page'}>
            <header className="ai-card-header">
            <label>任务筛选 <select value={historyFilter} disabled={Boolean(busy)} onChange={event => {
              historyFilterRef.current = event.target.value; setHistoryFilter(event.target.value);
              historyPageRef.current = 1;
              historyCursorsRef.current = [null];
              void changeHistoryPage(1);
            }}><option value="all">全部任务</option><option value="attention">仅异常任务</option><option value="unfinished">仅未完成任务</option></select></label>
              <button type="button" disabled={Boolean(busy)} onClick={() => changeHistoryPage()}>刷新状态</button>
            </header>
            {history.items.length ? <TaskList items={history.items} shops={shops} busy={Boolean(busy)} onSelect={selectHistory} />
              : <EmptyState>暂无符合条件的任务。</EmptyState>}
            <Pagination total={history.total} page={history.page} pageSize={HISTORY_PAGE_SIZE} onChange={changeHistoryPage}
              label="标准化记录" disabled={Boolean(busy)} />
          </section>
        ) : null}
      </div>
      {historyOpen ? <ModalDialog className="management-dialog ai-history-dialog is-standardization" open onClose={closeHistory} aria-label="标准化任务详情">
        <div className="dialog-body ai-task-panel standardization-panel">{taskOverview}</div>
      </ModalDialog> : null}
      {taskOpen ? <ModalDialog className="management-dialog ai-task-dialog" open onClose={closeTaskDialog} aria-label="新建任务">
        <button type="button" className="dialog-close" aria-label="关闭" onClick={closeTaskDialog}>×</button>
        <div className="dialog-body">
          {configuredModel ? <p className="ai-field-help">模型：{configuredModel}</p> : null}
          <p className="ai-field-help">每批通常包含一次生成和一次 LLM 二元复核，两阶段均消耗模型用量；拆批或重试可能增加请求。</p>
          <div className="ai-task-options">
            <button type="button" className="primary" disabled={!status?.configured || Boolean(busy) || Boolean(viewedJobId) || Boolean(job && !TERMINAL_STATUSES.has(job.status))} onClick={createJob}>{busy === 'create' ? '启动中…' : '全量任务'}</button>
            {retryTotal > 0 ? <button type="button" disabled={!status?.configured || Boolean(busy)} onClick={submitRetryAll}>{busy === 'retry' ? '提交中…' : `重试任务（${retryTotal} 条）`}</button> : null}
          </div>
          {job && !TERMINAL_STATUSES.has(job.status) ? <p className="ai-field-help">请先完成或取消当前任务。</p> : null}
          {error ? <p className="ai-error" role="alert">{error}</p> : null}
        </div>
      </ModalDialog> : null}
    </section>
  );
}
