import React, { useEffect, useState } from 'react';
import { requestJson } from './api.js';
import { Pagination } from './components/AdminControls.jsx';
import { ANALYTICS_PAGES, ANALYTICS_ACTIONS, ANALYTICS_DEVICES, ANALYTICS_BROWSERS, ANALYTICS_SOURCES } from '../../api/src/analytics/analytics-contract.ts';
import { REFERENCE_APPS } from '../../api/src/official-reference/official-reference.catalog.ts';
import './visitor-analytics.css';

const number = value => Number(value).toLocaleString('zh-CN');
const duration = value => value < 1000 ? '0 秒' : value < 60000 ? Math.round(value / 1000) + ' 秒' : (value / 60000).toFixed(1) + ' 分钟';
const time = value => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value));
const location = item => item.geoStatus === 'local' ? '内网 / 保留地址' : item.geoStatus === 'disabled' ? '归属地未启用' : item.geoStatus === 'resolved' ? [item.country, item.region, item.city].filter(Boolean).join(' / ') : item.ip ? '归属地暂不可用' : '未知归属地';
const referenceApps = Object.fromEntries(REFERENCE_APPS.map(app => [app.id, app.name]));

function useAnalyticsResource(path, revision) {
  const [state, setState] = useState({ data: null, loading: true, error: '' });
  useEffect(() => {
    if (!path) { setState({ data: null, loading: false, error: '' }); return undefined; }
    const controller = new AbortController();
    setState({ data: null, loading: true, error: '' });
    requestJson(path, { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setState({ data, loading: false, error: '' });
    }).catch(error => {
      if (!controller.signal.aborted) setState({ data: null, loading: false, error: error.message });
    });
    return () => controller.abort();
  }, [path, revision]);
  return state;
}

function TrendChart({ rows }) {
  const width = 760; const height = 210; const left = 42; const right = 18; const top = 14; const bottom = 30;
  const max = Math.max(4, Math.ceil(Math.max(0, ...rows.map(row => row.pageViews)) / 4) * 4);
  const x = index => rows.length < 2 ? width / 2 : left + index * (width - left - right) / (rows.length - 1);
  const y = value => height - bottom - value * (height - top - bottom) / max;
  return <section className="analytics-panel analytics-trend">
    <div className="analytics-panel-heading"><h2>访问趋势</h2><div className="analytics-legend"><span>浏览量 PV</span><span>独立访客 UV</span></div></div>
    <svg viewBox={'0 0 ' + width + ' ' + height} role="img" aria-label="访问趋势：浏览量与独立访客">
      <title>每日浏览量与独立访客，按北京时间统计</title>
      {[0, 1, 2, 3, 4].map(tick => <g key={tick}><line className="analytics-gridline" x1={left} x2={width - right} y1={y(max * tick / 4)} y2={y(max * tick / 4)} /><text x={left - 8} y={y(max * tick / 4) + 4} textAnchor="end">{number(max * tick / 4)}</text></g>)}
      {['pageViews', 'visitors'].map(metric => <g key={metric} className={'analytics-series ' + metric}>
        <polyline points={rows.map((row, index) => x(index) + ',' + y(row[metric])).join(' ')} />
        {rows.map((row, index) => <circle key={row.date} cx={x(index)} cy={y(row[metric])} r={rows.length > 30 ? 2 : 3} tabIndex={0} aria-label={row.date + ' ' + (metric === 'pageViews' ? '浏览量 ' : '独立访客 ') + row[metric]}><title>{row.date} · {metric === 'pageViews' ? 'PV' : 'UV'} {row[metric]}</title></circle>)}
      </g>)}
      {rows.map((row, index) => index === 0 || index === rows.length - 1 || index % Math.ceil(rows.length / 7) === 0 ? <text key={row.date} x={x(index)} y={height - 8} textAnchor="middle">{row.date.slice(5)}</text> : null)}
    </svg>
    <details className="analytics-daily-data"><summary>查看每日数据</summary><div className="analytics-table-scroll"><table><caption>每日访问统计（北京时间）</caption><thead><tr><th>日期</th><th>浏览量</th><th>独立访客</th><th>会话</th></tr></thead><tbody>{rows.map(row => <tr key={row.date}><td>{row.date}</td><td>{number(row.pageViews)}</td><td>{number(row.visitors)}</td><td>{number(row.sessions)}</td></tr>)}</tbody></table></div></details>
  </section>;
}

