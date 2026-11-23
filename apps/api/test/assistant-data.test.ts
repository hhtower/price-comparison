import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyShoppingNeeds, type ShoppingNeeds } from '@price-comparison/catalog/assistant-contract';
import { CATALOG_PLATFORMS } from '@price-comparison/catalog/platform-groups';
import { MEMBERSHIP_GROUPS } from '@price-comparison/catalog/membership-policy';
import type { CatalogPage, PublicCatalogProduct } from '../src/catalog/catalog.repository.js';
import type { PriceHistory, PriceHistoryPoint } from '../src/catalog/price-history.repository.js';
import type { CatalogService } from '../src/catalog/catalog.service.js';
import { readAssistantData, type CatalogDataRequest } from '../src/assistant/assistant-data.js';

const now = new Date('2026-11-23T12:00:00.000Z');
const product: PublicCatalogProduct = { id: '42', name: 'ChatGPT Plus', platform: 'openai',
  platformGroup: 'openai', kind: '会员', identityNames: ['GPT Plus'], isAiMembership: true };
const page: CatalogPage = { items: [], platformFacets: ['openai'], total: 120, offerTotal: 9876 };
const history: PriceHistory = { currency: 'CNY', days: 30, startDate: '2026-10-25', endDate: '2026-11-23', points: [] };

function mockCatalog(overrides: Partial<Pick<CatalogService, 'getCatalog' | 'getProducts' | 'getCoverage' | 'getPriceHistory'>> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const methods = {
    getCatalog: async () => page,
    getProducts: async () => ({ items: [product] }),
    getCoverage: async () => ({ shopCount: 51, productCount: 100001 }),
    getPriceHistory: async () => history,
    ...overrides,
  };
  const catalog = Object.fromEntries(Object.entries(methods).map(([method, implementation]) => [method,
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Reflect.apply(implementation, methods, args);
    }])) as unknown as CatalogService;
  return { catalog, calls };
}

async function read(request: CatalogDataRequest, needs = emptyShoppingNeeds(), mock = mockCatalog()) {
  const facts = await readAssistantData(request, needs, mock.catalog, new AbortController().signal, now);
  assert.ok(facts.length > 0);
  assert.ok(facts.every(fact => !('id' in fact) && (!fact.path || /^(?:\/|\/products\/[1-9][0-9]*)$/u.test(fact.path))));
  for (const fact of facts) {
    assert.doesNotMatch(fact.text, /requiredTags|推荐池|数据库快照|目录接口|历史接口/u);
    assert.equal(typeof fact.summary, 'string');
    assert.ok(fact.summary!.length > 0 && fact.summary!.length <= 180, `summary too long: ${fact.title}`);
    if (fact.title === '数据不可用') assert.equal(fact.critical, true);
  }
  return { facts, text: facts.map(fact => fact.text).join('\n'), calls: mock.calls };
}

test('statistics uses whole-query standard and quote totals, never page or coverage counts', async () => {
  const { text, calls, facts } = await read({ tool: 'statistics', scope: 'catalog' });
  assert.match(text, /标准商品.*120\s*个/u);
  assert.match(text, /报价.*9876\s*条/u);
  assert.match(text, /采集覆盖.*51\s*家.*100001\s*(?:个|条)/u);
  assert.match(text, /全目录/u);
  assert.match(text, /CNY.*默认/u);
  assert.match(text, /2026-11-23T12:00:00.000Z/u);
  assert.match(text, /价格分布.*平均价.*不支持/u);
  assert.match(text, /按全部匹配记录统计，不仅是当前页面展示的条目/u);
  assert.match(text, /分组数据可能存在更新时差/u);
  assert.equal(facts.find(fact => fact.title === '目录总计')?.summary, '公开目录：标准商品 120 个，报价 9876 条（CNY）。');
  assert.ok(facts.every(fact => !fact.critical));
  for (const title of ['查询范围', '统计说明']) {
    assert.doesNotMatch(facts.find(fact => fact.title === title)!.summary!, /\d/u);
  }
  assert.deepEqual(calls.filter(call => call.method === 'getCatalog').map(call => call.args[0]),
    [{ currency: 'CNY', tags: [], limit: 1 }]);
});

