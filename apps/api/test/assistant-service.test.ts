import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyShoppingNeeds, type AssistantReply, type ShoppingNeeds } from '@price-comparison/catalog/assistant-contract';
import { AssistantService } from '../src/assistant/assistant.service.js';
import type { AssistantRepository } from '../src/assistant/assistant.repository.js';
import type { CatalogService } from '../src/catalog/catalog.service.js';
import type { StreamingCall, StreamingResult } from '../src/ai/llm-runtime.js';
import type { ClaimedJob } from '../src/jobs/jobs.repository.js';
import type { CatalogOffer } from '../src/catalog/catalog.repository.js';

const quoteNow = new Date('2026-10-31T12:00:00.000Z');

function harness(outputs: unknown[], text = '我主要用来学习', needs = emptyShoppingNeeds(), catalogOverrides: Partial<CatalogService> = {},
  history: Array<{ text: string; reply: AssistantReply }> = []) {
  let saved: AssistantReply | null = null;
  let calls = 0;
  let reserved = 0;
  const repository = {
    readTurnContext: async () => ({
      snapshot: { id: '1', inputText: text, expectedRevision: 0 },
      deadlineAt: new Date(Date.now() + 90_000), needs, history,
    }),
    setPhase: async () => {},
    reserveModelRequest: async () => { reserved += 1; },
    finishModelRequest: async () => {},
    completeTurn: async (value: { reply: AssistantReply }) => { saved = value.reply; },
  } as unknown as AssistantRepository;
  const call: StreamingCall = async ({ signal, maxOutputTokens, messages }) => {
    signal.throwIfAborted();
    assert.equal(maxOutputTokens, 2048);
    calls += 1;
    const output = outputs.shift();
    return {
      content: JSON.stringify(typeof output === 'function' ? output(JSON.parse(String(messages.at(-1)?.content))) : output), finishReason: 'stop', usage: null,
      toolCalls: [], responseMs: 1, firstContentMs: 1, responseModel: 'mock', responseModels: ['mock'],
      responseId: 'r1', chunkCount: 1, contentChunks: 1,
    };
  };
  const catalog = { getProducts: async () => ({ items: [] }), ...catalogOverrides } as unknown as CatalogService;
  const job: ClaimedJob = { kind: 'assistant_turn', id: 1n, attempts: 1n, claimed_by: 'test', lease_until: new Date(Date.now() + 30_000), row: { claim_token: 'claim' } };
  return {
    run: (signal = new AbortController().signal) => new AssistantService(repository, catalog, call, 'mock', () => quoteNow).runTurn(job, signal),
    get saved() { return saved; }, get calls() { return calls; }, get reserved() { return reserved; },
  };
}

test('one complete understanding request can end in one question without querying arbitrary products', async () => {
  const state = harness([{
    intent: 'clarify', patch: {}, evidence: [], question: '主要想解决什么问题？', options: ['学习', '工作'],
  }]);
  await state.run();
  assert.equal(state.calls, 1);
  assert.equal(state.reserved, 1);
  assert.equal(state.saved?.kind, 'question');
  assert.equal(state.saved?.cards.length, 0);
});

function shoppingFixture() {
  const product = { id: '42', name: 'Claude Pro', platform: 'anthropic', platformGroup: 'anthropic', kind: '订阅' };
  const offer: CatalogOffer = {
    shopId: '3', productId: '9', name: 'Pro 一个月', shop: '测试商铺', price: '30.00', currency: 'CNY',
    settlementQuantity: 1, priceStatus: 'verified', capturedAt: quoteNow.toISOString(),
    priceExpiresAt: new Date(quoteNow.getTime() + 60_000).toISOString(), inventoryExpiresAt: new Date(quoteNow.getTime() + 60_000).toISOString(),
    productUrl: 'https://shop.invalid/product/9', spec: '', stale: false, inStock: true,
    tags: [{ name: 'access', value: 'dedicated' }, { name: 'duration', value: '1 month' }],
  };
  const needs: ShoppingNeeds = { ...emptyShoppingNeeds(), purpose: '写代码' };
  const catalog: Partial<CatalogService> = {
    resolvePublicProductIdentity: async () => product,
    getProduct: async () => product,
    getCatalog: async () => ({
      total: 1, platformFacets: [], items: [{
        ...product, standardProductId: product.id, shopCount: 1, productCount: 1, minPrice: offer.price, offers: [offer],
        detail: { kind: 'offers', page: 0, pageSize: 20, total: 1, entries: [offer] },
      }],
    }),
  };
  return { offer, needs, catalog };
}

