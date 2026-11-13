import { PRODUCT_TAG_RULES } from './product-tag-policy.js';

export const PURCHASE_GUIDE_GROUPS = [
  { id: 'verification', label: '接码状态' }, { id: 'region', label: '地区' },
  { id: 'duration', label: '使用期限' }, { id: 'usage', label: '使用入口与支持工具' },
  { id: 'subscription', label: '覆盖现有订阅' }, { id: 'bulk', label: '批量购买' },
  { id: 'warranty', label: '售后保障' },
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
  ['warranty', '售后保障', 'warranty', '所有有明确保障的商品', '完整保留保障范围、期限、起算点及必要免责；无售后或未说明不展示，不从会员分类推断具体保障。'],
];
export const PURCHASE_GUIDE_FIELDS: Readonly<Record<string, PurchaseGuideField>> = Object.fromEntries(definitions.map(([name, label, displayGroup, appliesTo, explanation], index) => [name, {
  label, explanation, appliesTo, displayGroup, collectionGroup: PURCHASE_GUIDE_GROUPS.find(g => g.id === displayGroup)!.label,
  summaryPriority: index + 1, valueType: name === 'duration' ? 'formatted' : PRODUCT_TAG_RULES[name].values ? 'enum' : 'text',
  rule: PRODUCT_TAG_RULES[name], unknownHandling: 'omit',
}]));

export const PURCHASE_GUIDE_CONTENT = {
  title: '新手选购指南',
  headline: '先选对，再比价。',
  introduction: '先分清你是要给已有账号开通权益，还是购买商家提供的账号。代充、发兑换码是完成购买的方式，不能单凭这些名称判断买完能得到什么。',
  scenariosTitle: '你想怎么买？',
  scenarios: [
    {
      id: 'guide-top-up', title: '我有账号，想开通或续费', choice: '先确认「用自己的账号」',
      text: '买完后，权益应开到你指定的账号上。商家可能代充，也可能发码让你兑换，要确认适用条件。“成品号”通常是另给一个账号，不是给你的账号续费。',
      check: '核对账号地区和现有订阅，问清能否叠加时长、是否覆盖现有权益，还是需要到期后操作；如果发兑换码，还要确认兑换截止时间。',
      question: '这个规格能在我的账号开通或续费吗？如果已有订阅会覆盖还是延长？买完怎么操作，开通后能用多久？',
      pitfall: '兑换截止时间不等于会员时长；“30 天内兑换”不代表能用 30 天。“接码”只收验证码，不等于开通会员。',
    },
    {
      id: 'guide-account', title: '我想买一个账号用', choice: '找「成品账号」，再分独享和共享',
      text: '独享是自己使用，共享是和别人共用。收到账号密码，不代表你能改密码、换邮箱，也不代表账号只归你使用。',
      check: '确认从哪里登录、能用哪些设备、有没有地区或网络要求。只想自己用，就先排除共享商品。',
      question: '这个账号会和别人共用吗？能改密码或邮箱吗？我用的设备和地区能登录吗？登不上或中途不能用了怎么处理？',
      pitfall: '“独享”描述使用方式，不是永久可用或账号所有权的承诺。',
    },
  ],
  comparison: {
    title: '同样写着一个月，为什么不能只比价格？',
    note: '以下为虚构示例，不是实时报价。',
    columns: ['要看什么', '示例报价 A', '示例报价 B'],
    rows: [
      ['标价', '19 元 / 个', '29 元 / 个'],
      ['买到什么', '成品账号', '成品账号'],
      ['谁在使用', '多人共享', '一人独享'],
      ['使用多久', '一个月', '一个月'],
      ['出了问题保什么', '仅保首次登录', '7 天内无法登录可换号'],
    ],
    takeaway: '如果你想一个人用，A 就不符合需求。B 的售后也只写了 7 天内的登录问题，不代表整个月的所有问题都保。先选符合需求的条件，再比较价格。',
  },
  checklistTitle: '下单前，把这 4 件事问清楚',
  checklist: [
    { title: '我能不能用？', text: '把自己的设备、地区、账号和现有订阅情况告诉商家，确认是否适用。页面没写的条件，不代表没有限制。' },
    { title: '这次一共付多少？', text: '看清所选规格、币种和起购数量。“每件 5 元，10 件起购”至少要付 50 元；别把单价当总价。' },
    { title: '什么时候拿到、能用多久？', text: '问清是自动发货还是等待人工处理，使用期限从付款、激活还是首次登录开始算，是否还有次数或额度限制。' },
    { title: '出问题找谁、怎么处理？', text: '“首登”就是首次登录；“仅保首登”不是保整个月。问清可反馈的期限、哪些情况不保、是补发、换号还是退款，并保留下单规格和商家承诺。' },
  ],
  nextTitle: '回到报价里，按这个顺序看',
  nextText: '搜索商品 → 选具体商家和规格 → 打开“商品说明”核对条件 → 比较符合需求的报价 → 点“去商家”确认后再下单。',
  caution: '本站汇总第三方报价，不参与交易或提供售后。价格、库存和条件可能变化，下单前以商家当前页面为准；报价有误可在该报价举报。',
  glossaryTitle: '有词看不懂？按需查这里',
  glossaryIntroduction: '商品说明中的详细用词按下面 7 类收好，不用全部读完，点开需要的就行。',
} as const;
