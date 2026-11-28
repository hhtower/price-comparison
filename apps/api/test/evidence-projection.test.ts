import { jsonObject } from './json-object.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildExtractionPayload } from '../src/ai/adaptive-batching.js';
import { buildTagExtractionRequest, type TagExtractionInput } from '../src/ai/tag-extraction-request.js';
import { buildMembershipFeatureRequest, buildMembershipFeatureReviewRequest } from '../src/ai/membership-feature-request.js';
import { buildProductTextReviewRequest } from '../src/ai/product-text-review-request.js';
import * as projections from '../src/ai/evidence-projection.js';
import { validateStandardizationEvidence, validateTagCitations } from '../src/ai/standardization-evidence.js';
import { parseStandardizationProtocolResponse } from '../src/ai/ai.schemas.js';
import { parseStandardizationReviewResponse } from '../src/ai/standardization-review-request.js';

const captured = (name: string, description: string) => ({
  unitId: 'listing', name, description, hash: 'a'.repeat(64),
});
const tagInput = (payload: ReturnType<typeof buildExtractionPayload>): TagExtractionInput & { shopText?: unknown } => ({
  ...payload, id: String(payload.id), name: String(payload.name),
});

test('standardization cannot cite duplicate capture paths removed from its actual request', () => {
  const body = 'Only the selected item, no subscription.';
  const payload = buildExtractionPayload({ id: '7', name: 'Unknown', spec: '',
    sourceData: { evidence: body, ratingText: captured('Unknown', body) } });
  const request = { model: 'mock', candidates: [], inputs: [{ productId: 7n, payload, candidateStandardProductIds: [] }] };
  const protocol = [{ id: '7', candidateStandardProductIds: [] }];
  const parse = (path: string) => parseStandardizationProtocolResponse({ items: [
    { id: '7', standardProductId: null, nullReason: 'insufficient_source', evidence: [{ path, quote: body }] },
  ] }, protocol);
  const inputs = [{ ...protocol[0]!, payload }];
  assert.ok(payload.shopText);
  assert.equal(projections.projectSemanticEvidence(payload).shopText, undefined);
  assert.throws(() => validateStandardizationEvidence(parse('shopText.description'), inputs, []), /证据路径/);
  const valid = validateStandardizationEvidence(parse('sourceData.evidence'), inputs, []);
  assert.throws(() => parseStandardizationReviewResponse(JSON.stringify({ items: [
    { id: '7', approved: false, code: 'insufficient_source', evidence: [{ path: 'shopText.description', quote: body }] },
  ] }), valid, request), /证据路径/);
});

test('all semantic tasks retain differing captured title and complete body after membership drops shopText', () => {
  const title = 'Original title: not a shared account';
  const body = 'Account delivery.\n'.repeat(2000) + 'Only the selected plan; no ban coverage, contact within one hour.';
  const source = Object.freeze({ ratingText: Object.freeze(captured(title, body)), evidence: 'Short normalized body' });
  const payload = buildExtractionPayload({ id: '7', name: 'Account', spec: 'monthly', sourceData: source });
  const frozen = structuredClone(payload);
  assert.deepEqual(payload.originalText, { name: title, description: body.trim() });
  const tags = JSON.parse(buildTagExtractionRequest([tagInput(payload)], 'mock').messages[1]!.content)[0];
  assert.deepEqual(tags.originalText, { name: title, description: body.trim() });

  const { shopText: _shopText, ...membership } = tagInput(payload);
  const requests = [
    buildMembershipFeatureRequest([membership], 'mock'),
    buildMembershipFeatureReviewRequest([membership], { items: [{ id: '7', refs: [0], membershipKind: 'account' }] }, 'mock'),
  ];
  for (const request of requests) {
    const lines = JSON.parse(request.messages[1]!.content).inputs[0].lines;
    assert(lines.some((line: { path: string; text: string }) => line.path === 'originalText.name' && line.text === title));
    assert.equal(lines.filter((line: { path: string }) => line.path === 'originalText.description')
      .map((line: { text: string }) => line.text).join('\n'), body.trim());
  }
  const review = JSON.parse(buildProductTextReviewRequest([tagInput(payload)], 'mock').messages[1]!.content)[0];
  assert.deepEqual(review.shopText, captured(title, body.trim()));
  assert.deepEqual(payload, frozen);
});

test('canonical captured evidence redacts credentials before entering tag or membership requests', () => {
  const raw = captured('Account password: private-title',
    'Only selected plan.\nhttps://user:private-url@api.invalid/v1?token=private-query\nBearer private-bearer\nNo ban coverage.');
  const payload = buildExtractionPayload({ id: '7', name: 'Account', spec: '', sourceData: { ratingText: raw } });
  assert.deepEqual(payload.originalText, {
    name: 'Account password: [redacted]',
    description: 'Only selected plan.\nhttps://api.invalid/v1\nBearer [redacted]\nNo ban coverage.',
  });
  for (const request of [
    buildTagExtractionRequest([tagInput(payload)], 'mock'),
    buildMembershipFeatureRequest([tagInput(payload)], 'mock'),
  ]) {
    assert.doesNotMatch(request.messages[1]!.content, /private-(title|url|query|bearer)/u);
    assert.match(request.messages[1]!.content, /No ban coverage/u);
  }
  assert.deepEqual(payload.shopText, raw, 'raw captured text remains available to independent text review');
});

