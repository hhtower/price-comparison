import { REFERENCE_WEBSITES } from '@price-comparison/catalog/official-reference';
import { parse } from 'parse5';
import type { ReferenceRegionSnapshot } from './official-reference.types.js';

type HtmlNode = {
  nodeName: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: HtmlNode[];
  parentNode?: HtmlNode;
};

const number = String.raw`((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)`;
const businessBilling = new RegExp(String.raw`^\$\s*${number}\s*/\s*month if billed annually\.\s*\$\s*${number}\s*/\s*month if billed monthly\.$`, 'u');
const claudeBilling = new RegExp(String.raw`^Per seat\s*/\s*month if billed annually\.\s*\$\s*${number} if billed monthly\.$`, 'u');
const businessDisplay = new RegExp(String.raw`^\$\s*${number}\s*/\s*month$`, 'u');
const claudeDisplay = new RegExp(String.raw`^\$\s*${number}$`, 'u');
const block = /^(?:div|section|article|p|h[1-6]|ul|ol|li|table|tr|td|blockquote)$/u;
const nonUsdCurrency = new RegExp(String.raw`\b(?:${Intl.supportedValuesOf('currency').filter(code => code !== 'USD').join('|')})\b`, 'u');

function hidden(node: HtmlNode, exposeHidden = false): boolean {
  return (node.attrs ?? []).some(attribute => (attribute.name === 'hidden' && !exposeHidden)
      || (attribute.name === 'aria-hidden' && attribute.value.toLowerCase() === 'true')
      || (attribute.name === 'style' && /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))\s*(?:!important\s*)?(?:;|$)/iu.test(attribute.value)));
}

function invisible(node: HtmlNode, exposeHidden = false): boolean {
  return ['script', 'style', 'template', 'noscript', 'svg'].includes(node.nodeName) || hidden(node, exposeHidden);
}

function streamInsertions(script: string): RegExpExecArray[] {
  const calls: RegExpExecArray[] = [];
  const brackets: string[] = [];
  // Recognize standalone calls without interpreting JavaScript; unsupported syntax fails closed.
  const token = /"(?:\\[\s\S]|[^"\\\r\n])*"|'(?:\\[\s\S]|[^'\\\r\n])*'|\/\*[\s\S]*?\*\/|(?:\/\/|<!--|-->)[^\r\n]*|[^"'`/]/gy;
  let statement = '';
  const finish = () => {
    const call = /^\s*\$RC\("(B:\d+)","(S:\d+)"\)\s*$/u.exec(statement);
    if (call) calls.push(call);
    statement = '';
  };
  for (let offset = 0; offset < script.length;) {
    token.lastIndex = offset;
    const match = token.exec(script);
    if (!match) return [];
    const value = match[0];
    offset = token.lastIndex;
    if (/^(?:\/\/|\/\*|<!--|-->)/u.test(value)) {
      statement += ' ';
      continue;
    }
    if (['(', '[', '{'].includes(value)) brackets.push(value);
    if ([')', ']', '}'].includes(value)
      && brackets.pop() !== ({ ')': '(', ']': '[', '}': '{' } as Record<string, string>)[value]) return [];
    if (value === ';' && !brackets.length) finish();
    else statement += value;
  }
  if (brackets.length) return [];
  finish();
  return calls;
}

