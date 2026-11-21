import { REFERENCE_WEBSITES } from '@price-comparison/catalog/official-reference';
import { parse } from 'parse5';
import { fetchSourceText } from './official-reference.sources.js';
import type { ReferenceRegionSnapshot } from './official-reference.types.js';
import { parseTeamReference } from './official-reference.team.js';
import { fetchGoogleReference } from './official-reference.google.js';

type HtmlNode = {
  nodeName: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: HtmlNode[];
  parentNode?: HtmlNode;
};

function website(appId: string) {
  const source = REFERENCE_WEBSITES.find(item => item.id === appId);
  if (!source) throw new Error('Unsupported reference website');
  const url = new URL(source.website);
  const allowed: Record<string, [string, string, string]> = {
    cursor: ['https://cursor.com', '/pricing', ''],
    kiro: ['https://kiro.dev', '/pricing', ''],
    'chatgpt-business': ['https://openai.com', '/business/pricing', ''],
    'claude-team': ['https://claude.com', '/pricing', '?currency=USD'],
    'google-ai': ['https://one.google.com', '/intl/en/about/google-ai-plans', '?gl=US&hl=en'],
  };
  const [origin, path, search] = allowed[source.id] ?? [];
  if (url.origin !== origin || url.username || url.password || url.search !== search || url.hash
    || url.pathname.replace(/\/$/u, '') !== path) throw new Error('Invalid reference website URL');
  return source;
}

function invisible(node: HtmlNode): boolean {
  return ['script', 'style', 'template', 'noscript', 'svg'].includes(node.nodeName)
    || (node.attrs ?? []).some(attribute => attribute.name === 'hidden'
      || (attribute.name === 'aria-hidden' && attribute.value === 'true')
      || (attribute.name === 'style' && /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important\s*)?(?:;|$)/iu.test(attribute.value)));
}

function text(node: HtmlNode): string {
  if (invisible(node)) return '';
  if (node.nodeName === '#text') return (node.value ?? '').replace(/\s+/gu, ' ').trim();
  return (node.childNodes ?? []).map(text).filter(Boolean).join(' ');
}

function priceBlocks(heading: HtmlNode, appId: string): HtmlNode[] {
  let anchor = heading;
  while (anchor.parentNode) {
    const siblings = (anchor.parentNode.childNodes ?? []).filter(node => text(node));
    const following = siblings.slice(siblings.indexOf(anchor) + 1);
    if (appId === 'cursor' && text(following[0] ?? { nodeName: '#text' }) === 'Most popular') following.shift();
    if (following.length) return following;
    anchor = anchor.parentNode;
  }
  throw new Error(`Missing website price for ${text(heading)}`);
}

export function parseWebsiteReference(appId: string, html: string): ReferenceRegionSnapshot {
  const source = website(appId);
  if (appId === 'chatgpt-business' || appId === 'claude-team') return parseTeamReference(appId, html);
  if (appId === 'google-ai') throw new Error('Google pricing requires the official price feed');
  if (Buffer.byteLength(html, 'utf8') > 4 * 1024 * 1024) throw new Error('Website HTML exceeds size limit');
  const headings: HtmlNode[] = [];
  const visit = (node: HtmlNode): void => {
    if (invisible(node)) return;
    if (/^h[1-6]$/u.test(node.nodeName)) headings.push(node);
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(parse(html) as HtmlNode);
  const period = appId === 'cursor' ? '\\s*/\\s*month' : '\\s*per user\\s*/\\s*month';
  const price = new RegExp(`^\\$\\s*((?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d{1,2})?)${period}$`, 'u');
  const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const offers = source.plans.map(plan => {
    const matches = headings.filter(heading => text(heading) === plan.heading);
    if (!matches.length) throw new Error(`Missing website plan: ${plan.id}`);
    const amounts = new Set<number>();
    for (const heading of matches) {
      const blocks = priceBlocks(heading, appId);
      // Only the price block immediately after the heading can establish a quote.
      for (let index = 0; index < blocks.length; index++) {
        const match = price.exec(text(blocks[index]));
        if (!match) {
          if (index === 0) throw new Error(`Invalid website price: ${plan.id}`);
          break;
        }
        const amount = Number(match[1].replaceAll(',', ''));
        if (!Number.isFinite(amount) || amount <= 0 || amount > 1e12) throw new Error(`Invalid website price: ${plan.id}`);
        amounts.add(amount);
      }
    }
    if (amounts.size !== 1) throw new Error(`Conflicting website prices: ${plan.id}`);
    const amount = [...amounts][0];
    return { id: plan.id, name: plan.name, amount, formatted: usd.format(amount), period: 'P1M', kind: 'subscription' as const };
  });
  return {
    appId: source.id, country: 'global', currency: 'USD', sourceUrl: source.website,
    capturedAt: new Date().toISOString(), offers,
  };
}

export async function fetchWebsiteReference(appId: string,
  fetcher: (url: string | URL, init?: RequestInit) => Promise<Response>,
  signal: AbortSignal): Promise<ReferenceRegionSnapshot> {
  const source = website(appId);
  if (appId === 'google-ai') return fetchGoogleReference(fetcher, signal);
  const html = await fetchSourceText(source.website, fetcher, signal, 'text/html');
  signal.throwIfAborted();
  return parseWebsiteReference(appId, html);
}
