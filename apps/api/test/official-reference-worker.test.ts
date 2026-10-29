import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readOfficialReferenceConfig } from '../src/official-reference/official-reference.config.js';
import { createOfficialReferenceHandler } from '../src/workers/official-reference.worker.js';
import type { ClaimedJob } from '../src/jobs/jobs.repository.js';
import { ReferenceUnavailableError } from '../src/official-reference/official-reference.collector.js';
import { ProxyAuthenticationError } from '../src/crawler/proxy-pool.js';

for (const fx of [false, true]) test(`reference ${fx ? 'FX' : 'region'} preserves terminal safe proxy authentication failure`, async () => {
  const error = new ProxyAuthenticationError();
  const handler = createOfficialReferenceHandler({ ...availableOnly, publish: async () => { assert.fail('must not publish'); } },
    () => async () => { throw error; },
    async (_id, _country, fetcher) => { await fetcher('https://apps.apple.com/'); return {} as never; });
  await assert.rejects(handler(job(fx), new AbortController().signal), caught => caught === error);
});

const availableOnly = { markUnavailable: async () => { throw new Error('unexpected unavailable app'); } };

const job = (fx = false) => ({ id: 1n, kind: 'fetch_run', attempts: 1n, claimed_by: 'test', lease_until: new Date(),
  row: fx ? { task_key: 'fx' } : { task_key: 'prices:6448311069:us', app_id: '6448311069', country: 'us' } }) as ClaimedJob;

test('reference config reuses AI proxy and allows a dedicated override without exposing credentials', () => {
  assert.equal(readOfficialReferenceConfig({ AI_PROXY_URL: 'http://localhost:7890' }).proxyUrl, 'http://localhost:7890');
  assert.equal(readOfficialReferenceConfig({ AI_PROXY_URL: 'http://a:80', OFFICIAL_REFERENCE_PROXY_URL: 'socks5://b:1080' }).proxyUrl, 'socks5://b:1080');
  assert.equal(readOfficialReferenceConfig({}).proxyUrl, '');
  assert.equal(readOfficialReferenceConfig({}).intervalMs, 7_200_000);
  assert.equal(readOfficialReferenceConfig({ OFFICIAL_REFERENCE_INTERVAL_MS: '3600000' }).intervalMs, 3_600_000);
  assert.throws(() => readOfficialReferenceConfig({ AI_PROXY_URL: 'ftp://secret:password@host' }), e => !String(e).includes('password'));
  assert.throws(() => readOfficialReferenceConfig({ OFFICIAL_REFERENCE_CONCURRENCY: '0' }));
});

test('worker atomically publishes only a complete validated FX response through injected transport', async () => {
  const published: unknown[] = [];
  const handler = createOfficialReferenceHandler({ ...availableOnly, publish: async (_job, value) => { published.push(value); } },
    signal => async (url, init) => { assert.equal(new URL(url).hostname, 'cdn.jsdelivr.net'); assert.ok(init?.signal); assert.ok(signal); return Response.json({ date: '2026-09-27', cny: { cny: 1, usd: 0.14 } }); });
  await handler(job(true), new AbortController().signal);
  assert.equal(published.length, 1);
  const bad = createOfficialReferenceHandler({ ...availableOnly, publish: async () => { throw new Error('must not publish'); } },
    () => async () => new Response('{"date":'));
  await assert.rejects(bad(job(true), new AbortController().signal), /upstream request failed/);
});

test('cancelled collection never publishes and transport errors never reveal proxy credentials', async () => {
  let writes = 0;
  const controller = new AbortController();
  const handler = createOfficialReferenceHandler({ ...availableOnly, publish: async () => { writes++; } }, () => async () => {
    controller.abort(new Error('cancelled')); return Response.json({});
  }, async (_id, _country, fetcher) => { await fetcher('https://apps.apple.com/'); return {} as never; });
  await assert.rejects(handler(job(), controller.signal)); assert.equal(writes, 0);
  const failed = createOfficialReferenceHandler({ ...availableOnly, publish: async () => { writes++; } }, () => async () => { throw new Error('http://user:password@proxy'); },
    async (_id, _country, fetcher) => { await fetcher('https://apps.apple.com/'); return {} as never; });
  await assert.rejects(failed(job(), new AbortController().signal), e => String(e).includes('upstream request failed') && !String(e).includes('password'));
});

test('confirmed official unavailability retires the old region but generic 404 failures cannot', async () => {
  let retired = 0;
  const store = { publish: async () => { throw new Error('must not publish'); }, markUnavailable: async () => { retired++; } };
  const unavailable = createOfficialReferenceHandler(store, () => async () => Response.json({}), async () => { throw new ReferenceUnavailableError('6448311069', 'us'); });
  await unavailable(job(), new AbortController().signal); assert.equal(retired, 1);
  const bad = createOfficialReferenceHandler(store, () => async () => Response.json({}), async () => { throw new Error('HTTP 404'); });
  await assert.rejects(bad(job(), new AbortController().signal)); assert.equal(retired, 1);
});
