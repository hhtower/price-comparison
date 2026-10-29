import React, { useEffect } from 'react';
import PurchaseGuide from './PurchaseGuide.jsx';
import { purchaseGuideReturnHref } from './purchase-guide-navigation.js';
import { PURCHASE_GUIDE_CONTENT as guide, PURCHASE_GUIDE_FIELDS, PURCHASE_GUIDE_GROUPS } from '@price-comparison/catalog/purchase-guide-content';

export default function PurchaseGuidePage() {
  const returnHref = purchaseGuideReturnHref();
  useEffect(() => {
    const revealAnchor = () => {
      const target = document.getElementById(window.location.hash.slice(1));
      const details = target?.closest('details');
      if (details) details.open = true;
      target?.scrollIntoView?.();
    };
    revealAnchor();
    window.addEventListener('hashchange', revealAnchor);
    return () => window.removeEventListener('hashchange', revealAnchor);
  }, []);
  return <main className="seo-document purchase-guide-page">
    <header className="product-page-heading guide-page-heading">
      <a className="product-back-link" href={returnHref}>{returnHref.startsWith('/products/') ? '返回商品详情' : '返回商品列表'}</a>
      <h1>{guide.title}</h1>
    </header>
    <PurchaseGuide full />
    <h2 id="guide-fields">{guide.glossaryTitle}</h2>
    <p className="guide-glossary-introduction">{guide.glossaryIntroduction}</p>
    <div className="guide-glossary">{PURCHASE_GUIDE_GROUPS.map(group => <details className="guide-card" key={group.id} id={`guide-${group.id}`}><summary>{group.label}</summary><dl className="guide-field-list">{Object.entries(PURCHASE_GUIDE_FIELDS).filter(([, field]) => field.displayGroup === group.id).map(([name, field]) => <div key={name} id={name}><dt>{field.label}</dt><dd>{field.explanation}</dd></div>)}</dl></details>)}</div>
    <a className="guide-return" href={returnHref}>{returnHref.startsWith('/products/') ? '返回商品详情，继续比价' : '返回商品列表，开始选购'}<span aria-hidden="true"> →</span></a>
  </main>;
}
