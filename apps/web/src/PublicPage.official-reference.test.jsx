import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { VirtuosoMockContext } from 'react-virtuoso';
import PublicPage from './PublicPage.jsx';
import * as reference from './official-reference.js';
import { canonicalProductDisplayName } from '@price-comparison/catalog/catalog-display';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const price = {
  country: 'ph', countryName: '菲律宾', currency: 'PHP', amount: 800, cnyAmount: 100,
  formatted: '₱800', capturedAt: '2026-11-21T10:00:00Z',
  sourceUrl: 'https://apps.apple.com/ph/app/id6448311069', stale: false,
};
const monthly = { id: 'plus-month', name: 'Plus - Monthly', kind: 'subscription', period: 'P1M', prices: [
  { ...price, country: 'us', countryName: '美国', currency: 'USD', amount: 28, cnyAmount: 200 },
  { ...price, country: 'cn', countryName: '中国大陆', currency: 'CNY', amount: 10, cnyAmount: 10, stale: true },
  price,
] };
const catalog = { exchangeDate: '2026-11-21', apps: [{ id: '6448311069', name: 'ChatGPT', plans: [monthly,
  { ...monthly, id: 'plus-year', name: 'Plus - Annual', period: 'P1Y', prices: [{ ...price, cnyAmount: 1000 }] },
] }] };
const offer = {
  productId: '1', shopId: '1', shop: '测试店铺', name: 'Plus 月卡', membershipKind: 'account',
  price: '88', currency: 'CNY', priceStatus: 'estimated', inStock: true, stale: false, settlementQuantity: 1,
  tags: [{ name: 'duration', value: 30 }, { name: 'region', value: 'us' }],
};

const websiteCatalog = { ...catalog, apps: [
  { id: 'cursor', name: 'Cursor', plans: [{ id: 'premium', name: 'Cursor Premium', kind: 'subscription', period: 'P1M',
    prices: [{ ...price, country: 'global', countryName: '美国', currency: 'USD', amount: 30,
      cnyAmount: 210, sourceUrl: 'https://cursor.com/pricing' }],
  }] },
  { id: 'kiro', name: 'Kiro', plans: [{ id: 'pro', name: 'Kiro Pro', kind: 'subscription', period: 'P1M',
    prices: [{ ...price, country: 'global', countryName: '美国', currency: 'USD', amount: 20,
      cnyAmount: 140, sourceUrl: 'https://kiro.dev/pricing/' }],
  }] },
] };

const googleCatalog = { apps: [{ id: '6477489729', name: 'Gemini', plans: [
  { id: 'pro-a', name: 'Google AI Pro (5 TB)', kind: 'subscription', period: 'P1M',
    prices: [{ ...price, cnyAmount: 120, sourceUrl: 'https://apps.apple.com/ph/app/id6477489729' }] },
  { id: 'pro-b', name: 'Google AI Pro (5 TB) #2', kind: 'subscription', period: 'P1M',
    prices: [{ ...price, cnyAmount: 100, sourceUrl: 'https://apps.apple.com/ph/app/id6477489729' }] },
  { id: 'plus-a', name: 'Google AI Plus (400 GB)', kind: 'subscription', period: 'P1M',
    prices: [{ ...price, cnyAmount: 25, sourceUrl: 'https://apps.apple.com/ph/app/id6477489729' }] },
  { id: 'plus-b', name: 'Google AI Plus (2 TB)', kind: 'subscription', period: 'P1M',
    prices: [{ ...price, cnyAmount: 30, sourceUrl: 'https://apps.apple.com/ph/app/id6477489729' }] },
  { id: 'ultra-store', name: 'Google AI Ultra (30 TB)', kind: 'subscription', period: 'P1M',
    prices: [{ ...price, cnyAmount: 900, sourceUrl: 'https://apps.apple.com/ph/app/id6477489729' }] },
  ...[['Gemini Pro', 140], ['Gemini Ultra 5x', 700], ['Gemini Ultra 20x', 1400]].map(([name, cnyAmount]) => ({
    id: name, name, kind: 'subscription', period: 'P1M', prices: [{ ...price, cnyAmount, currency: 'USD',
      country: 'us', countryName: '美国', sourceUrl: 'https://one.google.com/intl/en/about/google-ai-plans/?gl=US&hl=en' }],
  })),
] }] };

