import React, { useEffect, useRef, useState } from 'react';
import Brand from './Brand.jsx';
import ModalDialog from './components/ModalDialog.jsx';
import { usePageAnalytics } from './usePageAnalytics.js';
import { trackUsage } from './analytics.js';
import { isQualityTerminal, qualityApi } from './quality-api.js';
import { parseQualityIp, validQualityUrl } from './quality-input.js';
import { useQualityTask } from './quality-task.js';
import { useQualityModels } from './quality-models.js';
import { Report, TaskProgress, StatusPill } from './QualityReport.jsx';

const MODE_LABELS = { quick: '快速', standard: '标准', full: '完整' };
const TOOL_LABELS = { ai: 'AI检测', ip: 'IP检测' };
const TASK_PHASE_LABELS = { creating: '创建中', running: '检测中', cancelling: '取消中', disconnected: '已断连' };
const FAILURE_LABELS = { mismatch: '不匹配', 'invalid-response': '无效响应', timeout: '超时', 'request-error': '请求错误', pass: '通过' };
const required = item => item.required || ['connectivity', 'streaming'].includes(item.id);
const selectionFor = (catalog, mode) => new Set(catalog.filter(item => required(item) || item.modes?.includes(mode)).map(item => item.id));

function ProjectDrawer({ catalog, selected, onClose, onApply }) {
  const [draft, setDraft] = useState(() => new Set(selected));
  const groups = [...new Set(catalog.map(item => item.group))];
  return <ModalDialog open className="quality-drawer quality-modal-drawer" aria-labelledby="quality-project-title" onClose={onClose}>
    <div className="quality-drawer-header"><div><span className="quality-kicker">检测范围</span><h2 id="quality-project-title">选择检测项目</h2></div><button type="button" className="quality-icon-button" aria-label="关闭检测项目" onClick={onClose}>×</button></div>
    <div className="quality-drawer-body">{groups.map(group => <fieldset className="quality-project-group" key={group}><legend><strong>{group}</strong></legend>{catalog.filter(item => item.group === group).map(item => <label className={'quality-project-option ' + (draft.has(item.id) ? 'is-selected' : '')} key={item.id}><input type="checkbox" checked={draft.has(item.id)} disabled={required(item)} onChange={() => setDraft(current => { const next = new Set(current); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next; })} /><span>{item.label}</span>{required(item) ? <small>必选</small> : item.modes?.length === 1 && item.modes[0] === 'full' ? <small>完整模式</small> : null}</label>)}</fieldset>)}</div>
    <div className="quality-drawer-footer"><span>{draft.size} 项已选择</span><button type="button" className="quality-primary-button" onClick={() => { onApply(draft); onClose(); }}>应用设置</button></div>
  </ModalDialog>;
}
function TaskResult({ task, kind, onOpen, onRetestRisk }) {
  if (task.active || task.report && !isQualityTerminal(task.report.state)) return <TaskProgress task={task} kind={kind} />;
  if (task.report) return <Report report={task.report} onOpen={onOpen} onRetestRisk={onRetestRisk} />;
  return <section className="quality-empty"><h2>等待检测</h2><p>{kind === 'ai' ? '填写配置并开始检测，结果将在此展示。' : '输入地址并开始检测，结果将在此展示。'}</p></section>;
}
function Detail({ item, kind, onClose, onRetest, onFull, onProxy, onInclude }) {
  const attempts = item.evidence?.attempts;
  const measurements = item.evidence?.measurements;
  const baselineSampling = item.id === 'fingerprint-match';
  return <ModalDialog open className="quality-detail quality-modal-detail" aria-labelledby="quality-detail-title" onClose={onClose}>
    <button type="button" className="quality-icon-button quality-detail-close" aria-label="关闭检测详情" onClick={onClose}>×</button><span className="quality-kicker">检测详情</span><h2 id="quality-detail-title">{item.label}</h2><StatusPill status={item.status} /><p>{item.summary}</p>
    {item.impact ? <p>影响：{item.impact}</p> : null}
    {item.id === 'model-identity' ? <p>模型名称一致仅表示接口返回的名称匹配，模型来源未验证。</p> : null}
    {item.reason ? <p className="quality-detail-note">{item.reason === 'not-selected' ? '未选择检测，可加入本次配置后新建报告。' : item.reason === 'insufficient-samples' ? '请选择 3 次或 5 次后重新测试此项。' : baselineSampling ? '内置指纹库尚未覆盖目标模型。' : '暂不支持此能力，请查看模型能力说明或选择支持的模型后新建检测。'}</p> : null}
    {attempts ? <section className="quality-evidence" aria-label={baselineSampling ? '基准采样请求证据' : '检测轮次证据'}><strong>{baselineSampling ? '有效响应' : '通过'} {attempts.filter(attempt => attempt.outcome === 'pass').length} 次 / 共 {attempts.length} 次{baselineSampling ? '采样请求' : ''}</strong><ul>{attempts.map(attempt => <li key={attempt.run}>第 {attempt.run} {baselineSampling ? '次请求' : '轮'}：{baselineSampling && attempt.outcome === 'pass' ? '有效响应' : FAILURE_LABELS[attempt.outcome]}</li>)}</ul>{baselineSampling ? <p>采样成功仅表示取得有效响应，不代表与基准一致；一致性结论以本项评分和摘要为准。</p> : null}</section> : null}
    {measurements ? <section className="quality-evidence" aria-label="测速实测与阈值"><strong>测速实测 / 阈值</strong>{measurements.map(measurement => <p key={measurement.run}>第 {measurement.run} 轮：首 token {measurement.firstTokenMs === null ? '未取得' : measurement.firstTokenMs + ' ms'}（≤ 5000 ms）；总耗时 {measurement.responseMs} ms（≤ 30000 ms）；速度 {measurement.tokensPerSecond === null ? '未取得' : measurement.tokensPerSecond + ' token/s'}（≥ 5 token/s）</p>)}<p>未取得的数值不记作 0；轮次与实测仅包含服务端已验证的观测。</p></section> : null}
    {item.reason === 'unsupported' ? null : item.reason === 'not-selected' ? <button type="button" className="quality-secondary-button" onClick={onInclude}>加入检测</button> : item.status === 'unavailable' ? <button type="button" className="quality-secondary-button" onClick={onProxy}>改用 SOCKS5 地址</button> : <button type="button" className="quality-primary-button" onClick={onRetest}>重新测试此项</button>}
    {kind === 'ai' && ['unrun', 'cancelled'].includes(item.status) && !['unsupported', 'insufficient-samples'].includes(item.reason) ? <button type="button" className="quality-secondary-button" onClick={onFull}>加入完整检测后重跑</button> : null}
  </ModalDialog>;
}
function TaskActions({ task, retestIds, riskRetest = false, available = true, onReset }) {
  if (task.active) return <>{task.disconnected ? <><button type="button" className="quality-secondary-button" onClick={task.reconnect}>重新连接</button><button type="button" className="quality-secondary-button" onClick={() => { task.reset(); onReset?.(); }}>重新配置</button></> : null}<button type="button" className="quality-danger-button" onClick={task.cancel} disabled={task.phase === 'creating' || task.phase === 'cancelling'}>{task.phase === 'cancelling' ? '正在取消' : '取消检测'}</button></>;
  return <button type="submit" className="quality-primary-button" disabled={!available}>{retestIds?.length ? (riskRetest ? '开始风险重测' : '开始单项重测') : '开始检测'}</button>;
}
const INITIAL_AI_FORM = { endpoint: '', apiKey: '', model: '', mode: 'standard', runs: '3' };
function AITool({ catalog, visible, onPhaseChange }) {
  const [form, setForm] = useState(INITIAL_AI_FORM);
  const [selected, setSelected] = useState(() => selectionFor(catalog, 'standard'));
  const [custom, setCustom] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [focusedId, setFocusedId] = useState(null);
  const [retestIds, setRetestIds] = useState([]);
  const [riskRetest, setRiskRetest] = useState(false);
  const [notice, setNotice] = useState('');
  const safeConfig = useRef(null);
  const keyInput = useRef(null);
  const task = useQualityTask();
  useEffect(() => { onPhaseChange(task.phase); }, [onPhaseChange, task.phase]);
  const models = useQualityModels(form.endpoint, form.apiKey, task.active || !visible);
  const focused = task.report?.items.find(item => item.id === focusedId);
  function change(key, value) { setForm(current => ({ ...current, [key]: value })); task.setError(''); }
  function run(event) {
    event.preventDefault();
    if (!form.endpoint.trim()) return task.setError('请填写被测 Base URL');
    if (!validQualityUrl(form.endpoint.trim())) return task.setError('请填写有效且不含账号、密码、查询参数的 HTTP(S) Base URL');
    if (!form.apiKey.trim()) return task.setError('请填写本次检测使用的 API Key');
    if (!form.model.trim()) return task.setError('请填写目标模型');
    if (retestIds.length && safeConfig.current && (form.endpoint.trim().replace(/\/+$/, '') !== safeConfig.current.endpoint.trim().replace(/\/+$/, '') || form.model.trim() !== safeConfig.current.model.trim())) return task.setError('单项重测需保持原检测目标与模型；更换目标请退出单项重测。');
    const input = { kind: 'ai', endpoint: form.endpoint.trim(), apiKey: form.apiKey.trim(), model: form.model.trim(), mode: form.mode, runs: Number(form.runs), items: [...new Set([...selected, ...catalog.filter(required).map(item => item.id)])] };
    // Keep only non-secret configuration to restore the original target for a retest.
    const config = { ...form, selected: [...selected], apiKey: '' };
    setForm(current => ({ ...current, apiKey: '' }));
    setNotice(''); setFocusedId(null);
    void task.start(input, retestIds, () => { safeConfig.current = config; trackUsage('ai_test'); });
  }
  function prepare(itemIdOrIds, full = false, include = false, asRisk = false) {
    const ids = Array.isArray(itemIdOrIds) ? itemIdOrIds : itemIdOrIds ? [itemIdOrIds] : [];
    setFocusedId(null); setRetestIds(full || include ? [] : ids); setRiskRetest(asRisk);
    if (safeConfig.current) {
      const { selected: savedSelection, ...savedForm } = safeConfig.current;
      setForm({ ...savedForm, ...(full ? { mode: 'full' } : {}), apiKey: '' });
      setSelected(new Set(savedSelection));
      const defaults = selectionFor(catalog, savedForm.mode);
      setCustom(savedSelection.length !== defaults.size || savedSelection.some(id => !defaults.has(id)));
    }
    if (full) { setSelected(selectionFor(catalog, 'full')); setCustom(false); }
    if (include) { setSelected(current => new Set([...current, ...ids])); setCustom(true); }
    setNotice(full ? '已加入完整检测。请重新填写凭据后开始检测。' : include ? '已加入检测项目，请重新填写凭据后开始检测。' : asRisk ? '风险项重测保留其他结果。请重新填写本次检测凭据。' : '单项重测保留其他结果。请重新填写本次检测凭据。');
    queueMicrotask(() => keyInput.current?.focus());
  }
  const field = (label, key, options = {}) => <label>{label}<input value={form[key]} onChange={event => change(key, event.target.value)} disabled={task.active} maxLength={key.includes('Key') || key === 'apiKey' ? 4096 : 2048} {...options} /></label>;
  const showStabilityHint = form.runs === '1' && (retestIds.length ? retestIds.includes('stability') : selected.has('stability'));
  return <div className="quality-workbench"><form className="quality-config-panel quality-ai-config" onSubmit={run} noValidate>
    <div className="quality-config-notes">
      <div className="quality-model-help">
        <p id="quality-ai-model-status" className="quality-field-hint" aria-live="polite">{models.phase === 'loading' ? '正在获取模型列表…' : models.phase === 'error' ? '获取失败，可手动输入模型' : models.phase === 'ready' ? models.models.length ? '已获取 ' + models.models.length + ' 个模型' : '未返回模型，可手动输入' : '填写地址和 Key 后自动获取模型列表'}</p>
        {models.phase === 'error' || models.phase === 'ready' && !models.models.length ? <button type="button" className="quality-model-retry" aria-label="重新获取模型列表" onClick={models.retry} disabled={task.active}>重试</button> : null}
      </div>
      {showStabilityHint ? <p id="quality-ai-runs-hint" className="quality-field-hint quality-field-warning">仅检测 1 次，无法评价请求稳定性。</p> : null}
    </div>
    <div className="quality-config-grid">
      {field('被测 Base URL', 'endpoint', { placeholder: 'https://api.example.com/v1' })}{field('API Key', 'apiKey', { type: 'password', autoComplete: 'off', ref: keyInput, placeholder: '仅用于本次检测' })}
      <div className="quality-model-field">
        {field('目标模型', 'model', { placeholder: '选择或输入模型 ID', list: 'quality-ai-model-options', 'aria-describedby': 'quality-ai-model-status' })}
        <datalist id="quality-ai-model-options">{models.models.map(id => <option key={id} value={id} />)}</datalist>
      </div>
      <label>检测档位<select value={form.mode} disabled={task.active} onChange={event => { change('mode', event.target.value); setSelected(selectionFor(catalog, event.target.value)); setCustom(false); setRetestIds([]); setRiskRetest(false); setNotice(''); }}><option value="quick">快速</option><option value="standard">标准</option><option value="full">完整</option></select></label>
      <label>检测次数<select value={form.runs} disabled={task.active} aria-describedby={showStabilityHint ? 'quality-ai-runs-hint' : undefined} onChange={event => change('runs', event.target.value)}><option value="1">1 次</option><option value="3">3 次</option><option value="5">5 次</option></select></label>
    </div>
    <div className="quality-config-actions"><span>{retestIds.length ? riskRetest ? '风险重测' : '单项重测' : custom ? '自定义检测' : MODE_LABELS[form.mode] + '检测'} · {retestIds.length || selected.size} 项检测</span><button type="button" className="quality-secondary-button" disabled={task.active || !catalog.length} onClick={() => setDrawerOpen(true)}>展开检测项目</button><TaskActions task={task} retestIds={retestIds} riskRetest={riskRetest} onReset={() => { setRetestIds([]); setRiskRetest(false); setNotice(''); }} available={catalog.length > 0} /></div>
    {task.error ? <p className="quality-form-error" role="alert">{task.error}</p> : null}{notice ? <p className="quality-task-note" role="status">{notice}</p> : null}{retestIds.length && !task.active ? <button type="button" className="quality-text-button" onClick={() => { setRetestIds([]); setRiskRetest(false); setNotice(''); }}>{riskRetest ? '退出风险重测' : '退出单项重测'}</button> : null}
  </form><TaskResult task={task} kind="ai" onOpen={setFocusedId} onRetestRisk={() => prepare(task.report?.items.filter(item => item.status === 'risk').map(item => item.id) || [], false, false, true)} />{visible && drawerOpen ? <ProjectDrawer catalog={catalog} selected={selected} onClose={() => setDrawerOpen(false)} onApply={value => { setSelected(value); setCustom(true); setRetestIds([]); setRiskRetest(false); setNotice(''); }} /> : null}{visible && focused && !task.active ? <Detail item={focused} kind="ai" onClose={() => setFocusedId(null)} onRetest={() => prepare(focused.id)} onInclude={() => prepare(focused.id, false, true)} onFull={() => prepare(focused.id, true)} /> : null}</div>;
}
function IpTool({ visible, onPhaseChange }) {
  const [target, setTarget] = useState('');
  const [focusedId, setFocusedId] = useState(null);
  const [retestIds, setRetestIds] = useState([]);
  const [riskRetest, setRiskRetest] = useState(false);
  const [notice, setNotice] = useState('');
  const inputRef = useRef(null);
  const originalIp = useRef('');
  const task = useQualityTask();
  useEffect(() => { onPhaseChange(task.phase); }, [onPhaseChange, task.phase]);
  const parsed = parseQualityIp(target);
  const focused = task.report?.items.find(item => item.id === focusedId);
  function run(event) {
    event.preventDefault();
    if (!parsed) return task.setError('请输入有效的 IP 地址或 SOCKS5 地址');
    const input = { kind: 'ip', target: target.trim(), runs: 3 };
    const plainIp = parsed.type === 'socks' ? '' : target.trim();
    if (parsed.type === 'socks') setTarget('');
    setNotice(''); setFocusedId(null);
    void task.start(input, retestIds, () => { originalIp.current = plainIp; trackUsage('ip_test'); });
  }
  function prepare(itemIdOrIds, asRisk = false) {
    const ids = Array.isArray(itemIdOrIds) ? itemIdOrIds : itemIdOrIds ? [itemIdOrIds] : [];
    setFocusedId(null); setRetestIds(ids); setRiskRetest(asRisk); setTarget(ids.length ? originalIp.current : '');
    setNotice(ids.length ? (asRisk ? '风险项重测' : '单项重测') + '保留其他结果。SOCKS5 请重新填写完整地址与凭据。' : '请填写 SOCKS5 地址后开始新检测。');
    queueMicrotask(() => inputRef.current?.focus());
  }
  return <div className="quality-workbench">
    <form className="quality-config-panel ip-config-panel" onSubmit={run} noValidate>
      <div className="ip-config-row">
        <label>IP 地址或 SOCKS5 地址<input ref={inputRef} value={target} type="text" autoComplete="off" spellCheck={false} maxLength={2048} disabled={task.active} aria-describedby="ip-target-hint" onChange={event => { setTarget(event.target.value); task.setError(''); }} placeholder="1.2.3.4 或 socks5://user:password@host:port" /></label>
        <div className="quality-config-actions"><TaskActions task={task} retestIds={retestIds} riskRetest={riskRetest} onReset={() => { setRetestIds([]); setRiskRetest(false); setNotice(''); }} /></div>
      </div>
      <div className="ip-target-hint" id="ip-target-hint">
        <span>{parsed ? <><span className="quality-live-dot" />已识别：{parsed.label}</> : '支持 IPv4、IPv6 和 socks5:// 地址'}</span>
        <span>{parsed?.type === 'socks' ? '可执行完整线路检测' : '普通 IP 检测信息与风险，SOCKS5 可检测出口线路'}</span>
      </div>
      {task.error ? <p className="quality-form-error" role="alert">{task.error}</p> : null}
      {notice ? <p className="quality-task-note" role="status">{notice}</p> : null}
      {retestIds.length && !task.active ? <button type="button" className="quality-text-button" onClick={() => { setRetestIds([]); setRiskRetest(false); setNotice(''); }}>{riskRetest ? '退出风险重测' : '退出单项重测'}</button> : null}
    </form>
    <TaskResult task={task} kind="ip" onOpen={setFocusedId} onRetestRisk={() => prepare(task.report.items.filter(item => item.status === 'risk').map(item => item.id), true)} />
    {visible && focused && !task.active ? <Detail item={focused} kind="ip" onClose={() => setFocusedId(null)} onRetest={() => prepare(focused.id)} onProxy={() => prepare(null)} /> : null}
  </div>;
}

