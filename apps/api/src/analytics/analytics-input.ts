import { BadRequestException } from '@nestjs/common';
import { normalizeIp } from './analytics-network.js';
import { ANALYTICS_PAGES, ANALYTICS_DEVICES, ANALYTICS_BROWSERS, ANALYTICS_SOURCES, PAGE_ACTIONS, validReferenceContext, type AnalyticsCollection, type AnalyticsPage, type AnalyticsQuery, type AnalyticsPeriod } from './analytics-contract.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function invalid(): never { throw new BadRequestException('访问统计参数无效'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]) { if (Object.keys(value).some(key => !allowed.includes(key))) invalid(); }
function category(value: unknown, allowed: object) { if (typeof value !== 'string' || !Object.hasOwn(allowed, value)) invalid(); }
export function parseExcludedIp(value: unknown): string {
  const input = object(value); keys(input, ['ip']);
  const ip = normalizeIp(input.ip);
  if (!ip) throw new BadRequestException('请输入有效的 IPv4 或 IPv6 地址，不支持网段');
  return ip;
}

export function parseCollection(value: unknown): AnalyticsCollection {
  const input = object(value);
  keys(input, ['visitId', 'visitorId', 'sessionId', 'page', 'device', 'browser', 'source', 'activeMs', 'actions']);
  for (const field of ['visitId', 'visitorId', 'sessionId']) if (typeof input[field] !== 'string' || !UUID.test(input[field] as string)) invalid();
  category(input.page, ANALYTICS_PAGES); category(input.device, ANALYTICS_DEVICES); category(input.browser, ANALYTICS_BROWSERS); category(input.source, ANALYTICS_SOURCES);
  if (!Number.isSafeInteger(input.activeMs) || Number(input.activeMs) < 0 || Number(input.activeMs) > 86400000 || !Array.isArray(input.actions) || input.actions.length > 20) invalid();
  for (const raw of input.actions as unknown[]) {
    const action = object(raw); keys(action, ['id', 'name', 'reference']);
    if (typeof action.id !== 'string' || !UUID.test(action.id) || !(PAGE_ACTIONS[input.page as AnalyticsPage] as readonly unknown[]).includes(action.name)) invalid();
    if (!validReferenceContext(action.name, action.reference)) invalid();
  }
  return input as unknown as AnalyticsCollection;
}
export function parseAnalyticsQuery(value: unknown): AnalyticsQuery {
  const input = object(value); keys(input, ['days', 'page', 'limit']);
  const result = { days: 7, page: 1, limit: 20 };
  for (const key of ['days', 'page', 'limit'] as const) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'string' || !/^[1-9][0-9]*$/.test(input[key] as string)) invalid();
    result[key] = Number(input[key]);
  }
  if (![1, 7, 30, 90].includes(result.days) || result.page > 10000 || result.limit > 100) invalid();
  return result;
}
export function analyticsPeriod(days: number, now = new Date()): AnalyticsPeriod {
  const day = 86400000; const offset = 8 * 3600000;
  const midnight = Math.floor((now.getTime() + offset) / day) * day - offset;
  return { start: new Date(midnight - (days - 1) * day).toISOString(), end: new Date(midnight + day).toISOString(), days, timezone: 'Asia/Shanghai' };
}
