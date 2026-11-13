import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ASSISTANT_LIMITS, emptyShoppingNeeds, type AssistantReply, type ShoppingNeeds } from '@price-comparison/catalog/assistant-contract';
import { AssistantService, parseExplanation } from '../src/assistant/assistant.service.js';
import { applyNeedsPatch, parseUnderstanding } from '../src/assistant/assistant.schemas.js';
import { candidateEvidence } from '../src/assistant/assistant-candidates.js';
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
  const prompts: string[] = [];
  const repository = {
    readTurnContext: async () => ({
      snapshot: { id: '1', inputText: text, expectedRevision: 0 },
      deadlineAt: new Date(Date.now() + ASSISTANT_LIMITS.turnDeadlineMs), needs, history,
    }),
    setPhase: async () => {},
    reserveModelRequest: async () => { reserved += 1; },
    finishModelRequest: async () => {},
    completeTurn: async (value: { reply: AssistantReply }) => { saved = value.reply; },
  } as unknown as AssistantRepository;
  const call: StreamingCall = async ({ signal, maxOutputTokens, messages }) => {
    prompts.push(String(messages[0]?.content));
    signal.throwIfAborted();
    assert.equal(maxOutputTokens, 8192);
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
    get saved() { return saved; }, get calls() { return calls; }, get reserved() { return reserved; }, prompts,
  };
}

test('understanding prompt examples validate evidence and preserve or explicitly clear existing needs', async () => {
  const state = harness([{ intent: 'clarify', patch: {}, evidence: [], question: '你想买什么商品？', options: [] }]);
  await state.run();
  assert.match(state.prompts[0]!, /租号、共享、合租=membershipKinds:\["rental"\]/u);
  assert.match(state.prompts[0]!, /未分类=membershipKinds:\["unclassified"\]/u);
  const examples = [...state.prompts[0]!.matchAll(/<understanding_example>\s*<input>([\s\S]*?)<\/input>\s*<output>([\s\S]*?)<\/output>\s*<\/understanding_example>/gu)];
  assert.equal(examples.length, 2);
  const needs = examples.map(example => {
    const input = JSON.parse(example[1]!);
    const understanding = parseUnderstanding(JSON.parse(example[2]!), input.userText);
    return applyNeedsPatch(input.needs, understanding.patch);
  });
  assert.deepEqual(needs[0], {
    purpose: '写代码', platform: 'openai', product: 'ChatGPT Plus', budget: null,
    requiredTags: [{ name: 'duration', value: 30 }], membershipKinds: ['top_up'], preferences: ['lower_price'],
  });
  assert.deepEqual(needs[1], { purpose: '写代码', platform: 'openai', product: 'ChatGPT Plus', budget: null,
    requiredTags: [], preferences: [] });
});

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

test('obsolete filters produce an explicit question without model calls, catalog reads or silent no-matches', async () => {
  for (const patch of [{ warrantyDaysMin: 30 }, { preferences: ['longer_warranty'] },
    { requiredTags: [{ name: 'delivery', value: 'account' }] }]) {
    const needs = { ...emptyShoppingNeeds(), platform: 'openai', ...patch } as ShoppingNeeds;
    const state = harness([], '继续推荐', needs, {
      getProducts: async () => { throw new Error('invalid filters must not query'); },
    });
    await state.run();
    assert.equal(state.calls, 0);
    assert.equal(state.reserved, 0);
    assert.equal(state.saved?.kind, 'question');
    assert.equal(state.saved?.needsInvalidated, true);
    assert.match(state.saved?.text ?? '', /失效.*聊天记录仍保留/u);
    assert.deepEqual(state.saved?.needs, emptyShoppingNeeds());
  }
});

function shoppingFixture() {
  const product = { id: '42', name: 'Claude Pro', platform: 'anthropic', platformGroup: 'anthropic', kind: '订阅',
    identity: { family: 'anthropic', product: 'claude', tier: 'pro' } };
  const offer: CatalogOffer = {
    membershipKind: 'top_up',
    shopId: '3', productId: '9', name: 'Pro 一个月', shop: '测试商铺', price: '30.00', currency: 'CNY',
    settlementQuantity: 1, priceStatus: 'verified', capturedAt: quoteNow.toISOString(),
    priceExpiresAt: new Date(quoteNow.getTime() + 60_000).toISOString(), inventoryExpiresAt: new Date(quoteNow.getTime() + 60_000).toISOString(),
    productUrl: 'https://shop.invalid/product/9', spec: '', stale: false, inStock: true,
    tags: [{ name: 'sms_verification', value: 'verified' }, { name: 'duration', value: 30 }],
  };
  const needs: ShoppingNeeds = { ...emptyShoppingNeeds(), purpose: '写代码' };
  const catalog: Partial<CatalogService> = {
    resolvePublicProductIdentities: async () => [product],
    getProduct: async () => product,
    getProducts: async () => ({ items: [product] }),
    getReferenceOffers: async () => [offer],
  };
  return { offer, needs, catalog };
}

