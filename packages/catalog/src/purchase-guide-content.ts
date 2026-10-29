import { PRODUCT_TAG_RULES } from './product-tag-policy.js';

export const PURCHASE_GUIDE_GROUPS = [
  { id: 'purchase', label: '购买内容' },
  { id: 'usage', label: '使用方式' },
  { id: 'requirements', label: '使用前提' },
  { id: 'limits', label: '期限额度' },
  { id: 'warranty', label: '售后保障' },
  { id: 'other', label: '其他条件' },
] as const;

type DisplayGroup = typeof PURCHASE_GUIDE_GROUPS[number]['id'];
type CollectionGroup = '交付形态' | '使用方式' | '账号属性' | '登录与验证' | '设备与地区' | '期限与额度' | '售后保障' | '其他使用条件';
export interface PurchaseGuideField {
  label: string;
  explanation: string;
  appliesTo: string;
  collectionGroup: CollectionGroup;
  displayGroup: DisplayGroup;
  /** Smaller numbers appear first; a priority is not a claim that a missing field is known. */
  summaryPriority: number;
  valueType: 'enum' | 'formatted' | 'text';
  rule: typeof PRODUCT_TAG_RULES[string];
  unknownHandling: 'omit';
}

// Display text is separate from the canonical validation vocabulary and model instructions.
const fields: Record<string, PurchaseGuideField> = {};
function define(collectionGroup: CollectionGroup, displayGroup: DisplayGroup, appliesTo: string, summaryPriority: number,
  entries: Array<[string, string, string]>): void {
  for (const [name, label, explanation] of entries) {
    const rule = PRODUCT_TAG_RULES[name];
    fields[name] = { label, explanation, collectionGroup, displayGroup, appliesTo, summaryPriority,
      valueType: rule.values ? 'enum' : rule.pattern ? 'formatted' : 'text', rule, unknownHandling: 'omit' };
  }
}

