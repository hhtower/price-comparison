import React from 'react';
import ModalDialog from './components/ModalDialog.jsx';
import { PURCHASE_GUIDE_FIELDS, PURCHASE_GUIDE_GROUPS } from '@price-comparison/catalog/purchase-guide-content';
import { normalizePurchaseTag } from '@price-comparison/catalog/purchase-attributes';
import { displayPurchaseTagText, displayPurchaseTagValue } from './purchase-tag-values.js';

export function offerConditions(offer, formatValue = displayPurchaseTagValue) {
  const facts = new Map();
  for (const raw of offer.tags || []) {
    for (const tag of normalizePurchaseTag(raw)) {
      if (!tag || tag.name === 'minimum_quantity' || !PURCHASE_GUIDE_FIELDS[tag.name] || !tag.value || ['unknown', 'unspecified'].includes(tag.value)) continue;
      const value = formatValue(tag);
      facts.set(`${tag.name}:${value}`, { ...tag, value, ...PURCHASE_GUIDE_FIELDS[tag.name] });
    }
  }
  if (offer.settlementQuantity > 1) facts.set('minimum_quantity', { name: 'minimum_quantity', value: `${offer.settlementQuantity}件起购`, ...PURCHASE_GUIDE_FIELDS.minimum_quantity, summaryPriority: 0 });
  return [...facts.values()].sort((a, b) => a.summaryPriority - b.summaryPriority);
}

export default function OfferTagDetails({ offer, item, onClose, onReport, formatValue }) {
  const facts = offerConditions(offer, formatValue);
  return <ModalDialog open className="offer-tag-details" aria-labelledby="offer-tag-details-title" onClose={onClose}>
    <header className="dialog-header"><div className="offer-tag-details-summary"><h2 id="offer-tag-details-title" title={offer.name || item.name}>{offer.name || item.name}</h2><p>{offer.shop || '未知商铺'}{offer.independentShop ? <span className="offer-shop-risk-note"> · 自建站，风险相对更高</span> : ''}{offer.spec ? ` · ${offer.spec}` : ''}</p></div><button type="button" aria-label="关闭商品说明" onClick={onClose}>×</button></header>
    <div className="offer-tag-details-body" tabIndex={0} role="region" aria-label="商品条件">
      {facts.length ? <div className="offer-tag-details-groups">{PURCHASE_GUIDE_GROUPS.filter(group => facts.some(fact => fact.displayGroup === group.id)).map(group => <section key={group.id}><h3>{group.label}</h3>
        <ul>{facts.filter(fact => fact.displayGroup === group.id).map(fact => <li key={`${fact.name}:${fact.value}`} aria-label={`${fact.label}：${fact.value}`}>{displayPurchaseTagText(fact, fact.value)}</li>)}</ul>
      </section>)}</div> : <p className="offer-tag-details-empty">暂无商品条件信息</p>}
    </div>
    <footer className="offer-tag-details-actions"><button type="button" className="text-button" onClick={() => onReport(offer)}>举报此报价</button><button type="button" className="primary-button" onClick={onClose}>确认</button></footer>
  </ModalDialog>;
}
