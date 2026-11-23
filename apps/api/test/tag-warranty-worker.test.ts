import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpenAiModelCall } from '../src/ai/ai.worker.js';
import { buildTagExtractionOutcome } from '../src/ai/tag-extraction-result.js';

const labels = { subscription_warranty: 30, subscription_warranty_t: 'day',
  usage_warranty: null, usage_warranty_t: 'first_login' };
const job = { id: 7n, row: { job_id: 3n, job_type: 'tag_extraction', step: 'request' } };
function fixture(content = JSON.stringify(labels), finish = 'stop', hang = false, timeout = 1000, eligible = true) {
  let sends = 0;
  const call = createOpenAiModelCall({
    getTagExtractionBatchInputs: async () => ({ jobId: 3n, model: 'mock', stage: 'warranty',
      inputs: [{ productId: 11n, name: 'AI membership', spec: '', sourceData: { evidence: 'Subscription warranty' },
        payload: { warrantyEligible: eligible } }] }),
  } as never, { AI_BASE_URL: 'https://mock.invalid/v1', AI_API_KEY: 'mock', AI_MODEL: 'mock',
    AI_TIMEOUT_MS: String(timeout), AI_REQUEST_MAX_CONTEXT_TOKENS: '131072' }, async (_url, init) => {
    sends++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.stream, true);
    assert.equal(body.temperature, 0.2);
    assert.equal(JSON.parse(body.messages[1].content).inputs.length, 1);
    assert.equal(JSON.parse(body.messages[1].content).inputs[0].warrantyEligible, undefined);
    return new Response(new ReadableStream({
      start(controller) {
        const chunk = (text: string, reason?: string) => controller.enqueue(new TextEncoder().encode(
          `data: ${JSON.stringify({ choices: [{ delta: { content: text }, ...(reason ? { finish_reason: reason } : {}) }] })}\n\n`));
        chunk(content.slice(0, 9));
        if (hang) {
          init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true });
        } else {
          chunk(content.slice(9), finish);
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          controller.close();
        }
      },
    }));
  });
  return { run: (signal = new AbortController().signal) => call(job, signal), sends: () => sends };
}

test('warranty stage returns the complete four-field object through shared streaming transport', async () => {
  const state = fixture();
  const result = await state.run();
  assert.equal(state.sends(), 1);
  assert.equal(result.reviewStage, 'warranty');
  assert.deepEqual(result.tagExtractionItems, [{ productId: 11n, tags: [], rejectedTags: [], warrantyLabels: labels }]);
});

test('ineligible products never request warranty inference', async () => {
  const state = fixture(undefined, undefined, false, 1000, false);
  await assert.rejects(state.run());
  assert.equal(state.sends(), 0);
});

for (const [name, content, finish] of [
  ['malformed JSON', '{"subscription_warranty":', 'stop'],
  ['invalid duration', JSON.stringify({ ...labels, subscription_warranty: -1 }), 'stop'],
  ['extra wrapper', JSON.stringify({ items: [labels] }), 'stop'],
  ['truncation', JSON.stringify(labels), 'length'],
] as const) test(`warranty ${name} fails without a result or local retry`, async () => {
  const state = fixture(content, finish);
  await assert.rejects(state.run());
  assert.equal(state.sends(), 1);
});

test('warranty timeout and cancellation discard partial output', async () => {
  const timed = fixture(undefined, 'stop', true, 20);
  await assert.rejects(timed.run());
  assert.equal(timed.sends(), 1);
  const cancelled = fixture(undefined, 'stop', true);
  const controller = new AbortController();
  const running = cancelled.run(controller.signal);
  setTimeout(() => controller.abort(new Error('cancel warranty')), 10);
  await assert.rejects(running);
  assert.equal(cancelled.sends(), 1);
});

test('validated warranty labels publish independently of general tag review completeness', () => {
  const outcome = buildTagExtractionOutcome({ productId: 11n, tags: [], rejectedTags: [],
    reviewed: true, reviewDecisions: [], complete: false, warrantyLabels: labels }, []);
  assert.equal(outcome.outcome, 'partial_success');
  assert.deepEqual(outcome.after, [
    { name: 'subscription_warranty', value: '质保 30 天' },
    { name: 'usage_warranty', value: '首登' },
  ]);
});