test('identical captured evidence adds no duplicate semantic leaves', () => {
  const payload = buildExtractionPayload({ id: '1', name: 'Account', description: 'No ban coverage.', spec: '',
    sourceData: { ratingText: captured('Account', 'No ban coverage.') } });
  assert.equal(payload.originalText, undefined);
  assert.deepEqual(payload.shopText, captured('Account', 'No ban coverage.'));
});

test('membership transport excludes nested credentials without dropping source conditions', () => {
  const input = { id: '1', name: 'Account', sourceData: {
    evidence: 'Only selected plan.\nNo ban coverage.',
    selected: { password: 'private-password', API_key: 'private-key', warranty: 'First login only.' },
  } };
  const content = buildMembershipFeatureRequest([input], 'mock').messages[1]!.content;
  assert.doesNotMatch(content, /private-password|private-key/u);
  assert.match(content, /No ban coverage/u);
  assert.match(content, /First login only/u);
});

test('semantic transport removes only complete equal captured fields and keeps canonical citation paths', () => {
  assert.equal(typeof projections.projectSemanticEvidence, 'function');
  const body = 'Only selected plan.\nNo ban coverage.';
  const payload = { id: '1', name: 'Account', sourceData: { evidence: body, selected: ['monthly'] },
    shopText: captured('Account', body) };
  const frozen = structuredClone(payload);
  const semantic = projections.projectSemanticEvidence(payload);
  assert.deepEqual(semantic, { id: '1', name: 'Account', sourceData: { evidence: body, selected: ['monthly'] } });
  assert.deepEqual(payload, frozen);
  assert.notEqual(semantic.sourceData, payload.sourceData);
  assert.deepEqual(projections.projectSemanticEvidence(semantic), semantic);

  for (const different of [body + '\nExcept this SKU.', body.replace('\n', ' '), body.toLowerCase()]) {
    const distinct = projections.projectSemanticEvidence({ ...payload, shopText: captured('Account', different) });
    assert.deepEqual(distinct.shopText, { description: different });
    assert.equal(jsonObject(distinct.sourceData).evidence, body);
  }
  const distinctTitle = projections.projectSemanticEvidence({ ...payload, shopText: captured('Account: NOT shared', body) });
  assert.deepEqual(distinctTitle.shopText, { name: 'Account: NOT shared' });
});

test('semantic transport uses frozen safe alternatives without exposing raw secrets or changing text review', () => {
  assert.equal(typeof projections.projectSemanticEvidence, 'function');
  const raw = captured('Account password: private-title', 'No ban coverage.\nBearer private-bearer');
  const payload = buildExtractionPayload({ id: '1', name: 'Account', spec: '', sourceData: { ratingText: raw } });
  const frozen = structuredClone(payload);
  const semantic = projections.projectSemanticEvidence(payload);
  assert.equal(semantic.shopText, undefined);
  assert.deepEqual(semantic.originalText, {
    name: 'Account password: [redacted]', description: 'No ban coverage.\nBearer [redacted]',
  });
  assert.doesNotMatch(JSON.stringify(semantic), /private-title|private-bearer/u);
  const assertOriginalLeaves = (value: unknown, original: unknown) => {
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        assertOriginalLeaves(child, (original as Record<string, unknown>)[key]);
      }
    } else assert.equal(value, original);
  };
  assertOriginalLeaves(semantic, frozen);
  assert.doesNotThrow(() => validateTagCitations([
    { path: 'originalText.name', quote: 'Account password: [redacted]' },
    { path: 'originalText.description', quote: 'No ban coverage.\nBearer [redacted]' },
  ], payload));
  assert.deepEqual(JSON.parse(buildProductTextReviewRequest([tagInput(payload)], 'mock').messages[1]!.content),
    [{ id: '1', shopText: raw }]);
  assert.deepEqual(payload, frozen);
});

test('semantic transport rejects unfrozen sensitive captures instead of leaking or inventing citation paths', () => {
  const payload = { id: '1', name: 'Account', shopText: captured('Account', 'password: private-password\nNo ban coverage.') };
  const frozen = structuredClone(payload);
  assert.throws(() => projections.projectSemanticEvidence(payload), /frozen sanitized captured text/u);
  assert.deepEqual(payload, frozen);
});

test('explicitly empty captured body remains complete for review after independent projections', () => {
  const payload = buildExtractionPayload({ id: '1', name: 'Account', description: 'Other source body', spec: '',
    sourceData: { ratingText: captured('Account', '') } });
  const semantic = projections.projectSemanticEvidence(payload);
  assert.equal(semantic.shopText, undefined);
  assert.deepEqual(semantic.originalText, { description: '' });
  buildTagExtractionRequest([tagInput(payload)], 'mock');
  buildMembershipFeatureRequest([tagInput(payload)], 'mock');
  assert.deepEqual(JSON.parse(buildProductTextReviewRequest([tagInput(payload)], 'mock').messages[1]!.content),
    [{ id: '1', shopText: captured('Account', '') }]);
});
