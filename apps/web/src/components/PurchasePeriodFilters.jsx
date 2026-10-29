import React, { useId, useState } from 'react';
import { purchaseTagLabel } from '@price-comparison/catalog/purchase-attributes';

const durationKey = tag => JSON.stringify({ name: tag.name, value: tag.value });
const commonDurations = { days: [1, 7, 30], months: [1, 3, 12] };
const warrantyPresets = [7, 15, 30, 90];

export function isValidWarrantyMinimum(value) {
  return value === '' || (/^[0-9]+$/u.test(value) && Number(value) >= 1 && Number(value) <= 36500);
}

export function DurationFilterOptions({ tags, selectedTags, onToggle }) {
  const [expanded, setExpanded] = useState(() => new Set());
  const selected = tags.filter(tag => selectedTags.has(durationKey(tag)));
  return <>
    <div className="duration-filter-summary">
      <span role="status">{selected.length ? `已选 ${selected.length} 项` : '不限'}</span>
      {selected.length ? <button type="button" className="filter-expand" aria-label="清除订阅时长" onClick={() => selected.forEach(tag => onToggle(durationKey(tag)))}>清除</button> : null}
    </div>
    {['days', 'months'].map(unit => {
      const choices = tags.filter(tag => unit === 'days' ? tag.value.endsWith(' days') : / months?$/u.test(tag.value));
      if (!choices.length) return null;
      // Prefer stable common terms; use facet priority only to fill missing shortcuts.
      const common = new Set([...choices].sort((a, b) =>
        Number(commonDurations[unit].includes(Number.parseInt(b.value))) - Number(commonDurations[unit].includes(Number.parseInt(a.value)))
        || Number(b.priority ?? 0) - Number(a.priority ?? 0) || Number.parseInt(a.value) - Number.parseInt(b.value)).slice(0, 3).map(durationKey));
      const isExpanded = expanded.has(unit);
      const visible = choices.filter(tag => isExpanded || common.has(durationKey(tag)) || selectedTags.has(durationKey(tag)))
        .sort((a, b) => Number.parseInt(a.value) - Number.parseInt(b.value));
      const label = unit === 'days' ? '按天' : '按月';
      return <div className="duration-filter-unit" role="group" aria-label={label} key={unit}>
        <span className="duration-filter-label" aria-hidden="true">{label}</span>
        <div className="duration-filter-choices filter-options">
          {visible.map(tag => {
            const key = durationKey(tag);
            const selected = selectedTags.has(key);
            return <label key={key} className={selected ? 'is-selected' : ''}><input type="checkbox" aria-label={'订阅时长：' + purchaseTagLabel(tag)} checked={selected} onChange={() => onToggle(key)} /><span>{purchaseTagLabel(tag)}</span></label>;
          })}
          {isExpanded || visible.length < choices.length ? <button type="button" className="filter-expand" aria-label={(isExpanded ? '收起' : '更多期限') + '（' + label + '）'} aria-expanded={isExpanded} onClick={() => setExpanded(current => { const next = new Set(current); if (next.has(unit)) next.delete(unit); else next.add(unit); return next; })}>{isExpanded ? '收起' : '更多期限'}</button> : null}
        </div>
      </div>;
    })}
  </>;
}

export function WarrantyFilter({ choices, selectedTags, value, onChange }) {
  const valid = isValidWarrantyMinimum(value);
  const id = useId();
  const periodKey = durationKey({ name: 'warranty_scope', value: 'period' });
  const selected = value ? periodKey : choices.find(choice => choice.name === 'warranty_scope' && selectedTags.has(choice.key))?.key
    || choices.find(choice => selectedTags.has(choice.key))?.key || '';
  const [custom, setCustom] = useState(false);
  const showCustom = custom || Boolean(value && !warrantyPresets.includes(Number(value)));
  const change = (key, days = '') => {
    const tags = new Set([...selectedTags].filter(tag => !['warranty', 'warranty_scope', 'warranty_days'].includes(JSON.parse(tag).name)));
    // A minimum already implies period coverage; avoid a redundant query condition.
    if (key && !days) tags.add(key);
    onChange(days, tags);
  };
  return <>
    <div className="filter-options">
      {[{ key: '', label: '不限', ariaLabel: '质保要求不限' }, ...choices].map(({ key, label, ariaLabel }) => <label key={key} className={selected === key ? 'is-selected' : ''}>
        <input type="radio" name={id + '-type'} aria-label={ariaLabel || label} checked={selected === key} onChange={() => { setCustom(false); change(key); }} />
        <span>{label}</span>
      </label>)}
    </div>
    {selected === periodKey ? <div className="warranty-minimum" role="group" aria-label="最低质保天数">
      <span className="warranty-minimum-title">最低质保天数</span>
      <div className="filter-options">
        {['', ...warrantyPresets.map(String)].map(days => <label key={days} className={!showCustom && value === days ? 'is-selected' : ''}>
          <input type="radio" name={id + '-days'} aria-label={days ? '至少' + days + '天' : '最低质保天数不限'} checked={!showCustom && value === days} onChange={() => { setCustom(false); change(periodKey, days); }} />
          <span>{days ? days + '天' : '不限'}</span>
        </label>)}
        <label className={showCustom ? 'is-selected' : ''}>
          <input type="radio" name={id + '-days'} aria-label="自定义最低质保天数" checked={showCustom} onChange={() => setCustom(true)} />
          <span>自定义</span>
        </label>
      </div>
      {showCustom ? <label className="warranty-custom-days">至少<input type="text" inputMode="numeric" pattern="[0-9]*" aria-label="自定义最低质保天数" aria-invalid={!valid} aria-describedby={valid ? undefined : id + '-error'} placeholder="最低天数" value={value} onChange={event => change(periodKey, event.target.value)} />天</label> : null}
      {!valid ? <p id={id + '-error'} className="filter-period-hint is-error" role="alert">请输入1至36500的整数天数，留空表示不限。</p> : null}
    </div> : null}
  </>;
}
