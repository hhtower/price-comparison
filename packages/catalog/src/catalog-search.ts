import { canonicalProductDisplayName, CATALOG_PRODUCT_ALIASES, type ProductDisplayIdentity } from './catalog-display.js';

export function normalizeCatalogSearchText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}+]+/gu, ' ')
    .replace(/\b(pro|premium)\s*plus\b/gu, '$1+')
    .replace(/([\p{L}\p{N}])\s+\+/gu, '$1+').trim();
}

export function catalogSearchTerms(text: string): string[] {
  return normalizeCatalogSearchText(text).replace(/([a-z])(?=\d)/gu, '$1 ')
    .match(/\p{Script=Han}+|[^\p{Script=Han}\s]+/gu)?.filter(term => /[\p{L}\p{N}]/u.test(term)) ?? [];
}

export function compactCatalogSearchText(text: string): string {
  return normalizeCatalogSearchText(text).replace(/\s/gu, '')
    .replace(/(pro|premium)plus(?=$|\p{Script=Han})/gu, '$1+');
}

/** Identity names only: merchant copy and exclusion clauses are not aliases. */
export function catalogIdentityNames(name: string, identity: ProductDisplayIdentity, aliases: readonly string[] = []): string[] {
  const key = [identity.family, identity.product, identity.tier].map(value => value.trim().toLowerCase()).join('/');
  return [...new Set([name, canonicalProductDisplayName(identity),
    [identity.family, identity.product, identity.tier].filter(Boolean).join(' '),
    ...CATALOG_PRODUCT_ALIASES[key] ?? [], ...aliases].filter(value => value.trim()))];
}

export function catalogNameMatch(name: string, query: string): 0 | 1 | 2 {
  const normalize = (value: string) => normalizeCatalogSearchText(value)
    .replace(/\bchat\s+gpt\b/gu, 'chatgpt').replace(/\bgpt\b/gu, 'chatgpt');
  const source = normalize(name);
  const requested = normalize(query);
  if (!requested) return 0;
  if (compactCatalogSearchText(source) === compactCatalogSearchText(requested)) return 2;
  const terms = catalogSearchTerms(source);
  const words = catalogSearchTerms(requested);
  return words.length && words.every(word => terms.some(term => term === word
    || (/^\p{Script=Han}+$/u.test(word) && term.includes(word)))) ? 1 : 0;
}
