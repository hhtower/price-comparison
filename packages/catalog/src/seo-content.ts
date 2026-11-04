import { SITE_NAME } from './site-brand.js';

export const CATALOG_SEO_CONTENT = {
  title: 'AI 订阅与账号价格比较',
  conclusion: `${SITE_NAME}汇总第三方商铺报价，按规格、期限和售后比较；不参与交易，成交价以商家结算页为准。`,
  facts: [
    { title: '核对 5 项购买条件', text: '交付方式、使用期限、账号归属、售后范围、起订量分别核对。同名套餐可能包含不同权益。',
      href: '/guide', link: '查看选购说明' },
    { title: '区分 2 种价格口径', text: '标价来自商品页面，结算价用于报价比较；预估或缺失价格不代表可成交价格。',
      href: '#catalog-quotes', link: '核对报价与来源' },
    { title: '最多并排比较 3 条报价', text: '在报价旁勾选“对比”，查看商铺、价格、规格和更新时间。先统一购买条件，再比较价格。',
      href: '#catalog-quotes', link: '查看本站报价' },
  ],
  faq: [
    { question: '如何比较 ChatGPT、Claude 和 Gemini 的第三方订阅报价？',
      answer: '先选择平台和套餐，再核对交付方式、使用期限、账号归属与售后。条件一致后比较结算价，并打开来源商铺确认库存。' },
    { question: 'AI 订阅商品的标价与结算价为什么不同？',
      answer: '支付方式、手续费、优惠和起订量可能改变结算金额。标价与结算价分开展示，最终金额以商家结算页为准。' },
    { question: '页面中的报价采集时间是否代表现在仍有库存？',
      answer: '不代表。采集时间只说明观测发生的时间；价格、库存和售后可能变化，付款前需回到来源商铺确认。' },
    { question: `${SITE_NAME}是否销售账号或提供交易担保？`,
      answer: '不销售、不代收货款，也不提供交易担保。本站仅展示报价信息；付款、交付、退款和售后由买家与商家处理。' },
  ],
} as const;

export const PRODUCT_SEO_CONTENT = {
  conclusion: '本页汇总该商品的第三方商铺报价；请按规格、期限和售后比较，最终价格以商家结算页为准。',
  facts: CATALOG_SEO_CONTENT.facts,
  faq: [
    { question: '同一商品名称下的报价是否包含相同套餐和使用期限？',
      answer: '不一定。商品名称用于归类，交付方式、期限、地区和售后以每条报价的商品说明为准；不同条件的报价不应直接比较。' },
    { question: '如何在商品详情页比较不同商铺的结算价？',
      answer: '先筛选规格和期限，再勾选最多3条报价进行对比。核对起订量、支付方式和采集时间后，打开来源商铺确认实际金额。' },
    ...CATALOG_SEO_CONTENT.faq.slice(1),
  ],
} as const;