test.each([
  ['Gemini Pro', 100, 'app_store'], ['Google AI Plus', 25, 'app_store'],
  ['Gemini Ultra 5x', 700, 'website'], ['Gemini Ultra 20x', 900, 'app_store'],
])('Google matches %s across approved SKU variants and website prices without mixing tiers', (name, cnyAmount, sourceKind) => {
  expect(reference.catalogOfficialPrice(name, offer, googleCatalog)).toMatchObject({ cnyAmount, sourceKind });
});

test('unidentified Google Ultra and unrelated capacities cannot supply an Ultra 5x price', () => {
  const plans = googleCatalog.apps[0].plans.filter(plan => !plan.name.startsWith('Gemini'));
  for (const name of ['Google AI Ultra', 'Google AI Ultra (5 TB)', 'Gemini Ultra']) {
    plans.push({ ...plans[0], id: name, name, prices: [{ ...plans[0].prices[0], cnyAmount: 1 }] });
  }
  expect(reference.catalogOfficialPrice('Gemini Ultra 5x', offer, { apps: [{ ...googleCatalog.apps[0], plans }] })).toBeNull();
});

const businessCatalog = { apps: [{ id: '6448311069', name: 'ChatGPT', plans: [
  { id: 'team-month', name: 'ChatGPT Team', unit: 'seat', kind: 'subscription', period: 'P1M',
    prices: [{ ...price, country: 'global', currency: 'USD', amount: 25, cnyAmount: 175, sourceUrl: 'https://openai.com/business/pricing/' }] },
  { id: 'team-year', name: 'ChatGPT Team', unit: 'seat', kind: 'subscription', period: 'P1Y',
    prices: [{ ...price, country: 'global', currency: 'USD', amount: 240, cnyAmount: 1680, sourceUrl: 'https://openai.com/business/pricing/' }] },
] }] };

test('team reference preserves per-seat billing and compares the actual monthly amount', () => {
  expect(reference.catalogOfficialPrice('ChatGPT Team', offer, businessCatalog))
    .toMatchObject({ unit: 'seat', period: 'P1M', amount: 25, cnyAmount: 175, sourceKind: 'website' });
});

test('canonical Gemini Plus title matches the historical Google AI Plus pricing identity', () => {
  const title = canonicalProductDisplayName({ family: 'google', product: 'gemini', tier: 'plus' });
  expect(title).toBe('Gemini Plus');
  expect(reference.catalogOfficialPrice(title, offer, googleCatalog)).toMatchObject({ cnyAmount: 25 });
});

test('canonical Claude Premium title matches seat-labelled prices and enables an ordinary card', async () => {
  const title = canonicalProductDisplayName({ family: 'anthropic', product: 'claude', tier: 'team_5x' });
  const claude = { apps: [{ id: '6473753684', name: 'Claude', plans: [{
    id: 'team-premium-month', name: 'Claude Team Premium 席位', period: 'P1M', kind: 'subscription', unit: 'seat',
    prices: [{ ...price, country: 'global', countryName: '美国', currency: 'USD', amount: 125, cnyAmount: 875,
      sourceUrl: 'https://claude.com/pricing?currency=USD' }],
  }] }] };
  expect(reference.catalogOfficialPrice(title, offer, claude)).toMatchObject({ amount: 125, unit: 'seat' });
  renderCatalog({ product: { name: title, isAiMembership: false, membershipGroups: undefined }, referenceCatalog: claude });
  expect(await screen.findByLabelText('官方最低参考价')).toHaveTextContent('¥875/席位/月');
});

test.each([
  ['Cursor Premium', 'https://cursor.com/pricing', 210],
  ['Grok·X·Cursor Premium（统一订阅）', 'https://cursor.com/pricing', 210],
  ['Kiro Pro', 'https://kiro.dev/pricing/', 140],
])('matches %s to its verified website source', (title, sourceUrl, cnyAmount) => {
  expect(reference.catalogOfficialPrice(title, offer, websiteCatalog)).toMatchObject({ sourceUrl, cnyAmount });
});

