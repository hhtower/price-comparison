import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStandardizationProtocolResponse, standardizationProtocolSchema, StandardizationValidationError } from '../src/ai/ai.schemas.js';

const evidence = [{ path: 'name', quote: 'ChatGPT Plus 1个月合租' }];
const identity = { family: 'OpenAI', product: 'ChatGPT', tier: 'Plus', reason: '名称明确写明 ChatGPT Plus', evidence };
const classifiedItem = {
  id: '101', action: 'create_identity', identity,
  ruleIds: ['chatgpt-plus-default'], evidence, reason: '商品名称和规格支持该判断',
};
const input = { id: '101', candidateStandardProductIds: [], candidateRefs: {} };

test('citation whitespace is normalized while identity fields and other control characters stay strict', () => {
  const quote = 'ChatGPT\tPlus\r\n1个月合租';
  const multiline = [{ path: 'name', quote }];
  const item = { ...classifiedItem, evidence: multiline, identity: { ...identity, evidence: multiline } };
  const parsed = parseStandardizationProtocolResponse({ items: [item] }, [input]);
  assert.equal(parsed.items[0]?.status, 'classified');
  assert.equal(parsed.items[0]?.evidence[0]?.quote, 'ChatGPT Plus 1个月合租');
  for (const invalid of ['ChatGPT\u0000Plus', 'ChatGPT\u001bPlus', 'ChatGPT\u007fPlus', 'x'.repeat(1001)]) {
    assert.equal(parseStandardizationProtocolResponse({ items: [{ ...item, evidence: [{ path: 'name', quote: invalid }] }] }, [input]).items[0]?.reasonCode, 'invalid_response');
  }
  assert.equal(parseStandardizationProtocolResponse({ items: [{ ...item, identity: { ...identity, family: 'Open\nAI' } }] }, [input]).items[0]?.reasonCode, 'invalid_response');
  assert.equal(parseStandardizationProtocolResponse({ items: [{ ...item, evidence: [{ path: 'na\nme', quote }] }] }, [input]).items[0]?.reasonCode, 'invalid_response');
});

test('response schema permits omissions so the program can identify missing IDs', () => {
  const schema = standardizationProtocolSchema([input, { ...input, id: '102' }]) as any;
  assert.equal(schema.properties.items.minItems, undefined);
  assert.equal(schema.properties.items.maxItems, 2);
  assert.deepEqual(schema.properties.items.items.anyOf[0].properties.id.enum, ['101', '102']);
});

test('normalizes identity whitespace', () => {
  const parsed = parseStandardizationProtocolResponse({ items: [{ ...classifiedItem,
    identity: { ...identity, product: ' Ｃｈａｔ  GPT ' },
  }] }, [input]);
  assert.equal(parsed.items[0]?.status, 'classified');
  assert.deepEqual([parsed.identities[0]?.family, parsed.identities[0]?.product, parsed.identities[0]?.tier], ['openai', 'chatgpt', 'plus']);
});

test('field diagnostics distinguish missing and extra keys without retaining response values', () => {
  const { identity: _omitted, ...missing } = classifiedItem;
  const parsed = parseStandardizationProtocolResponse({ items: [{ ...missing, confidence: 'private-response-value' }] }, [input]);
  assert.equal(parsed.items[0]?.reasonCode, 'invalid_response');
  assert.match(parsed.items[0]!.reason, /缺少.*identity/);
  assert.match(parsed.items[0]!.reason, /多余.*confidence/);
  assert.doesNotMatch(parsed.items[0]!.reason, /private-response-value/);
  assert.equal(parsed.items[0]?.diagnostic?.stage, 'schema');
  assert.doesNotMatch(JSON.stringify(parsed.items[0]?.diagnostic), /private-response-value/);
});

