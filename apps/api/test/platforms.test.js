import test from 'node:test';
import assert from 'node:assert/strict';
import { crawl as crawl16688 } from '../src/platforms/16688.js';
import { crawl as crawlLiandong, probe as probeLiandong } from '../src/platforms/liandong.js';

test('16688 crawl reads products from the goods API', async () => {
  let request;
  const fetchImpl = async (url, options) => {
    if (String(url).endsWith('/shopApi/goods/list')) request = { url, options };
    return new Response(JSON.stringify({
      code: 1,
      data: { list: [{
        goods_no: 'G1', name: '商品 A', price: 12.5, image: 'https://img/a.png',
        stock_available_quantity: 3
      }] }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const products = await crawl16688(null, { url: 'https://www.16688.com.cn/shop/S620172' }, fetchImpl);
  assert.equal(request.url, 'https://www.16688.com.cn/shopApi/goods/list');
  assert.deepEqual(JSON.parse(request.options.body), { shop_no: 'S620172', sort: 'default' });
  assert.deepEqual(products, [{
    externalId: 'G1', name: '商品 A', sourceName: '商品 A', description: '', spec: '', price: 12.5,
    url: 'https://www.16688.com.cn/goods/G1', imageUrl: 'https://img/a.png', inStock: true
  }]);
});

test('16688 crawl saves the source quoted total with the selected payment channel', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, body: JSON.parse(options?.body ?? '{}') });
    if (String(url).endsWith('/shopApi/goods/list')) return new Response(JSON.stringify({
      code: 1, data: { list: [{ goods_no: 'G1', name: '商品 A', price: 90, stock_available_quantity: 1 }] }
    }));
    if (String(url).endsWith('/shopApi/payment/list')) return new Response(JSON.stringify({
      code: 1, data: { list: [{ id: 11, show_name: '支付宝', paytype: { name: '支付宝' } }] }
    }));
    return new Response(JSON.stringify({ code: 1, data: {
      unit_price: '90.00', goods_amount: '90.00', promotion_discount: '0.00', coupon_discount: '0.00', fee: '8.00', total_amount: '98.00'
    } }));
  };
  const [product] = await crawl16688(null, { url: 'https://www.16688.com.cn/shop/S620172' }, fetchImpl);
  assert.equal(product.price, 90);
  assert.equal(product.settlement?.price, '98.00');
  assert.equal(product.settlement?.paymentMethod, '支付宝');
  assert.equal(requests[2].body.channel_id, 11);
  assert.equal(requests[2].body.goods_no, 'G1');
});

test('16688 keeps a product unverified when its quote is unavailable', async () => {
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/shopApi/goods/list')) return new Response(JSON.stringify({
      code: 1, data: { list: [{ goods_no: 'G1', name: '商品 A', price: 90, stock_available_quantity: 1 }] }
    }));
    if (String(url).endsWith('/shopApi/payment/list')) return new Response(JSON.stringify({ code: 1, data: { list: [] } }));
    throw new Error('quote must not be requested without a channel');
  };
  const [product] = await crawl16688(null, { url: 'https://www.16688.com.cn/shop/S620172' }, fetchImpl);
  assert.equal(product.price, 90);
  assert.equal(product.settlement, undefined);
});

