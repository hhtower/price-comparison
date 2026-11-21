import React, { useEffect } from 'react';
import { usePageAnalytics } from './usePageAnalytics.js';
import PurchaseGuide from './PurchaseGuide.jsx';
import { purchaseGuideReturnHref } from './purchase-guide-navigation.js';
import { PURCHASE_GUIDE_CONTENT as guide } from '@price-comparison/catalog/purchase-guide-content';

export default function PurchaseGuidePage() {
  usePageAnalytics('guide');
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
      <h1>{guide.title}</h1>
      <a className="product-back-link" href={returnHref}>{returnHref.startsWith('/products/') ? '返回商品详情' : '返回商品列表'}</a>
    </header>
    <PurchaseGuide full />
    <a className="guide-return" href={returnHref}>{returnHref.startsWith('/products/') ? '返回商品详情，继续比价' : '返回商品列表，开始选购'}<span aria-hidden="true"> →</span></a>
  </main>;
}
