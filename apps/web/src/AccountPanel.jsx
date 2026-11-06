import React, { useEffect, useRef, useState } from 'react';
import ContactAdminButton from './ContactAdminButton.jsx';
import ModalDialog from './components/ModalDialog.jsx';
import { requestJson } from './api.js';

export default function AccountPanel({ onAuthenticated, emailEnabled = true, passwordMinLength = 8 }) {
  const [email, setEmail] = useState('');
  const [mode, setMode] = useState(emailEnabled ? 'email' : 'password');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [delivery, setDelivery] = useState(null);
  const [registration, setRegistration] = useState(null);
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(Date.now);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [captcha, setCaptcha] = useState(null);
  const [captchaAnswer, setCaptchaAnswer] = useState('');
  const [captchaValid, setCaptchaValid] = useState(false);
  const [captchaLoading, setCaptchaLoading] = useState(false);
  const [captchaError, setCaptchaError] = useState('');
  const [captchaReload, setCaptchaReload] = useState(0);
  const [pendingAction, setPendingAction] = useState('');
  const [suspended, setSuspended] = useState(false);
  const emailInput = useRef(null);
  const activeRequest = useRef(null);
  const captchaRequest = useRef(null);
  const wait = Math.max(0, Math.ceil((retryAt - now) / 1000));
  const graphicReady = captchaValid && !captchaLoading && /^[0-9]{5}$/.test(captchaAnswer);
  const codeReady = delivery?.challengeId && now < delivery.expiresAt && /^[0-9]{6}$/.test(code);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!pendingAction || suspended) return;
    const controller = new AbortController();
    captchaRequest.current = controller;
    setCaptchaValid(false); setCaptchaLoading(true); setCaptchaAnswer('');
    let expiry;
    requestJson('/api/mcp/captcha', { signal: controller.signal, cache: 'no-store', referrerPolicy: 'no-referrer' })
      .then(result => {
        if (controller.signal.aborted) return;
        if (!/^[A-Za-z0-9_-]{43}$/.test(result?.id) ||
          !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(result?.image) ||
          !Number.isFinite(result?.expiresInSeconds) || result.expiresInSeconds <= 0) throw new Error('Invalid captcha');
        setCaptcha(result); setCaptchaValid(true);
        expiry = window.setTimeout(() => {
          if (controller.signal.aborted) return;
          setCaptchaValid(false); setCaptchaAnswer(''); setCaptchaError('验证码已过期，请刷新图形验证码。');
        }, result.expiresInSeconds * 1000);
      })
      .catch(() => { if (!controller.signal.aborted) setCaptchaError('验证码暂不可用，请刷新或联系管理员。'); })
      .finally(() => { if (!controller.signal.aborted) setCaptchaLoading(false); });
    return () => { controller.abort(); window.clearTimeout(expiry); };
  }, [captchaReload, suspended, pendingAction]);

  useEffect(() => {
    const clearSecrets = () => {
      activeRequest.current?.abort(); captchaRequest.current?.abort(); activeRequest.current = null;
      setDelivery(null); setRegistration(null); setPassword(''); setCode(''); setRetryAt(0);
      setCaptcha(null); setCaptchaAnswer(''); setCaptchaValid(false); setCaptchaLoading(false);
      setPendingAction('');
      setCaptchaError(''); setError(''); setNotice(''); setBusy(''); setMode(emailEnabled ? 'email' : 'password'); setSuspended(true);
    };
    const restore = event => {
      if (event.persisted) { setNow(Date.now()); setSuspended(false); }
    };
    window.addEventListener('pagehide', clearSecrets);
    window.addEventListener('pageshow', restore);
    return () => {
      activeRequest.current?.abort(); captchaRequest.current?.abort();
      window.removeEventListener('pagehide', clearSecrets);
      window.removeEventListener('pageshow', restore);
    };
  }, [emailEnabled]);

  const closeSecurity = () => {
    activeRequest.current?.abort(); captchaRequest.current?.abort(); activeRequest.current = null;
    setPendingAction(''); setBusy(''); setCaptcha(null); setCaptchaAnswer('');
    setCaptchaValid(false); setCaptchaLoading(false); setCaptchaError('');
  };
  const openSecurity = action => {
    if (activeRequest.current || suspended || !emailInput.current?.reportValidity()) return;
    if (action === 'email-code' && (!emailEnabled || Date.now() < retryAt)) return;
    if (action === 'login' && (!password || password.length > 128)) return;
    setError(''); setNotice(''); setCaptchaError(''); setCaptcha(null); setCaptchaAnswer('');
    setCaptchaValid(false); setCaptchaLoading(true); setPendingAction(action);
  };
  const changeEmail = value => {
    setEmail(value);
    if (!delivery && !registration) return;
    setDelivery(null); setRegistration(null); setCode(''); setPassword(''); setRetryAt(0);
    setError(''); setNotice('');
  };
  const applyRetry = result => {
    if (typeof result?.retryToken === 'string') setDelivery(value => ({ ...value, retryToken: result.retryToken }));
    if (Number.isFinite(result?.retryAfterSeconds) && result.retryAfterSeconds >= 0) {
      setNow(Date.now()); setRetryAt(Date.now() + result.retryAfterSeconds * 1000);
    }
  };
  const submit = async action => {
    if (activeRequest.current || suspended || !emailInput.current?.reportValidity()) return;
    if ((action === 'email-code' || action === 'login') && (pendingAction !== action || !graphicReady)) return;
    if (action === 'email-code' && (!emailEnabled || Date.now() < retryAt)) return;
    if (action === 'verify-email' && (!codeReady || Date.now() >= delivery.expiresAt)) return;
    if (action === 'login' && (!password || password.length > 128)) return;
    if (action === 'register' && (!registration || password.length < passwordMinLength || password.length > 128)) return;
    const body = action === 'email-code'
      ? { email, captchaId: captcha.id, captchaAnswer, ...(delivery?.retryToken ? { retryToken: delivery.retryToken } : {}) }
      : action === 'verify-email' ? { challengeId: delivery.challengeId, code }
        : action === 'register' ? { registrationToken: registration.registrationToken, password }
          : { email, password, captchaId: captcha.id, captchaAnswer };
    const controller = new AbortController();
    activeRequest.current = controller;
    if (body.captchaId) { setCaptchaValid(false); captchaRequest.current?.abort(); }
    setBusy(action); setError(''); setNotice('');
    try {
      const result = await requestJson('/api/account/' + action, {
        method: 'POST', body: JSON.stringify(body), signal: controller.signal, cache: 'no-store', referrerPolicy: 'no-referrer',
      });
      if (controller.signal.aborted) return;
      if (body.captchaId) { setPendingAction(''); setCaptcha(null); setCaptchaAnswer(''); setCaptchaError(''); }
      if (action === 'email-code') {
        if (!result?.challengeId || !result?.retryToken || !Number.isFinite(result.expiresInSeconds) || result.expiresInSeconds <= 0) throw new Error('Invalid email challenge');
        setDelivery({ ...result, expiresAt: Date.now() + result.expiresInSeconds * 1000 });
        setCode(''); applyRetry(result);
        setNotice('验证码已发送，10 分钟内有效；新验证码会替换旧验证码。');
      } else if (result?.user?.id && result.user.email) {
        setPassword(''); setCode(''); setDelivery(null); setRegistration(null);
        onAuthenticated(result.user);
      } else if (action === 'verify-email' && result?.registrationToken && result.email?.toLowerCase() === email.trim().toLowerCase()) {
        setRegistration(result); setPassword(''); setCode(''); setDelivery(null); setRetryAt(0);
      } else throw new Error('Invalid account response');
    } catch (failure) {
      if (controller.signal.aborted) return;
      const details = failure.data?.error?.details;
      if (body.captchaId && failure.data?.error?.code === 'MCP_CAPTCHA_INVALID') {
        setCaptchaError('图形验证码错误或已过期，请输入新验证码后重试。');
        setCaptchaReload(value => value + 1);
        return;
      }
      if (body.captchaId) { setPendingAction(''); setCaptcha(null); setCaptchaAnswer(''); setCaptchaError(''); }
      if (action === 'email-code') {
        const invalidRetry = failure.data?.error?.code === 'ACCOUNT_RETRY_INVALID' && !details?.retryToken;
        if (invalidRetry) setDelivery(value => value ? { ...value, retryToken: undefined } : value);
        applyRetry(details);
        setError(failure.status === 429 ? '发送较频繁，请等待倒计时结束后重试。'
          : failure.status === 403 ? '暂时无法发送，请按提示重试或刷新图形验证码。'
            : '验证码未能发送，请稍后重试。');
      } else if (action === 'login') {
        setError(failure.status === 401 ? '邮箱或密码不正确，请重新输入。'
          : failure.status === 429 ? '登录尝试过于频繁，请稍后重试。'
            : failure.status >= 500 ? '登录服务暂不可用，请稍后重试。'
              : failure.status === 400 ? '登录信息无效，请检查邮箱和密码。'
                : '登录未完成，请稍后重试。');
      } else {
        setError(action === 'register' ? '创建账号未完成，请重试；凭证过期时请重新验证邮箱。'
            : '邮件验证码无效、已过期或尝试次数过多，请检查或重新发送。');
      }
    } finally {
      if (!controller.signal.aborted) { activeRequest.current = null; setBusy(''); }
    }
  };
  const action = registration ? 'register' : mode === 'password' ? 'login' : 'verify-email';

  return <div className="mcp-account">
    {registration && <div className="mcp-account-heading"><h2>设置账号密码</h2></div>}
    {registration && <p className="mcp-help">邮箱已验证。设置一个密码，供以后直接登录。</p>}
    {error && mode === 'password' && <p id="account-error" className="mcp-error" role="alert">{error}</p>}
    {notice && <p className="mcp-notice" role="status">{notice}</p>}
    <form onSubmit={event => { event.preventDefault(); if (action === 'login') openSecurity(action); else void submit(action); }}>
      <fieldset disabled={Boolean(busy) || suspended}>
        <div className="mcp-email-row">
          <div className="mcp-email-label-row"><label htmlFor="account-email">邮箱</label>
            {!registration && emailEnabled && <button type="button" className="mcp-text-button" disabled={Boolean(busy)} onClick={() => {
              closeSecurity();
              setMode(mode === 'email' ? 'password' : 'email'); setPassword(''); setError(''); setNotice('');
            }}>{mode === 'email' ? '密码登录' : '验证码登录'}</button>}
          </div>
          <input ref={emailInput} id="account-email" type="email" required maxLength={254} autoComplete="email"
            value={registration?.email || email} readOnly={Boolean(registration)} onChange={event => changeEmail(event.target.value)}
            aria-describedby={error ? 'account-error' : undefined} />
          {!registration && mode === 'email' && <div className="mcp-send-code">
            <button type="button" disabled={Boolean(busy) || wait > 0 || !email} onClick={() => openSecurity('email-code')}>
              {busy === 'email-code' ? '正在发送…' : delivery ? '重新发送' : '发送验证码'}
            </button><span className="mcp-retry-countdown" aria-live="polite">{wait > 0 ? `${wait}秒后重试` : ''}</span>
          </div>}
        </div>
        {error && mode !== 'password' && <p id="account-error" className="mcp-error" role="alert">{error}</p>}
        {registration || mode === 'password'
          ? <label htmlFor="account-password">密码<input id="account-password" type="password" required minLength={registration ? passwordMinLength : 1} maxLength={128}
            autoComplete={registration ? 'new-password' : 'current-password'} value={password} onChange={event => setPassword(event.target.value)}
            placeholder={registration ? `${passwordMinLength}–128 个字符` : '请输入密码'} /></label>
          : <label htmlFor="account-code">邮件验证码<input id="account-code" required inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code"
            value={code} onChange={event => setCode(event.target.value.replace(/\D/g, ''))} placeholder="6 位数字，10 分钟内有效" /></label>}
        <button type="submit" disabled={Boolean(busy) || (registration ? password.length < passwordMinLength
          : mode === 'password' ? !password : !codeReady)}>
          {busy && busy !== 'email-code' ? '正在处理…' : registration ? '创建账号并登录' : mode === 'password' ? '登录' : '继续'}
        </button>
      </fieldset>
    </form>
    {pendingAction && <ModalDialog open onClose={closeSecurity} className="mcp-security-dialog" aria-labelledby="account-security-title">
      <h3 id="account-security-title">{pendingAction === 'login' ? '登录前安全验证' : '发送前安全验证'}</h3>
      <form onSubmit={event => { event.preventDefault(); void submit(pendingAction); }}>
        <fieldset disabled={Boolean(busy)}>
          <div className="mcp-captcha-row">
            <label htmlFor="account-captcha">图形验证码<input id="account-captcha" inputMode="numeric" maxLength={5} autoComplete="off" placeholder="5 位数字"
              required value={captchaAnswer} onChange={event => setCaptchaAnswer(event.target.value.replace(/\D/g, ''))}
              aria-describedby="account-captcha-error" /></label>
            <div className="mcp-captcha-image" aria-busy={captchaLoading}>
              {captcha && <img src={captcha.image} alt="图形验证码" width="140" height="48" onError={() => {
                setCaptchaValid(false); setCaptchaError('验证码图片无法显示，请刷新或联系管理员。');
              }} />}
              {captchaLoading && <span className="mcp-captcha-overlay" role="status" aria-label="正在刷新图形验证码"><span className="mcp-spinner" /></span>}
            </div>
            <button type="button" className="mcp-secondary mcp-captcha-refresh" aria-label="刷新图形验证码" disabled={captchaLoading}
              onClick={() => { setCaptchaError(''); setCaptchaReload(value => value + 1); }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 3M18 17a7 7 0 0 1-12 1l-2-3" />
              </svg>
            </button>
          </div>
          <p id="account-captcha-error" className="mcp-captcha-error" role={captchaError ? 'alert' : undefined}>{captchaError || '\u00a0'}</p>
          <button type="submit" disabled={!graphicReady || Boolean(busy)}>
            {busy ? '正在验证…' : pendingAction === 'login' ? '验证并登录' : '验证并发送'}
          </button>
        </fieldset>
      </form>
      <button type="button" className="mcp-secondary mcp-security-cancel" onClick={closeSecurity}>取消</button>
    </ModalDialog>}
    <div className="mcp-manual-actions">
      {registration && <button type="button" disabled={Boolean(busy)} onClick={() => {
        setRegistration(null); setPassword(''); setError(''); setNotice('');
      }}>重新验证邮箱</button>}
      <ContactAdminButton />
    </div>
  </div>;
}