for (const [name, crawl, listPath, channelPath, quotePath, item] of [
  ['16688', crawl16688, '/shopApi/goods/list', '/shopApi/payment/list', '/shopApi/payment/quotePrice', { goods_no: 'G1', name: '商品 A', price: 90, stock_available_quantity: 1, limit_quantity: 2 }],
  ['liandong', crawlLiandong, '/shopApi/Shop/goodsList', '/shopApi/Shop/getUserChannel', '/shopApi/Shop/getGoodsPrice', { goods_key: 'G1', link: 'https://wzyp.cn/item/G1', name: '商品 A', price: 90, stock_num: 1, extend: { limit_count: 2 } }],
]) {
  test(`${name} skips quote-only settlement when stock cannot meet the source minimum`, async () => {
    const requests = [];
    const products = await crawl(null, { url: `https://example.test/${name}/shop` }, async (url, options) => {
      requests.push(String(url));
      if (String(url).endsWith(listPath)) return Response.json(name === '16688' ? { code: 1, data: { list: [item] } } : { code: 1, data: { list: JSON.parse(options.body).current === 1 ? [item] : [] } });
      if (String(url).endsWith(channelPath)) return Response.json(name === '16688' ? { code: 1, data: { list: [{ id: 1, show_name: '支付宝' }] } } : { code: 1, data: [{ id: 1, status: 1, custom_status: 1, show_name: '支付宝' }] });
      throw new Error('quote must not be requested when stock cannot meet the minimum');
    });
    assert.equal(products[0].settlement, undefined);
    assert.equal(requests.some(url => url.endsWith(quotePath)), false);
  });

  test(`${name} keeps settlement unverified when minimum quantity metadata is invalid`, async () => {
    const invalid = name === '16688' ? { ...item, limit_quantity: 'unknown' } : { ...item, extend: { limit_count: null } };
    const products = await crawl(null, { url: `https://example.test/${name}/shop` }, async (url, options) => {
      if (String(url).endsWith(listPath)) return Response.json(name === '16688' ? { code: 1, data: { list: [invalid] } } : { code: 1, data: { list: JSON.parse(options.body).current === 1 ? [invalid] : [] } });
      if (String(url).endsWith(channelPath)) return Response.json(name === '16688' ? { code: 1, data: { list: [{ id: 1, show_name: '支付宝' }] } } : { code: 1, data: [{ id: 1, status: 1, custom_status: 1, show_name: '支付宝' }] });
      throw new Error('quote must not be requested for invalid quantity metadata');
    });
    assert.equal(products[0].settlement, undefined);
  });

  test(`${name} rejects an explicit quote quantity that differs from the requested quantity`, async () => {
    const products = await crawl(null, { url: `https://example.test/${name}/shop` }, async (url, options) => {
      if (String(url).endsWith(listPath)) return Response.json({ code: 1, data: { list: name === '16688' ? [{ ...item, limit_quantity: 1 }] : (JSON.parse(options.body).current === 1 ? [{ ...item, extend: { limit_count: 1 } }] : []) } });
      if (String(url).endsWith(channelPath)) return Response.json(name === '16688' ? { code: 1, data: { list: [{ id: 1, show_name: '支付宝' }] } } : { code: 1, data: [{ id: 1, status: 1, custom_status: 1, show_name: '支付宝' }] });
      return Response.json({ code: 1, data: { total_amount: '98.00', quantity: 2 } });
    });
    assert.equal(products[0].settlement, undefined);
    assert.equal(products[0].price, 90);
  });
}

test('liandong crawl skips zero-price informational items', async () => {
  const fetchImpl = async (_url, options) => new Response(JSON.stringify({ code: 1, data: { list: JSON.parse(options.body).current === 1 ? [
    { goods_key: 'paid', link: 'https://wzyp.cn/item/paid', name: '付费商品', price: 10, stock_num: 1 },
    { goods_key: 'guide', link: 'https://wzyp.cn/item/guide', name: '使用教程', price: 0 }
  ] : [] } }));
  const products = await crawlLiandong(null, { url: 'https://wzyp.cn/shop/2VWX76A4' }, fetchImpl);
  assert.deepEqual(products.map(product => product.externalId), ['paid']);
});

test('liandong legacy availability status is not a one-unit stock count for bulk quotes', async () => {
  const requests = [];
  const [product] = await crawlLiandong(null, { url: 'https://wzyp.cn/shop/legacy' }, async (url, options) => {
    const body = JSON.parse(options.body);
    if (String(url).endsWith('/goodsList')) return Response.json({ code: 1, data: { list: body.current === 1 ? [{
      goods_key: 'bulk', link: 'https://wzyp.cn/item/bulk', name: 'Bulk', price: 10, status: 1, extend: { limit_count: 5 },
    }] : [] } });
    if (String(url).endsWith('/getUserChannel')) return Response.json({ code: 1, data: [{
      id: 1, status: 1, custom_status: 1, show_name: 'Alipay',
    }] });
    requests.push(body.quantity);
    return Response.json({ code: 1, data: { total_amount: '51.50', quantity: 5 } });
  });
  assert.equal(product.inStock, true);
  assert.deepEqual(requests, [5]);
  assert.equal(product.settlement?.price, '10.30');
});

