import type { StandardizationFlowControl } from '../../src/standardization/flow-evaluation.js';
import type { CandidateDocument } from '../../src/standardization/candidate-index.js';

const free = { family: 'openai', product: 'chatgpt', tier: 'free' };
const plus = { family: 'openai', product: 'chatgpt', tier: 'plus' };
const pro200 = { family: 'openai', product: 'chatgpt', tier: 'pro_20x' };
const pro500 = { family: 'openai', product: 'chatgpt', tier: 'pro_500' };
const team = { family: 'openai', product: 'chatgpt', tier: 'team' };
const team5x = { ...team, tier: 'team_5x' };
const max = { family: 'anthropic', product: 'claude', tier: 'max_20x' };
const jimeng = { family: '即梦', product: '即梦', tier: '高级会员' };
const canva = { family: 'canva', product: 'canva', tier: 'pro' };
const tavily = { family: 'tavily', product: 'search', tier: 'standard' };
const apple = { family: 'apple', product: 'apple_id', tier: 'standard' };
const cite = (path: string, quote: string) => ({ path, quote });
const tag = (name: string, value: string, quote: string) => ({
  name, value, evidence: [cite('sourceData.evidence', quote)],
});

// Minimal rewritten facts, independently hand-reviewed; numeric catalog IDs are generated locally, not seller IDs.
export const standardizationFlowCatalog: readonly CandidateDocument[] = [
  { id: '90001', ...free, aliases: ['ChatGPT Free'] },
  { id: '90002', ...plus, aliases: ['Chat G Plus'] },
  { id: '90003', ...team, aliases: ['Codex Team'] },
  { id: '90011', ...team5x, aliases: ['Team 5X', 'Business 5X'] },
  { id: '90009', ...pro500, aliases: ['ChatGPT Pro 500', 'ChatGPT Pro 25x'] },
  { id: '90010', ...pro200, aliases: ['ChatGPT Pro 200', 'ChatGPT Pro 10x', 'ChatGPT Pro 20x'] },
  { id: '90004', ...max, aliases: ['Claude MAX20x'] },
  { id: '90005', ...jimeng, aliases: ['即梦高级会员'] },
  { id: '90006', ...canva, aliases: ['Canva Pro'] },
  { id: '90007', ...tavily, aliases: ['Tavily 搜索 API'] },
  { id: '90008', ...apple, aliases: ['Apple ID'] },
];

