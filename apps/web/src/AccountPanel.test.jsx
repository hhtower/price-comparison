import React from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AccountPanel from './AccountPanel.jsx';

const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const USER = { id: 'account-1', email: 'dev@example.com' };
const calls = [];
let handler;
const requests = suffix => calls.filter(call => call.path.endsWith(suffix));
beforeEach(() => {
  handler = null;
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (path, options) => {
    const body = options?.body && JSON.parse(options.body);
    calls.push({ path, body, signal: options?.signal });
    const response = handler?.(path, body, options);
    if (response) return response;
    if (path === '/api/mcp/captcha') return Response.json({
      id: String.fromCharCode(96 + requests('/captcha').length).repeat(43), image: IMAGE, expiresInSeconds: 300,
    });
    if (path === '/api/account/email-code') return Response.json({
      challengeId: 'challenge-1', retryToken: 'retry-1', retryAfterSeconds: 60, expiresInSeconds: 600,
    });
    if (path === '/api/account/verify-email') return Response.json({ registrationToken: 'registration-1', email: USER.email });
    if (path === '/api/account/register' || path === '/api/account/login') return Response.json({ user: USER });
    throw new Error(`Unexpected request: ${path}`);
  }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function enterEmail() {
  fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: USER.email } });
}
async function click(name) {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name })); });
}
async function confirmSecurity(answer = '12345', name = '验证并发送') {
  fireEvent.change(screen.getByLabelText('图形验证码'), { target: { value: answer } });
  await click(name);
}
async function send() {
  enterEmail();
  await click('发送验证码');
  await confirmSecurity();
}

test('main forms have no graphic field or captcha fetch until an action opens the dialog', async () => {
  render(<AccountPanel onAuthenticated={vi.fn()} />);
  expect(screen.getByLabelText('邮件验证码')).toHaveAttribute('autocomplete', 'one-time-code');
  expect(screen.getByLabelText('邮件验证码')).toHaveAttribute('maxlength', '6');
  expect(screen.queryByLabelText('图形验证码')).not.toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await click('密码登录');
  expect(screen.getByLabelText('密码')).toHaveAttribute('autocomplete', 'current-password');
  expect(screen.queryByLabelText('图形验证码')).not.toBeInTheDocument();
  expect(calls).toHaveLength(0);
});

test('opening validates email, does not send mail, and cancelling restores focus without losing inputs', async () => {
  const user = userEvent.setup();
  render(<AccountPanel onAuthenticated={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'invalid' } });
  await click('发送验证码');
  expect(calls).toHaveLength(0);
  enterEmail();
  fireEvent.change(screen.getByLabelText('邮件验证码'), { target: { value: '123456' } });
  await user.click(screen.getByRole('button', { name: '发送验证码' }));
  const dialog = screen.getByRole('dialog', { name: '发送前安全验证' });
  expect(dialog.tagName).toBe('DIALOG');
  expect(dialog.closest('form')).toBeNull();
  expect(dialog.querySelector('form form')).toBeNull();
  expect(dialog).toContainElement(document.activeElement);
  expect(requests('/captcha')).toHaveLength(1);
  expect(requests('/email-code')).toHaveLength(0);
  expect(screen.getByRole('button', { name: '验证并发送' })).toBeDisabled();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '发送验证码' })).toHaveFocus();
  expect(screen.getByLabelText('邮箱')).toHaveValue(USER.email);
  expect(screen.getByLabelText('邮件验证码')).toHaveValue('123456');
  expect(requests('/email-code')).toHaveLength(0);
  await click('发送验证码');
  await click('取消');
  expect(requests('/captcha')).toHaveLength(2);
  expect(requests('/email-code')).toHaveLength(0);
});

