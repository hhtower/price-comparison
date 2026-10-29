import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { crawl, probe } from '../src/platforms/acg-faka-v5.js';

const shop = { url: 'https://lemon-watermelon.com/' };
const html = inner => `<html><head><link href="/app/Plugin/HimenoSena/Assets/Base.css?v=5.0.36"><script>setVar("CCY","¥");</script></head><body>${inner}</body></html>`;
const categoryNames = { 0: '推荐', 65: 'Chatgpt', 66: 'Claude' };
const navigation = (current = 0) => '<div class="category-items">' + Object.entries(categoryNames).map(([cid, name]) =>
  `<a class="article-item${Number(cid) === current ? ' active' : ''}" href="${Number(cid) ? '/?cid=' + cid : '/'}"><span class="article-item-name">${name}</span></a>`).join('') + '</div>';
const listing = (ids, cid = 0) => html(navigation(cid) + `<div class="category-info-name">${categoryNames[cid]}</div><div class="article-items">` + ids.map(id => `<a class="shop-item" href="/item?id=${id}">商品</a>`).join('') + '</div>');
// Shape and identity copied from the public 5.0.36 item?id=97 response.
const sku = (changes = {}) => ({ id: 186, repertory_item_sku_id: 46, name: 'Plus 成品号 | Ready Account', price: '3', stock: '0', stock_available: false,
  picture_url: '/cover.png', quantity_restriction: { min: 1, max: 0, total: 0 }, wholesale: [], have_wholesale: false, ...changes });
const item = (id = 97, changes = {}) => ({ id, name: 'GPT Plus 成品号', category: { id: 65, name: 'Chatgpt' }, attr: [],
  source: { id, status: 1, category_id: 65, introduce: '<p>质保首登</p>' }, sku: [sku()], ...changes });
const detail = product => html(`<script>setVar("item", ${JSON.stringify(product)});</script>`);
function encrypted(text) {
  const key = '47eb58ad83515344', cipher = createCipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(key));
  const payload = Buffer.concat([cipher.update(text), cipher.final()]).toString('base64');
  return `<script>var _0x5a4b=['${key}','decrypt'];function n(){var _0x17e911={'VvdIy':'${payload}','tHJHG':0};}</script>`;
}
function api({ root = listing([97]), categories = { 65: listing([97], 65), 66: listing([135], 66) }, products = { 97: item(), 135: item(135, { category: { id: 66, name: 'Claude' }, source: { id: 135, status: 1, category_id: 66 }, sku: [sku({ id: 224, name: 'GPT Pro5x', price: '680', stock: '4', stock_available: true })] }) }, intercept } = {}) {
  return async (input, init = {}) => {
    assert.ok(!init.method || init.method === 'GET', 'Only GET is permitted');
    const url = new URL(input), changed = await intercept?.(url, init);
    if (changed) return changed;
    const body = url.pathname === '/item' ? detail(products[url.searchParams.get('id')]) : url.searchParams.has('cid') ? categories[url.searchParams.get('cid')] : root;
    assert.ok(body, `Unexpected request ${url.href}`);
    return new Response(body);
  };
}
const run = send => crawl(null, shop, send);

test('acg-faka-v5 normalizes selected labels and keeps quantity restrictions', async () => {
  const [product] = await probe(shop, api({ products: { 97: item(97, {
    sku: [sku({ name: ' Ｍｏｎｔｈｌｙ \n account ' })],
  }) } }));
  assert.equal(product.spec, 'Monthly account');
  assert.equal(product.externalId, '97:186');
  assert.deepEqual(product.sourceData.quantityRestriction, { min: 1, max: 0, total: 0 });
  for (const key of ['sku', 'selectedOptions', 'specification', 'spec']) assert.equal(key in product.sourceData, false);
});

test('acg-faka-v5 enumerates categories rather than treating home recommendations as the catalog', async () => {
  const products = await run(api());
  assert.deepEqual(products.map(p => [p.externalId, p.price, p.inStock]), [['97:186', '3', false], ['135:224', '680', true]]);
  assert.equal(products[0].url, 'https://lemon-watermelon.com/item?id=97');
  assert.equal(products[1].sourceCategory, 'Claude');
  assert.equal(products[0].spec, 'Plus 成品号 | Ready Account');
  assert.match(products[0].sourceData.evidence, /质保首登/);
  assert.ok(!JSON.stringify(products[0].sourceData).includes('repertory_item_sku_id'));
});

test('acg-faka-v5 reads the publicly embedded AES HTML and every SKU price and availability', async () => {
  const p = item(97, { sku: [sku(), sku({ id: 187, name: '月卡', price: '135', stock: '1', stock_available: true })] });
  const products = await run(api({ intercept: url => url.pathname === '/item' && url.searchParams.get('id') === '97' ? new Response(encrypted(detail(p))) : undefined }));
  assert.deepEqual(products.slice(0, 2).map(p => [p.externalId, p.price, p.inStock]), [['97:186', '3', false], ['97:187', '135', true]]);
});

