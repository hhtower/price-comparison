import React from 'react';
import { PURCHASE_ATTRIBUTE_DEFINITIONS, purchaseTagLabel } from '@price-comparison/catalog/purchase-attributes';
import { PURCHASE_GUIDE_FIELDS } from '@price-comparison/catalog/purchase-guide-content';

export default function PurchaseTagEditor({ tag, onChange, index = 1 }) {
  const definition = PURCHASE_ATTRIBUTE_DEFINITIONS.find(field => field.name === tag.name);
  const rule = PURCHASE_GUIDE_FIELDS[tag.name]?.rule;
  const kind = typeof tag.value === 'object' ? tag.value.kind : 'exact';
  const numberInput = (value, key, label) => <label>{label}<input type="number" step="any" min="0" max="36500" required aria-label={`${label} ${index}`} value={value ?? ''} onChange={event => {
    const number = event.target.value === '' ? '' : Number(event.target.value);
    onChange({ ...tag, value: key ? { ...tag.value, [key]: number } : number });
  }} /></label>;
  return <>
    <select aria-label={`标签名称 ${index}`} required value={tag.name} onChange={event => {
      const name = event.target.value;
      onChange({ name, value: name === 'duration' ? 30 : '' });
    }}>
      <option value="">选择标签</option>
      {PURCHASE_ATTRIBUTE_DEFINITIONS.map(field => <option key={field.name} value={field.name}>{field.label}</option>)}
    </select>
    <div className="purchase-tag-editor-value">{tag.name === 'duration' ? <>
      <select aria-label={`期限限定 ${index}`} value={kind} onChange={event => {
        const next = event.target.value;
        onChange({ ...tag, value: next === 'exact' ? 30 : next === 'permanent' ? { kind: next } : next === 'range' ? { kind: next, min: 30, max: 90 } : { kind: next, days: 30 } });
      }}>
        {Object.entries({ exact: '精确', range: '范围', min: '至少', max: '最多', approx: '约', permanent: '永久' }).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      {kind === 'exact' ? numberInput(tag.value, null, '使用天数') : kind === 'range' ? <>{numberInput(tag.value.min, 'min', '最少天数')}{numberInput(tag.value.max, 'max', '最多天数')}</> : kind !== 'permanent' ? numberInput(tag.value.days, 'days', '使用天数') : null}
    </> : rule?.values ? <select aria-label={`标签值 ${index}`} required value={tag.value} onChange={event => onChange({ ...tag, value: event.target.value })}>
      <option value="">选择标签值</option>
      {rule.values.map(value => <option key={value} value={value}>{purchaseTagLabel({ name: tag.name, value })}</option>)}
    </select> : <input aria-label={`标签值 ${index}`} required value={typeof tag.value === 'string' ? tag.value : ''} maxLength={250} list={definition?.values.length ? `tag-values-${tag.name}-${index}` : undefined} placeholder={tag.name === 'warranty' ? '完整保障说明，保留期限、范围和免责' : '标签值'} onChange={event => onChange({ ...tag, value: event.target.value })} />}
    {!rule?.values && definition?.values.length > 0 && tag.name !== 'duration' ? <datalist id={`tag-values-${tag.name}-${index}`}>{definition.values.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}</datalist> : null}</div>
  </>;
}
