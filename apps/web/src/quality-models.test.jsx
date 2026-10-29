import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import QualityToolsPage from './QualityToolsPage.jsx';
import { catalog } from './quality-test-fixtures.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const change = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const tick = () => act(() => vi.advanceTimersByTimeAsync(500));
async function setup(resolveModels = () => Response.json({ models: ['model-a', 'model-b'] })) {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    if (url === '/api/quality/catalog') return Response.json(catalog);
    if (url === '/api/quality/models') { calls.push({ url, ...options }); return resolveModels(options, calls.length); }
    return Response.json({}, { status: 404 });
  }));
  await act(async () => { render(<QualityToolsPage />); });
  return calls;
}

test('valid URL and key automatically load selectable models after typing settles', async () => {
  const calls = await setup();
  change('被测 Base URL', 'not-a-url'); change('API Key', 'private-key'); await tick();
  expect(calls).toHaveLength(0);
  change('被测 Base URL', 'https://relay.example/v1/');
  change('API Key', 'first-key'); change('API Key', 'private-key');
  expect(calls).toHaveLength(0);
  await tick();
  expect(calls).toHaveLength(1);
  expect(calls[0].method).toBe('POST');
  expect(JSON.parse(calls[0].body)).toEqual({ endpoint: 'https://relay.example/v1', apiKey: 'private-key' });
  expect(calls[0].url).not.toContain('private-key');
  const model = screen.getByLabelText('目标模型');
  expect([...document.getElementById(model.getAttribute('list')).options].map(option => option.value)).toEqual(['model-a', 'model-b']);
  expect(screen.getByText('已获取 2 个模型')).toBeVisible();
  change('目标模型', 'model-b'); expect(model).toHaveValue('model-b');
  change('目标模型', 'custom-model'); expect(model).toHaveValue('custom-model');
});

test('editing credentials cancels discovery and ignores late responses without overwriting a manual model', async () => {
  const pending = [];
  const calls = await setup(() => new Promise(resolve => pending.push(resolve)));
  change('被测 Base URL', 'https://first.example/v1'); change('API Key', 'first-key');
  change('目标模型', 'manual-model'); await tick();
  change('API Key', 'second-key');
  expect(calls[0].signal.aborted).toBe(true);
  await tick();
  await act(async () => { pending[1](Response.json({ models: ['new-model'] })); });
  await act(async () => { pending[0](Response.json({ models: ['stale-model'] })); });
  const model = screen.getByLabelText('目标模型');
  expect([...document.getElementById(model.getAttribute('list')).options].map(option => option.value)).toEqual(['new-model']);
  expect(model).toHaveValue('manual-model');
  change('API Key', '');
  expect(document.getElementById(model.getAttribute('list')).options).toHaveLength(0);
});

test('failed model discovery allows manual input and an explicit retry without echoing upstream errors', async () => {
  const calls = await setup((_options, count) => count === 1 ? new Response('private-key upstream failure', { status: 502 }) : Response.json({ models: ['recovered-model'] }));
  change('被测 Base URL', 'https://relay.example/v1'); change('API Key', 'private-key'); await tick();
  expect(screen.getByText('获取失败，可手动输入模型')).toBeVisible();
  expect(document.body).not.toHaveTextContent('upstream failure');
  change('目标模型', 'manual-model');
  expect(screen.getByLabelText('目标模型')).toHaveValue('manual-model');
  fireEvent.click(screen.getByRole('button', { name: '重新获取模型列表' })); await tick();
  expect(calls).toHaveLength(2);
  expect(screen.getByText('已获取 1 个模型')).toBeVisible();
  expect(screen.getByLabelText('目标模型')).toHaveValue('manual-model');
});

test('leaving the AI tool aborts an outstanding discovery request', async () => {
  const calls = await setup(() => new Promise(() => {}));
  change('被测 Base URL', 'https://relay.example/v1'); change('API Key', 'private-key'); await tick();
  fireEvent.click(screen.getByRole('tab', { name: 'IP检测' }));
  expect(calls[0].signal.aborted).toBe(true);
});

test('an empty model list leaves manual input available with an explicit retry', async () => {
  await setup(() => Response.json({ models: [] }));
  change('被测 Base URL', 'https://relay.example/v1'); change('API Key', 'private-key'); await tick();
  expect(screen.getByText('未返回模型，可手动输入')).toBeVisible();
  expect(screen.getByRole('button', { name: '重新获取模型列表' })).toBeEnabled();
  change('目标模型', 'manual-model'); expect(screen.getByLabelText('目标模型')).toHaveValue('manual-model');
});
