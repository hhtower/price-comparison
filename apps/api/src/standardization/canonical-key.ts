import { createHash } from 'node:crypto';
import { normalizeIdentity } from './identity-policy.js';

export interface CanonicalStandardKeyInput {
  platform?: unknown;
  family?: unknown;
  product?: unknown;
  tier?: unknown;
  tags?: unknown;
}

export const canonicalizeMatchText = (value: unknown): string =>
  String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('en-US');

export function buildCanonicalStandardKey(input: CanonicalStandardKeyInput): string {
  const payload = normalizeIdentity(input);
  return `v3:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
}
