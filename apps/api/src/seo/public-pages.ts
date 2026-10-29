import { PURCHASE_GUIDE_CONTENT as guide, PURCHASE_GUIDE_FIELDS, PURCHASE_GUIDE_GROUPS } from '@price-comparison/catalog/purchase-guide-content';
import type { FastifyAdapter } from '@nestjs/platform-fastify';
import type { CatalogOffer, CatalogPage, PublicCatalogProduct, PublicCatalogProducts } from '../catalog/catalog.repository.js';
import type { CatalogQueryInput } from '../catalog/catalog.service.js';
import { DEFAULT_SITE_URL, PAGE_METADATA, SITE_NAME, pageSchema, productPageMetadata, type PageKind } from './page-metadata.js';

export interface PublicPagesOptions {
  readonly template: string;
  readonly siteUrl?: string;
  readonly getCatalog: (input?: CatalogQueryInput) => Promise<CatalogPage>;
  readonly getProducts: () => Promise<PublicCatalogProducts>;
  readonly getProduct: (id: string) => Promise<PublicCatalogProduct | null>;
}

function siteOrigin(value = DEFAULT_SITE_URL): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
    return url.origin;
  } catch {
    throw new Error('PUBLIC_SITE_URL must be an HTTPS origin without credentials, path, query or fragment');
  }
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function sourceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function renderOffer(offer: CatalogOffer): string {
  const source = sourceUrl(offer.productUrl);
  const date = new Date(offer.capturedAt);
  const captured = Number.isNaN(date.getTime()) ? '更新时间未知' : '<time datetime="' + date.toISOString() + '">' + date.toISOString() + '</time>';
  const name = escapeHtml(offer.name);
  const price = offer.price != null && ['verified', 'expired', 'estimated'].includes(offer.priceStatus ?? '')
    ? escapeHtml(offer.price) + ' ' + escapeHtml(offer.currency)
      + (offer.priceStatus === 'expired' || offer.priceStatus === 'estimated' || offer.paymentMethod?.includes('预估') ? ' · 预估' : '')
    : '—';
  return '<li><p>' + (source ? '<a href="' + escapeHtml(source) + '" rel="noopener noreferrer">' + name + '</a>' : name)
    + ' · ' + escapeHtml(offer.shop) + (offer.independentShop ? '（自建站）' : '') + '</p><p>' + price
    + (offer.settlementQuantity > 1 ? ' · ' + escapeHtml(offer.settlementQuantity) + '件起购' : '')
    + ' · ' + escapeHtml(offer.spec) + '</p><p>报价采集时间：' + captured
    + (offer.stale ? '（报价可能已过期）' : '') + '</p></li>';
}

function catalogContent(page: CatalogPage): string {
  return '<h1>AI 商品价格比较</h1><p>' + escapeHtml(PAGE_METADATA.public.description) + '</p>'
    + '<p>本站提供第三方报价信息，不参与交易；价格和库存以来源商铺为准，商品规格与售后以商家说明为准。</p>'
    + '<p class="purchase-guide-brief">第一次购买？<a href="/guide">查看选购说明 →</a></p>'
    + (page.items.length ? page.items.map(item => '<article><h2><a href="/products/' + escapeHtml(item.id) + '">' + escapeHtml(item.name) + '</a></h2><p>平台：'
      + escapeHtml(item.platform) + '</p><ul>' + item.offers.map(renderOffer).join('') + '</ul></article>').join('')
      : '<p>暂无可用报价，请稍后再试。</p>')
    + '<p>以上为首页报价摘要。启用 JavaScript 可搜索、筛选及加载更多商品和报价。</p>';
}

