import assert from 'node:assert/strict';
import test from 'node:test';
import { parseStandardizationProtocolResponse, standardizationProtocolSchema } from '../src/ai/ai.schemas.js';
import { validateStandardizationEvidence } from '../src/ai/standardization-evidence.js';

const inputs = [{ id: '1', candidateStandardProductIds: ['91'], candidateRefs: { i1c1: '91' } }];
const evidence = [{ path: 'name', quote: 'ChatGPT Plus' }];
const common = { id: '1', evidence, ruleIds: [], reason: 'Explicit offer' };
const candidate = { id: '91', family: 'openai', product: 'chatgpt', tier: 'plus', aliases: [] };

test('identity decisions and schema contain no tag field', () => {
  for (const action of [
    { action: 'reuse_candidate', candidateRef: 'i1c1' },
    { action: 'create_identity', identity: { family: 'openai', product: 'chatgpt', tier: 'plus', evidence, reason: 'Explicit plan' } },
  ]) {
    const parsed = parseStandardizationProtocolResponse({ items: [{ ...common, ...action }] }, inputs);
    assert.equal(parsed.items[0]?.status, 'classified');
    assert.equal('tags' in parsed.items[0]!, false);
  }
  assert.doesNotMatch(JSON.stringify(standardizationProtocolSchema(inputs)), /"tags"|"warranty_scope"/u);
});

test('first-stage validation returns only identity evidence', () => {
  const parsed = parseStandardizationProtocolResponse({ items: [{ ...common, action: 'reuse_candidate', candidateRef: 'i1c1' }] }, inputs);
  const result = validateStandardizationEvidence(parsed, [{ id: '1', payload: { name: 'ChatGPT Plus' } }], [candidate]);
  assert.equal(result.items[0]?.status, 'classified');
  assert.equal('tags' in result.items[0]!, false);
  assert.equal(result.items[0]?.diagnostic, undefined);
});
