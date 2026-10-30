import { standardProductDisplayName } from '@price-comparison/catalog/catalog-display';
import type { CatalogOffer } from '../catalog/catalog.repository.js';

export const DEFAULT_SITE_URL = 'https://price.yufu.pub';
export const SITE_NAME = '知途 · 拾价';
export const PRODUCT_PAGE_SIZE = 12;
export const PAGE_METADATA = {
  public: {
    path: '/', title: '知途 · 拾价 - AI 商品价格比较',
    description: '比较第三方商铺的 AI 商品价格、规格与更新时间，查看报价来源，按平台和购买条件筛选；提供 AI 接口与 IP 检测工具。',
  },
  tools: {
    path: '/tools', title: 'AI 与 IP 检测工具 - 知途 · 拾价',
    description: '检测 OpenAI-compatible API 的响应、模型能力与稳定性，查询 IP 网络、风险及服务可达性。检测结果仅供参考，不作为模型来源证明。',
  },
  guide: { path: '/guide', title: '新手选购指南 - 知途 · 拾价', description: '给已有账号开通或续费，还是买一个账号使用？按自己的需求挑商品，用报价示例看懂独享共享、使用期限和售后范围，下单前问清费用与使用条件。' },
  admin: { path: '/admin', title: '知途 · 拾价 · 管理端', description: '知途 · 拾价管理端。' },
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
    description: '比较' + name + '的第三方商铺报价、商品规格与更新时间，查看有效结算价和来源商铺。' };
}

export function publicSourceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function productPageSchema(product: { readonly id: string; readonly name: string }, origin: string,
  offers: readonly CatalogOffer[] = [], page = 1): Record<string, unknown> {
  const verified = offers.filter(offer => (offer.settlementQuantity ?? 1) === 1 && offer.priceStatus === 'verified'
    && !offer.paymentMethod?.includes('预估') && !offer.stale && offer.inStock !== false
    && offer.price != null && String(offer.price).trim() !== '' && Number.isFinite(Number(offer.price)) && Number(offer.price) >= 0
    && (offer.priceExpiresAt == null || Date.parse(offer.priceExpiresAt) > Date.now())
    && (offer.inventoryExpiresAt == null || Date.parse(offer.inventoryExpiresAt) > Date.now())
    && publicSourceUrl(offer.productUrl));
  return { '@context': 'https://schema.org', '@type': 'Product', name: standardProductDisplayName(product.name),
    url: origin + productPagePath(product.id, page),
    ...(verified.length ? { offers: verified.map(offer => ({ '@type': 'Offer', price: offer.price, priceCurrency: offer.currency,
      url: publicSourceUrl(offer.productUrl), seller: { '@type': 'Organization', name: offer.shop } })) } : {}) };
}

export function pageSchema(kind: PageKind, origin: string, page: { path: string; title: string; description: string } = PAGE_METADATA[kind]): Record<string, unknown> | null {
  if (kind === 'admin') return null;
  return {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', '@id': origin + '/#website', url: origin + '/', name: SITE_NAME, inLanguage: 'zh-CN' },
      { '@type': kind === 'public' ? 'CollectionPage' : 'WebPage', '@id': origin + page.path + '#webpage',
        url: origin + page.path, name: page.title, description: page.description, inLanguage: 'zh-CN',
        isPartOf: { '@id': origin + '/#website' } },
    ],
  };
}
