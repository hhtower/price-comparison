import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMembershipFeatureRequest, buildMembershipFeatureReviewRequest,
  parseMembershipFeatureResponse, parseMembershipFeatureReviewResponse } from '../src/ai/membership-feature-request.js';
import { estimateStandardizationRequest, readStandardizationRequestLimits } from '../src/ai/standardization-request.js';
import { planTagReviewRequests } from '../src/ai/tag-review-planner.js';

const inputs = [
  { id: '70000000000000001', name: '会员', spec: '商家账号，订阅1个月，保订阅。',
    sourceData: { evidence: '完整原文\n保订阅28天', category: '分类标签', selected: { warranty: '28天' } } },
  { id: '8', name: '共享会员', spec: '同一账号多人共用，保使用25天。' },
];
const proposals = { items: inputs.map(({ id }) => ({ id, membershipKind: 'account' as const, refs: [0, 1], tags: [] })) };

test('feature evidence removes category metadata, preserves complete original lines, and maps short IDs in both stages', () => {
  const before = structuredClone({ inputs, proposals });
  const first = JSON.parse(buildMembershipFeatureRequest(inputs, 'mock').messages[1]!.content);
  const review = JSON.parse(buildMembershipFeatureReviewRequest(inputs, proposals, 'mock').messages[1]!.content);
  assert.deepEqual(first.requiredIds, ['1', '2']);
  assert.deepEqual(first.inputs, review.inputs);
  assert.deepEqual(first.inputs[0].lines, [
    { n: 0, path: 'name', text: '会员' },
    { n: 1, path: 'spec', text: inputs[0]!.spec },
    { n: 2, path: 'sourceData.evidence', text: '完整原文' },
    { n: 3, path: 'sourceData.evidence', text: '保订阅28天' },
    { n: 4, path: 'sourceData.selected.warranty', text: '28天' },
  ]);
  assert.deepEqual(review.proposals.items.map((item: { id: string }) => item.id), ['1', '2']);
  const output = { items: [{ id: '2', refs: [1], membershipKind: 'rental' }, { id: '1', refs: [3], membershipKind: 'account' }] };
  assert.deepEqual(parseMembershipFeatureResponse(JSON.stringify(output), inputs).items.map(item => item.id), ['8', inputs[0]!.id]);
  assert.deepEqual(parseMembershipFeatureReviewResponse('{"items":[{"id":"2","classificationDecision":false},{"id":"1","classificationDecision":true}]}', inputs).items,
    [{ id: '8', classificationDecision: false }, { id: inputs[0]!.id, classificationDecision: true }]);
  assert.deepEqual({ inputs, proposals }, before);
});

test('invalid, blank, duplicate or missing references cannot enter either stage', () => {
  const source = [{ id: '7', name: '会员', spec: '' }];
  for (const refs of [undefined, [], [1], [-1], [99], [0, 0], [0.5], ['0'], [0, 1, 2, 3]]) {
    assert.throws(() => parseMembershipFeatureResponse(JSON.stringify({ items: [{ id: '1', refs, membershipKind: 'account' }] }), source));
    assert.throws(() => buildMembershipFeatureReviewRequest(source, {
      items: [{ id: '7', refs, membershipKind: 'account', tags: [] }],
    }, 'mock'));
  }
  assert.throws(() => parseMembershipFeatureResponse('{"items":[{"id":"9","refs":[0],"membershipKind":"account"}]}', source));
  assert.throws(() => parseMembershipFeatureResponse('{"items":[]}', source));
  assert.throws(() => buildMembershipFeatureReviewRequest(inputs, { items: proposals.items.slice(1) }, 'mock'));
});

test('feature request estimates match tested sampling and output budgets and cap review batches at three', () => {
  const limits = readStandardizationRequestLimits({});
  const built = buildMembershipFeatureRequest(inputs, 'mock');
  assert.equal(built.temperature, 0.2);
  assert.equal(built.maxOutputTokens, 8192);
  assert.equal(estimateStandardizationRequest(built, limits).outputReserveTokens, 8192);
  assert.equal(estimateStandardizationRequest(built, { ...limits, outputReserveTokens: 256 }).outputReserveTokens, 256);
  const many = Array.from({ length: 7 }, (_, i) => ({ id: String(i + 1), name: '会员', spec: '保订阅25天' }));
  const candidates = { items: many.map(({ id }) => ({ id, membershipKind: 'account' as const, refs: [0], tags: [] })) };
  const groups = planTagReviewRequests({ model: 'mock', inputs: many, proposals: candidates, membershipFeatures: true }, limits);
  assert.deepEqual(groups.map(group => group.request.inputs.length), [3, 3, 1]);
});