test('candidate ref diagnostics distinguish wrong type, empty and excessive length', () => {
  const { identity: _identity, ...common } = classifiedItem;
  for (const [candidateRef, expected] of [[null, /类型.*null/], ['', /空/], ['x'.repeat(31), /长度.*31.*30/]] as const) {
    const parsed = parseStandardizationProtocolResponse({ items: [{ ...common, action: 'reuse_candidate', candidateRef }] }, [input]);
    assert.equal(parsed.items[0]?.reasonCode, 'invalid_response');
    assert.match(parsed.items[0]!.reason, expected);
  }
});

test('unexpected field names cannot inject control characters or unbounded diagnostics', () => {
  const malformed = { ...classifiedItem, ['x\n' + 'z'.repeat(2000)]: 'private' };
  const parsed = parseStandardizationProtocolResponse({ items: [malformed] }, [input]);
  assert.ok(parsed.items[0]!.reason.length < 1000);
  assert.doesNotMatch(parsed.items[0]!.reason, /[\u0000-\u001f\u007f]/u);
  const manyEscapedFields = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [String(index) + '"'.repeat(60), null]));
  const bounded = parseStandardizationProtocolResponse({ items: [{ id: '101', action: 'create_identity', ...manyEscapedFields }] }, [input]);
  assert.ok(bounded.items[0]!.reason.length <= 1000);
});

test('global diagnostics do not copy unknown or duplicate ID values into saved reasons', () => {
  const secretItem = { ...classifiedItem, id: 'private-response-value' };
  for (const [items, inputs] of [
    [[secretItem], [input]],
    [[secretItem, secretItem], [{ ...input, id: secretItem.id }, input]],
  ] as const) {
    assert.throws(() => parseStandardizationProtocolResponse({ items }, inputs), (error: Error) => {
      assert.doesNotMatch(error.message, /private-response-value/);
      return true;
    });
  }
});

test('parses inline identities, candidate references, unclassified items and missing IDs in input order', () => {
  const { identity: _identity, ...common } = classifiedItem;
  const parsed = parseStandardizationProtocolResponse({ items: [
    { id: '103', action: 'insufficient_evidence', ruleIds: [], evidence: [], reason: '缺少产品和套餐证据' },
    { ...common, id: '102', action: 'reuse_candidate', candidateRef: 'i2c1', ruleIds: [] },
    { ...classifiedItem, id: '105', identity: { ...identity, tier: 'Team' } },
    classifiedItem,
  ] }, [
    input, { id: '102', candidateStandardProductIds: ['42'], candidateRefs: { i2c1: '42' } },
    { ...input, id: '103' }, { ...input, id: '104' }, { ...input, id: '105' },
  ]);
  assert.deepEqual(parsed.missingIds, ['104']);
  assert.equal(parsed.identities.length, 2);
  assert.deepEqual(parsed.items.map(item => [item.id, item.status, item.identity?.kind]), [
    ['101', 'classified', 'new'], ['102', 'classified', 'existing'],
    ['103', 'unclassified', undefined], ['105', 'classified', 'new'],
  ]);
});

test('rejects duplicate or unknown response IDs and duplicate input IDs before deriving omissions', () => {
  const inputs = [input, { ...input, id: '102' }];
  assert.throws(() => parseStandardizationProtocolResponse({ items: [classifiedItem, classifiedItem] }, inputs), /重复.*ID/);
  assert.throws(() => parseStandardizationProtocolResponse({ items: [{ ...classifiedItem, id: '999' }] }, inputs), /未知.*ID/);
  assert.throws(() => parseStandardizationProtocolResponse({ items: [] }, [input, input]), /ID.*重复/);
});

test('isolates invalid identities and unavailable candidate IDs to their item', () => {
  const { identity: _identity, ...common } = classifiedItem;
  const parsed = parseStandardizationProtocolResponse({ items: [
    { ...classifiedItem, identity: { ...identity, product: '' } },
    { ...common, id: '102', action: 'reuse_candidate', candidateRef: 'i2c1' },
  ] }, [input, { id: '102', candidateStandardProductIds: ['42'], candidateRefs: { i2c1: '77' } }]);
  assert.deepEqual(parsed.items.map(item => [item.id, item.status, item.reasonCode]), [
    ['101', 'unclassified', 'invalid_response'], ['102', 'unclassified', 'invalid_response'],
  ]);
  assert.deepEqual(parsed.missingIds, []);
});

