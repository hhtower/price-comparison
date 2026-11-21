export interface ReferenceWebsite {
  readonly id: string;
  readonly appId: string;
  readonly name: string;
  readonly developer: string;
  readonly category: string;
  readonly website: string;
  readonly country: 'global' | 'us';
  readonly plans: readonly {
    readonly id: string; readonly name: string; readonly heading: string; readonly period: 'P1M' | 'P1Y';
    readonly unit?: 'seat'; readonly priceKey?: string;
  }[];
}

// Source identities and plan labels only; prices are collected from the official pages.
export const REFERENCE_WEBSITES: readonly ReferenceWebsite[] = [
  {
    id: 'cursor', appId: 'cursor', name: 'Cursor', developer: 'Anysphere', category: 'AI 编程', country: 'global',
    website: 'https://cursor.com/pricing',
    plans: [
      { id: 'plus', name: 'Cursor Plus', heading: 'Plus', period: 'P1M' },
      { id: 'premium', name: 'Cursor Premium', heading: 'Premium', period: 'P1M' },
      { id: 'super', name: 'Cursor Super', heading: 'Super', period: 'P1M' },
      { id: 'ultra', name: 'Cursor Ultra', heading: 'Ultra', period: 'P1M' },
    ],
  },
  {
    id: 'kiro', appId: 'kiro', name: 'Kiro', developer: 'Amazon Web Services', category: 'AI 编程', country: 'global',
    website: 'https://kiro.dev/pricing/',
    plans: [
      { id: 'pro', name: 'Kiro Pro', heading: 'KIRO PRO', period: 'P1M' },
      { id: 'pro_plus', name: 'Kiro Pro+', heading: 'KIRO PRO+', period: 'P1M' },
      { id: 'pro_max', name: 'Kiro Pro Max', heading: 'KIRO PRO MAX', period: 'P1M' },
      { id: 'power', name: 'Kiro Power', heading: 'KIRO POWER', period: 'P1M' },
    ],
  },
  {
    id: 'chatgpt-business', appId: '6448311069', name: 'ChatGPT Business', developer: 'OpenAI', category: 'AI 助手', country: 'global',
    website: 'https://openai.com/business/pricing/',
    plans: [
      { id: 'business-standard-month', name: 'ChatGPT Team', heading: 'Standard seat', period: 'P1M', unit: 'seat' },
      { id: 'business-standard-year', name: 'ChatGPT Team', heading: 'Standard seat', period: 'P1Y', unit: 'seat' },
      { id: 'business-premium-month', name: 'ChatGPT Premium', heading: 'Premium seat', period: 'P1M', unit: 'seat' },
      { id: 'business-premium-year', name: 'ChatGPT Premium', heading: 'Premium seat', period: 'P1Y', unit: 'seat' },
    ],
  },
  {
    id: 'claude-team', appId: '6473753684', name: 'Claude Team', developer: 'Anthropic', category: 'AI 助手', country: 'global',
    website: 'https://claude.com/pricing?currency=USD',
    plans: [
      { id: 'team-standard-month', name: 'Claude Team', heading: 'Standard seat', period: 'P1M', unit: 'seat' },
      { id: 'team-standard-year', name: 'Claude Team', heading: 'Standard seat', period: 'P1Y', unit: 'seat' },
      { id: 'team-premium-month', name: 'Claude Team Premium 席位', heading: 'Premium seat', period: 'P1M', unit: 'seat' },
      { id: 'team-premium-year', name: 'Claude Team Premium 席位', heading: 'Premium seat', period: 'P1Y', unit: 'seat' },
    ],
  },
  {
    id: 'google-ai', appId: '6477489729', name: 'Google AI', developer: 'Google', category: 'AI 助手', country: 'us',
    website: 'https://one.google.com/intl/en/about/google-ai-plans/?gl=US&hl=en',
    plans: [
      { id: 'google-ai-plus-month', name: 'Google AI Plus', heading: 'Google AI Plus', period: 'P1M', priceKey: 'PRICE_GEN_AI_PLUS_MONTHLY' },
      { id: 'google-ai-pro-month', name: 'Gemini Pro', heading: 'Google AI Pro', period: 'P1M', priceKey: 'PRICE_GEN_AI_PRO_MONTHLY' },
      { id: 'google-ai-ultra-5x-month', name: 'Gemini Ultra 5x', heading: 'Google AI Ultra 5x', period: 'P1M', priceKey: 'PRICE_GEN_AI_ULTRA_100_MONTHLY' },
      { id: 'google-ai-ultra-20x-month', name: 'Gemini Ultra 20x', heading: 'Google AI Ultra 20x', period: 'P1M', priceKey: 'PRICE_GEN_AI_ULTRA_200_MONTHLY' },
    ],
  },
] as const;
