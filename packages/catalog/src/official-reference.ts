// Source identities and plan labels only; prices are collected from the official pages.
export const REFERENCE_WEBSITES = [
  {
    id: 'cursor', name: 'Cursor', developer: 'Anysphere', category: 'AI 编程',
    website: 'https://cursor.com/pricing',
    plans: [
      { id: 'plus', name: 'Cursor Plus', heading: 'Plus' },
      { id: 'premium', name: 'Cursor Premium', heading: 'Premium' },
      { id: 'super', name: 'Cursor Super', heading: 'Super' },
      { id: 'ultra', name: 'Cursor Ultra', heading: 'Ultra' },
    ],
  },
  {
    id: 'kiro', name: 'Kiro', developer: 'Amazon Web Services', category: 'AI 编程',
    website: 'https://kiro.dev/pricing/',
    plans: [
      { id: 'pro', name: 'Kiro Pro', heading: 'KIRO PRO' },
      { id: 'pro_plus', name: 'Kiro Pro+', heading: 'KIRO PRO+' },
      { id: 'pro_max', name: 'Kiro Pro Max', heading: 'KIRO PRO MAX' },
      { id: 'power', name: 'Kiro Power', heading: 'KIRO POWER' },
    ],
  },
] as const;
