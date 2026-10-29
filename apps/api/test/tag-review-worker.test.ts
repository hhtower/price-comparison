import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpenAiModelCall } from '../src/ai/ai.worker.js';
import { CONSISTENCY_KEYS, DISCLOSURE_KEYS } from '../src/shops/shop-text-review.js';

const bill = { name: 'official_bill', value: '有', path: 'sourceData.evidence', quote: '可提供付款卡账单' };
const twoFactor = { name: '2fa', value: '有', path: 'sourceData.evidence', quote: '建议自行设置2FA' };
const duration = { name: 'duration', value: '30 days', path: 'spec', quote: '1个月' };
const proposals = { items: [{ id: '11', tags: [bill, twoFactor] }, { id: '12', tags: [duration] }] };
const review = { items: [{ id: '12', decisions: [false], textReview: null }, { id: '11', decisions: [true, false], textReview: null }] };
const job = { id: 7n, row: { job_id: 3n, job_type: 'tag_extraction', step: 'request' } };

function setup(content = JSON.stringify(review), finish: string | null = 'stop', timeout = 1000, hang = false, shopText?: unknown, candidates = proposals) {
  let sends = 0;
  const call = createOpenAiModelCall({
    getTagExtractionBatchInputs: async () => ({ jobId: 3n, model: 'mock', stage: 'review', proposals: candidates,
      inputs: [
        { productId: 11n, name: '商品甲', spec: '', sourceData: { evidence: '建议自行设置2FA。\n可提供付款卡账单。' },
          ...(shopText === undefined ? {} : { payload: { name: '商品甲', spec: '', sourceData: { evidence: '建议自行设置2FA。\n可提供付款卡账单。' }, shopText } }) },
        { productId: 12n, name: '商品乙', spec: '1个月', sourceData: {} },
      ] }),
  } as never, { AI_BASE_URL: 'https://mock.invalid/v1', AI_API_KEY: 'mock', AI_MODEL: 'mock', AI_TIMEOUT_MS: String(timeout),
    AI_REQUEST_MAX_CONTEXT_TOKENS: '131072' },
  async (_url, init) => {
    sends++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.stream, true);
    assert.deepEqual(JSON.parse(body.messages[1].content).proposals, candidates);
    if (shopText !== undefined) assert.deepEqual(JSON.parse(body.messages[1].content).inputs[0].shopText, shopText);
    if (hang) return new Response(new ReadableStream({
      start(controller) { init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true }); },
    }));
    const bytes = new TextEncoder().encode([
      `data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(0, 5) } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(5) }, finish_reason: finish }] })}\n\n`,
      'data: [DONE]\n\n',
    ].join(''));
    return new Response(new ReadableStream({ start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 17) controller.enqueue(bytes.slice(offset, offset + 17));
      controller.close();
    } }));
  });
  return { call, sends: () => sends };
}

test('one review request judges several products and labels, preserving true candidates and refusing to correct false ones', async () => {
  const state = setup();
  const result = await state.call(job, new AbortController().signal);
  assert.equal(state.sends(), 1);
  assert.equal(result.tagExtractionStage, 'review');
  const byId = new Map(result.tagExtractionItems!.map(item => [item.productId, item]));
  assert.deepEqual(byId.get(11n)!.tags, [{ proposalIndex: 0, name: bill.name, value: bill.value, evidence: [{ path: bill.path, quote: bill.quote }] }]);
  assert.deepEqual(byId.get(11n)!.rejectedTags.map(tag => [tag.name, tag.reasonCode]), [['2fa', 'review_rejected']]);
  assert.deepEqual(byId.get(12n)!.tags, []);
  assert.equal(byId.get(12n)!.rejectedTags[0]!.value, '30 days', 'false must not produce a corrected 1 month tag');
  assert.ok(result.tagExtractionItems!.every(item => item.reviewed));
  assert.deepEqual(byId.get(11n)!.reviewDecisions, [true, false]);
  assert.deepEqual(byId.get(12n)!.reviewDecisions, [false]);
  assert.equal(byId.get(11n)!.rejectedTags[0]!.proposalIndex, 1);
});