test('yunmao probe validates goods without depending on shop metadata endpoints', async () => {
  const requests = [];
  const products = await probeLiandong({ url: 'https://catfk.com/shop/I8WO6J9O' }, async (url, options) => {
    const path = new URL(url).pathname;
    requests.push([path, JSON.parse(options.body)]);
    if (path === '/shopApi/Shop/goodsList') return Response.json({ code: 1, data: { total: 1, list: [
      { goods_key: 'G1', name: 'Product A', price: 12, link: 'https://catfk.com/item/G1' },
    ] } });
    throw new Error(`unexpected path ${path}`);
  });
  assert.equal(products[0].externalId, 'G1');
  assert.equal(products[0].price, 12);
  assert.deepEqual(requests.map(([path]) => path), ['/shopApi/Shop/goodsList']);
  assert.equal(requests[0][1].token, 'I8WO6J9O');
});

test('liandong crawl saves the source quoted total with the selected payment channel', async () => {
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options?.body ?? '{}');
    if (String(url).endsWith('/shopApi/Shop/goodsList')) return new Response(JSON.stringify({
      code: 1, data: { list: body.current === 1 ? [{ goods_key: 'G1', link: 'https://wzyp.cn/item/G1', name: '商品 A', price: 90, stock_num: 1 }] : [] }
    }));
    if (String(url).endsWith('/shopApi/Shop/getUserChannel')) return new Response(JSON.stringify({
      code: 1, data: [{ id: '4', status: 1, custom_status: 1, show_name: '微信', paytype: { name: '微信' } }]
    }));
    return new Response(JSON.stringify({ code: 1, data: { total_amount: 98 } }));
  };
  const [product] = await crawlLiandong(null, { url: 'https://wzyp.cn/shop/2VWX76A4' }, fetchImpl);
  assert.equal(product.price, 90);
  assert.equal(product.settlement?.price, '98.00');
  assert.equal(product.settlement?.paymentMethod, '微信');
});

test('liandong rejects an invalid quote without inventing a settlement', async () => {
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options?.body ?? '{}');
    if (String(url).endsWith('/shopApi/Shop/goodsList')) return new Response(JSON.stringify({
      code: 1, data: { list: body.current === 1 ? [{ goods_key: 'G1', link: 'https://wzyp.cn/item/G1', name: '商品 A', price: 90, stock_num: 1 }] : [] }
    }));
    if (String(url).endsWith('/shopApi/Shop/getUserChannel')) return new Response(JSON.stringify({ code: 1, data: [{ id: 4, status: 1, custom_status: 1, show_name: '微信' }] }));
    return new Response(JSON.stringify({ code: 1, data: { total_amount: 'not-a-number' } }));
  };
  const [product] = await crawlLiandong(null, { url: 'https://wzyp.cn/shop/2VWX76A4' }, fetchImpl);
  assert.equal(product.price, 90);
  assert.equal(product.settlement, undefined);
});

test('quote cancellation aborts the crawl instead of producing a settlement', async () => {
  await assert.rejects(crawl16688(null, { url: 'https://www.16688.com.cn/shop/S620172' }, async url => {
    if (String(url).endsWith('/shopApi/goods/list')) return new Response(JSON.stringify({ code: 1, data: { list: [{ goods_no: 'G1', name: '商品 A', price: 90, stock_available_quantity: 1 }] } }));
    if (String(url).endsWith('/shopApi/payment/list')) return new Response(JSON.stringify({ code: 1, data: { list: [{ id: 11, show_name: '支付宝' }] } }));
    throw new DOMException('The operation was aborted', 'AbortError');
  }), /abort/i);
});

for (const [label, fields, expected] of [
  ['numeric zero', { stock_available_quantity: 0 }, false],
  ['string zero', { stock_available_quantity: '0' }, false],
  ['positive quantity', { stock_available_quantity: 3 }, true],
  ['string quantity', { stock_available_quantity: '3' }, true],
  ['undisclosed quantity', { stock_available_quantity: -1 }, true],
  ['string undisclosed quantity', { stock_available_quantity: '-1' }, true],
  ['explicit sold out', { stock_available_quantity: -1, stock_available_status: 'out' }, false],
  ['sold out without quantity', { stock_available_status: 'out' }, false],
  ['missing inventory', {}, false],
  ['null inventory', { stock_available_quantity: null }, false],
  ['blank inventory', { stock_available_quantity: ' ' }, false],
  ['invalid inventory', { stock_available_quantity: 'unknown' }, false],
  ['nonfinite inventory', { stock_available_quantity: 'Infinity' }, false],
  ['invalid negative inventory', { stock_available_quantity: -2 }, false],
  ['boolean inventory', { stock_available_quantity: true }, false],
]) {
  test(`16688 stock availability handles ${label}`, async () => {
    const [product] = await crawl16688(null, { url: 'https://www.16688.com.cn/shop/test' },
      async () => apiResponse([{ goods_no: 'stock', name: 'Stock test', price: 10, ...fields }]));
    assert.equal(product.inStock, expected);
  });
}