test('acg-faka-v5 refuses incomplete category coverage, pagination, duplicates and drifting category identities', async () => {
  for (const options of [
    { root: listing([98]) },
    { categories: { 65: listing([97], 65) + '<a href="/?cid=65&page=2">下一页</a>', 66: listing([135], 66) } },
    { categories: { 65: listing([97, 97], 65), 66: listing([135], 66) } },
    { categories: { 65: listing([97], 65), 66: listing([97], 66) } },
    { categories: { 65: listing([97], 65).replace('cid=66', 'cid=67'), 66: listing([135], 66) } },
    { root: listing([97]).replace('/?cid=65', 'https://outside.test/?cid=65') },
  ]) await assert.rejects(run(api(options)));
});

test('acg-faka-v5 rejects invalid identity, price, stock, SKU and unsupported attribute shapes', async () => {
  for (const p of [item(98), item(97, { source: { id: 98, status: 1, category_id: 65 } }), item(97, { sku: [sku({ price: '-1' })] }),
    item(97, { sku: [sku({ stock: '0', stock_available: true })] }), item(97, { sku: [sku({ stock: '1.5' })] }),
    item(97, { sku: [sku(), sku()] }), item(97, { attr: { race: 'unverified' } }), item(97, { sku: [] }),
    item(97, { sku: [sku({ quantity_restriction: { min: 2, max: 1, total: 0 } })] }),
  ]) await assert.rejects(run(api({ products: { 97: p } })));
});

test('acg-faka-v5 honors purchase minimum and its public wholesale price without claiming ambiguous stock', async () => {
  const p = item(97, { sku: [sku({ stock: '4', stock_available: true, quantity_restriction: { min: 3, max: 0, total: 0 },
    wholesale: [{ quantity: 2, price: '2.50' }, { quantity: 10, price: '2' }], have_wholesale: true })] });
  assert.equal((await run(api({ products: { 97: p, 135: item(135, { category: { id: 66, name: 'Claude' }, source: { id: 135, status: 1, category_id: 66 } }) } })))[0].price, '2.50');
  await assert.rejects(run(api({ products: { 97: item(97, { sku: [sku({ stock: '充足', stock_available: true, quantity_restriction: { min: 3, max: 0, total: 0 } })] }) } })));
});

test('acg-faka-v5 propagates cancellation and partial failure without completing a snapshot', async () => {
  let completed = false;
  await assert.rejects(crawl(null, shop, api({ intercept: url => url.pathname === '/item' && url.searchParams.get('id') === '135' ? new Response('', { status: 503 }) : undefined }), { onListComplete: () => { completed = true; } }));
  assert.equal(completed, false);
  const controller = new AbortController();
  await assert.rejects(crawl(null, shop, api({ intercept: url => { if (url.searchParams.get('cid') === '66') controller.abort(); } }), { signal: controller.signal, onListComplete: () => { completed = true; } }));
  assert.equal(completed, false);
});

test('acg-faka-v5 rejects truncated documents and invalid AES without executing scripts', async () => {
  for (const root of [listing([97]).replace('</html>', ''), '<html><body>访问受限</body></html>', encrypted(listing([97])).replace("VvdIy':'", "VvdIy':'bad")]) await assert.rejects(run(api({ root })));
});

test('acg-faka-v5 never treats a navigation-only error response as an empty catalog', async () => {
  await assert.rejects(run(api({ root: listing([]), categories: { 65: html(navigation()), 66: listing([], 66) } })));
});

test('acg-faka-v5 refuses wrong-category empty pages and never completes their incomplete snapshot', async () => {
  for (const wrong of [listing([]), listing([], 65), listing([], 66).replace('class="category-info-name">Claude', 'class="category-info-name">推荐'),
    listing([], 66).replace('class="article-item" href="/"', 'class="article-item active" href="/"'),
    listing([], 66).replace('class="article-item active"', 'class="article-item"')]) {
    let complete = false;
    await assert.rejects(crawl(null, shop, api({ categories: { 65: listing([97], 65), 66: wrong } }), { onListComplete: () => { complete = true; } }), /category identity/);
    assert.equal(complete, false);
  }
  const rows = await run(api({ categories: { 65: listing([97], 65), 66: listing([], 66) } }));
  assert.deepEqual(rows.map(row => row.externalId), ['97:186']);
});

test('acg-faka-v5 validates root recommendation identity and the probe fallback category', async () => {
  await assert.rejects(run(api({ root: listing([97], 65) })), /category identity/);
  await assert.rejects(probe(shop, api({ root: listing([]), categories: { 65: listing([]), 66: listing([], 66) } })), /category identity/);
});

test('acg-faka-v5 refuses unsupported currency instead of treating USD amounts as CNY', async () => {
  await assert.rejects(run(api({ root: listing([97]).replace('"¥"', '"$"') })));
});

test('acg-faka-v5 probe returns a bounded preview, never marking the recommendation list complete', async () => {
  let calls = 0;
  const rows = await probe(shop, api({ intercept: () => { calls++; } }));
  assert.equal(rows.length, 1);
  assert.equal(calls, 2);
});