test('explicit rental understanding reaches catalog filters and the saved quote without a real model', async () => {
  const fixture = shoppingFixture();
  const product = { id: '42', name: 'Claude Pro', platform: 'anthropic', kind: '订阅',
    identity: { family: 'anthropic', product: 'claude', tier: 'pro' } };
  fixture.offer = { ...fixture.offer, membershipKind: 'rental' };
  const state = harness([
    { intent: 'recommend', patch: { membershipKinds: ['rental'] },
      evidence: [{ field: 'membershipKinds', quote: '合租' }], question: null, options: [] },
    (input: { candidates: Array<{ productId: string; evidence: Array<{ id: string; text: string }> }> }) => {
      const candidate = input.candidates[0]!;
      const rental = candidate.evidence.find(item => item.text.includes('租号'))!;
      assert.ok(rental);
      return { selections: [{ productId: candidate.productId, evidenceIds: [rental.id] }] };
    },
  ], '只看合租', { ...emptyShoppingNeeds(), product: 'Claude Pro' }, {
    getProducts: async () => ({ items: [product] }),
    getReferenceOffers: async input => {
      assert.deepEqual(input.membershipKinds, ['rental']);
      assert.equal(input.newcomer, true);
      assert.deepEqual(input.tags, []);
      return [fixture.offer];
    },
  });
  await state.run();
  assert.equal(state.calls, 2);
  assert.deepEqual(state.saved?.needs.membershipKinds, ['rental']);
  assert.equal(state.saved?.cards[0]?.offer?.membershipKind, 'rental');
  assert.match(state.saved?.cards[0]?.reasons.join(' ') ?? '', /租号/u);
});

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

test('recommendation reads the complete reference pool once including alternatives beyond 50 offers', async () => {
  const fixture = shoppingFixture();
  const product = { id: '42', name: 'ChatGPT Plus', platform: 'openai', kind: '订阅' };
  const offers = Array.from({ length: 52 }, (_, index) => ({ ...fixture.offer,
    productId: String(index + 1), price: index < 50 ? '30.00' : '60.00',
    spec: index < 50 ? '需资格账号' : index === 50 ? '普通账号可用' : '需实名验证',
    tags: [...fixture.offer.tags, { name: 'warranty', value: '保订阅30天，封号不保' }],
  }));
  let reads = 0;
  const needs = { ...emptyShoppingNeeds(), product: 'ChatGPT Plus', requiredTags: [{ name: 'sms_verification', value: 'verified' }],
    budget: { amount: '80', currency: 'CNY', basis: 'purchase' as const } };
  const state = harness([
    { intent: 'recommend', patch: {}, evidence: [], question: null, options: [] },
    (input: { candidates: Array<{ productId: string; evidence: Array<{ id: string }> }> }) => {
      assert.equal(input.candidates.length, 12);
      return { selections: ['1', '51', '52'].map(productId => {
        const candidate = input.candidates.find(candidate => candidate.productId === productId)!;
        assert.ok(candidate, 'later alternatives must reach reranking');
        return { productId, evidenceIds: [candidate.evidence[0]!.id] };
      }) };
    },
  ], '我想找一个靠谱的代充，gpt plus会员的', needs, {
    getProducts: async () => ({ items: [product] }), getProduct: async () => product,
    getReferenceOffers: async query => {
      assert.deepEqual(query.tags, needs.requiredTags);
      assert.equal(query.priceMax, '80');
      reads++;
      return offers;
    },
  });
  await state.run();
  assert.deepEqual(state.saved?.cards.map(c => c.productId), ['1', '51', '52']);
  assert.equal(reads, 1);
  assert.equal(state.calls, 2, 'diversity does not require extra model calls');
});

