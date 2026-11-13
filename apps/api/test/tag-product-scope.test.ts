import assert from 'node:assert/strict';
import test from 'node:test';
import { buildExtractionPayload } from '../src/ai/adaptive-batching.js';
import { validateTagExtractionDecision } from '../src/ai/tag-extraction-result.js';

const name = 'Free账号 已接码';
const promotion = 'plus代充链接：https://example.invalid/offer\n\n30天质保，美区账号。';
const tag = (name: string, value: string, quote: string, path = 'sourceData.evidence') =>
  ({ name, value, evidence: [{ path, quote }] });
const advertised = [tag('region', 'us', '美区'), tag('warranty', '30天质保', '30天质保')];

test('linked promotion cannot supply tags for the current account', () => {
  const own = tag('sms_verification', 'verified', '已接码', 'name');
  const result = validateTagExtractionDecision(1n, [own, ...advertised], { name, sourceData: { evidence: promotion } });
  assert.deepEqual(result.tags, [own]);
  assert.equal(result.rejectedTags.length, 2);
});

for (const path of ['sourceData.evidence', 'sourceData.description', 'evidence']) {
  test(`promotion scope survives blank lines and clipped citations in ${path}`, () => {
    const payload = path === 'evidence' ? { name, evidence: promotion } : { name, sourceData: { [path.split('.')[1]!]: promotion } };
    const result = validateTagExtractionDecision(1n, advertised.map(t => ({ ...t, evidence: [{ ...t.evidence[0]!, path }] })), payload);
    assert.deepEqual(result.tags, []);
    assert.equal(result.rejectedTags.length, 2);
  });
}

test('HTML paragraph projection retains promotion scope', () => {
  const payload = buildExtractionPayload({ id: '1', name, spec: '', sourceData: { evidence:
    '<p>plus代充链接：https://example.invalid/offer</p><p>30天质保，美区账号。</p>' } });
  assert.deepEqual(validateTagExtractionDecision(1n, advertised, payload).tags, []);
});

for (const source of [
  `本商品质保7天。\n${promotion}`, `${promotion}\n本商品质保7天。`,
  '本商品质保7天。推荐商品：Plus代充，30天质保，封号不保。',
]) test(`current item coverage survives unrelated promotion: ${source}`, () => {
  const own = tag('warranty', '质保7天', '质保7天');
  const result = validateTagExtractionDecision(1n, [own, ...advertised], { name, sourceData: { evidence: source } });
  assert.deepEqual(result.tags, [own]);
});

test('inline other-product facts cannot inherit the current subject', () => {
  const result = validateTagExtractionDecision(1n, advertised, { name, sourceData: { evidence: '本商品为Free账号，另售美区账号，30天质保。' } });
  assert.deepEqual(result.tags, []);
});

for (const qualifier of ['封号不保', '修改密码不保']) test(`later promotion cannot erase a coverage exclusion: ${qualifier}`, () => {
  const evidence = `本商品质保7天。${qualifier}，其他商品请联系。`;
  assert.deepEqual(validateTagExtractionDecision(1n, [tag('warranty', '质保7天', '质保7天')], { name, sourceData: { evidence } }).tags, []);
});

for (const [source, promise] of [
  ['本商品为Plus代充，30天质保。\n本商品代充链接：https://example.invalid/', '本商品为Plus代充，30天质保'],
  ['Plus代充链接：https://example.invalid/\n30天质保。', '30天质保'],
  ['购买链接：https://example.invalid/\nPlus代充，30天质保。', 'Plus代充，30天质保'],
  ['使用教程：https://example.invalid/\nPlus代充，30天质保。', 'Plus代充，30天质保'],
] as const) test(`current recharge links do not hide actual coverage: ${source}`, () => {
  const own = tag('warranty', promise, promise);
  assert.deepEqual(validateTagExtractionDecision(1n, [own], { name: 'Plus代充', sourceData: { evidence: source } }).tags, [own]);
});
