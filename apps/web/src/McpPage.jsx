import React, { useEffect, useRef, useState } from 'react';
import AccountPanel from './AccountPanel.jsx';
import Brand from './Brand.jsx';
import ContactAdminButton from './ContactAdminButton.jsx';
import { formatTime, requestJson } from './api.js';
import './mcp.css';

function captureCredential() {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const action = params.has('verify') ? 'verify' : params.has('claim') ? 'claim' : null;
  if (!action) return null;
  const token = params.get(action);
  window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
  return { action, token };
}

const STATUS = { pending: '等待管理员审核', unverified: '等待邮箱验证', approved: '申请已通过', rejected: '申请未通过', revoked: '接入已撤销', expired: '密钥已过期' };
const OPTIONS = { cache: 'no-store', referrerPolicy: 'no-referrer' };

export default function McpPage() {
  const [credential, setCredential] = useState(captureCredential);
  const [config, setConfig] = useState(null);
  const [configReload, setConfigReload] = useState(0);
  const [configError, setConfigError] = useState('');
  const [user, setUser] = useState(undefined);
  const [sessionReload, setSessionReload] = useState(0);
  const [sessionError, setSessionError] = useState('');
  const [application, setApplication] = useState(undefined);
  const [applicationReload, setApplicationReload] = useState(0);
  const [applicationLoading, setApplicationLoading] = useState(false);
  const [applicationError, setApplicationError] = useState('');
  const [claimed, setClaimed] = useState(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [suspended, setSuspended] = useState(false);
  const activeRequest = useRef(null);
  const applicationRequest = useRef(null);

  useEffect(() => {
    if (suspended) return;
    const controller = new AbortController();
    setConfigError('');
    requestJson('/api/mcp/config', { ...OPTIONS, signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setConfig(result); })
      .catch(() => { if (!controller.signal.aborted) setConfigError('MCP 接入暂不可用，请稍后重试。'); });
    return () => controller.abort();
  }, [configReload, suspended]);

  useEffect(() => {
    if (suspended) return;
    const controller = new AbortController();
    setSessionError('');
    requestJson('/api/account/session', { ...OPTIONS, signal: controller.signal })
      .then(result => {
        if (controller.signal.aborted) return;
        if (!result || !Object.hasOwn(result, 'user')) throw new Error('Invalid session');
        setUser(result.user);
      })
      .catch(() => { if (!controller.signal.aborted) setSessionError('无法读取登录状态，请重试。'); });
    return () => controller.abort();
  }, [sessionReload, suspended]);

  useEffect(() => {
    if (!user || !config || credential || claimed || suspended) return;
    const controller = new AbortController();
    applicationRequest.current = controller;
    setApplicationLoading(true); setApplicationError('');
    requestJson('/api/mcp/application', { ...OPTIONS, signal: controller.signal })
      .then(result => {
        if (controller.signal.aborted) return;
        if (!result || !Object.hasOwn(result, 'application')) throw new Error('Invalid application');
        setApplication(result.application);
      })
      .catch(failure => {
        if (controller.signal.aborted) return;
        if (failure.status === 401) { setUser(null); setApplication(undefined); setClaimed(null); }
        else setApplicationError('无法读取申请，请刷新状态重试。');
      })
      .finally(() => { if (!controller.signal.aborted) setApplicationLoading(false); });
    return () => controller.abort();
  }, [user, config, credential, claimed, applicationReload, suspended]);

  useEffect(() => {
    const clearSecrets = () => {
      activeRequest.current?.abort(); applicationRequest.current?.abort(); activeRequest.current = null;
      setCredential(null); setClaimed(null); setMessage(''); setError(''); setBusy(false);
    };
    const hide = () => { clearSecrets(); setSuspended(true); setUser(undefined); setApplication(undefined); };
    const captureHash = () => {
      const next = captureCredential();
      if (next) { clearSecrets(); setCredential(next); }
    };
    const restore = event => { if (event.persisted) setSuspended(false); };
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', restore);
    window.addEventListener('hashchange', captureHash);
    return () => {
      activeRequest.current?.abort(); applicationRequest.current?.abort();
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', restore);
      window.removeEventListener('hashchange', captureHash);
    };
  }, []);

  const submit = async (path, body, action) => {
    if (activeRequest.current || suspended) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    setBusy(true); setError(''); setMessage('');
    if (action === 'logout') { setClaimed(null); setCredential(null); }
    try {
      const result = await requestJson(path, { ...OPTIONS, method: 'POST', body: JSON.stringify(body), signal: controller.signal });
      if (controller.signal.aborted) return;
      if (action === 'claim') {
        setClaimed(result); setCredential(null);
        setApplication(value => value ? { ...value, canClaim: false } : value);
      } else if (action === 'verify') {
        setCredential(null); setMessage('邮箱已验证，等待管理员审核。登录后可查看申请状态。');
        setApplicationReload(value => value + 1);
      } else if (action === 'logout') {
        setUser(null); setApplication(undefined); setApplicationError('');
      } else setApplicationReload(value => value + 1);
    } catch (failure) {
      if (controller.signal.aborted) return;
      if (failure.status === 401 && !credential) {
        setUser(null); setApplication(undefined); setClaimed(null);
        setError('登录已过期，请重新登录。');
      } else setError(credential && failure.status === 400
        ? '链接无效、已使用或已过期，请联系管理员。已领取的密钥需要重新发放。'
        : '操作未完成，请稍后点击按钮重试。已领取但未保存的密钥需要联系管理员重新发放。');
    } finally {
      if (!controller.signal.aborted) { activeRequest.current = null; setBusy(false); }
    }
  };
  const copyKey = async () => {
    const key = claimed;
    try {
      await navigator.clipboard.writeText(key.apiKey);
      if (activeRequest.current?.signal.aborted) return;
      setMessage('密钥已复制，请妥善保管。');
    } catch { setError('无法访问剪贴板，请手动选择并复制密钥。'); }
  };
  const endpoint = claimed?.endpoint || config?.endpoint;
  const showAccount = !credential && !claimed && config && !configError && user === null;
  const applicationStatus = ['revoked', 'expired'].includes(application?.key?.status) ? application.key.status : application?.status;

  return <main className="mcp-page">
    <header className="mcp-header"><Brand /><nav aria-label="MCP 导航"><a href="/">商品比价</a><a href="/tools">检测工具</a><a href="/mcp" aria-current="page">MCP 接入</a></nav></header>
    <div className="mcp-layout">
      <div className="mcp-overview">
        <div className="mcp-intro">
          <p className="eyebrow">CATALOG / MCP</p><h1>把真实报价，接入你的工具。</h1>
          <p>通过 MCP 查询本站商品、商铺报价与价格历史。只读访问，申请审核后使用专属密钥接入。</p>
          <ol className="mcp-steps"><li>验证邮箱</li><li>提交申请</li><li>管理员审核</li><li>网站领取密钥</li></ol>
        </div>
        <section className="mcp-capabilities" aria-labelledby="mcp-tools-title">
          <h2 id="mcp-tools-title">三个工具，一份报价目录</h2>
          <dl>{[
            ['search_products', '查找商品', '按名称与条件检索商品，找到可比较的标准商品。'],
            ['get_product_offers', '比较报价', '分页查看商铺报价、采集时间和来源，下单前核对商家条件。'],
            ['get_price_history', '查看历史', '查询报价变化，了解商品过去的价格记录。'],
          ].map(([name, title, description]) => <div key={name}><dt><span>{title}</span><code>{name}</code></dt><dd>{description}</dd></div>)}</dl>
          <p className="mcp-help">报价仅供参考，成交价以商家结算页为准。客户端需要支持 HTTP MCP 和自定义 Authorization 请求头。</p>
          {endpoint && <label className="mcp-endpoint">MCP 地址<input readOnly value={new URL(endpoint, window.location.origin).href} /></label>}
        </section>
      </div>
      <section className="mcp-card" aria-label="MCP 接入申请" aria-busy={busy}>
        {user && <div className="mcp-account-bar"><span>{user.email}</span><button type="button" className="mcp-text-button" disabled={busy}
          onClick={() => void submit('/api/account/logout', {}, 'logout')}>退出登录</button></div>}
        {message && <p className="mcp-notice" role="status">{message}</p>}
        {error && <p className="mcp-error" role="alert">{error}</p>}
        {configError && <><p className="mcp-error" role="alert">{configError}</p><button type="button" className="mcp-secondary" onClick={() => setConfigReload(value => value + 1)}>重新检查服务</button></>}
        {sessionError && !credential && <><p className="mcp-error" role="alert">{sessionError}</p><button type="button" className="mcp-secondary" onClick={() => setSessionReload(value => value + 1)}>重试登录状态</button></>}
        {(!config || user === undefined) && !configError && !sessionError && !credential && <p role="status">正在检查接入服务…</p>}
        {config && !config.enabled && <p className="mcp-notice">邮件验证码暂不可用，已有账号可使用密码登录。</p>}
        {claimed ? <div className="mcp-key">
          <p className="eyebrow">ACCESS GRANTED</p><h2>请保存你的密钥</h2>
          <p>完整密钥仅显示一次，仅保存在当前页面内存中。离开或刷新页面后无法找回，请立即复制到安全的位置，不要分享或公开。</p>
          <label>API 密钥<input readOnly autoComplete="off" spellCheck={false} value={claimed.apiKey} /></label>
          <button type="button" onClick={copyKey}>复制密钥</button>
          <dl><div><dt>有效期至</dt><dd>{formatTime(claimed.expiresAt)}</dd></div><div><dt>请求额度</dt><dd>每分钟 {claimed.requestsPerMinute} 次</dd></div></dl>
          <p className="mcp-help">认证方式：Authorization: Bearer &lt;你的密钥&gt;。密钥丢失或泄露后，请联系管理员撤销并重新发放。</p>
          <button type="button" className="mcp-secondary" onClick={() => { setClaimed(null); setMessage('密钥已从页面清除。'); }}>清除页面密钥</button>
        </div> : credential ? <div className="mcp-credential">
          <h2>{credential.action === 'verify' ? '验证你的申请邮箱' : '领取接入密钥'}</h2>
          <p>{credential.action === 'verify' ? '点击后确认邮箱，申请将进入管理员审核。' : '审核已通过。完整密钥只会显示一次，请准备好安全保存。'}</p>
          <button type="button" disabled={busy} onClick={() => void submit('/api/mcp/applications/' + credential.action, { token: credential.token }, credential.action)}>{credential.action === 'verify' ? '验证邮箱' : '领取密钥'}</button>
          <div className="mcp-manual-actions"><button type="button" disabled={busy} onClick={() => { setCredential(null); setError(''); }}>返回账号</button><ContactAdminButton /></div>
        </div> : <>
          {showAccount && <AccountPanel emailEnabled={config.enabled} onAuthenticated={account => { setUser(account); setApplication(undefined); setError(''); setMessage(''); }} />}
          {user && config && !configError && <>
            {applicationError && <p className="mcp-error" role="alert">{applicationError}</p>}
            {applicationLoading && application === undefined && <p role="status">正在读取申请…</p>}
            {application ? <div className="mcp-application">
              <p className="eyebrow">YOUR MCP ACCESS</p><h2>{STATUS[applicationStatus] || '申请状态'}</h2>
              <dl className="mcp-application-details"><div><dt>名称</dt><dd>{application.name}</dd></div><div><dt>申请邮箱</dt><dd>{user.email}</dd></div>
                <div><dt>使用用途</dt><dd>{application.purpose}</dd></div><div><dt>预计使用量</dt><dd>{application.expectedUsage}</dd></div></dl>
              {application.reviewNote && <p className="mcp-notice">{application.reviewNote}</p>}
              {application.status === 'approved' && !application.canClaim && <p className="mcp-help">密钥已领取或暂不可领取。如需重新发放，请联系管理员。</p>}
              <div className="mcp-manual-actions">{application.canClaim && <button type="button" disabled={busy || applicationLoading} onClick={() => void submit('/api/mcp/application/claim', {}, 'claim')}>领取密钥</button>}
                <button type="button" className="mcp-secondary" disabled={busy || applicationLoading} onClick={() => setApplicationReload(value => value + 1)}>刷新状态</button><ContactAdminButton /></div>
            </div> : applicationError ? <button type="button" className="mcp-secondary" disabled={applicationLoading} onClick={() => setApplicationReload(value => value + 1)}>刷新状态</button>
              : application === null && <form onSubmit={event => {
                event.preventDefault(); void submit('/api/mcp/applications', Object.fromEntries(new FormData(event.currentTarget)), 'apply');
              }}>
                <h2>申请 MCP 接入</h2><p className="mcp-help">邮箱已验证，填写使用场景后等待管理员审核。</p>
                <fieldset disabled={busy || applicationLoading}>
                  <div className="mcp-form-row"><label>名称<input name="name" required maxLength={100} autoComplete="name" /></label>
                    <label>申请邮箱<input type="email" readOnly value={user.email} /></label></div>
                  <label>使用用途<textarea name="purpose" required maxLength={2000} rows={3} placeholder="你希望如何使用这些报价？" /></label>
                  <label>预计使用量<input name="expectedUsage" required maxLength={200} placeholder="例如：每天 100 次，用于个人工具" /></label>
                  <button type="submit">{busy ? '正在提交…' : '提交申请'}</button>
                </fieldset>
              </form>}
          </>}
        </>}
      </section>
    </div>
  </main>;
}
