import { sql } from 'kysely';
import { CATALOG_EMAIL_PRODUCT_PATTERN, CATALOG_IP_PRODUCT_PATTERN, CATALOG_PLATFORMS } from '@price-comparison/catalog/platform-groups';

// Display order is independent of identity recognition and never creates products.
const PRODUCT_ORDER = [
  [
    ...['free', 'go', 'plus', 'pro_5x', 'pro_20x', 'pro_500', 'team', 'team_5x'].map(tier => `openai/chatgpt/${tier}`),
    'openai/codex_sms/standard', 'openai/codex/credits', 'openai/codex_referral_service/standard',
    'openai/chatgpt_gift_card/standard', 'openai/chatgpt_student_verification/standard',
    'openai/chatgpt_card_binding_service/standard', 'openai/chatgpt_reauth_card/standard',
    'openai/chatgpt_team_discount_code/standard', 'openai/chatgpt/tutorial',
  ],
  [
    ...['free', 'pro', 'max_5x', 'max_20x', 'team', 'team_5x'].map(tier => `anthropic/claude/${tier}`),
    'anthropic/claude_sms/standard', 'anthropic/claude_kyc/standard',
    'anthropic/claude_kyc_link_extraction/standard', 'anthropic/claude/tutorial',
  ],
  [
    ...['plus', 'pro', 'ultra_5x', 'ultra_20x'].map(tier => `google/gemini/${tier}`),
    'youtube/youtube/individual', 'youtube/youtube/family', 'google/gcp_account/standard',
    'google/voice/standard', 'google/google_sms/standard', 'google/student_verification/standard',
    'google/antigravity_activation_service/standard', 'google/gemini/tutorial',
    'youtube/youtube/tutorial', 'google/ad/grant',
  ],
  [...['plus', 'premium', 'super', 'ultra', 'free', 'supergrok', 'heavy'].map(tier => `xai/grok/${tier}`),
    'x/account/standard', 'x/premium_membership/premium', 'x/premium_membership/premium_plus',
    'twitter/twitter_sms/standard', 'twitter/follower_service/standard',
    ...['free', 'pro', 'pro_plus', 'ultra'].map(tier => `cursor/cursor/${tier}`), 'cursor/cursor_sms/standard'],
  ['network/ip/standard'],
  ['google/email/standard', 'microsoft/outlook/standard', 'netease/163_mail/standard',
    'yahoo/email/standard', 'mail.com/email/standard', 'edu/email/standard',
    'google/gmail_code_service/standard', 'microsoft/mail_receive_service_mixed_domains/standard',
    'apple/icloud_mail/standard', 'email/domain_email/standard', 'email/receive_credits/standard'],
];
const ranks = Object.fromEntries(PRODUCT_ORDER.flatMap((products, group) => products.map((key, index) => [key, (group + 1) * 100 + index])));
// These legacy identities retain their original public IDs after catalog cleanup.
ranks['openai/codex/sms'] = ranks['openai/codex_sms/standard']!;
ranks['google/google/sms'] = ranks['google/google_sms/standard']!;
const PRODUCT_RANKS = JSON.stringify(ranks);
export const OTHER_CATALOG_RANK = 999;

export function catalogPlatformGroup() {
  return sql<string>`case
    when lower(coalesce(sp.canonical_family, '')) in ('software', 'bundle', 'mirror') then 'other'
    when lower(coalesce(sp.canonical_product, '')) ~ ${CATALOG_EMAIL_PRODUCT_PATTERN} then 'email'
    when lower(coalesce(sp.canonical_product, '')) ~ ${CATALOG_IP_PRODUCT_PATTERN} then 'ip'
    ${sql.join(CATALOG_PLATFORMS.map(group =>
    sql`when lower(btrim(sp.platform)) in (${sql.join(group.aliases)}) then ${group.id}`,
  ), sql` `)} else 'other' end`;
}

export function catalogOrderRank(group = catalogPlatformGroup()) {
  return sql<number>`coalesce((${PRODUCT_RANKS}::jsonb ->> lower(concat_ws('/',
    btrim(sp.canonical_family), btrim(sp.canonical_product), btrim(sp.canonical_tier))))::int,
    (case ${group}
      ${sql.join(CATALOG_PLATFORMS.map((group, index) => sql`when ${group.id} then ${(index + 1) * 100 + 99}`), sql` `)}
      else ${OTHER_CATALOG_RANK} end)::int)`;
}
