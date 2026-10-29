import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundedCandidateIndex, type CandidateDocument } from '../src/standardization/candidate-index.js';
import { VersionedCandidateIndex } from '../src/standardization/versioned-candidate-index.js';
import { buildCanonicalStandardKey } from '../src/standardization/canonical-key.js';
import { buildCandidateSearchQuery, buildExtractionPayload, estimateInputSize, planAdaptiveBatches } from '../src/ai/adaptive-batching.js';
import { identityGuardRegressions } from './fixtures/identity-guard-regressions.js';

test('reviewed Team account credentials recall their own tier under a one-candidate budget', () => {
  const documents: CandidateDocument[] = [
    { id: '1', family: 'openai', product: 'chatgpt', tier: 'team', aliases: [] },
    { id: '2', family: 'openai', product: 'chatgpt', tier: 'team_5x', aliases: [] },
    { id: '3', family: 'google', product: 'gmail', tier: 'standard', aliases: [] },
  ];
  const index = new BoundedCandidateIndex(documents, { maxCompared: 1, topK: 1 });
  for (const { input, identity } of identityGuardRegressions.filter(row => row.input.id.startsWith('team-'))) {
    const query = buildCandidateSearchQuery(buildExtractionPayload(input));
    assert.equal(query.canonicalKey, buildCanonicalStandardKey(identity), input.name);
    assert.equal(index.search(query).candidates[0]?.tier, identity.tier, input.name);
  }
});

const catalog: CandidateDocument[] = [
  { id: '1', family: 'openai', product: 'chatgpt', tier: 'plus', displayName: 'ChatGPT Plus 月卡', aliases: [] },
  { id: '2', family: 'sms', product: 'activation', tier: 'standard', displayName: '接码服务', aliases: ['SMS activation'] },
  { id: '3', family: 'google', product: 'gmail', tier: 'email_account', displayName: '谷歌邮箱成品', aliases: ['谷歌邮件账户'] },
];

test('weak canonical evidence cannot suppress a different relevant sales-title candidate', () => {
  const query = { text: `ChatGPT Plus ${'SMS activation '.repeat(60)}`, primaryText: 'ChatGPT Plus',
    canonicalKey: buildCanonicalStandardKey(catalog[1]!), canonicalKeyConfidence: 'heuristic' as const };
  for (const index of [new BoundedCandidateIndex(catalog), VersionedCandidateIndex.build({ version: 1n, aliasPolicyVersion: 'v1', documents: catalog })]) {
    const matches = index.search(query).candidates;
    assert.equal(matches[0]?.id, '1');
    assert.ok(matches.some(match => match.id === '2'));
  }
});

test('Chinese display names and confirmed aliases recall their catalog identity', () => {
  const index = new BoundedCandidateIndex(catalog);
  assert.equal(new BoundedCandidateIndex([{ ...catalog[2]!, aliases: [] }]).search({ text: '谷歌邮箱成品独享' }).candidates[0]?.id, '3');
  assert.equal(index.search({ text: '购买谷歌邮件账户' }).candidates[0]?.id, '3');
});

test('relevance filtering preserves short exact brands and two-character Chinese display names', () => {
  const index = new BoundedCandidateIndex([{ id: '1', family: 'x', product: 'x', tier: 'premium', displayName: '推特', aliases: [] }]);
  assert.equal(index.search({ text: 'X premium' }).candidates[0]?.id, '1');
  assert.equal(index.search({ text: '推特高级会员' }).candidates[0]?.id, '1');
  assert.deepEqual(index.search({ text: 'Netflix subscription' }).candidates, []);
});

test('generic terms and accidental ngrams do not fill unrelated candidate slots', () => {
  const index = new BoundedCandidateIndex([
    { id: '1', family: 'acme', product: 'software', tier: 'account', aliases: [] },
    { id: '2', family: 'finland', product: 'offline', tier: 'standard', aliases: [] },
  ]);
  assert.deepEqual(index.search({ text: 'handmade ceramic vase account' }).candidates, []);
  assert.deepEqual(index.search({ text: 'Netflix' }).candidates, []);
});

test('a reliable name match survives long unrelated context and a one-candidate comparison limit', () => {
  const distractors = Array.from({ length: 30 }, (_, i) => ({ id: `0${i}`, family: 'guide', product: `sms_help_${i}`, tier: 'standard', aliases: [] }));
  const index = new BoundedCandidateIndex([...distractors, { ...catalog[2]!, id: '999' }], { maxCompared: 1, topK: 1, maxScanned: 40 });
  const query = buildCandidateSearchQuery(buildExtractionPayload({ id: 'x', name: '谷歌邮箱成品', spec: '独享',
    sourceData: { evidence: 'guide sms help '.repeat(300) } }));
  assert.equal(index.search(query).candidates[0]?.id, '999');
});

