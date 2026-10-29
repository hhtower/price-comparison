import assert from 'node:assert/strict';
import test from 'node:test';
import { FINITE_CATALOG, isValidCatalogIdentity, normalizeIdentity, identityEvidenceConflict } from '../src/standardization/identity-policy.js';
import { parseStandardizationProtocolResponse } from '../src/ai/ai.schemas.js';
import { buildExtractionPayload } from '../src/ai/adaptive-batching.js';
import { validateStandardizationEvidence } from '../src/ai/standardization-evidence.js';

test('finite platforms cannot grow attribute or unknown-plan identities', () => {
  assert.equal(Object.values(FINITE_CATALOG).reduce((sum, tiers) => sum + tiers.length, 0), 72);
  for (const [family, product, tier] of [
    ['cursor', 'cursor', 'team'], ['xai', 'grok', 'lite'], ['xai', 'grok', 'super_plus'],
    ['google', 'gemini', 'free'], ['google', 'google_workspace', 'business'],
    ['openai', 'chatgpt_discount_eligibility', 'standard'], ['google', 'email', 'education'],
    ['microsoft', 'outlook_oauth2_account', 'premium'], ['email', 'privacy_mailbox', 'standard'],
    ['network', 'residential_ip', 'standard'], ['generic', 'cursor_pro_account', 'standard'],
    ['generic', 'grok', 'heavy'], ['other', 'gmail_account', 'standard'],
    ['generic', 'microsoft_outlook_oauth2_account', 'standard'],
    ['other', 'premium_cursor_subscription', 'standard'],
  ]) assert.equal(isValidCatalogIdentity({ family: family!, product: product!, tier: tier! }), false, `${family}/${product}/${tier}`);
  assert.equal(isValidCatalogIdentity({ family: 'software', product: 'cursor_plugin_metered_access', tier: 'standard' }), true);
  assert.equal(isValidCatalogIdentity({ family: 'training', product: 'typescript-course', tier: 'standard' }), true);
});

test('independent tools and bundles keep their complete sale object', () => {
  assert.equal(identityEvidenceConflict({ family: 'bundle', product: 'grok_bot_and_supergrok_bundle', tier: 'standard' },
    { name: 'Grok Bot与SuperGrok组合', sourceData: { evidence: '交付Grok Bot和SuperGrok会员，两项均包含。' } }), null);
  assert.equal(identityEvidenceConflict({ family: 'software', product: 'cursor_refund_service', tier: 'standard' },
    { name: 'Cursor自助退款5次卡', sourceData: { evidence: 'Cursor退款服务，不交付账号。' } }), null);
  assert.equal(identityEvidenceConflict({ family: 'google', product: 'gemini', tier: 'tutorial' },
    { name: 'Antigravity教程' }), null);
});

test('reviewed account and receiving identities preserve sale objects', () => {
  for (const [family, product, tier] of [
    ['openai', 'chatgpt', 'team'], ['openai', 'chatgpt', 'team_5x'], ['xai', 'grok', 'supergrok'],
    ['cursor', 'cursor', 'pro_plus'], ['google', 'email', 'standard'], ['microsoft', 'outlook', 'standard'],
    ['netease', '163_mail', 'standard'], ['google', 'gmail_code_service', 'standard'],
    ['microsoft', 'mail_receive_service_mixed_domains', 'standard'], ['email', 'receive_credits', 'standard'],
  ]) assert.equal(isValidCatalogIdentity({ family: family!, product: product!, tier: tier! }), true, `${family}/${product}/${tier}`);
  assert.deepEqual(normalizeIdentity({ family: 'cursor', product: 'cursor', tier: 'Pro+' }), { family: 'cursor', product: 'cursor', tier: 'pro_plus' });
  assert.deepEqual(normalizeIdentity({ family: 'google', product: 'antigravity', tier: 'tutorial' }), { family: 'google', product: 'gemini', tier: 'tutorial' });
  assert.equal(normalizeIdentity({ family: 'xai', product: 'grok', tier: 'super' }).tier, 'super');
});

