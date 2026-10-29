import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSpec, specificationParts, specificationText } from '../src/products/product-spec.js';

test('canonical spec normalizes text and keeps unlabeled sale wording intact', () => {
  assert.equal(normalizeSpec(), '');
  assert.equal(normalizeSpec('  Ｍｏｎｔｈｌｙ \n '), 'Monthly');
  assert.equal(normalizeSpec('邮箱 / 密码'), '邮箱 / 密码');
  assert.equal(normalizeSpec('期限： 1个月 / 地区: 美区'), '地区: 美区 / 期限: 1个月');
  assert.equal(normalizeSpec('期限: 1个月 / 期限: 1个月'), '期限: 1个月');
  assert.throws(() => normalizeSpec('期限: 1个月 / 期限: 1年'), /conflicting/);
  assert.throws(() => normalizeSpec({ term: 'month' }), /string/);
});

test('adapter specifications use stable labels, drop empty entries and detect conflicts', () => {
  const expected = '地区: 美区 / 期限: 1个月';
  assert.equal(specificationText({ 期限: '1个月', 地区: '美区', empty: '' }), expected);
  assert.equal(specificationText([{ name: '期限', value: '1个月' }, { name: '地区', value: '美区' }]), expected);
  assert.equal(specificationText([{ name: '期限', value: '1个月' }, { name: '期限', value: '1个月' }]), '期限: 1个月');
  assert.equal(specificationText({}), '');
  assert.equal(specificationText('月卡'), '月卡');
  assert.throws(() => specificationText([{ name: '期限', value: '1个月' }, { name: '期限', value: '1年' }]), /conflicting/);
  assert.throws(() => specificationText({ 期限: { unsupported: 'nested' } }), /scalar/);
  assert.throws(() => specificationText(true), /specification/);
});

test('spec encoding preserves separator characters without collisions or a second-parse change', () => {
  for (const options of [{ a: 'x / b: y' }, { 'a: b': 'c' }, { a: 'x / a: y' }, { 'a/b': 'c' }, { a: '"quoted"' }]) {
    const spec = specificationText(options);
    assert.equal(normalizeSpec(spec), spec);
    assert.equal(normalizeSpec(normalizeSpec(spec)), spec);
  }
  assert.notEqual(specificationText({ a: 'x / b: y' }), specificationText({ a: 'x', b: 'y' }));
  assert.notEqual(specificationText({ 'a: b': 'c' }), specificationText({ a: 'b: c' }));
  assert.deepEqual(specificationParts(specificationText({ a: 'x / b: y', c: 'z' })), ['a: "x / b: y"', 'c: z']);
  assert.deepEqual(specificationParts('普通文字 / 保留'), ['普通文字 / 保留']);
});