function Distribution({ title, rows = [], labels = {}, showVisitors = false }) {
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  return <section className="analytics-panel analytics-distribution" aria-label={title}><h2>{title}</h2>
    {rows.length ? <ul>{rows.map(row => <li key={row.key}><div><span>{labels[row.key] || row.key}</span><span><strong>{number(row.count)}</strong><small>{showVisitors && Number.isFinite(row.visitors) ? number(row.visitors) + ' 位访客' : (100 * row.count / total).toFixed(1) + '%'}</small></span></div><div className="analytics-bar" aria-hidden="true"><span style={{ width: 100 * row.count / total + '%' }} /></div></li>)}</ul> : <p className="analytics-muted">暂无数据</p>}
  </section>;
}

function UsageRankings({ actions = [], visitors = [] }) {
  const [sort, setSort] = useState('count');
  const ranked = [...actions].sort((a, b) => (b[sort] || 0) - (a[sort] || 0) || b.count - a.count || a.key.localeCompare(b.key));
  const total = actions.reduce((sum, row) => sum + row.count, 0);
  return <div className="analytics-rankings">
    <section className="analytics-panel" aria-label="功能使用排行">
      <div className="analytics-panel-heading"><h2>功能使用排行</h2><label className="analytics-ranking-sort">排序<select aria-label="功能排行排序" value={sort} onChange={event => setSort(event.target.value)}><option value="count">使用次数</option><option value="visitors">使用访客</option></select></label></div>
      {ranked.length ? <div className="analytics-table-scroll"><table><thead><tr><th>排名</th><th>功能</th><th>使用次数</th><th>使用访客</th><th>次数占比</th></tr></thead><tbody>
        {ranked.map((row, index) => <tr key={row.key}><td>{index + 1}</td><td>{ANALYTICS_ACTIONS[row.key] || row.key}</td><td>{number(row.count)}</td><td>{Number.isFinite(row.visitors) ? number(row.visitors) : '—'}</td><td>{(total ? 100 * row.count / total : 0).toFixed(1)}%</td></tr>)}
      </tbody></table></div> : <p className="analytics-muted">所选时段暂无功能使用记录</p>}
      <p className="analytics-footnote">按操作发生时间统计；使用访客在每项功能内去重，不同功能的访客数不能相加。检测次数表示任务创建成功。</p>
    </section>
    <section className="analytics-panel" aria-label="访客活跃排行"><h2>访客活跃排行 <small>TOP 20</small></h2>
      {visitors.length ? <div className="analytics-table-scroll"><table><thead><tr><th>排名</th><th>匿名访客</th><th>操作次数</th><th>浏览量</th><th>可见停留</th><th>最近活跃（北京时间）</th></tr></thead><tbody>
        {visitors.map((row, index) => <tr key={row.visitorId}><td>{index + 1}</td><td><span title={row.visitorId}>{row.visitorId.slice(0, 8)}</span></td><td>{number(row.actions)}</td><td>{number(row.pageViews)}</td><td>{duration(row.activeMs)}</td><td>{time(row.lastSeenAt)}</td></tr>)}
      </tbody></table></div> : <p className="analytics-muted">所选时段暂无活跃访客</p>}
      <p className="analytics-footnote">按操作次数、浏览量、可见停留依次排序；按匿名访客标识合并会话，同一 IP 下的不同访客不合并。浏览量与停留按访问开始时间归属。</p>
    </section>
  </div>;
}