function pricingContainers(appId: string, root: HtmlNode): Set<HtmlNode> {
  const exposed = new Set<HtmlNode>();
  const nodes: HtmlNode[] = [];
  const collect = (node: HtmlNode): void => {
    nodes.push(node);
    for (const child of node.childNodes ?? []) collect(child);
  };
  collect(root);
  const attr = (node: HtmlNode, name: string) => node.attrs?.find(item => item.name === name)?.value;
  const unique = (id: string | undefined): HtmlNode | undefined => {
    if (!id) return undefined;
    const matches = nodes.filter(node => attr(node, 'id') === id);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const visibleParents = (node: HtmlNode): boolean => {
    for (let parent = node.parentNode; parent; parent = parent.parentNode) {
      if (invisible(parent)) return false;
    }
    return true;
  };
  if (appId === 'claude-team') {
    const panel = unique('pricing-plans-panel-1');
    const tab = panel && unique(attr(panel, 'aria-labelledby'));
    const label = (node: HtmlNode): string => invisible(node) ? ''
      : node.value ?? (node.childNodes ?? []).map(label).join(' ');
    if (panel?.nodeName === 'div' && attr(panel, 'role') === 'tabpanel'
      && attr(panel, 'hidden') !== undefined && !hidden(panel, true) && visibleParents(panel)
      && tab?.nodeName === 'button' && attr(tab, 'role') === 'tab' && !hidden(tab) && visibleParents(tab)
      && attr(tab, 'aria-controls') === attr(panel, 'id')
      && label(tab).replace(/\s+/gu, ' ').trim() === 'Team & Enterprise') exposed.add(panel);
  } else if (appId === 'chatgpt-business') {
    const links = nodes.filter(node => node.nodeName === 'script' && !hidden(node) && visibleParents(node)
      && attr(node, 'src') === undefined
      && ['', 'text/javascript', 'application/javascript'].includes(attr(node, 'type') ?? ''))
      .flatMap(script => streamInsertions((script.childNodes ?? []).map(node => node.value ?? '').join(''))
        .map(call => ({ target: call[1], segment: call[2], script })));
    for (const link of links) {
      const target = unique(link.target);
      const segment = unique(link.segment);
      if (links.filter(other => other.target === link.target || other.segment === link.segment).length !== 1) continue;
      if (target?.nodeName === 'template' && visibleParents(target)
        && segment?.nodeName === 'div' && attr(segment, 'hidden') !== undefined
        && !hidden(segment, true) && visibleParents(segment)
        && nodes.indexOf(target) < nodes.indexOf(segment) && nodes.indexOf(segment) < nodes.indexOf(link.script)) {
        exposed.add(segment);
      }
    }
  }
  return exposed;
}

function cents(value: string): number {
  const amount = Math.round(Number(value.replaceAll(',', '')) * 100);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 1e14) throw new Error('Invalid team price');
  return amount;
}

