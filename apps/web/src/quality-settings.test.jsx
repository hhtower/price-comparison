import React from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import QualityToolsPage from './QualityToolsPage.jsx';
import { TaskProgress } from './QualityReport.jsx';
import { catalog, report } from './quality-test-fixtures.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function setup() {
  const calls = []; let current;
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    if (url === '/api/quality/catalog') return Response.json(catalog);
    if (url === '/api/quality/tasks' || url.endsWith('/retest')) {
      const body = JSON.parse(options.body); calls.push({ url, body });
      const input = body.input ?? body; const selected = body.itemIds ?? input.items;
      const items = selected.map(id => id === 'stability' && input.runs === 1
        ? { id, status: 'unrun', score: null, reason: 'insufficient-samples', summary: '观测不足，未评价请求稳定性。' }
        : { id, status: id === 'tool-calling' ? 'risk' : 'pass', score: id === 'tool-calling' ? 0 : 100, summary: '检测结果。' });
      current = report('ai', 'completed', { id: 'settings-' + calls.length, model: input.model, target: input.endpoint,
        configuration: { mode: input.mode, runs: input.runs, selected },
        items: [...(body.itemIds ? current.items.filter(item => !selected.includes(item.id)) : []), ...items] });
      return Response.json({ id: current.id, accessToken: 'settings-token' });
    }
    return Response.json(current);
  }));
  render(<QualityToolsPage />);
  await waitFor(() => expect(screen.getByRole('button', { name: '展开检测项目' })).toBeEnabled());
  for (const [label, value] of Object.entries({ '被测 Base URL': 'https://settings.example/v1', '目标模型': 'settings-model', 'API Key': 'settings-key' })) change(label, value);
  return calls;
}
function change(label, value) { fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value } }); }
async function start(name = '开始检测') {
  fireEvent.click(screen.getByRole('button', { name }));
  await screen.findByRole('region', { name: '检测报告' });
}

for (const mode of ['quick', 'standard', 'full']) for (const runs of [1, 3, 5]) {
  test(`${mode} submits exactly ${runs} runs and its selected catalog scope`, async () => {
    const calls = await setup();
    change('检测次数', String(runs)); change('检测档位', mode);
    expect(screen.getByLabelText('检测次数')).toHaveValue(String(runs));
    await start();
    const expected = catalog.ai.filter(item => item.modes.includes(mode)).map(item => item.id);
    expect(calls[0].body).toEqual({ kind: 'ai', endpoint: 'https://settings.example/v1', model: 'settings-model', apiKey: 'settings-key', mode, runs, items: expected });
    expect(screen.getByText('本次 ' + runs + ' 次')).toBeVisible();
    expect(screen.getByText('检测范围 ' + expected.length + ' 项')).toBeVisible();
    expect(document.body).not.toHaveTextContent('行为一致性');
  });
}

test('custom scope replaces defaults while preserving the chosen number of runs', async () => {
  const calls = await setup(); change('检测档位', 'quick'); change('检测次数', '5');
  fireEvent.click(screen.getByRole('button', { name: '展开检测项目' }));
  for (const name of ['模型名称一致性', '响应速度']) fireEvent.click(screen.getByRole('checkbox', { name }));
  fireEvent.click(screen.getByRole('button', { name: '应用设置' }));
  expect(screen.getByText('自定义检测 · 2 项检测')).toBeVisible();
  await start();
  expect(calls[0].body).toMatchObject({ mode: 'quick', runs: 5, items: ['connectivity', 'streaming'] });
});

test('single retest displays its actual scope and uses the newly selected runs', async () => {
  const calls = await setup(); change('检测档位', 'full'); await start();
  fireEvent.click(screen.getByRole('button', { name: /工具调用/ }));
  fireEvent.click(screen.getByRole('button', { name: '重新测试此项' }));
  expect(screen.getByText('单项重测 · 1 项检测')).toBeVisible();
  change('检测次数', '1'); change('API Key', 'new-settings-key');
  await start('开始单项重测');
  expect(calls[1].body).toMatchObject({ itemIds: ['tool-calling'], input: { mode: 'full', runs: 1, apiKey: 'new-settings-key', model: 'settings-model', endpoint: 'https://settings.example/v1' } });
  expect(screen.getByText('检测范围 1 项')).toBeVisible();
  expect(screen.getByText('报告累计 17 项')).toBeVisible();
});

test.each(['mode', 'scope'])('changing %s exits risk retest and clears the stale notice', async setting => {
  const calls = await setup(); await start();
  fireEvent.click(screen.getByRole('button', { name: '重测风险项' }));
  expect(screen.getByText('风险重测 · 1 项检测')).toBeVisible();
  change('检测次数', '5');
  if (setting === 'mode') change('检测档位', 'quick');
  else {
    fireEvent.click(screen.getByRole('button', { name: '展开检测项目' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '智商测试' }));
    fireEvent.click(screen.getByRole('button', { name: '应用设置' }));
  }
  expect(screen.queryByText(/风险项重测保留其他结果/)).not.toBeInTheDocument();
  change('API Key', 'new-settings-key'); await start();
  expect(calls[1].url).toBe('/api/quality/tasks');
  expect(calls[1].body.runs).toBe(5);
  expect(calls[1].body.items).not.toContain('iq-test');
});

test('single-run stability explains insufficient samples and allows an explicit higher-run retest', async () => {
  const calls = await setup(); change('检测次数', '1');
  expect(screen.getByText('仅检测 1 次，无法评价请求稳定性。')).toBeVisible();
  expect(screen.getByLabelText('检测次数')).toHaveAccessibleDescription('仅检测 1 次，无法评价请求稳定性。');
  await start();
  fireEvent.click(screen.getByRole('button', { name: /请求稳定性/ }));
  const dialog = screen.getByRole('dialog');
  expect(dialog).toHaveTextContent('请选择 3 次或 5 次后重新测试此项。');
  expect(within(dialog).queryByRole('button', { name: '加入完整检测后重跑' })).not.toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole('button', { name: '重新测试此项' }));
  expect(screen.getByLabelText('检测次数')).toHaveValue('1');
  change('检测次数', '3'); change('API Key', 'new-settings-key');
  expect(screen.queryByText('仅检测 1 次，无法评价请求稳定性。')).not.toBeInTheDocument();
  expect(screen.getByLabelText('检测次数')).not.toHaveAttribute('aria-describedby');
  await start('开始单项重测');
  expect(calls[1].body).toMatchObject({ itemIds: ['stability'], input: { runs: 3 } });
  expect(screen.getByRole('button', { name: /请求稳定性/ })).toHaveTextContent('100');
});

test('insufficient samples count as a resolved check in live task progress', () => {
  const snapshot = report('ai', 'running', { configuration: { mode: 'full', runs: 1, selected: ['stability', 'iq-test'] }, items: [
    { id: 'stability', status: 'unrun', score: null, reason: 'insufficient-samples', summary: '观测不足，未评价请求稳定性。' },
  ] });
  render(<TaskProgress kind="ai" task={{ phase: 'running', report: snapshot }} />);
  expect(screen.getByText('已完成 1 项 / 本次 2 项')).toBeVisible();
  expect(screen.getByRole('region', { name: '已完成结果' })).toHaveTextContent('观测不足，未评价请求稳定性。');
});