function guideContent(): string {
  return '<header class="product-page-heading guide-page-heading"><a class="product-back-link" href="/">返回商品列表</a><h1>' + escapeHtml(guide.title) + '</h1></header>'
    + '<div class="purchase-guide-content"><div class="guide-introduction"><p class="guide-headline">' + escapeHtml(guide.headline) + '</p><p>' + escapeHtml(guide.introduction) + '</p></div>'
    + '<h2 id="guide-scenarios">' + escapeHtml(guide.scenariosTitle) + '</h2><nav class="guide-choices" aria-label="按购买需求阅读">'
    + guide.scenarios.map(scenario => '<a href="#' + escapeHtml(scenario.id) + '">' + escapeHtml(scenario.title) + '<span aria-hidden="true"> ↓</span></a>').join('') + '</nav><div class="guide-grid">'
    + guide.scenarios.map(scenario => '<article class="guide-card guide-scenario" id="' + escapeHtml(scenario.id) + '"><h3>' + escapeHtml(scenario.title)
      + '</h3><p class="guide-choice">' + escapeHtml(scenario.choice) + '</p><p>' + escapeHtml(scenario.text) + '</p><p><strong>重点确认：</strong>'
      + escapeHtml(scenario.check) + '</p><div class="guide-question"><strong>可以这样问商家</strong><p>' + escapeHtml(scenario.question)
      + '</p></div><p class="guide-pitfall">' + escapeHtml(scenario.pitfall) + '</p></article>').join('') + '</div>'
    + '<div class="guide-comparison"><div class="guide-table-scroll" tabindex="0" role="region" aria-label="报价条件对比"><table><caption>'
    + escapeHtml(guide.comparison.title) + '</caption><thead><tr>'
    + guide.comparison.columns.map(column => '<th scope="col">' + escapeHtml(column) + '</th>').join('') + '</tr></thead><tbody>'
    + guide.comparison.rows.map(([label, a, b]) => '<tr><th scope="row">' + escapeHtml(label) + '</th><td>' + escapeHtml(a) + '</td><td>' + escapeHtml(b) + '</td></tr>').join('')
    + '</tbody></table></div><p class="guide-example-note">' + escapeHtml(guide.comparison.note) + '</p><p class="guide-takeaway">' + escapeHtml(guide.comparison.takeaway) + '</p></div>'
    + '<h2 id="guide-checklist">' + escapeHtml(guide.checklistTitle) + '</h2><dl class="guide-checklist">'
    + guide.checklist.map(item => '<div><dt>' + escapeHtml(item.title) + '</dt><dd>' + escapeHtml(item.text) + '</dd></div>').join('') + '</dl>'
    + '<div class="guide-next"><h2>' + escapeHtml(guide.nextTitle) + '</h2><p>' + escapeHtml(guide.nextText) + '</p><p class="guide-caution">' + escapeHtml(guide.caution) + '</p></div></div>'
    + '<h2 id="guide-fields">' + escapeHtml(guide.glossaryTitle) + '</h2><p class="guide-glossary-introduction">' + escapeHtml(guide.glossaryIntroduction) + '</p><div class="guide-glossary">'
    + PURCHASE_GUIDE_GROUPS.map(group => '<details class="guide-card" id="guide-' + group.id + '"><summary>' + escapeHtml(group.label) + '</summary><dl class="guide-field-list">'
      + Object.entries(PURCHASE_GUIDE_FIELDS).filter(([, field]) => field.displayGroup === group.id)
        .map(([name, field]) => '<div id="' + escapeHtml(name) + '"><dt>' + escapeHtml(field.label) + '</dt><dd>' + escapeHtml(field.explanation) + '</dd></div>').join('') + '</dl></details>').join('')
    + '</div><a class="guide-return" href="/">返回商品列表，开始选购<span aria-hidden="true"> →</span></a>';
}

function toolsContent(): string {
  return '<h1>AI 与 IP 检测工具</h1><p>' + escapeHtml(PAGE_METADATA.tools.description) + '</p>'
    + '<section><h2>AI 接口检测</h2><p>输入接口地址、模型和 API Key，按选择的项目检测响应、工具调用、多轮对话等能力。</p></section>'
    + '<section><h2>IP 检测</h2><p>查询 IP 的网络资料、风险信号及 AI、流媒体服务可达性。</p></section>'
    + '<p>检测结果仅反映本次观测，模型名称或指纹匹配不能证明模型来源。启用 JavaScript 后可使用交互检测。</p>';
}