test('current protocol retains business field, evidence, duplicate and length validation', () => {
  for (const invalid of [
    { identity: { ...identity, product: 'x'.repeat(251) } },
    { ruleIds: ['same', 'same'] }, { ruleIds: ['x'.repeat(101)] },
    { evidence: [{ path: 'name', quote: 'private\u0000value' }] },
    { evidence: [{ path: 'name', quote: 'x', unexpected: true }] },
    { evidence: Array.from({ length: 51 }, () => evidence[0]) },
    { reason: 'x'.repeat(1001) },
  ]) {
    const parsed = parseStandardizationProtocolResponse({ items: [{ ...classifiedItem, ...invalid }] }, [input]);
    assert.equal(parsed.items[0]?.reasonCode, 'invalid_response');
    assert.equal(parsed.identities.length, 0);
  }
});

test('well-formed but invalid identity values are distinct from response structure failures', () => {
  const parsed = parseStandardizationProtocolResponse({ items: [{ ...classifiedItem, identity: { ...identity, tier: 'pro' } }] }, [input]);
  assert.equal(parsed.items[0]?.reasonCode, 'identity_conflict');
  assert.equal(parsed.items[0]?.diagnostic?.code, 'invalid_identity');
  assert.deepEqual(parsed.items[0]?.diagnostic?.proposedIdentity, { family: 'openai', product: 'chatgpt', tier: 'pro' });
  assert.equal(parsed.identities.length, 0);
});

for (const [name, value, diagnostic, message] of [
  ['null shell', null, { code: 'invalid_type', fieldPath: '$', expectedType: 'object', actualType: 'null' }, /外壳无效/],
  ['array shell', [], { code: 'invalid_type', fieldPath: '$', expectedType: 'object', actualType: 'array' }, /外壳无效/],
  ['string shell', 'private-value', { code: 'invalid_type', fieldPath: '$', expectedType: 'object', actualType: 'string' }, /外壳无效/],
  ['missing items', {}, { code: 'missing_field', fieldPath: 'items', expectedType: 'array', actualType: 'undefined' }, /缺少字段 "items"/],
  ['null items', { items: null }, { code: 'items_type_invalid', fieldPath: 'items', expectedType: 'array', actualType: 'null' }, /items.*类型.*array.*null/],
  ['object items', { items: { 'private-key': 'private-value' } }, { code: 'items_type_invalid', fieldPath: 'items', expectedType: 'array', actualType: 'object' }, /items.*类型.*array.*object/],
  ['too many items', { items: [classifiedItem, classifiedItem] }, { code: 'items_limit_exceeded', fieldPath: 'items', actualCount: 2, maxCount: 1 }, /items.*2.*1/],
  ['null item', { items: [null] }, { code: 'invalid_type', fieldPath: 'items[0]', expectedType: 'object', actualType: 'null' }, /item 无效/],
  ['array item', { items: [[]] }, { code: 'invalid_type', fieldPath: 'items[0]', expectedType: 'object', actualType: 'array' }, /item 无效/],
  ['root extra field', { items: [], 'private-key': 'private-value' }, { code: 'unexpected_field', fieldPath: '$' }, /多余字段/],
] as const) {
  test(`global schema diagnostics describe ${name} without model content`, () => {
    assert.throws(() => parseStandardizationProtocolResponse(value, [input]), (error: unknown) => {
      assert.ok(error instanceof StandardizationValidationError);
      assert.equal(error.reasonCode, 'invalid_response');
      assert.deepEqual(error.diagnostic, { stage: 'schema', ...diagnostic });
      assert.match(error.message, message);
      assert.doesNotMatch(JSON.stringify(error.diagnostic), /private-key|private-value/);
      return true;
    });
  });
}