function ReferenceUsage({ data, labels }) {
  const names = new Map((labels.data?.apps || []).flatMap(app => app.plans.map(plan => [app.id + ':' + plan.id, plan.name])));
  function identity(planId) { try { return JSON.parse(planId); } catch { return []; } }
  function periodLabel(period, kind) {
    if (kind === 'purchase') return '一次性';
    if (!period) return '未注明';
    const match = /^P([1-9][0-9]*)([DWMY])$/.exec(period);
    if (!match) return period;
    return '每' + (match[1] === '1' ? '' : match[1]) + ({ D: '天', W: '周', M: match[1] === '1' ? '月' : '个月', Y: '年' }[match[2]]);
  }
  return <section className="analytics-reference" aria-label="官网正价参考使用情况">
    <h2>官网正价参考</h2>
    <div className="analytics-reference-totals">{[['打开次数', data.opens], ['使用访客', data.visitors]].map(([label, count]) =>
      <article className="analytics-metric" key={label} aria-label={label}><span>{label}</span><strong>{number(count)}</strong></article>)}
    </div>
    <div className="analytics-reference-breakdowns">
      <Distribution title="产品切换排行" rows={data.products} labels={referenceApps} showVisitors />
      <section className="analytics-panel" aria-label="套餐选择排行"><h2>套餐选择排行</h2>
        {data.plans.length ? <div className="analytics-table-scroll"><table><thead><tr><th>产品</th><th>套餐</th><th>周期 / SKU</th><th>选择次数</th><th>独立访客</th></tr></thead>
          <tbody>{data.plans.map(row => { const [sku, kind, period] = identity(row.planId); return <tr key={row.appId + ':' + row.planId}>
            <td>{referenceApps[row.appId] || row.appId}</td><td>{names.get(row.appId + ':' + row.planId) || 'SKU ' + (sku || row.planId)}</td>
            <td>{periodLabel(period, kind)}<small>{sku}</small></td><td>{number(row.count)}</td><td>{number(row.visitors)}</td>
          </tr>; })}</tbody></table></div> : <p className="analytics-muted">暂无套餐选择记录</p>}
        {labels.error && <p className="analytics-muted">套餐名称暂不可用，仍可按 SKU 查看统计。</p>}
      </section>
    </div>
    <p className="analytics-footnote">使用访客按打开工具的匿名访客去重，合并比价页和检测工具页；排行只计主动切换，默认选中和重复选择当前项不计。套餐展示前 20 项，名称取当前已发布目录，历史已下架套餐保留 SKU。</p>
  </section>;
}

