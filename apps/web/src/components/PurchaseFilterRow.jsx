import React, { useEffect, useId, useRef, useState } from 'react';

export function FilterRow({ label, unlimited, onClear, children }) {
  return <fieldset className="filter-group purchase-row"><legend>{label}</legend><div className="filter-group-content purchase-controls">
    <button type="button" className="filter-unlimited" aria-pressed={unlimited} onClick={onClear}>不限</button>{children}
  </div></fieldset>;
}

export function SearchFilterRow({ label, options, selected, onChoose, onRemove, onClear, single = false }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(8);
  const [active, setActive] = useState(-1);
  const listId = useId();
  const input = useRef(null);
  const needle = query.normalize('NFKC').trim().toLowerCase();
  const matches = !open ? [] : needle ? options.filter(option => `${option.label} ${option.keywords || ''}`.normalize('NFKC').toLowerCase().includes(needle)) : options;
  function close() { setOpen(false); setQuery(''); setActive(-1); setLimit(8); }
  function choose(key) { onChoose(key); close(); }
  useEffect(() => { if (active >= 0) document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: 'nearest' }); }, [active, listId]);
  return <FilterRow label={label} unlimited={!selected.length} onClear={() => { close(); onClear(); }}>
    <div className={`filter-picker${single && selected.length && !open ? ' shows-value' : ''}`} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) close(); }}>
      <input ref={input} role="combobox" spellCheck={false} aria-label={label} aria-autocomplete="list" aria-expanded={open} aria-controls={open ? listId : undefined} aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        placeholder={`选择或搜索${label}`} value={open ? query : single ? selected[0]?.label || '' : ''} onClick={() => setOpen(true)} onChange={event => { setQuery(event.target.value); setOpen(true); setActive(-1); setLimit(8); }} onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (!open && single && selected.length && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) event.currentTarget.select();
          if (event.key === 'Escape' && open) { event.stopPropagation(); event.preventDefault(); close(); }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault(); setOpen(true);
            const count = open ? matches.length : options.length;
            const index = count ? Math.max(0, Math.min(count - 1, active + (event.key === 'ArrowDown' ? 1 : -1))) : -1;
            setActive(index); setLimit(current => Math.max(current, index + 1));
          }
          if (event.key === 'Enter' && open && matches[active >= 0 ? active : 0]) { event.preventDefault(); choose(matches[active >= 0 ? active : 0].key); }
        }} />
      <button type="button" className="picker-toggle" tabIndex={-1} aria-label={`${open ? '收起' : '展开'}${label}`} aria-expanded={open} onMouseDown={event => event.preventDefault()} onClick={() => { input.current.focus(); if (open) close(); else setOpen(true); }}><span className="filter-chevron" aria-hidden="true" /></button>
      {open && <div id={listId} role="listbox" aria-label={label} aria-multiselectable={single ? undefined : true} className="filter-matches" onScroll={event => {
        const list = event.currentTarget;
        if (list.scrollTop + list.clientHeight >= list.scrollHeight - 4 && limit < matches.length) setLimit(limit + 8);
      }}>{matches.slice(0, limit).map((option, index) => <div role="option" aria-selected={selected.some(item => item.key === option.key)} id={`${listId}-${index}`} className={index === active ? 'is-active' : ''} key={option.key}
        onMouseDown={event => event.preventDefault()} onClick={() => choose(option.key)}>{option.label}</div>)}{!matches.length && <span role="status">无匹配选项</span>}</div>}
    </div>
    {!single && selected.map(option => <button type="button" className="filter-picked" key={option.key} aria-label={`移除${option.label}`} onClick={() => onRemove(option.key)}>{option.label} ×</button>)}
  </FilterRow>;
}