export const standardizationFlowControls: readonly StandardizationFlowControl[] = [
  {
    id: 'team-json-software', name: 'Team 5X 成品JSON', body: '已开通Team 5X账号，成品JSON交付，仅支持Sub2API。',
    soldObject: 'Activated Team 5X account credentials limited to Sub2API', expectedIdentity: team5x, proposalIdentity: team5x,
    expectedDisposition: 'release', expectedTags: { delivery_format: 'json', supported_client: 'sub2api', usage_restriction: '仅支持sub2api' },
    proposalTags: [tag('delivery_format', 'json', 'JSON'), tag('supported_client', 'sub2api', 'Sub2API'), tag('usage_restriction', '仅支持sub2api', '仅支持Sub2API')],
  },
  {
    id: 'team-rt-credentials', name: 'G Team 子号Token', body: '实时验活的ChatGPT Team子号，含RT凭证。CPA JSON和sub2api导入JSON。',
    soldObject: 'Standard Team account authorization, not model API credits', expectedIdentity: team, proposalIdentity: team,
    expectedDisposition: 'release',
  },
  {
    id: 'team-standard-negation', name: 'Team标准席位', body: '提供标准席位，也不是5Xteam。',
    soldObject: 'Standard Team seat with an explicit 5X denial', expectedIdentity: team, proposalIdentity: team,
    expectedDisposition: 'release',
  },
  {
    id: 'team-standard-negation-wrong', name: 'Team标准席位', body: '提供标准席位，也不是5Xteam。',
    soldObject: 'Standard Team seat wrongly proposed as 5X', expectedIdentity: team, proposalIdentity: team5x,
    expectedDisposition: 'review', expectedIdentityConflict: true, expectedReasonCode: 'identity_conflict',
  },
  {
    id: 'team-comparison-multiplier', name: 'Team标准席位', body: '交付Team账号，额度是Plus的1.25倍。',
    soldObject: 'Standard Team account; the Plus comparison is not a tier', expectedIdentity: team, proposalIdentity: team,
    expectedDisposition: 'release',
  },
  {
    id: 'team-registered-gmail', name: 'Team 5X Gmail邮箱', body: '本商品为Team 5X成品账号，Gmail注册，交付账密2FA。',
    soldObject: 'Team 5X account with a registration mailbox', expectedIdentity: team5x, proposalIdentity: team5x,
    expectedDisposition: 'release',
  },
  {
    id: 'team-tool-not-subscription', name: 'Team提链CDK', body: '仅提供结账链接生成工具，不含账号及订阅费用。',
    soldObject: 'Checkout tool without Team entitlement', expectedIdentity: null, proposalIdentity: team,
    expectedDisposition: 'review', expectedIdentityConflict: true, expectedReasonCode: 'identity_conflict',
  },
  {
    id: 'team-premium-unknown', name: 'Business premium 成品账号', body: 'JSON交付，仅支持Sub2API，未注明实际档位。',
    soldObject: 'Account credentials with unresolved premium tier', expectedIdentity: null, proposalIdentity: team5x,
    expectedDisposition: 'review', expectedIdentityConflict: true, expectedReasonCode: 'identity_conflict',
  },
  {
    id: 'team-ban-not-capability', name: 'Team 5X成品账号', body: '交付Team 5X账号，禁止反代。',
    soldObject: 'Team 5X account with a prohibition, not supported proxy use', expectedIdentity: team5x, proposalIdentity: team5x,
    expectedDisposition: 'release', expectedTags: { usage_restriction: '禁止反代' },
    proposalTags: [tag('usage_restriction', '禁止反代', '禁止反代'), tag('access_channel', 'reverse_proxy', '反代')],
  },
  {
    id: 'registered-gmail-free', name: 'Gmail注册 Free 已接码',
    body: 'Gmail邮箱注册Free；不提供Gmail邮箱，无法登录Gmail，只提供ChatGPT Free账号和密码。',
    soldObject: 'ChatGPT Free account, not a Gmail mailbox',
    expectedIdentity: free, proposalIdentity: free, expectedDisposition: 'release',
  },
  {
    id: 'team-seat-comparison', name: 'Codex Team月权益车位',
    body: '交付Team月权益车位，可与Plus并存，缓解额度，不想升级Pro。',
    soldObject: 'ChatGPT Team seat', expectedIdentity: team, proposalIdentity: team, expectedDisposition: 'release',
  },
  {
    id: 'chat-g-plus', name: 'Chat G Plus 成品账号', body: '交付Chat G Plus账号，附带登录教程。',
    soldObject: 'ChatGPT Plus account', expectedIdentity: plus, proposalIdentity: plus, proposalAction: 'reuse_candidate',
    expectedDisposition: 'release',
  },
  {
    id: 'claude-ad-relay', name: 'Claude MAX20x IOS充值',
    body: '正规代充Claude MAX20x订阅；如需模型中转API可另购。',
    soldObject: 'Claude Max 20x subscription top-up', expectedIdentity: max, proposalIdentity: max, expectedDisposition: 'release',
  },
  {
    id: 'tavily-search-api', name: 'Tavily 搜索 API',
    body: 'Tavily官方搜索API，每月1000搜索次数。',
    soldObject: 'Official search API, not model relay credits', expectedIdentity: tavily, proposalIdentity: tavily,
    expectedDisposition: 'release',
  },
  {
    id: 'apple-id-balance', name: 'Apple ID 美区账号附赠余额',
    body: '交付Apple ID账号，可下载APP，附赠账户余额。',
    soldObject: 'Apple ID account with incidental balance', expectedIdentity: apple, proposalIdentity: apple, expectedDisposition: 'release',
  },
  {
    id: 'jimeng-canva-conflict', name: '即梦高级会员月卡',
    body: '实际交付Canva Pro兑换码。',
    soldObject: 'Canva redemption contradicting Jimeng title', expectedIdentity: canva, proposalIdentity: jimeng,
    expectedDisposition: 'review', expectedIdentityConflict: true, expectedReasonCode: 'identity_conflict',
  },
  {
    id: 'pro-25x-alias', name: 'ChatGPT Pro25x账号', body: '交付Pro25x订阅账号。',
    soldObject: 'Pro 25x market alias for Pro 500', expectedIdentity: pro500,
    proposalIdentity: { family: 'openai', product: 'chatgpt', tier: 'pro_20x' },
    expectedDisposition: 'review', expectedIdentityConflict: true, expectedReasonCode: 'identity_conflict',
  },
  {
    id: 'pro-200-equivalent-multipliers', name: 'ChatGPT Pro 200 10x（原20x）账号',
    body: '交付Pro 200订阅账号，商家也称10x或历史20x。',
    soldObject: 'One Pro 200 subscription with equivalent multiplier labels',
    expectedIdentity: pro200, proposalIdentity: pro200, expectedDisposition: 'release',
  },
  {
    id: 'pro-500-equivalent-multipliers', name: 'ChatGPT Pro 500 25x（原50x）账号',
    body: '交付Pro 500订阅账号。',
    soldObject: 'One Pro 500 subscription with equivalent multiplier labels',
    expectedIdentity: pro500, proposalIdentity: pro500, expectedDisposition: 'release',
  },
  {
    id: 'pro-unselected-amount-menu', name: 'ChatGPT Pro 200 / Pro 500账号',
    body: '两档套餐可选，当前未选定套餐。',
    soldObject: 'Unselected menu of different Pro subscription tiers',
    expectedIdentity: null, proposalIdentity: pro500, expectedDisposition: 'review',
    expectedIdentityConflict: true, expectedReasonCode: 'identity_conflict',
  },
  {
    id: 'pro-price-not-tier', name: 'ChatGPT Pro 200账号 售价500美元',
    body: '实际交付Pro 200订阅账号。',
    soldObject: 'Pro 200 subscription; merchant sale price is not the plan name',
    expectedIdentity: pro200, proposalIdentity: pro200, expectedDisposition: 'release',
  },
  {
    id: 'pro-price-wrong-tier', name: 'ChatGPT Pro 200账号 售价500美元',
    body: '实际交付Pro 200订阅账号。',
    soldObject: 'Pro 200 subscription incorrectly proposed as Pro 500 from the price',
    expectedIdentity: pro200, proposalIdentity: pro500, expectedDisposition: 'review',
    expectedIdentityConflict: true, expectedReasonCode: 'identity_conflict',
  },
  {
    id: 'rt-no-credentials', name: 'ChatGPT Free RT',
    body: '实际只提供RT，不带邮箱密码。',
    soldObject: 'ChatGPT Free token, no mailbox credentials', expectedIdentity: free, proposalIdentity: free, expectedDisposition: 'release',
  },
  {
    id: 'rt-wrong-credentials', name: 'ChatGPT Free RT',
    body: '实际只提供RT，不带邮箱密码。提供登录JSON文件。',
    soldObject: 'ChatGPT Free token/JSON, no mailbox credentials', expectedIdentity: free, proposalIdentity: free,
    expectedDisposition: 'release', expectedTags: { delivery_format: 'json' },
    proposalTags: [tag('delivery_format', 'credentials', '邮箱密码'), tag('delivery_format', 'json', 'JSON')],
  },
  {
    id: 'import-not-warranty', name: 'ChatGPT Plus 账号',
    body: '首次登录请在1小时内导入。',
    soldObject: 'ChatGPT Plus account, import instruction is not a warranty',
    expectedIdentity: plus, proposalIdentity: plus, expectedDisposition: 'release',
    proposalTags: [tag('warranty_days', '30', '1小时内导入')],
  },
  {
    id: 'us-region', name: 'ChatGPT Plus 美国区账号', body: '交付美国区账号。',
    soldObject: 'US-region ChatGPT Plus account', expectedIdentity: plus, proposalIdentity: plus, expectedDisposition: 'release',
    proposalTags: [tag('region', 'us', '美国区')], expectedTags: { region: 'us' },
  },
  {
    id: 'random-not-us', name: 'ChatGPT Plus 账号', body: '随机区账号。',
    soldObject: 'ChatGPT Plus account, region unspecified/random', expectedIdentity: plus, proposalIdentity: plus,
    expectedDisposition: 'release', proposalTags: [tag('region', 'us', '随机区')],
  },
  {
    id: 'actual-10-usd', name: 'ChatGPT Plus 账号', body: '账户余额10美元。',
    soldObject: 'ChatGPT Plus account with 10 USD balance', expectedIdentity: plus, proposalIdentity: plus,
    expectedDisposition: 'release', proposalTags: [tag('balance', '10 usd', '10美元')], expectedTags: { balance: '10 usd' },
  },
  {
    id: 'wrong-100-usd', name: 'ChatGPT Plus 账号', body: '账户余额10美元。',
    soldObject: 'ChatGPT Plus account with 10 USD, not 100 USD', expectedIdentity: plus, proposalIdentity: plus,
    expectedDisposition: 'release', proposalTags: [tag('balance', '100 usd', '10美元')],
  },
  {
    id: 'first-login-conflict', name: '即梦高级会员 首登质保2h', body: '首登质保1h。',
    soldObject: 'Jimeng membership with contradictory first-login warranties',
    expectedIdentity: jimeng, proposalIdentity: jimeng, expectedDisposition: 'review',
    expectedPublicationConflict: true, expectedReasonCode: 'publication_blocked',
  },
  {
    id: 'unknown-full-evidence', name: '陌生商品', body: '交付内容、平台和套餐均未说明。',
    soldObject: 'Unknown product with complete but insufficient evidence',
    expectedIdentity: null, proposalIdentity: free, expectedDisposition: 'review',
    expectedIdentityConflict: true, expectedReasonCode: 'identity_conflict',
  },
  {
    id: 'oversized-full-evidence', name: 'ChatGPT Plus 账号', body: '完整交付说明；'.repeat(1000),
    soldObject: 'ChatGPT Plus account exceeding the explicit offline planner budget',
    expectedIdentity: plus, proposalIdentity: plus, expectedDisposition: 'review',
    inputBudgetBytes: 4096, expectedReasonCode: 'input_too_large',
  },
];
