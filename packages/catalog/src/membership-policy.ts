
export const MEMBERSHIP_KINDS = ['account', 'top_up', 'rental', 'short_term'] as const;
export type MembershipKind = typeof MEMBERSHIP_KINDS[number];
export const AI_MEMBERSHIP_TIERS: Readonly<Record<string, readonly string[]>> = {
  'openai/chatgpt': ['go', 'plus', 'pro_5x', 'pro_20x', 'pro_500', 'team', 'team_5x'],
  'anthropic/claude': ['pro', 'max_5x', 'max_20x', 'team', 'team_5x'],
  'google/gemini': ['plus', 'pro', 'ultra_5x', 'ultra_20x'],
  'xai/grok': ['plus', 'premium', 'super', 'ultra', 'supergrok', 'heavy'],
  'cursor/cursor': ['pro', 'pro_plus', 'ultra'],
};
export const MEMBERSHIP_POLICY_VERSION = 'ai-membership-20261110-v3';
type Identity = { family: string; product: string; tier: string };

export interface MembershipClassification {
  kind: MembershipKind;
  reason: string;
  durationSource?: 'explicit' | 'default';
  requiredWarrantyDays?: number | null;
}

export function isAiMembership(identity: Identity): boolean {
  return AI_MEMBERSHIP_TIERS[`${identity.family}/${identity.product}`]?.includes(identity.tier) ?? false;
}

export function membershipKindLabel(kind: MembershipKind): string {
  return { account: '成品号', top_up: '代充', rental: '租号', short_term: '短期' }[kind];
}
