import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MetricsRegistry } from '../src/observability/metrics.js';

test('crawler counters accumulate by key and render to prometheus', () => {
  const registry = new MetricsRegistry();
  registry.incrementCrawlerCounter('proxy_request');
  registry.incrementCrawlerCounter('proxy_request');
  registry.incrementCrawlerCounter('response_blocked');
  assert.deepEqual(registry.snapshot().crawler, { proxy_request: 2, response_blocked: 1 });
  const prometheus = registry.toPrometheus();
  assert.ok(prometheus.includes('crawler_events_total{key="proxy_request"} 2'));
  assert.ok(prometheus.includes('crawler_events_total{key="response_blocked"} 1'));
});
