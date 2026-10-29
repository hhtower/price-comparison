/** Shared metadata contract; model IDs must also fit the quality task's model input. */
export function normalizeModelIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1000 || value.some(id => typeof id !== 'string' || !id.trim() || id.length > 200 || /[\x00-\x1f\x7f]/u.test(id))) throw new Error('AI model list is invalid');
  return [...new Set(value.map(id => (id as string).trim()))].sort();
}
