import assert from 'node:assert/strict';
import test from 'node:test';
import { createIpQualityDetector } from '../src/quality/ip-quality-detector.js';
import type { IpQualityDetectorOptions } from '../src/quality/ip-quality-detector.js';
import type { ParsedIpTarget } from '../src/quality/quality-input.js';
import type { QualityItemResult } from '../src/quality/quality.types.js';

const plain = { kind: 'ip' as const, target: '8.8.8.8', runs: 3 };
const proxy = { ...plain, target: 'socks5://user:proxy-password@proxy.example:1080' };
const identity = { success: true, ip: '8.8.8.8', country_code: 'US', connection: { asn: 15169, org: 'Google LLC', isp: 'Google LLC' } };
const sourceOptions = { identityUrl: 'https://identity.example/{ip}', reputationUrl: 'https://reputation.example/{ip}', egressUrl: 'https://egress.example/', headersUrl: 'https://headers.example/', dnsUrl: 'https://dns.example/dns-query', aiServices: [{ url: 'https://ai.example/', expectedText: 'AI service ready' }] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
type Dial = (host: string, port: number, signal?: AbortSignal) => Promise<{ ok: boolean; ms: number }>;
function harness(respond: (url: URL, init?: RequestInit) => Response | Promise<Response>, options: Partial<IpQualityDetectorOptions> = {}, dial: Dial = async () => ({ ok: true, ms: 12 })) {
  const routes: string[] = [];
  const factories: Array<ParsedIpTarget | undefined> = [];
  let closed = 0;
  const detector = createIpQualityDetector({ ...sourceOptions, ...options, createFetch: async target => {
    factories.push(target);
    return { fetch: (async (url, init) => { routes.push(String(url)); return respond(new URL(String(url)), init); }) as typeof fetch, dial, close: async () => { closed++; } };
  } });
  return { detector, routes, factories, get closed() { return closed; } };
}
async function run(h: ReturnType<typeof harness>, ids: string[], input = proxy, signal = new AbortController().signal, onItem = (_: QualityItemResult) => {}) {
  const results = await h.detector(input, ids, signal, onItem);
  assert.equal(results.length, ids.length);
  return results;
}

test('plain IP performs identity lookups only and marks every exit item unavailable without opening a proxy', async () => {
  const h = harness(url => { assert.equal(url.hostname, 'identity.example'); assert.equal(url.pathname, '/8.8.8.8'); return json(identity); });
  const ids = ['geo', 'asn', 'provider', 'ai-access', 'region-limit', 'latency', 'packet-loss', 'dns', 'success-rate', 'egress', 'header-leak', 'streaming', 'mail'];
  const results = await run(h, ids, plain);
  assert.deepEqual(results.slice(0, 3).map(x => x.status), ['pass', 'pass', 'pass']);
  assert.ok(results.slice(3).every(x => x.status === 'unavailable' && x.score === null));
  assert.deepEqual(h.factories, [undefined]);
  assert.equal(h.routes.length, 1);
  assert.equal(h.closed, 1);
});

test('absent identity fields never become passes and invalid built-in reputation evidence is risk not unrun', async () => {
  const h = harness(() => json({ success: true, ip: '8.8.8.8' }), { reputationUrl: null, dnsblLookup: async () => [] });
  const results = await run(h, ['geo', 'asn', 'provider', 'ip-type', 'risk-score', 'blacklist', 'abuse'], plain);
  assert.deepEqual(results.slice(0, 3).map(x => x.status), ['unrun', 'unrun', 'unrun']);
  assert.deepEqual(results.slice(3).map(x => x.status), ['risk', 'risk', 'pass', 'risk']);
});

test('all proxy identity reputation DNS service and header probes use the same credential-bearing factory without exposing secrets', async () => {
  const h = harness(url => {
    if (url.hostname === 'egress.example') return json({ ip: '8.8.8.8' });
    if (url.hostname === 'identity.example') return json(identity);
    if (url.hostname === 'reputation.example') return json({ ip: '8.8.8.8', networkType: 'hosting', riskScore: 82, blacklisted: true, abuseScore: 40 });
    if (url.hostname === 'dns.example') return json({ Status: 0, Answer: [{ type: url.searchParams.get('type') === 'PTR' ? 12 : 1, data: url.searchParams.get('type') === 'PTR' ? 'dns.google.' : '93.184.216.34' }] });
    if (url.hostname === 'headers.example') return json({ headers: { Host: 'headers.example' } });
    if (url.hostname === 'ai.example') return new Response('AI service ready');
    throw new Error('unexpected route');
  });
  const ids = ['geo', 'asn', 'reverse-dns', 'ip-type', 'provider', 'risk-score', 'blacklist', 'abuse', 'ai-access', 'region-limit', 'latency', 'success-rate', 'egress', 'dns', 'header-leak', 'packet-loss', 'mail'];
  const result = await run(h, ids);
  assert.equal(h.factories.length, 1);
  assert.equal(h.factories[0]?.password, 'proxy-password');
  assert.equal(h.factories[0]?.host, 'proxy.example');
  assert.equal(result.find(x => x.id === 'risk-score')?.status, 'risk');
  assert.equal(result.find(x => x.id === 'blacklist')?.status, 'risk');
  assert.equal(result.find(x => x.id === 'abuse')?.status, 'risk');
  assert.equal(result.find(x => x.id === 'egress')?.status, 'pass');
  assert.equal(result.find(x => x.id === 'dns')?.status, 'pass');
  assert.equal(result.find(x => x.id === 'packet-loss')?.status, 'pass');
  assert.equal(result.find(x => x.id === 'mail')?.status, 'pass');
  assert.equal(JSON.stringify(result).includes('proxy-password'), false);
  assert.equal(h.closed, 1);
});

test('reputation identity mismatch and omitted false flags do not fabricate clean reputation', async () => {
  const mismatched = harness(() => json({ ip: '1.1.1.1', riskScore: 0, blacklisted: false, abuseScore: 0 }));
  assert.ok((await run(mismatched, ['risk-score', 'blacklist', 'abuse'], plain)).every(x => x.status === 'risk'));
  const omitted = harness(() => json({ ip: '8.8.8.8', riskScore: 0 }));
  const result = await run(omitted, ['risk-score', 'blacklist', 'abuse'], plain);
  assert.equal(result[0].status, 'pass');
  assert.deepEqual(result.slice(1).map(x => x.status), ['unrun', 'unrun']);
});

test('regional block and successful-status challenge pages are risks instead of AI access passes', async () => {
  for (const body of ['AI service ready unsupported_country_region_territory', '<title>Just a moment...</title> AI service ready', 'verify you are human AI service ready', 'Enable JavaScript and cookies to continue AI service ready', 'window._cf_chl_opt = {} AI service ready']) {
    const h = harness(() => new Response(body));
    const results = await run(h, ['ai-access', 'region-limit']);
    assert.ok(results.every(x => x.status === 'risk'));
  }
  const unknown = harness(() => new Response('a generic 200 page'));
  assert.ok((await run(unknown, ['ai-access', 'region-limit'])).every(x => x.status === 'unrun'));
});

test('HTTP failures reduce success rate and unstable egress is risk without fabricating ICMP packet loss', async () => {
  let attempts = 0;
  const h = harness(() => ++attempts === 2 ? json({ error: 'upstream secret' }, 502) : json({ ip: attempts === 1 ? '8.8.8.8' : '1.1.1.1' }));
  const results = await run(h, ['success-rate', 'egress', 'latency', 'packet-loss']);
  assert.equal(results[0].status, 'risk');
  assert.equal(results[0].score, 67);
  assert.equal(results[1].status, 'risk');
  assert.equal(results[2].status, 'risk');
  assert.equal(results[3].status, 'pass');
  assert.equal(attempts, 3);
});

test('one egress observation cannot prove stable egress', async () => {
  const h = harness(() => json({ ip: '8.8.8.8' }));
  assert.equal((await run(h, ['egress'], { ...proxy, runs: 1 }))[0].status, 'unrun');
});

test('forwarded headers are risky and their secret contents are never reported', async () => {
  const h = harness(() => json({ headers: { 'X-Forwarded-For': 'proxy-password', 'Proxy-Authorization': 'Bearer private-value' } }));
  const result = await run(h, ['header-leak']);
  assert.equal(result[0].status, 'risk');
  assert.equal(JSON.stringify(result).includes('proxy-password'), false);
  assert.equal(JSON.stringify(result).includes('private-value'), false);
});

test('invalid JSON, truncated body, oversized body and denied sources remain explicit risks', async () => {
  const cases = [
    () => new Response('{"success":'),
    () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{')); c.error(new Error('proxy-password')); } })),
    () => new Response('x'.repeat(1025)),
    () => json({ message: 'proxy-password' }, 403),
    () => json({ success: false, message: 'proxy-password' }),
  ];
  for (const respond of cases) {
    const h = harness(respond, { maxResponseBytes: 1024 });
    const result = await run(h, ['geo'], plain);
    assert.equal(result[0].status, 'risk');
    assert.equal(JSON.stringify(result).includes('proxy-password'), false);
    assert.equal(h.closed, 1);
  }
});

test('timeout aborts network work and returns risk even when a transport does not settle', async () => {
  let observed: AbortSignal | undefined;
  const h = harness((_url, init) => { observed = init?.signal ?? undefined; return new Promise<Response>(() => {}); }, { timeoutMs: 15 });
  const result = await run(h, ['geo'], plain);
  assert.equal(result[0].status, 'risk');
  assert.match(result[0].summary, /超时/);
  assert.equal(observed?.aborted, true);
  assert.equal(h.closed, 1);
});

test('cancellation preserves emitted results and stops all pending probes without leaking an abort reason', async () => {
  const controller = new AbortController();
  const emitted: QualityItemResult[] = [];
  const h = harness(() => json(identity));
  const result = await run(h, ['geo', 'asn', 'provider'], plain, controller.signal, item => { emitted.push(item); if (item.id === 'geo') controller.abort(new Error('proxy-password')); });
  assert.deepEqual(result.map(x => x.status), ['pass', 'cancelled', 'cancelled']);
  assert.deepEqual(emitted, result);
  assert.equal(h.routes.length, 1);
  assert.equal(JSON.stringify(result).includes('proxy-password'), false);
});

test('cancellation interrupts a stalled body and closes the factory', async () => {
  const controller = new AbortController();
  const h = harness(() => new Response(new ReadableStream({ start() { setTimeout(() => controller.abort('secret'), 5); } })), { timeoutMs: 1000 });
  const result = await run(h, ['geo', 'asn'], plain, controller.signal);
  assert.deepEqual(result.map(x => x.status), ['cancelled', 'cancelled']);
  assert.equal(h.closed, 1);
});

test('IPv6 reverse DNS uses the target address rather than local reverse resolution', async () => {
  const h = harness(url => {
    assert.equal(url.searchParams.get('type'), 'PTR');
    assert.equal(url.searchParams.get('name'), '8.8.8.8.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.6.8.4.1.0.0.2.ip6.arpa');
    return json({ Status: 0, Answer: [{ type: 12, data: 'dns.google.' }] });
  });
  assert.equal((await run(h, ['reverse-dns'], { ...plain, target: '2001:4860::8888' }))[0].status, 'pass');
});

test('NXDOMAIN reverse DNS reports no observed record instead of a failed probe', async () => {
  const h = harness(url => {
    assert.equal(url.searchParams.get('type'), 'PTR');
    assert.equal(url.searchParams.get('name'), '8.8.8.8.in-addr.arpa');
    return json({ Status: 3 });
  });
  const result = (await run(h, ['reverse-dns'], plain))[0];
  assert.equal(result.status, 'unrun');
  assert.equal(result.score, null);
});

test('built-in reputation source maps ip-api flags and DNSBL hits onto the risk items', async () => {
  const h = harness(url => {
    if (url.hostname === 'ip-api.com') return json({ status: 'success', query: '8.8.8.8', country: 'US', isp: 'Example ISP', hosting: true, proxy: false, mobile: false });
    throw new Error('unexpected route ' + url.hostname);
  }, { reputationUrl: null, dnsblLookup: async () => [] });
  const results = await run(h, ['ip-type', 'risk-score', 'abuse', 'blacklist'], plain);
  assert.equal(results[0].status, 'pass');
  assert.match(results[0].summary, /数据中心网络/);
  assert.equal(results[1].status, 'risk');
  assert.match(results[1].summary, /机房托管标记/);
  assert.equal(results[2].status, 'pass');
  assert.equal(results[3].status, 'pass');
});

test('DNSBL hits flip blacklist and risk-signal items to risk with the zone named', async () => {
  const h = harness(() => json({ status: 'success', query: '8.8.8.8', hosting: false, proxy: false, mobile: false }), { reputationUrl: null, dnsblLookup: async name => name.endsWith('.bl.spamcop.net') ? ['127.0.0.2'] : [] });
  const results = await run(h, ['blacklist', 'risk-score'], plain);
  assert.equal(results[0].status, 'risk');
  assert.match(results[0].summary, /bl\.spamcop\.net/);
  assert.equal(results[1].status, 'risk');
  assert.match(results[1].summary, /DNSBL 命中 1 库/);
});

test('AI probes use expectStatus as evidence instead of page text', async () => {
  const route = (fallback: () => Response) => (url: URL) => url.hostname === 'egress.example' ? json({ ip: '8.8.8.8' }) : fallback();
  const ok = harness(route(() => json({}, 401)), { aiServices: [{ url: 'https://ai.example/v1/models', expectStatus: 401 }] });
  const okResults = await run(ok, ['ai-access', 'region-limit']);
  assert.equal(okResults[0].status, 'pass');
  assert.equal(okResults[1].status, 'pass');
  const blocked = harness(route(() => json({ error: { message: 'unsupported_country_region_territory' } }, 403)), { aiServices: [{ url: 'https://ai.example/v1/models', expectStatus: 401 }] });
  const blockedResults = await run(blocked, ['ai-access', 'region-limit']);
  assert.ok(blockedResults.every(x => x.status === 'risk' && x.summary.includes('地区限制')));
  const mismatch = harness(route(() => json({}, 200)), { aiServices: [{ url: 'https://ai.example/v1/models', expectStatus: 401 }] });
  assert.equal((await run(mismatch, ['ai-access']))[0].status, 'unrun');
});

test('built-in streaming probes classify Netflix dual titles with TikTok and YouTube reachability', async () => {
  const h = harness(url => {
    if (url.hostname === 'egress.example') return json({ ip: '8.8.8.8' });
    if (url.hostname === 'www.netflix.com') return url.pathname === '/title/81280792' ? new Response('self', { status: 200 }) : new Response('gone', { status: 404 });
    if (url.hostname === 'www.tiktok.com') return new Response('ok', { status: 200 });
    if (url.hostname === 'www.youtube.com') return new Response('YouTube Premium', { status: 200 });
    throw new Error('unexpected route ' + url.hostname);
  });
  const partial = await run(h, ['streaming']);
  assert.equal(partial[0].status, 'risk');
  assert.match(partial[0].summary, /仅自制剧可看/);
  assert.match(partial[0].summary, /TikTok 可达/);
  assert.match(partial[0].summary, /YouTube Premium 可达/);
});

test('streaming probes treat oversized bodies as reachability evidence instead of failures', async () => {
  const h = harness(url => {
    if (url.hostname === 'egress.example') return json({ ip: '8.8.8.8' });
    if (url.hostname === 'www.netflix.com') return new Response('x'.repeat(600));
    if (url.hostname === 'www.tiktok.com') return new Response('x'.repeat(600));
    if (url.hostname === 'www.youtube.com') return new Response('x'.repeat(600));
    throw new Error('unexpected route ' + url.hostname);
  }, { maxResponseBytes: 128 });
  const result = (await run(h, ['streaming']))[0];
  assert.equal(result.status, 'pass');
  assert.match(result.summary, /Netflix 可达（响应超出读取上限/);
  assert.match(result.summary, /TikTok 可达/);
});

test('mail probes TCP port 25 through the exit dial and reports blocked egress', async () => {
  const open = harness(() => json({ ip: '8.8.8.8' }), {}, async (host, port) => ({ ok: port === 25 && host === 'gmail-smtp-in.l.google.com', ms: 35 }));
  const results = await run(open, ['mail']);
  assert.equal(results[0].status, 'pass');
  assert.match(results[0].summary, /25 端口出站握手成功/);
  const blocked = harness(() => json({ ip: '8.8.8.8' }), {}, async () => ({ ok: false, ms: 0 }));
  assert.equal((await run(blocked, ['mail']))[0].status, 'risk');
});

test('packet-loss dials 1.1.1.1:443 once per run and scores the failure ratio', async () => {
  let attempts = 0;
  const h = harness(() => json({ ip: '8.8.8.8' }), {}, async () => ({ ok: ++attempts % 2 === 1, ms: 10 }));
  const results = await run(h, ['packet-loss'], { ...proxy, runs: 3 });
  assert.equal(results[0].status, 'risk');
  assert.equal(results[0].score, 67);
  assert.equal(attempts, 3);
});

test('proxy connection errors stay redacted and never fall back to a direct transport', async () => {
  let attempts = 0;
  const detector = createIpQualityDetector({ ...sourceOptions, createFetch: async target => { attempts++; assert.equal(target?.type, 'socks'); throw new Error('socks5://user:proxy-password@proxy.example:1080'); } });
  const result = await detector(proxy, ['geo', 'ai-access'], new AbortController().signal, () => {});
  assert.ok(result.every(x => x.status === 'risk'));
  assert.equal(attempts, 1);
  assert.equal(JSON.stringify(result).includes('proxy-password'), false);
});

test('DNS JSON probes request the DNS media type through the proxy transport', async () => {
  const h = harness((_url, init) => {
    assert.equal(new Headers(init?.headers).get('accept'), 'application/dns-json');
    return json({ Status: 0, Answer: [{ type: 1, data: '93.184.216.34' }] });
  });
  assert.equal((await run(h, ['dns']))[0].status, 'pass');
  assert.equal(h.factories[0]?.type, 'socks');
});

test('malformed header echo cannot certify absence of proxy markers', async () => {
  for (const headers of [{ Host: null }, { Host: [] }, { Host: ['ok', 15] }, { Host: { nested: true } }]) {
    const h = harness(() => json({ headers }));
    assert.equal((await run(h, ['header-leak']))[0].status, 'risk');
  }
});

test('cancelled tasks with a pending factory close its eventual transport without issuing a request', async () => {
  const controller = new AbortController();
  let resolveFactory!: (transport: { fetch: typeof fetch; close(): Promise<void> }) => void;
  let closed = 0; let sent = 0;
  let initializationSignal: AbortSignal | undefined;
  const detector = createIpQualityDetector({ ...sourceOptions, createFetch: (_target, signal) => { initializationSignal = signal; return new Promise(resolve => { resolveFactory = resolve; }); } });
  const pending = detector(proxy, ['ai-access'], controller.signal, () => {});
  controller.abort('proxy-password');
  const result = await pending;
  assert.equal(result[0].status, 'cancelled');
  assert.equal(initializationSignal?.aborted, true);
  resolveFactory({ fetch: (async () => { sent++; return new Response('ignored'); }) as typeof fetch, close: async () => { closed++; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent, 0);
  assert.equal(closed, 1);
});

test('proxy transport initialization receives and obeys the probe timeout signal', async () => {
  let initializationSignal: AbortSignal | undefined;
  const detector = createIpQualityDetector({ ...sourceOptions, timeoutMs: 10, createFetch: (_target, signal) => { initializationSignal = signal; return new Promise(() => {}); } });
  const result = await detector(proxy, ['ai-access'], new AbortController().signal, () => {});
  assert.equal(result[0].status, 'risk');
  assert.equal(initializationSignal?.aborted, true);
});