for (const [name, content] of [
  ['invalid JSON', '{"items":'],
  ['missing textReview', JSON.stringify({ items: [{ id: '11', decisions: [true, false] }, review.items[0]] })],
  ['added tags', JSON.stringify({ items: [{ id: '11', decisions: [true, false], tags: [duration] }, review.items[0]] })],
  ['missing products', JSON.stringify({ items: [review.items[0]] })],
  ['unknown products', JSON.stringify({ items: [{ id: '99', decisions: [true], textReview: null }, review.items[1]] })],
  ['missing label votes', JSON.stringify({ items: [review.items[0], { id: '11', decisions: [true], textReview: null }] })],
  ['extra label votes', JSON.stringify({ items: [review.items[0], { id: '11', decisions: [true, false, true] }] })],
  ['non-boolean votes', JSON.stringify({ items: [review.items[0], { id: '11', decisions: ['yes', false] }] })],
]) {
  test(`a batch with ${name} fails closed without extra calls`, async () => {
    const state = setup(content);
    await assert.rejects(state.call(job, new AbortController().signal), error =>
      Reflect.get(error as object, 'retryClass') === 'invalid_response' && Reflect.get(error as object, 'requestOutcome') === 'confirmed');
    assert.equal(state.sends(), 1);
  });
}

test('truncated and unfinished batches never publish partial votes', async () => {
  for (const finish of ['length', null]) {
    const state = setup(JSON.stringify(review), finish);
    await assert.rejects(state.call(job, new AbortController().signal));
    assert.equal(state.sends(), 1);
  }
});

const text = { unitId: 'shared-unit', name: '完整商品标题', description: '正文。'.repeat(5000) + '末尾说明交付账号', hash: 'a'.repeat(64) };
const textReview = {
  answers: Object.fromEntries(DISCLOSURE_KEYS.map(key => [key, { value: null, reason: '适用范围不明确', evidence: [] }])),
  consistency: Object.fromEntries(CONSISTENCY_KEYS.map(key => [key, { value: false, reason: '完整原文未发现冲突', evidence: [] }])),
};
const fullReview = { ...textReview, answers: { ...textReview.answers,
  L2: { value: true, reason: '正文末尾明确交付形式', evidence: [{ field: 'description', quote: '末尾说明交付账号' }] } } };

test('full frozen title/body review survives fragmented SSE without altering binary votes or unknowns', async () => {
  const output = { items: [review.items[0], { ...review.items[1], textReview: fullReview }] };
  const state = setup(JSON.stringify(output), 'stop', 1000, false, text);
  const result = await state.call(job, new AbortController().signal);
  const item = result.tagExtractionItems!.find(item => item.productId === 11n)!;
  assert.deepEqual(item.textReview, fullReview);
  assert.deepEqual(item.reviewDecisions, [true, false]);
  assert.equal(item.tags.length, 1);
  assert.equal(state.sends(), 1);
});

test('text review runs even when both products have zero proposed tags', async () => {
  const candidates = { items: proposals.items.map(item => ({ ...item, tags: [] })) };
  const output = { items: [{ id: '11', decisions: [], textReview: fullReview }, { id: '12', decisions: [], textReview: null }] };
  const state = setup(JSON.stringify(output), 'stop', 1000, false, text, candidates);
  const result = await state.call(job, new AbortController().signal);
  assert.deepEqual(result.tagExtractionItems![0]!.textReview, fullReview);
  assert.deepEqual(result.tagExtractionItems!.map(item => item.tags), [[], []]);
});

test('missing, unknown-shaped, uncited and fabricated text reviews reject the entire completed response', async () => {
  const badReviews = [null, undefined, { ...textReview, answers: {} },
    { ...textReview, answers: { ...textReview.answers, L1: { value: true, reason: '无引文', evidence: [] } } },
    { ...textReview, answers: { ...textReview.answers, L1: { value: true, reason: '错误字段引文', evidence: [{ field: 'name', quote: '末尾说明交付账号' }] } } },
    { ...textReview, consistency: { ...textReview.consistency, C1: { value: true, reason: '单侧无法证明冲突', evidence: [{ field: 'name', quote: '完整商品标题' }] } } },
  ];
  for (const textReview of badReviews) {
    const output = { items: [review.items[0], { ...review.items[1], textReview }] };
    const state = setup(JSON.stringify(output), 'stop', 1000, false, text);
    await assert.rejects(state.call(job, new AbortController().signal), error => Reflect.get(error as object, 'retryClass') === 'invalid_response');
    assert.equal(state.sends(), 1);
  }
  const absentSource = setup(JSON.stringify({ items: [review.items[0], { ...review.items[1], textReview }] }));
  await assert.rejects(absentSource.call(job, new AbortController().signal));
});

test('batch review timeout and cancellation stop the shared stream without resending', async () => {
  const timeout = setup('', 'stop', 20, true);
  await assert.rejects(timeout.call(job, new AbortController().signal), /timed out/u);
  assert.equal(timeout.sends(), 1);
  const cancelled = setup('', 'stop', 1000, true);
  const controller = new AbortController();
  const result = cancelled.call(job, controller.signal);
  const timer = setTimeout(() => controller.abort(new Error('cancel review')), 20);
  try { await assert.rejects(result, /cancel review/u); } finally { clearTimeout(timer); }
  assert.equal(cancelled.sends(), 1);
});