export function parseTeamReference(appId: string, html: string): ReferenceRegionSnapshot {
  const source = REFERENCE_WEBSITES.find(item => item.id === appId);
  if (!source || !['chatgpt-business', 'claude-team'].includes(appId)) throw new Error('Unsupported team reference');
  if (Buffer.byteLength(html, 'utf8') > 4 * 1024 * 1024) throw new Error('Team HTML exceeds size limit');
  const seatNames = new Set(source.plans.map(plan => plan.heading));
  if (source.plans.length !== 4 || seatNames.size !== 2 || [...seatNames].some(heading =>
    source.plans.filter(plan => plan.heading === heading && plan.unit === 'seat' && plan.period === 'P1M').length !== 1
    || source.plans.filter(plan => plan.heading === heading && plan.unit === 'seat' && plan.period === 'P1Y').length !== 1)) {
    throw new Error('Invalid team plan metadata');
  }

  const root = parse(html) as HtmlNode;
  const exposed = pricingContainers(appId, root);
  const texts = new Map<HtmlNode, string>();
  const nodes: HtmlNode[] = [];
  const visit = (node: HtmlNode): string => {
    if (invisible(node, exposed.has(node))) return '';
    nodes.push(node);
    const value = node.nodeName === '#text' ? node.value ?? ''
      : (node.childNodes ?? []).map(visit).filter(Boolean).join(' ');
    const normalized = value.replace(/\s+/gu, ' ').trim();
    texts.set(node, normalized);
    return normalized;
  };
  visit(root);
  const text = (node: HtmlNode): string => texts.get(node) ?? '';
  const contains = (parent: HtmlNode, child: HtmlNode): boolean => {
    for (let node: HtmlNode | undefined = child; node; node = node.parentNode) {
      if (node === parent) return true;
    }
    return false;
  };
  const headings = nodes.filter(node => /^h[1-6]$/u.test(node.nodeName));
  const labels = nodes.filter(node => /^(?:p|h[1-6])$/u.test(node.nodeName) && seatNames.has(text(node)));
  const title = appId === 'chatgpt-business' ? 'Business' : 'Team';
  const titles = headings.filter(node => text(node) === title);
  if (!titles.length) throw new Error(`Missing team plan: ${title}`);
  const quotes = new Map<string, { monthly: number; annual: number }>();

  // Split at block boundaries while keeping inline spans in the same price sentence.
  const lines = (node: HtmlNode): string[] => {
    const result: string[] = [];
    let inline: string[] = [];
    const flush = () => {
      const value = inline.join(' ').trim();
      if (value) result.push(value);
      inline = [];
    };
    const append = (child: HtmlNode): void => {
      if (!text(child)) return;
      if (block.test(child.nodeName)) {
        flush();
        result.push(...lines(child));
      } else if (child.nodeName === 'br') {
        flush();
      } else if (child.nodeName === '#text') {
        inline.push(text(child));
      } else {
        for (const descendant of child.childNodes ?? []) append(descendant);
      }
    };
    for (const child of node.childNodes ?? []) append(child);
    flush();
    return result;
  };

  for (const heading of titles) {
    let card = heading.parentNode;
    while (card && !labels.some(label => contains(card!, label))) {
      if (['article', 'section', 'body', 'html'].includes(card.nodeName)) break;
      card = card.parentNode;
    }
    if (!card || headings.some(other => other !== heading && contains(card!, other)
      && Number(other.nodeName[1]) <= Number(heading.nodeName[1]))) {
      throw new Error(`Invalid team plan boundary: ${title}`);
    }
    if (nonUsdCurrency.test(text(card)) || /[\u20ac\u00a3\u00a5\u20b9]/u.test(text(card))) {
      throw new Error('Unsupported team currency');
    }
    const seats = labels.filter(label => contains(card!, label));
    if ([...seatNames].some(name => !seats.some(seat => text(seat) === name))) {
      throw new Error(`Missing team seat: ${title}`);
    }
    for (const seat of seats) {
      let container = seat;
      // Never cross into a sibling seat or another plan to repair an incomplete quote.
      while (container.parentNode && container.parentNode !== card
        && !seats.some(other => other !== seat && contains(container.parentNode!, other))) {
        container = container.parentNode;
      }
      if (headings.some(other => other !== seat && contains(container, other))) {
        throw new Error(`Invalid team seat boundary: ${text(seat)}`);
      }
      const evidence = lines(container).filter(line => line !== text(seat));
      const annualPrices = new Set<number>();
      const monthlyPrices = new Set<number>();
      const displays: number[] = [];
      for (let index = 0; index < evidence.length; index++) {
        const line = evidence[index];
        const billing = (appId === 'chatgpt-business' ? businessBilling : claudeBilling).exec(line);
        if (billing) {
          if (appId === 'chatgpt-business') {
            annualPrices.add(cents(billing[1]));
            monthlyPrices.add(cents(billing[2]));
          } else {
            const display = claudeDisplay.exec(evidence[index - 1] ?? '');
            if (!display) throw new Error('Missing team annual price');
            annualPrices.add(cents(display[1]));
            monthlyPrices.add(cents(billing[1]));
          }
          continue;
        }
        const display = (appId === 'chatgpt-business' ? businessDisplay : claudeDisplay).exec(line);
        if (display) {
          if (appId === 'claude-team' && !claudeBilling.test(evidence[index + 1] ?? '')) {
            throw new Error('Unbound team price');
          }
          displays.push(cents(display[1]));
        } else if (/[$\u20ac\u00a3\u00a5\u20b9]|\b(?:billed|USD|EUR|GBP|CAD|AUD)\b/iu.test(line)) {
          throw new Error(`Invalid team billing evidence: ${text(seat)}`);
        }
      }
      if (!annualPrices.size || !monthlyPrices.size) throw new Error(`Missing team billing price: ${text(seat)}`);
      if (annualPrices.size !== 1 || monthlyPrices.size !== 1) throw new Error(`Conflicting team prices: ${text(seat)}`);
      const annual = [...annualPrices][0];
      const monthly = [...monthlyPrices][0];
      if (displays.some(value => value !== annual)) throw new Error(`Conflicting team display price: ${text(seat)}`);
      if (annual * 12 > 1e14) throw new Error('Invalid annual team price');
      const previous = quotes.get(text(seat));
      if (previous && (previous.annual !== annual || previous.monthly !== monthly)) {
        throw new Error(`Conflicting team prices: ${text(seat)}`);
      }
      quotes.set(text(seat), { monthly, annual });
    }
  }
  const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const offers = source.plans.map(plan => {
    const quote = quotes.get(plan.heading);
    if (!quote) throw new Error(`Missing team seat: ${plan.heading}`);
    const amount = (plan.period === 'P1Y' ? quote.annual * 12 : quote.monthly) / 100;
    return { id: plan.id, name: plan.name, amount, formatted: usd.format(amount),
      period: plan.period, unit: plan.unit, kind: 'subscription' as const };
  });
  return { appId: source.id, country: source.country, currency: 'USD', sourceUrl: source.website,
    capturedAt: new Date().toISOString(), offers };
}
