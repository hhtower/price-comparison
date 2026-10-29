import assert from 'node:assert/strict';
import test from 'node:test';

const load = async () => {
  const api = await import('../src/standardization/review-evaluation.js').catch(() => ({})) as any;
  assert.equal(typeof api.buildDeidentifiedReviewIndex, 'function');
  return api;
};
test('review index drops raw identifiers and copy while identical copy never crosses splits', async () => {
  const api = await load();
  const index = api.buildDeidentifiedReviewIndex([
    { ids: ['secret-source-id-1'], name: 'Private product copy', spec: 'Monthly' },
    { ids: ['secret-source-id-2'], name: ' PRIVATE product   copy ', spec: 'Monthly' },
    { ids: ['secret-source-id-3'], name: 'Different private name', spec: '' },
  ], [
    { id: 'secret-source-id-1', action: '归入现有标准' },
    { id: 'secret-source-id-2', action: '保留待补证' },
    { id: 'secret-source-id-3', action: '继续隔离' },
  ]);
  assert.equal(index.groups.length, 3);
  assert.equal(index.groups[0].copyGroup, index.groups[1].copyGroup);
  assert.equal(index.groups[0].split, index.groups[1].split);
  assert.equal(index.groups[0].evidenceStatus, 'decidable');
  assert.equal(index.groups[1].evidenceStatus, 'pending_evidence');
  assert.doesNotMatch(JSON.stringify(index), /secret-source|Private product|Different private/i);
  assert.equal(index.modelSemanticQuality, 'unknown');
});

test('pending evidence does not become an accuracy denominator and absent telemetry stays unknown', async () => {
  const api = await load();
  const fixture = { version: 'test', samples: [
    { id: 'good', labelState: 'decidable', shouldClassify: true, identity: { family: 'openai', product: 'chatgpt', tier: 'plus' }, tags: {} },
    { id: 'pending', labelState: 'pending_evidence', shouldClassify: true, identity: null, tags: {} },
  ] };
  const report = api.evaluateEvidenceReview(fixture, { version: 'mock', fixtureVersion: 'test', catalog: [], outcomes: [
    { id: 'good', status: 'unclassified', reasonCode: 'insufficient_evidence', preBudgetCandidateIds: [], sentCandidateIds: [], tags: {} },
    { id: 'pending', status: 'unclassified', reasonCode: 'insufficient_evidence', preBudgetCandidateIds: [], sentCandidateIds: [], tags: {} },
  ] });
  assert.deepEqual(report.falseRejectionRate, { numerator: 1, denominator: 1, value: 1 });
  assert.equal(report.pendingEvidenceCount, 1);
  assert.equal(report.actualUsage, null);
  assert.equal(report.providerRequests, null);
  assert.equal(report.latencyP95Ms, null);
});

test('evaluation distinguishes same-evidence isolation overrides from changed-product old-identity reuse', async () => {
  const api = await load();
  const oldIdentity = { family: 'alpha', product: 'api', tier: 'standard' };
  const fixture = { version: 'v', samples: [
    { id: 'isolated', labelState: 'decidable', shouldClassify: false, identity: null, tags: {}, manualIsolation: true, evidenceChanged: false },
    { id: 'changed', labelState: 'decidable', shouldClassify: true, identity: { family: 'beta', product: 'api', tier: 'standard' }, tags: {}, previousIdentity: oldIdentity, evidenceChanged: true },
  ] };
  const report = api.evaluateEvidenceReview(fixture, { version: 'mock', fixtureVersion: 'v', catalog: [], outcomes: fixture.samples.map((sample: any) => ({ id: sample.id, status: 'classified', identity: oldIdentity, tags: {}, preBudgetCandidateIds: [], sentCandidateIds: [] })) });
  assert.deepEqual(report.isolationOverrideRate, { numerator: 1, denominator: 1, value: 1 });
  assert.deepEqual(report.staleIdentityRetentionRate, { numerator: 1, denominator: 1, value: 1 });
});

