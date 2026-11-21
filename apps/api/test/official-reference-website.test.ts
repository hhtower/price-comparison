import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REFERENCE_WEBSITES } from '@price-comparison/catalog/official-reference';
import { fetchWebsiteReference, parseWebsiteReference } from '../src/official-reference/official-reference.website.js';
import { createRunFetchFactory } from '../src/crawler/fetch-client.js';
import { ProxyPool } from '../src/crawler/proxy-pool.js';
import { HostRateLimiter } from '../src/crawler/rate-limiter.js';

// Small excerpts preserve the heading wrappers and price blocks in the saved pages.
const cursor = `
<section>
  <div><div><h3>Plus</h3></div><p><span>$8</span><span>/month</span></p><a>Get Plus</a></div>
  <div><div><h3>Premium</h3><span>Most popular</span></div><p>$30/month</p><a>Get Premium</a></div>
  <div><div><h3>Super</h3></div><p>$100/month</p><a>Get Super</a></div>
  <div><div><h3>Ultra</h3></div><p>$200/month</p><a>Get Ultra</a></div>
</section>`;
const kiro = `
<p>Free trial: the rest of your first month is free.</p>
<section>
  <div><div><h2>KIRO PRO</h2></div><div><div>$20</div><div>per user / month</div></div><p>Add-on credits ($0.04/credit)</p></div>
  <div><div><h2>KIRO PRO+</h2></div><div><div>$40</div><div>per user / month</div></div><p>Add-on credits ($0.04/credit)</p></div>
  <div><div><h2>KIRO PRO MAX</h2></div><div><div>$100</div><div>per user / month</div></div><p>Add-on credits ($0.04/credit)</p></div>
  <div><div><h2>KIRO POWER</h2></div><div><div>$200</div><div>per user / month</div></div><p>Add-on credits ($0.04/credit)</p></div>
</section>
<section><h2>Teams and enterprises</h2><p>$20 per seat / month</p></section>
<section><h2>Common Questions</h2><p>Pro ($20/month), Pro+ ($40/month), add-on credits $0.04/credit.</p></section>`;

test('Cursor produces the complete registered monthly USD snapshot', () => {
  const before = Date.now();
  const snapshot = parseWebsiteReference('cursor', cursor);
  assert.deepEqual({ ...snapshot, capturedAt: 'now' }, {
    appId: 'cursor', country: 'global', currency: 'USD',
    sourceUrl: 'https://cursor.com/pricing', capturedAt: 'now',
    offers: [
      { id: 'plus', name: 'Cursor Plus', amount: 8, formatted: '$8.00', period: 'P1M', kind: 'subscription' },
      { id: 'premium', name: 'Cursor Premium', amount: 30, formatted: '$30.00', period: 'P1M', kind: 'subscription' },
      { id: 'super', name: 'Cursor Super', amount: 100, formatted: '$100.00', period: 'P1M', kind: 'subscription' },
      { id: 'ultra', name: 'Cursor Ultra', amount: 200, formatted: '$200.00', period: 'P1M', kind: 'subscription' },
    ],
  });
  assert.ok(Date.parse(snapshot.capturedAt) >= before && Date.parse(snapshot.capturedAt) <= Date.now());
});

test('Kiro reads plan prices without including trial, add-on or team prices', () => {
  const snapshot = parseWebsiteReference('kiro', kiro);
  assert.equal(snapshot.appId, 'kiro');
  assert.equal(snapshot.country, 'global');
  assert.equal(snapshot.currency, 'USD');
  assert.equal(snapshot.sourceUrl, 'https://kiro.dev/pricing/');
  assert.deepEqual(snapshot.offers, [
    { id: 'pro', name: 'Kiro Pro', amount: 20, formatted: '$20.00', period: 'P1M', kind: 'subscription' },
    { id: 'pro_plus', name: 'Kiro Pro+', amount: 40, formatted: '$40.00', period: 'P1M', kind: 'subscription' },
    { id: 'pro_max', name: 'Kiro Pro Max', amount: 100, formatted: '$100.00', period: 'P1M', kind: 'subscription' },
    { id: 'power', name: 'Kiro Power', amount: 200, formatted: '$200.00', period: 'P1M', kind: 'subscription' },
  ]);
});

test('prices are parsed dynamically, including cents and grouped USD amounts', () => {
  const changedCursor = cursor.replace('$8', '&#36;9.25').replace('$30', '$31')
    .replace('$100', '$125.50').replace('$200', '$1,234.56');
  assert.deepEqual(parseWebsiteReference('cursor', changedCursor).offers.map(o => [o.amount, o.formatted]),
    [[9.25, '$9.25'], [31, '$31.00'], [125.5, '$125.50'], [1234.56, '$1,234.56']]);
  const changedKiro = kiro.replace('$20</div>', '$23.50</div>').replace('$40</div>', '$48</div>')
    .replace('$100</div>', '$115</div>').replace('$200</div>', '$250</div>');
  assert.deepEqual(parseWebsiteReference('kiro', changedKiro).offers.map(o => o.amount), [23.5, 48, 115, 250]);
});

