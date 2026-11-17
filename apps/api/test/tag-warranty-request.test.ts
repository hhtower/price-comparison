import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTagWarrantyRequest, parseWarrantyResponse, TAG_WARRANTY_PROMPT_VERSION,
  WARRANTY_PROMPT, WARRANTY_TAG_NAMES, warrantyTags, type WarrantyLabels,
} from '../src/ai/tag-warranty-request.js';

const absent: WarrantyLabels = {
  subscription_warranty: null, subscription_warranty_t: null,
  usage_warranty: null, usage_warranty_t: null,
};

test('parser accepts every valid duration/type pair independently for both warranties', () => {
  const subscriptionPairs = [
    [null, null], [null, 'unspecified'], [0.125, 'hour'], [48, 'hour'], [1.3333, 'day'],
  ] as const;
  const usagePairs = [...subscriptionPairs, [null, 'first_login']] as const;
  for (const [subscription_warranty, subscription_warranty_t] of subscriptionPairs) {
    for (const [usage_warranty, usage_warranty_t] of usagePairs) {
      const labels = { subscription_warranty, subscription_warranty_t, usage_warranty, usage_warranty_t };
      assert.deepEqual(parseWarrantyResponse(JSON.stringify(labels)), labels);
    }
  }
});

test('parser requires exactly the four fields on a single object', () => {
  for (const value of [null, [], true, 1, 'text', {}, [absent],
    { items: [absent] }, { ...absent, id: '1' }, { ...absent, explanation: '' }]) {
    assert.throws(() => parseWarrantyResponse(JSON.stringify(value)));
  }
  for (const key of Object.keys(absent)) {
    const missing = { ...absent } as Record<string, unknown>;
    delete missing[key];
    assert.throws(() => parseWarrantyResponse(JSON.stringify(missing)), /exactly four warranty fields/);
    assert.throws(() => parseWarrantyResponse(JSON.stringify({ ...missing, extra: null })),
      /exactly four warranty fields/);
  }
});

test('parser rejects invalid units and mismatched durations for either warranty', () => {
  for (const name of ['subscription_warranty', 'usage_warranty'] as const) {
    for (const unit of ['minute', 'month', 'DAY', '', false, 1, [], {}]) {
      assert.throws(() => parseWarrantyResponse(JSON.stringify({ ...absent, [`${name}_t`]: unit })),
        /invalid duration unit/);
    }
    for (const unit of ['hour', 'day']) {
      for (const value of [null, 0, -1, '6', false, [], {}]) {
        assert.throws(() => parseWarrantyResponse(JSON.stringify({ ...absent, [name]: value, [`${name}_t`]: unit })),
          /positive finite duration required/);
      }
      const overflow = JSON.stringify({ ...absent, [name]: 'OVERFLOW', [`${name}_t`]: unit })
        .replace('"OVERFLOW"', '1e400');
      assert.throws(() => parseWarrantyResponse(overflow), /positive finite duration required/);
    }
    for (const unit of [null, 'unspecified']) {
      for (const value of [0, 6, '6', false, [], {}]) {
        assert.throws(() => parseWarrantyResponse(JSON.stringify({ ...absent, [name]: value, [`${name}_t`]: unit })),
          /absence or unspecified duration requires null/);
      }
    }
  }
  assert.throws(() => parseWarrantyResponse(JSON.stringify({ ...absent, subscription_warranty_t: 'first_login' })),
    /first-login value requires usage label/);
  for (const value of [0, 6, '6', false]) {
    assert.throws(() => parseWarrantyResponse(JSON.stringify({
      ...absent, usage_warranty: value, usage_warranty_t: 'first_login',
    })), /first login requires null duration/);
  }
});

test('parser accepts a sole JSON fence and rejects truncation, commentary and multiple objects', () => {
  const json = JSON.stringify(absent);
  for (const content of [` \n${json}\n `, `\`\`\`json\n${json}\n\`\`\``,
    ` \n\`\`\`\r\n${json}\r\n\`\`\`\n `, `\`\`\`json \t\n${json}\n\`\`\``]) {
    assert.deepEqual(parseWarrantyResponse(content), absent);
  }
  for (const content of ['', '{', json.slice(0, -1), `${json}\n${json}`, `Result: ${json}`,
    `\`\`\`json\n${json}\n\`\`\`\nExplanation`, `Before\n\`\`\`json\n${json}\n\`\`\``,
    `\`\`\`json\n${json}\n\`\`\`\n\`\`\`json\n${json}\n\`\`\``,
    `\`\`\`javascript\n${json}\n\`\`\``]) {
    assert.throws(() => parseWarrantyResponse(content), SyntaxError);
  }
});

