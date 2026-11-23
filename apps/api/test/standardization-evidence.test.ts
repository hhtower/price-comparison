import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseStandardizationProtocolResponse, StandardizationValidationError } from '../src/ai/ai.schemas.js';
import { validateStandardizationEvidence, validateTagCitations } from '../src/ai/standardization-evidence.js';

const candidate = { id: '91', family: 'openai', product: 'chatgpt', tier: 'plus', aliases: [] };
const inputs = [{ id: '1', candidateStandardProductIds: ['91'],
  payload: { name: 'ChatGPT Plus', spec: '期限: 1个月', sourceData: { price: 12, options: ['JSON交付'] } } }];
const evidence = [{ path: 'name', quote: 'ChatGPT Plus' }];
const response = (citations = evidence, standardProductId: string | null = '91') =>
  parseStandardizationProtocolResponse({ items: [{ id: '1', standardProductId, nullReason: standardProductId ? null : 'insufficient_source', evidence: citations }] }, inputs);

test('boundary validates exact current scalar citations and returns the untouched decision', () => {
  const parsed = response([...evidence, { path: 'sourceData.price', quote: '12' },
    { path: 'sourceData.options[0]', quote: 'JSON交付' }]);
  assert.equal(validateStandardizationEvidence(parsed, inputs, [candidate]), parsed);
});

test('missing, fabricated, foreign, normalized-only and non-scalar citations throw for both outcomes', () => {
  for (const standardProductId of ['91', null]) {
    for (const citations of [
      [], [{ path: 'name', quote: 'Invented' }], [{ path: 'items[1].name', quote: 'ChatGPT Plus' }],
      [{ path: 'historyContext.name', quote: 'ChatGPT Plus' }], [{ path: 'name', quote: 'chatgpt plus' }],
      [{ path: 'name', quote: 'ChatGPT  Plus' }], [{ path: 'name', quote: 'ＣhatGPT Plus' }],
      [{ path: 'sourceData', quote: '12' }], [{ path: 'sourceData.options', quote: 'JSON交付' }],
      [{ path: 'sourceData.options.length', quote: '1' }],
      [{ path: 'constructor.name', quote: 'Object' }], [{ path: '__proto__.name', quote: 'ChatGPT Plus' }],
      [{ path: 'name..value', quote: 'ChatGPT Plus' }],
    ]) {
      const parsed = response(evidence, standardProductId);
      parsed.items[0]!.evidence = citations;
      assert.throws(() => validateStandardizationEvidence(parsed, inputs, [candidate]), StandardizationValidationError);
      assert.equal(parsed.items[0]!.reasonCode, standardProductId ? null : 'insufficient_source');
    }
  }
});

test('one invalid sibling fails the whole batch without partial business results', () => {
  const batchInputs = [...inputs, { ...inputs[0]!, id: '2', payload: { ...inputs[0]!.payload, name: 'Claude Pro' } }];
  const parsed = parseStandardizationProtocolResponse({
    items: ['1', '2'].map(id => ({ id, standardProductId: '91', nullReason: null, evidence })),
  }, batchInputs);
  assert.throws(() => validateStandardizationEvidence(parsed, batchInputs, [candidate]), (error: unknown) => {
    assert.ok(error instanceof StandardizationValidationError);
    assert.equal(error.diagnostic.itemId, '2');
    assert.equal(error.diagnostic.fieldPath, 'items[1].evidence[0].quote');
    assert.doesNotMatch(JSON.stringify(error.diagnostic), /ChatGPT|Claude/u);
    return true;
  });
  assert.deepEqual(parsed.items.map(item => item.status), ['classified', 'classified']);
});

test('boundary checks complete frozen IDs, candidate membership and existing identity only', () => {
  for (const invalid of [
    { ...response(), missingIds: ['2'] },
    { ...response(), items: [] },
    { ...response(), items: [response().items[0]!, response().items[0]!] },
    { ...response(), items: [{ ...response().items[0]!, id: 'unknown' }] },
  ]) assert.throws(() => validateStandardizationEvidence(invalid, inputs, [candidate]));
  assert.throws(() => validateStandardizationEvidence(response(), inputs, []));
  assert.throws(() => validateStandardizationEvidence(response(), inputs, [candidate, candidate]));
  assert.throws(() => validateStandardizationEvidence(response(), [inputs[0]!, inputs[0]!], [candidate]));
  assert.throws(() => validateStandardizationEvidence(response(), [{ ...inputs[0]!, candidateStandardProductIds: [] }], [candidate]));
  const forged = response();
  Object.assign(forged.items[0]!, { identity: { kind: 'new', ref: 'created', canonicalKey: 'old' } });
  assert.throws(() => validateStandardizationEvidence(forged, inputs, [candidate]));
});

test('approved definitions are not reinterpreted by legacy identity policy', () => {
  const source = [{ id: '1', candidateStandardProductIds: ['91'], payload: { name: 'X Twitter 自助充值 30天卡密' } }];
  const parsed = parseStandardizationProtocolResponse({ items: [{ id: '1', standardProductId: '91', nullReason: null,
    evidence: [{ path: 'name', quote: source[0]!.payload.name }] }] }, source);
  assert.equal(validateStandardizationEvidence(parsed, source,
    [{ ...candidate, family: 'x', product: 'premium_membership', tier: 'premium_plus' }]), parsed);
});

test('shared attribute citation validator keeps exact leaf matching and rejects identifier evidence', () => {
  validateTagCitations([{ path: 'sourceData.options[0]', quote: 'JSON交付' }], inputs[0]!.payload);
  for (const citation of [{ path: 'name', quote: 'chatgpt plus' }, { path: 'id', quote: '1' },
    { path: 'sourceData.id', quote: '1' }, { path: 'sourceData', quote: '12' }]) {
    assert.throws(() => validateTagCitations([citation], { ...inputs[0]!.payload, id: '1' }), StandardizationValidationError);
  }
  assert.throws(() => validateTagCitations([], inputs[0]!.payload), StandardizationValidationError);
});
