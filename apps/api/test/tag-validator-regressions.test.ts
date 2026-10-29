import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { buildExtractionPayload } from '../src/ai/adaptive-batching.js';
import { validateStandardizationTags } from '../src/ai/standardization-evidence.js';
import { normalizeSpec } from '../src/products/product-spec.js';

// Spec evidence uses the canonical spacing produced by the extraction payload.
const replayTag = ({ name, value, path, quote }: any) => ({ name, value,
  evidence: [{ path, quote: path === 'spec' ? normalizeSpec(quote) : quote }] });

const fixture = JSON.parse(await readFile(new URL('./fixtures/tag-extraction-quality-expanded-20261016.json', import.meta.url), 'utf8'));
for (const sample of fixture.samples.filter((s: any) => s.expected.length)) {
  test(`explicit diagnostic facts survive validation: ${sample.id} ${sample.scenario}`, () => {
    const proposed = sample.expected.map(replayTag);
    const result = validateStandardizationTags(proposed, buildExtractionPayload(sample.input));
    assert.deepEqual(result.rejectedTags, []);
    assert.deepEqual(result.tags, proposed);
  });
}

const negatives: Array<[string, string, string, string?]> = [
  ['sms_verification', 'verified', '账号尚未完成短信验证。', '已完成短信验证'],
  ['sms_verification', 'verified', '账号尚未完成短信验证。', '完成短信验证'],
  ['sms_verification', 'verified', '并非已完成短信验证。', '已完成短信验证'],
  ['sms_verification', 'verified', '建议买家完成短信验证。'],
  ['sms_verification', 'verified', '买家必须完成短信验证。'],
  ['sms_verification', 'verified', '如果已完成短信验证即可使用。', '已完成短信验证'],
  ['sms_verification', 'verified', '建议购买已完成短信验证的账号。', '已完成短信验证'],
  ['sms_verification', 'verified', '不要求已完成短信验证。', '已完成短信验证'],
  ['sms_verification', 'verified', '需要提供已完成短信验证的账号。', '已完成短信验证'],
  ['sms_verification', 'verified', '仅限已完成短信验证的用户购买。', '已完成短信验证'],
  ['sms_verification', 'verified', '以已完成短信验证为前提。', '已完成短信验证'],
  ['sms_verification', 'verified', '已完成短信验证的用户才能购买。', '已完成短信验证'],
  ['kyc', 'verified', '仅限已完成实名认证的用户购买。', '已完成实名认证'],
  ['sms_verification', 'unverified', '无需完成短信验证。'],
  ['sms_verification', 'verified', '已完成KYC实名认证。'],
  ['kyc', 'verified', '已完成短信验证。'],
  ['sms_required', '有', '买家无需完成短信验证。', '完成短信验证'],
  ['sms_required', '有', '建议买家完成短信验证。'],
  ['sms_required', '有', '如果需要完成短信验证，请联系商家。', '需要完成短信验证'],
  ['sms_required', '有', '不需要完成短信验证。', '需要完成短信验证'],
  ['sms_required', '有', '不是必须完成短信验证。', '必须完成短信验证'],
  ['sms_required', '有', '不要完成短信验证。', '完成短信验证'],
  ['kyc_required', '有', '无需完成KYC实名认证。', '完成KYC实名认证'],
  ['kyc_required', '有', '建议完成KYC实名认证。'],
  ['card_binding_required', '有', '无需绑定支付卡。', '绑定支付卡'],
  ['card_binding_required', '有', '不需要绑定支付卡。', '需要绑定支付卡'],
  ['card_binding_required', '有', '建议绑定支付卡。'],
  ['renewable', '有', '不支持订阅到期后才可续费。', '订阅到期后才可续费'],
  ['renewal_timing', 'after_expiry', '可能订阅到期后才可续费。', '订阅到期后才可续费'],
  ['renewal_timing', 'any_time', '如果随时可以续费，请联系商家。', '随时可以续费'],
  ['renewal_timing', 'any_time', '不支持随时可以续费。', '随时可以续费'],
  ['login_method', 'password', '邮箱密码只用于收信，产品登录方式未说明。', '邮箱密码'],
  ['login_method', 'password', '产品不使用密码登录。', '密码登录'],
  ['login_method', 'password', '产品不能使用密码登录。', '密码登录'],
  ['login_method', 'password', '建议产品使用密码登录。', '密码登录'],
  ['login_method', 'password', '不允许使用密码登录。', '密码登录'],
  ['login_method', 'password', '尚未启用密码登录。', '密码登录'],
  ['login_method', 'password', '关闭密码登录。', '密码登录'],
  ['login_method', 'password', '禁用密码登录。'],
  ['account_type', 'seat', '不提供家庭组共享车位。', '车位'],
  ['account_type', 'seat', '建议购买家庭组共享车位。', '车位'],
  ['account_type', 'seat', '未提供家庭组车位。', '车位'],
  ['account_type', 'seat', '非车位商品。', '车位'],
  ['account_type', 'seat', '家庭组不出售车位。', '车位'],
  ['account_type', 'seat', '家庭组不销售席位。'],
  ['account_type', 'seat', '赠送车位，实际出售的是其他商品。', '车位'],
  ['token_validity', '7 days', '订阅使用期7天。', '7天'],
  ['duration', '7 days', 'Token有效期7天。', '7天'],
  ['token_validity', '7 days', 'Token有效期约7天。', '7天'],
  ['token_validity', '7 days', 'Token有效期7天或14天。', '7天'],
  ['token_validity', '7 days', 'Token有效期7-14天。'],
  ['token_validity', '7 days', '赠送Token有效期7天。', '7天'],
  ['account_age', '2 years', '订阅使用期2年。', '2年'],
  ['account_age', '2 years', '账号号龄约2年。', '2年'],
  ['account_age', '2 years', '比较示例：账号号龄2年。', '2年'],
  ['minimum_quantity', '3', '最低购买数量并非3份。', '3份'],
  ['minimum_quantity', '3', '建议最低购买数量3份。', '3份'],
  ['minimum_quantity', '3', '库存3份。', '3份'],
  ['minimum_quantity', '3', '最低购买数量3份或5份。', '3份'],
];
for (const [name, value, source, quote = source] of negatives) {
  test(`new evidence rules reject unsupported ${name}: ${source}`, () => {
    const result = validateStandardizationTags([{ name, value, evidence: [{ path: 'sourceData.evidence', quote }] }],
      buildExtractionPayload({ name: '商品', sourceData: { evidence: source } }));
    assert.deepEqual(result.tags, []);
    assert.equal(result.rejectedTags.length, 1);
  });
}