test('tags use literal positive formats in subscription then usage order without conversion', () => {
  const cases: Array<{ labels: WarrantyLabels; tags: Array<{ name: string; value: string; evidence: [] }> }> = [
    { labels: absent, tags: [] },
    {
      labels: { ...absent, subscription_warranty: 6, subscription_warranty_t: 'hour',
        usage_warranty: 1.3333, usage_warranty_t: 'day' },
      tags: [
        { name: 'subscription_warranty', value: '质保 6 小时', evidence: [] },
        { name: 'usage_warranty', value: '质保 1.3333 天', evidence: [] },
      ],
    },
    {
      labels: { ...absent, subscription_warranty: 30, subscription_warranty_t: 'day',
        usage_warranty: 48, usage_warranty_t: 'hour' },
      tags: [
        { name: 'subscription_warranty', value: '质保 30 天', evidence: [] },
        { name: 'usage_warranty', value: '质保 48 小时', evidence: [] },
      ],
    },
    {
      labels: { ...absent, subscription_warranty_t: 'unspecified', usage_warranty_t: 'first_login' },
      tags: [
        { name: 'subscription_warranty', value: '质保（期限未注明）', evidence: [] },
        { name: 'usage_warranty', value: '首登', evidence: [] },
      ],
    },
    {
      labels: { ...absent, usage_warranty_t: 'unspecified' },
      tags: [{ name: 'usage_warranty', value: '质保（期限未注明）', evidence: [] }],
    },
    {
      labels: { ...absent, subscription_warranty: 0.125, subscription_warranty_t: 'hour' },
      tags: [{ name: 'subscription_warranty', value: '质保 0.125 小时', evidence: [] }],
    },
  ];
  for (const { labels, tags } of cases) {
    const before = structuredClone(labels);
    assert.deepEqual(warrantyTags(labels), tags);
    assert.deepEqual(warrantyTags(labels), tags);
    assert.deepEqual(labels, before);
  }
});

test('request uses the caller model and the exact projected single-product envelope', () => {
  const description = 'Synthetic offer.\nSelected option only.\n'.repeat(200);
  const input = { id: '101', name: 'Synthetic membership', spec: 'Selected option', category: 'membership',
    description, evidence: 'Synthetic evidence', details: { text: 'Complete details', stock: 2 },
    warranty: { text: 'Complete warranty', price: 10 },
    sourceData: { evidence: 'Complete source', nested: [{ text: 'Keep', sales: 9 }], stock: 4 },
    shopText: 'Omit shop data', price: 12 };
  const before = structuredClone(input);
  for (const model of ['caller-model-a', 'caller-model-b']) {
    const request = buildTagWarrantyRequest([input], model);
    assert.deepEqual(request, {
      model,
      messages: [
        { role: 'system', content: WARRANTY_PROMPT },
        { role: 'user', content: JSON.stringify({ inputs: [{
          id: '101', name: 'Synthetic membership', spec: 'Selected option', category: 'membership',
          description, details: { text: 'Complete details' }, warranty: { text: 'Complete warranty' },
          evidence: 'Synthetic evidence',
          sourceData: { evidence: 'Complete source', nested: [{ text: 'Keep' }] },
        }] }) },
      ],
      temperature: 0.2,
      responseFormat: { type: 'json_object' },
      maxOutputTokens: 8192,
    });
  }
  assert.deepEqual(input, before);
});

test('request rejects empty and multi-product batches and isolates successive single products', () => {
  const first = { id: '101', name: 'First synthetic product', evidence: 'FIRST_ONLY' };
  const second = { id: '102', name: 'Second synthetic product', evidence: 'SECOND_ONLY' };
  for (const inputs of [[], [first, second], [first, first]]) {
    assert.throws(() => buildTagWarrantyRequest(inputs, 'caller-model'), /exactly one product/);
  }
  const firstRequest = buildTagWarrantyRequest([first], 'caller-model');
  const secondRequest = buildTagWarrantyRequest([second], 'caller-model');
  assert.deepEqual(JSON.parse(firstRequest.messages[1]!.content), { inputs: [first] });
  assert.deepEqual(JSON.parse(secondRequest.messages[1]!.content), { inputs: [second] });
});

test('prompt retains exactly the five approved examples with valid four-field outputs', () => {
  const examples = [...WARRANTY_PROMPT.matchAll(/^Product: (.+)\r?\nOutput: (.+)$/gmu)]
    .map(([, product, output]) => ({ product, labels: parseWarrantyResponse(output!) }));
  assert.deepEqual(examples, [
    { product: '订阅质保30天。', labels: { ...absent, subscription_warranty: 30, subscription_warranty_t: 'day' } },
    { product: '质保首登，收货后6小时内验号。', labels: { ...absent, usage_warranty_t: 'first_login' } },
    { product: '双保6小时。', labels: {
      subscription_warranty: 6, subscription_warranty_t: 'hour', usage_warranty: 6, usage_warranty_t: 'hour',
    } },
    { product: '会员有效期30天，遇到问题请联系客服。', labels: absent },
    { product: '本次会员充值有官方账单。', labels: { ...absent, subscription_warranty_t: 'unspecified' } },
  ]);
  assert.match(TAG_WARRANTY_PROMPT_VERSION, /20261117/);
  assert.deepEqual(WARRANTY_TAG_NAMES, new Set(['subscription_warranty', 'usage_warranty', 'warranty_terms']));
});
