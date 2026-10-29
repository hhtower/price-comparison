import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isUnavailableShopError } from '../src/crawler/shop-failure.js';

test('only explicit shop business failures disable automatic crawling', () => {
  for (const message of ['店铺链接不存在', '商家已被关闭交易，有疑问请联系平台客服', '该商家已被封禁，有疑问请联系平台客服', '商家已注销，有疑问请联系平台客服']) {
    assert.equal(isUnavailableShopError(`liandong goods API: ${message}`), true, message);
  }
  for (const message of ['16688 goods API HTTP 404', 'liandong goods API HTTP 429', 'liandong goods API HTTP 500', 'fetch failed', 'liandong goods API: invalid response', 'liandong goods API: invalid product', 'liandong goods API: 系统维护中', 'liandong goods API: 店铺链接不存在有效签名', 'shop source changed during crawl']) {
    assert.equal(isUnavailableShopError(message), false, message);
  }
});
