export type DurationValue =
  | { kind: 'range'; min: number; max: number }
  | { kind: 'min' | 'max' | 'approx'; days: number }
  | { kind: 'permanent' };
export type TagValue = string | number | DurationValue;

export const MAX_DURATION_DAYS = 36_500;
const positiveDays = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_DURATION_DAYS;

export function isDurationValue(value: unknown): value is number | DurationValue {
  if (typeof value === 'number') return positiveDays(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.kind !== 'string') return false;
  if (v.kind === 'permanent') return Object.keys(v).length === 1;
  if (v.kind === 'range') return Object.keys(v).length === 3 && positiveDays(v.min) && positiveDays(v.max) && v.min < v.max;
  return ['min', 'max', 'approx'].includes(v.kind) && Object.keys(v).length === 2 && positiveDays(v.days);
}

export function durationToDays(value: number, unit: string): number {
  const units: Record<string, number> = {
    minute: 1 / 1440, minutes: 1 / 1440, 分钟: 1 / 1440,
    hour: 1 / 24, hours: 1 / 24, 小时: 1 / 24,
    day: 1, days: 1, 天: 1, 日: 1, week: 7, weeks: 7, 周: 7, 星期: 7,
    month: 30, months: 30, 月: 30, 个月: 30, year: 365, years: 365, 年: 365,
  };
  const days = value * (units[unit.toLowerCase()] ?? NaN);
  if (!positiveDays(days)) throw new Error('Invalid duration');
  return days;
}

const decimal = (n: number) => String(Number(n.toFixed(10)));
function displayDays(days: number): string {
  if (Number.isInteger(days / 365)) return decimal(days / 365) + '年';
  if (Number.isInteger(days / 30)) return decimal(days / 30) + '个月';
  if (days < 1) return days >= 1 / 24 ? decimal(days * 24) + '小时' : decimal(days * 1440) + '分钟';
  return decimal(days) + '天';
}

export function formatDuration(value: unknown): string {
  if (!isDurationValue(value)) return '';
  if (typeof value === 'number') return displayDays(value);
  if (value.kind === 'permanent') return '永久';
  if (value.kind === 'range') {
    if (Number.isInteger(value.min / 365) && Number.isInteger(value.max / 365)) return `${value.min / 365}-${value.max / 365}年`;
    if (Number.isInteger(value.min / 30) && Number.isInteger(value.max / 30)) return `${value.min / 30}-${value.max / 30}个月`;
    return `${decimal(value.min)}-${decimal(value.max)}天`;
  }
  return { min: '至少', max: '最多', approx: '约' }[value.kind] + displayDays(value.days);
}

/** Stable equality for typed values, independent of JSON object key order. */
export function tagValueKey(value: TagValue): string {
  if (typeof value !== 'object') return JSON.stringify(value);
  if (value.kind === 'permanent') return '{"kind":"permanent"}';
  if (value.kind === 'range') return JSON.stringify({ kind: value.kind, min: value.min, max: value.max });
  return JSON.stringify({ kind: value.kind, days: value.days });
}
