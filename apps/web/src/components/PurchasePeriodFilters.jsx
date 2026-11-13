import React, { useState } from 'react';
import { purchaseTagLabel, tagValueKey } from '@price-comparison/catalog/purchase-attributes';

const durationKey = tag => `{"name":${JSON.stringify(tag.name)},"value":${tagValueKey(tag.value)}}`;
const commonDurations = [1, 7, 30, 90, 360, 365];
const durationGroup = value => typeof value !== 'number' ? 'qualified' : value % 365 === 0 ? 'years' : value % 30 === 0 ? 'months' : 'days';
const durationOrder = value => typeof value === 'number' ? value : value.min ?? value.days ?? Infinity;

export function DurationFilterOptions({ tags, selectedTags, onToggle }) {
  const [expanded, setExpanded] = useState(() => new Set());
  const selected = tags.filter(tag => selectedTags.has(durationKey(tag)));
  return <>
    <div className="duration-filter-summary">
      <span role="status">{selected.length ? `已选 ${selected.length} 项` : '不限'}</span>
      {selected.length ? <button type="button" className="filter-expand" aria-label="清除使用期限" onClick={() => selected.forEach(tag => onToggle(durationKey(tag)))}>清除</button> : null}
    </div>
    {['days', 'months', 'years', 'qualified'].map(unit => {
      const choices = tags.filter(tag => durationGroup(tag.value) === unit);
      if (!choices.length) return null;
      // Prefer stable common terms; use facet priority only to fill missing shortcuts.
      const common = new Set([...choices].sort((a, b) =>
        Number(commonDurations.includes(b.value)) - Number(commonDurations.includes(a.value))
        || Number(b.priority ?? 0) - Number(a.priority ?? 0) || durationOrder(a.value) - durationOrder(b.value)).slice(0, 3).map(durationKey));
      const isExpanded = expanded.has(unit);
      const visible = choices.filter(tag => isExpanded || common.has(durationKey(tag)) || selectedTags.has(durationKey(tag)))
        .sort((a, b) => durationOrder(a.value) - durationOrder(b.value));
      const label = { days: '按天', months: '按月', years: '按年', qualified: '其他期限' }[unit];
      return <div className="duration-filter-unit" role="group" aria-label={label} key={unit}>
        <span className="duration-filter-label" aria-hidden="true">{label}</span>
        <div className="duration-filter-choices filter-options">
          {visible.map(tag => {
            const key = durationKey(tag);
            const selected = selectedTags.has(key);
            return <label key={key} className={selected ? 'is-selected' : ''}><input type="checkbox" aria-label={'使用期限：' + purchaseTagLabel(tag)} checked={selected} onChange={() => onToggle(key)} /><span>{purchaseTagLabel(tag)}</span></label>;
          })}
          {isExpanded || visible.length < choices.length ? <button type="button" className="filter-expand" aria-label={(isExpanded ? '收起' : '更多期限') + '（' + label + '）'} aria-expanded={isExpanded} onClick={() => setExpanded(current => { const next = new Set(current); if (next.has(unit)) next.delete(unit); else next.add(unit); return next; })}>{isExpanded ? '收起' : '更多期限'}</button> : null}
        </div>
      </div>;
    })}
  </>;
}
