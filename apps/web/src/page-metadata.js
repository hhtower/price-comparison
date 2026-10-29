import { DEFAULT_SITE_URL, PAGE_METADATA, SITE_NAME, pageSchema, productPageMetadata } from '../../api/src/seo/page-metadata.ts';

function setMeta(attribute, name, content) {
  let element = document.head.querySelector('meta[' + attribute + '="' + name + '"]');
  if (!element) {
    element = document.createElement('meta');
    element.setAttribute(attribute, name);
    document.head.appendChild(element);
  }
  element.content = content;
}

export function updatePageMetadata(kind, product) {
  const page = kind === 'product-error' ? { path: '/products/' + product.id, title: product.name + ' - ' + SITE_NAME,
    description: product.name + '。请返回商品列表或稍后重试。' } : product ? productPageMetadata(product) : PAGE_METADATA[kind];
  let canonical = document.head.querySelector('link[rel="canonical"]');
  const origin = new URL(canonical?.href || DEFAULT_SITE_URL).origin;
  if (!canonical) {
    canonical = document.createElement('link');
    canonical.rel = 'canonical';
    document.head.appendChild(canonical);
  }
  canonical.href = origin + page.path;
  // QualityToolsPage owns its active AI/IP tab title.
  if (kind !== 'tools') document.title = page.title;
  setMeta('name', 'description', page.description);
  setMeta('name', 'robots', kind === 'admin' || kind === 'product-error' ? 'noindex, nofollow' : 'index, follow, max-image-preview:large');
  for (const [name, value] of Object.entries({ 'og:type': product ? 'product' : 'website', 'og:locale': 'zh_CN', 'og:site_name': SITE_NAME,
    'og:title': page.title, 'og:description': page.description, 'og:url': canonical.href })) setMeta('property', name, value);
  setMeta('name', 'twitter:card', 'summary');
  setMeta('name', 'twitter:title', page.title);
  setMeta('name', 'twitter:description', page.description);
  const data = product && kind !== 'product-error' ? { '@context': 'https://schema.org', '@type': 'Product', name: product.name, url: canonical.href }
    : kind === 'product-error' ? null : pageSchema(kind, origin);
  let script = document.getElementById('page-structured-data');
  if (!data) { script?.remove(); return; }
  if (!script) {
    script = document.createElement('script');
    script.id = 'page-structured-data';
    script.type = 'application/ld+json';
    document.head.appendChild(script);
  }
  script.textContent = JSON.stringify(data);
}
