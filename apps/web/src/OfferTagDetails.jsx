import React from 'react';
import ModalDialog from './components/ModalDialog.jsx';
import { PURCHASE_GUIDE_FIELDS, PURCHASE_GUIDE_GROUPS } from '@price-comparison/catalog/purchase-guide-content';
import { normalizePurchaseTag, purchaseWarrantyLabel } from '@price-comparison/catalog/purchase-attributes';
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

const OFFER_SUMMARY_PRIORITY = { warranty: -5, access: -4, delivery: -3, account_type: -2, account_lifecycle: -1 };

export function OfferFacts({ tags, settlementQuantity, formatValue = displayPurchaseTagValue }) {
  const visibleTags = (tags || []).filter(tag => !(tag.name === 'account_type' && ['personal', 'enterprise'].includes(tag.value)));
  const facts = offerConditions({ tags: visibleTags, settlementQuantity }, formatValue).filter(fact => fact.displayGroup !== 'warranty');
  const warranty = purchaseWarrantyLabel(tags || []);
  if (warranty) facts.push({ name: 'warranty', value: warranty, summaryPriority: 30 });
  const values = facts.sort((a, b) => (OFFER_SUMMARY_PRIORITY[a.name] ?? a.summaryPriority)
    - (OFFER_SUMMARY_PRIORITY[b.name] ?? b.summaryPriority)).map(fact => ({
    key: `${fact.name}:${fact.value}`, text: displayPurchaseTagText(fact, fact.value), group: fact.displayGroup, warranty: fact.name === 'warranty',
  }));
  return values.length ? <div className="offer-facts" role="group" tabIndex={0} aria-label="商品标签">
    {values.slice(0, 3).map(value => <span key={value.key} className={value.warranty ? 'offer-warranty' : undefined} data-group={value.group} title={value.text}>{value.text}</span>)}
    {values.length > 3 ? <small>另 {values.length - 3} 个标签</small> : null}
  </div> : <div className="offer-facts" aria-hidden="true" />;
}

export default function OfferTagDetails({ offer, item, onClose, onReport, formatValue, children }) {
  const facts = offerConditions(offer, formatValue);
  return <ModalDialog open className="offer-tag-details" aria-labelledby="offer-tag-details-title" onClose={onClose}>
    <header className="dialog-header"><div className="offer-tag-details-summary"><h2 id="offer-tag-details-title" title={offer.name || item.name}>{offer.name || item.name}</h2><p>{offer.shop || '未知商铺'}{offer.independentShop ? <span className="offer-shop-risk-note"> · 自建站，风险相对更高</span> : ''}{offer.spec ? ` · ${offer.spec}` : ''}</p></div><button type="button" aria-label="关闭商品说明" onClick={onClose}>×</button></header>
    <div className="offer-tag-details-body" tabIndex={0} role="region" aria-label="商品条件">
      {children}
      {facts.length ? <div className="offer-tag-details-groups">{PURCHASE_GUIDE_GROUPS.filter(group => facts.some(fact => fact.displayGroup === group.id)).map(group => <section key={group.id}><h3>{group.label}</h3>
        <ul>{facts.filter(fact => fact.displayGroup === group.id).map(fact => <li key={`${fact.name}:${fact.value}`} aria-label={`${fact.label}：${fact.value}`}>{displayPurchaseTagText(fact, fact.value)}</li>)}</ul>
      </section>)}</div> : <p className="offer-tag-details-empty">暂无商品条件信息</p>}
    </div>
    <footer className="offer-tag-details-actions">{onReport && <button type="button" className="text-button" onClick={() => onReport(offer)}>举报此报价</button>}<button type="button" className="primary-button" onClick={onClose}>确认</button></footer>
  </ModalDialog>;
}
