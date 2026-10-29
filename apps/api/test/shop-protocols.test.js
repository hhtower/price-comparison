import test from 'node:test';
import assert from 'node:assert/strict';
import { platformForUrl, platforms } from '../src/platforms/index.js';

const shop = { url: 'https://suqiai.cc/' };
const product = (overrides = {}) => ({
  id: 5, slug: 'ChatGPT-Pro-5x', title: { 'zh-CN': 'ChatGPT Pro 5x 月卡' },
  description: { 'zh-CN': '官方充值，质保30天' }, content: { 'zh-CN': '<p>本人设备操作</p>' },
  price_amount: '650.00', images: ['/uploads/pro.png'],
  category: { name: { 'zh-CN': 'ChatGPT' } }, stock_status: 'in_stock', is_sold_out: false,
  skus: [{ id: 6, sku_code: 'pro5x', spec_values: { '周期': '月卡' }, price_amount: '650.00',
    stock_status: 'in_stock', is_sold_out: false, is_active: true, auto_stock_available: 0, stock_quantity_hidden: true }],
  ...overrides,
});
const response = body => Response.json(body);
const page = (items, current = 1, total = items.length, pages = 1) => response({ status_code: 0, data: items, pagination: { page: current, page_size: 12, total, total_page: pages } });
const crawl = fetchImpl => platformForUrl(shop.url).crawl(null, shop, fetchImpl);

test('registry recognizes SuqiAI and uses an explicitly saved protocol on another domain', () => {
  assert.equal(platformForUrl(shop.url).id, 'public-products-v1');
  assert.equal(platformForUrl('https://another-shop.example/', 'public-products-v1').id, 'public-products-v1');
  assert.throws(() => platformForUrl(shop.url, 'missing'), /protocol/i);
  assert.equal(platforms.filter(item => item.id === 'public-products-v1').length, 1);
  assert.throws(() => platformForUrl('https://user:password@suqiai.cc/'));
});

test('public products preserves SKU price, specification and stable evidence with hidden stock', async () => {
  const products = await crawl(async url => String(url).includes('?') ? page([product()]) : response({ status_code: 0, data: product() }));
  assert.equal(products.length, 1);
  assert.equal(products[0].externalId, '5:6');
  assert.equal(products[0].price, '650.00');
  assert.equal(products[0].spec, '周期: 月卡');
  assert.equal(products[0].inStock, true);
  assert.equal(products[0].sourceCategory, 'ChatGPT');
  assert.equal(products[0].imageUrl, 'https://suqiai.cc/uploads/pro.png');
  assert.ok(products[0].sourceData.evidence.includes('质保30天'));
  assert.ok(!JSON.stringify(products[0].sourceData).includes('650.00'));
});

test('public products reads all pages and details, retaining sold-out SKUs', async () => {
  const first = product();
  const second = product({ id: 8, slug: 'plus', title: { 'zh-CN': 'Plus' }, is_sold_out: true, skus: [
    { id: 9, spec_values: { '周期': '年卡' }, price_amount: '99.00', is_active: true, is_sold_out: true, stock_status: 'out_of_stock' },
    { id: 10, spec_values: {}, price_amount: '1.00', is_active: false },
  ] });
  const products = await crawl(async input => {
    const url = new URL(input);
    if (url.search) return page(url.searchParams.get('page') === '1' ? [first] : [second], Number(url.searchParams.get('page')), 2, 2);
    return response({ status_code: 0, data: url.pathname.endsWith('/plus') ? second : first });
  });
  assert.deepEqual(products.map(item => [item.externalId, item.price, item.inStock]), [['5:6', '650.00', true], ['8:9', '99.00', false]]);
});

test('public products rejects partial, duplicate and malformed snapshots', async () => {
  for (const payload of [
    { status_code: 1, data: [], pagination: { page: 1, total: 0, total_page: 0, page_size: 12 } },
    { status_code: 0, data: [] },
    { status_code: 0, data: [product(), product()], pagination: { page: 1, total: 2, total_page: 1, page_size: 12 } },
    { status_code: 0, data: [product()], pagination: { page: 1, total: 2, total_page: 1, page_size: 12 } },
  ]) await assert.rejects(crawl(async url => String(url).includes('?') ? response(payload) : response({ status_code: 0, data: product() })));
  for (const broken of [product({ skus: null }), product({ skus: [{ id: 6, is_active: true, spec_values: {}, price_amount: null }] }), product({ id: 99 }), product({ title: {} })]) {
    await assert.rejects(crawl(async url => String(url).includes('?') ? page([product()]) : response({ status_code: 0, data: broken })));
  }
  await assert.rejects(crawl(async url => String(url).includes('?') ? page([product()]) : new Response('', { status: 503 })));
});

