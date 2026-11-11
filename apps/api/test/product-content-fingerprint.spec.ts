import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { productContentFingerprint } from '../src/standardization/fingerprint.js';
import { buildExtractionPayload, extractionPayloadKey } from '../src/ai/adaptive-batching.js';

const source = { name: 'ChatGPT Plus', description: '简介', spec: '期限: 1个月 / 地区: 美区', sourceCategory: '会员',
  sourceData: { content: '完整详情', usage_guide: '仅限自用', warranty_info: '保订阅28天' } };

test('one fingerprint covers exactly the four approved product fields', () => {
  for (const changed of [
    { ...source, name: 'Claude Pro' }, { ...source, description: '新正文' },
    { ...source, spec: '期限: 1年 / 地区: 美区' },
    ...['content', 'warranty_info'].map(key => ({ ...source, sourceData: { ...source.sourceData, [key]: 'changed' } })),
  ]) assert.notEqual(productContentFingerprint(changed), productContentFingerprint(source));
});

test('extra merchant context reaches the model without changing the fingerprint', () => {
  const additions = { tags: ['促销'], attributes: ['shared'], unknown: 'new', brand: 'Other', model: 'Other',
    price: 99, microPrice: 200, stock: 5, ratingText: { hash: 'changed' }, shop: { name: 'seller' }, usage_guide: 'changed' };
  assert.equal(productContentFingerprint({ ...source, sourceCategory: 'API' }), productContentFingerprint(source));
  assert.equal(productContentFingerprint({ ...source, sourceData: { ...source.sourceData, ...additions } }), productContentFingerprint(source));
  const payload = buildExtractionPayload({ id: '1', name: source.name, spec: source.spec, category: source.sourceCategory,
    description: source.description, sourceData: { ...source.sourceData, ...additions } });
  const goods = payload.sourceData as Record<string, unknown>;
  assert.equal(goods.evidence, '简介');
  assert.equal(goods.content, '完整详情');
  assert.equal(goods.warranty_info, '保订阅28天');
  assert.equal(goods.usage_guide, 'changed');
  assert.deepEqual(goods.tags, ['促销']);
  assert.deepEqual(goods.attributes, ['shared']);
  assert.equal(payload.category, '会员');
  assert.equal(payload.brand, 'Other');
  assert.equal(goods.price, undefined);
  assert.equal(goods.stock, undefined);
  assert.equal(productContentFingerprint(source), createHash('sha256').update(extractionPayloadKey(payload)).digest('hex'));
});

test('canonical formatting is stable without erasing qualifiers', () => {
  assert.equal(productContentFingerprint(source), productContentFingerprint({ ...source, spec: '地区：美区 / 期限: 1个月' }));
  assert.equal(productContentFingerprint({ name: 'Account' }), productContentFingerprint({ name: 'Account', description: '', spec: '', sourceCategory: '' }));
  assert.equal(productContentFingerprint({ name: ' Account ', description: '<p>Body</p>' }), productContentFingerprint({ name: 'Account', description: 'Body' }));
  assert.notEqual(productContentFingerprint({ name: 'Account', description: '保订阅' }), productContentFingerprint({ name: 'Account', description: '不保订阅' }));
  assert.equal(productContentFingerprint(source), productContentFingerprint({ ...source, sourceData: { warranty_info: '保订阅28天', content: '完整详情', usage_guide: '仅限自用' } }));
});
