import React, { useEffect, useRef, useState } from 'react';
import { formatTime, requestJson } from './api.js';
import { EmptyState, Pagination } from './components/AdminControls.jsx';

const PAGE_SIZE = 10;
const SETTLEMENT_REASONS = {
  request_failed: '请求失败', blocked: '源站拦截', no_payment_channel: '无可用支付渠道',
  proxy_authentication: '代理认证失败',
  estimated: '支付价预估',
  invalid_quote: '结算响应无效', quantity_not_supported: '起购数量无效', deferred: '待分批核验',
  not_selected: '未公开商品', out_of_stock: '无库存', recently_verified: '近期已核验', superseded: '商品或来源已变化',
};
const RUN_STATUS = { queued: '排队中', running: '进行中', succeeded: '已完成', failed: '失败', cancelled: '已取消' };

function duration(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return '未知';
  return `${Math.round(Number(ms))} 毫秒`;
}

function SettlementSummary({ run }) {
  const report = run.settlementReport;
  if (!report) return run.error ? <span>{run.error}</span> : null;
  const isSupplement = run.taskType === 'settlement';
  const retryLabel = isSupplement
    ? ['failed', 'cancelled', 'succeeded'].includes(run.status) ? '已结束 · 未恢复' : '待重试'
    : '可补采';
  return <>
    <span>{isSupplement ? '结算补采' : '列表已采集'} · 核验成功 {report.verified} · 失败 {report.failed} · 跳过 {report.skipped}{report.retryable > 0 ? ` · ${retryLabel} ${report.retryable}` : ''}</span>
    <span>{Object.entries(report.reasons || {}).map(([reason, count]) => `${SETTLEMENT_REASONS[reason] || reason} ${count}`).join(' · ')}</span>
  </>;
}

function RunMetrics({ metrics }) {
  if (!metrics) return null;
  return <span>请求 {metrics.requests ?? 0} · 重试 {metrics.retries ?? 0} · 源站等待 {duration(metrics.durations?.rate_wait)} · 代理等待 {duration(metrics.durations?.proxy_wait)} · 网络 {duration(metrics.durations?.network)} · 入库 {duration(metrics.durations?.transaction)}</span>;
}

export default function FetchRuns() {
  const [data, setData] = useState({ items: [], total: 0, page: 1 });
  const [request, setRequest] = useState({ page: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const listRef = useRef(null);
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ limit: String(PAGE_SIZE), page: String(request.page) });
    requestJson(`/api/admin/run-history?${query}`, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        const items = result.items || [];
        const total = Number(result.total ?? items.length);
        const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
        if (request.page > lastPage) {
          controller.abort();
          loadPage(lastPage);
          return;
        }
        setData({ items, total, page: request.page });
        if (listRef.current) listRef.current.scrollTop = 0;
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [request]);

  function loadPage(page) {
    setLoading(true);
    setError('');
    setRequest({ page });
  }

  return (
    <section className="ai-history-panel fetch-runs-panel" aria-label="抓取记录" aria-busy={loading}>
      <header className="ai-card-header">
        <h3>抓取记录</h3>
        <div className="ai-header-actions">
          {loading ? <span className="fetch-runs-loading" role="status" aria-label="读取抓取记录"><span className="crawler-spinner" aria-hidden="true" />加载中…</span> : null}
          <button type="button" disabled={loading} onClick={() => loadPage(data.page)}>刷新记录</button>
        </div>
      </header>
      {error ? <div className="fetch-runs-error" role="alert">
        <span>抓取记录加载失败：{error}</span>
        <button type="button" disabled={loading} onClick={() => loadPage(request.page)}>重试</button>
      </div> : null}
      <div className="run-list admin-scroll-area" ref={listRef} tabIndex={0} aria-label="抓取记录列表">
        {data.items.length ? data.items.map((run) => (
          <article key={run.id} className="run-card">
            <header className="run-card-heading">
              <strong>{run.shopName || run.shop_name || `商铺 #${run.shopId || run.shop_id || ''}`}</strong>
              <span>{formatTime(run.startedAt || run.started_at || run.createdAt || run.created_at)}</span>
            </header>
            <div className="run-card-content">
              {run.taskType === 'settlement'
                ? <span>{run.sourceFetchRunId ? `补采任务 #${run.id} · 来源列表 #${run.sourceFetchRunId}` : `独立结算任务 #${run.id}`} · {RUN_STATUS[run.status] || run.status}</span>
                : <span>列表 #{run.id} · {RUN_STATUS[run.status] || run.status} · {run.itemCount ?? run.product_count ?? 0} 件商品</span>}
              <SettlementSummary run={run} />
              <RunMetrics metrics={run.crawlMetrics} />
            </div>
          </article>
        )) : loading ? <p className="ai-field-help">正在读取抓取记录…</p> : !error ? <EmptyState>暂无抓取记录</EmptyState> : null}
      </div>
      <Pagination total={data.total} page={data.page} pageSize={PAGE_SIZE} onChange={loadPage} label="抓取记录" disabled={loading} />
    </section>
  );
}