test('unrelated account identities do not inherit the X account product restriction', () => {
  for (const [family, tier] of [
    ['steam', 'standard'], ['tiktok', 'standard'], ['apple', 'standard'],
    ['dreamina', 'basic'], ['dreamina', 'premium'], ['dreamina', 'standard'],
  ]) {
    const identity = { family: family!, product: 'account', tier: tier! };
    assert.equal(isValidCatalogIdentity(identity), true, `${family}/account/${tier}`);
    assert.equal(identityEvidenceConflict(identity, { name: `${family}账号`, sourceData: { evidence: `交付${family}账号` } }), null);
  }
  assert.equal(isValidCatalogIdentity({ family: 'x', product: 'account', tier: 'standard' }), true);
  for (const family of ['openai', 'anthropic', 'google', 'xai', 'cursor', 'x', 'twitter', 'network']) {
    assert.equal(isValidCatalogIdentity({ family, product: 'account', tier: 'premium' }), false, family);
  }
  for (const family of ['codex', 'claudecode', 'x.ai', 'gro', 'gr0k', 'gmail', 'outlook']) {
    assert.equal(isValidCatalogIdentity({ family, product: 'account', tier: 'standard' }), false, family);
  }
  for (const key of Object.keys(FINITE_CATALOG)) {
    const product = key.split('/')[1]!;
    if (product === 'account') continue;
    assert.equal(isValidCatalogIdentity({ family: 'unrelated', product, tier: 'standard' }), false, key);
  }
  assert.ok(identityEvidenceConflict({ family: 'tiktok', product: 'account', tier: 'standard' }, { name: 'Steam账号', sourceData: { evidence: '交付Steam账号' } }));
  assert.ok(identityEvidenceConflict({ family: 'steam', product: 'account', tier: 'standard' }, { name: 'ChatGPT Plus账号', sourceData: { evidence: '实际交付ChatGPT Plus账号' } }));
});

test('unknown real subscriptions become review, never not_sellable', () => {
  const evidence = [{ path: 'name', quote: 'Cursor Premium会员' }];
  const result = parseStandardizationProtocolResponse({ items: [{ id: '1', action: 'create_identity',
    identity: { family: 'cursor', product: 'cursor', tier: 'premium', reason: '新套餐', evidence },
    ruleIds: [], evidence, reason: '新套餐' }] }, [{ id: '1', candidateStandardProductIds: [], candidateRefs: {} }]);
  assert.equal(result.items[0]?.status, 'unclassified');
  assert.equal(result.items[0]?.reasonCode, 'identity_conflict');
  assert.deepEqual(result.identities, []);
});

test('telegram account variants converge on the telegram account identity', () => {
  for (const [family, product, tier] of [
    ['telegram', 'telegram', 'account'], ['telegram', 'telegram', 'premium'], ['telegram', 'stars', 'top_up'],
  ]) assert.equal(isValidCatalogIdentity({ family: family!, product: product!, tier: tier! }), true, `${family}/${product}/${tier}`);
  for (const [family, product, tier] of [
    ['telegram', 'telegram', 'aged'], ['telegram', 'account', 'registered'], ['telegram', 'account', 'member'],
    ['telegram', '+967 直登协议服务', 'account'], ['telegram', 'technology_phone_number', 'standard'],
    ['印度', 'telegram账号', 'standard'], ['孟加拉', 'telegram账号', 'registered'], ['japan', 'telegram账号', 'standard'],
    ['phone', '+1 美国直登协议服务', 'standard'], ['phone', '+33 法国直登协议服务', 'standard'],
    ['us', 'telegram', 'account'], ['generic', 'telegram账号', 'standard'], ['其它', '+852 直登协议服务', '3年'],
  ]) assert.equal(isValidCatalogIdentity({ family: family!, product: product!, tier: tier! }), false, `${family}/${product}/${tier}`);
});

test('Super does not prove historical SuperGrok subscription', () => {
  const identity = { family: 'xai', product: 'grok', tier: 'supergrok' };
  assert.ok(identityEvidenceConflict(identity, { name: 'Grok Super 月订阅' }));
  assert.equal(identityEvidenceConflict(identity, { name: 'SuperGrok 月订阅', sourceData: { evidence: '交付SuperGrok会员。' } }), null);
});

