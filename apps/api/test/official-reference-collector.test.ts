import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchReferenceRegion, ReferenceUnavailableError } from '../src/official-reference/official-reference.collector.js';

const appId = '6448311069';
const signal = () => new AbortController().signal;
const json = (value: unknown, status = 200) => Response.json(value, { status });

// Shape captured from Apple's public /api/apps/v1/catalog API on 2026-09-27.
function offer(id: string, amount: number, currency = 'USD', period?: string) {
  return { assets: [], buyParams: `productType=A&salableAdamId=${id}&appAdamId=${appId}&pricingParameters=STDQ`,
    currencyCode: currency, price: amount, priceFormatted: `${currency} ${amount}`, priceString: String(amount),
    ...(period ? { recurringSubscriptionPeriod: period } : {}), type: 'buy' };
}
function item(id: string, amount: number, period?: string, country = 'us', currency = 'USD') {
  return { id, type: 'in-apps', href: `/v1/catalog/${country}/in-apps/${id}`,
    attributes: { name: 'ChatGPT Plus', isSubscription: !!period, offers: [offer(id, amount, currency, period)] } };
}
function payload(country = 'us', currency = 'USD') {
  return { data: [{ id: appId, type: 'apps', href: `/v1/catalog/${country}/apps/${appId}`,
    attributes: { name: 'ChatGPT', url: `https://apps.apple.com/${country}/app/chatgpt/id${appId}`,
      platformAttributes: { ios: { offers: [{ ...offer(appId, 0, currency), type: 'get' },
        { ...offer(appId, 0, currency), type: 'update' }] } } },
    relationships: { 'top-in-apps': { href: `/v1/catalog/${country}/apps/${appId}/top-in-apps`,
      data: [item('6448311597', 19.99, 'P1M', country, currency), item('6745416289', 200, 'P1Y', country, currency)] } },
  }] };
}

test('collector uses one injected JSON request and preserves same-name monthly and annual SKUs', async () => {
  const urls: string[] = [];
  const result = await fetchReferenceRegion(appId, 'us', async (url, init) => {
    urls.push(String(url));
    assert.equal(new URL(url).hostname, 'apps.apple.com');
    assert.equal(new URL(url).pathname, `/api/apps/v1/catalog/us/apps/${appId}`);
    assert.equal(new URL(url).searchParams.get('include'), 'top-in-apps');
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    return json(payload());
  }, signal());
  assert.equal(urls.length, 1);
  assert.equal(result.sourceUrl, `https://apps.apple.com/us/app/id${appId}`);
  assert.equal(result.currency, 'USD');
  assert.ok(Number.isFinite(Date.parse(result.capturedAt)));
  assert.deepEqual(result.offers.map(x => [x.id, x.name, x.amount, x.period, x.kind]), [
    [appId, 'ChatGPT', 0, null, 'app'],
    ['6448311597', 'ChatGPT Plus', 19.99, 'P1M', 'subscription'],
    ['6745416289', 'ChatGPT Plus', 200, 'P1Y', 'subscription'],
  ]);
});

test('collector retains stable IDs across regions and uses storefront billing currencies', async () => {
  for (const [country, currency] of [['jp', 'JPY'], ['ng', 'NGN'], ['pk', 'PKR'], ['eg', 'EGP'], ['cl', 'CLP'], ['ar', 'USD']]) {
    const result = await fetchReferenceRegion(appId, country, async () => json(payload(country, currency)), signal());
    assert.equal(result.country, country);
    assert.equal(result.currency, currency);
    assert.equal(result.offers[1].id, '6448311597');
  }
});

test('collector includes paid software, keeps one-time purchases, and excludes update offers', async () => {
  const data = payload();
  data.data[0].attributes.platformAttributes.ios.offers[0] = { ...offer(appId, 12.99), type: 'buy' };
  data.data[0].relationships['top-in-apps'].data = [item('6757568473', 4)];
  const result = await fetchReferenceRegion(appId, 'us', async () => json(data), signal());
  assert.deepEqual(result.offers.map(x => [x.id, x.amount, x.kind, x.period]), [
    [appId, 12.99, 'app', null], ['6757568473', 4, 'purchase', null],
  ]);
});

test('collector distinguishes official unavailable errors from failed or blocked requests', async () => {
  const unavailable = { errors: [{ title: 'Resource Not Found', detail: 'Resource with requested id was not found', status: '404', code: '40400' }] };
  await assert.rejects(fetchReferenceRegion(appId, 'cn', async () => json(unavailable, 404), signal()), error =>
    error instanceof ReferenceUnavailableError && error.appId === appId && error.country === 'cn');
  for (const response of [new Response('proxy not found', { status: 404 }), json(unavailable, 403),
    json({ errors: [{ status: '404', code: 'something-else' }] }, 404), new Response(null, { status: 429 })]) {
    await assert.rejects(fetchReferenceRegion(appId, 'us', async () => response, signal()), error =>
      error instanceof Error && !(error instanceof ReferenceUnavailableError));
  }
});

test('collector validates app and storefront before sending any request', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return json(payload()); };
  for (const [id, country] of [['../bad', 'us'], [appId, 'xx'], [appId, 'US'], ['', 'us']]) {
    await assert.rejects(fetchReferenceRegion(id, country, fetcher, signal()));
  }
  assert.equal(calls, 0);
});