test('verifies email then registers directly with one password and no additional graphic challenge', async () => {
  const authenticated = vi.fn();
  const persist = vi.spyOn(Storage.prototype, 'setItem');
  render(<AccountPanel onAuthenticated={authenticated} />);
  await send();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('图形验证码')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('密码')).not.toBeInTheDocument();
  expect(screen.getByText('60秒后重试')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('邮件验证码'), { target: { value: '123456' } });
  await click('继续');
  const password = screen.getByLabelText('密码');
  expect(password).toHaveAttribute('minlength', '12');
  expect(password).toHaveAttribute('maxlength', '128');
  expect(password).toHaveAttribute('autocomplete', 'new-password');
  expect(document.querySelectorAll('input[type="password"]')).toHaveLength(1);
  fireEvent.change(password, { target: { value: 'secure-password-123' } });
  await click('创建账号并登录');
  expect(authenticated).toHaveBeenCalledWith(USER);
  expect(requests('/email-code')[0].body).toEqual({
    email: USER.email, captchaId: 'a'.repeat(43), captchaAnswer: '12345',
  });
  expect(requests('/verify-email')[0].body).toEqual({ challengeId: 'challenge-1', code: '123456' });
  expect(requests('/register')[0].body).toEqual({
    registrationToken: 'registration-1', password: 'secure-password-123',
  });
  expect(requests('/captcha')).toHaveLength(1);
  expect(persist).not.toHaveBeenCalled();
  expect(window.location.href).not.toMatch(/registration-1|retry-1|123456|secure-password/);
});

test('an existing email authenticates after mail verification without an optional graphic validity blocker', async () => {
  handler = path => path.endsWith('/verify-email') && Response.json({ user: USER });
  const authenticated = vi.fn();
  const user = userEvent.setup();
  render(<AccountPanel onAuthenticated={authenticated} />);
  await send();
  await click('密码登录');
  await click('验证码登录');
  await user.type(screen.getByLabelText('邮件验证码'), '123456');
  await user.click(screen.getByRole('button', { name: '继续' }));
  await waitFor(() => expect(authenticated).toHaveBeenCalledWith(USER));
  expect(requests('/captcha')).toHaveLength(1);
  expect(requests('/register')).toHaveLength(0);
});

test('disabled email delivery still gates password login with the same safe dialog', async () => {
  const authenticated = vi.fn();
  render(<AccountPanel emailEnabled={false} onAuthenticated={authenticated} />);
  enterEmail();
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'saved-password-123' } });
  expect(screen.queryByRole('button', { name: '发送验证码' })).not.toBeInTheDocument();
  expect(calls).toHaveLength(0);
  await click('登录');
  expect(screen.getByRole('dialog', { name: '登录前安全验证' })).toBeInTheDocument();
  expect(requests('/login')).toHaveLength(0);
  await confirmSecurity('54321', '验证并登录');
  expect(authenticated).toHaveBeenCalledWith(USER);
  expect(requests('/login')[0].body).toEqual({
    email: USER.email, password: 'saved-password-123', captchaId: 'a'.repeat(43), captchaAnswer: '54321',
  });
  expect(requests('/email-code')).toHaveLength(0);
});

test.each([
  [403, 'ACCOUNT_EMAIL_BLOCKED', 120], [429, 'ACCOUNT_EMAIL_COOLDOWN', 120],
  [503, 'ACCOUNT_EMAIL_FAILED', 120],
])('a %s/%s error preserves inputs, honors %s seconds, and requires a fresh captcha with retry proof', async (status, errorCode, seconds) => {
  vi.useFakeTimers();
  handler = path => path.endsWith('/email-code') && Response.json({
    error: { code: errorCode, message: 'private SMTP details', details: { retryToken: 'retry-on-error', retryAfterSeconds: seconds } },
  }, { status });
  render(<AccountPanel onAuthenticated={vi.fn()} />);
  enterEmail();
  fireEvent.change(screen.getByLabelText('邮件验证码'), { target: { value: '123456' } });
  await click('发送验证码');
  await confirmSecurity();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByLabelText('邮箱')).toHaveValue(USER.email);
  expect(screen.getByLabelText('邮件验证码')).toHaveValue('123456');
  expect(screen.getByText(`${seconds}秒后重试`)).toBeInTheDocument();
  expect(screen.getAllByRole('alert')).toHaveLength(1);
  expect(screen.getByRole('alert')).not.toHaveTextContent('private SMTP');
  expect(screen.getByLabelText('邮箱')).toHaveAccessibleDescription(screen.getByRole('alert').textContent);
  expect(screen.getByRole('button', { name: '重新发送' })).toBeDisabled();
  act(() => { vi.setSystemTime(Date.now() + (seconds - 1) * 1000); vi.advanceTimersByTime(1000); });
  handler = null;
  await click('重新发送');
  expect(requests('/email-code')).toHaveLength(1);
  await confirmSecurity('54321');
  expect(requests('/email-code')[1].body).toEqual({
    email: USER.email, retryToken: 'retry-on-error', captchaId: 'b'.repeat(43), captchaAnswer: '54321',
  });
  expect(requests('/captcha')).toHaveLength(2);
});

