import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundedCandidateIndex, type CandidateDocument, type CandidateSearchQuery } from '../src/standardization/candidate-index.js';
import { VersionedCandidateIndex } from '../src/standardization/versioned-candidate-index.js';
import { buildCandidateSearchQuery, buildExtractionPayload } from '../src/ai/adaptive-batching.js';
import { buildCanonicalStandardKey } from '../src/standardization/canonical-key.js';

const documents: CandidateDocument[] = [
  { id: '01', family: 'google', product: 'email', tier: 'standard', displayName: 'Google Gmail', aliases: ['Gmail'] },
  { id: '02', family: 'microsoft', product: 'outlook', tier: 'standard', displayName: '微软邮箱', aliases: [] },
  { id: '03', family: 'anthropic', product: 'claude', tier: 'team', displayName: 'Claude Team', aliases: [] },
  { id: '04', family: 'cursor', product: 'cursor', tier: 'team', displayName: 'Cursor Team', aliases: [] },
  { id: '05', family: 'google', product: 'gemini', tier: 'plus', displayName: 'Google Plus', aliases: [] },
  { id: '90', family: 'openai', product: 'chatgpt', tier: 'team', displayName: 'ChatGPT Team', aliases: ['openai / chatgpt / team'] },
  { id: '91', family: 'openai', product: 'chatgpt', tier: 'team_5x', displayName: 'ChatGPT Premium', aliases: ['openai / chatgpt / team_5x'] },
  { id: '92', family: 'openai', product: 'chatgpt', tier: 'free', displayName: 'ChatGPT ordinary account', aliases: [] },
  { id: '93', family: 'microsoft', product: 'mail_receive_service_mixed_domains', tier: 'standard',
    displayName: '微软混合域名邮箱取件服务（不可网页登录）',
    definition: '仅通过取件入口接收微软邮箱邮件与验证码，不提供完整邮箱网页登录；域名子集与注册用途不另分产品。', aliases: [] },
];

function indexes(catalog = documents) {
  const options = { maxScanned: 12, maxCompared: 2, topK: 2 };
  const incremental = VersionedCandidateIndex.build({ version: 1n, aliasPolicyVersion: 'test', documents: [] }, options);
  assert.equal(incremental.applyChanges(catalog.map(document => ({
    version: 2n, operation: 'upsert' as const, standardProductId: document.id, document,
  })), 2n).targetVersionReady, true);
  return [new BoundedCandidateIndex(catalog, options),
    VersionedCandidateIndex.build({ version: 2n, aliasPolicyVersion: 'test', documents: catalog }, options),
    incremental];
}

function query(name: string, evidence: string): CandidateSearchQuery {
  return buildCandidateSearchQuery(buildExtractionPayload({ id: 'synthetic', name, spec: '', sourceData: { evidence } }));
}

const cases = [
  ['brand spelling and Business standard seats', 'GhatCPT Business 团队版 标准席位 一个月', '提供账号后加入团队空间。', '90'],
  ['Outlook inbox verification delivery', 'Outlook邮箱 接马 (三次码|OpenAI业务)',
    '仅提供邮箱验证码，二十分钟内三次收码。输入CDK进入取件网站收码，不能网页登录，不提供完整邮箱账号。', '93'],
  ['free account with incidental registration mailbox and Team eligibility', 'codex free-Gmail谷歌邮箱注册 可用5xteam 成品号',
    'codex free 无订阅，普通AI成品号，不送邮箱。发货格式：账号、密码、2fa。', '92'],
  ['standard Team with platform evidence in the body', 'Team 1x 标准席位', 'OpenAI ChatGPT 团队空间账号。', '90'],
  ['compact Team multiplier with platform evidence in the body', 'teamx5 临时席位', 'GPT 团队账号。', '91'],
] as const;

for (const [label, name, evidence, expected] of cases) {
  test(`supplement recalls ${label} within the shared retrieval budget`, () => {
    const input = query(name, evidence);
    const results = indexes().map(index => index.search(input));
    for (const result of results) {
      assert.ok(result.candidates.some(candidate => candidate.id === expected), `${label}: ${result.candidates.map(candidate => candidate.id)}`);
      assert.ok(result.stats.scanned <= 12);
      assert.ok(result.stats.compared <= 2);
      assert.ok(result.candidates.length <= 2);
      assert.equal(new Set(result.candidates.map(candidate => candidate.id)).size, result.candidates.length);
    }
    assert.deepEqual(results[1], results[0]);
    assert.deepEqual(results[2], results[0]);
  });
}

test('email-only Outlook delivery supplements the admitted mixed-domain service rather than a full mailbox', () => {
  const input = query(cases[1][1], cases[1][2]);
  for (const index of indexes()) {
    const result = index.search(input);
    assert.equal(result.candidates[0]?.product, 'mail_receive_service_mixed_domains');
    assert.ok(result.candidates[0]?.routes.includes('supplement'));
    assert.equal(result.candidates.some(candidate => candidate.product === 'outlook_code_service'), false);
  }
});

