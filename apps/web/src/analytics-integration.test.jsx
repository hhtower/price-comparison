import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import PublicPage from './PublicPage.jsx';
import QualityToolsPage from './QualityToolsPage.jsx';
import AdminPage from './AdminPage.jsx';
import { catalog, report } from './quality-test-fixtures.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const collected = () => fetch.mock.calls.filter(([url]) => url === '/api/analytics/collect').map(([, options]) => JSON.parse(options.body));
function server() {
  vi.stubGlobal('fetch', vi.fn(async url => {
    if (url === '/api/analytics/collect') return new Response(null, { status: 204 });
    if (url === '/api/quality/catalog') return Response.json(catalog);
    if (url === '/api/quality/tasks') return Response.json({ id: 'task-1', accessToken: 'memory-secret' });
    if (url === '/api/quality/tasks/task-1') return Response.json(report('ai', 'completed'));
    return Response.json({ items: [], platformFacets: ['openai'], tagFacets: [] });
  }));
}
it('records public visits, debounced searches and filter usage without search contents', async () => {
  server(); render(<PublicPage />);
  await waitFor(() => expect(collected().some(item => item.page === 'catalog')).toBe(true));
  fireEvent.change(screen.getByLabelText('搜索商品'), { target: { value: 'private search text' } });
  await waitFor(() => expect(collected().flatMap(item => item.actions).some(item => item.name === 'search')).toBe(true));
  fireEvent.click(await screen.findByRole('button', { name: 'ChatGPT / Codex', exact: true }));
  await waitFor(() => expect(collected().flatMap(item => item.actions).some(item => item.name === 'filter')).toBe(true));
  expect(JSON.stringify(collected())).not.toContain('private search text');
});
it('records successful task creation and tool switching without credentials or targets', async () => {
  server(); render(<QualityToolsPage />);
  await waitFor(() => expect(screen.getByRole('button', { name: '展开检测项目' })).toBeEnabled());
  await waitFor(() => expect(collected().some(item => item.page === 'tools_ai')).toBe(true));
  for (const [label, value] of Object.entries({ '被测 Base URL': 'https://private.example/v1', 'API Key': 'sk-secret-value', '目标模型': 'test-model' })) fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: '开始检测' }));
  await waitFor(() => expect(collected().flatMap(item => item.actions).some(item => item.name === 'ai_test')).toBe(true));
  fireEvent.click(screen.getByRole('tab', { name: 'IP检测' }));
  await waitFor(() => expect(collected().some(item => item.page === 'tools_ip')).toBe(true));
  expect(JSON.stringify(collected())).not.toMatch(/sk-secret|private.example|test-model|memory-secret/);
});
it('keeps admin visits out of collection and exposes analytics after login', async () => {
  server(); render(<AdminPage initialAuthenticated />);
  expect(await screen.findByRole('button', { name: '访问统计' })).toBeInTheDocument();
  expect(collected()).toHaveLength(0);
});
