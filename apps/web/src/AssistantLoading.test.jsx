import React from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import AssistantWidget from './AssistantWidget.jsx';
import App from './App.jsx';

const assistantChunk = vi.hoisted(() => {
  let resolve;
  const ready = new Promise(done => { resolve = done; });
  return { ready, resolve };
});
vi.mock('./AssistantPage.jsx', async () => {
  await assistantChunk.ready;
  return { default: () => <h1>助手已就绪</h1> };
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test('first open shows only a skeleton and remains dismissible while the module downloads', async () => {
  Object.defineProperty(HTMLDialogElement.prototype, 'show', {
    configurable: true, value: function () { this.open = true; },
  });
  render(<AssistantWidget api={{ status: async () => ({ enabled: true }) }} />);
  const launcher = await screen.findByRole('button', { name: '打开导购助手' });
  fireEvent.click(launcher);
  const dialog = screen.getByRole('dialog', { name: '导购助手' });
  expect(within(dialog).getByRole('heading', { name: '选购' })).toBeVisible();
  expect(within(dialog).queryByRole('heading', { name: '想用来做什么？' })).not.toBeInTheDocument();
  expect(within(dialog).queryByRole('button', { name: '写代码' })).not.toBeInTheDocument();
  expect(within(dialog).getByRole('status', { name: '正在加载导购助手' })).toBeVisible();
  expect(within(dialog).getByRole('status')).toHaveTextContent('');
  const collapse = within(dialog).getByRole('button', { name: '收起导购助手' });
  expect(collapse).toHaveFocus();
  fireEvent.click(collapse);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(launcher).toHaveFocus();
  fireEvent.click(launcher);
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('standalone route keeps navigation and a skeleton visible until the module is ready', async () => {
  window.history.replaceState({}, '', '/assistant');
  render(<App />);
  expect(screen.getByRole('main')).toBeVisible();
  expect(screen.getByRole('link', { name: '选购指南' })).toHaveAttribute('href', '/guide');
  expect(screen.getByRole('status', { name: '正在加载导购助手' })).toBeVisible();
  expect(screen.queryByRole('heading', { name: '想用来做什么？' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '收起导购助手' })).not.toBeInTheDocument();
  await act(async () => assistantChunk.resolve());
  expect(await screen.findByRole('heading', { name: '助手已就绪' })).toBeVisible();
  expect(screen.queryByRole('status', { name: '正在加载导购助手' })).not.toBeInTheDocument();
});
