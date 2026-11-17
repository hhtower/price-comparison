import React, { useState } from 'react';
import { expect, test } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { normalizePurchaseTag } from '@price-comparison/catalog/purchase-attributes';
import { PRODUCT_TAG_RULES } from '@price-comparison/catalog/product-tag-policy';
import PurchaseTagEditor from './PurchaseTagEditor.jsx';

function Editor({ initial = { name: 'duration', value: 30 } }) {
  const [tag, setTag] = useState(initial);
  return <><PurchaseTagEditor tag={tag} onChange={setTag} /><output aria-label="结果">{JSON.stringify(tag)}</output><output aria-label="有效">{String(normalizePurchaseTag(tag).length === 1)}</output></>;
}
test('offers current fields and submits fractional numeric days', () => {
  render(<Editor />);
  expect(screen.getByRole('combobox', { name: '标签名称 1' }).options).toHaveLength(10);
  fireEvent.change(screen.getByRole('spinbutton', { name: '使用天数 1' }), { target: { value: '0.5' } });
  expect(JSON.parse(screen.getByLabelText('结果').textContent)).toEqual({ name: 'duration', value: 0.5 });
  expect(screen.getByLabelText('有效')).toHaveTextContent('true');
  fireEvent.change(screen.getByRole('spinbutton', { name: '使用天数 1' }), { target: { value: '0' } });
  expect(screen.getByLabelText('有效')).toHaveTextContent('false');
});
test.each(['subscription_warranty', 'usage_warranty'])('edits canonical %s values without a preset value list', name => {
  expect(PRODUCT_TAG_RULES[name].multiple).not.toBe(true);
  render(<Editor initial={{ name, value: '' }} />);
  fireEvent.change(screen.getByRole('textbox', { name: '标签值 1' }), { target: { value: '质保 2.5 小时' } });
  expect(JSON.parse(screen.getByLabelText('结果').textContent)).toEqual({ name, value: '质保 2.5 小时' });
  expect(screen.getByLabelText('有效')).toHaveTextContent('true');
  const names = [...screen.getByRole('combobox', { name: '标签名称 1' }).options].map(option => option.value);
  expect(names).not.toContain('warranty');
  expect(names).not.toContain('warranty_terms');
});
test.each(['range', 'min', 'max', 'approx', 'permanent'])('keeps %s as a structured duration', kind => {
  render(<Editor />);
  fireEvent.change(screen.getByRole('combobox', { name: '期限限定 1' }), { target: { value: kind } });
  expect(JSON.parse(screen.getByLabelText('结果').textContent).value.kind).toBe(kind);
  expect(screen.getByLabelText('有效')).toHaveTextContent('true');
  if (kind === 'range') {
    fireEvent.change(screen.getByRole('spinbutton', { name: '最少天数 1' }), { target: { value: '100' } });
    expect(screen.getByLabelText('有效')).toHaveTextContent('false');
  }
});
test('offers only the negative subscription fact and distinct bulk meanings', () => {
  render(<Editor initial={{ name: 'subscription_override', value: '无' }} />);
  expect([...screen.getByRole('combobox', { name: '标签值 1' }).options].map(option => option.value)).toEqual(['', '无']);
  fireEvent.change(screen.getByRole('combobox', { name: '标签名称 1' }), { target: { value: 'bulk_purchase' } });
  expect([...screen.getByRole('combobox', { name: '标签值 1' }).options].map(option => option.text)).toEqual(['选择标签值', '支持批量购买', '需批量购买', '打包出售']);
});
test.each([
  ['subscription_warranty', '质保 12 天', true],
  ['subscription_warranty', '质保（期限未注明）', true],
  ['usage_warranty', '首登', true],
  ['subscription_warranty', '首登', false],
  ['usage_warranty', '质保 0 小时', false],
  ['usage_warranty', '质保 -1 天', false],
  ['usage_warranty', '质保 1e309 天', false],
  ['usage_warranty', '首登保障', false],
  ['subscription_warranty', '订阅保障30天', false],
  ['warranty_terms', '保订阅30天', false],
])('validates %s %s against the final warranty contract', (name, value, valid) => {
  render(<Editor initial={{ name, value }} />);
  expect(screen.getByLabelText('有效')).toHaveTextContent(String(valid));
});
