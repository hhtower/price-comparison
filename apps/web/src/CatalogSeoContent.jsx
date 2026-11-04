import React from 'react';
import { CATALOG_SEO_CONTENT, PRODUCT_SEO_CONTENT } from '@price-comparison/catalog/seo-content';

export function CatalogSeoIntro({ product = false }) {
  const content = product ? PRODUCT_SEO_CONTENT : CATALOG_SEO_CONTENT;
  return <div className="catalog-seo-intro">
    {!product ? <h1 className="catalog-page-title">{CATALOG_SEO_CONTENT.title}</h1> : null}
    <p className="seo-answer">{content.conclusion}</p>
    <div className="seo-facts">{content.facts.map(fact => <section className="seo-fact" key={fact.title}>
      <h2>{fact.title}</h2><p>{fact.text}</p><a href={fact.href}>{fact.link}</a>
    </section>)}</div>
  </div>;
}

export function CatalogSeoFaq({ product = false }) {
  const content = product ? PRODUCT_SEO_CONTENT : CATALOG_SEO_CONTENT;
  return <section className="seo-faq" aria-labelledby="catalog-faq-title">
    <h2 id="catalog-faq-title">报价与购买常见问题</h2>
    {content.faq.map(item => <div key={item.question}><h3>{item.question}</h3><p>{item.answer}</p></div>)}
  </section>;
}
