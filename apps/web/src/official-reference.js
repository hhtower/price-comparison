export async function readCatalog(signal) {
  const response = await fetch('/api/official-reference/catalog', {
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), credentials: 'omit',
  });
  if (!response.ok) throw new Error('参考价暂时无法读取');
  const catalog = await response.json();
  if (!Array.isArray(catalog?.apps) || !catalog.apps.every(app =>
    app && Array.isArray(app.plans) && app.plans.every(plan => plan && Array.isArray(plan.prices)))) {
    throw new Error('Invalid reference catalog');
  }
  return {
    ...catalog,
    apps: catalog.apps.map(app => ({ ...app, plans: app.plans.filter(plan => plan.kind !== 'app') }))
      .filter(app => app.plans.some(plan => plan.prices.length > 0)),
  };
}

export function formatPeriod(period) {
  const match = /^P([1-9][0-9]*)([DWMY])$/.exec(period);
  if (!match) return period;
  const [, count, unit] = match;
  const units = { D: ['天', '天'], W: ['周', '周'], M: ['月', '个月'], Y: ['年', '年'] };
  return count === '1' ? '每' + units[unit][0] : '每' + count + units[unit][1];
}

export function formatPlanName(plan) {
  // Structured billing periods take precedence over stale or localized name suffixes.
  const suffix = /(?:\s*[-–—·]\s*|\s+)(?:monthly|annual|yearly|mensal|按月付费|按年付费)(\s+#\d+)?\s*$/i;
  return plan.kind === 'subscription' && /^P[1-9][0-9]*[DWMY]$/.test(plan.period)
    ? plan.name.replace(suffix, '$1').trim() || plan.name
    : plan.name;
}