test('current filters are inherited and overridden transiently, including monthly duration', async () => {
  const needs: ShoppingNeeds = { ...emptyShoppingNeeds(), platform: 'openai', product: 'GPT Plus',
    newcomer: false, membershipKinds: ['top_up'], preferences: ['lower_price'],
    budget: { amount: '100', currency: 'USD', basis: 'month' }, requiredTags: [{ name: 'region', value: 'us' }] };
  const before = structuredClone(needs);
  const request: CatalogDataRequest = { tool: 'statistics', scope: 'current', currency: 'USD',
    filters: { budget: { amount: '20', currency: 'USD', basis: 'month' } } };
  const requestBefore = structuredClone(request);
  const { calls, text } = await read(request, needs);
  assert.deepEqual(calls.find(call => call.method === 'getCatalog')?.args[0], {
    standardProductId: '42', platform: 'openai', currency: 'USD', priceMax: '20.00',
    tags: [{ name: 'duration', value: 30 }, { name: 'region', value: 'us' }], membershipKinds: ['top_up'], limit: 1,
  });
  assert.match(text, /当前条件/u);
  assert.match(text, /30\s*天/u);
  assert.match(text, /20.00\s*USD/u);
  assert.match(text, /不代表.*实际购买要求/u);
  assert.deepEqual(needs, before);
  assert.deepEqual(request, requestBefore);
});

test('catalog scope starts empty, disables newcomer and accepts currency without budget', async () => {
  const needs: ShoppingNeeds = { ...emptyShoppingNeeds(), purpose: '写代码', platform: 'openai', product: 'GPT Plus',
    budget: { amount: '80', currency: 'CNY', basis: 'month' }, requiredTags: [{ name: 'region', value: 'us' }],
    membershipKinds: ['top_up'], newcomer: true };
  const { calls, text } = await read({ tool: 'statistics', scope: 'catalog', currency: 'USD' }, needs);
  assert.deepEqual(calls.find(call => call.method === 'getCatalog')?.args[0],
    { currency: 'USD', tags: [], limit: 1 });
  assert.match(text, /USD/u);
  assert.doesNotMatch(text, /80|30天|写代码/u);
});

test('explicit currency conflicts are unavailable, unless the transient budget is cleared', async () => {
  const needs: ShoppingNeeds = { ...emptyShoppingNeeds(), product: 'GPT Plus',
    budget: { amount: '80', currency: 'CNY', basis: 'purchase' } };
  for (const tool of ['statistics', 'history'] as const) {
    const result = await read({ tool, scope: 'current', currency: 'USD' }, needs);
    assert.match(result.text, /币种.*冲突/u);
    assert.match(result.facts[0]!.summary!, /币种.*冲突.*新预算.*清除预算/u);
    assert.equal(result.calls.length, 0);
    const cleared = await read({ tool, scope: 'current', currency: 'USD', filters: { budget: null } }, needs);
    assert.ok(cleared.calls.length > 0);
    assert.match(cleared.text, /USD/u);
  }
});

test('purpose-only and conflicting monthly duration scopes do not become unfiltered totals', async () => {
  for (const needs of [
    { ...emptyShoppingNeeds(), purpose: '写代码' },
    { ...emptyShoppingNeeds(), budget: { amount: '80', currency: 'CNY', basis: 'month' as const },
      requiredTags: [{ name: 'duration', value: 365 }] },
  ]) {
    const result = await read({ tool: 'statistics', scope: 'current' }, needs);
    assert.match(result.text, /不支持|冲突/u);
    assert.equal(result.calls.length, 0);
  }
});

test('membership grouping includes unclassified, with an independent overlapping total', async () => {
  const mock = mockCatalog({ getCatalog: async query => query.membershipKinds
    ? { ...page, total: 70, offerTotal: 100 } : page });
  const { text, calls } = await read({ tool: 'statistics', scope: 'catalog', groupBy: 'membership' }, emptyShoppingNeeds(), mock);
  assert.match(text, /标准商品.*120\s*个/u);
  assert.doesNotMatch(text, /350/u);
  assert.match(text, /未分类/u);
  assert.match(text, /不可相加|不能相加/u);
  assert.match(text, /非会员/u);
  assert.deepEqual(calls.filter(call => call.method === 'getCatalog').slice(1).map(call => (call.args[0] as any).membershipKinds),
    MEMBERSHIP_GROUPS.map(kind => [kind]));
  assert.ok(calls.length <= 8);
});