test('semantic reranking can choose a complementary offer beyond three differently worded restrictions', async () => {
  const fixture = shoppingFixture();
  const restrictions = ['仅限优惠资格账号', '需具备优惠资格', '账号必须符合优惠活动条件', '普通账号可用，无需优惠资格', '需资格账号'];
  const offers = restrictions.map((value, index) => ({ ...fixture.offer, productId: String(index + 1), price: String(30 + index),
    spec: value, tags: fixture.offer.tags,
  }));
  const state = harness([
    { intent: 'recommend', patch: {}, evidence: [], question: null, options: [] },
    (input: { candidates: Array<{ productId: string; evidence: Array<{ id: string; text: string }> }> }) => {
      assert.equal(input.candidates.length, 5, 'do not discard alternatives before semantic reranking');
      return { selections: ['1', '4', '2'].map(productId => {
        const candidate = input.candidates.find(candidate => candidate.productId === productId)!;
        const restriction = candidate.evidence.find(evidence => evidence.text.startsWith('商品规格与购买条件：'))!;
        return { productId, evidenceIds: [restriction.id] };
      }) };
    },
  ], '请推荐不同购买条件的方案', { ...fixture.needs, preferences: ['lower_price'] }, {
    ...fixture.catalog, getReferenceOffers: async () => offers,
  });
  await state.run();
  assert.deepEqual(state.saved?.cards.map(card => card.productId), ['1', '4', '2']);
  assert.ok(state.saved?.cards.find(card => card.productId === '4')?.reasons.some(text => text.includes('无需优惠资格')));
  assert.equal(state.calls, 2);
});

test('reranking preserves the preferred quote and fills omissions from deterministic alternatives', async () => {
  const fixture = shoppingFixture();
  const offers = Array.from({ length: 6 }, (_, index) => ({ ...fixture.offer, productId: String(index + 1),
    price: String(30 + index), spec: index < 3 ? '需实名验证' : '无需实名', tags: fixture.offer.tags,
  }));
  const state = harness([
    { intent: 'recommend', patch: {}, evidence: [], question: null, options: [] },
    (input: { candidates: Array<{ productId: string; evidence: Array<{ id: string }> }> }) => {
      const candidate = input.candidates.find(candidate => candidate.productId === '2')!;
      return { selections: [{ productId: '2', evidenceIds: [candidate.evidence[0]!.id] }] };
    },
  ], '请推荐', { ...fixture.needs, preferences: ['lower_price'] }, {
    ...fixture.catalog, getReferenceOffers: async () => offers,
  });
  await state.run();
  assert.equal(state.saved?.cards[0]?.productId, '1');
  assert.ok(state.saved?.cards.some(card => card.productId === '4'));
  assert.equal(state.saved?.cards.length, 3);
});

test('AI default remains a hard SQL request with budgets and preferences and never fills short term', async () => {
  for (const qualifyingCount of [0, 1, 3]) {
    const fixture = shoppingFixture();
    const offers = Array.from({ length: qualifyingCount }, (_, index) => ({ ...fixture.offer,
      productId: String(index + 1), price: String(10 + index), membershipKind: 'account' as const,
    }));
    const needs = { ...fixture.needs, budget: { amount: '99', currency: 'CNY', basis: 'purchase' as const },
      preferences: ['lower_price' as const] };
    const state = harness([
      { intent: 'recommend', patch: {}, evidence: [], question: null, options: [] },
      (input: { candidates: Array<{ productId: string; evidence: Array<{ id: string }> }> }) => ({
        selections: input.candidates.map(candidate => ({ productId: candidate.productId, evidenceIds: [candidate.evidence[0]!.id] })),
      }),
    ], '请推荐', needs, { ...fixture.catalog, getReferenceOffers: async input => {
      assert.equal(input.newcomer, true);
      assert.equal(input.priceMax, '99');
      assert.equal(input.membershipKinds, undefined);
      return offers;
    } });
    await state.run();
    assert.equal(state.saved?.cards.length, qualifyingCount);
    assert.deepEqual(state.saved?.needs, needs);
    assert.equal(state.saved?.kind, qualifyingCount ? 'recommendation' : 'no_match');
    assert.equal(state.calls, qualifyingCount ? 2 : 1);
  }
});

test('explicit natural-language membership and all-category choices reach the query and persist only as user choices', async () => {
  for (const [text, patch] of [
    ['只看短期', { membershipKinds: ['short_term'] }],
    ['只看未分类', { membershipKinds: ['unclassified'] }],
    ['全部类别', { membershipKinds: null, newcomer: false }],
    ['只看成品号', { membershipKinds: ['account'] }],
  ] as const) {
    const fixture = shoppingFixture();
    if (patch.membershipKinds === null) fixture.needs.membershipKinds = ['top_up'];
    let query: Parameters<CatalogService['getReferenceOffers']>[0] | undefined;
    const state = harness([{ intent: 'recommend', patch,
      evidence: Object.keys(patch).map(field => ({ field, quote: text })), question: null, options: [] }],
    text, fixture.needs, { ...fixture.catalog, getReferenceOffers: async input => { query = input; return []; } });
    await state.run();
    assert.deepEqual(query?.membershipKinds, patch.membershipKinds ?? undefined);
    assert.equal(query?.newcomer, 'newcomer' in patch ? patch.newcomer : true);
    assert.deepEqual(state.saved?.needs, { ...fixture.needs, ...patch });
    assert.equal(state.saved?.kind, 'no_match');
    assert.equal(state.calls, 1);
  }
});