test('Outlook receipt accounts with explicit web login do not gain a receiving-only service supplement', () => {
  const input = query('Outlook邮箱 收件账号', '交付完整邮箱账号密码，支持网页登录，可发送和接收邮件。');
  for (const index of indexes()) {
    const result = index.search(input);
    assert.equal(result.candidates[0]?.product, 'outlook');
    assert.equal(result.candidates.some(candidate => candidate.routes.includes('supplement')), false);
  }
});

test('supplement does not infer that Team 10x is the admitted 5x tier', () => {
  for (const name of ['ChatGPT Team 10x', 'ChatGPT Team10x', 'GhatCPT Business 10x', 'OpenAI teamx10', 'ChatGPT 10x Team']) {
    for (const index of indexes()) {
      assert.equal(index.search(query(name, '团队席位。')).candidates.some(candidate => candidate.routes.includes('supplement')), false, name);
    }
  }
});

test('a supported multiplier before Team is retained instead of defaulting to a standard seat', () => {
  for (const [name, tier] of [['ChatGPT 5x Team', 'team_5x'], ['ChatGPT 1x Team', 'team']] as const) {
    for (const index of indexes()) {
      const supplement = index.search(query(name, '团队席位。')).candidates.find(candidate => candidate.routes.includes('supplement'));
      assert.equal(supplement?.tier, tier, name);
    }
  }
});

test('generic plans and other platforms do not gain an OpenAI supplement', () => {
  for (const input of [
    query('Team 1x', '标准席位，独享 Plus 同等额度。'),
    query('teamx5', 'G PLUS 分类，支持 sub2api。'),
    query('Plus', ''), query('Free', ''),
    query('Claude Team', 'Anthropic 团队账号。'),
    query('Cursor Team', 'Cursor 团队账号。'),
    query('Google Plus', 'Google 套餐。'),
    query('Gmail谷歌邮箱账号', '仅出售邮箱，可自行注册 codex free，无订阅。'),
    query('Claude Team', '兼容 OpenAI ChatGPT 工作流。'),
    query('Cursor Team', '支持 OpenAI 模型。'),
    query('Google Plus', '与 ChatGPT Plus 对比。'),
    query('codex free Gmail邮箱账号', '仅出售邮箱账号，非AI成品号，无订阅。'),
  ]) {
    for (const index of indexes()) {
      assert.equal(index.search(input).candidates.some(candidate => candidate.family === 'openai' && candidate.routes.includes('supplement')),
        false, String(input.primaryText));
    }
  }
});

test('a supported supplement survives an unrelated heuristic while retaining the strongest alias', () => {
  const input = { ...query(cases[2][1], cases[2][2]),
    canonicalKey: buildCanonicalStandardKey(documents[1]!), canonicalKeyConfidence: 'heuristic' as const };
  for (const index of indexes()) {
    assert.deepEqual(new Set(index.search(input).candidates.map(candidate => candidate.id)), new Set(['01', '92']));
  }
});

test('premium Team wording is never supplemented as a standard seat', () => {
  for (const name of ['GhatCPT Business Premium monthly', 'ChatGPT Team Premium monthly']) {
    for (const index of indexes()) {
      const result = index.search(query(name, '团队账号。'));
      assert.equal(result.candidates.some(candidate => candidate.id === '90' && candidate.routes.includes('supplement')), false);
      assert.ok(result.candidates.some(candidate => candidate.id === '91'));
    }
  }
});

test('unknown Team multipliers and explicit inbox service denials do not create lookup hints', () => {
  for (const input of [
    query('ChatGPT Team 7x', '团队席位。'),
    query('ChatGPT Team 1.5x', '团队席位。'),
    query('ChatGPT Team .5x', '团队席位。'),
    query('ChatGPT 1x Team 5x', '团队席位。'),
    query('Outlook邮箱账号，不提供接码服务', '交付完整邮箱账号密码。'),
  ]) {
    for (const index of indexes()) assert.equal(index.search(input).candidates.some(candidate => candidate.routes.includes('supplement')), false);
  }
});

test('explicit mailbox sale stays ahead of incidental AI account registration instructions', () => {
  const input = query('Gmail谷歌邮箱账号', '仅出售邮箱，交付邮箱账号密码。可用于注册 codex free，无订阅。');
  for (const index of indexes()) assert.equal(index.search(input).candidates[0]?.id, '01');
});

test('an absent or isolated inbox service is never synthesized or replaced with a new catalog identity', () => {
  const input = query(cases[1][1], cases[1][2]);
  const active = documents.filter(document => document.id !== '93');
  for (const index of indexes(active)) {
    assert.equal(index.search(input).candidates.some(candidate => candidate.id === '93'), false);
    assert.ok(index.search(input).candidates.every(candidate => active.some(document => document.id === candidate.id)));
  }
  const incremental = VersionedCandidateIndex.build({ version: 1n, aliasPolicyVersion: 'test', documents });
  assert.equal(incremental.applyChanges([{ version: 2n, operation: 'isolate', standardProductId: '93' }], 2n).targetVersionReady, true);
  assert.deepEqual(incremental.search(input), new BoundedCandidateIndex(active).search(input));
});