for (const [label, fields, expected] of [
  ['nested zero', { extend: { stock_count: 0, show_stock_type: 0 } }, false],
  ['hidden nested zero', { extend: { stock_count: 0, show_stock_type: 1 } }, false],
  ['nested string zero', { extend: { stock_count: '0' } }, false],
  ['nested positive quantity', { extend: { stock_count: 4 } }, true],
  ['nested string quantity', { extend: { stock_count: '4' } }, true],
  ['nested quantity takes precedence', { extend: { stock_count: 0 }, stock_num: 5, status: 1 }, false],
  ['legacy zero', { stock_num: 0 }, false],
  ['legacy string zero', { stock_num: '0' }, false],
  ['legacy positive quantity', { stock_num: '4' }, true],
  ['legacy sold out status', { status: 0 }, false],
  ['legacy string sold out status', { status: '0' }, false],
  ['legacy available status', { status: 1 }, true],
  ['legacy string available status', { status: '1' }, true],
  ['missing inventory', {}, false],
  ['null inventory', { extend: { stock_count: null } }, false],
  ['blank inventory', { extend: { stock_count: ' ' } }, false],
  ['invalid inventory', { extend: { stock_count: 'unknown' }, status: 1 }, false],
  ['nonfinite inventory', { extend: { stock_count: 'Infinity' } }, false],
  ['negative inventory', { extend: { stock_count: -1 } }, false],
  ['boolean inventory', { extend: { stock_count: true } }, false],
]) {
  test(`liandong stock availability handles ${label}`, async () => {
    const [product] = await crawlLiandong(null, { url: 'https://wzyp.cn/shop/test' },
      async (_url, options) => apiResponse(JSON.parse(options.body).current === 1
        ? [{ goods_key: 'stock', link: 'https://wzyp.cn/item/stock', name: 'Stock test', price: 10, ...fields }] : []));
    assert.equal(product.inStock, expected);
  });
}

test('both adapters preserve specifications and explicit identity evidence returned by the API',async()=>{
  const item={goods_no:'1',goods_key:'1',link:'https://example.test/p',name:'Account',price:10,spec:'12 months',sourceCategory:'Subscription',vendor:'OpenAI',family:'ChatGPT',tier:'Plus',model:'GPT-5',description:'Shared account',stock_num:1,selectedOptions:[{name:'term',value:'1 month'},{name:'access',value:'shared'}],sku:{region:'US'}};
  for(const crawl of [crawl16688,crawlLiandong]){
    const [product]=await crawl(null,{url:'https://example.test/shop'},async(_url,options)=>new Response(JSON.stringify({code:1,data:{list:JSON.parse(options.body).current > 1 ? [] : [item]}})));
    assert.equal(product.spec,'12 months');
    assert.equal(product.sourceCategory,'Subscription');
    assert.deepEqual(product.sourceData,{vendor:'OpenAI',family:'ChatGPT',tier:'Plus',model:'GPT-5',evidence:'Shared account'});
  }
});

test('both adapters capture raw full listing text only when the body is present', async () => {
  const { captureRatingText } = await import('../src/platforms/source-evidence.js');
  for (const crawl of [crawl16688, crawlLiandong]) {
    for (const description of ['  Raw\n\n<p>full body</p>  ', '', undefined]) {
      const item = { goods_no: 'raw', goods_key: 'raw', link: 'https://example.test/raw',
        name: ' ＧＰＴ · source title ', description, price: 10, stock_num: 1, stock_available_quantity: 1 };
      const [product] = await crawl(null, { url: 'https://example.test/shop' }, async (_url, options) =>
        Response.json({ code: 1, data: { list: JSON.parse(options.body).current > 1 ? [] : [item] } }));
      assert.deepEqual(product.ratingText, captureRatingText('raw', item.name, description));
    }
  }
});

