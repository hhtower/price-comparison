import assert from 'node:assert/strict';

export function jsonObject(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected a JSON object');
  return value as Record<string, unknown>;
}