test('recommendation uses two calls and assembles the standard-product link and actual price on server', async () => {
  const fixture = shoppingFixture();
  const state = harness([
    { intent: 'recommend', patch: {}, evidence: [], question: null, options: [] },
    (input: { candidates: Array<{ productId: string; evidence: Array<{ id: string }> }> }) => ({
      selections: [{ productId: input.candidates[0]!.productId, evidenceIds: [input.candidates[0]!.evidence[0]!.id] }],
    }),
  ], '请推荐', fixture.needs, fixture.catalog);
  await state.run();
  assert.equal(state.calls, 2);
  assert.equal(state.saved?.cards[0]?.price, '30.00');
  assert.equal(state.saved?.cards[0]?.detailPath, '/products/42');
  assert.ok(state.saved?.cards[0]?.reasons.length);
  assert.match(state.saved?.cards[0]?.reasons.join(' ') ?? '', /Claude Code/u);
  assert.match(state.saved?.cards[0]?.caveats.join(' ') ?? '', /实际使用入口/u);
});

test('comparison keeps the previous recommendation even after an intervening clarification', async () => {
  const fixture = shoppingFixture();
  const explanation = (input: { candidates: Array<{ productId: string; evidence: Array<{ id: string }> }> }) => ({
    selections: [{ productId: input.candidates[0]!.productId, evidenceIds: [input.candidates[0]!.evidence[0]!.id] }],
  });
  const initial = harness([
    { intent: 'recommend', patch: {}, evidence: [], question: null, options: [] }, explanation,
  ], '请推荐', fixture.needs, fixture.catalog);
  await initial.run();
  const lookedUp: string[] = [];
  const comparing = harness([
    { intent: 'compare', patch: {}, evidence: [], question: null, options: [] }, explanation,
  ], '比较刚才的商品', fixture.needs, {
    ...fixture.catalog,
    getProduct: async id => { lookedUp.push(id); return { id, name: 'Claude Pro', platform: 'anthropic', kind: '订阅' }; },
  }, [
    { text: '请推荐', reply: initial.saved! },
    { text: '怎么买', reply: { kind: 'question', text: '有已有账号吗？', options: [], cards: [], needs: fixture.needs } },
  ]);
  await comparing.run();
  assert.deepEqual([...new Set(lookedUp)], ['42']);
  assert.equal(comparing.saved?.kind, 'comparison');
});

test('comparison without previous candidates does not substitute newly chosen products', async () => {
  const fixture = shoppingFixture();
  const state = harness([{ intent: 'compare', patch: {}, evidence: [], question: null, options: [] }],
    '比较刚才两个', fixture.needs, { getCatalog: async () => { throw new Error('must not search new candidates'); } });
  await state.run();
  assert.match(state.saved?.text ?? '', /没有可比较/u);
  assert.equal(state.saved?.cards.length, 0);
  assert.equal(state.calls, 1);
});

test('page platform constrains recommendations even when understanding omits it', async () => {
  const fixture = shoppingFixture();
  const state = harness([{ intent: 'recommend', patch: { purpose: '写代码' },
    evidence: [{ field: 'purpose', quote: '写代码' }], question: null, options: [] }],
  '当前页面筛选：ChatGPT / Codex\n写代码', emptyShoppingNeeds(), fixture.catalog);
  await state.run();
  assert.equal(state.saved?.needs.platform, 'openai');
  assert.equal(state.saved?.cards.length, 0, 'must not substitute Claude for the page platform');
});

