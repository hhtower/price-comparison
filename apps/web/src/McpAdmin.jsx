import React, { useCallback, useEffect, useRef, useState } from 'react';
import { formatTime, requestJson } from './api.js';
import { EmptyState, Pagination } from './components/AdminControls.jsx';
import ModalDialog from './components/ModalDialog.jsx';
import './mcp.css';
import './mcp-admin.css';

const STATUSES = { unverified: '待验证', pending: '待审核', approved: '已通过', rejected: '已拒绝' };
const KEY_STATUSES = { active: '有效', revoked: '已撤销', expired: '已过期', unclaimed: '待领取' };
const ACTIONS = { approve: '申请已通过，已尝试发送领取通知。', reject: '申请已拒绝。', resend: '已尝试重发通知，请检查通知状态。', revoke: '密钥已撤销。', reissue: '已重新发放，请用户领取新密钥；请检查通知状态。' };

export default function McpAdmin() {
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ items: [], total: 0 });
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const selected = data.items.find(item => item.id === selectedId);
  const [apiKey, setApiKey] = useState('');
  const [keyLoading, setKeyLoading] = useState(false);
  const [keyError, setKeyError] = useState('');
  const [keyMessage, setKeyMessage] = useState('');
  const revealController = useRef(null);
  const detailVersion = useRef(0);
  const mounted = useRef(true);
  const clearSecret = useCallback(() => {
    revealController.current?.abort();
    revealController.current = null;
    setApiKey(''); setKeyLoading(false); setKeyError(''); setKeyMessage('');
  }, []);
  const selectRow = useCallback(id => {
    detailVersion.current += 1;
    clearSecret();
    setSelectedId(id); setError(''); setMessage('');
  }, [clearSecret]);
  const closeDetails = useCallback(() => selectRow(null), [selectRow]);
  useEffect(() => {
    mounted.current = true;
    window.addEventListener('pagehide', closeDetails);
    return () => {
      mounted.current = false;
      detailVersion.current += 1;
      revealController.current?.abort();
      window.removeEventListener('pagehide', closeDetails);
    };
  }, [closeDetails]);
  useEffect(() => {
    if (selectedId !== null && !selected) closeDetails();
  }, [selectedId, selected, closeDetails]);
  useEffect(() => { clearSecret(); }, [selected?.key, clearSecret]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    requestJson(`/api/admin/mcp/applications?page=${page}&pageSize=10${status ? '&status=' + status : ''}`, { signal: controller.signal, cache: 'no-store' })
      .then(result => {
        if (controller.signal.aborted) return;
        if (page > 1 && !result.items.length) { closeDetails(); setPage(Math.max(1, Math.ceil(result.total / 10))); return; }
        setData(result);
      })
      .catch(error => { if (!controller.signal.aborted) setError(error.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [page, status, reload, closeDetails]);

  const revealKey = async () => {
    if (!selected?.key?.canReveal || busy || loading || keyLoading) return;
    clearSecret();
    const controller = new AbortController();
    revealController.current = controller;
    setKeyLoading(true);
    try {
      const result = await requestJson(`/api/admin/mcp/applications/${encodeURIComponent(selected.id)}/key`, { signal: controller.signal, cache: 'no-store' });
      if (controller.signal.aborted || revealController.current !== controller) return;
      if (typeof result?.apiKey !== 'string' || !result.apiKey.trim()) throw new Error('未能读取完整密钥，请重试。');
      setApiKey(result.apiKey);
    } catch (error) {
      if (!controller.signal.aborted && revealController.current === controller) setKeyError(error.message);
    } finally {
      if (!controller.signal.aborted && revealController.current === controller) setKeyLoading(false);
    }
  };
  const copyKey = async () => {
    const controller = revealController.current;
    try {
      await navigator.clipboard.writeText(apiKey);
      if (controller && !controller.signal.aborted && revealController.current === controller) {
        setKeyError(''); setKeyMessage('密钥已复制。');
      }
    } catch {
      if (controller && !controller.signal.aborted && revealController.current === controller) setKeyError('复制失败，请手动复制密钥。');
    }
  };
  const mutate = async (id, action, body = {}) => {
    if (busy) return;
    if (action === 'revoke' && !window.confirm('撤销后当前密钥立即失效，确认撤销？')) return;
    if (action === 'reissue' && !window.confirm('重新发放会立即使当前密钥失效，并发送新的领取邮件，确认继续？')) return;
    if (action === 'revoke' || action === 'reissue') clearSecret();
    const version = detailVersion.current;
    setBusy(true); setMessage(''); setError('');
    try {
      await requestJson(`/api/admin/mcp/applications/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: JSON.stringify(body) });
      if (!mounted.current) return;
      if (version === detailVersion.current) setMessage(ACTIONS[action]);
      setLoading(true); setReload(value => value + 1);
    } catch (error) {
      if (mounted.current && version === detailVersion.current) setError(error.message);
    } finally { if (mounted.current) setBusy(false); }
  };
  const review = (event, id) => {
    event.preventDefault();
    const action = event.nativeEvent.submitter.value;
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const body = { reviewNote: values.reviewNote };
    if (action === 'reject' && !body.reviewNote.trim()) {
      setError('请填写拒绝原因后再拒绝申请。'); return;
    }
    if (action !== 'reject') {
      body.expiresInDays = Number(values.expiresInDays);
      body.requestsPerMinute = Number(values.requestsPerMinute);
      if (!Number.isInteger(body.expiresInDays) || body.expiresInDays < 1 || body.expiresInDays > 365
        || !Number.isInteger(body.requestsPerMinute) || body.requestsPerMinute < 1 || body.requestsPerMinute > 1000) {
        setError('有效期须为 1–365 天，每分钟请求数须为 1–1000 的整数。'); return;
      }
    }
    void mutate(id, action, body);
  };

  const feedback = <>
    {message && <p className="mcp-notice" role="status">{message}</p>}
    {error && <p className="mcp-error" role="alert">{error}</p>}
    {error && <div className="section-toolbar"><button type="button" className="outline-button" disabled={loading || busy} onClick={() => { setError(''); setReload(value => value + 1); }}>重新加载申请</button></div>}
  </>;
  return <section className="admin-section active-section mcp-admin" aria-label="Skill / MCP 申请管理" aria-busy={loading || busy}>
    <div className="product-toolbar"><div><h2>Skill / MCP 接入管理</h2><p className="mcp-help">按用户管理申请与共用密钥，在详情中审核、查看密钥及调整访问权限。</p></div>
      <label className="report-status-filter">申请状态<select aria-label="申请状态" value={status} disabled={busy} onChange={event => { closeDetails(); setStatus(event.target.value); setPage(1); setData({ items: [], total: 0 }); }}>
        <option value="">全部状态</option>{Object.entries(STATUSES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
    </div>
    {!selected && feedback}
    <div className="data-table-wrap admin-scroll-area mcp-admin-table">
      {loading ? <p className="empty-state" role="status">正在加载申请…</p> : data.items.length ? <table aria-label="Skill / MCP 申请列表">
        <thead><tr><th scope="col">申请人</th><th scope="col">申请状态</th><th scope="col">密钥状态</th><th scope="col">额度 / 到期</th><th scope="col">使用量</th><th scope="col">操作</th></tr></thead>
        <tbody>{data.items.map(item => <tr key={item.id}>
          <td><strong>{item.name}</strong><span className="mcp-table-secondary">{item.email}</span></td>
          <td><span className="status-pill">{STATUSES[item.status] || item.status}</span></td>
          <td>{item.key ? KEY_STATUSES[item.key.status] || item.key.status : '未发放'}</td>
          <td>{item.key ? <>{item.key.requestsPerMinute} 次 / 分钟<span className="mcp-table-secondary">{formatTime(item.key.expiresAt)}</span></> : '—'}</td>
          <td>{item.key ? <>{item.key.requestCount} 次<span className="mcp-table-secondary">{item.key.lastUsedAt ? formatTime(item.key.lastUsedAt) : '尚未使用'}</span></> : '—'}</td>
          <td><button type="button" className="outline-button" onClick={() => selectRow(item.id)}>查看详情</button></td>
        </tr>)}</tbody>
      </table> : <EmptyState>暂无符合条件的申请</EmptyState>}
    </div>
    <Pagination total={data.total} page={page} pageSize={10} disabled={loading || busy} onChange={value => { closeDetails(); setPage(value); }} label="Skill / MCP 申请" />
    {selected && <ModalDialog open onClose={closeDetails} className="mcp-admin-detail" aria-labelledby="mcp-detail-title">
      <header className="mcp-detail-header"><div><h2 id="mcp-detail-title">申请详情</h2><strong>{selected.name}</strong><p>{selected.email}</p></div><button type="button" className="outline-button" onClick={closeDetails} aria-label="关闭详情">关闭</button></header>
      <span className="status-pill">{STATUSES[selected.status] || selected.status}</span>
      {feedback}
        <dl className="mcp-application-details">
          <div><dt>使用用途</dt><dd>{selected.purpose}</dd></div><div><dt>预计使用量</dt><dd>{selected.expectedUsage}</dd></div>
          <div><dt>申请时间</dt><dd>{formatTime(selected.createdAt)}</dd></div><div><dt>邮箱验证</dt><dd>{formatTime(selected.emailVerifiedAt)}</dd></div>
          {selected.reviewedAt && <div><dt>审核时间</dt><dd>{formatTime(selected.reviewedAt)}</dd></div>}
        </dl>
        <p className={selected.notificationStatus === 'failed' ? 'mcp-error' : 'mcp-help'}>{selected.notificationStatus === 'failed' ? '通知发送失败，请检查邮件配置后重发通知。' : selected.notificationStatus === 'sent' ? '通知已发送' : '通知状态：' + (selected.notificationStatus || '暂无')}</p>
        {selected.key && <div className="mcp-key-summary"><strong>{KEY_STATUSES[selected.key.status] || selected.key.status}</strong><p>到期 {formatTime(selected.key.expiresAt)} · 每分钟 {selected.key.requestsPerMinute} 次 · 累计 {selected.key.requestCount} 次</p><p>最近使用：{formatTime(selected.key.lastUsedAt)}</p>
          {selected.key.canReveal ? <div className="mcp-admin-secret">
            {apiKey ? <><label>完整密钥<input readOnly value={apiKey} autoComplete="off" spellCheck={false} /></label><div className="mcp-review-actions"><button type="button" className="outline-button" onClick={copyKey}>复制密钥</button><button type="button" className="outline-button" onClick={clearSecret}>隐藏密钥</button></div></>
              : <button type="button" className="outline-button" disabled={keyLoading || loading || busy} onClick={revealKey}>{keyLoading ? '正在读取密钥…' : '查看完整密钥'}</button>}
            {keyError && <p className="mcp-error" role="alert">{keyError}</p>}
            {keyMessage && <p className="mcp-notice" role="status">{keyMessage}</p>}
          </div> : <p className="mcp-help">{selected.key.status === 'unclaimed'
            ? '用户领取后即可查看完整密钥。'
            : selected.key.status === 'revoked' || selected.key.status === 'expired'
              ? '请重新发放并由用户领取新密钥。' : '完整密钥暂不可查看。'}</p>}
        </div>}
        <form key={`${selected.id}:${selected.status}:${selected.reviewedAt}:${selected.key?.requestsPerMinute}`} onSubmit={event => review(event, selected.id)}>
          <fieldset disabled={busy || loading}>
            <label>审核备注<textarea name="reviewNote" defaultValue={selected.reviewNote || ''} readOnly={selected.status !== 'pending' && selected.status !== 'approved'} maxLength={1000} rows={2} /></label>
            {(selected.status === 'pending' || selected.status === 'approved') && <div className="mcp-review-limits">
              <label>有效期（天）<input name="expiresInDays" type="number" min="1" max="365" step="1" defaultValue={90} required /></label>
              <label>每分钟请求数<input name="requestsPerMinute" type="number" min="1" max="1000" step="1" defaultValue={selected.key?.requestsPerMinute ?? 60} required /></label>
            </div>}
            <div className="mcp-review-actions">
              {selected.status === 'pending' && <><button className="approve" name="action" value="approve">通过申请</button><button className="reject" name="action" value="reject" formNoValidate>拒绝申请</button></>}
              {selected.status === 'approved' && <><button className="approve" name="action" value="reissue">重新发放</button>{selected.key?.status !== 'revoked' && <button className="reject" type="button" onClick={() => mutate(selected.id, 'revoke')}>撤销密钥</button>}</>}
              {(selected.status !== 'approved' || !selected.key || selected.key.status === 'unclaimed') && <button type="button" className="outline-button" onClick={() => mutate(selected.id, 'resend')}>重发通知</button>}
            </div>
          </fieldset>
        </form>
    </ModalDialog>}
  </section>;
}
