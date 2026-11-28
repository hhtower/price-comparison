import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTagExtractionRequest, parseTagExtractionResponse, TAG_EXTRACTION_PROTOCOL_VERSION, type TagExtractionInput } from '../src/ai/tag-extraction-request.js';
import * as tagRequests from '../src/ai/tag-extraction-request.js';
import { buildMembershipFeatureRequest } from '../src/ai/membership-feature-request.js';
import { PURCHASE_GUIDE_FIELDS } from '@price-comparison/catalog/purchase-guide-content';
import { EVIDENCE_VALIDATION_VERSION, PIPELINE_VERSIONS, pipelineVersionSnapshot, isCurrentPipeline, assertCurrentPipeline } from '../src/ai/pipeline-versions.js';

test('current validation accepts new tasks and expires previous validation snapshots', () => {
  assert.equal(EVIDENCE_VALIDATION_VERSION, 'match-only-boundary-20261119-v1');
  const current = pipelineVersionSnapshot('mock');
  assert.equal(isCurrentPipeline(current, 'manual_full'), true);
  const job = { job_type: 'manual_full' as const, prompt_version: PIPELINE_VERSIONS.prompt, rule_version: PIPELINE_VERSIONS.standardizationPolicy, pipeline_versions: current };
  assert.doesNotThrow(() => assertCurrentPipeline(job));
  const previous = { ...PIPELINE_VERSIONS, validation: 'evidence-identity-publication-20261024-v9' };
  assert.equal(isCurrentPipeline(previous, 'manual_full'), false);
  assert.throws(() => assertCurrentPipeline({ ...job, pipeline_versions: previous }), { code: 'AI_POLICY_STALE' });
});

test('tag prompt examples use the same sparse canonical protocol as worker responses', () => {
  const prompt = buildTagExtractionRequest([], 'mock').messages[0]!.content;
  const blocks = [...prompt.matchAll(/```json\n([\s\S]*?)\n```/gu)];
  assert.equal(blocks.length, 2, 'one complete input/output example');
  const inputs = JSON.parse(blocks[0]![1]!) as TagExtractionInput[];
  const response = parseTagExtractionResponse(blocks[1]![1]!);
  assert.deepEqual(response.items.map(item => item.id), inputs.map(item => item.id));
  assert.deepEqual(response.items.map(item => item.tags.map(tag => [tag.name, tag.value])), [
    [['duration', 30], ['subscription_override', '无']],
    [['supported_client', 'sub2api']],
    [],
    [['duration', 30]],
    [['bulk_purchase', 'bundle']],
  ]);
  assert.notEqual(inputs[3]!.name, inputs[3]!.spec, 'explicit title duration wins over conflicting specification');

});

test('tag JSON contract rejects structural corruption and duplicate product IDs', () => {
  const tag = { name: 'duration', value: 30 };
  for (const payload of [
    { items: [], extra: true }, { items: [{ id: '1', tags: [], extra: true }] },
    { items: [{ id: '1', tags: [{ ...tag, extra: true }] }] },
    { items: [{ id: '1', tags: [] }, { id: '1', tags: [] }] },
  ]) assert.throws(() => parseTagExtractionResponse(JSON.stringify(payload)));
});
test('compact context preserves only general fields with their applicability and canonical constraints', () => {
  const built = buildTagExtractionRequest([], 'mock');
  assert.equal(built.model, 'mock');
  assert.deepEqual(built.responseFormat, { type: 'json_object' });
  const prompt = built.messages[0]!.content;
  const groups = JSON.parse(prompt.match(/<tag_vocabulary>\n([\s\S]*?)\n<\/tag_vocabulary>/u)![1]!);
  const fields = groups.flatMap((group: { appliesTo: string; fields: object[] }) =>
    group.fields.map(field => ({ ...field, appliesTo: group.appliesTo })));
  assert.deepEqual(fields.sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)),
    Object.entries(PURCHASE_GUIDE_FIELDS)
      .filter(([name]) => !['subscription_warranty', 'usage_warranty', 'warranty_terms'].includes(name))
      .map(([name, field]) => ({ name, meaning: field.label, appliesTo: field.appliesTo, ...field.rule }))
      .sort((a, b) => a.name.localeCompare(b.name)));
  assert.deepEqual(groups, tagRequests.TAG_SCHEMA);
  assert.ok(prompt.length < 10000, 'keep the general vocabulary and rules compact');
  assert.equal(fields.length, 7);
  assert.doesNotMatch(prompt, /subscription_warranty|usage_warranty|warranty_terms|warrantyEvidence/u);
});

