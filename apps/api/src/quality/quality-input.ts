import { isIP } from 'node:net';
import { QUALITY_CATALOG } from './quality.catalog.js';
import type { AiQualityInput, QualityInput, QualityMode } from './quality.types.js';
export interface ParsedIpTarget { type: 'ipv4' | 'ipv6' | 'socks'; host: string; port?: number; username?: string; password?: string; display: string; }
export function parseIpTarget(value: string): ParsedIpTarget | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  const raw = value.trim();
  const family = isIP(raw);
  if (family) return { type: family === 4 ? 'ipv4' : 'ipv6', host: raw, display: family === 4 ? raw.split('.').slice(0, 2).join('.') + '.*.*' : raw.split(':').slice(0, 2).join(':') + ':…' };
  try {
    const url = new URL(raw);
    if (!['socks5:', 'socks5h:'].includes(url.protocol) || url.pathname || url.search || url.hash || !url.hostname || !url.port) return null;
    const port = Number(url.port);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !/^[a-z\d.:-]+$/i.test(host)) return null;
    if (host.includes(':') && isIP(host) !== 6) return null;
    const username = decodeURIComponent(url.username); const password = decodeURIComponent(url.password);
    if ([username, password].some(x => /[\x00- \x7f]/.test(x) || Buffer.byteLength(x) > 255)) return null;
    if (Boolean(username) !== Boolean(password)) return null;
    return { type: 'socks', host, port, ...(username ? { username, password } : {}), display: `socks5://${url.hostname}:${port}` };
  } catch { return null; }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('检测配置无效');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('检测配置包含未知字段');
}
function text(value: unknown, name: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${name}无效`);
  return value.trim();
}
export function validateQualityEndpoint(value: unknown): string {
  const raw = text(value, 'Base URL', 2048);
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) throw new Error();
    return raw.replace(/\/+$/, '');
  } catch { throw new Error('Base URL 必须是不含凭据和查询参数的 HTTP(S) 地址'); }
}
export interface QualityModelInput { endpoint: string; apiKey: string; }
export function validateQualityModelInput(value: unknown): QualityModelInput {
  const input = record(value);
  keys(input, ['endpoint', 'apiKey']);
  return { endpoint: validateQualityEndpoint(input.endpoint), apiKey: text(input.apiKey, 'API Key', 4096) };
}
export function validateQualityInput(value: unknown): QualityInput {
  const input = record(value);
  const runs = input.runs === undefined ? 3 : input.runs;
  if (typeof runs !== 'number' || !Number.isSafeInteger(runs) || runs < 1 || runs > 5) throw new Error('检测次数必须为 1 至 5');
  if (input.kind === 'ip') {
    keys(input, ['kind', 'target', 'runs']);
    const target = text(input.target, 'IP 或 SOCKS5 地址', 2048);
    if (!parseIpTarget(target)) throw new Error('请输入有效的 IP 地址或 SOCKS5 地址');
    return { kind: 'ip', target, runs };
  }
  if (input.kind !== 'ai') throw new Error('检测类型无效');
  keys(input, ['kind', 'endpoint', 'apiKey', 'model', 'mode', 'runs', 'items']);
  if (typeof input.mode !== 'string' || !['quick', 'standard', 'full'].includes(input.mode)) throw new Error('检测档位无效');
  if (!Array.isArray(input.items) || input.items.length > QUALITY_CATALOG.ai.length || new Set(input.items).size !== input.items.length || input.items.some(id => typeof id !== 'string' || !QUALITY_CATALOG.ai.some(item => item.id === id)) || QUALITY_CATALOG.ai.some(item => item.required && !(input.items as unknown[]).includes(item.id))) throw new Error('检测项目无效，基础连通性和流式协议必须开启');
  const result: AiQualityInput = { kind: 'ai', endpoint: validateQualityEndpoint(input.endpoint), apiKey: text(input.apiKey, 'API Key', 4096), model: text(input.model, '目标模型'), mode: input.mode as QualityMode, runs, items: [...input.items] };
  return result;
}
export function maskQualityTarget(input: QualityInput): string {
  if (input.kind === 'ai') return `${new URL(input.endpoint).origin}/…`;
  return parseIpTarget(input.target)?.display ?? '地址已隐藏';
}