test('semantic selections reject invented candidates, duplicate selections and cross-candidate evidence', () => {
  const fixture = shoppingFixture();
  const candidates = ['1', '2'].map(productId => ({
    standardProduct: { id: '42', name: 'Claude Pro', platform: 'anthropic', kind: '订阅' },
    offer: { ...fixture.offer, productId }, capabilityEvidence: [],
  }));
  const valid = { productId: '1', evidenceIds: [candidateEvidence(candidates[0]!)[0]!.id] };
  for (const selections of [
    [valid, valid], [{ ...valid, productId: 'invented' }],
    [{ ...valid, evidenceIds: [candidateEvidence(candidates[1]!)[0]!.id] }],
  ]) assert.throws(() => parseExplanation({ selections }, candidates), /MODEL_INVALID_RESPONSE/u);
});

test('a large evidence pool shrinks without truncating the preferred complementary offers', async () => {
  const fixture = shoppingFixture();
  const offers = Array.from({ length: 12 }, (_, index) => ({ ...fixture.offer, productId: String(index + 1),
    price: String(30 + index), tags: fixture.offer.tags,
    spec: (index < 10 ? '仅限优惠资格' : index === 10 ? '普通账号可用' : '需实名验证')
      + '完整售后条款'.repeat(200),
  }));
  let supplied: Array<{ productId: string; source: { spec: string }; evidence: Array<{ id: string; text: string }> }> = [];
  const state = harness([
    { intent: 'recommend', patch: {}, evidence: [], question: null, options: [] },
    (input: { candidates: typeof supplied }) => {
      supplied = input.candidates;
      return { selections: input.candidates.slice(0, 3).map(candidate => ({
        productId: candidate.productId, evidenceIds: [candidate.evidence[0]!.id],
      })) };
    },
  ], '请推荐', { ...fixture.needs, preferences: ['lower_price'] }, {
    ...fixture.catalog, getReferenceOffers: async () => offers,
  });
  await state.run();
  assert.ok(supplied.length >= 3 && supplied.length < 12);
  assert.ok(Buffer.byteLength(JSON.stringify(supplied)) <= 32 * 1024);
  assert.equal(supplied[0]?.productId, '1');
  assert.ok(supplied.slice(0, 3).some(candidate => candidate.productId === '11'));
  for (const candidate of supplied) {
    assert.equal(candidate.source.spec, offers.find(offer => offer.productId === candidate.productId)?.spec);
  }
  assert.deepEqual(state.saved?.cards.map(card => card.productId), supplied.slice(0, 3).map(candidate => candidate.productId));
  assert.equal(state.calls, 2);
});

test('recommendations preserve the queried price snapshot without reloading changed prices', async () => {
  const fixture = shoppingFixture();
  let explained = false;
  const offers = Array.from({ length: 5 }, (_, index) => ({ ...fixture.offer, productId: String(index + 1), price: `${30 + index}.00` }));
  const state = harness([
    { intent: 'recommend', patch: {}, evidence: [], question: null, options: [] },
    (input: { candidates: Array<{ productId: string; evidence: Array<{ id: string }> }> }) => {
      explained = true;
      return { selections: input.candidates.slice(0, 3).map(candidate => ({
        productId: candidate.productId, evidenceIds: [candidate.evidence[0]!.id],
      })) };
    },
  ], '请推荐', { ...fixture.needs, preferences: ['lower_price'] }, {
    ...fixture.catalog, getReferenceOffers: async () => offers.map((offer, index) => explained && index < 3 ? { ...offer, price: `${30 + index}.10` } : offer),
  });
  await state.run();
  assert.deepEqual(state.saved?.cards.map(card => card.productId), ['1', '2', '3']);
  assert.deepEqual(state.saved?.cards.map(card => card.price), ['30.00', '31.00', '32.00']);
  assert.equal(state.calls, 2);
});

