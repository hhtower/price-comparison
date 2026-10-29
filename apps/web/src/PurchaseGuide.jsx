import React from 'react';
import { purchaseGuideHref, refreshPurchaseGuideHref } from './purchase-guide-navigation.js';
import { PURCHASE_GUIDE_CONTENT as guide } from '@price-comparison/catalog/purchase-guide-content';

export default function PurchaseGuide({ full = false }) {
  if (!full) return <p className="purchase-guide-brief">第一次购买？<a href={purchaseGuideHref()} onClick={refreshPurchaseGuideHref} onAuxClick={refreshPurchaseGuideHref} onContextMenu={refreshPurchaseGuideHref}>查看选购说明 →</a></p>;
  return <div className="purchase-guide-content">
    <div className="guide-introduction"><p className="guide-headline">{guide.headline}</p><p>{guide.introduction}</p></div>
    <h2 id="guide-scenarios">{guide.scenariosTitle}</h2>
    <nav className="guide-choices" aria-label="按购买需求阅读">{guide.scenarios.map(scenario => <a key={scenario.id} href={`#${scenario.id}`}>{scenario.title}<span aria-hidden="true"> ↓</span></a>)}</nav>
    <div className="guide-grid">{guide.scenarios.map(scenario => <article className="guide-card guide-scenario" key={scenario.id} id={scenario.id}>
      <h3>{scenario.title}</h3><p className="guide-choice">{scenario.choice}</p><p>{scenario.text}</p>
      <p><strong>重点确认：</strong>{scenario.check}</p>
      <div className="guide-question"><strong>可以这样问商家</strong><p>{scenario.question}</p></div>
      <p className="guide-pitfall">{scenario.pitfall}</p>
    </article>)}</div>
    <div className="guide-comparison">
      <div className="guide-table-scroll" tabIndex={0} role="region" aria-label="报价条件对比">
        <table><caption>{guide.comparison.title}</caption><thead><tr>{guide.comparison.columns.map(column => <th scope="col" key={column}>{column}</th>)}</tr></thead>
          <tbody>{guide.comparison.rows.map(([label, a, b]) => <tr key={label}><th scope="row">{label}</th><td>{a}</td><td>{b}</td></tr>)}</tbody>
        </table>
      </div>
      <p className="guide-example-note">{guide.comparison.note}</p><p className="guide-takeaway">{guide.comparison.takeaway}</p>
    </div>
    <h2 id="guide-checklist">{guide.checklistTitle}</h2>
    <dl className="guide-checklist">{guide.checklist.map(item => <div key={item.title}><dt>{item.title}</dt><dd>{item.text}</dd></div>)}</dl>
    <div className="guide-next"><h2>{guide.nextTitle}</h2><p>{guide.nextText}</p><p className="guide-caution">{guide.caution}</p></div>
  </div>;
}
