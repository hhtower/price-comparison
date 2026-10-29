export type LinkageBin = 'yes' | 'no' | 'high' | 'medium' | 'low';

export interface DuplicateLinkagePolicy {
  readonly version: string;
  readonly suspectedThreshold: number;
  readonly fieldAliases: Readonly<Record<'family' | 'product' | 'tier', Readonly<Record<string, string>>>>;
  readonly weights: Readonly<Record<string, Readonly<Record<LinkageBin, number>>>>;
}

export const DUPLICATE_LINKAGE_POLICY: DuplicateLinkagePolicy = {
  version: 'duplicate-linkage-20260921-v3',
  suspectedThreshold: 3.5,
  fieldAliases: {
    family: {
      twitter: 'x', 'x.com': 'x', 微软: 'microsoft', outlook: 'microsoft',
      字节跳动: 'bytedance', tiktok: 'bytedance',
    },
    product: {
      'openai chatgpt': 'chatgpt', 'chatgpt account': 'chatgpt',
      'x premium': 'premium', 'twitter premium': 'premium',
      'tiktok account': 'tiktok account', '抖音国际版账号': 'tiktok account',
      'outlook 邮箱': 'outlook', outlok: 'outlook',
    },
    tier: {
      'chatgpt plus': 'plus', 普通: 'standard', 账号: 'account',
      'email account': 'account', mailbox: 'account',
    },
  },
  // These are frozen, reviewable Fellegi-Sunter-style log likelihood weights.
  // The calibration check validates their shape and fixture partitioning; runtime never trains them.
  weights: {
    familyExact: { yes: 0, no: 0, high: 0, medium: 0, low: 0 },
    productExact: { yes: 0.223144, no: -0.693147, high: 0, medium: 0, low: 0 },
    tierExact: { yes: 1.386294, no: -0.916291, high: 0, medium: 0, low: 0 },
    tierCoreExact: { yes: 1.609438, no: -1.609438, high: 0, medium: 0, low: 0 },
    tokenSimilarity: { high: 0.916291, medium: -1.386294, low: 0, yes: 0, no: 0 },
    ngramSimilarity: { high: 0.916291, medium: -1.386294, low: 0, yes: 0, no: 0 },
    editSimilarity: { high: 0.510826, medium: -1.098612, low: 0, yes: 0, no: 0 },
    crossFieldSimilarity: { high: 0, medium: 0, low: 0, yes: 0, no: 0 },
  },
};