test.each(['Cursor Pro', 'Cursor Pro+', 'Kiro Free', 'Kiro Students', 'Kiro Pro 试用权益账号'])('does not invent current official equivalents for %s', title => {
  expect(reference.catalogOfficialPrice(title, offer, websiteCatalog)).toBeNull();
});

test('website references reject mismatched providers and unexpected URLs', () => {
  for (const sourceUrl of ['https://cursor.com/pricing', 'https://kiro.dev/other', 'https://kiro.dev.evil.example/pricing/']) {
    const app = websiteCatalog.apps[1];
    const plan = app.plans[0];
    expect(reference.catalogOfficialPrice('Kiro Pro', offer, { ...websiteCatalog, apps: [
      { ...app, plans: [{ ...plan, prices: [{ ...plan.prices[0], sourceUrl }] }] },
    ] })).toBeNull();
  }
});

test('known Grok legacy SKUs compare together without treating unified Premium as SuperGrok', () => {
  const grok = { apps: [{ id: '6670324846', name: 'Grok', plans: ['6741437612', '6744708035'].map((id, index) => ({
    id: JSON.stringify([id, 'subscription', 'P1M']), name: index ? 'SuperGrok #2' : 'SuperGrok', kind: 'subscription', period: 'P1M',
    prices: [{ ...price, cnyAmount: index ? 80 : 100, sourceUrl: 'https://apps.apple.com/ph/app/id6670324846' }],
  })) }] };
  expect(reference.catalogOfficialPrice('SuperGrok（旧版）', offer, grok)).toMatchObject({ cnyAmount: 80 });
  expect(reference.catalogOfficialPrice('Grok·X·Cursor Premium（统一订阅）', offer, grok)).toBeNull();
  expect(reference.catalogOfficialPrice('SuperGrok（旧版）', offer, { apps: [
    { ...grok.apps[0], plans: [...grok.apps[0].plans, { ...grok.apps[0].plans[0], id: 'unknown-variant' }] },
  ] })).toBeNull();
});

test('catalog reference compares the lowest fresh official price across regions', () => {
  expect(reference.catalogOfficialPrice('ChatGPT Plus', offer, catalog)).toMatchObject({
    country: 'ph', cnyAmount: 100, period: 'P1M', percentage: 88,
  });
});

test('catalog comparison uses both minima even when the official billing period differs', () => {
  const annual = { ...monthly, id: 'plus-year', name: 'Plus - Annual', period: 'P1Y', prices: [{ ...price, cnyAmount: 20 }] };
  const result = reference.catalogOfficialPrice('ChatGPT Plus', offer, {
    ...catalog, apps: [{ ...catalog.apps[0], plans: [monthly, annual] }],
  });
  expect(result).toMatchObject({ period: 'P1Y', cnyAmount: 20 });
  expect(result.percentage).toBeCloseTo(440);
});

test.each([
  ['higher merchant price', { price: '112' }, 112],
  ['zero merchant price', { price: '0' }, 0],
  ['same foreign currency', { currency: 'PHP', price: '704' }, 88],
  ['RMB alias', { currency: 'RMB' }, 88],
  ['different foreign currency', { currency: 'USD' }, null],
  ['missing duration', { tags: [] }, 88],
  ['warranty is not duration', { tags: [{ name: 'subscription_warranty', value: '质保30天' }] }, 88],
  ['different duration', { tags: [{ name: 'duration', value: 60 }] }, 88],
  ['qualified duration', { tags: [{ name: 'duration', value: { kind: 'min', days: 30 } }] }, 88],
  ['conflicting duration', { tags: [{ name: 'duration', value: 30 }, { name: 'duration', value: 365 }] }, 88],
  ['missing price', { price: null }, null],
  ['blank price', { price: ' ' }, null],
  ['negative price', { price: '-1' }, null],
  ['invalid price', { price: 'Infinity' }, null],
  ['bulk minimum uses the existing unit price', { settlementQuantity: 10 }, 88],
])('catalog percentage handles %s without changing its comparison basis', (_name, changes, percentage) => {
  const actual = reference.catalogOfficialPrice('ChatGPT Plus', { ...offer, ...changes }, catalog)?.percentage;
  if (percentage === null) expect(actual).toBeNull();
  else expect(actual).toBeCloseTo(percentage);
});

