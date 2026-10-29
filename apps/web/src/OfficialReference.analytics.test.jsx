import React, { StrictMode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import OfficialReference from './OfficialReference.jsx';
import { usePageAnalytics } from './usePageAnalytics.js';
import { parseCollection } from '../../api/src/analytics/analytics-input.ts';

const price = { country: 'us', countryName: '美国', currency: 'USD', formatted: '$20', amount: 20, cnyAmount: 140, stale: false };
const plans = Array.from({ length: 8 }, (_, index) => ({ id: JSON.stringify([String(6744120541 + index), 'subscription', 'P1M']), name: '套餐 ' + index, kind: 'subscription', period: 'P1M', prices: [price] }));
const catalog = { updatedAt: '2026-09-27T08:00:00Z', exchangeDate: '2026-09-27', apps: [
  { id: '6448311069', name: 'ChatGPT', plans },
  { id: '1232780281', name: 'Notion', plans: plans.slice(0, 2) },
] };
const collected = () => fetch.mock.calls.filter(([url]) => url === '/api/analytics/collect').map(([, options]) => JSON.parse(options.body));
const events = () => collected().flatMap(payload => payload.actions);
function Host({ page }) { usePageAnalytics(page); return <OfficialReference />; }
function server(offline = false) {
  vi.stubGlobal('fetch', vi.fn(async url => {
    if (url === '/api/analytics/collect') { if (offline) throw new Error('offline'); return new Response(null, { status: 204 }); }
    if (url === '/api/official-reference/catalog') return Response.json(catalog);
    throw new Error('Unexpected URL');
  }));
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); document.body.style.overflow = ''; });

it.each(['catalog', 'tools_ai', 'tools_ip'])('records reference interactions under the existing %s visit without duplicate selections', async page => {
  server(); render(<StrictMode><Host page={page} /></StrictMode>);
  await waitFor(() => expect(collected()).toHaveLength(1));
  fireEvent.click(screen.getByRole('button', { name: '官网正价参考' }));
  const picker = await screen.findByRole('button', { name: /切换套餐/ });
  expect(events().map(event => event.name)).toEqual(['reference_open']);
  fireEvent.click(screen.getByRole('button', { name: 'ChatGPT', exact: true }));
  fireEvent.click(picker);
  fireEvent.click(screen.getByRole('button', { name: '套餐 0 · 每月', pressed: true }));
  expect(events().map(event => event.name)).toEqual(['reference_open', 'reference_plans_open']);
  fireEvent.click(picker);
  fireEvent.click(screen.getByRole('button', { name: '套餐 1 · 每月' }));
  expect(events().at(-1)).toMatchObject({ name: 'reference_plan_select', reference: { appId: '6448311069', planId: plans[1].id } });
  fireEvent.click(screen.getByRole('button', { name: 'Notion' }));
  expect(events().at(-1)).toMatchObject({ name: 'reference_product', reference: { appId: '1232780281' } });
  const month = screen.getByRole('tab', { name: '套餐 0 · 每月' });
  fireEvent.click(month);
  const before = events().length;
  fireEvent.keyDown(month, { key: 'ArrowRight' });
  expect(events()).toHaveLength(before + 1);
  expect(events().at(-1)).toMatchObject({ name: 'reference_plan_select', reference: { appId: '1232780281', planId: plans[1].id } });
  fireEvent.keyDown(document.activeElement, { key: 'End' });
  expect(events()).toHaveLength(before + 1);
  fireEvent.click(screen.getByRole('button', { name: '关闭官网正价参考' }));
  fireEvent.click(screen.getByRole('button', { name: '官网正价参考' }));
  expect(await screen.findByRole('tab', { name: '套餐 1 · 每月', selected: true })).toBeInTheDocument();
  expect(events()).toHaveLength(before + 2);
  expect(events().filter(event => event.name === 'reference_open')).toHaveLength(2);
  expect(new Set(collected().map(payload => payload.visitId)).size).toBe(1);
  expect(collected().every(payload => payload.page === page)).toBe(true);
  for (const payload of collected()) expect(() => parseCollection(payload)).not.toThrow();
  expect(JSON.stringify(events())).not.toMatch(/sourceUrl|formatted|cnyAmount|套餐|https:/);
});

it('failed tracking never blocks the price viewer or product selection', async () => {
  server(true); render(<Host page="catalog" />);
  await waitFor(() => expect(collected()).toHaveLength(1));
  fireEvent.click(screen.getByRole('button', { name: '官网正价参考' }));
  await screen.findByText('140.00');
  fireEvent.click(screen.getByRole('button', { name: 'Notion' }));
  fireEvent.click(screen.getByRole('tab', { name: '套餐 1 · 每月' }));
  expect(screen.getByText('140.00')).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: '套餐 1 · 每月', selected: true })).toBeInTheDocument();
  expect(events().map(event => event.name)).toEqual(['reference_open', 'reference_product', 'reference_plan_select']);
});
