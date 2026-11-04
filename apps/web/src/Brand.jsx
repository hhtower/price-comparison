import React from 'react';
import { SITE_NAME } from '@price-comparison/catalog/site-brand';
import logoUrl from './assets/logo.svg';

export { logoUrl };

export default function Brand({ admin = false, className = '' }) {
  const classes = ['brand', 'brand-with-logo', className].filter(Boolean).join(' ');
  return (
    <a className={classes} href="/" aria-label={SITE_NAME}>
      <img className="brand-mark" src={logoUrl} alt="" aria-hidden="true" />
      <span className="brand-copy">{SITE_NAME}</span>
      {admin ? <span className="brand-role">ADMIN</span> : null}
    </a>
  );
}
