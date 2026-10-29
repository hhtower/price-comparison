import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeShopUrl } from '../src/shops/shop-url.js';

test('public shop identities preserve tenant paths and meaningful queries, excluding unsafe URLs', () => {
  const normalize = normalizeShopUrl;
  assert.equal(normalize('http://WZYP.cn/shop/Ab.c/?ref=friend#top'), 'https://wzyp.cn/shop/ab.c');
  assert.equal(normalize('https://store.example/?tenant=two&utm_source=test'), 'https://store.example/?tenant=two');
  assert.equal(normalize('https://store.example/catalog/'), 'https://store.example/catalog');
  assert.equal(normalize('https://WZYP.cn./shop/A'), 'https://wzyp.cn/shop/a');
  assert.equal(normalize('https://www.16688.com.cn/shop/S123/?ref=source'), 'https://www.16688.com.cn/shop/S123');
  for (const url of ['https://wzyp.cn/', 'https://www.16688.com.cn/', 'https://catfk.com/item/one', 'http://127.0.0.1/',
    'https://[::1]/', 'https://localhost/', 'https://private.local/', 'https://private.local./', 'https://user:pass@store.example/',
    'https://store.example:8080/', 'javascript:alert(1)', 'https://wzyp.cn/shop/a%2Fb']) assert.equal(normalize(url), null, url);
});

test('wzyp shop tokens are case insensitive without folding unrelated paths or tenants', () => {
  const normalize = normalizeShopUrl;
  for (const url of ['https://wzyp.cn/shop/ZXC', 'https://wzyp.cn/shop/zxc', 'http://WZYP.CN/shop/%5AxC/?ref=share#top']) {
    assert.equal(normalize(url), 'https://wzyp.cn/shop/zxc');
  }
  assert.notEqual(normalize('https://wzyp.cn/shop/ZXC2'), normalize('https://wzyp.cn/shop/ZXC'));
  assert.notEqual(normalize('https://store.example/shop/ZXC'), normalize('https://store.example/shop/zxc'));
  assert.notEqual(normalize('https://store.example/?tenant=ZXC'), normalize('https://store.example/?tenant=zxc'));
});

test('verified storefront aliases share an identity without merging arbitrary www hosts', () => {
  const normalize = normalizeShopUrl;
  assert.equal(normalize('https://www.cccrad.uk/'), normalize('https://cccrad.uk/'));
  assert.equal(normalize('http://www.cccrad.uk/?utm_source=test'), 'https://cccrad.uk/');
  assert.notEqual(normalize('https://www.store.example/'), normalize('https://store.example/'));
  assert.notEqual(normalize('https://www.cccrad.uk/?tenant=one'), normalize('https://cccrad.uk/?tenant=two'));
});

test('legacy liandong shop addresses use wzyp without relying on redirects', () => {
  const normalize = normalizeShopUrl;
  assert.equal(normalize('https://pay.ldxp.cn/shop/BMCCA'), 'https://wzyp.cn/shop/bmcca');
  assert.equal(normalize('http://PAY.LDXP.CN/shop/%42MCCA/?ref=share#top'), 'https://wzyp.cn/shop/bmcca');
  assert.notEqual(normalize('https://pay.ldxp.cn/shop/other'), normalize('https://wzyp.cn/shop/BMCCA'));
  assert.equal(normalize('https://pay.ldxp.cn/'), null);
  assert.equal(normalize('https://pay.ldxp.cn/item/product'), null);
  assert.equal(normalize('https://pay.ldxp.cn.evil.example/shop/BMCCA'), 'https://pay.ldxp.cn.evil.example/shop/BMCCA');
});