test('membership grouping respects selected kinds over newcomer, and default newcomer otherwise', async () => {
  const selected = await read({ tool: 'statistics', scope: 'current', groupBy: 'membership' },
    { ...emptyShoppingNeeds(), newcomer: true, membershipKinds: ['rental', 'unclassified'] });
  assert.deepEqual(selected.calls.filter(call => call.method === 'getCatalog').slice(1)
    .map(call => (call.args[0] as any).membershipKinds), [['rental'], ['unclassified']]);
  const newcomer = await read({ tool: 'statistics', scope: 'current', groupBy: 'membership' });
  assert.deepEqual(newcomer.calls.filter(call => call.method === 'getCatalog').slice(1)
    .map(call => (call.args[0] as any).membershipKinds), [['account'], ['top_up']]);
});

test('platform grouping queries whole aggregates in at most eight reads including other', async () => {
  const { calls, text } = await read({ tool: 'statistics', scope: 'catalog', groupBy: 'platform' });
  assert.equal(calls.length, 8);
  assert.deepEqual(calls.slice(1).map(call => (call.args[0] as any).platform),
    [...CATALOG_PLATFORMS.map(platform => platform.id), 'other']);
  assert.match(text, /其他/u);
});

test('group fact text identifies each group without titles and shares query time only once', async () => {
  for (const [groupBy, labels] of [
    ['membership', ['成品号', '代充', '租号', '短期', '未分类']],
    ['platform', ['ChatGPT / Codex', 'Claude', 'Gemini / Google', 'Grok / X / Cursor', 'IP', '邮箱', '其他']],
  ] as const) {
    const { facts, text } = await read({ tool: 'statistics', scope: 'catalog', groupBy });
    const category = groupBy === 'membership' ? '会员分组' : '平台分组';
    for (const label of labels) {
      const group = facts.find(fact => fact.title === `${category}：${label}`);
      assert.ok(group, `missing group ${label}`);
      assert.ok(group.text.includes(`${category}：${label}`), `text must identify ${label}`);
      assert.ok(group.summary!.includes(label), `summary must identify ${label}`);
      assert.match(group.summary!, /标准商品 120 个.*报价 9876 条.*CNY/u);
      assert.doesNotMatch(group.text, /查询时间|截至|2026-11-23/u);
    }
    assert.equal(text.split(now.toISOString()).length - 1, 1);
    assert.match(text, /查询时间 2026-11-23T12:00:00.000Z/u);
    assert.doesNotMatch(text, /截至/u);
    assert.ok(text.length < 2500, `combined facts use ${text.length} characters`);
  }
});

test('current purpose-only scope stays unsupported for both tools and all statistics groupings', async () => {
  for (const request of [
    { tool: 'history', scope: 'current' },
    ...(['none', 'membership', 'platform'] as const).map(groupBy => ({ tool: 'statistics', scope: 'current', groupBy })),
  ] as CatalogDataRequest[]) {
    const { text, calls, facts } = await read(request, { ...emptyShoppingNeeds(), purpose: '写代码' });
    assert.match(text, /不支持仅凭用途/u);
    assert.match(facts[0]!.summary!, /不支持仅凭用途.*请先指定平台或商品/u);
    assert.match(text, /查询时间/u);
    assert.doesNotMatch(text, /截至/u);
    assert.equal(calls.length, 0);
  }
});

test('platform grouping cannot widen a selected source platform or a resolved product', async () => {
  const scoped = await read({ tool: 'statistics', scope: 'current', groupBy: 'platform' },
    { ...emptyShoppingNeeds(), platform: 'gmail', newcomer: false, membershipKinds: ['unclassified'] });
  assert.deepEqual(scoped.calls.map(call => call.args[0]), [
    { platform: 'gmail', currency: 'CNY', membershipKinds: ['unclassified'], tags: [], limit: 1 },
  ]);
  const resolved = await read({ tool: 'statistics', scope: 'catalog', groupBy: 'platform', filters: { product: 'GPT Plus' } });
  assert.equal(resolved.calls.length, 2);
  assert.equal((resolved.calls[1]?.args[0] as any).standardProductId, '42');
});