test('follow-up product selection preserves budget and purpose while browsing the requested product', async () => {
  const fixture = shoppingFixture();
  const needs = { ...fixture.needs, budget: { amount: '80', currency: 'CNY', basis: 'purchase' as const } };
  const product = { id: '42', name: 'ChatGPT Plus', platform: 'openai', kind: '订阅' };
  const state = harness([
    (input: { needs: ShoppingNeeds; history: unknown[] }) => {
      assert.equal(input.needs.purpose, '写代码');
      assert.equal(input.history.length, 1);
      return { intent: 'recommend', patch: { platform: 'openai', product: 'ChatGPT Plus' },
        evidence: [{ field: 'platform', quote: 'gpt plus' }, { field: 'product', quote: 'gpt plus' }], question: null, options: [] };
    },
    (input: { candidates: Array<{ productId: string; evidence: Array<{ id: string }> }> }) => ({
      selections: [{ productId: input.candidates[0]!.productId, evidenceIds: [input.candidates[0]!.evidence[0]!.id] }],
    }),
  ], '我想购买gpt plus，你觉得哪些适合我呢？', needs, {
    ...fixture.catalog, resolvePublicProductIdentity: async () => null, getProduct: async () => product,
    getProducts: async () => ({ items: [product] }),
    getCatalog: async query => {
      assert.equal(query.platform, 'openai');
      return fixture.catalog.getCatalog!(query);
    },
  }, [{ text: '写代码', reply: { kind: 'question', text: '想买哪个产品？', options: [], cards: [], needs } }]);
  await state.run();
  assert.equal(state.saved?.cards[0]?.title, 'ChatGPT Plus');
  assert.deepEqual(state.saved?.needs.budget, needs.budget);
  assert.equal(state.saved?.needs.purpose, '写代码');
  assert.equal(state.saved?.text, '找到以下报价。');
  assert.match(state.saved?.cards[0]?.caveats.join(' ') ?? '', /报价/u);
  assert.equal(state.saved?.cards[0]?.offer?.shop, '测试商铺');
});

test('a correction to Plus finds the standard product beyond unrelated search hits and preserves other needs', async () => {
  const fixture = shoppingFixture();
  const go = { id: '1', name: 'ChatGPT Go', platform: 'openai', kind: '订阅' };
  const plus = { ...go, id: '42', name: 'ChatGPT Plus' };
  const needs = { ...fixture.needs, platform: 'openai', product: 'ChatGPT Go',
    budget: { amount: '80', currency: 'CNY', basis: 'purchase' as const } };
  const state = harness([
    { intent: 'recommend', patch: { product: 'ChatGPT Plus' },
      evidence: [{ field: 'product', quote: '我要的是plus' }], question: null, options: [] },
    (input: { candidates: Array<{ productId: string; evidence: Array<{ id: string }> }> }) => ({
      selections: [{ productId: input.candidates[0]!.productId, evidenceIds: [input.candidates[0]!.evidence[0]!.id] }],
    }),
  ], '我要的是plus', needs, {
    ...fixture.catalog,
    getProducts: async () => ({ items: [go, ...Array.from({ length: 5 }, (_, i) => ({ ...go, id: String(i + 2) })), plus] }),
    getProduct: async id => id === '42' ? plus : { ...go, id },
    getCatalog: async query => ({ total: 1, platformFacets: [], items: [{
      ...(query.standardProductId === '42' ? plus : go), standardProductId: query.standardProductId ?? '1',
      shopCount: 1, productCount: 1, minPrice: '30.00',
      offers: [{ ...fixture.offer, shop: 'PLUSAI', name: 'Go会员官方直冲' }],
    }] }),
  });
  await state.run();
  assert.equal(state.saved?.kind, 'recommendation');
  assert.deepEqual(state.saved?.cards.map(card => card.title), ['ChatGPT Plus']);
  assert.deepEqual(state.saved?.needs, { ...needs, product: 'ChatGPT Plus' });
});

