import { DomainValidationError } from '../common/errors.js';

export function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new DomainValidationError('REQUIRED_FIELD', `${field} 不能为空`, { field });
  return normalized;
}

export function normalizeHttpUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString();
  } catch {}
  throw new DomainValidationError('INVALID_URL', '商铺 URL 必须是有效的 HTTP(S) 地址');
}
