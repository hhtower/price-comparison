import React from 'react';

export function Pagination({ total, page, pageSize, onChange, label = '数据', disabled = false }) {
  if (!total) return null;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="pagination" aria-label={`${label}分页`}>
      <button type="button" data-page-prev disabled={disabled || page <= 1} onClick={() => onChange(Math.max(1, page - 1))}>上一页</button>
      <span>第 {page} / {totalPages} 页，共 {total} 条</span>
      <button type="button" data-page-next disabled={disabled || page >= totalPages} onClick={() => onChange(Math.min(totalPages, page + 1))}>下一页</button>
    </div>
  );
}

export function IconButton({ action, id, label, icon, onClick }) {
  const paths = {
    'eye': <><path d="M2.5 12s3.5-5 9.5-5 9.5 5 9.5 5-3.5 5-9.5 5-9.5-5-9.5-5Z" /><circle cx="12" cy="12" r="2.5" /></>,
    'merge': <><path d="M7 5v4a3 3 0 0 0 3 3h4a3 3 0 0 1 3 3v4" /><path d="m14 16 3 3 3-3" /><path d="M7 5h.01" /></>,
    'pencil': <><path d="m4 16-.8 4.8L8 20l10.9-10.9a2.1 2.1 0 0 0-3-3L4 16Z" /><path d="m14.5 7.5 2 2" /></>,
    'link': <><path d="M10 13.5a4 4 0 0 0 5.7.1l2.1-2.1a4 4 0 0 0-5.7-5.7L11 6.9" /><path d="M14 10.5a4 4 0 0 0-5.7-.1l-2.1 2.1a4 4 0 0 0 5.7 5.7L13 17.1" /></>,
  };
  return (
    <button
      type="button"
      className={`icon-button ${icon === 'trash-2' ? 'danger-text' : ''}`}
      title={label}
      aria-label={label}
      onClick={() => onClick(action, id)}
    >
      <span className="action-icon" aria-hidden="true">
        {icon === 'rotate-ccw' ? (
          <svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></svg>
        ) : paths[icon] ? (
          <svg viewBox="0 0 24 24">{paths[icon]}</svg>
        ) : (
          <svg viewBox="0 0 24 24"><path d="M4 7h16" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M6 7l1 13h10l1-13" /><path d="M9 7V4h6v3" /></svg>
        )}
      </span>
    </button>
  );
}

export function EmptyState({ children }) {
  return <p className="empty-state">{children}</p>;
}