for (const resumed of [false, true]) test(`Plus top-up separates delivery from the product name (${resumed ? 'existing needs' : 'observed model output'})`, async () => {
  const fixture = shoppingFixture();
  const product = { id: '42', name: 'ChatGPT Plus', platform: 'openai', kind: '订阅' };
  const topup = { ...fixture.offer, productId: '10', tags: [...fixture.offer.tags, { name: 'delivery', value: 'top_up' }] };
  const account = { ...fixture.offer, price: '1.00', tags: [...fixture.offer.tags, { name: 'delivery', value: 'account' }] };
  const initial = { ...emptyShoppingNeeds(), ...(resumed ? { platform: 'openai', product: 'ChatGPT Plus 代充',
    budget: { amount: '80', currency: 'CNY', basis: 'purchase' as const } } : {}) };
  const state = harness([
    { intent: 'recommend', patch: resumed ? {} : { platform: 'openai', product: 'ChatGPT Plus 代充' },
      evidence: resumed ? [] : [{ field: 'platform', quote: 'gpt' }, { field: 'product', quote: 'plus代充' }], question: null, options: [] },
    (input: { candidates: Array<{ productId: string; evidence: Array<{ id: string }> }> }) => ({
      selections: [{ productId: input.candidates[0]!.productId, evidenceIds: [input.candidates[0]!.evidence[0]!.id] }],
    }),
  ], resumed ? '继续帮我找' : '我现在有一个gpt账号了，想要找一个plus代充', initial, {
    getProducts: async () => ({ items: [product, { ...product, id: '43', name: 'ChatGPT Go' }] }),
    getProduct: async () => product,
    getCatalog: async query => {
      assert.equal(query.standardProductId, '42');
      assert.deepEqual(query.tags, [{ name: 'delivery', value: 'top_up' }]);
      return { total: 1, platformFacets: [], items: [{ ...product, standardProductId: '42', shopCount: 1,
        productCount: 2, minPrice: '1.00', offers: [account, topup] }] };
    },
  });
  await state.run();
  assert.equal(state.saved?.kind, 'recommendation');
  assert.deepEqual(state.saved?.cards.map(card => card.productId), ['10']);
  assert.deepEqual(state.saved?.needs, { ...initial, platform: 'openai', product: 'chatgpt plus',
    requiredTags: [{ name: 'delivery', value: 'top_up' }] });
});

for (const clearsTags of [false, true]) test(`follow-ups retain delivery from previous product names (clears tags: ${clearsTags})`, async () => {
  const needs = { ...emptyShoppingNeeds(), platform: 'openai', product: 'ChatGPT Plus 代充' };
  const state = harness([
    { intent: 'recommend', patch: { product: 'ChatGPT Plus', ...(clearsTags ? { requiredTags: [] } : {}) },
      evidence: [{ field: 'product', quote: 'Plus' }, ...(clearsTags ? [{ field: 'requiredTags', quote: '再找一个' }] : [])],
      question: null, options: [] },
  ], 'Plus，再找一个', needs);
  await state.run();
  assert.equal(state.saved?.kind, clearsTags ? 'question' : 'no_match');
  assert.deepEqual(state.saved?.needs.requiredTags, [{ name: 'delivery', value: 'top_up' }]);
});

test('delivery embedded in product names cannot override an existing conflicting requirement', async () => {
  const needs = { ...emptyShoppingNeeds(), platform: 'openai', product: 'ChatGPT Plus 代充',
    requiredTags: [{ name: 'delivery', value: 'account' }] };
  const state = harness([{ intent: 'recommend', patch: {}, evidence: [], question: null, options: [] }], '继续找', needs, {
    getProducts: async () => { throw new Error('conflicting requirements must be clarified'); },
  });
  await state.run();
  assert.equal(state.saved?.kind, 'question');
  assert.deepEqual(state.saved?.needs, needs);
  assert.equal(state.calls, 1);
});

