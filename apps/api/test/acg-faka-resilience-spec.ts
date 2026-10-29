import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import acgFaka from '../src/platforms/acg-faka.js';
import { isUnavailableShopError } from '../src/crawler/shop-failure.js';

interface Listing { id: number; name: string; status: number; category_id: number; category: { id: number; name: string } }
const listing = (id: number, extra: Partial<Listing> = {}): Listing =>
  ({ id, name: `P${id}`, status: 1, category_id: 1, category: { id: 1, name: '默认' }, ...extra });
const detail = (id: number, extra: Record<string, unknown> = {}) => ({ code: 200, data: {
  id, name: `P${id}`, status: 1, draft_status: 0, inventory_hidden: 0, minimum: 1, maximum: 0,
  config: {}, only_user: 0, purchase_count: 0, description: '', delivery_way: 1, cover: '', ...extra } });
const jsonResponse = (payload: unknown) => ({ ok: true, status: 200, json: async () => payload, headers: { get: () => 'application/json' } });
const makeFetch = (route: (url: URL, init: { body?: string }) => unknown) =>
  async (input: string | URL, init: { body?: string } = {}) => jsonResponse(route(new URL(String(input)), init));
const standardItemReads = (over: { stock?: unknown; quote?: unknown } = {}) => (url: URL): unknown => {
  if (url.pathname.endsWith('/commodityDetail')) return detail(Number(url.searchParams.get('commodityId')));
  if (url.pathname.endsWith('/stock')) return { code: 200, data: over.stock ?? { stock: '5', stock_state: 1 } };
  if (url.pathname.endsWith('/valuation')) return { code: 200, data: over.quote ?? { price: '9.90' } };
  if (url.pathname.endsWith('/pay')) return { code: 200, data: [] };
  throw new Error(`unexpected ${url.pathname}`);
};
const shop = { url: 'https://t.example/' };

