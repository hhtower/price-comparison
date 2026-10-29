import React from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PublicPage from './PublicPage.jsx';

let clipboardDescriptor;
let execCommandDescriptor;
beforeEach(() => {
  clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  execCommandDescriptor = Object.getOwnPropertyDescriptor(document, 'execCommand');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ items: [], platformFacets: [], tagFacets: [] })));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
  else delete navigator.clipboard;
  if (execCommandDescriptor) Object.defineProperty(document, 'execCommand', execCommandDescriptor);
  else delete document.execCommand;
});

async function openCommunity(user) {
  render(<PublicPage />);
  await user.click(screen.getByRole('button', { name: 'QQ 交流群', exact: true }));
  return within(screen.getByRole('dialog', { name: 'QQ 交流群' }));
}

test('provides a labelled GitHub icon link that opens the project safely in a new tab', () => {
  render(<PublicPage />);
  const github = screen.getByRole('link', { name: 'GitHub 开源仓库' });
  expect(github).toHaveAttribute('href', 'https://github.com/hhtower/price-comparison');
  expect(github).toHaveAttribute('target', '_blank');
  expect(github.rel.split(/\s+/u)).toEqual(expect.arrayContaining(['noopener', 'noreferrer']));
});

test('opens the community from the homepage with a selectable number and downloadable QR image', async () => {
  const user = userEvent.setup();
  render(<PublicPage />);
  expect(screen.queryByRole('img', { name: 'QQ 群二维码' })).not.toBeInTheDocument();
  const trigger = screen.getByRole('button', { name: 'QQ 交流群', exact: true });
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  trigger.focus();
  await user.keyboard('{Enter}');
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const modal = within(screen.getByRole('dialog', { name: 'QQ 交流群' }));
  expect(modal.getByRole('textbox', { name: 'QQ 群号' })).toHaveValue('346347792');
  expect(modal.getByRole('textbox', { name: 'QQ 群号' })).toHaveAttribute('readonly');
  const image = modal.getByRole('img', { name: 'QQ 群二维码' });
  expect(modal.getByRole('link', { name: '保存二维码' })).toHaveAttribute('href', image.getAttribute('src'));
  expect(modal.getByRole('link', { name: '保存二维码' })).toHaveAttribute('download', '知途拾价-QQ群二维码.png');
  await user.click(modal.getByRole('button', { name: '关闭交流群弹窗' }));
  expect(screen.queryByRole('dialog', { name: 'QQ 交流群' })).not.toBeInTheDocument();
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(trigger).toHaveFocus();
});

test('copies the actual group number and announces success only after the clipboard write succeeds', async () => {
  const user = userEvent.setup();
  const modal = await openCommunity(user);
  await user.click(modal.getByRole('button', { name: '复制群号' }));
  expect(await navigator.clipboard.readText()).toBe('346347792');
  expect(modal.getByRole('status')).toHaveTextContent('群号已复制');
  expect(modal.getByRole('button', { name: '已复制' })).toBeEnabled();
});

test.each(['missing', 'denied'])('falls back to selecting and copying the number when Clipboard API is %s', async failure => {
  const user = userEvent.setup();
  const modal = await openCommunity(user);
  if (failure === 'missing') Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  else vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));
  let copiedText;
  Object.defineProperty(document, 'execCommand', { configurable: true, value: command => {
    if (command !== 'copy') return false;
    const input = document.activeElement;
    copiedText = input.value.slice(input.selectionStart, input.selectionEnd);
    return true;
  } });
  await user.click(modal.getByRole('button', { name: '复制群号' }));
  expect(copiedText).toBe('346347792');
  expect(modal.getByRole('status')).toHaveTextContent('群号已复制');
});

test('keeps the number selected for manual copy when browser copying fails', async () => {
  const user = userEvent.setup();
  const modal = await openCommunity(user);
  vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('Blocked'));
  Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false });
  await user.click(modal.getByRole('button', { name: '复制群号' }));
  const number = modal.getByRole('textbox', { name: 'QQ 群号' });
  expect(number).toHaveFocus();
  expect(number.value.slice(number.selectionStart, number.selectionEnd)).toBe('346347792');
  expect(modal.getByRole('alert')).toHaveTextContent(/复制失败.*手动复制/);
  expect(modal.queryByRole('button', { name: '已复制' })).not.toBeInTheDocument();
});

test('ignores a pending clipboard completion after the dialog is closed and reopened', async () => {
  const user = userEvent.setup();
  let complete;
  const modal = await openCommunity(user);
  vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  await user.click(modal.getByRole('button', { name: '复制群号' }));
  expect(modal.getByRole('button', { name: '复制中…' })).toBeDisabled();
  await user.click(modal.getByRole('button', { name: '关闭交流群弹窗' }));
  await user.click(screen.getByRole('button', { name: 'QQ 交流群', exact: true }));
  await act(async () => complete());
  const reopened = within(screen.getByRole('dialog', { name: 'QQ 交流群' }));
  expect(reopened.getByRole('button', { name: '复制群号' })).toBeEnabled();
  expect(reopened.getByRole('status')).not.toHaveTextContent('已复制');
});

test('allows group-number copying if the QR image fails to load', async () => {
  const user = userEvent.setup();
  const modal = await openCommunity(user);
  fireEvent.error(modal.getByRole('img', { name: 'QQ 群二维码' }));
  expect(modal.getByRole('alert')).toHaveTextContent(/二维码.*群号/);
  expect(modal.queryByRole('link', { name: '保存二维码' })).not.toBeInTheDocument();
  await user.click(modal.getByRole('button', { name: '复制群号' }));
  expect(await navigator.clipboard.readText()).toBe('346347792');
});

test('Escape closes only the community dialog and preserves the expanded desktop filters', async () => {
  const user = userEvent.setup();
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  render(<PublicPage />);
  await user.click(screen.getByRole('button', { name: '筛选', exact: true }));
  await user.click(screen.getByRole('button', { name: 'QQ 交流群', exact: true }));
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog', { name: 'QQ 交流群' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '筛选', exact: true })).toHaveAttribute('aria-expanded', 'true');
});
