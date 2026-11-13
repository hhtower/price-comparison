import React, { useState } from 'react';
import { expect, test } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { normalizePurchaseTag } from '@price-comparison/catalog/purchase-attributes';
import PurchaseTagEditor from './PurchaseTagEditor.jsx';

function Editor({ initial = { name: 'duration', value: 30 } }) {
  const [tag, setTag] = useState(initial);
  return <><PurchaseTagEditor tag={tag} onChange={setTag} /><output aria-label="结果">{JSON.stringify(tag)}</output><output aria-label="有效">{String(normalizePurchaseTag(tag).length === 1)}</output></>;
}
test('uses the eight valid fields and submits fractional numeric days', () => {
  render(<Editor />);
  expect(screen.getByRole('combobox', { name: '标签名称 1' }).options).toHaveLength(9);
  fireEvent.change(screen.getByRole('spinbutton', { name: '使用天数 1' }), { target: { value: '0.5' } });
  expect(JSON.parse(screen.getByLabelText('结果').textContent)).toEqual({ name: 'duration', value: 0.5 });
  expect(screen.getByLabelText('有效')).toHaveTextContent('true');
  fireEvent.change(screen.getByRole('spinbutton', { name: '使用天数 1' }), { target: { value: '0' } });
  expect(screen.getByLabelText('有效')).toHaveTextContent('false');
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
test('preserves warranty scope, timing and exclusions as one bounded text field', () => {
  render(<Editor initial={{ name: 'warranty', value: '购买后1小时内仅保首登，封号不保' }} />);
  expect(screen.getByRole('textbox', { name: '标签值 1' })).toHaveValue('购买后1小时内仅保首登，封号不保');
  expect(screen.getByRole('textbox', { name: '标签值 1' })).toHaveAttribute('maxlength', '250');
  expect(screen.getByLabelText('有效')).toHaveTextContent('true');
});