test('unavailable Plus never falls back to a Go quote from PLUSAI', async () => {
  const fixture = shoppingFixture();
  const go = { id: '42', name: 'ChatGPT Go', platform: 'openai', kind: '订阅' };
  const state = harness([{ intent: 'recommend', patch: {}, evidence: [], question: null, options: [] },
    (input: { candidates: Array<{ productId: string; evidence: Array<{ id: string }> }> }) => ({
      selections: [{ productId: input.candidates[0]!.productId, evidenceIds: [input.candidates[0]!.evidence[0]!.id] }],
    })],
    '继续推荐', { ...emptyShoppingNeeds(), platform: 'openai', product: 'ChatGPT Plus' }, {
      ...fixture.catalog, getProducts: async () => ({ items: [go] }), getProduct: async () => go,
    });
  await state.run();
  assert.equal(state.saved?.kind, 'no_match');
  assert.equal(state.saved?.cards.length, 0);
  assert.equal(state.saved?.needs.product, 'ChatGPT Plus');
  assert.equal(state.saved?.text, '暂时没找到符合要求的报价。');
  assert.equal(state.calls, 1);
});

test('platform-only browsing reloads authoritative catalog groups instead of guessing from the vendor name', async () => {
  const fixture = shoppingFixture();
  let metadataReads = 0;
  const needs = { ...emptyShoppingNeeds(), platform: 'email' };
  const state = harness([
    { intent: 'recommend', patch: {}, evidence: [], question: null, options: [] },
    (input: { candidates: Array<{ productId: string; evidence: Array<{ id: string }> }> }) => ({
      selections: [{ productId: input.candidates[0]!.productId, evidenceIds: [input.candidates[0]!.evidence[0]!.id] }],
    }),
  ], '找邮箱', needs, {
    ...fixture.catalog, getProduct: async id => {
      metadataReads++;
      return { id, name: '邮箱', platform: 'google', platformGroup: 'email', kind: '账号与订阅' };
    },
  });
  await state.run();
  assert.ok(metadataReads >= 1);
  assert.equal(state.saved?.cards.length, 1);
  assert.equal(state.saved?.cards[0]?.title, '邮箱');
});

test('explicit platform overrides page context and survives a follow-up with the old page filter', async () => {
  const fixture = shoppingFixture();
  const explain = (input: { candidates: Array<{ productId: string; evidence: Array<{ id: string }> }> }) => ({
    selections: [{ productId: input.candidates[0]!.productId, evidenceIds: [input.candidates[0]!.evidence[0]!.id] }],
  });
  const first = harness([{ intent: 'recommend', patch: { platform: 'anthropic', product: null },
    evidence: [{ field: 'platform', quote: 'Claude' }, { field: 'product', quote: '我想买Claude' }], question: null, options: [] }, explain],
  '当前页面筛选：ChatGPT / Codex\n我想买Claude', { ...fixture.needs, platform: 'openai', product: 'ChatGPT Plus' }, fixture.catalog);
  await first.run();
  const next = harness([{ intent: 'recommend', patch: {}, evidence: [], question: null, options: [] }, explain],
    '当前页面筛选：ChatGPT / Codex\n继续推荐', first.saved!.needs, fixture.catalog);
  await next.run();
  assert.equal(next.saved?.needs.platform, 'anthropic');
  assert.equal(next.saved?.needs.product, null);
  assert.equal(next.saved?.cards[0]?.title, 'Claude Pro');
});

test('quote snapshots bound merchant text, preserve terms or mark omissions, and omit unsafe links', async () => {
  const fixture = shoppingFixture();
  const explain = (input: { candidates: Array<{ productId: string; evidence: Array<{ id: string }> }> }) => ({
    selections: [{ productId: input.candidates[0]!.productId, evidenceIds: [input.candidates[0]!.evidence[0]!.id] }],
  });
  Object.assign(fixture.offer, { name: '商品'.repeat(200), spec: '条款'.repeat(2000), productUrl: 'javascript:alert(1)' });
  const state = harness([{ intent: 'recommend', patch: {}, evidence: [], question: null, options: [] }, explain],
    '请推荐', fixture.needs, fixture.catalog);
  await state.run();
  assert.ok(state.saved?.cards[0]?.offer?.name.length! <= 240);
  assert.equal(state.saved?.cards[0]?.offer?.productUrl, '');
  assert.match(state.saved?.cards[0]?.offer?.spec ?? '', /完整/u);
});

