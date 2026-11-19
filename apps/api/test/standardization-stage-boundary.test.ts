import assert from 'node:assert/strict';
import test from 'node:test';
import { parseStandardizationProtocolResponse, standardizationProtocolSchema } from '../src/ai/ai.schemas.js';
import { validateStandardizationEvidence } from '../src/ai/standardization-evidence.js';

const inputs = [{ id: '1', candidateStandardProductIds: ['91'] }];
const evidence = [{ path: 'name', quote: 'ChatGPT Plus' }];
const common = { id: '1', evidence };
const candidate = { id: '91', family: 'openai', product: 'chatgpt', tier: 'plus', aliases: [] };

test('match-only decisions and schema contain no identity creation or tag fields', () => {
  for (const standardProductId of ['91', null]) {
    const parsed = parseStandardizationProtocolResponse({ items: [{ ...common, standardProductId }] }, inputs);
    assert.equal(parsed.items[0]?.status, standardProductId ? 'classified' : 'unclassified');
    assert.equal('tags' in parsed.items[0]!, false);
  }
  assert.doesNotMatch(JSON.stringify(standardizationProtocolSchema(inputs)), /"tags"|"warranty_scope"|"identity"|"action"|"reason"|"ruleIds"/u);
  assert.throws(() => parseStandardizationProtocolResponse({ items: [{
    ...common, action: 'create_identity', identity: { family: 'openai', product: 'chatgpt', tier: 'plus' },
  }] }, inputs));
});

test('first-stage validation returns only identity evidence', () => {
  const parsed = parseStandardizationProtocolResponse({ items: [{ ...common, standardProductId: '91' }] }, inputs);
  const result = validateStandardizationEvidence(parsed, [{ ...inputs[0]!, payload: { name: 'ChatGPT Plus' } }], [candidate]);
  assert.equal(result.items[0]?.status, 'classified');
  assert.equal('tags' in result.items[0]!, false);
  assert.equal(result.items[0]?.diagnostic, undefined);
});