test.each([
  [88.2, '8.82折'], [88.26, '8.83折'], [88, '8.8折'], [80, '8折'], [99, '9.9折'], [100, '同价'], [112, '贵 12%'],
  [0, '0折'], [0.01, '0折'], [null, ''], [undefined, ''], [Infinity, ''],
])('official comparison formats %s as a familiar price label', (percentage, label) => {
  expect(reference.formatOfficialDiscount(percentage)).toBe(label);
});

test.each([
  ['other tier', [{ ...monthly, name: 'Pro' }]],
  ['ambiguous SKU', [monthly, { ...monthly, id: 'duplicate', name: 'Plus - Monthly #2' }]],
  ['stale prices', [{ ...monthly, prices: [{ ...price, stale: true }] }]],
  ['missing exchange rate', [{ ...monthly, prices: [{ ...price, cnyAmount: null }] }]],
  ['zero reference', [{ ...monthly, prices: [{ ...price, cnyAmount: 0 }] }]],
  ['untrusted source', [{ ...monthly, prices: [{ ...price, sourceUrl: 'https://shop.invalid' }] }]],
])('catalog omits unreliable official references: %s', (_name, plans) => {
  expect(reference.catalogOfficialPrice('ChatGPT Plus', offer, {
    ...catalog, apps: [{ ...catalog.apps[0], plans }],
  })).toBeNull();
});

function renderCatalog({ groups, referenceFailure = false, product = {}, referenceCatalog = catalog } = {}) {
  const requests = [];
  const item = { id: '42', name: 'ChatGPT Plus', platform: 'openai', isAiMembership: true,
    identity: { family: 'openai', product: 'chatgpt', tier: 'plus' },
    offers: [offer], shopCount: 2, productCount: 2, membershipGroups: groups || ['account', 'top_up', 'top_up_half_price'].map(kind => ({
      kind, minPrice: '88', maxPrice: '88', shopCount: 1, productCount: 1,
      offers: [{ ...offer, membershipKind: kind, productId: kind }],
    })), ...product,
  };
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = new URL(input, 'http://localhost');
    requests.push(url.pathname);
    if (url.pathname === '/api/official-reference/catalog') {
      return referenceFailure ? new Response(null, { status: 503 }) : Response.json(referenceCatalog);
    }
    if (url.pathname === '/api/analytics/collect') return new Response(null, { status: 204 });
    if (url.pathname.endsWith('/price-history')) return Response.json({ points: [] });
    if (url.pathname === '/api/catalog/coverage') return Response.json({ shopCount: 2, productCount: 2 });
    if (url.pathname === '/api/catalog/products') return Response.json({ items: [item] });
    return Response.json({ items: [item], total: 1, offerTotal: 2, platformFacets: ['openai'] });
  }));
  render(<VirtuosoMockContext.Provider value={{ viewportHeight: 1600, itemHeight: 300 }}><PublicPage /></VirtuosoMockContext.Provider>);
  return requests;
}

test('Kiro paid products show website references even before they have membership groups', async () => {
  renderCatalog({ referenceCatalog: websiteCatalog, product: { name: 'Kiro Pro', platform: 'kiro', isAiMembership: false, membershipGroups: undefined } });
  const official = await screen.findByLabelText('官方最低参考价');
  expect(official).toHaveTextContent('¥140/月');
  expect(official).toHaveTextContent('美国');
  expect(official).toHaveTextContent('6.29折');
  expect(official).not.toHaveAttribute('title', expect.stringContaining('App Store'));
});

test('Notion Business ordinary cards show their existing official price', async () => {
  renderCatalog({ product: { name: 'Notion Business', platform: 'notion', isAiMembership: false, membershipGroups: undefined },
    referenceCatalog: { apps: [{ id: '1232780281', name: 'Notion', plans: [{
      id: 'business', name: 'Business', kind: 'subscription', period: 'P1M',
      prices: [{ ...price, sourceUrl: 'https://apps.apple.com/ph/app/id1232780281' }],
    }] }] },
  });
  const official = await screen.findByLabelText('官方最低参考价');
  expect(official).toHaveTextContent('¥100/月');
  expect(official).toHaveTextContent('8.8折');
});