test('both adapters convert selected structured specifications into the canonical string', async () => {
  const structuredSpec = [{ name: '套餐', options: ['1个月合租', '1 year exclusive'], selected: '1个月合租' }];
  const item = { goods_no: 'structured', goods_key: 'structured', link: 'https://example.test/structured', name: 'Plus', price: 10, spec: structuredSpec, stock_num: 1 };
  for (const crawl of [crawl16688, crawlLiandong]) {
    const [product] = await crawl(null, { url: 'https://example.test/shop' }, async (_url, options) => new Response(JSON.stringify({ code: 1, data: { list: JSON.parse(options.body).current > 1 ? [] : [item] } })));
    assert.equal(product.spec, '套餐: 1个月合租');
    assert.equal('specification' in (product.sourceData ?? {}), false);
  }
});

for (const [name, crawl] of [['16688', crawl16688], ['liandong', crawlLiandong]]) {
  test(`${name} accepts a successful empty shop snapshot`, async () => {
    assert.deepEqual(await crawl(null, { url: 'https://example.test/shop' }, async () => apiResponse([])), []);
  });

  test(`${name} rejects invalid response shapes and malformed products`, async () => {
    for (const payload of [null, {}, { code: 0, data: { list: [] } }, { code: 1, data: { list: {} } },
      { code: 1, data: { list: [null] } }, { code: 1, data: { list: [{}] } },
      ...[{ name: '' }, { price: 'not-a-price' }, { price: null }, { price: -1 }].map(overrides => ({ code: 1, data: { list: [{ ...apiProduct('invalid'), ...overrides }] } })),
    ]) {
      await assert.rejects(crawl(null, { url: 'https://example.test/shop' }, async () => new Response(JSON.stringify(payload))));
    }
  });

  test(`${name} rejects duplicate product IDs within a snapshot`, async () => {
    await assert.rejects(crawl(null, { url: 'https://example.test/shop' }, async () => apiResponse([apiProduct('same'), apiProduct('same')])), /duplicate/i);
  });
}

test('liandong reads subsequent pages before returning the complete snapshot', async () => {
  const requests = [];
  const firstPage = Array.from({ length: 100 }, (_, index) => apiProduct(`first-${index}`));
  const secondPage = [apiProduct('last')];
  const products = await crawlLiandong(null, { url: 'https://wzyp.cn/shop/token' }, async (url, options) => {
    if (!String(url).endsWith('/shopApi/Shop/goodsList')) return new Response(JSON.stringify({ code: 0 }));
    const request = JSON.parse(options.body);
    requests.push(request);
    return apiResponse(request.current === 1 ? firstPage : request.current === 2 ? secondPage : []);
  });
  assert.deepEqual(products.map(product => product.externalId), [...firstPage, ...secondPage].map(item => item.goods_key));
  assert.deepEqual(requests.map(request => [request.current, request.pageSize]), [[1, 100], [2, 100], [3, 100]]);
  assert.ok(requests.every(request => request.token === 'token' && request.goods_type === 'card' && request.category_id === 0 && request.keywords === ''));
});

test('liandong follows short pages and filters informational items only after validating the page', async () => {
  const pages = [[{ ...apiProduct('guide'), price: 0 }], [apiProduct('paid')], []];
  let calls = 0;
  const products = await crawlLiandong(null, { url: 'https://wzyp.cn/shop/token' }, async url => {
    if (!String(url).endsWith('/shopApi/Shop/goodsList')) return new Response(JSON.stringify({ code: 0 }));
    return apiResponse(pages[calls++]);
  });
  assert.deepEqual(products.map(product => product.externalId), ['paid']);
  assert.equal(calls, 3);
  let emptyCalls = 0;
  assert.deepEqual(await crawlLiandong(null, { url: 'https://wzyp.cn/shop/token' }, async url => String(url).endsWith('/shopApi/Shop/goodsList')
    ? apiResponse(emptyCalls++ === 0 ? [{ ...apiProduct('guide'), price: 0 }] : [])
    : new Response(JSON.stringify({ code: 0 }))), []);
});

