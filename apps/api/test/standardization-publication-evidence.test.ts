import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildExtractionPayload } from '../src/ai/adaptive-batching.js';
import { parseStandardizationProtocolResponse } from '../src/ai/ai.schemas.js';
import { validateStandardizationEvidence } from '../src/ai/standardization-evidence.js';

const input = { id: '1', name: 'ChatGPT Plus 账号 首登质保2小时', spec: '',
  sourceData: { evidence: '<p>提供Plus账号密码2FA。</p><p>仅质保下单后1小时内首次登录。</p>' } };
const evidence = [{ path: 'name', quote: input.name }];

for (const action of ['create_identity', 'insufficient_evidence'] as const) {
  test(`${action} on contradictory actual warranty promises remains publication review`, () => {
    const choice = action === 'create_identity' ? { identity: {
      family: 'openai', product: 'chatgpt', tier: 'plus', reason: 'Explicit account', evidence,
    } } : {};
    const parsed = parseStandardizationProtocolResponse({ items: [{
      id: '1', action, ...choice, ruleIds: [], evidence, reason: 'Source assertions',
    }] }, [{ id: '1', candidateStandardProductIds: [], candidateRefs: {} }]);
    const validated = validateStandardizationEvidence(parsed, [{ id: '1', payload: buildExtractionPayload(input) }], []);
    assert.equal(validated.items[0]?.status, 'unclassified');
    assert.equal(validated.items[0]?.reasonCode, 'publication_blocked');
    assert.equal(validated.items[0]?.diagnostic?.stage, 'publication');
    assert.deepEqual(validated.identities, []);
  });
}