test('collector fails closed on cross-app, cross-region, mixed-currency and conflicting SKU data', async () => {
  const mutations: Array<(data: any) => void> = [
    data => { data.data[0].id = '12345'; },
    data => { data.data[0].href = `/v1/catalog/jp/apps/${appId}`; },
    data => { data.data[0].attributes.url = `https://apps.apple.com/jp/app/id${appId}`; },
    data => { data.data[0].relationships['top-in-apps'].data[0].href = '/v1/catalog/jp/in-apps/6448311597'; },
    data => { data.data[0].relationships['top-in-apps'].data[0].attributes.offers[0].currencyCode = 'JPY'; },
    data => { data.data[0].relationships['top-in-apps'].data[0].attributes.offers[0].buyParams = 'salableAdamId=6448311597&appAdamId=12345'; },
    data => { data.data[0].relationships['top-in-apps'].data[0].attributes.offers[0].buyParams = `salableAdamId=12345&appAdamId=${appId}`; },
    data => { data.data[0].relationships['top-in-apps'].data.push(item('6448311597', 1, 'P1M')); },
    data => { data.data[0].relationships['top-in-apps'].data[0].attributes.offers.push(offer('6448311597', 1, 'USD', 'P1M')); },
  ];
  for (const mutate of mutations) { const data = payload(); mutate(data);
    await assert.rejects(fetchReferenceRegion(appId, 'us', async () => json(data), signal())); }
});

test('collector rejects truncated, incomplete and invalid prices instead of returning a partial snapshot', async () => {
  const mutations: Array<(data: any) => void> = [
    data => { data.data = []; },
    data => { delete data.data[0].relationships['top-in-apps']; },
    data => { data.data[0].relationships['top-in-apps'].next = '/next'; },
    data => { data.data[0].relationships['top-in-apps'].data[1].attributes.offers[0].price = -1; },
    data => { data.data[0].relationships['top-in-apps'].data[1].attributes.offers[0].price = '200'; },
    data => { data.data[0].relationships['top-in-apps'].data[1].attributes.offers[0].priceString = '20'; },
    data => { data.data[0].relationships['top-in-apps'].data[1].attributes.offers[0].priceFormatted = ''; },
    data => { data.data[0].relationships['top-in-apps'].data[1].attributes.offers[0].recurringSubscriptionPeriod = 'yearly-ish'; },
    data => { data.data[0].relationships['top-in-apps'].data[1].attributes.offers = []; },
    data => { data.data[0].relationships['top-in-apps'].data[1].attributes.isSubscription = 'true'; },
  ];
  for (const mutate of mutations) { const data = payload(); mutate(data);
    await assert.rejects(fetchReferenceRegion(appId, 'us', async () => json(data), signal())); }
  for (const body of ['<html>blocked</html>', '{"data":[', '{}']) {
    await assert.rejects(fetchReferenceRegion(appId, 'us', async () => new Response(body), signal()));
  }
});

test('collector refuses redirects and oversized declared or streamed responses', async () => {
  const responses = [new Response(null, { status: 302, headers: { location: 'https://apps.apple.com/jp/app/id6448311069' } }),
    new Response('{}', { headers: { 'content-length': '99999999' } }),
    new Response(new Uint8Array(4 * 1024 * 1024 + 1))];
  for (const response of responses) await assert.rejects(fetchReferenceRegion(appId, 'us', async () => response, signal()));
});

test('collector honours pre-cancellation without invoking the injected transport', async () => {
  const controller = new AbortController(); controller.abort(new Error('stopped'));
  let calls = 0;
  await assert.rejects(fetchReferenceRegion(appId, 'us', async () => { calls++; return json(payload()); }, controller.signal), /stopped/);
  assert.equal(calls, 0);
});

test('collector cancellation interrupts a stuck fetch even if its transport ignores the signal', async () => {
  const controller = new AbortController();
  const pending = fetchReferenceRegion(appId, 'us', async () => new Promise<Response>(() => {}), controller.signal);
  controller.abort(new Error('stopped fetch'));
  await assert.rejects(pending, /stopped fetch/);
});

test('collector cancels a pending response body and never publishes partial JSON', async () => {
  const controller = new AbortController(); let cancelled = false;
  const response = new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('{"data":[')); },
    cancel() { cancelled = true; } }));
  const pending = fetchReferenceRegion(appId, 'us', async () => response, controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error('stopped body'));
  await assert.rejects(pending, /stopped body/);
  assert.equal(cancelled, true);
});

test('collector enforces its own deadline when the transport never settles', { timeout: 1_000 }, async context => {
  const realSetTimeout = globalThis.setTimeout;
  context.mock.method(globalThis, 'setTimeout', (callback: () => void) => realSetTimeout(callback, 1));
  await assert.rejects(fetchReferenceRegion(appId, 'us', async () => new Promise<Response>(() => {}), signal()),
    error => error instanceof DOMException && error.name === 'TimeoutError');
});

test('collector keeps only one identical universal app SKU across Apple platforms', async () => {
  const data = payload();
  Object.assign(data.data[0].attributes.platformAttributes, { mac: structuredClone(data.data[0].attributes.platformAttributes.ios) });
  const result = await fetchReferenceRegion(appId, 'us', async () => json(data), signal());
  assert.equal(result.offers.filter(x => x.kind === 'app').length, 1);
  assert.equal(result.offers.length, 3);
});

test('collector discards a response arriving after cancellation', async () => {
  const controller = new AbortController();
  let finish: ((response: Response) => void) | undefined;
  let cancelled = false;
  const pending = fetchReferenceRegion(appId, 'us', async () => new Promise<Response>(resolve => { finish = resolve; }), controller.signal);
  controller.abort(new Error('stopped'));
  await assert.rejects(pending, /stopped/);
  finish!(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, true);
});
