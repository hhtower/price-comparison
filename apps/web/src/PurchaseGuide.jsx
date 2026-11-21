import React from 'react';
import { purchaseGuideHref, refreshPurchaseGuideHref } from './purchase-guide-navigation.js';
import { PURCHASE_GUIDE_CONTENT as guide, PURCHASE_GUIDE_FIELDS, PURCHASE_GUIDE_GROUPS } from '@price-comparison/catalog/purchase-guide-content';

export function PurchaseGuideLink({ children }) {
  return <a href={purchaseGuideHref()} onClick={refreshPurchaseGuideHref} onAuxClick={refreshPurchaseGuideHref} onContextMenu={refreshPurchaseGuideHref}>{children}</a>;
}

export default function PurchaseGuide({ full = false }) {
  if (!full) return <p className="purchase-guide-brief">第一次购买？<PurchaseGuideLink>查看选购说明 →</PurchaseGuideLink></p>;
  return <div className="purchase-guide-content">
    <h2 id="guide-scenarios">{guide.scenariosTitle}</h2>
    <div className="guide-grid">{guide.scenarios.map(scenario => <article className="guide-card guide-scenario" key={scenario.id} id={scenario.id}>
      <h3>{scenario.title}</h3><p className="guide-choice">{scenario.choice}</p><p>{scenario.text}</p>
    </article>)}</div>
    <h2 id="guide-warranties">{guide.warrantiesTitle}</h2>
    <div className="guide-warranties">{['subscription_warranty', 'usage_warranty'].map(name => <dl key={name} id={`guide-${name}`}><div id={name}>
      <dt>{PURCHASE_GUIDE_FIELDS[name].label}</dt><dd>{PURCHASE_GUIDE_FIELDS[name].explanation}</dd>
    </div></dl>)}</div>
    <details className="guide-more" id="guide-more">
      <summary>{guide.moreTitle}</summary>
      <h2 id="guide-checklist">{guide.checklistTitle}</h2>
      <dl className="guide-checklist">{guide.checklist.map(item => <div key={item.title}><dt>{item.title}</dt><dd>{item.text}</dd></div>)}</dl>
      <div className="guide-comparison">
        <div className="guide-table-scroll" tabIndex={0} role="region" aria-label="报价条件对比">
          <table><caption>{guide.comparison.title}</caption><thead><tr>{guide.comparison.columns.map(column => <th scope="col" key={column}>{column}</th>)}</tr></thead>
            <tbody>{guide.comparison.rows.map(([label, a, b]) => <tr key={label}><th scope="row">{label}</th><td>{a}</td><td>{b}</td></tr>)}</tbody>
          </table>
        </div>
        <p className="guide-example-note">{guide.comparison.note}</p><p className="guide-takeaway">{guide.comparison.takeaway}</p>
      </div>
      <div id="guide-fields">
        <h2>{guide.glossaryTitle}</h2>
        <dl className="guide-field-list"><div id="guide-2fa"><dt>{guide.twoFactor.title}</dt><dd>{guide.twoFactor.text}</dd></div></dl>
        {PURCHASE_GUIDE_GROUPS.filter(group => !['subscription_warranty', 'usage_warranty'].includes(group.id)).map(group => <dl className="guide-field-list" key={group.id} id={`guide-${group.id}`}>{Object.entries(PURCHASE_GUIDE_FIELDS).filter(([, field]) => field.displayGroup === group.id).map(([name, field]) => <div key={name} id={name}><dt>{field.label}</dt><dd>{field.explanation}</dd></div>)}</dl>)}
      </div>
    </details>
  </div>;
}
