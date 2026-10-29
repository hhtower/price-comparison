import assert from 'node:assert/strict';
import test from 'node:test';
import { CrawlRunMetrics } from '../src/crawler/run-metrics.js';

test('run metrics count actual attempts and retain previous attempts across retry', () => {
  const first = new CrawlRunMetrics();
  first.observe({ type: 'request', host: 'example.test', stage: 'list', retry: false });
  first.observe({ type: 'request', host: 'example.test', stage: 'list', retry: true });
  first.observe({ type: 'failure', host: 'example.test', reason: 'connection' });
  first.observe({ type: 'duration', host: 'example.test', phase: 'network', ms: 125 });
  first.data.listFailed++;
  const second = new CrawlRunMetrics(first.data);
  second.observe({ type: 'request', host: 'example.test', stage: 'settlement', retry: false });
  assert.equal(second.data.attempts, 2);
  assert.equal(second.data.requests, 3);
  assert.equal(second.data.retries, 2);
  assert.equal(second.data.listFailed, 1);
  assert.equal(second.data.durations.network, 125);
  assert.deepEqual(second.data.hosts['example.test'], {
    requests: 3, retries: 2, list: 2, channel: 0, settlement: 1,
    connection: 1, rate_limited: 0, blocked: 0, timeout: 0, networkMs: 125,
  });
  assert.equal(first.data.requests, 2, 'retry collector must not mutate the prior report');
});
