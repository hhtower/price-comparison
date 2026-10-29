import type { QualityConfiguration, QualityEvidence, QualityKind, QualityProgress, QualityState } from './quality.types.js';
import { QUALITY_CATALOG } from './quality.catalog.js';

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error('检测证据结构无效');
  return value as Record<string, unknown>;
}
const integer = (value: unknown, max: number) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= max;
const measured = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const oneOf = (value: unknown, allowed: string[]) => typeof value === 'string' && allowed.includes(value);
export const qualityTimestamp = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export function qualityAttemptLimit(config: QualityConfiguration): number {
  return config.runs;
}

export function validateQualityEvidence(value: unknown): QualityEvidence {
  const evidence = object(value, ['attempts', 'measurements']);
  if (!Object.keys(evidence).length || Object.values(evidence).some(entry => entry === undefined)) throw new Error('检测证据为空');
  if (evidence.attempts !== undefined) {
    if (!Array.isArray(evidence.attempts) || !evidence.attempts.length || evidence.attempts.length > 30) throw new Error('检测次数证据无效');
    for (const [index, entry] of evidence.attempts.entries()) {
      const attempt = object(entry, ['run', 'outcome']);
      if (attempt.run !== index + 1 || !oneOf(attempt.outcome, ['pass', 'mismatch', 'invalid-response', 'timeout', 'request-error'])) throw new Error('检测轮次证据无效');
    }
  }
  if (evidence.measurements !== undefined) {
    if (!Array.isArray(evidence.measurements) || !evidence.measurements.length || evidence.measurements.length > 5) throw new Error('测速证据无效');
    for (const [index, entry] of evidence.measurements.entries()) {
      const sample = object(entry, ['run', 'firstTokenMs', 'responseMs', 'tokensPerSecond']);
      if (sample.run !== index + 1 || !measured(sample.responseMs) || (sample.firstTokenMs !== null && (!measured(sample.firstTokenMs) || (sample.firstTokenMs as number) > (sample.responseMs as number))) || (sample.tokensPerSecond !== null && !measured(sample.tokensPerSecond))) throw new Error('测速数值无效');
    }
  }
  return structuredClone(evidence) as QualityEvidence;
}

export function validateQualityConfiguration(value: unknown, kind: QualityKind): QualityConfiguration {
  const config = object(value, ['runs', 'mode', 'selected']);
  const catalogue = QUALITY_CATALOG[kind];
  if (!integer(config.runs, 5) || !Array.isArray(config.selected) || !config.selected.length || config.selected.length > catalogue.length || new Set(config.selected).size !== config.selected.length || config.selected.some(id => typeof id !== 'string' || !catalogue.some(item => item.id === id))) throw new Error('报告检测配置无效');
  if (kind === 'ai' ? !oneOf(config.mode, ['quick', 'standard', 'full']) : config.mode !== null) throw new Error('报告检测模式无效');
  return structuredClone(config) as unknown as QualityConfiguration;
}

export function validateQualityProgress(value: unknown, configuration: QualityConfiguration, state: QualityState): QualityProgress[] {
  if (!Array.isArray(value) || value.length > configuration.selected.length || (state !== 'running' && value.length)) throw new Error('检测进度无效');
  const seen = new Set<string>();
  for (const entry of value) {
    const progress = object(entry, ['itemId', 'stage', 'attempt', 'total', 'startedAt']);
    if (typeof progress.itemId !== 'string' || !configuration.selected.includes(progress.itemId) || seen.has(progress.itemId) || !oneOf(progress.stage, ['measurement', 'baseline', 'probe']) || !integer(progress.total, 30) || !integer(progress.attempt, progress.total as number) || !qualityTimestamp(progress.startedAt)) throw new Error('检测轮次进度无效');
    const stage = ['connectivity', 'model-identity', 'streaming', 'token-usage', 'latency'].includes(progress.itemId) ? 'measurement' : progress.itemId === 'fingerprint-match' ? 'baseline' : 'probe';
    if (configuration.mode === null || progress.stage !== stage || progress.total !== qualityAttemptLimit(configuration) * (progress.itemId === 'multi-turn' ? 2 : 1)) throw new Error('检测请求计划无效');
    seen.add(progress.itemId);
  }
  return structuredClone(value) as QualityProgress[];
}
