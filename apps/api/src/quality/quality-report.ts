import { QUALITY_CATALOG } from './quality.catalog.js';
import { qualityAttemptLimit, qualityTimestamp, validateQualityConfiguration, validateQualityEvidence, validateQualityProgress } from './quality-evidence.js';
import type { QualityItemResult, QualityReport, QualityKind, QualityStatus, QualitySummary } from './quality.types.js';
export const QUALITY_WEIGHTS: Record<QualityKind, Record<string, number>> = {
  ai: { '模型真实性': 25, '推理能力': 30, '能力完整度': 20, '协议兼容': 15, '稳定性与性能': 10 },
  ip: { 'IP 身份': 7.5, 'IP 类型': 7.5, '风险信誉': 30, 'AI 服务': 25, '网络质量': 15, '连通稳定': 10, '隐私泄露': 5, '扩展服务': 0 },
};

// Reports cross a JSON boundary. Compare every own key without depending on
// property insertion order, so server and browser validate the same contract.
function sameReportJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => sameReportJson(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  return keys.length === Object.keys(rightRecord).length && keys.every(key => Object.hasOwn(rightRecord, key) && sameReportJson(leftRecord[key], rightRecord[key]));
}
const statuses: QualityStatus[] = ['pass', 'risk', 'unrun', 'unavailable', 'cancelled'];
// The catalogue stays complete; statistics and cards exclude checks never selected.
// Results retained by a partial retest still belong to the cumulative report.
export function qualityReportScope(report: Pick<QualityReport, 'items' | 'configuration'>): QualityReport['items'] {
  return report.items.filter(item => report.configuration.selected.includes(item.id) || item.status !== 'unrun' || item.reason !== 'not-selected');
}
export function validateQualityItem(value: QualityItemResult): QualityItemResult {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['id', 'status', 'score', 'summary', 'impact', 'reason', 'evidence', 'label', 'group'].includes(key))) throw new Error('检测结果包含未知字段');
  if (!value || typeof value.id !== 'string' || !statuses.includes(value.status) || typeof value.summary !== 'string' || !value.summary.trim() || value.summary.length > 240 || /[\x00-\x08\x0b-\x1f]/.test(value.summary) || (value.impact !== undefined && (typeof value.impact !== 'string' || value.impact.length > 240))) throw new Error('检测结果格式无效');
  if (value.score !== null && (typeof value.score !== 'number' || !Number.isFinite(value.score) || value.score < 0 || value.score > 100)) throw new Error('检测分数无效');
  if ((value.status === 'pass' && value.score === null) || (!['pass', 'risk'].includes(value.status) && value.score !== null)) throw new Error('检测状态与分数不一致');
  if (value.reason !== undefined && (value.status !== 'unrun' || !['not-selected', 'unsupported', 'insufficient-samples'].includes(value.reason))) throw new Error('未覆盖原因无效');
  const evidence = value.evidence === undefined ? undefined : validateQualityEvidence(value.evidence);
  return { id: value.id, status: value.status, score: value.score, summary: value.summary, ...(value.impact ? { impact: value.impact } : {}), ...(value.reason ? { reason: value.reason } : {}), ...(evidence ? { evidence } : {}) };
}
export function buildQualityReport(base: Omit<QualityReport, 'items' | 'summary'>, results: QualityItemResult[]): QualityReport {
  const catalogue = QUALITY_CATALOG[base.kind];
  if (!catalogue) throw new Error('检测类型无效');
  const configuration = validateQualityConfiguration(base.configuration, base.kind);
  const progress = validateQualityProgress(base.progress, configuration, base.state);
  const byId = new Map<string, QualityItemResult>();
  for (const result of results) {
    if (!catalogue.some(item => item.id === result.id) || byId.has(result.id)) throw new Error('检测项目无效或重复');
    const item = validateQualityItem(result);
    if (item.evidence && !['pass', 'risk'].includes(item.status)) throw new Error('检测证据与状态不一致');
    if (item.evidence?.measurements && (base.kind !== 'ai' || item.id !== 'latency')) throw new Error('测速证据项目无效');
    if (configuration.selected.includes(item.id) && ((item.evidence?.attempts?.length ?? 0) > qualityAttemptLimit(configuration) || (item.evidence?.measurements?.length ?? 0) > qualityAttemptLimit(configuration))) throw new Error('检测证据超出配置次数');
    byId.set(result.id, item);
  }
  if (progress.some(entry => { const item = byId.get(entry.itemId); return !item || item.status !== 'unrun' || item.reason !== undefined; })) throw new Error('已完成项目不能包含活动进度');
  const items = catalogue.map(item => ({
    ...byId.get(item.id) ?? (!configuration.selected.includes(item.id)
      ? { id: item.id, status: 'unrun' as const, score: null, reason: 'not-selected' as const, summary: '未纳入当前范围，可加入检测或单项重测。' }
      : { id: item.id, status: base.state === 'cancelled' ? 'cancelled' as const : 'unrun' as const, score: null, summary: base.state === 'cancelled' ? '检测取消，尚未完成此项。' : '尚未执行此项，可加入检测或单项重测。' }),
    label: item.label, group: item.group,
  }));
  const scopedItems = qualityReportScope({ items, configuration });
  const tested = scopedItems.filter(item => item.status === 'pass' || item.status === 'risk');
  let numerator = 0; let denominator = 0;
  for (const [group, weight] of Object.entries(QUALITY_WEIGHTS[base.kind])) {
    const groupItems = tested.filter(item => item.group === group);
    if (groupItems.length && weight > 0) { numerator += weight * groupItems.reduce((total, item) => total + (item.score ?? 0), 0) / groupItems.length; denominator += weight; }
  }
  const counts = (status: QualityStatus) => scopedItems.filter(item => item.status === status).length;
  const risk = counts('risk'); const unrun = counts('unrun'); const cancelled = counts('cancelled');
  const summary: QualitySummary = { score: denominator ? Math.round(numerator / denominator) : null, tested: tested.length, risk, unrun, unavailable: counts('unavailable'), cancelled, total: scopedItems.length, overall: base.state === 'cancelled' || cancelled ? '检测未完成' : risk || base.state === 'failed' ? '存在风险' : unrun || !tested.length ? '存在未覆盖风险' : '通过' };
  return { id: base.id, kind: base.kind, state: base.state, target: base.target, ...(base.model ? { model: base.model } : {}), items, summary, configuration, progress, createdAt: base.createdAt, ...(base.completedAt ? { completedAt: base.completedAt } : {}) };
}
export function validateQualityReport(value: unknown): QualityReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('报告无效');
  const report = value as QualityReport;
  if (Object.keys(report).some(key => !['id', 'kind', 'state', 'target', 'model', 'items', 'summary', 'configuration', 'progress', 'createdAt', 'completedAt'].includes(key)) || !QUALITY_CATALOG[report.kind] || !['queued', 'running', 'completed', 'cancelled', 'failed'].includes(report.state) || !Array.isArray(report.items) || report.items.length !== QUALITY_CATALOG[report.kind].length) throw new Error('报告结构无效');
  for (const field of ['id', 'target', 'createdAt'] as const) if (typeof report[field] !== 'string' || !report[field] || report[field].length > 512) throw new Error('报告字段无效');
  if (!qualityTimestamp(report.createdAt) || (report.completedAt !== undefined && (!qualityTimestamp(report.completedAt) || report.completedAt < report.createdAt)) || (report.model !== undefined && (typeof report.model !== 'string' || report.model.length > 200))) throw new Error('报告时间或模型无效');
  if (['completed', 'cancelled', 'failed'].includes(report.state) !== (report.completedAt !== undefined)) throw new Error('报告终态时间无效');
  const rebuilt = buildQualityReport(report, report.items);
  if (!sameReportJson(rebuilt, report)) throw new Error('报告字段或评分不一致');
  return rebuilt;
}