function ExcludedIps({ resource, onChange }) {
  const [ip, setIp] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const { data, loading } = resource;
  const ips = data?.ips ?? [];
  const currentIp = data?.currentIp;
  const currentExcluded = currentIp && ips.includes(currentIp);
  const busy = pending || loading || !data || Boolean(resource.error);
  async function change(method, suffix = '', body) {
    if (busy) return;
    setPending(true); setError(''); setMessage('');
    try {
      await requestJson('/api/admin/analytics/excluded-ips' + suffix, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (body) setIp('');
      setMessage(method === 'DELETE' ? '已移除排除 IP' : '已添加排除 IP');
      onChange();
    } catch (error) { setError(error.message); }
    finally { setPending(false); }
  }
  return <section className="analytics-panel analytics-exclusions" aria-label="排除 IP" aria-busy={pending || loading}>
    <div className="analytics-panel-heading"><h2>排除 IP</h2><span className="analytics-exclusion-count">{loading ? '读取名单中' : data ? ips.length + ' 个已排除' : '名单暂不可用'}</span></div>
    <p className="analytics-footnote">排除自己的访问和测试流量，保存后自动刷新全部统计与历史明细。移除后恢复计入，原始记录不会删除。</p>
    <form className="analytics-exclusion-form" onSubmit={event => { event.preventDefault(); void change('POST', '', { ip: ip.trim() }); }}>
      <label>要排除的 IP<input value={ip} onChange={event => setIp(event.target.value)} placeholder="输入 IPv4 或 IPv6 地址" maxLength={64} required autoComplete="off" spellCheck={false} disabled={busy} /></label>
      <button type="submit" className="outline-button" disabled={busy || !ip.trim()}>添加排除</button>
      <button type="button" className="outline-button" onClick={() => void change('POST', '/current')} disabled={busy || !currentIp || currentExcluded}>{currentExcluded ? '当前 IP 已排除' : '排除当前 IP'}</button>
    </form>
    {data && <p className="analytics-exclusion-current">{currentIp ? '当前 IP：' + currentIp : '无法识别当前 IP，请手动添加'}<span>由服务端识别；代理或共享网络下，排除的是整个出口 IP。</span></p>}
    {error && <p className="analytics-error" role="alert">{error}</p>}
    {message && <p className="analytics-exclusion-status" role="status">{message}</p>}
    {loading ? <p role="status" className="analytics-muted">正在加载排除 IP…</p> : data ? ips.length ? <ul className="analytics-exclusion-list">
      {ips.map(address => <li key={address}><code>{address}</code><button type="button" aria-label={'移除 ' + address} onClick={() => void change('DELETE', '/' + encodeURIComponent(address))} disabled={busy}>移除</button></li>)}
    </ul> : <p className="analytics-muted">暂无排除 IP</p> : <p className="analytics-muted">排除名单暂不可用，请重试。</p>}
  </section>;
}

export default function VisitorAnalytics() {
  const [{ days, page }, setFilter] = useState({ days: 7, page: 1 });
  const [revision, setRevision] = useState(0);
  const summary = useAnalyticsResource('/api/admin/analytics/summary?days=' + days, revision);
  const visits = useAnalyticsResource('/api/admin/analytics/visits?days=' + days + '&page=' + page + '&limit=20', revision);
  const exclusions = useAnalyticsResource('/api/admin/analytics/excluded-ips', revision);
  const referenceLabels = useAnalyticsResource(summary.data?.reference?.plans?.length ? '/api/official-reference/catalog' : null, revision);
  const data = summary.data; const error = summary.error || visits.error || exclusions.error;
  const metrics = data ? [
    ['浏览量 PV', number(data.overview.pageViews), '页面访问次数'],
    ['独立访客 UV', number(data.overview.visitors), '按匿名浏览器标识去重'],
    ['访问会话', number(data.overview.sessions), '30 分钟无操作后新建会话'],
    ['平均页面停留', duration(data.overview.avgActiveMs), '仅计可见且未闲置的时间'],
    ['功能使用次数', number(data.overview.actions), '搜索、跳转和检测等操作'],
  ] : [];
  return <section className="admin-section active-section visitor-analytics">
    <header className="analytics-header"><div><p className="eyebrow">CONSUMER ANALYTICS</p><h1>访问统计</h1><p>了解访客从哪里进入、浏览哪些页面、使用哪些功能。</p></div><div className="analytics-controls"><label>统计范围<select aria-label="统计范围" value={days} onChange={event => setFilter({ days: Number(event.target.value), page: 1 })}><option value="1">今天</option><option value="7">最近 7 天</option><option value="30">最近 30 天</option><option value="90">最近 90 天</option></select></label><button type="button" className="outline-button" onClick={() => setRevision(value => value + 1)} disabled={summary.loading || visits.loading}>刷新</button></div></header>
    {error ? <div className="analytics-error" role="alert"><span>{error}</span><button type="button" onClick={() => setRevision(value => value + 1)}>重试</button></div> : null}
    <div className="analytics-content admin-scroll-area" aria-busy={summary.loading || visits.loading}>
      <ExcludedIps resource={exclusions} onChange={() => { setFilter(value => ({ ...value, page: 1 })); setRevision(value => value + 1); }} />
      {summary.loading ? <p role="status">正在加载访问统计…</p> : null}
      {data ? <>
        <div className="analytics-metrics">{metrics.map(([label, value, hint]) => <article className="analytics-metric" key={label} aria-label={label}><span>{label}</span><strong>{value}</strong><small>{hint}</small></article>)}</div>
        <TrendChart rows={data.trend} />
        <UsageRankings actions={data.actions} visitors={data.visitorRanking} />
        <div className="analytics-distributions"><Distribution title="页面访问分布" rows={data.pages} labels={ANALYTICS_PAGES} /><Distribution title="设备分布" rows={data.devices} labels={ANALYTICS_DEVICES} /><Distribution title="浏览器分布" rows={data.browsers} labels={ANALYTICS_BROWSERS} /><Distribution title="访问来源" rows={data.sources} labels={ANALYTICS_SOURCES} /></div>
        {data.reference && <ReferenceUsage data={data.reference} labels={referenceLabels} />}
        <section aria-label="IP 归属地统计" className="analytics-geography"><h2>IP 归属地统计</h2><p className="analytics-geography-note">按页面访问次数统计；各维度展示前 9 项，其余合并为“其他”。已有 IP 的失败记录可由近期成功缓存补充；仍无法解析、内网或未记录 IP 的归属地计入“未知”。</p><div className="analytics-distributions"><Distribution title="国家 / 地区分布" rows={data.countries} /><Distribution title="省份分布" rows={data.regions} /><Distribution title="城市分布" rows={data.cities} /><Distribution title="运营商分布" rows={data.isps} /></div></section>
      </> : null}
      <section className="analytics-panel analytics-records"><h2>访问明细</h2>
        {visits.loading ? <p role="status">正在加载访问记录…</p> : visits.data ? visits.data.items.length ? <><div className="analytics-table-scroll"><table><thead><tr><th>访问时间（北京时间）</th><th>匿名访客 / 会话</th><th>访客 IP</th><th>IP 归属地</th><th>运营商</th><th>页面</th><th>设备 / 浏览器</th><th>来源</th><th>可见停留</th><th>操作次数</th></tr></thead><tbody>{visits.data.items.map(item => <tr key={item.id}><td>{time(item.startedAt)}</td><td><span title={item.visitorId}>{item.visitorId.slice(0, 8)}</span><small title={item.sessionId}>{item.sessionId.slice(0, 8)}</small></td><td className="analytics-ip">{item.ip || "未记录 IP"}</td><td className="analytics-location">{location(item)}{item.geoFromCache && <small title="按同 IP 最近一次成功解析补充，不代表访问当时的归属地">IP 缓存补充</small>}</td><td className="analytics-isp">{item.isp || "未知运营商"}</td><td>{ANALYTICS_PAGES[item.page]}</td><td>{ANALYTICS_DEVICES[item.device]}<small>{ANALYTICS_BROWSERS[item.browser]}</small></td><td>{ANALYTICS_SOURCES[item.source]}</td><td>{duration(item.activeMs)}</td><td>{number(item.actions)}</td></tr>)}</tbody></table></div><Pagination label="访问明细" total={visits.data.total} page={visits.data.page} pageSize={visits.data.pageSize} onChange={next => setFilter({ days, page: next })} /></> : <p className="analytics-muted">所选时段暂无访问记录</p> : null}
      </section>
      <p className="analytics-footnote">按北京时间统计，时段包含今天；UV 和会话在整个时段内去重。匿名标识不等于实名人数，清理浏览器数据或更换设备会产生新访客。停留时间每 30 秒及离开页面时更新，断网或拦截上报可能造成少计。服务端记录访问时的 IP 及归属地，仅管理员可见。IP 归属地反映网络出口，使用代理时可能显示代理地区，不代表精确位置。历史记录无法补回 IP。不采集搜索内容、检测凭据或完整 URL。</p>
    </div>
  </section>;
}