test('liandong completes at the reported total, counting free items and following short pages', async () => {
  const pages = [[{ ...apiProduct('guide'), price: 0 }], [apiProduct('paid')], [apiProduct('last')]];
  const requests = [];
  let completed = 0;
  const products = await crawlLiandong(null, { url: 'https://wzyp.cn/shop/token' }, async (url, options) => {
    assert.ok(String(url).endsWith('/goodsList'), 'no settlement requested for unselected products');
    const { current } = JSON.parse(options.body);
    requests.push(current);
    assert.ok(current <= pages.length, 'do not request an extra empty page');
    return Response.json({ code: 1, data: { total: '3', list: pages[current - 1] } });
  }, { settlementProductIds: new Set(), onListComplete: () => completed++ });
  assert.deepEqual(products.map(product => product.externalId), ['paid', 'last']);
  assert.deepEqual(requests, [1, 2, 3]);
  assert.equal(completed, 1);
});

test('liandong accepts total zero as a complete empty snapshot', async () => {
  let calls = 0;
  assert.deepEqual(await crawlLiandong(null, { url: 'https://wzyp.cn/shop/token' }, async () => {
    calls++;
    return Response.json({ code: 1, data: { total: 0, list: [] } });
  }), []);
  assert.equal(calls, 1);
});

test('liandong refuses incomplete or changing totals before marking the list complete or quoting', async () => {
  for (const pages of [
    [{ total: 2, list: [] }],
    [{ total: 3, list: [apiProduct('first')] }, { total: 3, list: [] }],
    [{ total: 3, list: [apiProduct('first')] }, { total: 2, list: [apiProduct('second')] }],
    [{ total: 3, list: [apiProduct('first')] }, { list: [] }],
    [{ list: [apiProduct('first')] }, { total: 1, list: [] }],
    [{ total: 1, list: [apiProduct('first'), apiProduct('second')] }],
    [{ total: 3, list: [apiProduct('first'), apiProduct('second')] }, { total: 3, list: [apiProduct('third'), apiProduct('fourth')] }],
  ]) {
    let calls = 0, completed = false;
    await assert.rejects(crawlLiandong(null, { url: 'https://wzyp.cn/shop/token' }, async url => {
      assert.ok(String(url).endsWith('/goodsList'), 'invalid snapshots must not request quotes');
      assert.ok(calls < pages.length, 'fail at the inconsistent page');
      return Response.json({ code: 1, data: pages[calls++] });
    }, { onListComplete: () => { completed = true; } }), /liandong goods API:.*(?:total|snapshot)/);
    assert.equal(completed, false);
  }
});

test('liandong rejects malformed totals during crawling and approval preview', async () => {
  for (const total of [null, '', ' ', '1.5', -1, 0.5, true, {}, [], Number.MAX_SAFE_INTEGER + 1]) {
    const fetchImpl = async () => Response.json({ code: 1, data: { total, list: [] } });
    const shop = { url: 'https://wzyp.cn/shop/token' };
    await assert.rejects(crawlLiandong(null, shop, fetchImpl), /invalid.*total/);
    await assert.rejects(probeLiandong(shop, fetchImpl), /invalid.*total/);
  }
});

test('liandong keeps source categories from the goods API in crawling and approval preview', async () => {
  const items = [
    { ...apiProduct('category'), category: { id: 1, name: ' ChatGPT Plus ' } },
    { ...apiProduct('explicit'), sourceCategory: 'Original', category: { name: 'Fallback' } },
    { ...apiProduct('blank'), sourceCategory: ' ', category: { name: 'Codex' } },
    { ...apiProduct('invalid'), category: { name: { internal: 'invalid' } } },
  ];
  const fetchImpl = async (url, options) => String(url).endsWith('/goodsList')
    ? Response.json({ code: 1, data: { total: items.length, list: JSON.parse(options.body).current === 1 ? items : [] } })
    : Response.json({ code: 0 });
  const shop = { url: 'https://wzyp.cn/shop/token' };
  const products = await crawlLiandong(null, shop, fetchImpl);
  assert.deepEqual(products.map(product => product.sourceCategory), ['ChatGPT Plus', 'Original', 'Codex', undefined]);
  assert.deepEqual((await probeLiandong(shop, fetchImpl)).map(product => product.sourceCategory), ['ChatGPT Plus', 'Original', 'Codex']);
  assert.equal(products[0].sourceData.category.name, 'ChatGPT Plus');
});

