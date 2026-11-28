import { PRODUCT_TAG_RULES } from './product-tag-policy.js';

export const PURCHASE_GUIDE_GROUPS = [
  { id: 'verification', label: '接码状态' }, { id: 'region', label: '地区' },
  { id: 'duration', label: '使用期限' }, { id: 'usage', label: '使用入口与支持工具' },
  { id: 'subscription', label: '覆盖现有订阅' }, { id: 'bulk', label: '批量购买' },
  { id: 'subscription_warranty', label: '订阅保障' }, { id: 'usage_warranty', label: '使用保障' },
] as const;
type DisplayGroup = typeof PURCHASE_GUIDE_GROUPS[number]['id'];
export interface PurchaseGuideField {
  label: string; explanation: string; appliesTo: string; collectionGroup: string; displayGroup: DisplayGroup;
  summaryPriority: number; valueType: 'enum' | 'formatted' | 'text'; rule: typeof PRODUCT_TAG_RULES[string]; unknownHandling: 'omit';
}
const definitions: Array<[string, string, DisplayGroup, string, string]> = [
  ['sms_verification', '接码状态', 'verification', '账号商品', '账号是否已经完成短信验证，不表示后续无需再次验证。'],
  ['region', '地区', 'region', '有明确地区的当前商品', '当前商品本身的地区，包括IP商品的地区；账号使用时推荐或要求的IP地区不是账号地区。'],
  ['duration', '使用期限', 'duration', '明确使用期限的商品', '以天数记录使用期限，1个月按30天、1年按365天；保留范围、至少、最多和约数，不混入质保或兑换期限。'],
  ['access_channel', '使用入口', 'usage', '账号、订阅及数字服务', '当前商品明确支持的网页、接口或协议入口，不从交付文件格式推断。'],
  ['supported_client', '支持工具', 'usage', '明确支持软件或工具的商品', '原文明确支持的工具名称；支持不能扩展为仅支持。'],
  ['subscription_override', '覆盖现有订阅', 'subscription', '订阅充值商品', '仅明确不能覆盖现有订阅时显示不可覆盖订阅，未说明或允许覆盖时省略。'],
  ['bulk_purchase', '批量购买', 'bulk', '明确批量销售的商品', '区分支持批量、多件起购和固定打包，不由库存或价格推断，不代替实际结算数量。'],
  ['subscription_warranty', '订阅保障', 'subscription_warranty', 'AI 会员商品', '商家承诺真实充值，提供可核对的充值订单，并兑现约定的会员权益。'],
  ['usage_warranty', '使用保障', 'usage_warranty', 'AI 会员商品', '商家对正常登录和约定期限内持续使用提供的保障。“首登”仅保首次登录。'],
];
export const PURCHASE_GUIDE_FIELDS: Readonly<Record<string, PurchaseGuideField>> = Object.fromEntries(definitions.map(([name, label, displayGroup, appliesTo, explanation], index) => [name, {
  label, explanation, appliesTo, displayGroup, collectionGroup: PURCHASE_GUIDE_GROUPS.find(g => g.id === displayGroup)!.label,
  summaryPriority: index + 1, valueType: name === 'duration' ? 'formatted' : PRODUCT_TAG_RULES[name].values ? 'enum' : 'text',
  rule: PRODUCT_TAG_RULES[name], unknownHandling: 'omit',
}]));

export const PURCHASE_GUIDE_CONTENT = {
  title: '选购指南',
  scenariosTitle: '商品类型',
  scenarios: [
    {
      id: 'guide-account', title: '成品号', choice: '用商家提供的账号',
      text: '已包含订阅保障，会员权益在商家提供的账号上。',
    },
    {
      id: 'guide-top-up', title: '代充', choice: '用你自己的账号',
      text: '已包含订阅保障，为自己的账号开通或续费会员。ChatGPT Plus 的代充进一步区分“通用”和“半价资格”，其他会员显示“代充”。通用不保证没有地区、订阅状态等其他购买限制，下单前仍需核对商品说明。',
    },
    {
      id: 'guide-rental', title: '租号', choice: '使用商家账号，按约定租用',
      text: '可为独享或多人共享，按约定的期限和方式使用。',
    },
    {
      id: 'guide-short-term', title: '短期', choice: '保障较短，或条件尚不明确',
      text: '包括明确的短期商品（不足 25 天）、仅有短时或首登保障，以及没有保障承诺或交付方式不明确的商品。“质保订阅”或“保整个订阅周期”按订单保障理解，不因未写具体天数归入短期。',
    },
  ],
  comparison: {
    title: '同样写着一个月，为什么不能只比价格？',
    note: '以下为虚构示例，不是实时报价。',
    columns: ['要看什么', '示例报价 A', '示例报价 B'],
    rows: [
      ['标价', '19 元 / 个', '29 元 / 个'],
      ['使用哪个账号', '商家提供的账号', '商家提供的账号'],
      ['谁在使用', '多人共享', '一人独享'],
      ['使用多久', '一个月', '一个月'],
      ['使用保障', '仅保首次登录', '7 天内无法登录可换号'],
    ],
    takeaway: '想独享就先排除 A。B 的使用期限是一个月，登录问题保障是 7 天。比较价格时，也要比较使用方式和保障期限。',
  },
  warrantiesTitle: '两种保障，分开看',
  moreTitle: '购买前了解更多',
  checklistTitle: '下单前，确认四件事',
  checklist: [
    { title: '能不能用', text: '设备、地区、网络和现有订阅是否适用，有无次数或额度限制。' },
    { title: '一共多少钱', text: '核对规格、币种和起购数量，单价不一定是实付总价。' },
    { title: '能用多久', text: '何时交付、从何时计时；兑换截止时间不等于使用期限。' },
    { title: '出问题怎么办', text: '问清保障期限、补发或退款方式，保留订单与商家承诺。' },
  ],
  glossaryTitle: '其他商品术语',
  twoFactor: {
    title: '2FA（双重验证）',
    text: '登录时，除了账号密码，还需通过第二种方式验证身份，例如输入验证器生成的动态验证码。',
  },
} as const;
