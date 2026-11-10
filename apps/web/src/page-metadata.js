import { DEFAULT_SITE_URL, PAGE_METADATA, SITE_NAME, catalogPageMetadata, pageSchema, productPagePath, productPageMetadata, productPageSchema } from '../../api/src/seo/page-metadata.ts';

function setMeta(attribute, name, content) {
  let element = document.head.querySelector('meta[' + attribute + '="' + name + '"]');
  if (!element) {
    element = document.createElement('meta');
    element.setAttribute(attribute, name);
    document.head.appendChild(element);
  }
  element.content = content;
}

export function updatePageMetadata(kind, product, pageNumber = 1, membershipKind) {
  const page = kind === 'product-error' ? { path: productPagePath(product.id, pageNumber, membershipKind), title: product.name + ' - ' + SITE_NAME,
    description: product.name + '。请返回商品列表或稍后重试。' } : product ? productPageMetadata(product, pageNumber, membershipKind)
      : kind === 'public' ? catalogPageMetadata(new URLSearchParams(window.location.search).get('cursor'))
        : kind === 'mcp' ? { path: '/mcp', title: 'Skill / MCP 接入 - ' + SITE_NAME, description: '一次申请，共用密钥，通过 Skill 或 MCP 查询商品、商铺报价与价格历史。' } : PAGE_METADATA[kind];
  let canonical = document.head.querySelector('link[rel="canonical"]');
  const origin = new URL(canonical?.href || DEFAULT_SITE_URL).origin;
  if (!canonical) {
    canonical = document.createElement('link');
    canonical.rel = 'canonical';
    document.head.appendChild(canonical);
  }
  canonical.href = origin + page.path;
  document.title = page.title;
  setMeta('name', 'description', page.description);
  setMeta('name', 'referrer', kind === 'mcp' ? 'no-referrer' : 'strict-origin-when-cross-origin');
  setMeta('name', 'robots', kind === 'admin' || kind === 'assistant' || kind === 'mcp' || kind === 'product-error' ? 'noindex, nofollow' : 'index, follow, max-image-preview:large');
  for (const [name, value] of Object.entries({ 'og:type': product ? 'product' : 'website', 'og:locale': 'zh_CN', 'og:site_name': SITE_NAME,
    'og:title': page.title, 'og:description': page.description, 'og:url': canonical.href })) setMeta('property', name, value);
  setMeta('name', 'twitter:card', 'summary');
  setMeta('name', 'twitter:title', page.title);
  setMeta('name', 'twitter:description', page.description);
  let script = document.getElementById('page-structured-data');
  const data = product && kind !== 'product-error' ? productPageSchema(product, origin, pageNumber, membershipKind)
    : kind === 'product-error' ? null : pageSchema(kind, origin, page);
  if (!data) { script?.remove(); return; }
  if (!script) {
    script = document.createElement('script');
    script.id = 'page-structured-data';
    script.type = 'application/ld+json';
    document.head.appendChild(script);
  }
  script.textContent = JSON.stringify(data);
}