test('model explanation cannot omit the preferred warranty and top-up quote', async () => {
  const fixture = shoppingFixture();
  const preferred = { ...fixture.offer, productId: '10', price: '50.00', tags: [...fixture.offer.tags,
    { name: 'warranty', value: 'covered' }, { name: 'delivery', value: 'top_up' }] };
  const state = harness([{ intent: 'recommend', patch: {}, evidence: [], question: null, options: [] },
    (input: { candidates: Array<{ productId: string; evidence: Array<{ id: string }> }> }) => {
      assert.equal(input.candidates[0]!.productId, '10');
      const cheap = input.candidates.find(candidate => candidate.productId === '9')!;
      return { selections: [{ productId: cheap.productId, evidenceIds: [cheap.evidence[0]!.id] }] };
    }], '请推荐', fixture.needs, { ...fixture.catalog, getCatalog: async query => {
      const page = await fixture.catalog.getCatalog!(query);
      return { ...page, items: page.items.map(item => ({ ...item,
        detail: { kind: 'offers', page: 0, pageSize: 20, total: 2, entries: [fixture.offer, preferred] } })) };
    } });
  await state.run();
  assert.deepEqual(state.saved?.cards.map(card => card.productId), ['10', '9']);
  assert.match(state.saved?.cards[0]?.reasons.join(' ') ?? '', /给你已有账号充值/u);
  assert.equal(state.saved?.text, '找到以下报价。');
  assert.doesNotMatch(state.saved?.text ?? '', /我会先|请结合使用需求确认|下单前请核对/u);
});

test('beginner delivery instructions and warranty facts fit the card evidence budget', async () => {
  const fixture = shoppingFixture();
  fixture.offer.tags.push({ name: 'delivery', value: 'account' }, { name: 'warranty', value: 'covered' },
    { name: 'warranty_exclusion', value: 'ban' }, { name: 'warranty_terms', value: '联系商家处理' });
  const state = harness([
    { intent: 'recommend', patch: {}, evidence: [], question: null, options: [] },
    (input: { candidates: Array<{ productId: string; evidence: Array<{ id: string; text: string }> }> }) => ({
      selections: [{ productId: '9', evidenceIds: input.candidates[0]!.evidence
        .filter(item => !/购买内容|质保|不保事项|售后条款/u.test(item.text)).slice(0, 4).map(item => item.id) }],
    }),
  ], '请推荐', fixture.needs, fixture.catalog);
  await state.run();
  assert.match(state.saved?.cards[0]?.reasons.join(' ') ?? '', /成品号：商家提供一个账号/u);
  assert.match(state.saved?.cards[0]?.caveats.join(' ') ?? '', /不保封号/u);
  assert.ok(state.saved!.cards[0]!.evidenceIds.length <= 8);
});

test('a standard product changed to another tier during explanation loses its original capability evidence', async () => {
  const fixture = shoppingFixture();
  let changed = false;
  const state = harness([
    { intent: 'recommend', patch: {}, evidence: [], question: null, options: [] },
    (input: { candidates: Array<{ productId: string; evidence: Array<{ id: string }> }> }) => {
      changed = true;
      return { selections: [{ productId: input.candidates[0]!.productId, evidenceIds: [input.candidates[0]!.evidence[0]!.id] }] };
    },
  ], '请推荐', fixture.needs, {
    ...fixture.catalog, resolvePublicProductIdentity: async identity => changed ? null : fixture.catalog.resolvePublicProductIdentity!(identity),
  });
  await state.run();
  assert.equal(state.saved?.kind, 'no_match');
  assert.equal(state.saved?.cards.length, 0);
  assert.equal(state.calls, 2);
});

