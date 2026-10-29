import React, { useEffect, useState } from 'react';
import { isQualityTerminal } from './quality-api.js';
import { qualityReportScope } from '../../api/src/quality/quality-report.ts';
const MODE_LABELS = { quick: '快速', standard: '标准', full: '完整' };
const STATUS_LABELS = { pass: '通过', risk: '风险', unrun: '未测试', unavailable: '需 SOCKS5', cancelled: '检测取消' };
export function StatusPill({ status }) {
  return <span className={'quality-status quality-status-' + status}>{STATUS_LABELS[status]}</span>;
}
export function Report({ report, onOpen, onRetestRisk }) {
  const { summary, configuration } = report;
  const items = qualityReportScope(report);
  const risks = items.filter(item => item.status === 'risk');
  const uncovered = items.filter(item => ['unrun', 'cancelled', 'unavailable'].includes(item.status));
  const groups = [...new Set(items.filter(item => item.status === 'pass').map(item => item.group))];
  const coverage = Math.round(summary.tested / summary.total * 100);
  const tone = { '通过': 'pass', '存在风险': 'risk', '存在未覆盖风险': 'uncovered', '检测未完成': 'incomplete' }[summary.overall];
  const retained = items.some(item => item.status !== 'unavailable' && !configuration.selected.includes(item.id));
  const card = item => <button key={item.id} type="button" className={'quality-report-card quality-card-' + item.status} onClick={() => onOpen(item.id)}><span className="quality-report-card-title">{item.label}</span><strong>{item.score ?? '--'}</strong><StatusPill status={item.status} /><small>{item.id === 'model-identity' && ['pass', 'risk'].includes(item.status) ? <>{item.status === 'pass' ? '名称匹配' : '名称不匹配'} · 来源未验证</> : item.summary}</small><span className="quality-card-detail">查看详情</span></button>;
  return <section className="quality-report" aria-label="检测报告">
    {report.state === 'cancelled' ? <div className="quality-cancelled" role="status"><strong>检测已取消</strong><span>已完成结果已保留，其余项目标记为检测取消。可重新填写配置继续检测。</span></div> : null}
    {report.state === 'failed' ? <div className="quality-cancelled" role="status"><strong>检测失败</strong><span>已保留完成结果。请检查配置或网络，重新填写凭据后再试。</span></div> : null}
    <section className="quality-report-summary" aria-label="检测概览" data-tone={tone}>
      <header className="quality-report-header">
        <div className="quality-report-identity">{report.kind !== 'ai' ? <span className="quality-report-kind">{report.target.startsWith('socks') ? '线路检测报告' : 'IP 检测报告'}</span> : null}{report.model ? <strong className="quality-report-model" title={report.model}>{report.model}</strong> : null}<span className="quality-report-target" title={report.target}>{report.target}</span></div>
        <time className="quality-report-time" aria-label="报告时间" dateTime={report.completedAt}>{new Date(report.completedAt).toLocaleString('zh-CN', { hour12: false })}</time>
      </header>
      <div className="quality-report-result">
        <div className="quality-report-verdict"><span className="quality-verdict-mark" aria-hidden="true">{tone === 'risk' ? '!' : tone === 'pass' ? '✓' : tone === 'uncovered' ? '!' : '–'}</span><h2>{summary.overall}</h2></div>
        <div className="quality-report-score" aria-label={'已测项目评分：' + (summary.score ?? '未评分')}><span className="quality-score-label">已测评分</span><div><strong>{summary.score ?? '--'}</strong><span> / 100</span></div></div>
        <dl className="quality-report-stats" aria-label="检测统计">
          <div className={summary.risk ? 'quality-stat-risk' : undefined}><dt>风险项目</dt><dd aria-label={'风险 ' + summary.risk + ' 项'}>{summary.risk}<span> 项</span></dd></div>
          <div><dt>已完成</dt><dd aria-label={'已完成 ' + summary.tested + ' 项'}>{summary.tested}<span> 项</span></dd></div>
          <div><dt>未测试</dt><dd aria-label={'未测试 ' + summary.unrun + ' 项'}>{summary.unrun}<span> 项</span></dd></div>
          <div><dt>覆盖率</dt><dd aria-label={'覆盖率 ' + coverage + '%'}>{coverage}<span>%</span></dd></div>
        </dl>
      </div>
      <div className="quality-report-meta">{report.kind === 'ai' ? <span>{MODE_LABELS[configuration.mode]}模式</span> : null}<span>本次 {configuration.runs} 次</span><span>检测范围 {configuration.selected.length} 项</span>{retained ? <span>报告累计 {summary.total} 项</span> : null}{report.kind === 'ip' && summary.unavailable ? <span>需 SOCKS5 {summary.unavailable} 项</span> : null}{summary.cancelled ? <span>已取消 {summary.cancelled} 项</span> : null}</div>
      {retained ? <p className="quality-report-retained">保留本次范围外的既有结果；其证据轮次可能来自此前检测。</p> : null}
    </section>
    {risks.length ? <section className="quality-risk-section" aria-label="风险项"><div className="quality-section-heading"><h3>风险项 · {risks.length}</h3>{onRetestRisk ? <button type="button" className="quality-secondary-button" onClick={onRetestRisk}>重测风险项</button> : null}</div><div className="quality-report-grid">{risks.map(card)}</div></section> : null}
    {uncovered.length ? <section className="quality-uncovered-section" aria-label="未覆盖项目"><h3>未覆盖项目 · {uncovered.length}</h3><div className="quality-report-grid">{uncovered.map(card)}</div></section> : null}
    {groups.map(group => <section className="quality-group-section" key={group} aria-label={group}><h3>{group}</h3><div className="quality-report-grid">{items.filter(item => item.status === 'pass' && item.group === group).map(card)}</div></section>)}
  </section>;
}
export function TaskProgress({ task, kind }) {
  const report = task.phase !== 'creating' && task.report && !isQualityTerminal(task.report.state) ? task.report : null;
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const state = task.disconnected ? 'disconnected' : task.phase === 'creating' || task.phase === 'cancelling' ? task.phase : report?.state ?? 'running';
  const title = state === 'creating' ? '正在创建检测任务' : state === 'cancelling' ? '正在取消检测' : state === 'disconnected' ? '检测进度连接中断' : state === 'queued' ? '检测任务排队中' : (kind === 'ai' ? 'AI检测中' : 'IP检测中');
  const completed = report ? report.items.filter(item => report.configuration.selected.includes(item.id) && (item.status !== 'unrun' || ['unsupported', 'insufficient-samples'].includes(item.reason))) : [];
  const count = report ? '已完成 ' + completed.length + ' 项 / 本次 ' + report.configuration.selected.length + ' 项' : '等待服务端响应';
  const elapsed = Math.max(0, Math.floor((now - (report ? Date.parse(report.createdAt) : task.startedAt)) / 1000));
  return <section className="quality-task-panel" aria-label="检测概览" data-state={state}>
    <section className="quality-task-status" aria-label="检测进度" aria-live="polite">
      <div className="quality-task-header"><span className="quality-task-symbol" aria-hidden="true"><span /></span><div className="quality-task-heading"><h2>{title}</h2>{report ? <div className="quality-task-identity"><span className="quality-task-target" title={report.target}>{report.target}</span>{report.model ? <span className="quality-task-model">模型：{report.model}</span> : null}</div> : null}</div><span className="quality-task-count">{count}</span></div>
      <div className="quality-task-track" role="progressbar" aria-label="检测进度" aria-valuetext={task.disconnected ? title : count}><span /></div>
      <p className="quality-task-note">{task.disconnected ? '任务可能仍在运行，请重新连接以获取最新进度。' : state === 'cancelling' ? '正在停止检测，已完成的项目将保留。' : state === 'queued' ? '任务已提交，正在等待可用的检测资源。' : state === 'creating' ? '正在连接检测服务，请稍候。' : '请求轮次仅表示当前进度，不代表已通过项目数。'} · 已耗时 {elapsed} 秒</p>
      {report?.progress.length ? <ul className="quality-active-requests" aria-label="当前请求">{report.progress.map(entry => <li key={entry.itemId}><strong>{report.items.find(item => item.id === entry.itemId).label}</strong><span>{({measurement:'基础观测',baseline:'基准对照',probe:'能力检测'})[entry.stage]} · 第 {entry.attempt}/{entry.total} 轮</span></li>)}</ul> : report && state === 'running' ? <p className="quality-task-note">等待下一项请求</p> : null}
    </section>
    {completed.length ? <section className="quality-completed-results" aria-label="已完成结果"><h3>已完成结果</h3><ul>{completed.map(item => <li key={item.id}><div><strong>{item.label}</strong><StatusPill status={item.status} />{item.score !== null ? <span>{item.score} 分</span> : null}</div><p>{item.reason === 'unsupported' ? '暂不支持 · ' : ''}{item.summary}</p></li>)}</ul></section> : null}
  </section>;
}
