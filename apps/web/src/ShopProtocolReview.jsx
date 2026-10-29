import React, { useState } from 'react';
import { formatTime } from './api.js';
import './shop-protocols.css';

export default function ShopProtocolReview({ item, protocols, onReview, selected = false, onSelect, disabled = false }) {
  const [selection, setSelection] = useState('');
  const [busy, setBusy] = useState(false);
  const locked = busy || disabled;

  const review = async action => {
    setBusy(true);
    try { await onReview(item.id, action, action === 'approve' ? selection || undefined : undefined); }
    finally { setBusy(false); }
  };

  return <tr className={selected ? 'is-selected' : undefined}>
    <td className='selection-column'><input type='checkbox' aria-label={`选择商铺 ${item.name}`} checked={selected} disabled={locked} onChange={event => onSelect?.(event.target.checked)} /></td>
    <td className='shop-cell'>
      <strong title={item.name}>{item.name}</strong>
      <a className='table-url' href={item.url} target='_blank' rel='noreferrer' title={item.url}>{item.url.replace(/^https?:\/\//, '')}</a>
      {item.platform ? <small>{item.platform}</small> : null}
    </td>
    <td className='protocol-review-main'>
      <div className='protocol-picker'>
        <label><select aria-label='采集协议' value={selection} disabled={locked} onChange={event => setSelection(event.target.value)}>
          <option value=''>自动识别</option>
          {protocols.map(protocol => <option key={protocol.id} value={protocol.id}>{protocol.name}</option>)}
        </select></label>
      </div>
      {busy ? <p role='status' className='protocol-status'>正在验证协议并审核…</p> : null}
    </td>
    <td className='table-time'>{formatTime(item.createdAt ?? item.created_at)}</td>
    <td><div className='row-actions'>
      <button type='button' className='quiet-button' disabled={locked} onClick={() => review('approve')}>通过并抓取</button>
      <button type='button' className='quiet-button danger-text' disabled={locked} onClick={() => review('reject')}>拒绝</button>
    </div></td>
  </tr>;
}
