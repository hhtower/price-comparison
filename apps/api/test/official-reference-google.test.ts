import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchGoogleReference, parseGoogleReference } from '../src/official-reference/official-reference.google.js';

const cells = [
  ['Google AI Plus', 'PRICE_GEN_AI_PLUS_MONTHLY'],
  ['Google AI Pro', 'PRICE_GEN_AI_PRO_MONTHLY'],
  ['Google AI Ultra 5x', 'PRICE_GEN_AI_ULTRA_100_MONTHLY'],
  ['Google AI Ultra 20x', 'PRICE_GEN_AI_ULTRA_200_MONTHLY'],
];
const html = `<script type="module" src="/about/assets/d/other.min.js"></script>
<script type="module" src="/about/assets/d/prices.min.js"></script>
<table><thead><tr>${cells.map(([name, key]) => `<th><div>${name}</div><div><g1-localized-price variant="${key}" country="US"></g1-localized-price>/mo</div></th>`).join('')}</tr></thead></table>`;
const feed = { COUNTRY_CODE: 'US', CURRENCY_CODE: 'USD', PRICE_GEN_AI_PLUS_MONTHLY: 4.99,
  PRICE_GEN_AI_PRO_MONTHLY: 19.99, PRICE_GEN_AI_ULTRA_100_MONTHLY: 99.99, PRICE_GEN_AI_ULTRA_200_MONTHLY: 199.99 };
const priceScript = 'const file = preview() || `pricing_2026_11_16.json`; customElements.define(`g1-localized-price`, Component);';

test('Google binds official comparison headings to distinct Plus, Pro, Ultra 5x and 20x feed prices', () => {
  const snapshot = parseGoogleReference(html, feed);
  assert.equal(snapshot.appId, 'google-ai');
  assert.equal(snapshot.country, 'us');
  assert.equal(snapshot.currency, 'USD');
  assert.equal(snapshot.sourceUrl, 'https://one.google.com/intl/en/about/google-ai-plans/?gl=US&hl=en');
  assert.deepEqual(snapshot.offers.map(offer => [offer.name, offer.amount, offer.period]), [
    ['Google AI Plus', 4.99, 'P1M'], ['Gemini Pro', 19.99, 'P1M'],
    ['Gemini Ultra 5x', 99.99, 'P1M'], ['Gemini Ultra 20x', 199.99, 'P1M'],
  ]);
  assert.equal(parseGoogleReference(html, { ...feed, PRICE_GEN_AI_ULTRA_100_MONTHLY: 88.88 }).offers[2].amount, 88.88);
});

test('Google rejects mismatched country, currency, missing and malformed prices atomically', () => {
  for (const change of [
    { COUNTRY_CODE: 'CA' }, { CURRENCY_CODE: 'EUR' }, { COUNTRY_CODE: undefined },
    ...[undefined, null, '99.99', 0, -1, Infinity, NaN, 1e13].map(value => ({ PRICE_GEN_AI_ULTRA_100_MONTHLY: value })),
  ]) assert.throws(() => parseGoogleReference(html, { ...feed, ...change }));
  for (const input of [null, [], 'not JSON']) assert.throws(() => parseGoogleReference(html, input));
});

test('Google requires the visible official tier and price-key pairing, not nearby or scripted hints', () => {
  for (const changed of [
    html.replace('Google AI Ultra 5x', 'Google AI Ultra'),
    html.replace('variant="PRICE_GEN_AI_ULTRA_100_MONTHLY"', 'variant="PRICE_GEN_AI_ULTRA_200_MONTHLY"'),
    html.replace('country="US"', 'country="CA"'),
    html.replace('<table>', '<table hidden>'),
    html.replace('<table>', '<template><table>') + '</template>',
    html.replace('<table>', '<script><table>') + '</script>',
    html.replace('Google AI Pro', 'Google AI Pro Max'),
  ]) assert.throws(() => parseGoogleReference(changed, feed));
});

test('Google discovers the current versioned feed from the official page script without executing it', async () => {
  const urls: string[] = [];
  const snapshot = await fetchGoogleReference(async (url, init) => {
    const value = String(url); urls.push(value);
    assert.equal(new URL(value).hostname, 'one.google.com');
    assert.equal(init?.redirect, 'manual');
    if (value.includes('google-ai-plans')) return new Response(html);
    if (value.endsWith('other.min.js')) return new Response('/* not pricing */');
    if (value.endsWith('prices.min.js')) return new Response(priceScript.replace('2026_11_16', '2026_12_03'));
    assert.equal(value, 'https://one.google.com/intl/ALL_us/about/feeds/pricing_2026_12_03.json');
    return Response.json(feed);
  }, new AbortController().signal);
  assert.equal(snapshot.offers.length, 4);
  assert.equal(urls.length, 4);
});

test('Google rejects unknown or ambiguous feed discovery and never requests an untrusted asset', async () => {
  for (const script of [
    'const file = `pricing_2026_11_16.json`;',
    priceScript.replace('pricing_2026_11_16.json', '../../private.json'),
    priceScript + 'const other = preview() || `pricing_2026_12_03.json`;',
  ]) await assert.rejects(fetchGoogleReference(async url =>
    new Response(String(url).includes('google-ai-plans') ? html : script), new AbortController().signal));
  const urls: string[] = [];
  await assert.rejects(fetchGoogleReference(async url => {
    urls.push(String(url));
    return new Response(html.replaceAll('/about/assets/d/', 'https://evil.example/'));
  }, new AbortController().signal));
  assert.equal(urls.length, 1);
});

test('Google cancellation and partial feed failures cannot return an incomplete snapshot', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fetchGoogleReference(async () => { assert.fail('cancelled fetch'); }, controller.signal));
  await assert.rejects(fetchGoogleReference(async url => {
    if (String(url).includes('google-ai-plans')) return new Response(html);
    if (String(url).endsWith('.min.js')) return new Response(priceScript);
    return new Response('{"COUNTRY_CODE":"US"');
  }, new AbortController().signal));
});
