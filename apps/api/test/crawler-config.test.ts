import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readCrawlerConfig } from '../src/config/env.js';

test('readCrawlerConfig returns defaults when env is empty', () => {
  const config = readCrawlerConfig({});
  assert.deepEqual(config.proxies, []);
  assert.equal(config.targetIntervalMs, 3_600_000);
  assert.equal(config.minIntervalMs, undefined);
  assert.equal(config.concurrency, 2);
  assert.equal(config.hostConcurrency, 2);
  assert.equal(config.hostMinIntervalMs.get('wzyp.cn'), 500);
  assert.equal(config.hostMinIntervalMs.get('www.16688.com.cn'), 1000);
  assert.equal(config.hostMinIntervalMs.get('catfk.com'), 10000);
  for (const host of ['ldxp.cn', 'www.ldxp.cn', 'pay.ldxp.cn', 'pay.qxvx.cn']) {
    assert.equal(config.hostMinIntervalMs.get(host), 1000);
  }
});

test('readCrawlerConfig validates independent host concurrency', () => {
  assert.equal(readCrawlerConfig({ CRAWLER_HOST_CONCURRENCY: '3' }).hostConcurrency, 3);
  assert.equal(readCrawlerConfig({ CRAWLER_HOST_CONCURRENCY: ' ' }).hostConcurrency, 2);
  for (const value of ['0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992']) {
    assert.throws(() => readCrawlerConfig({ CRAWLER_HOST_CONCURRENCY: value }), /CRAWLER_HOST_CONCURRENCY/);
  }
});

test('readCrawlerConfig preserves an explicit refresh interval upper bound', () => {
  assert.equal(readCrawlerConfig({ CRAWLER_TARGET_INTERVAL_MS: '1200000' }).targetIntervalMs, 1_200_000);
  assert.throws(() => readCrawlerConfig({ CRAWLER_TARGET_INTERVAL_MS: '0' }), /positive integer/);
});

test('retired settlement cadence does not block startup or change list scheduling', () => {
  assert.deepEqual(readCrawlerConfig({ CRAWLER_SETTLEMENT_INTERVAL_MS: '0' }), readCrawlerConfig({}));
});

test('readCrawlerConfig accepts explicit refresh bounds and an omitted or blank minimum', () => {
  const config = readCrawlerConfig({ CRAWLER_MIN_INTERVAL_MS: '600000', CRAWLER_TARGET_INTERVAL_MS: '2700000' });
  assert.equal(config.minIntervalMs, 600_000);
  assert.equal(config.targetIntervalMs, 2_700_000);
  assert.equal(readCrawlerConfig({ CRAWLER_MIN_INTERVAL_MS: ' ' }).minIntervalMs, undefined);
  assert.equal(readCrawlerConfig({ CRAWLER_MIN_INTERVAL_MS: '600000' }).targetIntervalMs, 3_600_000);
  assert.equal(readCrawlerConfig({ CRAWLER_MIN_INTERVAL_MS: '600000', CRAWLER_TARGET_INTERVAL_MS: '600000' }).minIntervalMs, 600_000);
});

test('readCrawlerConfig rejects invalid minimums and inverted refresh bounds', () => {
  for (const minimum of ['0', '-1', '999', '1000.5', 'NaN', 'Infinity', 'invalid', '9007199254740992', '2700001']) {
    assert.throws(() => readCrawlerConfig({
      CRAWLER_MIN_INTERVAL_MS: minimum, CRAWLER_TARGET_INTERVAL_MS: '2700000',
    }), /CRAWLER_MIN_INTERVAL_MS/);
  }
});

test('readCrawlerConfig parses mixed proxy protocols', () => {
  const config = readCrawlerConfig({ CRAWLER_PROXIES: 'http://u:p@1.2.3.4:8080, socks5://5.6.7.8:1080,https://proxy.example.com' });
  assert.deepEqual(config.proxies, ['http://u:p@1.2.3.4:8080', 'socks5://5.6.7.8:1080', 'https://proxy.example.com']);
});

test('readCrawlerConfig rejects invalid proxy entries', () => {
  assert.throws(() => readCrawlerConfig({ CRAWLER_PROXIES: 'not a url' }), /invalid URL/);
  assert.throws(() => readCrawlerConfig({ CRAWLER_PROXIES: 'ftp://1.2.3.4:21' }), /unsupported protocol/);
  assert.throws(() => readCrawlerConfig({ CRAWLER_SELFHOSTED_PROXY_URL: 'not a url' }), /CRAWLER_SELFHOSTED_PROXY_URL.*invalid URL/);
  assert.throws(() => readCrawlerConfig({ CRAWLER_SELFHOSTED_PROXY_URL: 'ftp://1.2.3.4:21' }), /CRAWLER_SELFHOSTED_PROXY_URL.*unsupported protocol/);
});

test('readCrawlerConfig parses the self-hosted proxy override', () => {
  assert.equal(readCrawlerConfig({}).selfHostedProxyUrl, undefined);
  assert.equal(readCrawlerConfig({ CRAWLER_SELFHOSTED_PROXY_URL: '  ' }).selfHostedProxyUrl, undefined);
  assert.equal(readCrawlerConfig({ CRAWLER_SELFHOSTED_PROXY_URL: 'http://172.17.0.1:12795' }).selfHostedProxyUrl, 'http://172.17.0.1:12795');
});

test('readCrawlerConfig overrides host intervals and rejects malformed entries', () => {
  const config = readCrawlerConfig({ CRAWLER_HOST_MIN_INTERVAL_MS: 'wzyp.cn:2000, example.com:100' });
  assert.equal(config.hostMinIntervalMs.get('wzyp.cn'), 2000);
  assert.equal(config.hostMinIntervalMs.get('example.com'), 100);
  assert.equal(config.hostMinIntervalMs.get('www.16688.com.cn'), 1000);
  assert.throws(() => readCrawlerConfig({ CRAWLER_HOST_MIN_INTERVAL_MS: 'wzyp.cn' }), /invalid entry/);
  assert.throws(() => readCrawlerConfig({ CRAWLER_HOST_MIN_INTERVAL_MS: 'wzyp.cn:abc' }), /invalid entry/);
  for (const value of ['0', '9007199254740992']) {
    assert.throws(() => readCrawlerConfig({ CRAWLER_HOST_MIN_INTERVAL_MS: `wzyp.cn:${value}` }), /CRAWLER_HOST_MIN_INTERVAL_MS/);
  }
});
