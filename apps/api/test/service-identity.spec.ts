import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeIdentity, isValidCatalogIdentity, assessProductEvidence, identityEvidenceConflict } from '../src/standardization/identity-policy.js';
import { buildCanonicalStandardKey } from '../src/standardization/canonical-key.js';
import { buildCandidateSearchQuery } from '../src/ai/adaptive-batching.js';
import { BoundedCandidateIndex } from '../src/standardization/candidate-index.js';
import { parseStandardizationProtocolResponse } from '../src/ai/ai.schemas.js';

const groups = [
  { family: 'openai', product: 'codex_sms', aliases: ['codex_sms', 'openai_sms', 'chatgpt_sms', 'OpenAI SMS', 'sms'] },
  { family: 'anthropic', product: 'claude_sms', aliases: ['claude_sms', 'anthropic_sms', 'claude_code_sms', 'sms'] },
  { family: 'google', product: 'google_sms', aliases: ['google_sms', 'gemini_sms', 'google_ai_sms', 'sms'] },
];
test('an explicit SMS tier on a known account product uses the same service identity', () => {
  for (const [family, product, service] of [['openai', 'codex', 'codex_sms'], ['anthropic', 'claude', 'claude_sms'], ['google', 'gemini', 'google_sms']]) {
    const expected = { family: family!, product: service!, tier: 'standard' };
    assert.deepEqual(normalizeIdentity({ family, product, tier: 'sms' }), expected);
    assert.equal(buildCanonicalStandardKey({ family: family!, product: product!, tier: 'sms' }), buildCanonicalStandardKey(expected));
  }
  assert.notDeepEqual(normalizeIdentity({ family: 'google', product: 'codex', tier: 'sms' }), { family: 'google', product: 'google_sms', tier: 'standard' });
});
for (const group of groups) test(`${group.family} service aliases share one validated identity and database key`, () => {
  const expected = { family: group.family, product: group.product, tier: 'standard' };
  for (const product of group.aliases) {
    const actual = { ...expected, product };
    assert.deepEqual(normalizeIdentity(actual), expected);
    assert.equal(isValidCatalogIdentity(actual), true);
    assert.equal(buildCanonicalStandardKey(actual), buildCanonicalStandardKey(expected));
  }
});

test('service aliases remain scoped to their provider and preserve distinct sale objects', () => {
  assert.equal(isValidCatalogIdentity({ family: 'google', product: 'codex_sms', tier: 'standard' }), false);
  assert.equal(isValidCatalogIdentity({ family: 'openai', product: 'gemini_sms', tier: 'standard' }), false);
  for (const product of ['api_credits', 'codex_api_credits', 'email_code_service', 'chatgpt', 'chatgpt_registration_tool']) {
    const identity = { family: 'openai', product, tier: 'standard' };
    assert.deepEqual(normalizeIdentity(identity), identity);
    assert.notEqual(buildCanonicalStandardKey(identity), buildCanonicalStandardKey({ ...identity, product: 'codex_sms' }));
  }
  assert.notEqual(buildCanonicalStandardKey({ family: 'openai', product: 'codex_sms', tier: 'premium' }),
    buildCanonicalStandardKey({ family: 'openai', product: 'codex_sms', tier: 'standard' }));
});

test('same-provider service labels are aliases, while cross-provider offers remain ambiguous', () => {
  for (const [name, family, product] of [
    ['Codex / OpenAI / ChatGPT 接码服务', 'openai', 'codex_sms'],
    ['Anthropic / Claude Code 接码服务', 'anthropic', 'claude_sms'],
    ['Google / Gemini 接码服务', 'google', 'google_sms'],
    ['谷歌接码 美国实卡', 'google', 'google_sms'],
  ]) assert.deepEqual(assessProductEvidence({ name }).identity, { family, product, tier: 'standard' });
  assert.equal(assessProductEvidence({ name: 'OpenAI / Claude 接码服务' }).kind, 'ambiguous');
  assert.equal(assessProductEvidence({ name: 'Google / Codex 接码服务' }).kind, 'ambiguous');
});

