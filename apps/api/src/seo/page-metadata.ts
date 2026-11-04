import { standardProductDisplayName } from '@price-comparison/catalog/catalog-display';
import { CATALOG_SEO_CONTENT, PRODUCT_SEO_CONTENT } from '@price-comparison/catalog/seo-content';
import { SITE_NAME } from '@price-comparison/catalog/site-brand';
import type { CatalogOffer } from '../catalog/catalog.repository.js';

export const DEFAULT_SITE_URL = 'https://price.yufu.pub';
export { SITE_NAME };
export const PRODUCT_PAGE_SIZE = 12;
export const PAGE_METADATA = {
  public: {
    path: '/', title: `AI 订阅与账号价格比较 - ${SITE_NAME}`,
    description: CATALOG_SEO_CONTENT.conclusion,
  },
  tools: {
    path: '/tools', title: `AI 与 IP 检测工具 - ${SITE_NAME}`,
    description: '检测 OpenAI-compatible API 的响应、模型能力与稳定性，查询 IP 网络、风险及服务可达性。检测结果仅供参考，不作为模型来源证明。',
  },
  guide: { path: '/guide', title: `新手选购指南 - ${SITE_NAME}`, description: '给已有账号开通或续费，还是买一个账号使用？按自己的需求挑商品，用报价示例看懂独享共享、使用期限和售后范围，下单前问清费用与使用条件。' },
  admin: { path: '/admin', title: `${SITE_NAME} · 管理端`, description: `${SITE_NAME}管理端。` },
  assistant: { path: '/assistant', title: `导购助手 - ${SITE_NAME}`, description: '说说你的用途和购买要求，通过独立对话了解选购条件与本站真实报价。' },
} as const;
export type PageKind = keyof typeof PAGE_METADATA;

export function publicPageNumber(value: unknown): number | null {
  if (Array.isArray(value)) {
    if (value.length > 1) return null;
    value = value[0];
  }
  if (value === undefined || value === null) return 1;
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,8}$/u.test(value)) return null;
  return Number(value);
}

export function productPagePath(id: string, page = 1): string {
  return '/products/' + id + (page > 1 ? '?page=' + page : '');
}

export function catalogPageMetadata(cursor?: string) {
  return { ...PAGE_METADATA.public, path: cursor ? '/?cursor=' + encodeURIComponent(cursor) : '/',
    title: cursor ? 'AI 商品价格比较（目录续页） - ' + SITE_NAME : PAGE_METADATA.public.title };
}

export function productPageMetadata(product: { readonly id: string; readonly name: string }, page = 1) {
  const name = standardProductDisplayName(product.name);
  return { path: productPagePath(product.id, page), title: name + '价格比较' + (page > 1 ? '（第' + page + '页）' : '') + ' - ' + SITE_NAME,
    description: '比较' + name + '的第三方商铺报价、交付方式、使用期限与售后，核对标价、结算价、采集时间和来源链接。成交价以商家结算页为准。' };
}

export function publicSourceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function organizationSchema(origin: string) {
  return { '@type': 'Organization', '@id': origin + '/#organization', name: SITE_NAME, url: origin + '/',
    sameAs: ['https://github.com/hhtower/price-comparison'] };
}

function websiteSchema(origin: string) {
  return { '@type': 'WebSite', '@id': origin + '/#website', url: origin + '/', name: SITE_NAME, inLanguage: 'zh-CN',
    publisher: { '@id': origin + '/#organization' } };
}

function breadcrumbSchema(origin: string, path: string, title: string) {
  if (path === '/' || path.startsWith('/?')) return null;
  const label = title.replace(' - ' + SITE_NAME, '');
  return { '@type': 'BreadcrumbList', '@id': origin + path + '#breadcrumb', itemListElement: [
    { '@type': 'ListItem', position: 1, name: '首页', item: origin + '/' },
    { '@type': 'ListItem', position: 2, name: label, item: origin + path.split('?')[0] },
  ] };
}

function faqSchema(origin: string, path: string, items: readonly { question: string; answer: string }[]) {
  return { '@type': 'FAQPage', '@id': origin + path.split('?')[0] + '#faq',
    mainEntity: items.map(({ question, answer }) => ({ '@type': 'Question', name: question,
      acceptedAnswer: { '@type': 'Answer', text: answer } })) };
}

export function productPageSchema(product: { readonly id: string; readonly name: string }, origin: string,
  offers: readonly CatalogOffer[] = [], page = 1): Record<string, unknown> {
  const metadata = productPageMetadata(product, page);
  const pageUrl = origin + metadata.path;
  const productId = pageUrl + '#product';
  const breadcrumb = breadcrumbSchema(origin, productPagePath(product.id), standardProductDisplayName(product.name))!;
  const verified = offers.filter(offer => (offer.settlementQuantity ?? 1) === 1 && offer.priceStatus === 'verified'
    && !offer.paymentMethod?.includes('预估') && !offer.stale && offer.inStock === true
    && offer.price != null && String(offer.price).trim() !== '' && Number.isFinite(Number(offer.price)) && Number(offer.price) >= 0
    && (offer.priceExpiresAt == null || Date.parse(offer.priceExpiresAt) > Date.now())
    && (offer.inventoryExpiresAt == null || Date.parse(offer.inventoryExpiresAt) > Date.now())
    && publicSourceUrl(offer.productUrl));
  return { '@context': 'https://schema.org', '@graph': [
    organizationSchema(origin),
    websiteSchema(origin),
    { '@type': 'WebPage', '@id': pageUrl + '#webpage', url: pageUrl, name: metadata.title, description: metadata.description,
      inLanguage: 'zh-CN', isPartOf: { '@id': origin + '/#website' },
      ...(verified.length ? { mainEntity: { '@id': productId } } : {}),
      breadcrumb: { '@id': breadcrumb['@id'] } },
    breadcrumb,
    faqSchema(origin, metadata.path, PRODUCT_SEO_CONTENT.faq),
    // Product snippets require offers or genuine reviews; omit incomplete Product markup.
    ...(verified.length ? [{ '@type': 'Product', '@id': productId, name: standardProductDisplayName(product.name), url: pageUrl,
      offers: verified.map(offer => ({ '@type': 'Offer', price: offer.price, priceCurrency: offer.currency,
        availability: 'https://schema.org/InStock',
        url: publicSourceUrl(offer.productUrl), seller: { '@type': 'Organization', name: offer.shop } })) }] : []),
  ] };
}

export function pageSchema(kind: PageKind, origin: string, page: { path: string; title: string; description: string } = PAGE_METADATA[kind]): Record<string, unknown> | null {
  if (kind === 'admin' || kind === 'assistant') return null;
  const breadcrumb = breadcrumbSchema(origin, page.path, page.title);
  return {
    '@context': 'https://schema.org',
    '@graph': [
      organizationSchema(origin),
      websiteSchema(origin),
      { '@type': kind === 'public' ? 'CollectionPage' : 'WebPage', '@id': origin + page.path + '#webpage',
        url: origin + page.path, name: page.title, description: page.description, inLanguage: 'zh-CN',
        isPartOf: { '@id': origin + '/#website' }, ...(breadcrumb ? { breadcrumb: { '@id': breadcrumb['@id'] } } : {}) },
      ...(breadcrumb ? [breadcrumb] : []),
      ...(kind === 'public' ? [faqSchema(origin, page.path, CATALOG_SEO_CONTENT.faq)] : []),
    ],
  };
}
