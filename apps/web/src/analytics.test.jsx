import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createVisitTracker } from './analytics.js';
import React, { StrictMode } from 'react';
import { render, cleanup } from '@testing-library/react';
import { usePageAnalytics } from './usePageAnalytics.js';

let stop;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-27T00:00:00Z'));
  localStorage.clear(); sessionStorage.clear();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
});
afterEach(() => { cleanup(); stop?.(); stop = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const payloads = () => fetch.mock.calls.map(([, options]) => JSON.parse(options.body));
it('records anonymous page views, reuses identities, and avoids duplicate initial delivery', async () => {
  const tracker = createVisitTracker(); stop = tracker.start('catalog');
  await vi.advanceTimersByTimeAsync(1);
  const first = payloads()[0];
  expect(first).toMatchObject({ page: 'catalog', activeMs: 0, actions: [], source: 'direct' });
  expect(Object.keys(first).sort()).toEqual(['visitId', 'visitorId', 'sessionId', 'page', 'device', 'browser', 'source', 'activeMs', 'actions'].sort());
  stop(); stop = tracker.start('tools_ai'); await vi.advanceTimersByTimeAsync(1);
  expect(payloads().at(-1)).toMatchObject({ visitorId: first.visitorId, sessionId: first.sessionId, page: 'tools_ai' });
  expect(payloads().at(-1).visitId).not.toBe(first.visitId);
});
it('counts only visible time and flushes a whitelisted action without field contents', async () => {
  const tracker = createVisitTracker(); stop = tracker.start('catalog');
  await vi.advanceTimersByTimeAsync(5000);
  tracker.action('search');
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
  expect(payloads().at(-1).activeMs).toBe(5000);
  expect(payloads().flatMap(payload => payload.actions)).toHaveLength(1);
  expect(payloads().flatMap(payload => payload.actions)[0].name).toBe('search');
  await vi.advanceTimersByTimeAsync(60000);
  stop(); stop = undefined;
  expect(payloads().at(-1).activeMs).toBe(5000);
});
it('does not track admin or fail the page when storage or delivery fails', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
  fetch.mockRejectedValue(new Error('offline'));
  const tracker = createVisitTracker();
  stop = tracker.start('admin'); await vi.advanceTimersByTimeAsync(1); expect(fetch).not.toHaveBeenCalled();
  stop(); stop = tracker.start('catalog'); await vi.advanceTimersByTimeAsync(1);
  expect(payloads()).toHaveLength(1);
  expect(() => tracker.action('apiKey', { secret: 'do-not-send' })).not.toThrow();
});
it('drops arbitrary reference metadata before it can leave the browser', () => {
  const tracker = createVisitTracker(); stop = tracker.start('catalog');
  tracker.action('reference_product', { appId: 'https://private.example' });
  tracker.action('reference_plan_select', { appId: '6448311069', planId: '["6744120541","subscription","P1M"]', secret: 'sk-private' });
  tracker.action('search', { query: 'private search' });
  expect(payloads().flatMap(payload => payload.actions)).toHaveLength(0);
  tracker.action('reference_product', { appId: '6448311069' });
  expect(payloads().flatMap(payload => payload.actions)).toEqual([{ id: expect.any(String), name: 'reference_product', reference: { appId: '6448311069' } }]);
  expect(JSON.stringify(payloads())).not.toMatch(/private|secret|https:/);
});
it('rotates inactive sessions and stops idle duration after thirty minutes', async () => {
  const tracker = createVisitTracker(); stop = tracker.start('catalog');
  const first = payloads()[0];
  await vi.advanceTimersByTimeAsync(31 * 60000);
  expect(payloads().at(-1).activeMs).toBe(30 * 60000);
  tracker.action('search');
  expect(payloads().at(-1).sessionId).not.toBe(first.sessionId);
  expect(payloads().at(-1).visitorId).toBe(first.visitorId);
  expect(payloads().at(-1).activeMs).toBe(0);
});
it('navigation refreshes the shared session activity without changing visitor identity', async () => {
  const tracker = createVisitTracker(); stop = tracker.start('catalog'); const first = payloads()[0];
  await vi.advanceTimersByTimeAsync(25 * 60000);
  stop(); stop = tracker.start('tools_ai');
  await vi.advanceTimersByTimeAsync(10 * 60000);
  stop(); stop = tracker.start('catalog');
  expect(payloads().at(-1).sessionId).toBe(first.sessionId);
});
it('StrictMode and rerenders keep a single page view and tool switches record a new one', async () => {
  function Page({ page }) { usePageAnalytics(page); return null; }
  const view = render(<StrictMode><Page page="catalog" /></StrictMode>);
  await vi.advanceTimersByTimeAsync(1);
  expect(payloads()).toHaveLength(1);
  view.rerender(<StrictMode><Page page="catalog" /></StrictMode>);
  await vi.advanceTimersByTimeAsync(1); expect(payloads()).toHaveLength(1);
  view.rerender(<StrictMode><Page page="tools_ip" /></StrictMode>);
  await vi.advanceTimersByTimeAsync(1);
  expect(new Set(payloads().map(payload => payload.visitId)).size).toBe(2);
  expect(payloads().at(-1).page).toBe('tools_ip');
});
it('counts a BFCache restoration as a new visit but keeps normal pageshow idempotent', async () => {
  const tracker = createVisitTracker(); stop = tracker.start('catalog');
  const first = payloads()[0];
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
  expect(new Set(payloads().map(payload => payload.visitId)).size).toBe(1);
  await vi.advanceTimersByTimeAsync(5000);
  window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  await vi.advanceTimersByTimeAsync(10000);
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  tracker.action('search');
  expect(new Set(payloads().map(payload => payload.visitId)).size).toBe(2);
  expect(payloads().at(-1)).toMatchObject({ visitorId: first.visitorId, sessionId: first.sessionId, activeMs: 0 });
});
