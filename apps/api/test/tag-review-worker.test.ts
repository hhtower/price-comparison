import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpenAiModelCall } from '../src/ai/ai.worker.js';
import { buildTagExtractionOutcome } from '../src/ai/tag-extraction-result.js';
import { CONSISTENCY_KEYS, DISCLOSURE_KEYS } from '../src/shops/shop-text-review.js';

const bill = { name: 'supported_client', value: 'codex' };
const twoFactor = { name: 'region', value: 'us' };
const duration = { name: 'duration', value: 30 };
const proposals = { items: [{ id: '11', tags: [bill, twoFactor] }, { id: '12', tags: [duration] }] };
const review = { items: [{ id: '12', accepted: [false], complete: false }, { id: '11', accepted: [true, false], complete: true }] };
const job = { id: 7n, row: { job_id: 3n, job_type: 'tag_extraction', step: 'request' } };

function setup(content = JSON.stringify(review), finish: string | null = 'stop', timeout = 1000, hang = false, shopText?: unknown, candidates = proposals, jobType = 'tag_extraction', stage = 'review', previousDecisions?: any[]) {
  let sends = 0;
  const call = createOpenAiModelCall({
    getTagExtractionBatchInputs: async () => ({ jobId: 3n, model: 'mock', stage, proposals: candidates, previousDecisions,
      inputs: [
        { productId: 11n, name: '商品甲', spec: '', sourceData: { evidence: '建议使用美区IP。\n支持Codex。' },
          ...(shopText === undefined ? {} : { payload: { name: '商品甲', spec: '', sourceData: { evidence: '建议使用美区IP。\n支持Codex。' }, shopText } }) },
        { productId: 12n, name: '商品乙', spec: '1个月', sourceData: {} },
      ] }),
  } as never, { AI_BASE_URL: 'https://mock.invalid/v1', AI_API_KEY: 'mock', AI_MODEL: 'mock', AI_TIMEOUT_MS: String(timeout),
    AI_REQUEST_MAX_CONTEXT_TOKENS: '131072' },
  async (_url, init) => {
    sends++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.stream, true);
    if (jobType === 'tag_extraction' && stage === 'review') assert.deepEqual(JSON.parse(body.messages[1].content).proposals, candidates);
    const sent = JSON.parse(body.messages[1].content);
    if (jobType === 'text_review' && shopText !== undefined) assert.deepEqual(sent[0].shopText, shopText);
    if (jobType === 'tag_extraction' && stage === 'review') assert.equal(Object.hasOwn(sent.inputs[0], 'shopText'), false);
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
  return { call: (_job: typeof job, signal: AbortSignal) => call({ ..._job, row: { ..._job.row, job_type: jobType } }, signal), sends: () => sends };
}

test('one review request judges several products and labels, preserving true candidates and refusing to correct false ones', async () => {
  const state = setup();
  const result = await state.call(job, new AbortController().signal);
  assert.equal(state.sends(), 1);
  assert.equal(result.tagExtractionStage, 'review');
  const byId = new Map(result.tagExtractionItems!.map(item => [item.productId, item]));
  assert.deepEqual(byId.get(11n)!.tags, [{ proposalIndex: 0, name: bill.name, value: bill.value, evidence: [] }]);
  assert.deepEqual(byId.get(11n)!.rejectedTags.map(tag => [tag.name, tag.reasonCode]), [['region', 'review_rejected']]);
  assert.deepEqual(byId.get(12n)!.tags, []);
  assert.equal(byId.get(12n)!.rejectedTags[0]!.value, 30, 'false must not produce a corrected 1 month tag');
  assert.ok(result.tagExtractionItems!.every(item => item.reviewed));
  assert.deepEqual(byId.get(11n)!.reviewDecisions, [true, false]);
  assert.deepEqual(byId.get(12n)!.reviewDecisions, [false]);
  assert.equal(byId.get(11n)!.rejectedTags[0]!.proposalIndex, 1);
  assert.equal(byId.get(11n)!.complete, true);
  assert.equal(byId.get(12n)!.complete, false);
  assert.equal(Object.hasOwn(byId.get(11n)!, 'textReview'), false);
});

for (const [name, content] of [
  ['invalid JSON', '{"items":'],
  ['missing completeness', JSON.stringify({ items: [{ id: '11', accepted: [true, false] }, review.items[0]] })],
  ['added tags', JSON.stringify({ items: [{ ...review.items[1], tags: [duration] }, review.items[0]] })],
  ['missing products', JSON.stringify({ items: [review.items[0]] })],
  ['unknown products', JSON.stringify({ items: [{ id: '99', accepted: [true], complete: true }, review.items[1]] })],
  ['missing label votes', JSON.stringify({ items: [review.items[0], { id: '11', accepted: [true], complete: true }] })],
  ['extra label votes', JSON.stringify({ items: [review.items[0], { ...review.items[1], accepted: [true, false, true] }] })],
  ['non-boolean votes', JSON.stringify({ items: [review.items[0], { ...review.items[1], accepted: ['yes', false] }] })],
  ['duplicate IDs', JSON.stringify({ items: [review.items[0], review.items[0]] })],
  ['coupled text review', JSON.stringify({ items: [review.items[0], { ...review.items[1], textReview: null }] })],
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

test('tag review ignores captured shop text and succeeds without requesting fourteen text judgments', async () => {
  const state = setup(JSON.stringify(review), 'stop', 1000, false, text);
  const result = await state.call(job, new AbortController().signal);
  assert.equal(state.sends(), 1);
  assert.ok(result.tagExtractionItems!.every(item => !Object.hasOwn(item, 'textReview')));
  assert.deepEqual(result.tagExtractionItems!.find(item => item.productId === 11n)!.reviewDecisions, [true, false]);
});

test('independent full title/body review survives fragmented SSE without generating tag decisions', async () => {
  const output = { items: [{ id: '12', textReview: null }, { id: '11', textReview: fullReview }] };
  const state = setup(JSON.stringify(output), 'stop', 1000, false, text, proposals, 'text_review', 'extract');
  const result = await state.call(job, new AbortController().signal);
  const item = result.tagExtractionItems!.find(item => item.productId === 11n)!;
  assert.deepEqual(item.textReview, fullReview);
  assert.equal(item.reviewDecisions, undefined);
  assert.deepEqual(item.tags, []);
  assert.deepEqual(item.rejectedTags, []);
  assert.equal(result.tagExtractionStage, 'extract');
  assert.equal(state.sends(), 1);
});

test('text review runs even when both products have zero proposed tags', async () => {
  const candidates = { items: proposals.items.map(item => ({ ...item, tags: [] })) };
  const output = { items: [{ id: '11', textReview: fullReview }, { id: '12', textReview: null }] };
  const state = setup(JSON.stringify(output), 'stop', 1000, false, text, candidates, 'text_review', 'extract');
  const result = await state.call(job, new AbortController().signal);
  assert.deepEqual(result.tagExtractionItems![0]!.textReview, fullReview);
  assert.deepEqual(result.tagExtractionItems!.map(item => item.tags), [[], []]);
});

test('text review rejects missing, foreign and duplicate product IDs before returning any decisions', async () => {
  for (const items of [
    [{ id: '11', textReview: fullReview }],
    [{ id: '11', textReview: fullReview }, { id: '99', textReview: null }],
    [{ id: '11', textReview: fullReview }, { id: '11', textReview: fullReview }],
  ]) {
    const state = setup(JSON.stringify({ items }), 'stop', 1000, false, text, proposals, 'text_review', 'extract');
    await assert.rejects(state.call(job, new AbortController().signal), error =>
      Reflect.get(error as object, 'retryClass') === 'invalid_response');
    assert.equal(state.sends(), 1);
  }
});

test('missing, unknown-shaped, uncited and fabricated text reviews reject the entire completed response', async () => {
  const badReviews = [null, undefined, { ...textReview, answers: {} },
    { ...textReview, answers: { ...textReview.answers, L1: { value: true, reason: '无引文', evidence: [] } } },
    { ...textReview, answers: { ...textReview.answers, L1: { value: true, reason: '错误字段引文', evidence: [{ field: 'name', quote: '末尾说明交付账号' }] } } },
    { ...textReview, consistency: { ...textReview.consistency, C1: { value: true, reason: '单侧无法证明冲突', evidence: [{ field: 'name', quote: '完整商品标题' }] } } },
  ];
  for (const textReview of badReviews) {
    const output = { items: [{ id: '12', textReview: null }, { id: '11', textReview }] };
    const state = setup(JSON.stringify(output), 'stop', 1000, false, text, proposals, 'text_review', 'extract');
    await assert.rejects(state.call(job, new AbortController().signal), error => Reflect.get(error as object, 'retryClass') === 'invalid_response'
      && Reflect.get(error as object, 'responseMetadata').responseDiagnostic.code === 'text_review_invalid');
    assert.equal(state.sends(), 1);
  }
  const absentSource = setup(JSON.stringify({ items: [{ id: '12', textReview: null }, { id: '11', textReview }] }), 'stop', 1000, false, undefined, proposals, 'text_review', 'extract');
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


for (const jobType of ['tag_extraction', 'text_review']) test(jobType + ' extraction rejects truncation, invalid output and aborts stalled streams', async () => {
  const valid = jobType === 'text_review' ? { items: [{ id: '11', textReview: null }, { id: '12', textReview: null }] }
    : { items: [{ id: '11', tags: [] }, { id: '12', tags: [] }] };
  for (const [content, finish] of [[JSON.stringify(valid), 'length'], [JSON.stringify(valid), null], ['{', 'stop']] as const) {
    const state = setup(content, finish, 1000, false, undefined, proposals, jobType, 'extract');
    await assert.rejects(state.call(job, new AbortController().signal), error => finish === null ? /missing finish reason/u.test(String(error)) : Reflect.get(error as object, 'retryClass') === 'invalid_response');
    assert.equal(state.sends(), 1);
  }
  const timeout = setup('', 'stop', 20, true, undefined, proposals, jobType, 'extract');
  await assert.rejects(timeout.call(job, new AbortController().signal), /timed out/u);
  assert.equal(timeout.sends(), 1);
  const cancelled = setup('', 'stop', 1000, true, undefined, proposals, jobType, 'extract');
  const controller = new AbortController();
  const pending = cancelled.call(job, controller.signal);
  const timer = setTimeout(() => controller.abort(new Error('cancel extraction')), 20);
  try { await assert.rejects(pending, /cancel extraction/u); } finally { clearTimeout(timer); }
  assert.equal(cancelled.sends(), 1);
});

test('repair generation emits only new candidates and review merges previous successes without revoting', async () => {
  const previous = [{ productId: 11n, tags: [{ name: 'supported_client', value: 'codex', evidence: [], proposalIndex: 0 }],
    rejectedTags: [{ name: 'region', value: 'us', evidence: [], proposalIndex: 1, reasonCode: 'review_rejected', reason: 'Rejected' }],
    reviewed: true, reviewDecisions: [true, false], complete: false }];
  const candidates = { items: [{ id: '11', tags: [{ name: 'duration', value: 30 }] }, { id: '12', tags: [] }] };
  const extracted = await setup(JSON.stringify(candidates), 'stop', 1000, false, undefined, candidates, 'tag_extraction', 'repair', previous)
    .call(job, new AbortController().signal);
  assert.equal(extracted.tagExtractionStage, 'repair');
  assert.deepEqual(extracted.tagExtractionItems![0]!.tags.map(tag => tag.name), ['duration']);
  const result = await setup(JSON.stringify({ items: [{ id: '11', accepted: [true], complete: true }, { id: '12', accepted: [], complete: true }] }),
    'stop', 1000, false, undefined, candidates, 'tag_extraction', 'review', previous).call(job, new AbortController().signal);
  const merged = result.tagExtractionItems![0]!;
  assert.deepEqual(merged.tags.map(tag => tag.name), ['supported_client', 'duration']);
  assert.equal(merged.complete, true);
  assert.equal(merged.attempts!.length, 2);
});

test('streamed generation and all-true review preserve a valid sibling when a candidate fails business validation', async () => {
  for (const [invalid, reasonCode] of [
    [{ name: 'region', value: 'not_a_region' }, 'tag_value_invalid'],
    [{ name: 'unknown_dimension', value: 'some_value' }, 'tag_name_unknown'],
    [{ name: 'duration', value: 0 }, 'tag_value_invalid'],
    [{ name: 'duration', value: { kind: 'range', min: 90, max: 30 } }, 'tag_value_invalid'],
  ] as const) {
    const response = { items: [{ id: '11', tags: [bill, invalid] }, { id: '12', tags: [] }] };
    const generation = setup(JSON.stringify(response), 'stop', 1000, false, undefined, proposals, 'tag_extraction', 'extract');
    const extracted = await generation.call(job, new AbortController().signal);
    assert.equal(generation.sends(), 1);
    assert.deepEqual(extracted.tagExtractionItems![0]!.tags.map(({ name, value }) => ({ name, value })), [bill, invalid]);
    assert.deepEqual(extracted.tagExtractionItems![0]!.rejectedTags, []);
    const candidates = { items: extracted.tagExtractionItems!.map(item => ({
      id: String(item.productId), tags: item.tags.map(({ name, value }) => ({ name, value })),
    })) };
    const review = setup(JSON.stringify({ items: [
      { id: '11', accepted: [true, true], complete: true }, { id: '12', accepted: [], complete: true },
    ] }), 'stop', 1000, false, undefined, candidates);
    const result = await review.call(job, new AbortController().signal);
    assert.equal(review.sends(), 1);
    const decision = result.tagExtractionItems!.find(item => item.productId === 11n)!;
    assert.deepEqual(decision.tags.map(({ name, value }) => ({ name, value })), [bill]);
    assert.deepEqual(decision.reviewDecisions, [true, true]);
    assert.equal(decision.rejectedTags[0]!.reasonCode, reasonCode);
    assert.equal(decision.rejectedTags[0]!.proposalIndex, 1);
    const outcome = buildTagExtractionOutcome(decision, []);
    assert.equal(outcome.outcome, 'partial_success');
    assert.equal(outcome.successfulCount, 1);
    assert.equal(outcome.failedCount, 1);
    assert.deepEqual(outcome.after, [bill]);
  }
});