test('candidate lookup stops on cancellation before requesting an explanation', async () => {
  const fixture = shoppingFixture();
  const controller = new AbortController();
  let reads = 0;
  const state = harness([{ intent: 'recommend', patch: {}, evidence: [], question: null, options: [] }],
    '请推荐', fixture.needs, { ...fixture.catalog, getReferenceOffers: async query => {
      reads += 1;
      controller.abort(new Error('stop lookup'));
      return fixture.catalog.getReferenceOffers!(query);
    } });
  await assert.rejects(state.run(controller.signal), /stop lookup/);
  assert.equal(reads, 1);
  assert.equal(state.calls, 1);
  assert.equal(state.saved, null);
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
    '比较刚才两个', fixture.needs, { getReferenceOffers: async () => { throw new Error('must not search new candidates'); } });
  await state.run();
  assert.equal(state.saved?.text, '先告诉我想买哪个商品，找到报价后再帮你比较。');
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
    ...fixture.catalog, resolvePublicProductIdentities: async () => [], getProduct: async () => product,
    getProducts: async () => ({ items: [product] }),
    getReferenceOffers: async query => {
      assert.equal(query.standardProductId, '42');
      return fixture.catalog.getReferenceOffers!(query);
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
    getReferenceOffers: async () => [{ ...fixture.offer, shop: 'PLUSAI', name: 'Go会员官方直冲' }],
  });
  await state.run();
  assert.equal(state.saved?.kind, 'recommendation');
  assert.deepEqual(state.saved?.cards.map(card => card.title), ['ChatGPT Plus']);
  assert.deepEqual(state.saved?.needs, { ...needs, product: 'ChatGPT Plus' });
});

for (const resumed of [false, true]) test(`numeric duration separates from product names (resumed: ${resumed})`, async () => {
  const fixture = shoppingFixture();
  const product = { id: '42', name: 'ChatGPT Plus', platform: 'openai', kind: '订阅' };
  const initial = { ...emptyShoppingNeeds(), ...(resumed ? { platform: 'openai', product: 'ChatGPT Plus 1个月' } : {}) };
  const state = harness([
    { intent: 'recommend', patch: resumed ? {} : { platform: 'openai', product: 'ChatGPT Plus 1个月' },
      evidence: resumed ? [] : [{ field: 'platform', quote: 'ChatGPT' }, { field: 'product', quote: 'ChatGPT Plus 1个月' }], question: null, options: [] },
    (input: { candidates: Array<{ productId: string; evidence: Array<{ id: string }> }> }) => ({
      selections: [{ productId: input.candidates[0]!.productId, evidenceIds: [input.candidates[0]!.evidence[0]!.id] }],
    }),
  ], 'ChatGPT Plus 1个月', initial, {
    getProducts: async () => ({ items: [product] }), getReferenceOffers: async query => {
      assert.deepEqual(query.tags, [{ name: 'duration', value: 30 }]);
      return [fixture.offer];
    },
  });
  await state.run();
  assert.equal(state.saved?.kind, 'recommendation');
  assert.deepEqual(state.saved?.needs, { ...initial, platform: 'openai', product: 'chatgpt plus', requiredTags: [{ name: 'duration', value: 30 }] });
});

for (const clearsTags of [false, true]) test(`follow-ups retain duration from previous product names (clears tags: ${clearsTags})`, async () => {
  const needs = { ...emptyShoppingNeeds(), platform: 'openai', product: 'ChatGPT Plus 1个月' };
  const state = harness([
    { intent: 'recommend', patch: { product: 'ChatGPT Plus', ...(clearsTags ? { requiredTags: [] } : {}) },
      evidence: [{ field: 'product', quote: 'Plus' }, ...(clearsTags ? [{ field: 'requiredTags', quote: '再找一个' }] : [])], question: null, options: [] },
  ], 'Plus，再找一个', needs);
  await state.run();
  assert.equal(state.saved?.kind, clearsTags ? 'question' : 'no_match');
  assert.deepEqual(state.saved?.needs.requiredTags, [{ name: 'duration', value: 30 }]);
});

test('duration embedded in a product name cannot override a conflicting requirement', async () => {
  const needs = { ...emptyShoppingNeeds(), platform: 'openai', product: 'ChatGPT Plus 1个月', requiredTags: [{ name: 'duration', value: 365 }] };
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
  assert.equal(state.saved?.text, '暂时没找到符合要求的报价，可以调整预算或购买条件再找。');
  assert.equal(state.calls, 1);
});

test('platform-only browsing uses authoritative catalog groups instead of guessing from the vendor name', async () => {
  const fixture = shoppingFixture();
  let metadataReads = 0;
  const needs = { ...emptyShoppingNeeds(), platform: 'email' };
  const state = harness([
    { intent: 'recommend', patch: {}, evidence: [], question: null, options: [] },
    (input: { candidates: Array<{ productId: string; evidence: Array<{ id: string }> }> }) => ({
      selections: [{ productId: input.candidates[0]!.productId, evidenceIds: [input.candidates[0]!.evidence[0]!.id] }],
    }),
  ], '找邮箱', needs, {
    ...fixture.catalog, getProducts: async () => {
      metadataReads++;
      return { items: [{ id: '42', name: '邮箱', platform: 'google', platformGroup: 'email', kind: '账号与订阅' }] };
    },
  });
  await state.run();
  assert.ok(metadataReads >= 1);
  assert.equal(state.saved?.cards.length, 1);
  assert.equal(state.saved?.cards[0]?.title, '邮箱');
});