for (const [appId, html] of [['cursor', cursor], ['kiro', kiro]]) {
  test(`${appId} accepts identical repeated cards and rejects conflicting duplicates`, () => {
    assert.equal(parseWebsiteReference(appId, html + html).offers.length, 4);
    assert.throws(() => parseWebsiteReference(appId, html + html.replace('$200', '$201')), /conflict/i);
  });

  test(`${appId} rejects partial pages even when FAQ or script contains the missing price`, () => {
    const partial = html.slice(0, html.indexOf(appId === 'cursor'
      ? '<div><div><h3>Ultra' : '<div><div><h2>KIRO POWER'));
    assert.throws(() => parseWebsiteReference(appId, partial));
    assert.throws(() => parseWebsiteReference(appId,
      partial + `<script>${html}</script><p>Ultra $200/month; KIRO POWER $200 per user / month</p>`));
  });

  test(`${appId} excludes non-visible HTML from price evidence`, () => {
    for (const tag of ['script', 'style', 'template', 'noscript']) {
      assert.throws(() => parseWebsiteReference(appId, `<${tag}>${html}</${tag}>`));
      assert.deepEqual(parseWebsiteReference(appId, `<${tag}>${html.replace('$200', '$1')}</${tag}>${html}`).offers,
        parseWebsiteReference(appId, html).offers);
    }
    for (const attributes of ['hidden', 'aria-hidden="true"', 'style="display: none"']) {
      assert.throws(() => parseWebsiteReference(appId, `<div ${attributes}>${html}</div>`));
    }
  });
}

test('missing prices cannot bind to a neighboring plan, heading or unrelated card', () => {
  for (const replacement of [
    '', '<h4>Teams</h4><p>$8/month</p>',
    '<p>Trial: $1/month</p>', '<p>Add-on credits $0.04/month</p>',
    '<p>$8/user/month</p>', '<p>$8/month for the first month</p>',
  ]) {
    assert.throws(() => parseWebsiteReference('cursor',
      cursor.replace('<p><span>$8</span><span>/month</span></p>', replacement)), replacement);
  }
  assert.throws(() => parseWebsiteReference('cursor',
    cursor.replace('<p><span>$8</span><span>/month</span></p><a>Get Plus</a>', '')));
  assert.throws(() => parseWebsiteReference('kiro', kiro.replace('<div>$20</div>', '<div></div>')));
  assert.throws(() => parseWebsiteReference('kiro',
    kiro.replace('<div>$20</div><div>per user / month</div>', '<div>$20 per seat / month</div>')));
});

test('malformed, non-USD, non-monthly and ambiguous plan prices reject the whole snapshot', () => {
  for (const price of ['$0', '$-8', '$NaN', '$1e2', '$8.001', '$1,23', '$1,000,00', '$1000000000001', 'EUR 8', 'CA$8']) {
    assert.throws(() => parseWebsiteReference('cursor', cursor.replace('$8', price)), price);
  }
  assert.throws(() => parseWebsiteReference('cursor', cursor.replace('/month', '/year')));
  assert.throws(() => parseWebsiteReference('cursor',
    cursor.replace('<span>$8</span>', '<s>$8</s><span>$4</span>')));
  assert.throws(() => parseWebsiteReference('cursor',
    cursor.replace('<a>Get Ultra</a>', '<p>$201/month</p><a>Get Ultra</a>')));
  assert.throws(() => parseWebsiteReference('cursor', cursor + '<div><h3>Plus</h3><p>Contact sales</p></div>'));
});

test('unsupported IDs and URL inputs reject before making any request', async () => {
  let calls = 0;
  for (const appId of ['', 'Cursor', 'unknown', 'https://cursor.com/pricing', 'http://127.0.0.1/', 'cursor/../kiro']) {
    assert.throws(() => parseWebsiteReference(appId, cursor));
    await assert.rejects(fetchWebsiteReference(appId, async () => {
      calls++; return new Response(cursor);
    }, new AbortController().signal));
  }
  assert.equal(calls, 0);
});

test('invalid registered source URLs reject before making any request', async () => {
  const source = REFERENCE_WEBSITES.find(item => item.id === 'cursor')!;
  const original = source.website;
  let calls = 0;
  try {
    for (const website of ['http://cursor.com/pricing', 'https://evil.example/pricing',
      'https://user@cursor.com/pricing', 'https://cursor.com/not-pricing', 'not a URL']) {
      Object.assign(source, { website });
      assert.throws(() => parseWebsiteReference('cursor', cursor));
      await assert.rejects(fetchWebsiteReference('cursor', async () => {
        calls++; return new Response(cursor);
      }, new AbortController().signal));
    }
  } finally {
    Object.assign(source, { website: original });
  }
  assert.equal(calls, 0);
});