describe('acg-faka 站点侧缺陷容忍(2026-10-25 六店实测)', () => {
  test('flat fallback rejects moving totals and duplicate identities from observed broken pagination', async () => {
    const ids = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => listing(from + i));
    const pages: Record<number, { code: number; data: Listing[]; total: number }> = {
      1: { code: 200, data: ids(1, 12), total: 45 },
      2: { code: 200, data: [listing(12), ...ids(13, 23)], total: 42 },
      3: { code: 200, data: [], total: 45 },
    };
    for (const second of [pages[2]!, { ...pages[2]!, data: ids(13, 24) }, { ...pages[2]!, total: 45 }]) {
      let completed = false;
      await assert.rejects(acgFaka.crawl(undefined, shop, makeFetch(url =>
        url.pathname.endsWith('/data') ? { code: 200, data: [] }
        : url.pathname.endsWith('/commodity') ? Number(url.searchParams.get('page')) === 2 ? second : pages[Number(url.searchParams.get('page'))]!
        : standardItemReads()(url)), { onListComplete: () => { completed = true; } }), /pagination changed|duplicate product ID/);
      assert.equal(completed, false);
    }
  });

  test('分类视图优先于平铺(accharbor 实测:平铺仅 107/179,分类全收)', async () => {
    let stats: { categories: number; categoryClaims: number; flatTotal: number | null; unique: number } | null = null;
    const products = await acgFaka.crawl(undefined, shop, makeFetch(url => {
      if (url.pathname.endsWith('/data')) return { code: 200, data: [{ id: 9, commodity_count: 2 }] };
      if (url.pathname.endsWith('/commodity')) {
        assert.equal(url.searchParams.get('categoryId'), '9');
        assert.equal(url.searchParams.get('page'), '1');
        assert.equal(url.searchParams.get('limit'), '12');
        return { code: 200, data: [listing(1), listing(2)] };
      }
      return standardItemReads()(url);
    }), { onListStats: value => { stats = value; } });
    assert.equal(products.length, 2);
    assert.equal(stats!.categories, 1);
    assert.equal(stats!.categoryClaims, 2);
    assert.equal(stats!.flatTotal, null);
  });

  test('category pagination uses the requested offset through the final short page', async () => {
    const items = Array.from({ length: 13 }, (_, index) => listing(index + 1));
    const pages: number[] = [];
    const products = await acgFaka.crawl(undefined, shop, makeFetch(url => {
      if (url.pathname.endsWith('/data')) return { code: 200, data: [{ id: 9, commodity_count: 13 }] };
      if (url.pathname.endsWith('/commodity')) {
        assert.equal(url.searchParams.get('categoryId'), '9');
        const current = Number(url.searchParams.get('page')), limit = Number(url.searchParams.get('limit'));
        pages.push(current);
        return { code: 200, data: items.slice((current - 1) * limit, current * limit) };
      }
      return standardItemReads()(url);
    }));
    assert.deepEqual(products.map(product => product.externalId), items.map(item => String(item.id)));
    assert.deepEqual(pages, [1, 2]);
  });

  test('a later category failure rejects the crawl without marking a partial list complete', async () => {
    let completed = false;
    await assert.rejects(acgFaka.crawl(undefined, shop, makeFetch(url => {
      if (url.pathname.endsWith('/data')) return { code: 200, data: [{ id: 1, commodity_count: 1 }, { id: 2, commodity_count: 1 }] };
      if (url.pathname.endsWith('/commodity')) {
        if (url.searchParams.get('categoryId') === '1') return { code: 200, data: [listing(1)] };
        throw new Error('category request failed');
      }
      return standardItemReads()(url);
    }), { onListComplete: () => { completed = true; } }), /category request failed/);
    assert.equal(completed, false);
  });

  test('库存空串按售罄处理(web3chirou id49 实测: stock="" state=0)', async () => {
    const products = await acgFaka.crawl(undefined, shop, makeFetch(url => {
      if (url.pathname.endsWith('/data')) return { code: 200, data: [] };
      if (url.pathname.endsWith('/commodity')) return { code: 200, data: [listing(1)], total: 1 };
      return standardItemReads({ stock: { stock: '', stock_state: 0 } })(url);
    }));
    assert.equal(products.length, 1);
    assert.equal(products[0].inStock, false);
    assert.equal(products[0].price, '9.90');
  });

  test('已删类型选项跳过该规格(fk.ybkjs.top 商品21「质保」实测: code 0 此商品类型不存在)', async () => {
    const products = await acgFaka.crawl(undefined, shop, makeFetch((url, init) => {
      if (url.pathname.endsWith('/data')) return { code: 200, data: [] };
      if (url.pathname.endsWith('/commodity')) return { code: 200, data: [listing(21)], total: 1 };
      if (url.pathname.endsWith('/commodityDetail')) return detail(21, { config: { category: { 普通: 0, 质保: 1 } } });
      if (url.pathname.endsWith('/valuation') && new URLSearchParams(init.body ?? '').get('race') === '质保')
        return { code: 0, msg: '此商品类型不存在[质保]' };
      return standardItemReads()(url);
    }));
    assert.equal(products.length, 1);
    assert.equal(products[0].spec, '类型: 普通');
  });
});

describe('isUnavailableShopError 覆盖 16688 死铺文案', () => {
  test('「店铺不存在或已关闭」应停用(老饕AI源头 459 次空转根因)', () => {
    assert.equal(isUnavailableShopError('16688 goods API: 店铺不存在或已关闭'), true);
    assert.equal(isUnavailableShopError('16688 goods API: 店铺不存在'), true);
    assert.equal(isUnavailableShopError('liandong goods API: 该商家已被封禁，有疑问请联系平台客服QQ：800000957'), true);
    assert.equal(isUnavailableShopError('liandong goods API: 店铺链接不存在'), true);
    assert.equal(isUnavailableShopError('acg-faka goods API: HTTP 502'), false);
    assert.equal(isUnavailableShopError('16688 goods API: 商品不存在'), false);
  });
});