define('交付形态', 'purchase', '所有商品；仅记录商品资料明确承诺的交付内容', 10, [
  ['delivery', '购买内容', '区分成品账号、给已有账号充值和兑换权益。'],
  ['delivery_format', '交付资料', '商家实际提供的账密、兑换码、令牌或文件等资料格式。'],
  ['delivery_mode', '交付流程', '区分人工交付、自动发货和自行领取。'],
  ['email_included', '附带邮箱', '是否随商品提供邮箱，不代表可以修改邮箱。'],
]);
define('使用方式', 'usage', '账号、订阅及数字服务', 20, [
  ['access', '使用方式', '账号是独享还是多人共享，与能否反代分开说明。'],
  ['access_channel', '使用入口', '可使用的网页、反代、接口或邮件协议入口。'],
  ['supported_client', '支持软件', '资料明确支持的软件名称，不由交付文件格式推断。'],
  ['account_type', '账号角色', '区分子号、主号、席位、个人或企业账号。'],
  ['intended_use', '适用用途', '速刷等明确用途，不代表使用期限或稳定性保证。'],
  ['shared_users', '共享人数', '资料明确的共享人数，不等同于可用席位数。'],
  ['multi_open', '同时多开', '允许同时开启的实例数量。'],
]);
define('账号属性', 'purchase', '账号及邮箱商品', 60, [
  ['account_lifecycle', '账号新旧', '区分新号和老号，不据此推断具体注册时间。'],
  ['email_provider', '邮箱服务商', '交付邮箱所属服务商，不等同于邮箱域名。'],
  ['email_domain', '邮箱域名', '邮箱地址的域名后缀，不包含账号或密码。'],
  ['registration_year', '注册年份', '明确的注册年份或年份范围，不换算成精确号龄。'],
  ['followers', '粉丝数量', '商品资料注明的粉丝数量，不代表活跃度。'],
]);
define('登录与验证', 'requirements', '账号、充值及支付类商品；区分已完成状态和买家所需操作', 15, [
  ['login_method', '登录方式', '使用密码、邮箱验证码、OAuth 或单点登录。'],
  ['2fa', '双重验证', '是否配置或提供双重验证，不代表买家无需验证。'],
  ['sms_verification', '接码状态', '账号是否已经完成短信验证。'],
  ['sms_required', '需要短信验证', '买家使用时是否仍需进行短信验证。'],
  ['kyc', '实名认证状态', '账号是否已经通过实名认证。'],
  ['kyc_required', '需要实名认证', '买家使用时是否需要进行实名认证。'],
  ['card_binding_required', '需要绑卡', '使用或激活时是否需要绑定支付卡。'],
  ['3ds', '银行卡验证', '支付卡是否支持或具备 3DS 验证。'],
]);
define('设备与地区', 'requirements', '有明确设备、地区或网络条件的商品', 25, [
  ['device_platform', '适用设备', '支持的设备或操作系统，不代表充值渠道。'],
  ['payment_platform', '充值平台', '使用的充值平台，与可登录设备分开。'],
  ['region', '商品地区', '商品所属地区，不自动视为可用地区或推荐网络地区。'],
  ['region_options', '可选地区', '购买时明确可以选择的地区。'],
  ['recommended_ip_region', '建议网络地区', '商家建议使用的网络地区，不代表强制要求。'],
  ['registration_region', '注册地区', '账号注册时所属地区，不代表当前使用地区。'],
  ['payment_region', '支付地区', '充值或支付所用地区，不代表账号注册地。'],
  ['vpn_required', '需要代理网络', '资料明确说明是否需要代理网络。'],
]);
define('售后保障', 'warranty', '有明确售后说明的商品；未说明不等于无保障', 30, [
  ['warranty', '售后保障', '是否提供质保；有质保不代表覆盖所有问题。'],
  ['warranty_scope', '保障范围', '保障范围可能仅限首登、激活、首次接码或订阅。'],
  ['warranty_trigger', '保障起点', '保障期限从购买、交付、激活或首次登录开始。'],
  ['warranty_days', '质保天数', '明确按天承诺的质保时长，不扩大有限保障范围。'],
  ['warranty_window', '保障时间窗', '保障事件必须发生的时间范围，不等同于订阅期限。'],
  ['warranty_exclusion', '不保事项', '商家明确排除的售后问题，例如封号。'],
  ['warranty_detail', '补充保障', '明确的补充保障期限或仅保订阅条件。'],
  ['warranty_terms', '售后条款', '完整保留商家明确的售后前提、不保事项和退款换货限制，不省略条件或扩大承诺。'],
]);

