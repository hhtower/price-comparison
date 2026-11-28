import type { MembershipKind } from '@price-comparison/catalog/membership-policy';
import type { MembershipFeatureReviewFeedback } from '../../src/ai/membership-feature-request.js';

export const MEMBERSHIP_FEATURE_FIXTURE_VERSION = 'membership-feature-cases-20261128-v1';
export const MEMBERSHIP_FEATURE_HELD_OUT_IDS: readonly string[] = ['130', '131', '132'];

export interface MembershipFeatureCase {
  id: string;
  name: string;
  spec: string;
  expectedKind: MembershipKind;
  proposedKind: MembershipKind;
  reviewCode: MembershipFeatureReviewFeedback['code'];
  reason: string;
}

// 101-129 preserve the e8c63e74 examples; 130-132 are held-out paraphrases.
// Review recordings must assess proposedKind with refs [0, 1], independently of generation.
export const membershipFeatureCases: readonly MembershipFeatureCase[] = [
  {
    id: '101', name: '团队月席位', spec: '给客服发你自己的邮箱，邀请进入工作区。质保订阅30天，个人封号不保。',
    expectedKind: 'top_up', proposedKind: 'top_up', reviewCode: null,
    reason: '买家邮箱接受邀请，订阅保障30天；个人封号免责不否定订阅保障。',
  },
  {
    id: '102', name: '母号代充', spec: '人工充值两个标准席位，质保订阅30天，封号不保。',
    expectedKind: 'top_up', proposedKind: 'account', reviewCode: 'delivery_mismatch',
    reason: '所售为代充，母号角色和席位数量不能推导卖家交付账号。',
  },
  {
    id: '103', name: '会员账号', spec: '店家提供邮箱密码，独享。保订阅25天，登录问题仅首登十分钟内处理。',
    expectedKind: 'account', proposedKind: 'account', reviewCode: null,
    reason: '卖家独享账号且订阅保障达到25天；首登处理期限不缩短订阅保障。',
  },
  {
    id: '104', name: '多人共享', spec: '一个店家账号供三位买家登录。保证持续使用26天，到期收回。',
    expectedKind: 'rental', proposedKind: 'rental', reviewCode: null,
    reason: '共享并回收卖家账号，持续使用保障26天独立满足门槛。',
  },
  {
    id: '105', name: '共享周卡', spec: '卖家账号租用七天，七天全程包用。官方月费25美元，月卡另购。',
    expectedKind: 'short_term', proposedKind: 'rental', reviewCode: 'protection_mismatch',
    reason: '实际所售仅七天；官方月费和另售月卡不能延长本订单期限。',
  },
  {
    id: '106', name: '月权益车位', spec: '质保订阅30天。CDK发货，自助兑换。',
    expectedKind: 'short_term', proposedKind: 'top_up', reviewCode: 'delivery_mismatch',
    reason: '订阅保障已满足，但CDK形式无法确定充值买家账号还是交付卖家账号。',
  },
  {
    id: '107', name: '买家自有账号代充 保订阅30天', spec: '店家共享账号，只保首登。',
    expectedKind: 'top_up', proposedKind: 'short_term', reviewCode: 'protection_mismatch',
    reason: '同一商品标题明确买家账号及30天订阅保障，优先于低层级冲突规格。',
  },
  {
    id: '108', name: '会员账号', spec: '买家提供自己的账号充值，保订阅30天。',
    expectedKind: 'top_up', proposedKind: 'top_up', reviewCode: null,
    reason: '泛称会员账号不决定交付方式；规格明确充值买家账号且保障30天。',
  },
  {
    id: '109', name: '独享成品账号 使用30天', spec: '卖家提供账号，仅保首登。',
    expectedKind: 'short_term', proposedKind: 'account', reviewCode: 'protection_mismatch',
    reason: '30天使用期限不是保障承诺，仅保首登不满足订阅或持续使用保障。',
  },
  {
    id: '110', name: 'Plus 半价资格号代充', spec: '买家自备有半价资格的账号，保订阅30天。',
    expectedKind: 'top_up_half_price', proposedKind: 'top_up', reviewCode: 'delivery_mismatch',
    reason: '明确要求买家账号具有半价订阅资格，应保留该充值前提。',
  },
  {
    id: '111', name: 'Plus 新旧号代充', spec: '给买家自己的账号充值，保订阅30天。',
    expectedKind: 'top_up', proposedKind: 'top_up_half_price', reviewCode: 'delivery_mismatch',
    reason: '新旧号代充没有声明半价资格要求，不能从市场惯例推断。',
  },
  {
    id: '112', name: 'Plus 代充 无需半价资格', spec: '给买家自己的账号充值，保订阅30天。',
    expectedKind: 'top_up', proposedKind: 'top_up', reviewCode: null,
    reason: '标题明确免除半价资格要求，属于普通买家账号充值。',
  },
  {
    id: '113', name: 'Plus 代充', spec: '本商品给买家账号充值，保订阅30天。另售更便宜的套餐：仅限半价资格号。',
    expectedKind: 'top_up', proposedKind: 'top_up_half_price', reviewCode: 'delivery_mismatch',
    reason: '半价资格只约束另售套餐，不能迁移到当前订单。',
  },
  {
    id: '114', name: 'Plus 半价资格号代充', spec: '给买家账号充值，订阅30天，仅保首登。',
    expectedKind: 'short_term', proposedKind: 'top_up_half_price', reviewCode: 'protection_mismatch',
    reason: '有半价资格不能替代保障；30天订阅寿命及首登保障仍不够。',
  },
  {
    id: '115', name: 'Grok Plus 半价资格代充', spec: '给买家自己的账号充值，必须有半价资格，保订阅30天。',
    expectedKind: 'top_up_half_price', proposedKind: 'top_up_half_price', reviewCode: null,
    reason: '账户资格事实不因产品品牌不同而改变。',
  },
  {
    id: '116', name: 'ChatGPT Pro 半价资格代充', spec: '给买家自己的账号充值，必须有半价资格，保订阅30天。',
    expectedKind: 'top_up_half_price', proposedKind: 'top_up_half_price', reviewCode: null,
    reason: '账户资格事实不因产品档位不同而改变。',
  },
  {
    id: '117', name: 'plus 半价卡密充值 质保订阅30天', spec: '发货形式为卡密加充值网址，提交买家账号 Session 自助充值。',
    expectedKind: 'top_up_half_price', proposedKind: 'top_up', reviewCode: 'delivery_mismatch',
    reason: '标题指明半价充值路线，规格明确充值买家账号；卡密不是卖家账号交付。',
  },
  {
    id: '118', name: 'plus 半价卡密充值 质保订阅30天', spec: '半价指本店促销价格，给买家自己的账号充值，无需账号优惠资格。',
    expectedKind: 'top_up', proposedKind: 'top_up_half_price', reviewCode: 'delivery_mismatch',
    reason: '规格澄清半价为商家促销且免除账号资格，不构成与标题的资格冲突。',
  },
  {
    id: '119', name: '会员月卡代充', spec: '仅限官方结算页显示五折订阅优惠的买家账号，给自己的账号充值，保订阅30天。',
    expectedKind: 'top_up_half_price', proposedKind: 'top_up_half_price', reviewCode: null,
    reason: '官方结算页五折优惠是账户订阅资格，虽未使用固定资格号措辞仍成立。',
  },
  {
    id: '120', name: 'Pro 5X 代充', spec: '给买家自己的账号续费，质保订阅整个周期，封号不保。',
    expectedKind: 'top_up', proposedKind: 'short_term', reviewCode: 'protection_mismatch',
    reason: '整个购买周期的订阅保障无需重复数字天数，封号免责不否定该层保障。',
  },
  {
    id: '121', name: '会员成品号', spec: '卖家提供独享账号，质保订阅，掉订阅按剩余天数退款。',
    expectedKind: 'account', proposedKind: 'short_term', reviewCode: 'protection_mismatch',
    reason: '所购订阅异常按剩余天数退款建立订单保障，不需要另写30天。',
  },
  {
    id: '122', name: '多人共享订阅', spec: '租用店家账号，多人共用，到期回收；质保订单整个订阅周期。',
    expectedKind: 'rental', proposedKind: 'short_term', reviewCode: 'protection_mismatch',
    reason: '共享租用账号具有订单整个订阅周期保障，不能因缺数字期限误判短期。',
  },
  {
    id: '123', name: 'CursorPro Auto号2天授权码400刀大礼包', spec: '卖家授权码登录。有效期2天，质保2天订阅。',
    expectedKind: 'short_term', proposedKind: 'account', reviewCode: 'protection_mismatch',
    reason: '实际所售及保障均仅两天，全程保障不改变明确的短期订单。',
  },
  {
    id: '124', name: '会员月卡代充', spec: '充值买家账号，一个月订阅，只有首登10分钟保障，不保订阅。',
    expectedKind: 'short_term', proposedKind: 'top_up', reviewCode: 'protection_mismatch',
    reason: '明示不保订阅且仅首登保障，月订阅长度本身不能通过保障门槛。',
  },
  {
    id: '125', name: 'Pro 代充', spec: '充值买家账号，质保订阅，但只保7天，之后无售后。',
    expectedKind: 'short_term', proposedKind: 'top_up', reviewCode: 'protection_mismatch',
    reason: '具体七天售后上限约束泛称质保订阅，且没有另一层合格保障。',
  },
  {
    id: '126', name: '会员代充', spec: '给买家账号充值，掉订阅按未用天数退赔，封号不保。',
    expectedKind: 'top_up', proposedKind: 'short_term', reviewCode: 'protection_mismatch',
    reason: '未用订阅天数退赔建立本订单订阅保障，封号免责单独处理。',
  },
  {
    id: '127', name: '会员代充 质保订阅', spec: '充值买家账号。充值成功后不退不换；订阅异常按官方退款流程处理。',
    expectedKind: 'top_up', proposedKind: 'short_term', reviewCode: 'protection_mismatch',
    reason: '成功购买不退不换和退款流程不否定标题承诺的订阅异常保障。',
  },
  {
    id: '128', name: '会员代充', spec: '充值买家账号，质保订阅30天，封号只保7天。',
    expectedKind: 'top_up', proposedKind: 'short_term', reviewCode: 'protection_mismatch',
    reason: '订阅保障30天已合格，另一层封号保障七天不缩短订阅保障。',
  },
  {
    id: '129', name: '独享成品号', spec: '卖家提供账号，持续使用保障30天，订阅只保7天。',
    expectedKind: 'account', proposedKind: 'short_term', reviewCode: 'protection_mismatch',
    reason: '持续使用保障30天独立合格，订阅层仅七天不否定另一层。',
  },
  {
    id: '130', name: '自用邮箱会员续订', spec: '沿用您正在登录的账户办理续订。本次买到的订阅若中途消失，未享用部分由我们赔付；首次登录请当天完成，赔付款三个工作日到账。',
    expectedKind: 'top_up', proposedKind: 'short_term', reviewCode: 'protection_mismatch',
    reason: '未享用部分赔付覆盖购买订单；首次登录要求和赔付到账时间不是保障期限。',
  },
  {
    id: '131', name: '合用账号三周体验', spec: '多人共用店家登录凭据，购买后可用21天，期满收回。您买到的这一期全程兜底，无法使用即退剩余费用。',
    expectedKind: 'short_term', proposedKind: 'rental', reviewCode: 'protection_mismatch',
    reason: '完整覆盖本期也不能把明确21天的短期订单变成长保障租用。',
  },
  {
    id: '132', name: '个人账户优惠续订通道', spec: '请先在自己的订阅管理页确认：本账户续订应付为标准订阅费的一半。只有享有此官方权益的账户才能办理；服务覆盖本次购买的完整订阅期，掉订阅退还未用部分。',
    expectedKind: 'top_up_half_price', proposedKind: 'top_up', reviewCode: 'delivery_mismatch',
    reason: '要求账户本身拥有官方减半续订权益，不是店铺降价；完整购买期保障已成立。',
  },
];
