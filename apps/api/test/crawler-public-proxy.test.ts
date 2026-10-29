import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCrawlerHandler } from '../src/workers/crawler.worker.js';

for (const [url, protocol] of [['https://custom.example/', 'public-products-v1'], ['https://ouvg.top/', 'dujiaoka'], ['https://chong.nerver.cc/', 'orion-key'], ['https://douyiner.cn/', 'acg-faka'], ['https://geminipro.vip/', 'emshop'], ['https://catcard.uk/', 'catcard'], ['https://lemon-watermelon.com/', 'acg-faka-v5']]) {
test(`custom protocol ${protocol} uses the configured proxy and public-address validation on ${url}`, async () => {
  const shop = { id: 1n, url, protocol, enabled: true, deleted_at: null };
  const selected = { selectAll: () => selected, where: () => selected, executeTakeFirst: async () => shop };
  const diagnostic = { set: () => diagnostic, where: () => diagnostic, execute: async () => [] };
  const database = {
    selectFrom: () => selected,
    updateTable: () => diagnostic,
    transaction: () => ({ execute: async () => {} }),
  } as never;
  const reason = new Error('stop before network');
  const handler = createCrawlerHandler(database, {} as never, {
    publicProxyUrl: 'http://domestic.example:24976',
    publicFetchFactory: async (_proxy, options) => {
      assert.equal(options?.serverProxyUrl, 'http://domestic.example:24976');
      assert.ok(options?.signal);
      assert.notEqual(options?.proxyDns, true);
      throw reason;
    },
  });
  await assert.rejects(handler({ kind: 'fetch_run', id: 1n, attempts: 1n, claimed_by: 'test',
    lease_until: new Date(Date.now() + 30000), row: { shop_id: 1n, claim_token: 'test' } }), error => error === reason);
});
}

// 自建站出口覆盖：配置 CRAWLER_SELFHOSTED_PROXY_URL 后公共客户端改走自建出口，缺省仍回退 publicProxyUrl。
test('custom protocol uses selfHostedProxyUrl when configured', async () => {
  const shop = { id: 1n, url: 'https://custom.example/', protocol: 'public-products-v1', enabled: true, deleted_at: null };
  const selected = { selectAll: () => selected, where: () => selected, executeTakeFirst: async () => shop };
  const diagnostic = { set: () => diagnostic, where: () => diagnostic, execute: async () => [] };
  const database = {
    selectFrom: () => selected,
    updateTable: () => diagnostic,
    transaction: () => ({ execute: async () => {} }),
  } as never;
  const reason = new Error('stop before network');
  const handler = createCrawlerHandler(database, {} as never, {
    publicProxyUrl: 'http://domestic.example:24976',
    selfHostedProxyUrl: 'http://172.17.0.1:12795',
    publicFetchFactory: async (_proxy, options) => {
      assert.equal(options?.serverProxyUrl, 'http://172.17.0.1:12795');
      assert.equal(options?.proxyDns, true);
      throw reason;
    },
  });
  await assert.rejects(handler({ kind: 'fetch_run', id: 1n, attempts: 1n, claimed_by: 'test',
    lease_until: new Date(Date.now() + 30000), row: { shop_id: 1n, claim_token: 'test' } }), error => error === reason);
});