test('Google registration evidence recalls Google SMS instead of excluded Codex context', () => {
  const evidence = { name: 'Google长效接马【25-30天】【美国ATT运营商实卡】', spec: '',
    evidence: '此产品是Google接验证码，是注册google账号用的！不是直接用于登录Codex的！登录Codex接验证码是店里另外一个产品。' };
  const query = buildCandidateSearchQuery(evidence);
  assert.equal(query.canonicalKey, buildCanonicalStandardKey({ family: 'google', product: 'google_sms', tier: 'standard' }));
  const index = new BoundedCandidateIndex([
    { id: '4024', family: 'openai', product: 'codex_sms', tier: 'standard', aliases: [] },
    { id: '4092', family: 'google', product: 'google_sms', tier: 'standard', aliases: [] },
  ]);
  assert.equal(index.search(query).candidates[0]?.id, '4092');
  assert.equal(identityEvidenceConflict({ family: 'google', product: 'gemini_sms', tier: 'standard' }, evidence), null);
});

test('explicit provider fields precede broad categories in SMS candidate hints', () => {
  for (const [brand, family, product] of [['Google', 'google', 'google_sms'], ['Anthropic', 'anthropic', 'claude_sms']]) {
    assert.deepEqual(assessProductEvidence({ name: '短信接码服务', sourceData: { brand, category: { name: 'Codex 热销服务' } } }).identity, { family, product, tier: 'standard' });
  }
});

test('email code products cannot receive SMS canonical hints merely for mentioning OpenAI', () => {
  for (const name of ['域名邮箱 接马 (二次码|OpenAI业务)', 'Gmail 接马 (三次码|OpenAI业务)', 'OpenAI 邮箱验证码接收服务']) {
    const evidence = { name, evidence: '用于注册 OpenAI 账号，通过邮箱接收验证码。' };
    assert.equal(buildCandidateSearchQuery(evidence).canonicalKey, undefined);
    assert.ok(identityEvidenceConflict({ family: 'openai', product: 'codex_sms', tier: 'standard' }, evidence));
  }
});

test('Google service labels can mention Gmail without selling a mailbox', () => {
  const evidence = { name: 'Google/Gmail/YouTube 接马 智利【单次接马】', evidence: '谷歌账号注册用手机号码，只接一次短信。' };
  assert.deepEqual(assessProductEvidence(evidence).identity, { family: 'google', product: 'google_sms', tier: 'standard' });
});

test('service warnings remain sellable but standalone instructions do not become SMS inventory', () => {
  assert.deepEqual(assessProductEvidence({ name: 'Codex 接码【看清楚商品说明】' }).identity,
    { family: 'openai', product: 'codex_sms', tier: 'standard' });
  assert.notEqual(assessProductEvidence({ name: 'Codex 接码使用说明' }).kind, 'sms_service');
});

test('physical phone verification titles establish SMS delivery without a tutorial paragraph', () => {
  for (const [name, family, product] of [
    ['Google谷歌美国T-Mobile实卡长效接验证码', 'google', 'google_sms'],
    ['codex美国T-Mobile单次接验证码', 'openai', 'codex_sms'],
    ['whatsapp美国实卡长效接验证码', 'whatsapp', 'whatsapp_sms'],
  ]) assert.deepEqual(assessProductEvidence({ name }).identity, { family, product, tier: 'standard' });
  assert.notEqual(assessProductEvidence({ name: 'Gmail邮箱接验证码' }).kind, 'sms_service');
});

test('SMS API delivery support does not turn phone verification inventory into API credits', () => {
  assert.deepEqual(assessProductEvidence({ name: '美国实卡codex 短效单次接马 可以api对接 自动化codex绑定' }).identity,
    { family: 'openai', product: 'codex_sms', tier: 'standard' });
  assert.equal(assessProductEvidence({ name: 'Codex API credits', evidence: '账号需要手机接码' }).kind, 'other');
});

test('model-created service descriptions normalize before canonical key construction', () => {
  const evidence = [{ path: 'name', quote: 'OpenAI 手机接码服务' }];
  const items = ['codex_sms', 'openai_sms', 'chatgpt_sms'].map((product, i) => ({ id: String(i + 1), action: 'create_identity',
    identity: { family: 'openai', product, tier: 'standard', reason: 'Phone verification service', evidence },
    ruleIds: [], evidence, reason: 'Phone verification service' }));
  const parsed = parseStandardizationProtocolResponse({ items }, items.map(item => ({ id: item.id, candidateStandardProductIds: [], candidateRefs: {} })));
  assert.ok(parsed.items.every(item => item.status === 'classified'));
  assert.equal(new Set(parsed.identities.map(identity => identity.canonicalKey)).size, 1);
  assert.ok(parsed.identities.every(identity => identity.product === 'codex_sms'));
});