test.each([60, 120, 240, 480, 600])('uses the server %s-second deadline and a new captcha for a successful resend', async seconds => {
  vi.useFakeTimers();
  handler = path => path.endsWith('/email-code') && Response.json({
    challengeId: 'challenge-1', retryToken: 'retry-1', retryAfterSeconds: seconds, expiresInSeconds: 600,
  });
  render(<AccountPanel onAuthenticated={vi.fn()} />);
  await send();
  expect(screen.getByText(`${seconds}秒后重试`)).toBeInTheDocument();
  act(() => { vi.setSystemTime(Date.now() + (seconds - 5) * 1000); vi.advanceTimersByTime(1000); });
  expect(screen.getByText('4秒后重试')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '重新发送' })).toBeDisabled();
  act(() => vi.advanceTimersByTime(4000));
  await click('重新发送');
  expect(requests('/email-code')).toHaveLength(1);
  await confirmSecurity('54321');
  expect(requests('/email-code')[1].body).toEqual({
    email: USER.email, retryToken: 'retry-1', captchaId: 'b'.repeat(43), captchaAnswer: '54321',
  });
});

test('editing email discards its mail challenge and retry credential without eagerly fetching captcha', async () => {
  render(<AccountPanel onAuthenticated={vi.fn()} />);
  await send();
  fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'other@example.com' } });
  expect(screen.queryByText('60秒后重试')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '继续' })).toBeDisabled();
  expect(requests('/captcha')).toHaveLength(1);
  await click('发送验证码');
  await confirmSecurity('54321');
  expect(requests('/email-code')[1].body).toEqual({
    email: 'other@example.com', captchaId: 'b'.repeat(43), captchaAnswer: '54321',
  });
});

test('an expired retry proof is cleared but the next attempt still needs fresh captcha without losing mail input', async () => {
  vi.useFakeTimers();
  render(<AccountPanel onAuthenticated={vi.fn()} />);
  await send();
  fireEvent.change(screen.getByLabelText('邮件验证码'), { target: { value: '123456' } });
  act(() => vi.advanceTimersByTime(60_000));
  handler = path => path.endsWith('/email-code') && Response.json({ error: { code: 'ACCOUNT_RETRY_INVALID' } }, { status: 403 });
  await click('重新发送');
  await confirmSecurity();
  expect(screen.getByLabelText('邮箱')).toHaveValue(USER.email);
  expect(screen.getByLabelText('邮件验证码')).toHaveValue('123456');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(requests('/captcha')).toHaveLength(2);
  handler = null;
  await click('重新发送');
  await confirmSecurity('54321');
  expect(requests('/email-code')[2].body).toEqual({
    email: USER.email, captchaId: 'c'.repeat(43), captchaAnswer: '54321',
  });
});

test('password login failures preserve credentials and the next login opens a new challenge', async () => {
  handler = path => path.endsWith('/login') && Response.json({ error: { message: 'internal credential details' } }, { status: 403 });
  const authenticated = vi.fn();
  render(<AccountPanel onAuthenticated={authenticated} />);
  enterEmail();
  await click('密码登录');
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'saved-password-123' } });
  await click('登录');
  await confirmSecurity('12345', '验证并登录');
  expect(screen.getByRole('alert')).not.toHaveTextContent('internal credential');
  expect(screen.getByLabelText('密码')).toHaveValue('saved-password-123');
  expect(screen.getByLabelText('邮箱')).toHaveValue(USER.email);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  handler = null;
  await click('登录');
  await confirmSecurity('54321', '验证并登录');
  expect(authenticated).toHaveBeenCalledWith(USER);
  expect(requests('/login')[1].body.captchaId).toBe('b'.repeat(43));
});