for (const [id, code, actualType] of [
  [undefined, 'invalid_type', 'undefined'], [null, 'invalid_type', 'null'],
  [101, 'invalid_type', 'number'], [{ secret: 'private-value' }, 'invalid_type', 'object'],
  ['', 'empty_string', undefined], ['private\nvalue', 'control_character', undefined],
  ['private-value'.repeat(3), 'string_too_long', undefined],
  ['private-value', 'item_id_unknown', undefined],
] as const) {
  test(`invalid or unknown item ID has safe diagnostics: ${code}/${actualType ?? typeof id}`, () => {
    assert.throws(() => parseStandardizationProtocolResponse({ items: [{ ...classifiedItem, id }] }, [input]), (error: unknown) => {
      assert.ok(error instanceof StandardizationValidationError);
      assert.equal(error.reasonCode, 'invalid_response');
      assert.equal(error.diagnostic.stage, 'schema');
      assert.equal(error.diagnostic.code, code);
      assert.equal(error.diagnostic.fieldPath, 'items[0].id');
      assert.equal(error.diagnostic.itemId, undefined);
      if (actualType) {
        assert.equal(error.diagnostic.expectedType, 'string');
        assert.equal(error.diagnostic.actualType, actualType);
      }
      assert.doesNotMatch(JSON.stringify(error.diagnostic), /private|secret/);
      assert.doesNotMatch(error.message, /private|secret/);
      return true;
    });
  });
}

test('duplicate response IDs identify the second occurrence using only the validated input ID', () => {
  assert.throws(() => parseStandardizationProtocolResponse({ items: [classifiedItem, { ...classifiedItem, id: ' 101 ' }] },
    [input, { ...input, id: '102' }]), (error: unknown) => {
    assert.ok(error instanceof StandardizationValidationError);
    assert.equal(error.message, 'AI 响应包含重复 ID');
    assert.deepEqual(error.diagnostic, { stage: 'schema', code: 'duplicate_item_id', fieldPath: 'items[1].id', itemId: '101' });
    return true;
  });
});

test('schema paths follow response indices while decisions and missing IDs follow input order', () => {
  const parsed = parseStandardizationProtocolResponse({ items: [
    { ...classifiedItem, id: '102' },
    { ...classifiedItem, id: ' 101 ', identity: { ...identity, tier: null } },
  ] }, [input, { ...input, id: '102' }, { ...input, id: '103' }]);
  assert.deepEqual(parsed.items.map(item => item.id), ['101', '102']);
  assert.deepEqual(parsed.items[0]?.diagnostic, { stage: 'schema', code: 'invalid_type',
    fieldPath: 'items[1].identity.tier', expectedType: 'string', actualType: 'null', itemId: '101' });
  assert.equal(parsed.items[1]?.status, 'classified');
  assert.deepEqual(parsed.identities.map(entry => entry.ref), ['i-102']);
  assert.deepEqual(parsed.missingIds, ['103']);
});