test('business card labels the official price as a single seat rather than a whole workspace', async () => {
  renderCatalog({ product: { name: 'ChatGPT Team' }, referenceCatalog: businessCatalog });
  const prices = await screen.findAllByLabelText('官方最低参考价');
  expect(prices[0]).toHaveTextContent('¥175/席位/月');
  expect(prices[0]).not.toHaveAttribute('title', expect.stringContaining('App Store'));
});

test('membership cards show the estimate beside the lowest price and share one official reference request', async () => {
  const requests = renderCatalog();
  await screen.findAllByLabelText('官方最低参考价');
  for (const kind of ['成品号', '代充 · 通用', '代充 · 半价资格']) {
    const card = screen.getByRole('button', { name: `ChatGPT Plus · ${kind}` }).closest('article');
    const lowest = card.querySelector('.product-lowest-price');
    expect(lowest).toHaveTextContent('¥88 起');
    expect(within(lowest).getByLabelText('预估价')).toHaveTextContent('估');
    expect(within(lowest).getByLabelText('预估价')).toHaveAttribute('title', '预估价');
    expect(card.querySelector('.product-counts')).not.toHaveTextContent('估');
    const official = within(card).getByLabelText('官方最低参考价');
    expect(official).toHaveAttribute('title', expect.stringContaining('App Store 最低参考价'));
    expect(official).toHaveTextContent('¥100');
    expect(official).toHaveTextContent('菲律宾');
    expect(official).toHaveTextContent('¥100/月');
    expect(official).toHaveTextContent('8.8折');
  }
  expect(requests.filter(path => path === '/api/official-reference/catalog')).toHaveLength(1);
});

test('the percentage uses the card minimum even if its quote is not in the preview', async () => {
  renderCatalog({ groups: [{ kind: 'account', minPrice: '50', maxPrice: '88', shopCount: 1, productCount: 2,
    offers: [offer],
  }] });
  const official = await screen.findByLabelText('官方最低参考价');
  const card = screen.getByRole('button', { name: 'ChatGPT Plus · 成品号' }).closest('article');
  expect(card.querySelector('.product-lowest-price')).toHaveTextContent('¥50 起');
  expect(within(card).queryByLabelText('预估价')).not.toBeInTheDocument();
  expect(official).toHaveTextContent('5折');
});

test.each([
  ['88.2', 'lower', '8.82折'], ['112', 'higher', '贵 12%'], ['100', 'same', '同价'],
])('comparison labels distinguish %s with both text and color state', async (amount, relation, label) => {
  renderCatalog({ groups: [{ kind: 'account', minPrice: amount, maxPrice: amount, shopCount: 1, productCount: 1,
    offers: [{ ...offer, price: amount, tags: [] }],
  }] });
  const official = await screen.findByLabelText('官方最低参考价');
  const comparison = official.querySelector('.product-official-percentage');
  expect(comparison).toHaveTextContent(label);
  expect(comparison).toHaveAttribute('data-price-relation', relation);
});

test.each(['rental', 'short_term'])('other membership groups do not load official references: %s', async kind => {
  const requests = renderCatalog({ groups: [{ kind, minPrice: '88', maxPrice: '88', shopCount: 1, productCount: 1,
    offers: [{ ...offer, membershipKind: kind }],
  }] });
  await screen.findByRole('button', { name: `ChatGPT Plus · ${kind === 'rental' ? '租号' : '短期'}` });
  expect(screen.queryByLabelText('官方最低参考价')).not.toBeInTheDocument();
  expect(requests).not.toContain('/api/official-reference/catalog');
});

test('reference service failure leaves merchant prices available', async () => {
  renderCatalog({ referenceFailure: true });
  const card = (await screen.findByRole('button', { name: 'ChatGPT Plus · 成品号' })).closest('article');
  expect(card).toHaveTextContent('¥88 起');
  expect(screen.queryByLabelText('官方最低参考价')).not.toBeInTheDocument();
});
