import { QUALITY_CATALOG } from '../../api/src/quality/quality.catalog.ts';
import { buildQualityReport } from '../../api/src/quality/quality-report.ts';

// Public catalogue and strict report builder are shared with the service.
// This module contains mock data only and makes no network requests.
export const catalog = QUALITY_CATALOG;
export function report(kind = 'ai', state = 'completed', extra = {}) {
  const selected = catalog[kind].filter(item => kind === 'ip' || item.modes.includes('standard')).map(item => item.id);
  const configuration = { runs: 3, mode: kind === 'ai' ? 'standard' : null, selected };
  const results = catalog[kind].map((item, index) => {
    let status = 'pass';
    let reason;
    if (!selected.includes(item.id)) { status = 'unrun'; reason = 'not-selected'; }
    else if (state === 'queued' || state === 'running' && index > 0) status = 'unrun';
    else if (state === 'cancelled' && index > 0) status = 'cancelled';
    else if (item.proxyOnly) status = 'unavailable';
    else if (['tool-calling', 'risk-score'].includes(item.id)) status = 'risk';
    return { id: item.id, status, score: status === 'pass' ? 90 : status === 'risk' ? 40 : null,
      summary: status === 'unavailable' ? '需要 SOCKS5 地址执行出口检测。' : reason === 'not-selected' ? '未选择检测。' : '服务端检测结论。',
      ...(reason ? { reason } : {}),
      ...(item.id === 'tool-calling' && status === 'risk' ? { evidence: { attempts: [{run:1,outcome:'pass'},{run:2,outcome:'timeout'},{run:3,outcome:'invalid-response'}] } } : {}),
      ...(kind === 'ai' && item.id === 'latency' && status === 'pass' ? { evidence: { measurements: [{run:1,firstTokenMs:800,responseMs:2400,tokensPerSecond:24}] } } : {}),
    };
  });
  const { items = results, ...overrides } = extra;
  const base = { id: 'task-1', kind, state, target: kind === 'ai' ? 'https://relay.example/v1' : '1.2.3.4',
    ...(kind === 'ai' ? { model: 'test-model' } : {}), configuration, progress: [], createdAt: '2026-09-26T00:00:00.000Z',
    ...(['completed','cancelled','failed'].includes(state) ? { completedAt: '2026-09-26T00:00:12.000Z' } : {}), ...overrides };
  return buildQualityReport(base, items);
}
