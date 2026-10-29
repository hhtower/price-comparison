import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchSourceText, parseExchangeRates } from '../src/official-reference/official-reference.sources.js';

test('exchange rates validate dated CNY-base quotes and discard invalid rates', () => {
  const rates = parseExchangeRates({ date: '2026-09-26', cny: { cny: 1, usd: 0.14, jpy: 20, eur: 0, bad: -1, nan: '0.1' } });
  assert.equal(rates.rates.usd, 0.14); assert.equal(rates.rates.eur, undefined); assert.equal(rates.rates.nan, undefined);
  assert.throws(() => parseExchangeRates({ date: 'bad', cny: {} }));
  assert.throws(() => parseExchangeRates({ date: '2026-09-26', cny: { cny: 2, usd: 0.14 } }));
});

test('source reads enforce byte limits and cancel stalled response streams', async () => {
  await assert.rejects(fetchSourceText('https://cdn.jsdelivr.net/fx', async () => new Response('x', { headers: { 'content-length': '99999999' } })));
  const controller = new AbortController();
  const pending = fetchSourceText('https://cdn.jsdelivr.net/fx', async () => new Response(new ReadableStream({ pull() {} })), controller.signal);
  setTimeout(() => controller.abort(new Error('cancelled')), 10);
  await assert.rejects(pending, /cancelled/);
});

test('Apple canonical redirects stay on the same origin, app and region', async () => {
  let calls = 0;
  const read = await fetchSourceText('https://apps.apple.com/us/app/id6448311069?l=en-GB', async url => {
    calls++;
    if (calls === 1) return new Response(null, { status: 301, headers: { location: 'https://apps.apple.com/us/app/chatgpt/id6448311069' } });
    assert.equal(String(url), 'https://apps.apple.com/us/app/chatgpt/id6448311069'); return new Response('official page');
  });
  assert.equal(read, 'official page'); assert.equal(calls, 2);
  for (const location of ['http://127.0.0.1/private', 'https://evil.example/app', 'https://apps.apple.com/jp/app/id6448311069', 'https://apps.apple.com/us/app/id12345']) {
    let attempts = 0;
    await assert.rejects(fetchSourceText('https://apps.apple.com/us/app/id6448311069', async () => {
      attempts++; return new Response(null, { status: 302, headers: { location } });
    }));
    assert.equal(attempts, 1);
  }
});