const periods: Array<[string, string, string]> = [
  ['duration', '使用期限', '订阅或商品使用期限'], ['account_age', '账号年龄', '账号注册至今的时长'],
  ['token_validity', '令牌有效期', '交付令牌的有效期限'],
  ['redemption_code_validity', '兑换码有效期', '兑换码可兑换的期限'],
  ['sms_receive_link_duration', '接码链接有效期', '接收短信链接可用的期限'],
];
for (const [name, label, meaning] of periods) {
  define('期限与额度', 'limits', '明确注明相应期限的商品；不同对象的期限分别记录', 35,
    [[name, label, `${meaning}，不替代其他对象的期限。`],
      ...[['range', '范围', '明确上下限'], ['min', '下限', '至少'], ['max', '上限', '最多'], ['approx', '约数', '约为']]
        .filter(([suffix]) => Object.hasOwn(PRODUCT_TAG_RULES, `${name}_${suffix}`))
        .map(([suffix, suffixLabel, qualifier]): [string, string, string] =>
          [`${name}_${suffix}`, label + suffixLabel, `${meaning}的${qualifier}时长，保留原有单位和限定。`])]);
}
define('期限与额度', 'limits', '明确提供数量、额度或资源配置的商品', 40, [
  ['email_validity', '邮箱有效期', '交付邮箱的有效期限，不代表订阅期限。'],
  ['number_validity', '号码有效期', '交付号码的有效期限，不代表接码链接期限。'],
  ['credits_validity', '积分有效期', '积分可以使用的有效期限。'],
  ['quantity', '商品数量', '本次购买交付的数量。'], ['minimum_quantity', '最低购买量', '下单要求的最小数量。'],
  ['usage_count', '使用次数', '明确可用的使用次数。'], ['usage_count_max', '最多使用次数', '明确允许的最大使用次数。'],
  ['seats', '席位数量', '商品包含的可用席位数量，不推断共享人数。'],
  ['binding_limit', '绑定数量上限', '允许绑定的账号或对象数量上限。'],
  ['included_sms_count', '附带短信次数', '购买包含的短信接收次数。'], ['reset_count', '重置次数', '明确允许的重置次数。'],
  ['cpu_cores', '处理器核心数', '所购计算资源的核心数量。'], ['token_count', '令牌额度', '商品包含的 token 数量，不是令牌有效期。'],
  ['token_unit', '令牌计量单位', '商品明确标注的令牌计量口径。'],
  ['credits', '积分额度', '商品包含的积分数量，不自动换算货币。'], ['credits_range', '积分范围', '积分数量的明确上下限。'],
  ['amount', '面值', '商品金额或面值，保留币种。'], ['balance', '余额', '账号或卡内余额，保留币种。'],
  ['balance_range', '余额范围', '余额的明确上下限，保留币种。'],
  ['amount_daily', '每日金额额度', '每天可用的金额额度，保留币种。'], ['amount_monthly', '每月金额额度', '每月可用的金额额度，保留币种。'],
  ['credits_daily', '每日积分', '每天可用的积分数量。'], ['credits_monthly', '每月积分', '每月可用的积分数量。'],
  ['request_limit_hourly', '每小时请求数', '每小时允许的请求数量。'], ['request_limit_daily', '每日请求数', '每天允许的请求数量。'],
  ['storage', '存储容量', '可用的存储空间，保留容量单位。'], ['memory', '内存容量', '所购资源的内存容量，保留单位。'],
  ['data_quota', '流量额度', '包含的数据流量额度，保留单位。'], ['bandwidth', '带宽', '连接带宽上限，保留速率单位。'],
]);
define('其他使用条件', 'requirements', '有明确使用限制或续费条件的商品', 5, [
  ['usage_restriction', '使用限制', '保留商家明确的使用限制，不把禁止行为变成支持能力。'],
  ['single_use', '一次性使用', '是否仅能使用一次，不据此推断具体有效时长。'],
  ['subscription_override', '覆盖现有订阅', '充值是否可覆盖已有订阅。'],
  ['renewable', '能否续费', '是否允许继续续费或续租。'], ['renewal_timing', '续费时间', '区分随时续费和到期后才能续费。'],
]);
define('其他使用条件', 'other', '卡片、号码、网络或实物等对应商品；仅在适用时展示', 80, [
  ['card_network', '卡组织', '支付卡所属的银行卡组织。'], ['card_type', '卡片形态', '区分实体卡与虚拟卡。'],
  ['card_bin', '卡号段', '支付卡公开的前六至八位号段，不记录完整卡号。'],
  ['ip_type', '网络地址类型', '明确的住宅或动态住宅网络地址类型。'],
  ['sim_type', '电话卡形态', '区分实体电话卡与 eSIM。'], ['payment_method', '支付方式', '商品明确支持的支付方式。'],
  ['invoice', '提供发票', '是否明确提供发票，不等同于官方账单。'], ['official_bill', '官方账单', '是否明确提供官方账单。'],
  ['edition', '版本', '商家注明的具体商品版本。'], ['model', '型号', '商家注明的具体型号。'],
  ['carrier', '运营商', '电话卡或网络所属运营商。'], ['language', '语言', '商品支持或交付的语言。'],
  ['color', '颜色', '当前所选规格的商品颜色。'], ['material', '材质', '当前所选规格的商品材质。'], ['size', '尺寸', '当前所选规格的商品尺寸。'],
]);

/** Missing or unknown facts are omitted, never converted to a negative promise. */
export const PURCHASE_GUIDE_FIELDS: Readonly<Record<string, PurchaseGuideField>> = fields;

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
  glossaryIntroduction: '商品说明中的详细用词按下面 6 类收好，不用全部读完，点开需要的就行。',
} as const;
