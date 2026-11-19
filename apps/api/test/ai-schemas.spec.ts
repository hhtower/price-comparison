import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStandardizationProtocolResponse, standardizationProtocolSchema, StandardizationValidationError } from '../src/ai/ai.schemas.js';

const evidence = [{ path: 'name', quote: 'ChatGPT Plus' }];
const classifiedItem = { id: '101', standardProductId: '42', evidence };
const input = { id: '101', candidateStandardProductIds: ['42'] };

test('match-only schema requires one cited match or null per input and scopes IDs to each item', () => {
  const schema = standardizationProtocolSchema([input, { id: '102', candidateStandardProductIds: [] }]) as any;
  assert.deepEqual(schema.required, ['items']);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.items.minItems, 2);
  assert.equal(schema.properties.items.maxItems, 2);
  const [matched, unmatched] = schema.properties.items.items.anyOf;
  assert.equal(matched.properties.id.const, '101');
  assert.deepEqual(matched.properties.standardProductId.enum, ['42', null]);
  assert.deepEqual(unmatched.properties.standardProductId.enum, [null]);
  assert.deepEqual(matched.required, ['id', 'standardProductId', 'evidence']);
  assert.equal(matched.additionalProperties, false);
  assert.equal(matched.properties.evidence.minItems, 1);
});

test('parses matched and unmatched decisions in input order without new identities or omissions', () => {
  const parsed = parseStandardizationProtocolResponse({ items: [
    { id: '102', standardProductId: null, evidence }, classifiedItem,
  ] }, [input, { id: '102', candidateStandardProductIds: [] }]);
  assert.deepEqual(Object.keys(parsed).sort(), ['items', 'missingIds']);
  assert.deepEqual(parsed.missingIds, []);
  assert.deepEqual(parsed.items.map(item => [item.id, item.status, item.identity, item.reasonCode]), [
    ['101', 'classified', { kind: 'existing', standardProductId: '42' }, null],
    ['102', 'unclassified', undefined, 'unmatched'],
  ]);
  assert.ok(parsed.items.every(item => item.ruleIds.length === 0));
  assert.deepEqual(parsed.items.map(item => item.evidence), [evidence, evidence]);
});

test('citation text remains literal while invalid control characters, paths and lengths fail the batch', () => {
  const quote = 'ChatGPT\tPlus\r\nmonthly';
  const parsed = parseStandardizationProtocolResponse({ items: [
    { ...classifiedItem, evidence: [{ path: 'name', quote }] },
  ] }, [input]);
  assert.equal(parsed.items[0]?.evidence[0]?.quote, quote);
  for (const invalid of ['ChatGPT\u0000Plus', 'ChatGPT\u001bPlus', 'ChatGPT\u007fPlus', 'x'.repeat(1001)]) {
    assert.throws(() => parseStandardizationProtocolResponse({ items: [
      { ...classifiedItem, evidence: [{ path: 'name', quote: invalid }] },
    ] }, [input]), StandardizationValidationError);
  }
  assert.throws(() => parseStandardizationProtocolResponse({ items: [
    { ...classifiedItem, evidence: [{ path: 'na\nme', quote }] },
  ] }, [input]), StandardizationValidationError);
});

test('missing, duplicate and unknown IDs reject the entire batch with safe diagnostics', () => {
  for (const [items, inputs, code] of [
    [[classifiedItem], [input, { ...input, id: '102' }], 'missing_item_id'],
    [[classifiedItem, classifiedItem], [input, { ...input, id: '102' }], 'duplicate_item_id'],
    [[{ ...classifiedItem, id: 'private-value' }], [input], 'item_id_unknown'],
    [[], [input, input], 'duplicate_input_id'],
  ] as const) {
    assert.throws(() => parseStandardizationProtocolResponse({ items }, inputs), (error: unknown) => {
      assert.ok(error instanceof StandardizationValidationError);
      assert.equal(error.reasonCode, 'invalid_response');
      assert.equal(error.diagnostic.code, code);
      assert.doesNotMatch(error.message + JSON.stringify(error.diagnostic), /private-value/);
      return true;
    });
  }
});

for (const [id, code, actualType] of [
  [undefined, 'invalid_type', 'undefined'], [null, 'invalid_type', 'null'],
  [101, 'invalid_type', 'number'], [{ secret: 'private-value' }, 'invalid_type', 'object'],
  ['', 'empty_string', undefined], ['private\nvalue', 'control_character', undefined],
  ['private-value'.repeat(3), 'string_too_long', undefined],
  [' 101 ', 'item_id_unknown', undefined],
] as const) {
  test(`invalid item ID rejects the batch with bounded diagnostics: ${code}/${actualType ?? typeof id}`, () => {
    assert.throws(() => parseStandardizationProtocolResponse({ items: [{ ...classifiedItem, id }] }, [input]),
      (error: unknown) => {
        assert.ok(error instanceof StandardizationValidationError);
        assert.equal(error.reasonCode, 'invalid_response');
        assert.equal(error.diagnostic.code, code);
        assert.equal(error.diagnostic.fieldPath, 'items[0].id');
        assert.equal(error.diagnostic.itemId, undefined);
        if (actualType) assert.equal(error.diagnostic.actualType, actualType);
        assert.doesNotMatch(error.message + JSON.stringify(error.diagnostic), /private|secret/);
        return true;
      });
  });
}