test('public products accepts an explicitly complete empty snapshot', async () => {
  assert.deepEqual(await crawl(async () => page([], 1, 0, 0)), []);
});

test('invalid inventory never becomes a successful sold-out snapshot', async () => {
  for (const overrides of [{ stock_status: undefined }, { stock_status: 'unknown' }, { is_sold_out: 'false' }]) {
    const broken = product({ skus: [{ ...product().skus[0], ...overrides }] });
    await assert.rejects(crawl(async url => String(url).includes('?') ? page([product()]) : response({ status_code: 0, data: broken })), /stock/i);
  }
});

test('verified pending storefronts bind their actual protocol instead of the source platform label', () => {
  for (const host of ['cccrad.uk', 'ultra.makelove.cloud', 'shop.txyxt.dpdns.org', 'zhang520.store',
    'kapay.shop', 'burstpro-ai.online', 'morimm.com', 'shop.aictk.shop', 'faka.getmodel.net',
    'gpthub.ciyuanapi.ai', 'pay.gogo77.top', 'shop.huashengg.com', 'buy.aixou.top', 'sim.pst1.top',
    'kkfaka.xyz', 'lu-box.me', 'blog.esfine.chat', 'xxxyan.cc']) {
    assert.equal(platformForUrl(`https://${host}/`).id, 'public-products-v1');
  }
  for (const [host, protocol] of [['douyiner.cn', 'acg-faka'], ['chong.nerver.cc', 'orion-key'],
    ['ouvg.top', 'dujiaoka'], ['geminipro.vip', 'emshop'], ['catcard.uk', 'catcard'], ['lemon-watermelon.com', 'acg-faka-v5']]) {
    assert.equal(platformForUrl(`https://${host}/`).id, protocol);
  }
  assert.equal(platforms.find(item => item.id === 'emshop').responseFormat, 'html');
  for (const host of ['19cm.tech', 'bei-bei.shop', 'sulanjun.cc']) {
    assert.throws(() => platformForUrl(`https://${host}/`), /Unsupported shop host/);
  }
});

test('Dujiao-Next accepts public low and unlimited stock statuses with sold-out overrides', async () => {
  for (const stock_status of ['low_stock', 'unlimited']) {
    for (const is_sold_out of [false, true]) {
      const item = product({ stock_status, is_sold_out, skus: [{ ...product().skus[0], stock_status, spec_values: { 'zh-CN': '月卡', 'en-US': 'Month' } }] });
      const [result] = await crawl(async url => String(url).includes('?') ? page([item]) : response({ status_code: 0, data: item }));
      assert.equal(result.inStock, !is_sold_out);
      assert.equal(result.spec, '月卡');
      assert.equal(result.name, 'ChatGPT Pro 5x 月卡 · 月卡');
    }
  }
});

test('Dujiao-Next legacy SKUs use remaining inventory for their fulfillment type', async () => {
  for (const [fulfillment_type, field] of [['manual', 'manual_stock_total'], ['auto', 'auto_stock_available']]) {
    for (const quantity of [-1, 0, 2]) {
      const sku = { ...product().skus[0], stock_status: undefined, [field]: quantity, manual_stock_sold: 90 };
      const item = product({ fulfillment_type, stock_status: 'in_stock', skus: [sku] });
      const [result] = await crawl(async url => String(url).includes('?') ? page([item]) : response({ status_code: 0, data: item }));
      assert.equal(result.inStock, quantity !== 0);
    }
    for (const quantity of [undefined, null, -2, NaN, '2']) {
      const item = product({ fulfillment_type, skus: [{ ...product().skus[0], stock_status: undefined, [field]: quantity }] });
      await assert.rejects(crawl(async url => String(url).includes('?') ? page([item]) : response({ status_code: 0, data: item })), /stock/i);
    }
  }
});

test('Dujiao-Next refuses incomplete localized specifications', async () => {
  for (const spec_values of [{ 'zh-CN': null, 'en-US': '' }, { 'zh-CN': '', 'en-US': ' ' }, { 'zh-CN': 1 }, { 'zh-CN': '月卡', 'en-US': {} }]) {
    const item = product({ skus: [{ ...product().skus[0], spec_values }] });
    await assert.rejects(crawl(async url => String(url).includes('?') ? page([item]) : response({ status_code: 0, data: item })), /specification/i);
  }
});
