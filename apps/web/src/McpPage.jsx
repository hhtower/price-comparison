import React, { useCallback, useEffect, useRef, useState } from 'react';
import AccountPanel from './AccountPanel.jsx';
import Brand from './Brand.jsx';
import ContactAdminButton from './ContactAdminButton.jsx';
import ModalDialog from './components/ModalDialog.jsx';
import { formatTime, requestJson } from './api.js';
import './mcp.css';
import './mcp-access-page.css';

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
  const [accessOpen, setAccessOpen] = useState(Boolean(credential));
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
  const sessionRequest = useRef(null);
  const applicationRequest = useRef(null);
  const secretVersion = useRef(0);

  const clearSecrets = useCallback(() => {
    secretVersion.current += 1;
    activeRequest.current?.abort(); sessionRequest.current?.abort(); applicationRequest.current?.abort();
    activeRequest.current = null;
    setCredential(null); setClaimed(null); setMessage(''); setError(''); setBusy(false);
    setUser(undefined); setApplication(undefined); setApplicationLoading(false);
    setSessionError(''); setApplicationError('');
  }, []);
  const closeAccess = () => { clearSecrets(); setAccessOpen(false); };
  const openAccess = () => { setMessage(''); setError(''); setAccessOpen(true); };

  useEffect(() => {
    if (suspended) return;
    const controller = new AbortController();
    setConfigError('');
    requestJson('/api/mcp/config', { ...OPTIONS, signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setConfig(result); })
      .catch(() => { if (!controller.signal.aborted) setConfigError('Skill / MCP 接入暂不可用，请稍后重试。'); });
    return () => controller.abort();
  }, [configReload, suspended]);

  useEffect(() => {
    if (!accessOpen || suspended) return;
    const controller = new AbortController();
    sessionRequest.current = controller;
    setSessionError('');
    requestJson('/api/account/session', { ...OPTIONS, signal: controller.signal })
      .then(result => {
        if (controller.signal.aborted) return;
        if (!result || !Object.hasOwn(result, 'user')) throw new Error('Invalid session');
        setUser(result.user);
      })
      .catch(() => { if (!controller.signal.aborted) setSessionError('无法读取登录状态，请重试。'); });
    return () => controller.abort();
  }, [accessOpen, sessionReload, suspended]);

  useEffect(() => {
    if (!accessOpen || !user || !config || credential || claimed || busy || suspended) return;
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
  }, [accessOpen, user, config, credential, claimed, busy, applicationReload, suspended]);

  useEffect(() => {
    const hide = () => { clearSecrets(); setSuspended(true); };
    const captureHash = () => {
      const next = captureCredential();
      if (next) {
        clearSecrets(); setCredential(next); setAccessOpen(true);
        setSessionReload(value => value + 1);
      }
    };
    const restore = event => { if (event.persisted) setSuspended(false); };
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', restore);
    window.addEventListener('hashchange', captureHash);
    return () => {
      secretVersion.current += 1;
      activeRequest.current?.abort(); sessionRequest.current?.abort(); applicationRequest.current?.abort();
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', restore);
      window.removeEventListener('hashchange', captureHash);
    };
  }, [clearSecrets]);

  const submit = async (path, body, action) => {
    if (activeRequest.current || !accessOpen || suspended) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    setBusy(true); setError(''); setMessage('');
    if (action === 'logout') {
      secretVersion.current += 1;
      sessionRequest.current?.abort(); applicationRequest.current?.abort();
      setApplicationLoading(false); setClaimed(null); setCredential(null);
    }
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
        ? '链接无效、已使用或已过期，请联系管理员。已领取但未保存的密钥，此领取页面不会再次显示。'
        : '操作未完成，请稍后点击按钮重试。已领取但未保存密钥，请联系管理员。');
    } finally {
      if (!controller.signal.aborted) { activeRequest.current = null; setBusy(false); }
    }
  };
  const copyKey = async () => {
    const key = claimed;
    const version = secretVersion.current;
    try {
      await navigator.clipboard.writeText(key.apiKey);
      if (version !== secretVersion.current) return;
      setMessage('密钥已复制，请妥善保管。');
    } catch { if (version === secretVersion.current) setError('无法访问剪贴板，请手动选择并复制密钥。'); }
  };
  const endpoint = claimed?.endpoint || config?.endpoint;
  const installInstruction = `请从 ${window.location.origin}/assets/skills/price-comparison/INSTALL.md 安装 price-comparison skill，然后为本站配置接入密钥。`;
  const copyInstall = async () => {
    const version = secretVersion.current;
    setMessage(''); setError('');
    try {
      await navigator.clipboard.writeText(installInstruction);
      if (version === secretVersion.current) setMessage('安装指令已复制，发送给你的智能体即可。');
    } catch { if (version === secretVersion.current) setError('无法访问剪贴板，请手动选择并复制安装指令。'); }
  };
  const showAccount = !credential && !claimed && config && !configError && user === null;
  const applicationStatus = ['revoked', 'expired'].includes(application?.key?.status) ? application.key.status : application?.status;

  return <main className="mcp-page mcp-access-page">
    <header className="mcp-header"><Brand /><nav aria-label="接入导航"><a href="/">商品比价</a><a href="/tools">检测工具</a><a href="/mcp" aria-current="page">Skill / MCP 接入</a></nav></header>
    <div className="mcp-access-content">
        <section className="mcp-access-intro" aria-labelledby="mcp-access-title">
          <div><p className="eyebrow">CATALOG / AGENT ACCESS</p><h1 id="mcp-access-title">真实报价，接入你的智能体。</h1>
            <p>查商品、比报价、看历史。Skill 与 MCP，一次申请，共用一把密钥。</p></div>
          <div className="mcp-access-cta">
            <button type="button" onClick={openAccess}>申请接入 <span aria-hidden="true">↗</span></button>
            <button type="button" className="mcp-text-button" onClick={openAccess}>查看申请状态</button>
          </div>
        </section>
        {!accessOpen && <div className="mcp-access-feedback">
          {message && <p className="mcp-notice" role="status">{message}</p>}
          {error && <p className="mcp-error" role="alert">{error}</p>}
          {configError && <div className="mcp-access-service-error"><p className="mcp-error" role="alert">{configError}</p>
            <button type="button" className="mcp-secondary" onClick={() => setConfigReload(value => value + 1)}>重新检查服务</button></div>}
        </div>}
        <section className="mcp-methods" aria-label="接入方式">
          <article className="mcp-method">
            <div className="mcp-access-method-top"><span className="mcp-access-index" aria-hidden="true">01 / SKILL</span><span>对话式使用</span></div>
            <div className="mcp-method-heading"><h2>Skill 接入</h2></div>
            <p>把指令发给 Codex、Claude Code 或 DeepSeek Harness，安装后只需填写密钥。</p>
            <label>Skill 安装与配置指令<textarea readOnly rows={3} value={installInstruction} /></label>
            <div className="mcp-method-actions"><button type="button" className="mcp-secondary" onClick={copyInstall}>复制安装指令</button>
              <a href="/assets/access/skill.md" target="_blank" rel="noopener noreferrer">Skill 接入说明 <span aria-hidden="true">↗</span></a></div>
            <p className="mcp-help">已安装？输入「使用 price-comparison skill 配置密钥」。</p>
          </article>
          <article className="mcp-method">
            <div className="mcp-access-method-top"><span className="mcp-access-index" aria-hidden="true">02 / MCP</span><span>客户端连接</span></div>
            <div className="mcp-method-heading"><h2>MCP 接入</h2></div>
            <p>连接支持 Streamable HTTP 的客户端，使用同一把密钥作为认证凭据。</p>
            {endpoint && <label className="mcp-endpoint">MCP 地址<input readOnly value={new URL(endpoint, window.location.origin).href} /></label>}
            {!endpoint && <p className="mcp-help">{configError ? '服务地址暂不可用，请重试。' : '正在读取服务地址…'}</p>}
            <div className="mcp-access-transport"><span>传输协议 <strong>Streamable HTTP</strong></span><span>认证方式 <strong>API Key</strong></span></div>
            <div className="mcp-method-actions"><a href="/assets/access/mcp.md" target="_blank" rel="noopener noreferrer">MCP 接入说明 <span aria-hidden="true">↗</span></a></div>
            <p className="mcp-help">按文档配置服务地址与认证头，即可调用报价工具。</p>
          </article>
        </section>
        <section className="mcp-capabilities" aria-labelledby="mcp-tools-title">
          <h2 id="mcp-tools-title">两种接入，同一份报价目录</h2><span className="mcp-access-shared">共用有效期与请求额度</span>
          <dl>{[
            ['查找商品', '按名称与条件，找到目标商品。'],
            ['比较报价', '对比商铺报价，核对来源与时间。'],
            ['查看历史', '查看价格变化，了解历史行情。'],
          ].map(([title, description]) => <div key={title}><dt>{title}</dt><dd>{description}</dd></div>)}</dl>
        </section>
        <footer className="mcp-access-footer"><span>报价仅供参考，成交价与库存以商家为准。</span><span>登录 / 注册 → 提交申请 → 审核通过 → 领取密钥</span></footer>
    </div>
      {accessOpen && <ModalDialog open onClose={closeAccess} className="mcp-card mcp-access-dialog" aria-labelledby="mcp-access-dialog-title">
        <div className="mcp-access-dialog-header"><h2 id="mcp-access-dialog-title">Skill / MCP 接入</h2>
          <button type="button" className="mcp-dialog-close" aria-label="关闭接入窗口" onClick={closeAccess}><span aria-hidden="true">×</span></button></div>
        <div aria-busy={busy}>
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
          <p>完整密钥仅显示一次。关闭窗口、离开或刷新页面后，此领取页面不会再次显示。请立即复制到安全的位置，不要分享或公开。</p>
          <label>API 密钥<input readOnly autoComplete="off" spellCheck={false} value={claimed.apiKey} /></label>
          <button type="button" onClick={copyKey}>复制密钥</button>
          <dl><div><dt>有效期至</dt><dd>{formatTime(claimed.expiresAt)}</dd></div><div><dt>请求额度</dt><dd>每分钟 {claimed.requestsPerMinute} 次</dd></div></dl>
          <p className="mcp-help">这把密钥同时用于 Skill 和 MCP，请按对应接入说明配置。密钥遗失请联系管理员；如有泄露，须撤销并重新发放，随后更新两种接入方式的配置。</p>
          <button type="button" className="mcp-secondary" onClick={() => { secretVersion.current += 1; setClaimed(null); setMessage('密钥已从页面清除。'); }}>清除页面密钥</button>
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
              <p className="eyebrow">YOUR AGENT ACCESS</p><h2>{STATUS[applicationStatus] || '申请状态'}</h2>
              <dl className="mcp-application-details"><div><dt>名称</dt><dd>{application.name}</dd></div><div><dt>申请邮箱</dt><dd>{user.email}</dd></div>
                <div><dt>使用用途</dt><dd>{application.purpose}</dd></div><div><dt>预计使用量</dt><dd>{application.expectedUsage}</dd></div></dl>
              {application.reviewNote && <p className="mcp-notice">{application.reviewNote}</p>}
              {application.status === 'approved' && !application.canClaim && <p className="mcp-help">密钥已领取或暂不可领取。遗失请联系管理员；泄露须撤销并重新发放。</p>}
              <div className="mcp-manual-actions">{application.canClaim && <button type="button" disabled={busy || applicationLoading} onClick={() => void submit('/api/mcp/application/claim', {}, 'claim')}>领取密钥</button>}
                <button type="button" className="mcp-secondary" disabled={busy || applicationLoading} onClick={() => setApplicationReload(value => value + 1)}>刷新状态</button><ContactAdminButton /></div>
            </div> : applicationError ? <button type="button" className="mcp-secondary" disabled={applicationLoading} onClick={() => setApplicationReload(value => value + 1)}>刷新状态</button>
              : application === null && <form onSubmit={event => {
                event.preventDefault(); void submit('/api/mcp/applications', Object.fromEntries(new FormData(event.currentTarget)), 'apply');
              }}>
                <h2>申请 Skill / MCP 接入</h2><p className="mcp-help">填写一次使用场景，审核通过后领取共用密钥。已有申请无需重复提交。</p>
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
        </div>
      </ModalDialog>}
  </main>;
}
