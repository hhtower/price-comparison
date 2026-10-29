import assert from 'node:assert/strict';
import test from 'node:test';
import { buildExtractionPayload } from '../src/ai/adaptive-batching.js';
import { validateTagExtractionDecision } from '../src/ai/tag-extraction-result.js';

const name = 'G free普号 | 微软 | 高存活率,超稳定 | 账密+2fa | AT | 生图 | 一号一住宅ip | 未接';
const promotion = 'plus代充链接，一对一教学，小白友好版： https://wzyp.cn/item/m6u9gv\n\n86块plus，30天质保，已开账密2fa的，可以qq联系！';
const tag = (name: string, value: string, quote: string, path = 'sourceData.evidence') =>
  ({ name, value, evidence: [{ path, quote }] });
const advertised = [
  tag('delivery', 'top_up', 'plus代充链接'),
  tag('warranty', 'covered', '30天质保'),
  tag('warranty_days', '30', '30天质保'),
  tag('2fa', '有', '已开账密2fa'),
  tag('delivery_format', 'credentials', '已开账密2fa'),
];

test('linked Plus promotion cannot supply tags for the Free account being sold', () => {
  const ownTags = [tag('2fa', '有', '账密+2fa', 'name'), tag('delivery_format', 'credentials', '账密', 'name')];
  const payload = buildExtractionPayload({ id: '1', name, spec: '', sourceData: { evidence: promotion } });
  const result = validateTagExtractionDecision(1n, [...ownTags, ...advertised.filter(t => t.name !== '2fa')], payload);
  assert.deepEqual(result.tags, ownTags);
  assert.equal(result.rejectedTags.length, 4);
});

for (const path of ['sourceData.evidence', 'sourceData.description', 'evidence']) {
  test(`promotion context survives blank lines and clipped citations in ${path}`, () => {
    const payload = path === 'evidence' ? { name, evidence: promotion }
      : { name, sourceData: { [path.split('.')[1]!]: promotion } };
    const proposed = advertised.map(t => ({ ...t, evidence: [{ ...t.evidence[0]!, path }] }));
    const result = validateTagExtractionDecision(1n, proposed, payload);
    assert.deepEqual(result.tags, []);
    assert.equal(result.rejectedTags.length, proposed.length);
  });
}

test('HTML paragraph projection retains the promotion boundary', () => {
  const payload = buildExtractionPayload({ id: '1', name, spec: '',
    sourceData: { evidence: '<p>plus代充链接，一对一教学：https://wzyp.cn/item/m6u9gv</p><p>30天质保，已开账密2fa。</p>' } });
  const result = validateTagExtractionDecision(1n, advertised.slice(0, 3), payload);
  assert.deepEqual(result.tags, []);
});

test('current-item facts before and explicitly after a promotion remain usable', () => {
  for (const source of [
    `本商品质保7天，自动发货。\n${promotion}`,
    `${promotion}\n本商品质保7天，自动发货。`,
    `本商品质保7天，自动发货。推荐商品：Plus代充，30天质保。`,
  ]) {
    const proposed = [tag('warranty', 'covered', '质保7天'), tag('warranty_days', '7', '质保7天'),
      tag('delivery_mode', 'automatic', '自动发货')];
    const result = validateTagExtractionDecision(1n, proposed, { name, sourceData: { evidence: source } });
    assert.deepEqual(result.rejectedTags, [], source);
    assert.deepEqual(result.tags, proposed, source);
  }
});

test('promotion warranty conditions cannot invalidate current-item coverage', () => {
  const source = '本商品质保7天。\n推荐商品：Plus代充，链接 https://wzyp.cn/item/m6u9gv\n仅首登质保24小时，封号不保。';
  const proposed = [tag('warranty', 'covered', '质保7天'), tag('warranty_days', '7', '质保7天')];
  const result = validateTagExtractionDecision(1n, proposed, { name, sourceData: { evidence: source } });
  assert.deepEqual(result.rejectedTags, []);
  assert.deepEqual(result.tags, proposed);
});

test('rejected promotion tags cannot conflict with supported current-item tags', () => {
  const source = `本商品交付成品账号，质保7天。\n${promotion}`;
  const ownTags = [tag('delivery', 'account', '交付成品账号'), tag('warranty', 'covered', '质保7天'),
    tag('warranty_days', '7', '质保7天')];
  const result = validateTagExtractionDecision(1n, [...ownTags, ...advertised.slice(0, 3)],
    { name, sourceData: { evidence: source } });
  assert.deepEqual(result.tags, ownTags);
  assert.equal(result.rejectedTags.length, 3);
});

test('an inline other-product offer cannot inherit the opening current-item subject', () => {
  const source = '本商品为Free账号，另售Plus代充，30天质保。';
  const proposed = [tag('delivery', 'top_up', 'Plus代充'), tag('warranty', 'covered', '30天质保'),
    tag('warranty_days', '30', '30天质保')];
  const result = validateTagExtractionDecision(1n, proposed, { name: 'Free账号', sourceData: { evidence: source } });
  assert.deepEqual(result.tags, []);
  assert.equal(result.rejectedTags.length, proposed.length);
});

test('a later promotion cannot erase an earlier warranty exclusion or condition', () => {
  for (const qualifier of ['封号不保', '修改密码不保']) for (const offer of [
    '其他商品请联系。', 'plus代充链接：https://wzyp.cn/item/m6u9gv',
  ]) {
    const source = `本商品质保7天。${qualifier}，${offer}`;
    const proposed = [tag('warranty', 'covered', '质保7天'), tag('warranty_days', '7', '质保7天')];
    const result = validateTagExtractionDecision(1n, proposed, { name, sourceData: { evidence: source } });
    assert.deepEqual(result.tags, [], qualifier);
  }
});

test('the product title itself is current-item evidence even when it names a recharge link', () => {
  const proposed = [tag('delivery', 'top_up', 'Plus代充链接', 'name')];
  const result = validateTagExtractionDecision(1n, proposed, { name: 'Plus代充链接' });
  assert.deepEqual(result.rejectedTags, []);
  assert.deepEqual(result.tags, proposed);
});

test('an ordinary purchase or tutorial link does not discard actual product tags', () => {
  for (const source of [
    '本商品为Plus代充，30天质保。\n本商品代充链接：https://wzyp.cn/item/m6u9gv',
    'Plus代充链接：https://wzyp.cn/item/m6u9gv\n30天质保。',
    '购买链接：https://wzyp.cn/item/m6u9gv\nPlus代充，30天质保。',
    '使用教程：https://example.com/help\nPlus代充，30天质保。',
  ]) {
    const proposed = [tag('delivery', 'top_up', 'Plus代充'), tag('warranty', 'covered', '30天质保'),
      tag('warranty_days', '30', '30天质保')];
    const result = validateTagExtractionDecision(1n, proposed, { name: 'Plus代充', sourceData: { evidence: source } });
    assert.deepEqual(result.rejectedTags, [], source);
    assert.deepEqual(result.tags, proposed, source);
  }
});