test('a captcha 400 stays local, refreshes the challenge, and preserves the email and mail code', async () => {
  handler = path => path.endsWith('/email-code') && Response.json({ error: { code: 'MCP_CAPTCHA_INVALID' } }, { status: 400 });
  render(<AccountPanel onAuthenticated={vi.fn()} />);
  enterEmail();
  fireEvent.change(screen.getByLabelText('邮件验证码'), { target: { value: '123456' } });
  await click('发送验证码');
  await confirmSecurity();
  const dialog = screen.getByRole('dialog', { name: '发送前安全验证' });
  expect(dialog).toContainElement(screen.getByRole('alert'));
  expect(screen.getAllByRole('alert')).toHaveLength(1);
  expect(screen.getByRole('alert')).toHaveTextContent('验证码');
  expect(screen.getByLabelText('图形验证码')).toHaveValue('');
  expect(screen.getByLabelText('邮件验证码')).toHaveValue('123456');
  expect(requests('/captcha')).toHaveLength(2);
  handler = null;
  await confirmSecurity('54321');
  expect(requests('/email-code')[1].body.captchaId).toBe('b'.repeat(43));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('a network failure consumes the graphic proof and next opening fetches a fresh one', async () => {
  handler = path => path.endsWith('/email-code') && Promise.reject(new Error('offline'));
  render(<AccountPanel onAuthenticated={vi.fn()} />);
  await send();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('alert')).toBeInTheDocument();
  expect(screen.getByLabelText('邮箱')).toHaveValue(USER.email);
  handler = null;
  await click('发送验证码');
  expect(screen.getByLabelText('图形验证码')).toHaveValue('');
  await confirmSecurity('54321');
  expect(requests('/email-code')[1].body.captchaId).toBe('b'.repeat(43));
});

test('refresh retains the old image in a fixed rectangle with an icon button and spinner overlay', async () => {
  render(<AccountPanel onAuthenticated={vi.fn()} />);
  enterEmail();
  await click('发送验证码');
  const image = screen.getByRole('img', { name: '图形验证码' });
  expect(image).toHaveAttribute('width', '140');
  expect(image).toHaveAttribute('height', '48');
  const rectangle = image.parentElement;
  const refresh = screen.getByRole('button', { name: '刷新图形验证码' });
  expect(refresh).toHaveTextContent('');
  let resolve;
  handler = path => path === '/api/mcp/captcha' && new Promise(done => { resolve = done; });
  fireEvent.change(screen.getByLabelText('图形验证码'), { target: { value: '12345' } });
  await click('刷新图形验证码');
  expect(image).toBeInTheDocument();
  expect(image).toHaveAttribute('src', IMAGE);
  expect(rectangle).toHaveAttribute('aria-busy', 'true');
  expect(screen.getByLabelText('正在刷新图形验证码')).toBeInTheDocument();
  expect(refresh).toBeDisabled();
  expect(screen.getByRole('button', { name: '验证并发送' })).toBeDisabled();
  await act(async () => resolve(Response.json({ error: {} }, { status: 503 })));
  expect(rectangle).toHaveAttribute('aria-busy', 'false');
  expect(image).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('验证码');
});

test('captcha failures allow keyboard refresh and invalid images cannot authorize sending', async () => {
  handler = path => path === '/api/mcp/captcha' && Response.json({ error: {} }, { status: 503 });
  const user = userEvent.setup();
  render(<AccountPanel onAuthenticated={vi.fn()} />);
  enterEmail();
  await click('发送验证码');
  expect(document.querySelector('.mcp-captcha-image')).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('验证码');
  handler = null;
  screen.getByRole('button', { name: '刷新图形验证码' }).focus();
  await user.keyboard('{Enter}');
  const image = await screen.findByRole('img', { name: '图形验证码' });
  fireEvent.error(image);
  fireEvent.change(screen.getByLabelText('图形验证码'), { target: { value: '12345' } });
  expect(screen.getByRole('button', { name: '验证并发送' })).toBeDisabled();
  await click('取消');
  await click('进群联系管理员');
  expect(screen.getByRole('dialog', { name: 'QQ 交流群' })).toBeInTheDocument();
});

test.each(['https://external.example/captcha.png', 'data:image/svg+xml;base64,AAAA'])('rejects unsafe captcha image %s', async image => {
  handler = path => path === '/api/mcp/captcha' && Response.json({ id: 'a'.repeat(43), image, expiresInSeconds: 300 });
  render(<AccountPanel onAuthenticated={vi.fn()} />);
  enterEmail();
  await click('发送验证码');
  expect(screen.getByRole('alert')).toHaveTextContent('验证码');
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '验证并发送' })).toBeDisabled();
});

