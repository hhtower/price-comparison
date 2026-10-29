import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HostRateLimiter } from '../src/crawler/rate-limiter.js';

function harness(intervals: Record<string, number>) {
  let clock = 0;
  const requested: number[] = [];
  const sleep = async (ms: number) => { requested.push(ms); clock += ms; };
  const limiter = new HostRateLimiter(new Map(Object.entries(intervals)), () => clock, sleep);
  return { limiter, sleepDelays: requested, clock: () => clock };
}

test('first request starts immediately, second waits the configured interval', async () => {
  const { limiter, sleepDelays } = harness({ 'wzyp.cn': 1_000 });
  await limiter.acquire('wzyp.cn');
  assert.deepEqual(sleepDelays, []);
  await limiter.acquire('wzyp.cn');
  assert.deepEqual(sleepDelays, [1_000]);
});

test('different hosts do not block each other', async () => {
  const { limiter, sleepDelays } = harness({ 'wzyp.cn': 1_000, 'www.16688.com.cn': 500 });
  await limiter.acquire('wzyp.cn');
  await limiter.acquire('www.16688.com.cn');
  assert.deepEqual(sleepDelays, []);
});

test('unconfigured hosts get a conservative domain budget instead of unrestricted requests', async () => {
  const { limiter, sleepDelays } = harness({ 'wzyp.cn': 1_000 });
  await limiter.acquire('wzyp.cn');
  await limiter.acquire('other.example.com');
  await limiter.acquire('other.example.com');
  assert.deepEqual(sleepDelays, [1_000]);
});

test('queued same-host requests space by one interval each', async () => {
  const { limiter, sleepDelays } = harness({ 'wzyp.cn': 1_000 });
  const pending = [limiter.acquire('wzyp.cn'), limiter.acquire('wzyp.cn'), limiter.acquire('wzyp.cn')];
  await Promise.all(pending);
  assert.deepEqual(sleepDelays, [1_000, 1_000]);
});

test('a host pause delays only its host and cannot be shortened by an older pause', async () => {
  const { limiter, sleepDelays } = harness({ 'wzyp.cn': 100 });
  await limiter.pause('wzyp.cn', 500);
  await limiter.pause('wzyp.cn', 200);
  await limiter.acquire('other.example.com');
  await limiter.acquire('wzyp.cn');
  assert.deepEqual(sleepDelays, [500]);
});

test('a queued request exits promptly when cancelled behind a pending admission', async () => {
  let clock = 0;
  let release!: () => void;
  const first = new Promise<void>(resolve => { release = resolve; });
  const limiter = new HostRateLimiter(new Map([['wzyp.cn', 100]]), () => clock, async () => first);
  await limiter.acquire('wzyp.cn');
  const waiting = limiter.acquire('wzyp.cn');
  const controller = new AbortController();
  const cancelled = limiter.acquire('wzyp.cn', controller.signal);
  const reason = new Error('cancelled');
  controller.abort(reason);
  await assert.rejects(cancelled, error => error === reason);
  clock = 100;
  release();
  await waiting;
});