test('fetch uses the registered URL and bounded redirect policy for both sites', async () => {
  for (const [appId, html, url] of [
    ['cursor', cursor, 'https://cursor.com/pricing'],
    ['kiro', kiro, 'https://kiro.dev/pricing/'],
  ]) {
    const snapshot = await fetchWebsiteReference(appId, async (requested, init) => {
      assert.equal(String(requested), url);
      assert.equal(init?.redirect, 'manual');
      assert.ok(init?.signal instanceof AbortSignal);
      return new Response(html);
    }, new AbortController().signal);
    assert.equal(snapshot.sourceUrl, url);
    assert.equal(snapshot.offers.length, 4);
  }
});

test('website collection opts into HTML in the real shared crawler transport', async () => {
  const signal = new AbortController().signal;
  const fetcher = createRunFetchFactory({
    pool: new ProxyPool([]), limiter: new HostRateLimiter(new Map()),
    fetchImpl: (async () => new Response(cursor, { headers: { 'content-type': 'text/html; charset=utf-8' } })) as never,
  })(signal);
  const snapshot = await fetchWebsiteReference('cursor', fetcher, signal);
  assert.equal(snapshot.offers.length, 4);
  assert.equal(snapshot.offers[1].amount, 30);
});

test('shared crawler leaves manual HTML redirects to the source origin validator', async () => {
  for (const location of ['/pricing/', 'https://evil.example/private']) {
    const urls: string[] = [];
    const signal = new AbortController().signal;
    const fetcher = createRunFetchFactory({
      pool: new ProxyPool([]), limiter: new HostRateLimiter(new Map()),
      fetchImpl: (async (url: string | URL) => {
        urls.push(String(url));
        return urls.length === 1 ? new Response('<p>Moved</p>', {
          status: 301, headers: { 'content-type': 'text/html', location },
        }) : new Response(cursor, { headers: { 'content-type': 'text/html' } });
      }) as never,
    })(signal);
    if (location.startsWith('/')) {
      assert.equal((await fetchWebsiteReference('cursor', fetcher, signal)).offers.length, 4);
      assert.deepEqual(urls, ['https://cursor.com/pricing', 'https://cursor.com/pricing/']);
    } else {
      await assert.rejects(fetchWebsiteReference('cursor', fetcher, signal), /redirect/);
      assert.deepEqual(urls, ['https://cursor.com/pricing']);
    }
  }
});

test('same-origin redirects retain the exact registered source URL', async () => {
  let calls = 0;
  const snapshot = await fetchWebsiteReference('cursor', async () => ++calls === 1
    ? new Response(null, { status: 302, headers: { location: '/pricing/' } })
    : new Response(cursor), new AbortController().signal);
  assert.equal(snapshot.sourceUrl, 'https://cursor.com/pricing');
  assert.equal(calls, 2);
});

test('cross-origin redirects fail without requesting the new origin', async () => {
  let calls = 0;
  await assert.rejects(fetchWebsiteReference('cursor', async () => {
    calls++; return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
  }, new AbortController().signal), /redirect/i);
  assert.equal(calls, 1);
});

test('network, HTTP, partial-body and size failures cannot return a snapshot', async () => {
  const networkError = new Error('offline');
  await assert.rejects(fetchWebsiteReference('cursor', async () => { throw networkError; },
    new AbortController().signal), networkError);
  for (const response of [
    new Response(cursor, { status: 503 }),
    new Response(cursor.slice(0, 200)),
    new Response(cursor, { headers: { 'content-length': '4194305' } }),
    new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(4194305)); controller.close(); },
    })),
    new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(cursor)); },
      pull(controller) { controller.error(new Error('body disconnected')); },
    })),
  ]) {
    await assert.rejects(fetchWebsiteReference('cursor', async () => response, new AbortController().signal));
  }
});

test('already cancelled requests never fetch', async () => {
  let calls = 0;
  await assert.rejects(fetchWebsiteReference('cursor', async () => {
    calls++; return new Response(cursor);
  }, AbortSignal.abort(new Error('cancelled'))), /cancelled/);
  assert.equal(calls, 0);
});

test('cancellation discards even a complete-looking page until the body finishes', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const pending = fetchWebsiteReference('cursor', async () => new Response(new ReadableStream({
    start(stream) { stream.enqueue(new TextEncoder().encode(cursor)); },
    pull() { controller.abort(new Error('cancelled during body')); },
    cancel() { cancelled = true; },
  })), controller.signal);
  await assert.rejects(pending, /cancelled during body/);
  assert.equal(cancelled, true);
});
