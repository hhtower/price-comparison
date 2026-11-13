import React from 'react';
import ModalDialog from './components/ModalDialog.jsx';
import { PURCHASE_GUIDE_FIELDS, PURCHASE_GUIDE_GROUPS } from '@price-comparison/catalog/purchase-guide-content';
import { normalizePurchaseTag, purchaseWarrantyLabel } from '@price-comparison/catalog/purchase-attributes';
import { sanitizeOfferName } from '@price-comparison/catalog/catalog-display';
import { displayPurchaseTagText, displayPurchaseTagValue } from './purchase-tag-values.js';

export function offerConditions(offer, formatValue = displayPurchaseTagValue) {
  const facts = new Map();
  for (const raw of offer.tags || []) {
    for (const tag of normalizePurchaseTag(raw)) {
      if (!tag || tag.name === 'warranty' || !PURCHASE_GUIDE_FIELDS[tag.name] || !tag.value || ['unknown', 'unspecified'].includes(tag.value)) continue;
      const value = formatValue(tag);
      facts.set(`${tag.name}:${value}`, { ...tag, value, ...PURCHASE_GUIDE_FIELDS[tag.name] });
    }
  }
  if (offer.settlementQuantity > 1) facts.set('settlement_quantity', { name: 'settlement_quantity', value: `${offer.settlementQuantity}件起购`, label: '起购数量', displayGroup: PURCHASE_GUIDE_FIELDS.bulk_purchase.displayGroup, summaryPriority: 0 });
  return [...facts.values()].sort((a, b) => a.summaryPriority - b.summaryPriority);
}

const OFFER_SUMMARY_PRIORITY = { warranty: -3, subscription_override: -2, settlement_quantity: -1 };

export function OfferFacts({ tags, settlementQuantity, formatValue = displayPurchaseTagValue, limit = 2, onOpenDetails }) {
  const facts = offerConditions({ tags, settlementQuantity }, formatValue);
  const warranty = purchaseWarrantyLabel(tags || []);
  if (warranty) facts.push({ name: 'warranty', value: warranty, summaryPriority: 30 });
  const values = facts.sort((a, b) => (OFFER_SUMMARY_PRIORITY[a.name] ?? a.summaryPriority)
    - (OFFER_SUMMARY_PRIORITY[b.name] ?? b.summaryPriority)).map(fact => ({
    key: `${fact.name}:${fact.value}`, name: fact.name, text: displayPurchaseTagText(fact, fact.value), group: fact.displayGroup, warranty: fact.name === 'warranty',
  }));
  return values.length ? <div className="offer-facts" role="group" tabIndex={0} aria-label="商品标签">
    {values.slice(0, limit).map(value => <span key={value.key} className={value.warranty ? 'offer-warranty' : undefined} data-field={value.name} data-group={value.group} title={value.text}>{value.text}</span>)}
    {values.length > limit ? <button type="button" className="offer-facts-more" aria-label={`查看全部商品条件，另有 ${values.length - limit} 项`} onClick={onOpenDetails}>+{values.length - limit}</button> : null}
  </div> : <div className="offer-facts" aria-hidden="true" />;
}

export default function OfferTagDetails({ offer, item, onClose, onReport, formatValue, children, footer }) {
  const conditions = offerConditions(offer, formatValue);
  const warranty = purchaseWarrantyLabel(offer.tags || []);
  const facts = [...conditions];
  if (warranty) facts.push({ name: 'warranty', value: warranty, ...PURCHASE_GUIDE_FIELDS.warranty });
  const displayName = sanitizeOfferName(offer.name || item.name);
  return <ModalDialog open className="offer-tag-details" aria-labelledby="offer-tag-details-title" onClose={onClose}>
    <header className="dialog-header"><div className="offer-tag-details-summary"><h2 id="offer-tag-details-title" title={displayName}>{displayName}</h2><p>店铺：{offer.shop || '未知商铺'}{offer.independentShop ? <span className="offer-shop-risk-note"> · 自建站，风险相对更高</span> : ''}{offer.spec ? ` · ${offer.spec}` : ''}</p></div><button type="button" aria-label="关闭商品说明" onClick={onClose}>×</button></header>
    <div className="offer-tag-details-body" tabIndex={0} role="region" aria-label="商品条件">
      {children}
      {facts.length ? <div className="offer-tag-details-groups">{PURCHASE_GUIDE_GROUPS.filter(group => facts.some(fact => fact.displayGroup === group.id)).map(group => <section key={group.id}><h3>{group.label}</h3>
        <ul>{facts.filter(fact => fact.displayGroup === group.id).map(fact => <li key={`${fact.name}:${fact.value}`} data-field={fact.name} aria-label={`${fact.label}：${fact.value}`}>{displayPurchaseTagText(fact, fact.value)}</li>)}</ul>
      </section>)}</div> : <p className="offer-tag-details-empty">暂无商品条件信息</p>}
    </div>
    <footer className="offer-tag-details-actions">{onReport && <button type="button" className="text-button" onClick={() => onReport(offer)}>举报此报价</button>}{footer}<button type="button" className="primary-button" onClick={onClose}>确认</button></footer>
  </ModalDialog>;
}