test('general prompt and protocol expire snapshots that included warranty extraction', () => {
  const current = pipelineVersionSnapshot('mock');
  assert.ok(current && typeof current === 'object' && !Array.isArray(current));
  assert.equal(PIPELINE_VERSIONS.tagPrompt, 'tag-20261121-v18');
  assert.equal(PIPELINE_VERSIONS.tagReviewPrompt, 'tag-review-20261121-v14');
  assert.equal(TAG_EXTRACTION_PROTOCOL_VERSION, 'tag-json-typed-values-20261117-v7');
  assert.equal(isCurrentPipeline({ ...current, tagPrompt: 'tag-20261015-v5' }, 'tag_extraction'), false);
  assert.equal(isCurrentPipeline({ ...current, tagPrompt: 'tag-20261025-v7' }, 'tag_extraction'), false);
  assert.equal(isCurrentPipeline({ ...current, tagProtocol: 'tag-json-object-closed-v1' }, 'tag_extraction'), false);
  assert.equal(isCurrentPipeline({ ...current, tagPrompt: 'tag-20261114-v10' }, 'tag_extraction'), false);
  assert.equal(isCurrentPipeline({ ...current, tagReviewPrompt: 'tag-review-20261114-v6' }, 'tag_extraction'), false);
  assert.equal(isCurrentPipeline({ ...current, tagPrompt: 'tag-20261115-v16' }, 'tag_extraction'), false);
  assert.equal(isCurrentPipeline({ ...current, tagReviewPrompt: 'tag-review-20261115-v12' }, 'tag_extraction'), false);
  assert.equal(isCurrentPipeline({ ...current, tagProtocol: 'tag-json-typed-values-20261115-v6' }, 'tag_extraction'), false);
});


test('generation accepts sparse canonical name/value facts and rejects legacy citation fields', () => {
  const value = { items: [{ id: '1', tags: [{ name: 'duration', value: 30 }] }, { id: '2', tags: [] }] };
  assert.deepEqual(parseTagExtractionResponse(JSON.stringify(value)), value);
  for (const extra of [{ path: 'spec' }, { quote: '1 month' }, { reason: 'supported' }]) {
    assert.throws(() => parseTagExtractionResponse(JSON.stringify({ items: [{ id: '1', tags: [{ name: 'duration', value: 30, ...extra }] }] })));
  }
});

test('generation preserves business-invalid candidates for independent per-tag rejection', () => {
  const tags = [
    { name: 'supported_client', value: 'codex' },
    { name: 'region', value: 'not_a_region' },
    { name: 'unknown_dimension', value: 'some_value' },
    { name: 'duration', value: 0 },
    { name: 'duration', value: -1 },
    { name: 'duration', value: 36501 },
    { name: 'duration', value: { kind: 'range', min: 90, max: 30 } },
    { name: 'duration', value: { kind: 'min', days: 0 } },
    { name: 'duration', value: { kind: 'max', days: -1 } },
    { name: 'duration', value: { kind: 'approx', days: 36501 } },
    { name: 'unknown_dimension', value: { kind: 'permanent' } },
  ];
  const response = { items: [{ id: '1', tags }] };
  assert.deepEqual(parseTagExtractionResponse(JSON.stringify(response)), response);
});

