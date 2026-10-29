const text = value => value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const labelText = value => /[:/]/u.test(value) || value.startsWith('"') ? JSON.stringify(value) : value;
const valueText = value => value.includes(' / ') || value.startsWith('"') ? JSON.stringify(value) : value;

function optionsText(entries) {
  const options = new Map();
  for (const [rawName, rawValue] of entries) {
    if (rawValue == null || rawValue === '') continue;
    if (typeof rawValue !== 'string' && !(typeof rawValue === 'number' && Number.isFinite(rawValue))) {
      throw new TypeError('specification values must be scalar text');
    }
    const name = text(String(rawName)), value = text(String(rawValue));
    if (!value) continue;
    if (!name) throw new TypeError('specification label must not be empty');
    if (options.has(name) && options.get(name) !== value) throw new TypeError(`conflicting specification: ${name}`);
    options.set(name, value);
  }
  return [...options].sort(([a], [b]) => compare(a, b)).map(([name, value]) => `${labelText(name)}: ${valueText(value)}`).join(' / ');
}

function parseOptions(value) {
  // Quote only reserved delimiters, so ordinary specs remain readable and encoding is unambiguous.
  const option = /("(?:[^"\\]|\\.)*"|(?!")[^:/]+?):\s*("(?:[^"\\]|\\.)*"|(?!")(?:(?! \/ ).)+?)(?: \/ |$)/uy;
  const entries = [];
  const parts = [];
  let offset = 0;
  while (offset < value.length) {
    const match = option.exec(value);
    if (!match) return null;
    try {
      entries.push(match.slice(1, 3).map(token => token.startsWith('"') ? JSON.parse(token) : token));
    } catch { return null; }
    parts.push(`${match[1]}: ${match[2]}`);
    offset = option.lastIndex;
  }
  return entries.length ? { entries, parts } : null;
}

/** Internal product contract: one string; only labeled options are reordered. */
export function normalizeSpec(value) {
  if (value == null) return '';
  if (typeof value !== 'string') throw new TypeError('spec must be a string');
  const normalized = text(value);
  const options = parseOptions(normalized);
  return options ? optionsText(options.entries) : normalized;
}

/** Keep attribute boundaries without treating a quoted separator as a new attribute. */
export function specificationParts(value) {
  return parseOptions(value)?.parts ?? [value];
}

/** Used at adapter boundaries, never to infer options from titles or SKU codes. */
export function specificationText(value) {
  if (value == null || typeof value === 'string') return normalizeSpec(value);
  if (Array.isArray(value)) {
    if (!value.every(item => item && typeof item === 'object' && typeof item.name === 'string' && Object.hasOwn(item, 'value'))) {
      throw new TypeError('specification options must have name and value');
    }
    return optionsText(value.map(item => [item.name, item.value]));
  }
  if (value && typeof value === 'object') return optionsText(Object.entries(value));
  throw new TypeError('invalid specification');
}

/** Source metadata cannot define a second specification beside product.spec. */
export function withoutSpecAliases(source) {
  return Object.fromEntries(Object.entries(source ?? {}).filter(([key]) =>
    !['spec', 'selectedoptions', 'sku', 'specification'].includes(key.normalize('NFKC').replace(/[\s_-]+/gu, '').toLowerCase())));
}