test('a requested Plus product changed to Go during explanation is removed before replying', async () => {
  const fixture = shoppingFixture();
  const product = { id: '42', name: 'ChatGPT Plus', platform: 'openai', kind: '订阅' };
  const state = harness([
    { intent: 'recommend', patch: {}, evidence: [], question: null, options: [] },
    (input: { candidates: Array<{ productId: string; evidence: Array<{ id: string }> }> }) => {
      product.name = 'ChatGPT Go';
      return { selections: [{ productId: input.candidates[0]!.productId, evidenceIds: [input.candidates[0]!.evidence[0]!.id] }] };
    },
  ], '请推荐', { ...emptyShoppingNeeds(), platform: 'openai', product: 'ChatGPT Plus' }, {
    ...fixture.catalog, getProducts: async () => ({ items: [product] }), getProduct: async () => product,
  });
  await state.run();
  assert.equal(state.saved?.kind, 'no_match');
  assert.deepEqual(state.saved?.cards, []);
  assert.equal(state.calls, 2);
});

test('price expiry while explaining removes a candidate without making a third model request', async () => {
  const fixture = shoppingFixture();
  const state = harness([
    { intent: 'recommend', patch: {}, evidence: [], question: null, options: [] },
    (input: { candidates: Array<{ productId: string; evidence: Array<{ id: string }> }> }) => {
      Object.assign(fixture.offer, { priceExpiresAt: new Date(quoteNow.getTime() - 1).toISOString() });
      return { selections: [{ productId: input.candidates[0]!.productId, evidenceIds: [input.candidates[0]!.evidence[0]!.id] }] };
    },
  ], '请推荐', fixture.needs, fixture.catalog);
  await state.run();
  assert.equal(state.calls, 2);
  assert.equal(state.saved?.kind, 'no_match');
  assert.equal(state.saved?.cards.length, 0);
});

test('PostgreSQL JSON timestamps with offsets and microseconds become canonical UTC card timestamps', async () => {
  const fixture = shoppingFixture();
  fixture.offer.capturedAt = fixture.offer.capturedAt.replace('Z', '123+00:00');
  fixture.offer.priceExpiresAt = fixture.offer.priceExpiresAt!.replace('Z', '123+00:00');
  const state = harness([
    { intent: 'recommend', patch: {}, evidence: [], question: null, options: [] },
    (input: { candidates: Array<{ productId: string; evidence: Array<{ id: string }> }> }) => ({
      selections: [{ productId: input.candidates[0]!.productId, evidenceIds: [input.candidates[0]!.evidence[0]!.id] }],
    }),
  ], '请推荐', fixture.needs, fixture.catalog);
  await state.run();
  assert.equal(state.saved?.cards[0]?.capturedAt, new Date(fixture.offer.capturedAt).toISOString());
  assert.equal(state.saved?.cards[0]?.priceExpiresAt, new Date(fixture.offer.priceExpiresAt).toISOString());
});

test('model cannot add free claims or references outside the actual candidate evidence', async () => {
  const fixture = shoppingFixture();
  const state = harness([
    { intent: 'recommend', patch: {}, evidence: [], question: null, options: [] },
    { selections: [{ productId: '9', evidenceIds: ['forged'] }], text: '保证不封号' },
  ], '请推荐', fixture.needs, fixture.catalog);
  await assert.rejects(state.run(), /MODEL_INVALID_RESPONSE/u);
  assert.equal(state.saved, null);
});

test('warranty scope and exclusions are shown even when the model selects only a price reason', async () => {
  const fixture = shoppingFixture();
  fixture.offer.tags.push(
    { name: 'warranty_scope', value: 'first_login' },
    { name: 'warranty_days', value: '30' },
    { name: 'warranty_exclusion', value: 'ban' },
  );
  const state = harness([
    { intent: 'recommend', patch: {}, evidence: [], question: null, options: [] },
    (input: { candidates: Array<{ productId: string; evidence: Array<{ id: string }> }> }) => ({
      selections: [{ productId: input.candidates[0]!.productId, evidenceIds: [input.candidates[0]!.evidence[0]!.id] }],
    }),
  ], '请推荐', fixture.needs, fixture.catalog);
  await state.run();
  const warnings = state.saved?.cards[0]?.caveats.join(' ') ?? '';
  assert.match(warnings, /仅保首登/u);
  assert.match(warnings, /不保封号/u);
});

