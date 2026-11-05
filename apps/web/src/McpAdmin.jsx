import React, { useEffect, useState } from 'react';
import { formatTime, requestJson } from './api.js';
import { EmptyState, Pagination } from './components/AdminControls.jsx';
import './mcp.css';

const STATUSES = { unverified: '待验证', pending: '待审核', approved: '已通过', rejected: '已拒绝' };
const KEY_STATUSES = { active: '有效', revoked: '已撤销', expired: '已过期', unclaimed: '待领取' };
const ACTIONS = { approve: '申请已通过，已尝试发送领取通知。', reject: '申请已拒绝。', resend: '已尝试重发通知，请检查通知状态。', revoke: '密钥已撤销。', reissue: '已重新发放，旧密钥立即失效；请检查通知状态。' };

export default function McpAdmin() {
  const [status, setStatus] = useState('pending');
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ items: [], total: 0 });
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    requestJson(`/api/admin/mcp/applications?page=${page}&pageSize=10${status ? '&status=' + status : ''}`, { signal: controller.signal, cache: 'no-store' })
      .then(result => {
        if (controller.signal.aborted) return;
        if (page > 1 && !result.items.length) { setPage(Math.max(1, Math.ceil(result.total / 10))); return; }
        setData(result);
      })
      .catch(error => { if (!controller.signal.aborted) setError(error.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [page, status, reload]);

  const mutate = async (id, action, body = {}) => {
    if (busy) return;
    if (action === 'revoke' && !window.confirm('撤销后当前密钥立即失效，确认撤销？')) return;
    if (action === 'reissue' && !window.confirm('重新发放会立即使旧密钥失效，并发送新的领取邮件，确认继续？')) return;
    setBusy(true); setMessage(''); setError('');
    try {
      await requestJson(`/api/admin/mcp/applications/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: JSON.stringify(body) });
      setMessage(ACTIONS[action]); setReload(value => value + 1);
    } catch (error) { setError(error.message); }
    finally { setBusy(false); }
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

  return <section className="admin-section active-section mcp-admin" aria-label="MCP 申请管理" aria-busy={loading || busy}>
    <div className="product-toolbar"><div><h2>MCP 接入管理</h2><p className="mcp-help">审核申请、发送领取通知并管理只读密钥。完整密钥仅由申请人在网站领取。</p></div>
      <label className="report-status-filter">申请状态<select aria-label="申请状态" value={status} disabled={busy} onChange={event => { setStatus(event.target.value); setPage(1); setData({ items: [], total: 0 }); setError(''); }}>
        <option value="">全部状态</option>{Object.entries(STATUSES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
    </div>
    {message && <p className="mcp-notice" role="status">{message}</p>}
    {error && <p className="mcp-error" role="alert">{error}</p>}
    {error && <div className="section-toolbar"><button type="button" className="outline-button" disabled={loading || busy} onClick={() => { setError(''); setReload(value => value + 1); }}>重新加载申请</button></div>}
    <div className="mcp-review-list admin-scroll-area">
      {loading ? <p role="status">正在加载申请…</p> : data.items.length ? data.items.map(item => <article className="mcp-review-card" key={`${item.id}:${item.reviewedAt}:${reload}`}>
        <header><div><h3>{item.name}</h3><span>{item.email}</span></div><span className="status-pill">{STATUSES[item.status] || item.status}</span></header>
        <dl className="mcp-application-details">
          <div><dt>使用用途</dt><dd>{item.purpose}</dd></div><div><dt>预计使用量</dt><dd>{item.expectedUsage}</dd></div>
          <div><dt>申请时间</dt><dd>{formatTime(item.createdAt)}</dd></div><div><dt>邮箱验证</dt><dd>{formatTime(item.emailVerifiedAt)}</dd></div>
          {item.reviewedAt && <div><dt>审核时间</dt><dd>{formatTime(item.reviewedAt)}</dd></div>}
        </dl>
        <p className={item.notificationStatus === 'failed' ? 'mcp-error' : 'mcp-help'}>{item.notificationStatus === 'failed' ? '通知发送失败，请检查邮件配置后重发通知。' : item.notificationStatus === 'sent' ? '通知已发送' : '通知状态：' + (item.notificationStatus || '暂无')}</p>
        {item.key && <div className="mcp-key-summary"><strong>{item.key.prefix ? item.key.prefix + '… · ' : ''}{KEY_STATUSES[item.key.status] || item.key.status}</strong><p>到期 {formatTime(item.key.expiresAt)} · 每分钟 {item.key.requestsPerMinute} 次 · 累计 {item.key.requestCount} 次</p><p>最近使用：{formatTime(item.key.lastUsedAt)}</p></div>}
        <form onSubmit={event => review(event, item.id)}>
          <fieldset disabled={busy || loading}>
            <label>审核备注<textarea name="reviewNote" defaultValue={item.reviewNote || ''} readOnly={item.status !== 'pending' && item.status !== 'approved'} maxLength={1000} rows={2} /></label>
            {(item.status === 'pending' || item.status === 'approved') && <div className="mcp-review-limits">
              <label>有效期（天）<input name="expiresInDays" type="number" min="1" max="365" step="1" defaultValue={90} required /></label>
              <label>每分钟请求数<input name="requestsPerMinute" type="number" min="1" max="1000" step="1" defaultValue={60} required /></label>
            </div>}
            <div className="mcp-review-actions">
              {item.status === 'pending' && <><button className="approve" name="action" value="approve">通过申请</button><button className="reject" name="action" value="reject" formNoValidate>拒绝申请</button></>}
              {item.status === 'approved' && <><button className="approve" name="action" value="reissue">重新发放</button>{item.key?.status !== 'revoked' && <button className="reject" type="button" onClick={() => mutate(item.id, 'revoke')}>撤销密钥</button>}</>}
              {(item.status !== 'approved' || !item.key || item.key.status === 'unclaimed') && <button type="button" className="outline-button" onClick={() => mutate(item.id, 'resend')}>重发通知</button>}
            </div>
          </fieldset>
        </form>
      </article>) : <EmptyState>暂无符合条件的申请</EmptyState>}
    </div>
    <Pagination total={data.total} page={page} pageSize={10} disabled={loading || busy} onChange={setPage} label="MCP 申请" />
  </section>;
}
