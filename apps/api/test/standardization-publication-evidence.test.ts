import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseStandardizationProtocolResponse } from '../src/ai/ai.schemas.js';
import { validateStandardizationEvidence } from '../src/ai/standardization-evidence.js';

const candidate = { id: '91', family: 'openai', product: 'chatgpt', tier: 'plus', aliases: [] };
for (const standardProductId of ['91', null]) {
  test(`boundary does not reinterpret warranty and delivery attributes for ${standardProductId ?? 'unmatched'}`, () => {
    const payload = { name: 'ChatGPT Plus 账号 首登质保2小时',
      sourceData: { evidence: '提供Plus账号密码2FA。仅质保下单后1小时内首次登录。' } };
    const inputs = [{ id: '1', payload, candidateStandardProductIds: ['91'] }];
    const parsed = parseStandardizationProtocolResponse({ items: [{
      id: '1', standardProductId, evidence: [{ path: 'name', quote: payload.name }],
    }] }, inputs);
    const validated = validateStandardizationEvidence(parsed, inputs, [candidate]);
    assert.equal(validated, parsed);
    assert.equal(validated.items[0]!.reasonCode, standardProductId ? null : 'unmatched');
    assert.equal(validated.items[0]!.diagnostic, undefined);
  });
}