test('every group preserves budget, currency, tags, product and explicit membership filters', async () => {
  const result = await read({ tool: 'statistics', scope: 'current', groupBy: 'membership' }, {
    ...emptyShoppingNeeds(), product: 'GPT Plus', newcomer: false, membershipKinds: ['account', 'top_up'],
    budget: { amount: '99', currency: 'USD', basis: 'purchase' },
    requiredTags: [{ name: 'duration', value: 30 }, { name: 'region', value: 'us' }],
  });
  const queries = result.calls.filter(call => call.method === 'getCatalog').map(call => call.args[0]);
  assert.deepEqual(queries, [
    ['account', 'top_up'], ['account'], ['top_up'],
  ].map(membershipKinds => ({ standardProductId: '42', currency: 'USD', priceMax: '99.00', limit: 1,
    tags: [{ name: 'duration', value: 30 }, { name: 'region', value: 'us' }], membershipKinds })));
  assert.ok(result.calls.length <= 8);
});

test('missing quote aggregates are unavailable, never inferred from the preview', async () => {
  const result = await read({ tool: 'statistics', scope: 'catalog' }, emptyShoppingNeeds(),
    mockCatalog({ getCatalog: async () => ({ ...page, offerTotal: undefined }) }));
  assert.match(result.text, /报价.*(?:不可用|无法获取)/u);
  assert.doesNotMatch(result.text, /报价.*0\s*条/u);
  const total = result.facts.find(fact => fact.title === '目录总计')!;
  assert.match(total.summary!, /报价.*不可用/u);
  assert.equal(total.critical, true);
});

test('history resolves public identity aliases and preserves supported membership scope', async () => {
  const result = await read({ tool: 'history', scope: 'current', currency: 'USD' },
    { ...emptyShoppingNeeds(), platform: 'openai', product: 'GPT Plus', membershipKinds: ['rental'], newcomer: false },
    mockCatalog({ getPriceHistory: async () => ({ ...history, currency: 'USD' }) }));
  assert.deepEqual(result.calls.map(call => call.method), ['getProducts', 'getPriceHistory']);
  assert.deepEqual(result.calls[1]?.args, ['42', undefined, 'USD', { membershipKinds: ['rental'] }]);
  assert.match(result.text, /暂无.*历史/u);
  assert.match(result.text, /USD/u);
});

test('history prefers exact standard names and aliases over broader product names', async () => {
  for (const name of ['ChatGPT Plus', 'GPT Plus']) {
    const mock = mockCatalog({ getProducts: async () => ({ items: [
      { ...product, id: '43', name: 'ChatGPT Plus extra', identityNames: ['GPT Plus extra'] }, product,
    ] }) });
    const { calls, text } = await read({ tool: 'history', scope: 'current' },
      { ...emptyShoppingNeeds(), platform: 'openai', product: name }, mock);
    assert.deepEqual(calls.map(call => call.method), ['getProducts', 'getPriceHistory']);
    assert.equal(calls[1]?.args[0], '42');
    assert.match(text, /暂无.*历史/u);
    assert.match(text, /查询时间/u);
    assert.doesNotMatch(text, /截至/u);
  }
});

test('history reports ambiguous, missing and merged products without reading arbitrary history', async () => {
  for (const [items, expected] of [
    [[product, { ...product, id: '43', name: 'ChatGPT Plus Special' }], /多个|不唯一/u],
    [[{ ...product, name: 'ChatGPT Plus extra', identityNames: [] },
      { ...product, id: '43', name: 'ChatGPT Plus Special', identityNames: [] }], /多个|不唯一/u],
    [[], /未找到/u],
    [[{ ...product, mergedIntoId: '43' }], /未找到/u],
  ] as const) {
    const mock = mockCatalog({ getProducts: async () => ({ items }) });
    const result = await read({ tool: 'history', scope: 'catalog', filters: { product: 'ChatGPT Plus' } }, emptyShoppingNeeds(), mock);
    assert.match(result.text, expected);
    assert.match(result.facts[0]!.summary!, expected);
    if (items.length > 1) assert.match(result.facts[0]!.summary!, /请补充平台或套餐名/u);
    assert.equal(result.calls.length, 1);
  }
});

