import React from 'react';
import logoUrl from './assets/logo.svg';

export { logoUrl };

export default function Brand({ admin = false, className = '' }) {
  const classes = ['brand', 'brand-with-logo', className].filter(Boolean).join(' ');
  return (
    <a className={classes} href="/" aria-label="知途 · 拾价">
      <img className="brand-mark" src={logoUrl} alt="" aria-hidden="true" />
      <span className="brand-copy">知途 · 拾价</span>
      {admin ? <span className="brand-role">ADMIN</span> : null}
    </a>
  );
}