for (const [name, quote, source] of [
  ['kyc', '已完成实名认证', '账号已完成实名认证。登录时需要使用VPN。'],
  ['kyc', '已完成实名认证', '账号已完成实名认证，不需要买家再次验证。'],
  ['sms_verification', '已完成短信验证', '账号已完成短信验证。登录时需要使用VPN。'],
  ['sms_verification', '已完成短信验证', '账号已完成短信验证，不需要买家再次验证。'],
]) {
  test(`completed verification survives unrelated requirements: ${source}`, () => {
    const proposed = [{ name: name!, value: 'verified', evidence: [{ path: 'sourceData.evidence', quote: quote! }] }];
    const result = validateStandardizationTags(proposed,
      buildExtractionPayload({ name: '商品', sourceData: { evidence: source } }));
    assert.deepEqual(result.rejectedTags, []);
    assert.deepEqual(result.tags, proposed);
  });
}

test('new evidence rules preserve selected SKU priority', () => {
  for (const [name, value, spec, evidence] of [
    ['card_binding_required', '有', '无需绑定支付卡', '激活时需要绑定支付卡'],
    ['token_validity', '7 days', 'Token有效期14天', 'Token有效期7天'],
    ['renewal_timing', 'any_time', '订阅到期后才可续费', '随时可以续费'],
    ['account_age', '2 years', '账号号龄3年', '账号号龄2年'],
  ]) {
    const result = validateStandardizationTags([{ name: name!, value: value!, evidence: [{ path: 'sourceData.evidence', quote: evidence! }] }],
      buildExtractionPayload({ name: '商品', spec, sourceData: { evidence } }));
    assert.deepEqual(result.tags, [], name);
  }
});

test('new period evidence keeps objects separate within a sentence', () => {
  const source = 'Token有效期7天，订阅使用期30天，账号号龄2年。';
  const result = validateStandardizationTags([
    { name: 'token_validity', value: '7 days', evidence: [{ path: 'sourceData.evidence', quote: 'Token有效期7天' }] },
    { name: 'duration', value: '30 days', evidence: [{ path: 'sourceData.evidence', quote: '订阅使用期30天' }] },
    { name: 'account_age', value: '2 years', evidence: [{ path: 'sourceData.evidence', quote: '账号号龄2年' }] },
  ], buildExtractionPayload({ name: '商品', sourceData: { evidence: source } }));
  assert.equal(result.tags.length, 3);
  assert.deepEqual(result.rejectedTags, []);
});

test('validation preserves a partial proposal without inventing the missing seat tag', () => {
  const sample = fixture.samples.find((sample: any) => sample.id === '1007');
  const proposed = sample.expected.filter((tag: any) => tag.name !== 'account_type').map(replayTag);
  assert.ok(proposed.length > 0);
  assert.ok(sample.expected.some((tag: any) => tag.name === 'account_type'));
  const result = validateStandardizationTags(proposed, buildExtractionPayload(sample.input));
  assert.deepEqual(result.rejectedTags, []);
  assert.deepEqual(result.tags, proposed);
});