export default function QualityToolsPage() {
  const [tool, setTool] = useState('ai');
  const [aiPhase, setAiPhase] = useState('idle');
  const [ipPhase, setIpPhase] = useState('idle');
  const phases = { ai: aiPhase, ip: ipPhase };
  usePageAnalytics(tool === 'ai' ? 'tools_ai' : 'tools_ip');
  const [catalog, setCatalog] = useState(null);
  const [catalogError, setCatalogError] = useState('');
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  useEffect(() => { document.title = '知途 · 拾价 · ' + TOOL_LABELS[tool]; }, [tool]);
  useEffect(() => {
    const controller = new AbortController();
    setCatalogError('');
    qualityApi.catalog(controller.signal).then(value => {
      if (!Array.isArray(value?.ai) || !Array.isArray(value?.ip) || !value.ai.length || !value.ip.length || [...value.ai, ...value.ip].some(item => typeof item.id !== 'string' || typeof item.label !== 'string' || typeof item.group !== 'string')) throw new Error('检测项目加载失败，请重试。');
      if (!controller.signal.aborted) setCatalog(value);
    }).catch(error => { if (!controller.signal.aborted) setCatalogError(error.message); });
    return () => controller.abort();
  }, [catalogAttempt]);
  return <main className="quality-page">
    <header className="quality-header"><div className="brand-block"><Brand /><p className="brand-disclaimer">检测结果仅供参考</p></div><nav aria-label="检测工具导航"><a href="/">首页</a><a className="is-active" href="/tools" aria-current="page">检测工具</a></nav></header>
    <div className="quality-scroll">
      <h1 className="quality-sr-only">{TOOL_LABELS[tool]}</h1>
      <div className="quality-toolbar">
        <div className="quality-tool-switcher" role="tablist" aria-label="检测工具类型">
          {['ai', 'ip'].map((kind, index) => <button key={kind} type="button" role="tab" id={'quality-tab-' + kind} aria-label={TOOL_LABELS[kind]} aria-controls={'quality-tool-panel-' + kind} aria-describedby={phases[kind] !== 'idle' ? 'quality-task-state-' + kind : undefined} tabIndex={tool === kind ? 0 : -1} aria-selected={tool === kind} className={tool === kind ? 'is-active' : ''} onClick={() => setTool(kind)} onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 'ai' : event.key === 'End' ? 'ip' : index === 0 ? 'ip' : 'ai'; setTool(next); document.getElementById('quality-tab-' + next)?.focus(); } }}>{TOOL_LABELS[kind]}{phases[kind] !== 'idle' ? <><span aria-hidden="true"> · </span><small id={'quality-task-state-' + kind}>{TASK_PHASE_LABELS[phases[kind]]}</small></> : null}</button>)}
        </div>
      </div>
      {['ai', 'ip'].map(kind => <div key={kind} role="tabpanel" id={'quality-tool-panel-' + kind} aria-labelledby={'quality-tab-' + kind} tabIndex={0} hidden={tool !== kind} inert={tool !== kind}>
        {catalog ? kind === 'ai' ? <AITool catalog={catalog.ai} visible={tool === kind} onPhaseChange={setAiPhase} /> : <IpTool visible={tool === kind} onPhaseChange={setIpPhase} /> : tool === kind ? <section className="quality-empty">{catalogError ? <><p role="alert">{catalogError}</p><button type="button" className="quality-secondary-button" onClick={() => setCatalogAttempt(current => current + 1)}>重新加载检测项目</button></> : <p role="status">正在加载检测项目…</p>}</section> : null}
      </div>)}
    </div>
  </main>;
}