test('history requires an identity and refuses to discard budget, duration or required tags', async () => {
  for (const filters of [
    {},
    { product: 'GPT Plus', budget: { amount: '80', currency: 'CNY', basis: 'purchase' as const } },
    { product: 'GPT Plus', requiredTags: [{ name: 'duration', value: 30 }] },
    { product: 'GPT Plus', requiredTags: [{ name: 'region', value: 'us' }] },
  ]) {
    const result = await read({ tool: 'history', scope: 'catalog', filters });
    assert.match(result.text, /不支持|指定.*商品/u);
    if (filters.product) {
      assert.match(result.text, /历史暂不支持预算和商品标签筛选/u);
      assert.match(result.facts[0]!.summary!, /历史暂不支持预算和商品标签筛选.*保留这些条件/u);
    }
    assert.equal(result.calls.length, 0);
  }
});

function point(date: string, price: string, quantity = 1): PriceHistoryPoint {
  return { date, price, quantity, verifiedAt: `${date}T01:00:00.000Z`, productId: '7',
    shop: '商家', name: '商品', spec: '规格', contentVersion: '1', paymentMethod: '支付价' };
}

test('history summary uses actual dated observations, quantities and currency, never invented continuity', async () => {
  const data = { ...history, points: [point('2026-11-20', '75.50', 2), point('2026-11-02', '100.00')] };
  const before = structuredClone(data);
  const result = await read({ tool: 'history', scope: 'catalog', filters: { product: 'GPT Plus' } },
    emptyShoppingNeeds(), mockCatalog({ getPriceHistory: async () => data }));
  assert.match(result.text, /2026-10-25.*2026-11-23/u);
  assert.match(result.text, /上海|Asia\/Shanghai/u);
  assert.match(result.text, /2\s*天/u);
  assert.match(result.text, /2026-11-02.*100.00\s*CNY.*1\s*件/u);
  assert.match(result.text, /2026-11-20.*75.50\s*CNY.*2\s*件/u);
  assert.match(result.text, /每日最低.*结算/u);
  assert.match(result.text, /缺失|缺测/u);
  assert.match(result.text, /规格.*期限|期限.*规格/u);
  assert.ok(result.facts.some(fact => fact.path === '/products/42'));
  assert.ok(result.text.length < 1800);
  const summary = result.facts[0]!.summary!;
  assert.match(summary, /2026-10-25.*2026-11-23.*2\s*天/u);
  assert.match(summary, /最早.*100.00\s*CNY.*1\s*件/u);
  assert.match(summary, /最近.*75.50\s*CNY.*2\s*件/u);
  assert.ok(!result.facts[0]!.critical);
  assert.deepEqual(data, before);
});

test('summaries retain complete large counts and history amounts while omitting long product names', async () => {
  const counts = await read({ tool: 'statistics', scope: 'current', groupBy: 'platform' },
    { ...emptyShoppingNeeds(), platform: 'p'.repeat(120) },
    mockCatalog({ getCatalog: async () => ({ ...page, total: 9007199254740991, offerTotal: 9007199254740990 }) }));
  const group = counts.facts.find(fact => fact.title.startsWith('平台分组：'))!;
  assert.ok(group.summary!.includes('p'.repeat(120)));
  assert.match(group.summary!, /9007199254740991.*9007199254740990/u);

  const longName = '很长的标准商品名称'.repeat(30);
  const result = await read({ tool: 'history', scope: 'catalog', filters: { product: 'GPT Plus' } },
    emptyShoppingNeeds(), mockCatalog({
      getProducts: async () => ({ items: [{ ...product, name: longName }] }),
      getPriceHistory: async () => ({ ...history, points: [
        point('2026-11-02', '999999999999.99', 2147483647),
        point('2026-11-20', '888888888888.88', 2147483646),
      ] }),
    }));
  const summary = result.facts[0]!.summary!;
  assert.ok(result.text.includes(longName), 'full product identity remains in details');
  assert.doesNotMatch(summary, /很长的标准/u);
  assert.match(summary, /999999999999.99\s*CNY.*2147483647\s*件/u);
  assert.match(summary, /888888888888.88\s*CNY.*2147483646\s*件/u);
});

