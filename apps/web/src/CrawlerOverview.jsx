import React from 'react';
import { formatTime } from './api.js';

function duration(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return '未知';
  const seconds = Math.round(Number(ms) / 1000);
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  return `${seconds} 秒`;
}

function count(value) { return value == null ? '未知' : value.toLocaleString('zh-CN'); }
function percent(part, total) { return part != null && total > 0 ? `${Math.round(part / total * 100)}%` : '暂无数据'; }
function Metric({ label, value, detail, title }) {
  return <div title={title}><dt>{label}</dt><dd>{typeof value === 'string' ? value : count(value)}</dd>{detail ? <small>{detail}</small> : null}</div>;
}

export default function CrawlerOverview({ status, error, loading, onRefresh }) {
  const diagnostics = status?.diagnostics;
  const queue = status?.instances;
  const coverage = diagnostics?.coverage;
  const supplement = diagnostics?.settlementQueue;
  const hasSupplement = supplement && Object.values(supplement).some(value => value > 0);
  const budgets = (diagnostics?.budgets || []).filter(item => item.sampledShops > 0)
    .sort((a, b) => (b.estimatedMs ?? -1) - (a.estimatedMs ?? -1) || a.host.localeCompare(b.host)).slice(0, 10);
  const heartbeat = status?.lastReportAt ? formatTime(new Date(status.lastReportAt).toISOString()) : null;
  return <section className="ai-task-panel crawler-panel">
    <section className="ai-task-card" aria-label="抓取任务" aria-busy={loading}>
      <header className="ai-card-header">
        <div className="crawler-heading"><h3>抓取监控</h3>
          <span className={`ai-status-badge is-${error ? 'attention' : !status ? 'neutral' : status.workerCount > 0 ? 'success' : 'attention'}`}>
            {error ? status ? '状态待确认' : '状态未知' : !status ? loading ? '正在读取…' : '状态未知'
              : status.workerCount > 0 ? `${count(status.workerCount)} 个进程在线` : '暂无进程上报'}
          </span>
        </div>
        <div className="crawler-actions">
          <span className="crawler-heartbeat" title={heartbeat || undefined}>{heartbeat ? `心跳 ${heartbeat.slice(11)}` : '暂无心跳'}</span>
          <button type="button" disabled={loading} onClick={onRefresh}>
            {loading ? <span className="crawler-spinner" aria-hidden="true" /> : null}{loading ? '刷新中…' : '刷新状态'}
          </button>
        </div>
      </header>
      {error ? <p className="ai-error crawler-error" role="alert">{error} {status ? '当前显示上次收到的数据。' : ''}</p> : null}
      {!status && loading ? <div className="crawler-loading" role="status" aria-label="读取抓取状态">
        <span className="crawler-spinner" aria-hidden="true" />正在读取抓取状态…
      </div> : <dl className="crawler-metrics">
        <Metric label="待执行" value={queue?.queued} />
        <Metric label="进行中" value={queue?.running} />
        <Metric label="等待重试" value={diagnostics?.deferred} />
        <Metric label="最长排队" value={diagnostics?.oldestQueuedMs != null ? duration(diagnostics.oldestQueuedMs)
          : queue?.queued === 0 ? '无排队' : '未知'} />
        <Metric label="近1小时失败" value={queue?.failedRecent} title="含列表抓取与报价补采" />
        <Metric label="成功率（近1小时）" value={percent(diagnostics?.listSucceeded, diagnostics?.windowRuns)}
          detail={diagnostics?.windowRuns > 0 ? `${count(diagnostics.listSucceeded)} / ${count(diagnostics.windowRuns)}`
            : diagnostics?.windowRuns === 0 ? '暂无完成记录' : undefined}
          title="近1小时已结束的列表任务：成功数 / 总数" />
        <Metric label="报价覆盖率（当前）" value={percent(coverage?.verified, coverage?.eligible)}
          detail={coverage?.eligible > 0 ? `${count(coverage.verified)} / ${count(coverage.eligible)}`
            : coverage?.eligible === 0 ? '暂无在售商品' : undefined}
          title="当前已发布且有库存的商品中，支付价仍在核验有效期内的比例" />
      </dl>}
      {supplement ? <section className="crawler-supplement" aria-label="报价补采">
        <h4>报价补采</h4>
        {hasSupplement ? <dl>
          <Metric label="待执行" value={supplement.queued} />
          <Metric label="进行中" value={supplement.running} />
          <Metric label="等待重试" value={supplement.deferred} />
          <Metric label="近1小时失败" value={supplement.failedRecent} />
        </dl> : <span className="ai-field-help">暂无补采任务</span>}
      </section> : null}
      {budgets.length ? <section className="crawler-hosts">
        <h4>域名负载</h4>
        <div className="data-table-wrap"><table className="crawler-budget-table" aria-label="域名抓取负载">
          <thead><tr><th scope="col">域名</th><th scope="col">样本请求</th><th scope="col" aria-sort="descending">预计一轮 ↓</th></tr></thead>
          <tbody>{budgets.map(item => <tr key={item.host}>
            <td>{item.host}</td><td>{count(item.requests)}</td><td>{duration(item.estimatedMs)}</td>
          </tr>)}</tbody>
        </table></div>
      </section> : null}
    </section>
  </section>;
}
