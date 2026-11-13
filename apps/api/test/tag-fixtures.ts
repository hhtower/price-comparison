import { jsonb, type JsonValue, type JsonbInput } from '../src/database/types.js';

/** Insert decoded test facts through the same JSONB boundary as application writes. */
export function tagRows<T extends { value: JsonValue }>(input: T | readonly T[]): Array<Omit<T, 'value'> & { value: JsonbInput }> {
  const rows: readonly T[] = Array.isArray(input) ? input : [input as T];
  return rows.map(row => ({ ...row, value: jsonb(row.value) }));
}
