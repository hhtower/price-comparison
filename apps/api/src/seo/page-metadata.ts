export const DEFAULT_SITE_URL = 'https://price.yufu.pub';
export const SITE_NAME = '知途 · 拾价';
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

export function productPageMetadata(product: { readonly id: string; readonly name: string }) {
  return { path: '/products/' + product.id, title: product.name + '价格比较 - ' + SITE_NAME,
    description: '比较' + product.name + '的第三方商铺报价、商品规格与更新时间，查看有效结算价和来源商铺。' };
}

export function pageSchema(kind: PageKind, origin: string): Record<string, unknown> | null {
  if (kind === 'admin') return null;
  const page = PAGE_METADATA[kind];
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