function renderPage(template: string, kind: PageKind, origin: string, content: string, unavailable = false,
  custom?: { readonly page: ReturnType<typeof productPageMetadata>; readonly schema?: Record<string, unknown> }): string {
  const page = custom?.page ?? PAGE_METADATA[kind];
  const noindex = kind === 'admin' || unavailable;
  const canonical = origin + page.path;
  const schema = noindex ? null : custom ? custom.schema : pageSchema(kind, origin);
  const metadata = '<meta name="description" content="' + escapeHtml(page.description) + '">'
    + '<meta name="robots" content="' + (noindex ? 'noindex, nofollow' : 'index, follow, max-image-preview:large') + '">'
    + '<link rel="canonical" href="' + escapeHtml(canonical) + '">'
    + '<meta property="og:type" content="website"><meta property="og:locale" content="zh_CN">'
    + '<meta property="og:site_name" content="' + SITE_NAME + '"><meta property="og:title" content="' + escapeHtml(page.title) + '">'
    + '<meta property="og:description" content="' + escapeHtml(page.description) + '"><meta property="og:url" content="' + escapeHtml(canonical) + '">'
    + '<meta name="twitter:card" content="summary"><meta name="twitter:title" content="' + escapeHtml(page.title) + '">'
    + '<meta name="twitter:description" content="' + escapeHtml(page.description) + '">'
    + (schema ? '<script id="page-structured-data" type="application/ld+json">' + JSON.stringify(schema).replace(/</gu, '\\u003c') + '</script>' : '');
  const navigation = kind === 'guide'
    ? ''
    : '<nav aria-label="网站导航"><a href="/">知途 · 拾价</a> · <a href="/tools">检测工具</a>'
      + (kind === 'public' && !custom && !unavailable ? '' : ' · <a href="/guide">新手指南</a>') + '</nav>';
  const body = '<main class="seo-document' + (kind === 'guide' ? ' purchase-guide-page' : '') + '">' + navigation + content + '</main>';
  return template.replace(/<title>[\s\S]*?<\/title>/u, () => '<title>' + escapeHtml(page.title) + '</title>')
    .replace(/<meta\s+name="description"[^>]*>/u, '')
    .replace('</head>', () => metadata + '</head>')
    .replace('<div id="root"></div>', () => '<div id="root">' + body + '</div>');
}