for (const [name, changes, code, fieldPath, facts] of [
  ['family type', { identity: { ...identity, family: 123 } }, 'invalid_type', 'identity.family', { expectedType: 'string', actualType: 'number' }],
  ['product type', { identity: { ...identity, product: null } }, 'invalid_type', 'identity.product', { expectedType: 'string', actualType: 'null' }],
  ['tier type', { identity: { ...identity, tier: [] } }, 'invalid_type', 'identity.tier', { expectedType: 'string', actualType: 'array' }],
  ['identity reason type', { identity: { ...identity, reason: false } }, 'invalid_type', 'identity.reason', { expectedType: 'string', actualType: 'boolean' }],
  ['item reason type', { reason: { secret: 'private-value' } }, 'invalid_type', 'reason', { expectedType: 'string', actualType: 'object' }],
  ['empty text', { reason: ' \t ' }, 'empty_string', 'reason', {}],
  ['long text', { reason: 'private-value'.repeat(100) }, 'string_too_long', 'reason', {}],
  ['control characters', { reason: 'private\u0000value' }, 'control_character', 'reason', {}],
  ['normalization overflow', { reason: '\ufdfa'.repeat(100) }, 'invalid_string', 'reason', {}],
  ['ruleIds type', { ruleIds: null }, 'invalid_type', 'ruleIds', { expectedType: 'array', actualType: 'null' }],
  ['rule ID type', { ruleIds: ['valid', 123] }, 'invalid_type', 'ruleIds[1]', { expectedType: 'string', actualType: 'number' }],
  ['duplicate rules', { ruleIds: ['private-value', 'private-value'] }, 'duplicate_value', 'ruleIds', {}],
  ['too many rules', { ruleIds: Array(51).fill('private-value') }, 'too_many_items', 'ruleIds', { actualCount: 51, maxCount: 50 }],
  ['evidence type', { evidence: {} }, 'invalid_type', 'evidence', { expectedType: 'array', actualType: 'object' }],
  ['too much evidence', { evidence: Array(51).fill(evidence[0]) }, 'too_many_items', 'evidence', { actualCount: 51, maxCount: 50 }],
  ['citation type', { evidence: [null] }, 'invalid_type', 'evidence[0]', { expectedType: 'object', actualType: 'null' }],
  ['citation path type', { evidence: [{ path: 123, quote: 'private-value' }] }, 'invalid_type', 'evidence[0].path', { expectedType: 'string', actualType: 'number' }],
  ['second quote type', { evidence: [evidence[0], { path: 'name', quote: null }] }, 'invalid_type', 'evidence[1].quote', { expectedType: 'string', actualType: 'null' }],
  ['identity evidence type', { identity: { ...identity, evidence: false } }, 'invalid_type', 'identity.evidence', { expectedType: 'array', actualType: 'boolean' }],
  ['identity quote type', { identity: { ...identity, evidence: [{ path: 'name', quote: [] }] } }, 'invalid_type', 'identity.evidence[0].quote', { expectedType: 'string', actualType: 'array' }],
  ['identity type', { identity: null }, 'invalid_type', 'identity', { expectedType: 'object', actualType: 'null' }],
  ['unknown action', { action: 'private-value' }, 'invalid_action', 'action', { expectedType: 'string', actualType: 'string' }],
  ['action type', { action: null }, 'invalid_action', 'action', { expectedType: 'string', actualType: 'null' }],
] as const) {
  test(`item schema diagnostic retains path and facts for ${name} while accepting other items`, () => {
    const parsed = parseStandardizationProtocolResponse({ items: [
      { ...classifiedItem, ...changes }, { ...classifiedItem, id: '102' },
    ] }, [input, { ...input, id: '102' }]);
    assert.equal(parsed.items[0]?.reasonCode, 'invalid_response');
    const diagnostic = parsed.items[0]!.diagnostic!;
    assert.equal(diagnostic.stage, 'schema');
    assert.equal(diagnostic.code, code);
    assert.equal(diagnostic.fieldPath, `items[0].${fieldPath}`);
    assert.equal(diagnostic.itemId, '101');
    for (const [key, expected] of Object.entries(facts)) assert.equal(Reflect.get(diagnostic, key), expected);
    assert.doesNotMatch(JSON.stringify(diagnostic), /private-value|secret/);
    assert.equal(parsed.items[1]?.status, 'classified');
    assert.deepEqual(parsed.identities.map(entry => entry.ref), ['i-102']);
    assert.deepEqual(parsed.missingIds, []);
  });
}