test('liandong fails the whole snapshot when a later page fails or is malformed', async () => {
  for (const nextResponse of [
    () => new Response('', { status: 503 }),
    () => new Response('{broken'),
    () => new Response(JSON.stringify({ code: 0, msg: 'failed' })),
    () => new Response(JSON.stringify({ code: 1, data: { list: {} } })),
    () => { throw new Error('network failure'); },
  ]) {
    let calls = 0;
    await assert.rejects(crawlLiandong(null, { url: 'https://wzyp.cn/shop/token' }, async () => ++calls === 1 ? apiResponse([apiProduct('first')]) : nextResponse()));
    assert.equal(calls, 2);
  }
});

test('liandong rejects overlapping or repeated pages instead of returning partial results', async () => {
  for (const secondPage of [[apiProduct('first')], [apiProduct('second'), apiProduct('first')]]) {
    let calls = 0;
    await assert.rejects(crawlLiandong(null, { url: 'https://wzyp.cn/shop/token' }, async () => apiResponse(++calls === 1 ? [apiProduct('first')] : secondPage)), /duplicate|repeat/i);
    assert.equal(calls, 2);
  }
});

test('liandong bounds a feed that never returns an empty page', async () => {
  let calls = 0;
  await assert.rejects(crawlLiandong(null, { url: 'https://wzyp.cn/shop/token' }, async () => {
    assert.ok(++calls <= 1000);
    return apiResponse([apiProduct(`page-${calls}`)]);
  }), /pagination.*limit/i);
  assert.equal(calls, 1000);
});

function apiResponse(list) {
  return new Response(JSON.stringify({ code: 1, data: { list } }));
}

function apiProduct(id) {
  return { goods_no: id, goods_key: id, link: `https://wzyp.cn/item/${id}`, name: `Product ${id}`, price: 10, stock_num: 1 };
}

for (const [name, crawl, channelPath, quotePath] of [
  ['16688', crawl16688, '/shopApi/payment/list', '/shopApi/payment/quotePrice'],
  ['liandong', crawlLiandong, '/shopApi/Shop/getUserChannel', '/shopApi/Shop/getGoodsPrice'],
]) {
  const run = async (channels, code = 1) => {
    const quotedIds = [];
    const products = await crawl(null, { url: 'https://example.test/shop/token' }, async (url, options) => {
      if (String(url).endsWith(channelPath)) return Response.json({ code, data: name === '16688' ? { list: channels } : channels });
      if (String(url).endsWith(quotePath)) {
        quotedIds.push(JSON.parse(options.body).channel_id);
        return Response.json({ code: 1, data: { total_amount: '98.00' } });
      }
      return apiResponse(JSON.parse(options.body).current > 1 ? [] : [{ ...apiProduct('G1'), stock_available_quantity: 1 }]);
    });
    return { product: products[0], quotedIds };
  };
  test(`${name} skips disabled channels and quotes the first available channel`, async () => {
    const { product, quotedIds } = await run([
      { id: 1, status: 0, custom_status: 1, show_name: 'Disabled' },
      { id: 2, status: 1, custom_status: 0, show_name: 'Disabled' },
      { id: '4', status: 1, custom_status: 1, show_name: 'WeChat' },
    ]);
    assert.deepEqual(quotedIds, ['4']);
    assert.equal(product.settlement?.price, '98.00');
  });
  test(`${name} never quotes malformed channel IDs or unsuccessful channel responses`, async () => {
    for (const id of ['', ' ', 0, '0', -1, 'NaN', 'Infinity', null, true]) {
      const { product, quotedIds } = await run([{ id, status: 1, custom_status: 1, show_name: 'WeChat' }]);
      assert.deepEqual(quotedIds, [], String(id));
      assert.equal(product.settlement, undefined);
    }
    const { product, quotedIds } = await run([{ id: 4, status: 1, custom_status: 1, show_name: 'WeChat' }], 0);
    assert.deepEqual(quotedIds, []);
    assert.equal(product.settlement, undefined);
    if (name === 'liandong') {
      const missingStatus = await run([{ id: 4, show_name: 'WeChat' }]);
      assert.deepEqual(missingStatus.quotedIds, []);
      assert.equal(missingStatus.product.settlement, undefined);
    }
  });
}