test('synthetic review groups expose only deidentified fields and keep copies in one split', async () => {
  const api = await load();
  const index = api.buildDeidentifiedReviewIndex([
    { ids: ['sample-1', 'sample-2'], name: 'Example plan', spec: 'Monthly' },
    { ids: ['sample-3'], name: ' EXAMPLE plan ', spec: 'Monthly' },
    { ids: ['sample-4'], name: 'Another example', spec: 'Annual' },
  ], [
    { id: 'sample-1', action: '归入现有标准' },
    { id: 'sample-2', action: '保留待补证' },
    { id: 'sample-3', action: '继续隔离' },
    { id: 'sample-4', action: '核对独立商品/历史标准' },
    { id: 'external-control', action: '继续隔离' },
  ]);
  assert.deepEqual(index.coverage, { indexedGroups: 3, indexedMembers: 4, reviewDecisionRows: 5, externalControlRows: 1 });
  assert.equal(index.modelSemanticQuality, 'unknown');
  const splits = new Map<string, string>();
  const allowedActions = new Set(['assign_existing', 'retain_isolation', 'needs_evidence', 'inspect_history', 'exclude_listing', 'unknown_review']);
  let members = 0;
  for (const group of index.groups) {
    assert.deepEqual(Object.keys(group).sort(), ['id', 'copyGroup', 'split', 'memberCount', 'evidenceStatus', 'identityLabelStatus', 'actionCounts'].sort());
    assert.match(group.id, /^review-\d{4}$/);
    assert.match(group.copyGroup, /^copy-\d{4}$/);
    assert.ok(['train', 'validation', 'test'].includes(group.split));
    assert.ok(['decidable', 'pending_evidence', 'mixed'].includes(group.evidenceStatus));
    assert.equal(group.identityLabelStatus, 'review_suggestion_unverified');
    assert.ok(Object.keys(group.actionCounts).every(action => allowedActions.has(action)));
    assert.equal(Object.values(group.actionCounts).reduce((sum: number, value: any) => sum + value, 0), group.memberCount);
    if (splits.has(group.copyGroup)) assert.equal(splits.get(group.copyGroup), group.split);
    splits.set(group.copyGroup, group.split);
    members += group.memberCount;
  }
  assert.equal(members, 4);
  assert.equal(splits.size, 2);
  assert.deepEqual(index.externalControlActionCounts, { retain_isolation: 1 });
});

test('retrieval recall includes missed catalog identities and observed telemetry remains auditable', async () => {
  const api = await load();
  const identity = { family: 'example', product: 'service', tier: 'standard' };
  const samples = ['found', 'missed'].map(id => ({ id, labelState: 'decidable', shouldClassify: true, identity, tags: {} }));
  const report = api.evaluateEvidenceReview({ version: 'v', samples }, { version: 'recorded', fixtureVersion: 'v',
    catalog: [{ standardProductId: 'standard-1', identity }], outcomes: [
      { id: 'found', status: 'classified', standardProductId: 'standard-1', preBudgetCandidateIds: ['standard-1'], sentCandidateIds: ['standard-1'], tags: {} },
      { id: 'missed', status: 'unclassified', preBudgetCandidateIds: [], sentCandidateIds: [], reasonCode: 'insufficient_evidence', tags: {} },
    ], telemetry: {
      found: { providerRequests: 1, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, latencyMs: 100, validStructure: true },
      missed: { providerRequests: 2, usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 }, latencyMs: 300, validStructure: false },
    } });
  assert.deepEqual(report.candidateRecall, { numerator: 1, denominator: 2, value: 0.5 });
  assert.equal(report.budgetRetention.numerator, 1);
  assert.equal(report.budgetRetention.denominator, 1);
  assert.deepEqual(report.actualUsage, { promptTokens: 30, completionTokens: 15, totalTokens: 45 });
  assert.equal(report.providerRequests, 3);
  assert.equal(report.requestsPerCorrectClassification, 3);
  assert.equal(report.latencyP95Ms, 300);
  assert.deepEqual(report.structuralValidity, { numerator: 1, denominator: 2, value: 0.5 });
});

