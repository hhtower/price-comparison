import type { ExtractionInput } from '../../src/ai/adaptive-batching.js';
import type { Identity } from '../../src/standardization/identity-policy.js';

// Synthetic sale assertions; no merchant URLs, credentials or contact information.
export const identityGuardRegressions: Array<{ input: ExtractionInput; identity: Identity }> = [
  ...[
    ['team-json-sub2', 'Team 5X 成品JSON', '已开通Team 5X成品账号，仅支持Sub2API。', 'team_5x'],
    ['team-rt-sub2', 'G Team 子号Token', '实时验活的ChatGPT Team子号，含RT。CPA JSON和sub2api JSON交付。', 'team'],
    ['team-negated-5x', 'Team标准席位', '提供标准席位，也不是5Xteam。', 'team'],
    ['team-usage-comparison', 'Team标准席位', '交付Team账号，额度是Plus的1.25倍。', 'team'],
    ['team-registered-mail', 'Team 5X Gmail邮箱', '本商品为Team 5X成品账号，Gmail注册，交付账密2FA。', 'team_5x'],
  ].map(([id, name, evidence, tier]) => ({ input: { id: id!, name: name!, spec: '', sourceData: { evidence: evidence! } },
    identity: { family: 'openai', product: 'chatgpt', tier: tier! } })),
  {
    input: { id: 'team-comparison', name: 'Codex Team 月度车位', spec: '',
      sourceData: { evidence: '<p>交付Team车位，订阅30天，每月续费。</p><p>可与Plus并存；Plus额度不足且不想升级Pro时可以使用Team。</p><p>价格与Plus作比较，包含15次Pro模型使用机会。</p><p>Business母号可另购。</p>' } },
    identity: { family: 'openai', product: 'chatgpt', tier: 'team' },
  },
  {
    input: { id: '1', name: 'Codex Go 官方充值', spec: '',
      sourceData: { evidence: '<p>商品内容：Codex Go 一个月订阅。</p><p>3 已加入 TEAM / 组织的账户，需要先退出团队或切换至个人账户。</p>' } },
    identity: { family: 'openai', product: 'chatgpt', tier: 'go' },
  },
  {
    input: { id: '2', name: 'Codex Pro 5x 官方充值', spec: '',
      sourceData: { evidence: '<p>交付 Pro 5x 订阅。</p><p>仅限当前没有 GO、PLUS、PRO 等有效订阅的账户。</p>' } },
    identity: { family: 'openai', product: 'chatgpt', tier: 'pro_5x' },
  },
  {
    input: { id: '3', name: 'Google 老邮箱', spec: '',
      sourceData: { evidence: '<p>只包登录邮箱，发货邮箱、密码、辅助邮箱、2FA。</p><p>拿去开各种会员请先修改2FA，再自行充值会员。</p>' } },
    identity: { family: 'google', product: 'email', tier: 'standard' },
  },
  {
    input: { id: '4', name: '美国住宅 IP', spec: '',
      sourceData: { evidence: '<p>提供家庭住宅 IP 资源，购买后发代理订阅链接。</p><p>提升 GPT、Claude Code 等 AI 工具的访问稳定性。</p>' } },
    identity: { family: 'network', product: 'ip', tier: 'standard' },
  },
  {
    input: { id: '5', name: 'Codex Free 苹果邮箱 iCloud 已接短信 2FA', spec: '',
      sourceData: { evidence: '<p>Codex Free账号，iCloud邮箱已接短信。</p><p>发货邮箱----密码----2FA，提供登录JSON文件。</p>' } },
    identity: { family: 'openai', product: 'chatgpt', tier: 'free' },
  },
  ...[
    ['6', 'Meta/Muse', 'meta', 'meta_sms'],
    ['7', 'Discord', 'discord', 'discord_sms'],
    ['8', 'PayPal', 'paypal', 'paypal_sms'],
    ['9', 'YouTube', 'google', 'google_sms'],
    ['10', 'Facebook', 'facebook', 'facebook_sms'],
    ['11', 'Amazon', 'amazon', 'amazon_sms'],
    ['12', 'WeChat', 'wechat', 'wechat_sms'],
    ['13', 'X/Twitter', 'twitter', 'twitter_sms'],
    ['14', 'Luma', 'luma', 'luma_sms'],
  ].map(([id, platform, family, product]) => ({
    input: { id: id!, name: `${platform} 接马 美国手机号`, spec: '',
      sourceData: { evidence: `<p>发货格式：手机号----取码链接。</p><p>只接 ${platform} 的短信验证码。</p>` } },
    identity: { family: family!, product: product!, tier: 'standard' },
  })),
];
