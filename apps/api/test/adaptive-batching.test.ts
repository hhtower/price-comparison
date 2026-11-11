import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planAdaptiveBatches, buildCandidateSearchQuery, buildExtractionPayload, estimateInputSize, extractionPayloadKey } from '../src/ai/adaptive-batching.js';
import { classifyRetryClass } from '../src/jobs/jobs.repository.js';
import { assessProductEvidence } from '../src/standardization/identity-policy.js';
import { productContentFingerprint } from '../src/standardization/fingerprint.js';
import { buildCanonicalStandardKey } from '../src/standardization/canonical-key.js';

test('input key ignores per-listing bindings but preserves every extraction field', () => {
  const payload = buildExtractionPayload({ id: '1', name: 'ChatGPT Plus', spec: 'monthly', sourceData: { evidence: 'account' } });
  const key = extractionPayloadKey(payload);
  assert.equal(extractionPayloadKey({ ...payload, id: '2', shopText: { hash: 'other' }, shopSource: { url: 'other' } }), key);
  assert.equal(extractionPayloadKey({ ...payload, category: 'different' }), key);
  for (const changed of [{ spec: 'annual' }, { sourceData: { evidence: 'recharge' } }]) {
    assert.notEqual(extractionPayloadKey({ ...payload, ...changed }), key);
  }
});

test('candidate heuristic uses frozen visible text with its block boundaries', () => {
  const payload = buildExtractionPayload({ id: '1', name: 'Gemini Pro 账号', spec: '', sourceData: { evidence: '<p><b>使用教程</b></p><p>交付 Gemini Pro 账号</p>' } });
  assert.equal(buildCandidateSearchQuery(payload).canonicalKey, buildCanonicalStandardKey({ family: 'google', product: 'gemini', tier: 'pro' }));
});

test('frozen model input projects visible HTML once at every string leaf without changing paths or source fingerprint', () => {
  const sourceData = { evidence: '<p>订阅 <strong>1个月</strong>&nbsp;可用</p><script>假套餐</script><style>.x{}</style><p>独享&amp;安全</p>' };
  const before = productContentFingerprint({ name: 'ChatGPT Plus', sourceData });
  const payload = buildExtractionPayload({ id: '1', name: 'ChatGPT Plus', spec: '&lt;b&gt;字面标签', sourceData });
  assert.equal((payload.sourceData as any).evidence, '订阅 1个月 可用\n独享&安全');
  assert.equal(payload.spec, '<b>字面标签');
  assert.equal(productContentFingerprint({ name: 'ChatGPT Plus', sourceData }), before);
  assert.equal(sourceData.evidence.includes('<strong>'), true);
  assert.equal(buildExtractionPayload({ id: '2', name: 'n', spec: '', evidence: '前文<div>正文</div>后文' }).sourceData?.evidence, '前文\n正文\n后文');
  assert.equal(buildExtractionPayload({ id: '2a', name: 'n', spec: '', description: '简介',
    sourceData: { evidence: '独立正文', content: '详情' } }).sourceData?.content, '详情 独立正文');
  assert.equal(buildExtractionPayload({ id: '2b', name: 'n', spec: '', description: '完整正文',
    sourceData: { evidence: '<p>完整<strong>正文</strong></p>' } }).sourceData?.content, undefined);
  assert.equal(buildExtractionPayload({ id: '3', name: 'n', spec: '', sourceData: { evidence: 'Use &lt;example&gt; literally' } }).sourceData?.evidence, 'Use <example> literally');
  assert.equal(buildExtractionPayload({ id: '4', name: 'n', spec: '', sourceData: { brand: '&lt;Vendor&gt;' } }).brand, '<Vendor>');
});

test('packs until byte or token budget would be exceeded', () => {
  const batches = planAdaptiveBatches([
    { productId: 1n, payload: { name: 'a' }, inputBytes: 100, estimatedTokens: 30 },
    { productId: 2n, payload: { name: 'b' }, inputBytes: 100, estimatedTokens: 30 },
    { productId: 3n, payload: { name: 'c' }, inputBytes: 100, estimatedTokens: 30 },
  ], { maxItems: 10, maxInputBytes: 250, maxInputTokens: 100 });
  assert.deepEqual(batches.map(x => x.productIds), [[1n, 2n], [3n]]);
});

test('preserves complete nested fact evidence while excluding quote and sensitive fields', () => {
  const payload = buildExtractionPayload({
    id: '1', name: 'n', spec: 'term: 1 month / access: shared / region: US / product: ChatGPT', sourceData: {
      evidence: 'e', secret: 'x', price: 10, stock: true,
    },
  });
  assert.deepEqual(payload, {
    id: '1', name: 'n', spec: 'access: shared / product: ChatGPT / region: US / term: 1 month',
    sourceData: {
      evidence: 'e',
    },
  });
});

test('model spec sanitizes credentials without mutating canonical spec or semantic casing', () => {
  const input = { id: '1', name: 'ChatGPT Plus', spec: 'Plan: Plus / password: PrivateValue / term: 1 Month' };
  const payload = buildExtractionPayload(input);
  assert.equal(payload.spec, 'Plan: Plus / password: [redacted] / term: 1 Month');
  assert.equal(input.spec, 'Plan: Plus / password: PrivateValue / term: 1 Month');
});

test('model evidence retains complete merchant context beyond the fingerprint fields', () => {
  const payload = buildExtractionPayload({ id: '1', name: ' Account ', spec: '12 months', vendor: 'Official',
    sourceData: { brand: 'Other', family: 'ChatGPT', tier: 'Plus', model: 'GPT-5', evidence: 'monthly access',
      usage_guide: 'Use your account', warranty_info: 'Subscription warranty' } });
  assert.equal(payload.vendor, 'Official');
  assert.equal(payload.brand, 'Other');
  assert.deepEqual(payload.sourceData, { brand: 'Other', family: 'ChatGPT', tier: 'Plus', model: 'GPT-5',
    evidence: 'monthly access', usage_guide: 'Use your account', warranty_info: 'Subscription warranty' });
  const oversized = buildExtractionPayload({ id: '3', name: 'n', spec: '',
    sourceData: { evidence: 'e'.repeat(16000) + ' conflict-tail' } });
  assert.equal(String((oversized.sourceData as Record<string, unknown>).evidence).endsWith('conflict-tail'), true);
  assert.deepEqual(planAdaptiveBatches([{ productId: 3n, payload: oversized, ...estimateInputSize(oversized) }],
    { maxItems: 10, maxInputBytes: 12_000, maxInputTokens: 10_000 }), []);
});

test('mixed oversized inputs are excluded from callable batches', () => {
  const limits = { maxItems: 10, maxInputBytes: 100, maxInputTokens: 100 };
  const batches = planAdaptiveBatches([
    { productId: 1n, payload: {}, inputBytes: 101, estimatedTokens: 1 },
    { productId: 2n, payload: {}, inputBytes: 10, estimatedTokens: 1 },
  ], limits);
  assert.deepEqual(batches.map((batch) => batch.productIds), [[2n]]);
});

test('classifies AI retry failures without using finish reason as success metadata', () => {
  assert.equal(classifyRetryClass('AI response timed out after 50ms'), 'network');
  assert.equal(classifyRetryClass('AI response JSON is invalid'), 'invalid_response');
  assert.equal(classifyRetryClass('network unavailable'), 'network');
  assert.equal(classifyRetryClass('requeued'), 'cancelled');
});