test('malformed telemetry stays unknown instead of reporting invented numeric measurements', async () => {
  const api = await load();
  const identity = { family: 'example', product: 'service', tier: 'standard' };
  const report = api.evaluateEvidenceReview({ version: 'v', samples: [{ id: 'one', labelState: 'decidable', shouldClassify: true, identity, tags: {} }] },
    { version: 'recorded', fixtureVersion: 'v', catalog: [], outcomes: [{ id: 'one', status: 'classified', identity, preBudgetCandidateIds: [], sentCandidateIds: [], tags: {} }],
      telemetry: { one: { providerRequests: 0.5, usage: { promptTokens: -1, completionTokens: 4, totalTokens: 3 }, latencyMs: -10 } } });
  assert.equal(report.providerRequests, null);
  assert.equal(report.actualUsage, null);
  assert.equal(report.latencyP95Ms, null);
  assert.equal(report.requestsPerCorrectClassification, null);
});

const stageIdentity = { family: 'openai', product: 'chatgpt', tier: 'plus' };
const stageRow = {
  id: 'control', proposalSource: 'synthetic-control', expectedIdentity: stageIdentity,
  expectedDisposition: 'release', expectedTags: {}, proposedIdentity: stageIdentity,
  proposalDisposition: 'release', proposedTags: {}, identityRejected: false,
  candidateTargetId: 'catalog-plus', recalledCandidateIds: ['catalog-plus'],
  finalIdentity: stageIdentity, finalDisposition: 'release', finalTags: {},
};
const loadStages = async () => {
  const api = await load();
  assert.equal(typeof api.evaluateStandardizationStages, 'function', 'stage metrics must separate proposals from final outcomes');
  return api.evaluateStandardizationStages;
};

test('stage metrics separate correct proposals rejected by identity rules from retrieval misses', async () => {
  const evaluate = await loadStages();
  const report = evaluate([
    { ...stageRow, id: 'rule-rejection', identityRejected: true, finalIdentity: null, finalDisposition: 'review' },
    { ...stageRow, id: 'recall-miss', recalledCandidateIds: [] },
  ]);
  assert.deepEqual(report.identityRuleFalseRejection, { numerator: 1, denominator: 2, value: 0.5 });
  assert.deepEqual(report.candidateRecallMiss, { numerator: 1, denominator: 2, value: 0.5 });
  assert.deepEqual(report.finalErroneousRelease, { numerator: 0, denominator: 1, value: 0 });
  assert.deepEqual(report.syntheticProposalCorrectness, { numerator: 2, denominator: 2, value: 1 });
  assert.deepEqual(report.modelProposalCorrectness, { numerator: 0, denominator: 0, value: null });
  assert.equal(report.modelSemanticQuality, 'unknown');
});

test('wrong identities and unsupported tags count as proposal errors, not identity rule false rejections', async () => {
  const evaluate = await loadStages();
  const wrong = { family: 'anthropic', product: 'claude', tier: 'pro' };
  const report = evaluate([
    { ...stageRow, id: 'wrong-model', proposalSource: 'model', proposedIdentity: wrong, identityRejected: true,
      finalIdentity: null, finalDisposition: 'review' },
    { ...stageRow, id: 'wrong-model-released', proposalSource: 'model', proposedIdentity: wrong, finalIdentity: wrong },
    { ...stageRow, id: 'wrong-tag-released', proposedTags: { amount: '100 usd' }, finalTags: { amount: '100 usd' } },
    { ...stageRow, id: 'wrong-tag-dropped', proposedTags: { amount: '100 usd' } },
  ]);
  assert.deepEqual(report.modelProposalCorrectness, { numerator: 0, denominator: 2, value: 0 });
  assert.deepEqual(report.syntheticProposalCorrectness, { numerator: 0, denominator: 2, value: 0 });
  assert.deepEqual(report.identityRuleFalseRejection, { numerator: 0, denominator: 2, value: 0 });
  assert.deepEqual(report.finalErroneousRelease, { numerator: 2, denominator: 3, value: 2 / 3 });
});