for (const [name, candidateRef, code, facts] of [
  ['wrong type', null, 'invalid_type', { expectedType: 'string', actualType: 'null' }],
  ['empty', '', 'empty_string', {}],
  ['too long', 'x'.repeat(31), 'string_too_long', {}],
  ['unknown', 'private-value', 'unknown_candidate_ref', {}],
  ['another item', 'i2c1', 'unknown_candidate_ref', {}],
] as const) {
  test(`candidate ref diagnostics are item-local and safe: ${name}`, () => {
    const { identity: _identity, ...common } = classifiedItem;
    const parsed = parseStandardizationProtocolResponse({ items: [{ ...common, action: 'reuse_candidate', candidateRef }] }, [
      { ...input, candidateStandardProductIds: ['42'], candidateRefs: { i1c1: '42' } },
      { ...input, id: '102', candidateStandardProductIds: ['43'], candidateRefs: { i2c1: '43' } },
    ]);
    assert.equal(parsed.items[0]?.reasonCode, 'invalid_response');
    assert.deepEqual(parsed.items[0]?.diagnostic, { stage: 'schema', code, fieldPath: 'items[0].candidateRef', ...facts, itemId: '101' });
    assert.doesNotMatch(JSON.stringify(parsed.items[0]?.diagnostic), /private-value|i2c1|42|43/);
  });
}

test('candidate mapping validation reports the public candidateRef field', () => {
  const { identity: _identity, ...common } = classifiedItem;
  for (const standardProductId of ['77', 'private-value']) {
    const parsed = parseStandardizationProtocolResponse({ items: [{ ...common, action: 'reuse_candidate', candidateRef: 'i1c1' }] },
      [{ ...input, candidateStandardProductIds: ['42'], candidateRefs: { i1c1: standardProductId } }]);
    assert.equal(parsed.items[0]?.reasonCode, 'invalid_response');
    assert.equal(parsed.items[0]?.diagnostic?.stage, 'schema');
    assert.equal(parsed.items[0]?.diagnostic?.fieldPath, 'items[0].candidateRef');
    assert.doesNotMatch(JSON.stringify(parsed.items[0]?.diagnostic), /77|private-value/);
  }
});

for (const [name, changes, code, fieldPath] of [
  ['missing action field', { action: 'reuse_candidate', identity: undefined }, 'missing_field', 'candidateRef'],
  ['extra action field', { 'private-key': 'private-value' }, 'unexpected_field', '$'],
  ['missing identity field', { identity: { family: 'OpenAI', tier: 'Plus', reason: 'identity reason', evidence } }, 'missing_field', 'identity.product'],
  ['extra identity field', { identity: { ...identity, 'private-key': 'private-value' } }, 'unexpected_field', 'identity'],
  ['missing citation field', { evidence: [{ path: 'name' }] }, 'missing_field', 'evidence[0].quote'],
  ['extra citation field', { evidence: [{ ...evidence[0], 'private-key': 'private-value' }] }, 'unexpected_field', 'evidence[0]'],
  ['missing identity citation field', { identity: { ...identity, evidence: [{ quote: 'private-value' }] } }, 'missing_field', 'identity.evidence[0].path'],
  ['extra unclassified field', { action: 'not_sellable', 'private-key': 'private-value' }, 'unexpected_field', '$'],
] as const) {
  test(`exact-key diagnostics describe ${name} without arbitrary names or values`, () => {
    const parsed = parseStandardizationProtocolResponse({ items: [{ ...classifiedItem, ...changes }] }, [input]);
    assert.equal(parsed.items[0]?.reasonCode, 'invalid_response');
    const diagnostic = parsed.items[0]!.diagnostic!;
    assert.equal(diagnostic.stage, 'schema');
    assert.equal(diagnostic.code, code);
    assert.equal(diagnostic.fieldPath, fieldPath === '$' ? 'items[0]' : `items[0].${fieldPath}`);
    assert.equal(diagnostic.itemId, '101');
    assert.doesNotMatch(JSON.stringify(diagnostic), /private-key|private-value/);
  });
}