test('selected SKU is part of primary retrieval evidence and heuristic identities are marked', () => {
  const query = buildCandidateSearchQuery(buildExtractionPayload({ id: 'x', name: 'ChatGPT', spec: '套餐: Plus', sourceData: { evidence: 'Pro Enterprise 升级比较',
  } }));
  assert.match(query.primaryText ?? '', /ChatGPT/u);
  assert.match(query.primaryText ?? '', /Plus/u);
  assert.doesNotMatch(query.primaryText ?? '', /Enterprise/u);
  const simple = buildCandidateSearchQuery({ name: 'ChatGPT Plus' });
  assert.equal(simple.canonicalKeyConfidence, 'heuristic');
});

test('selected tier ranks before a same-family lower-id candidate under the comparison budget', () => {
  const alternatives = [
    { id: '001', family: 'openai', product: 'chatgpt', tier: 'pro', aliases: [] },
    { ...catalog[0]!, id: '999' },
  ];
  const query = { text: 'ChatGPT Plus', primaryText: 'ChatGPT Plus' };
  assert.equal(new BoundedCandidateIndex(alternatives, { maxCompared: 1 }).search(query).candidates[0]?.id, '999');
});

test('display-only catalog updates have identical incremental and full retrieval including statistics', () => {
  const options = { maxScanned: 70, maxCompared: 10, topK: 8 };
  const index = VersionedCandidateIndex.build({ version: 1n, aliasPolicyVersion: 'v1', documents: catalog }, options);
  const updated = { ...catalog[2]!, displayName: '星河专用账户' };
  const applied = index.applyChanges([{ version: 2n, standardProductId: '3', operation: 'upsert', document: updated }], 2n);
  assert.equal(applied.targetVersionReady, true);
  const rebuilt = new BoundedCandidateIndex([catalog[0]!, catalog[1]!, updated], options);
  for (const query of [{ text: '星河专用账户' }, { text: '谷歌邮箱成品' }, { text: '购买谷歌邮件账户' },
    { text: 'ChatGPT Plus SMS activation', primaryText: 'ChatGPT Plus', canonicalKey: buildCanonicalStandardKey(catalog[1]!), canonicalKeyConfidence: 'heuristic' as const }]) {
    assert.deepEqual(index.search(query), rebuilt.search(query));
  }
  assert.equal(index.search({ text: '星河专用账户' }).candidates[0]?.id, '3');
});

test('extraction keeps a single stable source body with complete denial and SKU evidence', () => {
  const body = `${'商品使用说明。'.repeat(1200)}不提供共享；不是已开通会员；所选 SKU 仅资格。`;
  const payload = buildExtractionPayload({ id: 'x', name: '资格号', spec: '权益: 仅资格，不含会员 / 期限: 非月卡', evidence: body, sourceData: {
    evidence: body,
  } });
  assert.equal(payload.evidence, undefined);
  assert.equal((payload.sourceData as Record<string, unknown>).evidence, body.normalize('NFKC'));
  assert.equal(JSON.stringify(payload).split('不是已开通会员').length - 1, 1);
  assert.equal(payload.spec, '期限: 非月卡 / 权益: 仅资格,不含会员');
  assert.deepEqual(planAdaptiveBatches([{ productId: 1n, payload, ...estimateInputSize(payload) }],
    { maxItems: 10, maxInputBytes: 1000, maxInputTokens: 1000 }), []);
});

test('explicit-only body uses sourceData evidence while distinct source and explicit evidence are preserved', () => {
  const only = buildExtractionPayload({ id: '1', name: '商品', spec: '', evidence: '仅含资格' });
  assert.equal(only.evidence, undefined);
  assert.equal((only.sourceData as Record<string, unknown>).evidence, '仅含资格');
  const distinct = buildExtractionPayload({ id: '2', name: '商品', spec: '', evidence: '未开通会员', sourceData: { evidence: '自助注册' } });
  assert.equal(distinct.evidence, '未开通会员');
  assert.equal((distinct.sourceData as Record<string, unknown>).evidence, '自助注册');
});

test('explicit extraction evidence cannot bypass source credential sanitization', () => {
  const body = 'API 地址: https://login:private-value@example.test/v1?api_key=hidden-key&region=us Authorization: Bearer private-token password=hidden-password';
  for (const sourceData of [undefined, { evidence: '独立来源正文' }]) {
    const payload = buildExtractionPayload({ id: '1', name: 'API 商品', spec: '', evidence: body, sourceData });
    assert.doesNotMatch(JSON.stringify(payload), /private-value|hidden-key|private-token|hidden-password/u);
    assert.match(JSON.stringify(payload), /https:\/\/example.test\/v1\?region=us/u);
  }
});

test('multilingual input estimates do not budget Chinese as four characters per token', () => {
  const payload = { evidence: '仅售资格不含会员'.repeat(400) };
  const chinese = estimateInputSize(payload);
  const english = estimateInputSize({ evidence: 'ordinary product '.repeat(200) });
  assert.ok(chinese.estimatedTokens >= 3200);
  assert.ok(chinese.estimatedTokens > english.estimatedTokens * 2);
  assert.deepEqual(planAdaptiveBatches([{ productId: 1n, payload, ...chinese }],
    { maxItems: 10, maxInputBytes: 20_000, maxInputTokens: 2000 }), []);
});