test('blocked commercial promises are erroneous releases but not identity rule false rejections', async () => {
  const evaluate = await loadStages();
  const report = evaluate([
    { ...stageRow, id: 'commercial-conflict', expectedDisposition: 'review', finalDisposition: 'review', finalIdentity: null },
    { ...stageRow, id: 'commercial-leak', expectedDisposition: 'review' },
    { ...stageRow, id: 'unknown-free', expectedIdentity: null, expectedDisposition: 'review', identityRejected: true,
      finalIdentity: null, finalDisposition: 'review', candidateTargetId: undefined },
  ]);
  assert.deepEqual(report.identityRuleFalseRejection, { numerator: 0, denominator: 0, value: null });
  assert.deepEqual(report.finalErroneousRelease, { numerator: 1, denominator: 1, value: 1 });
  assert.deepEqual(report.candidateRecallMiss, { numerator: 0, denominator: 2, value: 0 });
});

test('empty and unobserved stage denominators stay null and duplicate controls are rejected', async () => {
  const evaluate = await loadStages();
  for (const rows of [[], [{ ...stageRow, proposalSource: null, proposalDisposition: null,
    proposedIdentity: null, identityRejected: null, recalledCandidateIds: null, finalDisposition: null, finalIdentity: null }]]) {
    const report = evaluate(rows);
    for (const name of ['modelProposalCorrectness', 'syntheticProposalCorrectness', 'identityRuleFalseRejection',
      'candidateRecallMiss', 'finalErroneousRelease']) {
      assert.deepEqual(report[name], { numerator: 0, denominator: 0, value: null });
    }
  }
  assert.throws(() => evaluate([stageRow, stageRow]), /duplicate/u);
});

test('omitting an optional supported tag is not an unsafe release, but inventing one is', async () => {
  const evaluate = await loadStages();
  const report = evaluate([
    { ...stageRow, id: 'safe-omission', expectedTags: { region: 'us' }, proposedTags: { region: 'us' } },
    { ...stageRow, id: 'unsafe-addition', finalTags: { region: 'us' } },
  ]);
  assert.deepEqual(report.finalErroneousRelease, { numerator: 1, denominator: 2, value: 0.5 });
});

test('observed model correctness is measured before rules, with synthetic proposals excluded', async () => {
  const evaluate = await loadStages();
  const report = evaluate([
    { ...stageRow, id: 'correct-model-rejected', proposalSource: 'model', identityRejected: true,
      finalDisposition: 'review', finalIdentity: null },
    { ...stageRow, id: 'wrong-model-reviewed', proposalSource: 'model', proposedIdentity: null,
      proposalDisposition: 'review', finalDisposition: 'review', finalIdentity: null },
    { ...stageRow, id: 'synthetic-correct' },
  ]);
  assert.deepEqual(report.modelProposalCorrectness, { numerator: 1, denominator: 2, value: 0.5 });
  assert.equal(report.modelSemanticQuality, 'observed');
  assert.deepEqual(report.syntheticProposalCorrectness, { numerator: 1, denominator: 1, value: 1 });
  assert.deepEqual(report.identityRuleFalseRejection, { numerator: 1, denominator: 2, value: 0.5 });
});

test('multi-value supported tags are compared by facts, while one unsupported sibling makes a release unsafe', async () => {
  const evaluate = await loadStages();
  const expectedTags = { delivery_format: ['json', 'credentials'] };
  const report = evaluate([
    { ...stageRow, id: 'valid-multiple', expectedTags, proposedTags: { delivery_format: ['credentials', 'json'] },
      finalTags: { delivery_format: ['credentials', 'json'] } },
    { ...stageRow, id: 'invalid-sibling', expectedTags: { delivery_format: 'json' },
      proposedTags: { delivery_format: ['credentials', 'json'] }, finalTags: { delivery_format: ['credentials', 'json'] } },
  ]);
  assert.deepEqual(report.syntheticProposalCorrectness, { numerator: 1, denominator: 2, value: 0.5 });
  assert.deepEqual(report.finalErroneousRelease, { numerator: 1, denominator: 2, value: 0.5 });
});