test('platform browsing skips standards without matching reference quotes before limiting products', async () => {
  const fixture = shoppingFixture();
  const read: string[] = [];
  const state = harness([
    { intent: 'recommend', patch: {}, evidence: [], question: null, options: [] },
    (input: { candidates: Array<{ productId: string; evidence: Array<{ id: string }> }> }) => ({
      selections: input.candidates.map(candidate => ({ productId: candidate.productId, evidenceIds: [candidate.evidence[0]!.id] })),
    }),
  ], '看看这个平台', { ...emptyShoppingNeeds(), platform: 'openai' }, {
    getProducts: async () => ({ items: Array.from({ length: 6 }, (_, i) => ({ id: String(i + 1), name: `套餐${i}`, platform: 'openai', kind: '订阅' })) }),
    getReferenceOffers: async query => {
      read.push(String(query.standardProductId));
      return query.standardProductId === '6' ? [fixture.offer] : [];
    },
  });
  await state.run();
  assert.deepEqual(read, ['1', '2', '3', '4', '5', '6']);
  assert.equal(state.saved?.kind, 'recommendation');
  assert.equal(state.saved?.cards[0]?.standardProductId, '6');
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

test('model explanation cannot replace the preferred price with a longer warranty claim', async () => {
  const fixture = shoppingFixture();
  const expensive = { ...fixture.offer, productId: '10', price: '50.00', tags: [...fixture.offer.tags,
    { name: 'warranty', value: '保订阅30天，封号不保' }] };
  const state = harness([{ intent: 'recommend', patch: {}, evidence: [], question: null, options: [] },
    (input: { candidates: Array<{ productId: string; evidence: Array<{ id: string }> }> }) => {
      assert.equal(input.candidates[0]!.productId, '9');
      const other = input.candidates.find(candidate => candidate.productId === '10')!;
      return { selections: [{ productId: other.productId, evidenceIds: [other.evidence[0]!.id] }] };
    }], '请推荐', { ...fixture.needs, preferences: ['lower_price'] },
    { ...fixture.catalog, getReferenceOffers: async () => [fixture.offer, expensive] });
  await state.run();
  assert.deepEqual(state.saved?.cards.map(card => card.productId), ['9', '10']);
  assert.match(state.saved?.cards[0]?.reasons.join(' ') ?? '', /代充/u);
  assert.equal(state.saved?.text, '找到以下报价。');
});

test('membership evidence and complete warranty summary fit the card budget', async () => {
  const fixture = shoppingFixture();
  fixture.offer.membershipKind = 'account';
  fixture.offer.tags.push({ name: 'warranty', value: '保订阅30天，封号不保；需联系商家处理' });
  const state = harness([
    { intent: 'recommend', patch: {}, evidence: [], question: null, options: [] },
    (input: { candidates: Array<{ productId: string; evidence: Array<{ id: string; text: string }> }> }) => ({
      selections: [{ productId: '9', evidenceIds: input.candidates[0]!.evidence
        .filter(item => !/会员商品特性|商家质保/u.test(item.text)).slice(0, 4).map(item => item.id) }],
    }),
  ], '请推荐', fixture.needs, fixture.catalog);
  await state.run();
  assert.match(state.saved?.cards[0]?.reasons.join(' ') ?? '', /成品号/u);
  assert.match(state.saved?.cards[0]?.caveats.join(' ') ?? '', /封号不保/u);
  assert.ok(state.saved!.cards[0]!.evidenceIds.length <= 8);
});

test('recommendation retains the capability evidence captured by the initial query', async () => {
  const fixture = shoppingFixture();
  let changed = false;
  const state = harness([
    { intent: 'recommend', patch: {}, evidence: [], question: null, options: [] },
    (input: { candidates: Array<{ productId: string; evidence: Array<{ id: string }> }> }) => {
      changed = true;
      return { selections: [{ productId: input.candidates[0]!.productId, evidenceIds: [input.candidates[0]!.evidence[0]!.id] }] };
    },
  ], '请推荐', fixture.needs, {
    ...fixture.catalog, resolvePublicProductIdentities: async identity => changed ? [] : fixture.catalog.resolvePublicProductIdentities!(identity),
  });
  await state.run();
  assert.equal(state.saved?.kind, 'recommendation');
  assert.equal(state.saved?.cards.length, 1);
  assert.equal(state.calls, 2);
});

test('recommendation retains the requested product snapshot if the catalog changes during explanation', async () => {
  const fixture = shoppingFixture();
  const product = { id: '42', name: 'ChatGPT Plus', platform: 'openai', kind: '订阅' };
  const state = harness([
    { intent: 'recommend', patch: {}, evidence: [], question: null, options: [] },
    (input: { candidates: Array<{ productId: string; evidence: Array<{ id: string }> }> }) => {
      product.name = 'ChatGPT Go';
      return { selections: [{ productId: input.candidates[0]!.productId, evidenceIds: [input.candidates[0]!.evidence[0]!.id] }] };
    },
  ], '请推荐', { ...emptyShoppingNeeds(), platform: 'openai', product: 'ChatGPT Plus' }, {
    ...fixture.catalog, getProducts: async () => ({ items: [structuredClone(product)] }), getProduct: async () => product,
  });
  await state.run();
  assert.equal(state.saved?.kind, 'recommendation');
  assert.equal(state.saved?.cards[0]?.title, 'ChatGPT Plus');
  assert.equal(state.calls, 2);
});

test('expired reference quotes are returned without an additional catalog read', async () => {
  const fixture = shoppingFixture();
  fixture.offer.priceStatus = 'expired';
  fixture.offer.priceExpiresAt = new Date(quoteNow.getTime() - 1).toISOString();
  const state = harness([
    { intent: 'recommend', patch: {}, evidence: [], question: null, options: [] },
    (input: { candidates: Array<{ productId: string; evidence: Array<{ id: string }> }> }) => {
      return { selections: [{ productId: input.candidates[0]!.productId, evidenceIds: [input.candidates[0]!.evidence[0]!.id] }] };
    },
  ], '请推荐', fixture.needs, fixture.catalog);
  await state.run();
  assert.equal(state.calls, 2);
  assert.equal(state.saved?.kind, 'recommendation');
  assert.equal(state.saved?.cards.length, 1);
});

test('reference quotes with no expiry retain their captured price and time', async () => {
  const fixture = shoppingFixture();
  fixture.offer.priceStatus = 'estimated';
  fixture.offer.priceExpiresAt = null;
  fixture.offer.inventoryExpiresAt = null;
  const state = harness([
    { intent: 'recommend', patch: {}, evidence: [], question: null, options: [] },
    (input: { candidates: Array<{ productId: string; evidence: Array<{ id: string }> }> }) => ({
      selections: [{ productId: input.candidates[0]!.productId, evidenceIds: [input.candidates[0]!.evidence[0]!.id] }],
    }),
  ], '请推荐', fixture.needs, fixture.catalog);
  await state.run();
  assert.equal(state.saved?.cards[0]?.price, '30.00');
  assert.equal(state.saved?.cards[0]?.capturedAt, quoteNow.toISOString());
  assert.equal(state.saved?.cards[0]?.priceExpiresAt, null);
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
    { name: 'warranty', value: '购买后1小时仅保首登，不保封号' },
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

test('purpose-only requests without supporting product evidence continue with a question', async () => {
  for (const purpose of ['读论文', '学习', '做海报']) {
    const state = harness([{
      intent: 'recommend', patch: { purpose }, evidence: [{ field: 'purpose', quote: purpose }],
      question: null, options: [],
    }], purpose);
    await state.run();
    assert.equal(state.calls, 1);
    assert.equal(state.saved?.kind, 'question');
    assert.equal(state.saved?.needs.purpose, purpose);
    assert.equal(state.saved?.cards.length, 0);
    assert.match(state.saved?.text ?? '', /平台|套餐/u);
    assert.ok(state.saved!.options.length > 0, 'the user can select a concrete next step');
  }
});

test('invalid understanding fails without pretending the user needs to answer another question', async () => {
  const state = harness([{ intent: 'recommend', patch: { budget: { amount: '1.00', currency: 'CNY', basis: 'purchase' } } }]);
  await assert.rejects(state.run(), /MODEL_INVALID_RESPONSE/u);
  assert.equal(state.saved, null, 'unvalidated changes must never persist');
  assert.equal(state.calls, 1, 'only an explicit user retry can send another request');
});

test('invalid understanding never replaces existing purchase conditions with a fallback', async () => {
  for (const selection of [{}, { platform: 'openai' }, { platform: 'openai', product: 'ChatGPT Plus' }]) {
    const needs: ShoppingNeeds = { ...emptyShoppingNeeds(), ...selection,
      budget: { amount: '80', currency: 'CNY', basis: 'purchase' },
      requiredTags: [{ name: 'sms_verification', value: 'verified' }] };
    const state = harness([{ intent: 'clarify', patch: { budget: null }, evidence: [], question: '预算已取消？', options: [] }], '读论文', needs);
    await assert.rejects(state.run(), /MODEL_INVALID_RESPONSE/u);
    assert.equal(state.saved, null);
  }
});

test('a platform selected after clarification resumes recommendations with the earlier user message in context', async () => {
  const first = harness([{ intent: 'recommend', patch: { purpose: '读论文' },
    evidence: [{ field: 'purpose', quote: '读论文' }], question: null, options: [] }], '读论文');
  await first.run();
  assert.equal(first.saved?.kind, 'question');
  assert.ok(first.saved?.options.includes('Claude'));
  const fixture = shoppingFixture();
  const next = harness([
    (input: { history: Array<{ text: string; reply: AssistantReply }> }) => {
      assert.equal(input.history[0]?.text, '读论文');
      assert.equal(input.history[0]?.reply.kind, 'question');
      return { intent: 'recommend', patch: { platform: 'anthropic', product: 'Claude Pro' },
        evidence: [{ field: 'platform', quote: 'Claude' }, { field: 'product', quote: 'Claude Pro' }], question: null, options: [] };
    },
    (input: { candidates: Array<{ productId: string; evidence: Array<{ id: string }> }> }) => ({
      selections: [{ productId: input.candidates[0]!.productId, evidenceIds: [input.candidates[0]!.evidence[0]!.id] }],
    }),
  ], 'Claude Pro', first.saved!.needs, {
    ...fixture.catalog, getProducts: async () => ({ items: [{ id: '42', name: 'Claude Pro', platform: 'anthropic', kind: '订阅' }] }),
  }, [{ text: '读论文', reply: first.saved! }]);
  await next.run();
  assert.equal(next.saved?.kind, 'recommendation');
  assert.equal(next.saved?.cards[0]?.standardProductId, '42');
  assert.equal(next.saved?.needs.purpose, '读论文');
});

for (const [platform, name] of [['openai', 'ChatGPT'], ['anthropic', 'Claude'], ['google', 'Gemini']]) {
  test(`answering ${name} advances the conversation and preserves earlier conditions`, async () => {
    const needs = { ...emptyShoppingNeeds(), purpose: '写代码', budget: { amount: '80.00', currency: 'CNY', basis: 'month' as const } };
    const previous: AssistantReply = { kind: 'question', text: '你想了解哪个平台或套餐？可以选一个，也可以直接输入名称。',
      options: ['ChatGPT', 'Claude', 'Gemini'], needs, cards: [] };
    const state = harness([{ intent: 'recommend', patch: { platform }, evidence: [{ field: 'platform', quote: name }], question: null, options: [] }],
      name, needs, { resolvePublicProductIdentities: async () => [], getReferenceOffers: async () => [] }, [{ text: '写代码', reply: previous }]);
    await state.run();
    assert.equal(state.saved?.kind, 'no_match');
    assert.deepEqual(state.saved?.needs, { ...needs, platform });
    assert.deepEqual(state.saved?.options, []);

    for (const output of [{ intent: 'clarify' }, { intent: 'clarify', patch: {}, evidence: [], question: previous.text, options: previous.options }]) {
      const invalid = harness([output], name, needs, {}, [{ text: '写代码', reply: previous }]);
      await assert.rejects(invalid.run(), /MODEL_INVALID_RESPONSE/u);
      assert.equal(invalid.saved, null, 'an ignored answer must not be stored as another successful question');
    }
  });
}

test('model cannot silently clear an existing hard requirement while changing the purpose', async () => {
  const needs = { ...emptyShoppingNeeds(), requiredTags: [{ name: 'sms_verification', value: 'verified' }] };
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
    ...emptyShoppingNeeds(), requiredTags: [{ name: 'sms_verification', value: 'verified' }],
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
    ...emptyShoppingNeeds(), requiredTags: [{ name: 'sms_verification', value: 'verified' }],
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

test('an omitted platform answer cannot produce the same server-generated clarification again', async () => {
  const needs = { ...emptyShoppingNeeds(), purpose: '读论文' };
  const first = harness([{ intent: 'recommend', patch: {}, evidence: [], question: null, options: [] }], '读论文', needs);
  await first.run();
  assert.equal(first.saved?.kind, 'question');
  const next = harness([{ intent: 'recommend', patch: {}, evidence: [], question: null, options: [] }],
    'ChatGPT', first.saved!.needs, {}, [{ text: '读论文', reply: first.saved! }]);
  await assert.rejects(next.run(), /MODEL_INVALID_RESPONSE/u);
  assert.equal(next.saved, null);
});