test('expired graphic and mail codes block submission without clearing the email', async () => {
  vi.useFakeTimers();
  render(<AccountPanel onAuthenticated={vi.fn()} />);
  enterEmail();
  await click('发送验证码');
  fireEvent.change(screen.getByLabelText('图形验证码'), { target: { value: '12345' } });
  act(() => vi.advanceTimersByTime(300_000));
  expect(screen.getByRole('button', { name: '验证并发送' })).toBeDisabled();
  expect(screen.getByRole('alert')).toHaveTextContent('过期');
  await click('刷新图形验证码');
  await confirmSecurity('54321');
  fireEvent.change(screen.getByLabelText('邮件验证码'), { target: { value: '123456' } });
  expect(screen.getByRole('button', { name: '继续' })).toBeEnabled();
  act(() => vi.advanceTimersByTime(600_000));
  expect(screen.getByRole('button', { name: '继续' })).toBeDisabled();
  expect(screen.getByLabelText('邮箱')).toHaveValue(USER.email);
});

test('a busy send cannot submit twice; cancellation aborts and ignores the late result', async () => {
  let resolve;
  handler = path => path.endsWith('/email-code') && new Promise(done => { resolve = done; });
  render(<AccountPanel onAuthenticated={vi.fn()} />);
  await send();
  expect(screen.getByRole('button', { name: '正在发送…' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '正在验证…' })).toBeDisabled();
  fireEvent.submit(screen.getByLabelText('图形验证码').closest('form'));
  expect(requests('/email-code')).toHaveLength(1);
  await click('取消');
  expect(requests('/email-code')[0].signal.aborted).toBe(true);
  await act(async () => resolve(Response.json({
    challengeId: 'late-challenge', retryToken: 'late-retry', retryAfterSeconds: 60, expiresInSeconds: 600,
  })));
  expect(screen.queryByText('60秒后重试')).not.toBeInTheDocument();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '发送验证码' })).toBeEnabled();
});

test.each(['cancel', 'mode', 'pagehide', 'unmount'])('pending captcha is aborted on %s and its late response is ignored', async reason => {
  let resolve;
  handler = path => path === '/api/mcp/captcha' && new Promise(done => { resolve = done; });
  const { unmount } = render(<AccountPanel onAuthenticated={vi.fn()} />);
  enterEmail();
  await click('发送验证码');
  const pending = requests('/captcha')[0];
  if (reason === 'cancel') await click('取消');
  if (reason === 'mode') await click('密码登录');
  if (reason === 'pagehide') fireEvent(window, new PageTransitionEvent('pagehide', { persisted: true }));
  if (reason === 'unmount') unmount();
  expect(pending.signal.aborted).toBe(true);
  await act(async () => resolve(Response.json({ id: 'a'.repeat(43), image: IMAGE, expiresInSeconds: 300 })));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  expect(requests('/email-code')).toHaveLength(0);
});

test('pagehide clears credentials and aborts registration; pageshow does not fetch captcha or resend', async () => {
  const authenticated = vi.fn();
  render(<AccountPanel onAuthenticated={authenticated} />);
  await send();
  fireEvent.change(screen.getByLabelText('邮件验证码'), { target: { value: '123456' } });
  await click('继续');
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secure-password-123' } });
  let resolve;
  handler = path => path.endsWith('/register') && new Promise(done => { resolve = done; });
  await click('创建账号并登录');
  const pending = requests('/register')[0];
  fireEvent(window, new PageTransitionEvent('pagehide', { persisted: true }));
  expect(pending.signal.aborted).toBe(true);
  expect(screen.queryByLabelText('密码')).not.toBeInTheDocument();
  expect(screen.getByLabelText('邮件验证码')).toHaveValue('');
  expect(screen.queryByLabelText('图形验证码')).not.toBeInTheDocument();
  expect(screen.getByLabelText('邮箱')).toHaveValue(USER.email);
  fireEvent(window, new PageTransitionEvent('pageshow', { persisted: true }));
  await act(async () => resolve(Response.json({ user: USER })));
  expect(authenticated).not.toHaveBeenCalled();
  expect(requests('/email-code')).toHaveLength(1);
  expect(requests('/captcha')).toHaveLength(1);
  expect(screen.getByRole('button', { name: '发送验证码' })).toBeEnabled();
});
