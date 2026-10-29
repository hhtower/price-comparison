import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTagExtractionRequest, parseTagExtractionResponse, TAG_EXTRACTION_PROTOCOL_VERSION, type TagExtractionInput } from '../src/ai/tag-extraction-request.js';
import { validateTagExtractionDecision } from '../src/ai/tag-extraction-result.js';
import { buildExtractionPayload } from '../src/ai/adaptive-batching.js';
import { PURCHASE_GUIDE_FIELDS } from '@price-comparison/catalog/purchase-guide-content';
import type { JsonValue } from '../src/database/types.js';
import { EVIDENCE_VALIDATION_VERSION, PIPELINE_VERSIONS, pipelineVersionSnapshot, isCurrentPipeline, assertCurrentPipeline } from '../src/ai/pipeline-versions.js';

test('current validation accepts new tasks and expires previous validation snapshots', () => {
  assert.equal(EVIDENCE_VALIDATION_VERSION, 'evidence-identity-publication-20261025-v11');
  const current = pipelineVersionSnapshot('mock');
  assert.equal(isCurrentPipeline(current), true);
  const job = { prompt_version: PIPELINE_VERSIONS.prompt, rule_version: PIPELINE_VERSIONS.identityPolicy, pipeline_versions: current };
  assert.doesNotThrow(() => assertCurrentPipeline(job));
  const previous = { ...PIPELINE_VERSIONS, validation: 'evidence-identity-publication-20261024-v9' };
  assert.equal(isCurrentPipeline(previous), false);
  assert.throws(() => assertCurrentPipeline({ ...job, pipeline_versions: previous }), { code: 'AI_POLICY_STALE' });
});

test('tag prompt examples survive the same citation and business validation as worker responses', () => {
  const prompt = buildTagExtractionRequest([], 'mock').messages[0]!.content;
  const blocks = [...prompt.matchAll(/```json\n([\s\S]*?)\n```/gu)];
  assert.equal(blocks.length, 2, 'one complete input/output example');
  const inputs = JSON.parse(blocks[0]![1]!) as TagExtractionInput[];
  const response = parseTagExtractionResponse(blocks[1]![1]!);
  assert.deepEqual(response.items.map(item => item.id), inputs.map(item => item.id));
  for (const item of response.items) {
    const input = inputs.find(input => input.id === item.id)!;
    const payload = buildExtractionPayload({ ...input, sourceData: input.sourceData as JsonValue });
    const proposed = item.tags.map(({ name, value, path, quote }) => ({ name, value, evidence: [{ path, quote }] }));
    const validated = validateTagExtractionDecision(BigInt(item.id), proposed, payload);
    assert.deepEqual(validated.rejectedTags, [], item.id);
    assert.deepEqual(validated.tags, proposed, item.id);
  }
  assert.deepEqual(response.items.map(item => item.tags.map(tag => [tag.name, tag.value])), [
    [['duration', '1 month'], ['renewable', '无']],
    [['supported_client', 'sub2api'], ['usage_restriction', '禁止反代']],
    [['warranty', 'covered'], ['warranty_scope', 'first_login'], ['warranty_window', '24 hours'], ['warranty_exclusion', 'ban']],
    [],
    [['duration', '12 months']],
    [['delivery_mode', 'manual']],
  ]);
  assert.notEqual(inputs[4]!.name, inputs[4]!.spec, 'example distinguishes general title from selected SKU');
  assert.equal(response.items[4]!.tags[0]!.path, 'spec');
  assert.equal(response.items[5]!.tags[0]!.quote, (inputs[5]!.sourceData as { evidence: string }).evidence, 'short evidence keeps the delivery action');
});

 test('tag JSON contract rejects structural corruption while leaving vocabulary checks to individual decisions', () => {
  const tag = { name: 'duration', value: '1 month', path: 'spec', quote: '1个月' };
  for (const payload of [
    { items: [], extra: true }, { items: [{ id: '1', tags: [], extra: true }] },
    { items: [{ id: '1', tags: [{ ...tag, extra: true }] }] },
    { items: [{ id: '1', tags: [] }, { id: '1', tags: [] }] },
  ]) assert.throws(() => parseTagExtractionResponse(JSON.stringify(payload)));
});
 test('compact context preserves every shared field, applicability and canonical constraint', () => {
  const built = buildTagExtractionRequest([], 'deepseek-flash');
  assert.deepEqual(built.responseFormat, { type: 'json_object' });
  const prompt = built.messages[0]!.content;
  const groups = JSON.parse(prompt.match(/<tag_vocabulary>\n([\s\S]*?)\n<\/tag_vocabulary>/u)![1]!);
  const fields = groups.flatMap((group: { appliesTo: string; fields: object[] }) =>
    group.fields.map(field => ({ ...field, appliesTo: group.appliesTo })));
  assert.deepEqual(fields.sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)),
    Object.entries(PURCHASE_GUIDE_FIELDS).map(([name, field]) => ({ name, meaning: field.label, appliesTo: field.appliesTo, ...field.rule }))
      .sort((a, b) => a.name.localeCompare(b.name)));
  assert.ok(prompt.length < 18000, 'retain the full vocabulary and complete warranty conditions within the compact context budget');
  assert.ok(!prompt.includes(PURCHASE_GUIDE_FIELDS.delivery.explanation));
});

test('product-scoped prompt expires v5 while retaining the per-tag protocol', () => {
  assert.equal(PIPELINE_VERSIONS.tagPrompt, 'tag-20261025-v7');
  assert.equal(PIPELINE_VERSIONS.tagReviewPrompt, 'tag-review-20261027-v3');
  assert.equal(TAG_EXTRACTION_PROTOCOL_VERSION, 'tag-json-object-per-tag-20261023-v2');
  assert.equal(isCurrentPipeline({ ...pipelineVersionSnapshot('mock'), tagPrompt: 'tag-20261015-v5' }), false);
  assert.equal(isCurrentPipeline({ ...pipelineVersionSnapshot('mock'), tagProtocol: 'tag-json-object-closed-v1' }), false);
});