test('generation still rejects malformed, oversized and unsupported wire values as a whole batch', () => {
  const valid = { name: 'supported_client', value: 'codex' };
  for (const invalid of [
    { name: 'duration' }, { value: 30 }, { name: '', value: 30 }, { name: 'x'.repeat(251), value: 30 },
    ...[null, true, [], {}, '', ' ', 'x'.repeat(251),
      { kind: 'unknown' }, { kind: 'range', min: 1 }, { kind: 'range', min: '1', max: 3 },
      { kind: 'min', days: null }, { kind: ['min'], days: 1 }, { kind: 'max', days: 1, extra: true },
      { kind: 'permanent', days: 1 }].map(value => ({ name: 'duration', value })),
  ]) {
    assert.throws(() => parseTagExtractionResponse(JSON.stringify({ items: [{ id: '1', tags: [valid, invalid] }] })));
  }
  assert.throws(() => parseTagExtractionResponse('{"items":'));
  assert.throws(() => parseTagExtractionResponse('{"items":[{"id":"1","tags":[{"name":"duration","value":1e400}]}]}'));
});

test('general requests preserve raw source conditions while responses reject every warranty field', () => {
  const inputs = [{ id: '1', name: '账号', description: '一次性商品，不退不换。\n交付后一小时内无法使用可联系处理;封禁不退',
    sourceData: { details: '须在交付后一小时内联系，核实后处理。', warranty_info: '封禁不退' } }];
  const before = structuredClone(inputs);
  assert.deepEqual(JSON.parse(buildTagExtractionRequest(inputs, 'mock').messages[1]!.content), before);
  for (const name of ['subscription_warranty', 'usage_warranty', 'warranty_terms']) {
    const output = { items: [{ id: '1', tags: [{ name: 'duration', value: 30 }, { name, value: 'source promise' }] }] };
    assert.throws(() => parseTagExtractionResponse(JSON.stringify(output)), /invalid items or tags/u);
  }
  assert.deepEqual(inputs, before);
});

test('tag projection preserves full raw conditions but excludes operational data without changing membership input', () => {
  const input = { id: '1', name: 'Account', spec: 'selected', category: 'AI', description: 'body\n'.repeat(5000),
    evidence: 'original evidence', details: { limitation: 'only selected SKU', price: 8 }, warranty: 'first login only; no ban cover',
    sourceData: { evidence: 'second original body', content: 'full content', warranty_info: 'within one hour',
      selectedOptions: [{ name: 'duration', value: 'one month', stock: 4, access_token: 'secret' }],
      price: 42, stock: 9, ratingText: { name: 'rating' }, 'API-Key': 'secret', authorization: 'secret' },
    shopText: { name: 'rating' }, taskId: 'task', price: 99, inventory: 10 };
  const before = structuredClone(input);
  assert.equal(typeof tagRequests.projectTagInput, 'function');
  const projected = tagRequests.projectTagInput(input);
  const sent = JSON.parse(buildTagExtractionRequest([projected], 'mock').messages[1]!.content)[0];
  assert.equal(sent.description, input.description);
  assert.equal(sent.evidence, 'original evidence');
  assert.equal(sent.warranty, input.warranty);
  assert.deepEqual(sent.details, { limitation: 'only selected SKU' });
  assert.equal(sent.sourceData.evidence, 'second original body');
  assert.equal(sent.sourceData.content, 'full content');
  assert.equal(sent.sourceData.warranty_info, 'within one hour');
  assert.deepEqual(sent.sourceData.selectedOptions, [{ name: 'duration', value: 'one month' }]);
  for (const key of ['shopText', 'taskId', 'price', 'inventory']) assert.equal(Object.hasOwn(sent, key), false);
  for (const key of ['price', 'stock', 'ratingText', 'API-Key', 'authorization']) assert.equal(Object.hasOwn(sent.sourceData, key), false);
  const featureLines = JSON.parse(buildMembershipFeatureRequest([input], 'mock').messages[1]!.content).inputs[0].lines;
  for (const text of ['second original body', 'full content', 'within one hour', 'one month']) {
    assert(featureLines.some((line: { text: string }) => line.text === text));
  }
  assert.deepEqual(input, before);
});