test('history distinguishes removed products from missing observations and rejects mismatched currency', async () => {
  for (const [response, expected] of [[null, /不可用/u], [history, /暂无.*历史/u],
    [{ ...history, currency: 'USD', points: [point('2026-11-20', '3')] }, /币种.*不一致/u]] as const) {
    const result = await read({ tool: 'history', scope: 'catalog', filters: { product: 'GPT Plus' } },
      emptyShoppingNeeds(), mockCatalog({ getPriceHistory: async () => response }));
    assert.match(result.text, expected);
    assert.match(result.facts[0]!.summary!, expected);
    assert.equal(result.facts[0]!.critical, true);
  }
});

test('arbitrary filters and invalid currency cannot bypass the query boundary', async () => {
  for (const request of [
    { tool: 'statistics', scope: 'catalog', currency: 'usd' },
    { tool: 'history', scope: 'catalog', filters: { product: 'GPT Plus', priceMax: '5' } },
    { tool: 'statistics', scope: 'catalog', filters: { standardProductId: '42', limit: 100 } },
  ]) {
    const result = await read(request as CatalogDataRequest);
    assert.match(result.text, /无效|不支持/u);
    assert.equal(result.calls.length, 0);
  }
});

test('unsafe product IDs never become fact paths or history queries', async () => {
  for (const id of ['../admin', 'https://example.com', '9223372036854775808']) {
    const result = await read({ tool: 'history', scope: 'catalog', filters: { product: 'GPT Plus' } },
      emptyShoppingNeeds(), mockCatalog({ getProducts: async () => ({ items: [{ ...product, id }] }) }));
    assert.match(result.text, /不可用/u);
    assert.equal(result.calls.length, 1);
    assert.doesNotMatch(result.text, /admin|example\.com/u);
  }
});

test('service failures become unavailable facts without leaking internal errors', async () => {
  const result = await read({ tool: 'statistics', scope: 'catalog' }, emptyShoppingNeeds(),
    mockCatalog({ getCatalog: async () => { throw new Error('postgres://private:secret SQL select'); } }));
  assert.match(result.text, /不可用/u);
  assert.doesNotMatch(result.text, /postgres|secret|SQL/u);
});

test('already cancelled and in-flight reads abort without starting later queries', async () => {
  const controller = new AbortController();
  const mock = mockCatalog();
  controller.abort();
  await assert.rejects(readAssistantData({ tool: 'statistics', scope: 'catalog' },
    emptyShoppingNeeds(), mock.catalog, controller.signal, now), { name: 'AbortError' });
  assert.equal(mock.calls.length, 0);

  const active = new AbortController();
  let finish!: (value: CatalogPage) => void;
  const waiting = mockCatalog({ getCatalog: () => new Promise(resolve => { finish = resolve; }) });
  const reading = readAssistantData({ tool: 'statistics', scope: 'catalog', groupBy: 'platform' },
    emptyShoppingNeeds(), waiting.catalog, active.signal, now);
  active.abort();
  await assert.rejects(reading, { name: 'AbortError' });
  finish(page);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(waiting.calls.length, 1);
});

test('cancellation after product resolution prevents history queries and preserves the abort reason', async () => {
  const controller = new AbortController();
  const reason = new Error('caller deadline');
  const mock = mockCatalog({ getProducts: async () => {
    controller.abort(reason);
    return { items: [product] };
  } });
  await assert.rejects(readAssistantData({ tool: 'history', scope: 'current' },
    { ...emptyShoppingNeeds(), product: 'GPT Plus' }, mock.catalog, controller.signal, now),
  error => error === reason);
  assert.deepEqual(mock.calls.map(call => call.method), ['getProducts']);
});