export function registerPublicPages(adapter: FastifyAdapter, options: PublicPagesOptions): void {
  const server = adapter.getInstance();
  const origin = siteOrigin(options.siteUrl);
  const excluded = ['/api/', '/v1/', '/metrics', '/ready', '/health'];
  // React replaces the server HTML and needs these public read endpoints to render.
  // Exact/path-query rules avoid accidentally allowing similarly prefixed private routes.
  const renderResources = ['/api/catalog$', '/api/catalog?', '/api/catalog/facets$', '/api/catalog/facets?',
    '/api/catalog/products$', '/api/catalog/products?', '/api/catalog/products/', '/api/quality/catalog$'];
  server.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0]!;
    if (/^\/(?:admin|api|v1)(?:\/|$)/u.test(path) || ['/metrics', '/ready', '/health'].includes(path)) {
      reply.header('X-Robots-Tag', 'noindex, nofollow');
    }
  });
  // The wildcard policy also applies to Googlebot, Bingbot, Baiduspider and AI search crawlers.
  // Admin is deliberately crawlable so crawlers can see its noindex directive.
  server.get('/robots.txt', async (_request, reply) => reply.type('text/plain; charset=utf-8')
    .send(['User-agent: *', 'Allow: /', ...renderResources.map(path => 'Allow: ' + path),
      ...excluded.map(path => 'Disallow: ' + path), 'Sitemap: ' + origin + '/sitemap.xml', ''].join('\n')));
  server.get('/sitemap.xml', async (request, reply) => {
    try {
      const products = await options.getProducts();
      return reply.type('application/xml; charset=utf-8').header('Cache-Control', 'no-cache')
        .send('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
          + ['/', '/tools', '/guide', ...products.items.map(product => '/products/' + product.id)]
            .map(path => '<url><loc>' + escapeHtml(origin + path) + '</loc></url>').join('') + '</urlset>');
    } catch {
      request.log.warn('public product sitemap unavailable');
      return reply.code(503).header('Retry-After', '60').header('X-Robots-Tag', 'noindex, nofollow').send('Sitemap temporarily unavailable');
    }
  });
  server.get('/products/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-cache');
    const missing = () => reply.code(404).header('X-Robots-Tag', 'noindex, nofollow')
      .send(renderPage(options.template, 'public', origin, '<h1>商品不存在</h1>', true));
    if (!/^[1-9][0-9]{0,18}$/u.test(id) || BigInt(id) >= 2n ** 63n) return missing();
    try {
      const product = await options.getProduct(id);
      if (!product) return missing();
      if (product.mergedIntoId) return reply.code(308).redirect('/products/' + product.mergedIntoId);
      const catalog = await options.getCatalog({ standardProductId: id, detailKind: 'offers', detailPage: 0, detailPageSize: 20, currency: 'CNY', offerSort: 'price' });
      const item = catalog.items[0];
      const offers = item?.detail?.kind === 'offers' ? item.detail.entries : item?.offers ?? [];
      const page = productPageMetadata(product);
      const verified = offers.filter(offer => (offer.settlementQuantity ?? 1) === 1 && offer.priceStatus === 'verified' && offer.price !== null
        && Number.isFinite(Number(offer.price)) && Number(offer.price) >= 0 && sourceUrl(offer.productUrl));
      const schema = { '@context': 'https://schema.org', '@type': 'Product', name: product.name, url: origin + page.path,
        ...(verified.length ? { offers: verified.map(offer => ({ '@type': 'Offer', price: offer.price, priceCurrency: offer.currency,
          url: sourceUrl(offer.productUrl), seller: { '@type': 'Organization', name: offer.shop } })) } : {}) };
      const content = '<h1>' + escapeHtml(product.name) + '</h1><p>' + escapeHtml(page.description) + '</p>'
        + (offers.length ? '<ul>' + offers.map(renderOffer).join('') + '</ul>' : '<p>暂无可用报价，请稍后再试。</p>');
      return reply.send(renderPage(options.template, 'public', origin, content, false, { page, schema }));
    } catch {
      request.log.warn('public product HTML unavailable');
      return reply.code(503).header('Retry-After', '60').header('X-Robots-Tag', 'noindex, nofollow')
        .send(renderPage(options.template, 'public', origin, '<h1>商品报价暂时不可用</h1><p>请稍后重试。</p>', true));
    }
  });
  server.get('/', async (request, reply) => {
    reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-cache');
    try {
      // Reuses CatalogService's bounded summary and existing versioned cache; no bot-specific content.
      const catalog = await options.getCatalog();
      return reply.send(renderPage(options.template, 'public', origin, catalogContent(catalog)));
    } catch {
      request.log.warn('public catalog HTML unavailable');
      return reply.code(503).header('Retry-After', '60').header('X-Robots-Tag', 'noindex, nofollow')
        .send(renderPage(options.template, 'public', origin, '<h1>商品报价暂时不可用</h1><p>请稍后重试。</p>', true));
    }
  });
  server.get('/guide', async (_request, reply) => reply.type('text/html; charset=utf-8')
    .send(renderPage(options.template, 'guide', origin, guideContent())));
  server.get('/tools', async (_request, reply) => reply.type('text/html; charset=utf-8')
    .send(renderPage(options.template, 'tools', origin, toolsContent())));
  server.get('/admin', async (_request, reply) => reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store')
    .send(renderPage(options.template, 'admin', origin, '<h1>管理端</h1><p>请启用 JavaScript 并登录。</p>')));
  for (const path of ['/tools', '/admin', '/guide']) server.get(path + '/', async (request, reply) => {
    const queryIndex = request.url.indexOf('?');
    return reply.code(308).redirect(path + (queryIndex < 0 ? '' : request.url.slice(queryIndex)));
  });
}