for (const [name, value, code, fieldPath] of [
  ['null shell', null, 'invalid_type', '$'],
  ['array shell', [], 'invalid_type', '$'],
  ['string shell', 'private-value', 'invalid_type', '$'],
  ['missing items', {}, 'missing_field', 'items'],
  ['null items', { items: null }, 'items_type_invalid', 'items'],
  ['object items', { items: { secret: 'private-value' } }, 'items_type_invalid', 'items'],
  ['too many items', { items: [classifiedItem, classifiedItem] }, 'items_limit_exceeded', 'items'],
  ['null item', { items: [null] }, 'invalid_type', 'items[0]'],
  ['array item', { items: [[]] }, 'invalid_type', 'items[0]'],
  ['root extra field', { items: [classifiedItem], secret: 'private-value' }, 'unexpected_field', '$'],
] as const) {
  test(`whole-response diagnostics describe ${name} without model content`, () => {
    assert.throws(() => parseStandardizationProtocolResponse(value, [input]), (error: unknown) => {
      assert.ok(error instanceof StandardizationValidationError);
      assert.equal(error.reasonCode, 'invalid_response');
      assert.equal(error.diagnostic.stage, 'schema');
      assert.equal(error.diagnostic.code, code);
      assert.equal(error.diagnostic.fieldPath, fieldPath);
      assert.doesNotMatch(error.message + JSON.stringify(error.diagnostic), /private-value|secret/);
      return true;
    });
  });
}

for (const [name, changes, code, fieldPath] of [
  ['candidate type', { standardProductId: 42 }, 'invalid_type', 'standardProductId'],
  ['empty candidate', { standardProductId: '' }, 'empty_string', 'standardProductId'],
  ['long candidate', { standardProductId: 'x'.repeat(31) }, 'string_too_long', 'standardProductId'],
  ['unknown candidate', { standardProductId: 'private-value' }, 'unknown_candidate_id', 'standardProductId'],
  ['borrowed candidate', { standardProductId: '43' }, 'unknown_candidate_id', 'standardProductId'],
  ['evidence type', { evidence: {} }, 'invalid_type', 'evidence'],
  ['empty evidence', { evidence: [] }, 'evidence_count_invalid', 'evidence'],
  ['too much evidence', { evidence: Array(51).fill(evidence[0]) }, 'evidence_count_invalid', 'evidence'],
  ['citation type', { evidence: [null] }, 'invalid_type', 'evidence[0]'],
  ['citation path type', { evidence: [{ path: 123, quote: 'private-value' }] }, 'invalid_type', 'evidence[0].path'],
  ['second quote type', { evidence: [evidence[0], { path: 'name', quote: null }] }, 'invalid_type', 'evidence[1].quote'],
  ['missing quote', { evidence: [{ path: 'name' }] }, 'missing_field', 'evidence[0].quote'],
  ['extra citation key', { evidence: [{ ...evidence[0], secret: 'private-value' }] }, 'unexpected_field', 'evidence[0]'],
  ['model reason', { reason: 'private-value' }, 'unexpected_field', ''],
  ['model rules', { ruleIds: [] }, 'unexpected_field', ''],
  ['legacy action', { action: 'create_identity' }, 'unexpected_field', ''],
  ['legacy identity', { identity: { family: 'private-value' } }, 'unexpected_field', ''],
  ['legacy candidate ref', { candidateRef: 'i1c1' }, 'unexpected_field', ''],
] as const) {
  test(`${name} rejects all items and preserves only bounded diagnostic facts`, () => {
    assert.throws(() => parseStandardizationProtocolResponse({ items: [
      { ...classifiedItem, id: '102', standardProductId: '43' },
      { ...classifiedItem, ...changes },
    ] }, [input, { id: '102', candidateStandardProductIds: ['43'] }]), (error: unknown) => {
      assert.ok(error instanceof StandardizationValidationError);
      assert.equal(error.reasonCode, 'invalid_response');
      assert.equal(error.diagnostic.code, code);
      assert.equal(error.diagnostic.fieldPath, 'items[1]' + (fieldPath ? '.' + fieldPath : ''));
      assert.equal(error.diagnostic.itemId, '101');
      assert.doesNotMatch(error.message + JSON.stringify(error.diagnostic), /private-value|secret/);
      return true;
    });
  });
}

test('omitted match ID is a schema error instead of an implicit unmatched decision', () => {
  assert.throws(() => parseStandardizationProtocolResponse({ items: [{ id: '101', evidence }] }, [input]),
    (error: unknown) => {
      assert.ok(error instanceof StandardizationValidationError);
      assert.equal(error.diagnostic.code, 'missing_field');
      assert.equal(error.diagnostic.fieldPath, 'items[0].standardProductId');
      return true;
    });
});

test('unexpected keys cannot inject control characters or unbounded diagnostic content', () => {
  const malformed = { ...classifiedItem, ['x\n' + 'z'.repeat(2000)]: 'private-value' };
  assert.throws(() => parseStandardizationProtocolResponse({ items: [malformed] }, [input]), (error: unknown) => {
    assert.ok(error instanceof StandardizationValidationError);
    assert.ok(error.message.length < 1000);
    assert.doesNotMatch(error.message, /[\u0000-\u001f\u007f]/u);
    assert.doesNotMatch(error.message + JSON.stringify(error.diagnostic), /private-value|zzzz/);
    return true;
  });
});