test('changing family or naming a tool cannot recreate finite platform subscriptions', () => {
  for (const [product, name] of [
    ['grok_super', 'Grok Super会员'], ['grok_heavy', 'Grok Heavy会员'],
    ['x_account', 'X账号'], ['residential_proxy', '住宅IP代理'],
    ['twitter_premium', 'Twitter Premium会员'], ['gmail_oauth', 'Gmail OAuth邮箱'],
    ['youtube_premium', 'YouTube Premium会员'], ['google_mail_account', 'Google邮箱账号'],
    ['edu_email_account', '教育邮箱账号'],
    ['grok_tool', 'Grok Super会员'], ['x_account_bundle', 'X账号'],
    ['grok_tool', 'Grok Super会员，附赠使用教程'],
    ['grok_tool', 'Grok Super会员（不含工具）'], ['grok_bundle', 'Grok Super会员（非组合商品）'],
    ['grok_course', 'Grok Super会员（不售课程）'],
    ['grok_tool', 'Grok Super会员，工具支持网页登录'], ['grok_bundle', 'Grok Super会员组合优惠'],
    ['grok_course', 'Grok Super会员附赠课程'],
  ]) {
    const identity = { family: 'generic', product: product!, tier: 'standard' };
    const input = { id: '1', name: name!, spec: '', sourceData: { evidence: `交付${name!}` } };
    const evidence = [{ path: 'name', quote: input.name }];
    const payload = buildExtractionPayload(input);
    assert.ok(identityEvidenceConflict(identity, input), product);
    assert.ok(identityEvidenceConflict(identity, payload, 'text'), product + ' frozen');
    for (const choice of [
      { action: 'create_identity', identity: { ...identity, reason: '实际商品', evidence } },
      { action: 'reuse_candidate', candidateRef: 'i1c1' },
    ]) {
      const parsed = parseStandardizationProtocolResponse({ items: [{ id: '1', ...choice,
        ruleIds: [], evidence, reason: '实际商品' }] },
      [{ id: '1', candidateStandardProductIds: ['91'], candidateRefs: { i1c1: '91' } }]);
      const result = validateStandardizationEvidence(parsed, [{ id: '1', payload }], [{ id: '91', ...identity, aliases: [] }]);
      assert.equal(result.items[0]?.status, 'unclassified', product + ' ' + choice.action);
      assert.equal(result.items[0]?.reasonCode, 'identity_conflict');
      assert.deepEqual(result.identities, []);
    }
  }
});

test('independent platform goods require their own evidenced sale object', () => {
  for (const [family, product, name] of [
    ['software', 'icloud_hidden_email_generator_toolkit', 'iCloud隐藏邮箱工具包'],
    ['software', 'chatgpt_mirror', 'ChatGPT镜像服务'],
    ['software', 'cursor_plugin_metered_access', 'Cursor插件计量服务'],
    ['software', 'cursor_account_manager', 'Cursor账号管理工具'],
    ['software', 'cursor_refund_service', 'Cursor退款服务'],
    ['bundle', 'grok_bot_and_supergrok_bundle', 'Grok Bot与SuperGrok组合'],
    ['software', 'grok_api_relay', 'Grok API中转接口'],
    ['microsoft', 'office', 'Microsoft Office软件'], ['apple', 'iphone', 'Apple iPhone手机'],
    ['generic', 'visa_card', 'VISA卡，可充值ChatGPT Plus'],
    ['generic', 'visa_card', 'VISA卡可充值ChatGPT Plus'],
    ['generic', 'phone', '手机，可安装Cursor'], ['generic', 'keyboard', '键盘，适合ChatGPT用户'],
  ]) {
    const identity = { family: family!, product: product!, tier: 'standard' };
    assert.equal(isValidCatalogIdentity(identity), true, product);
    assert.equal(identityEvidenceConflict(identity, { name }), null, product);
  }
});

test('independent goods cannot override explicit conflicting delivery or included instructions', () => {
  for (const [product, name, description] of [
    ['grok_tool', 'Grok工具', '实际仅交付Grok Super会员，不交付任何工具'],
    ['grok_course', 'Grok教程', '实际仅交付Grok Super会员，不出售课程'],
    ['grok_course', 'Grok Super会员（含使用教程）', '实际仅交付Grok Super会员'],
    ['grok_tool', 'Grok工具', '实际交付Grok Super会员，不含工具'],
  ]) {
    const identity = { family: 'software', product: product!, tier: 'standard' };
    const input = { name: name!, sourceData: { evidence: description! } };
    assert.ok(identityEvidenceConflict(identity, input), product + ' raw');
    assert.ok(identityEvidenceConflict(identity, buildExtractionPayload({ id: '1', spec: '', ...input }), 'text'), product + ' frozen');
  }
});