test('unsupported purpose is explained rather than recommended from model memory', async () => {
  const state = harness([{
    intent: 'recommend', patch: { purpose: '学习' }, evidence: [{ field: 'purpose', quote: '学习' }],
    question: null, options: [],
  }]);
  await state.run();
  assert.equal(state.calls, 1);
  assert.equal(state.saved?.cards.length, 0);
  assert.match(state.saved?.text ?? '', /资料|用途/u);
});

test('malformed complete model response is rejected before any answer persistence', async () => {
  const state = harness([{ intent: 'recommend', patch: { budget: { amount: '1.00', currency: 'CNY', basis: 'purchase' } } }]);
  await assert.rejects(state.run(), /MODEL_INVALID_RESPONSE/u);
  assert.equal(state.saved, null);
});

test('model cannot silently clear an existing hard requirement while changing the purpose', async () => {
  const needs = { ...emptyShoppingNeeds(), requiredTags: [{ name: 'access', value: 'dedicated' }] };
  const state = harness([{
    intent: 'recommend', patch: { requiredTags: [] },
    evidence: [{ field: 'requiredTags', quote: '写代码' }], question: null, options: [],
  }], '我想写代码', needs);
  await state.run();
  assert.deepEqual(state.saved?.needs.requiredTags, needs.requiredTags);
  assert.equal(state.saved?.kind, 'question');
  assert.equal(state.calls, 1);
});

test('follow-up cannot silently drop a product selection on the same platform', async () => {
  const needs = { ...emptyShoppingNeeds(), platform: 'openai', product: 'ChatGPT Plus' };
  const state = harness([{ intent: 'recommend', patch: { product: null },
    evidence: [{ field: 'product', quote: '继续推荐' }], question: null, options: [] }], '继续推荐', needs);
  await state.run();
  assert.equal(state.saved?.needs.product, 'ChatGPT Plus');
  assert.equal(state.saved?.kind, 'question');
});

test('negated consent never clears an existing hard requirement', async () => {
  const needs = {
    ...emptyShoppingNeeds(), requiredTags: [{ name: 'access', value: 'dedicated' }],
    budget: { amount: '80.00', currency: 'CNY', basis: 'purchase' as const },
  };
  for (const [text, field, patch] of [
    ['不接受共享', 'requiredTags', { requiredTags: [] }],
    ['不要取消预算', 'budget', { budget: null }],
    ['不要放宽独享要求', 'requiredTags', { requiredTags: [] }],
  ] as const) {
    const state = harness([{
      intent: 'recommend', patch, evidence: [{ field, quote: text }], question: null, options: [],
    }], text, needs);
    await state.run();
    assert.deepEqual(state.saved?.needs, needs, text);
    assert.equal(state.saved?.kind, 'question');
  }
});

test('explicitly allowing shared accounts or removing a budget can relax those requirements', async () => {
  const needs = {
    ...emptyShoppingNeeds(), requiredTags: [{ name: 'access', value: 'dedicated' }],
    budget: { amount: '80.00', currency: 'CNY', basis: 'purchase' as const },
  };
  const state = harness([{
    intent: 'recommend', patch: { requiredTags: [], budget: null },
    evidence: [{ field: 'requiredTags', quote: '共享也行' }, { field: 'budget', quote: '不限制预算' }],
    question: null, options: [],
  }], '共享也行，不限制预算', needs);
  await state.run();
  assert.deepEqual(state.saved?.needs.requiredTags, []);
  assert.equal(state.saved?.needs.budget, null);
});

test('aborted turns never start model work or commit an answer', async () => {
  const state = harness([]);
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(state.run(controller.signal), /cancelled/u);
  assert.equal(state.calls, 0);
  assert.equal(state.saved, null);
});
