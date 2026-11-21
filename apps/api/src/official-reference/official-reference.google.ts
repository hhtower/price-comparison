import { REFERENCE_WEBSITES } from '@price-comparison/catalog/official-reference';
import { parse } from 'parse5';
import { fetchSourceText } from './official-reference.sources.js';
import type { ReferenceRegionSnapshot } from './official-reference.types.js';

type Node = { nodeName: string; value?: string; attrs?: { name: string; value: string }[]; childNodes?: Node[] };
const attribute = (node: Node, name: string) => node.attrs?.find(item => item.name === name)?.value;
const source = () => REFERENCE_WEBSITES.find(item => item.id === 'google-ai')!;

function hidden(node: Node): boolean {
  return ['style', 'template', 'noscript', 'svg'].includes(node.nodeName)
    || (node.attrs ?? []).some(item => item.name === 'hidden' || item.name === 'aria-hidden' && item.value === 'true'
      || item.name === 'style' && /(?:display\s*:\s*none|visibility\s*:\s*hidden)/iu.test(item.value));
}

function walk(node: Node, visit: (node: Node) => void): void {
  if (hidden(node)) return;
  visit(node);
  if (node.nodeName !== 'script') for (const child of node.childNodes ?? []) walk(child, visit);
}

function text(node: Node): string {
  if (hidden(node) || node.nodeName === 'script') return '';
  return (node.nodeName === '#text' ? node.value ?? '' : (node.childNodes ?? []).map(text).join(' '))
    .normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

export function parseGoogleReference(html: string, payload: unknown): ReferenceRegionSnapshot {
  if (Buffer.byteLength(html, 'utf8') > 4 * 1024 * 1024) throw new Error('Google page exceeds size limit');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid Google pricing feed');
  const feed = payload as Record<string, unknown>;
  if (feed.COUNTRY_CODE !== 'US' || feed.CURRENCY_CODE !== 'USD') throw new Error('Google price region mismatch');
  const cells: Node[] = [];
  walk(parse(html) as Node, node => { if (node.nodeName === 'th') cells.push(node); });
  const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const offers = source().plans.map(plan => {
    const matches = cells.filter(cell => text(cell).replace(/\s*\/mo$/u, '') === plan.heading);
    if (!matches.length) throw new Error('Missing Google plan identity');
    for (const cell of matches) {
      const prices: Node[] = [];
      walk(cell, node => { if (node.nodeName === 'g1-localized-price') prices.push(node); });
      if (prices.length !== 1 || attribute(prices[0], 'variant') !== plan.priceKey
        || attribute(prices[0], 'country') !== 'US') throw new Error('Google plan price-key mismatch');
    }
    const amount = feed[plan.priceKey!];
    if (!Object.hasOwn(feed, plan.priceKey!) || typeof amount !== 'number' || !Number.isFinite(amount)
      || amount <= 0 || amount > 1e12) throw new Error('Invalid Google plan price');
    return { id: plan.id, name: plan.name, amount, formatted: usd.format(amount), period: plan.period, kind: 'subscription' as const };
  });
  return { appId: source().id, country: 'us', currency: 'USD', sourceUrl: source().website,
    capturedAt: new Date().toISOString(), offers };
}

export async function fetchGoogleReference(fetcher: (url: string | URL, init?: RequestInit) => Promise<Response>,
  signal: AbortSignal): Promise<ReferenceRegionSnapshot> {
  const html = await fetchSourceText(source().website, fetcher, signal, 'text/html');
  const scripts = new Set<string>();
  walk(parse(html) as Node, node => {
    const path = attribute(node, 'src');
    if (node.nodeName === 'script' && attribute(node, 'type') === 'module'
      && path && /^\/about\/assets\/d\/[A-Za-z0-9_-]+\.min\.js$/u.test(path)) scripts.add(path);
  });
  if (!scripts.size || scripts.size > 32) throw new Error('Invalid Google pricing assets');
  for (const path of scripts) {
    const script = await fetchSourceText('https://one.google.com' + path, fetcher, signal, 'application/javascript');
    if (!/customElements\.define\s*\(\s*(['"`])g1-localized-price\1/u.test(script)) continue;
    // Read the current feed name, never execute downloaded JavaScript or pin a dated price file.
    const feeds = [...new Set([...script.matchAll(/\|\|\s*(['"`])(pricing_\d{4}_\d{2}_\d{2}\.json)\1/gu)].map(match => match[2]))];
    if (feeds.length !== 1) throw new Error('Ambiguous Google pricing feed');
    const payload = JSON.parse(await fetchSourceText('https://one.google.com/intl/ALL_us/about/feeds/' + feeds[0],
      fetcher, signal, 'application/json'));
    signal.throwIfAborted();
    return parseGoogleReference(html, payload);
  }
  throw new Error('Google pricing feed was not found');
}
