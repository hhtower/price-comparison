/** Public navigation groups; source platform names remain part of product identity. */
export const CATALOG_PLATFORMS = [
  { id: 'openai', label: 'ChatGPT / Codex', aliases: ['openai', 'open ai', 'chatgpt', 'codex'] },
  { id: 'anthropic', label: 'Claude', aliases: ['anthropic', 'claude'] },
  { id: 'google', label: 'Gemini / Google', aliases: ['google', 'gemini', 'youtube'] },
  { id: 'xai', label: 'Grok / X / Cursor', aliases: ['xai', 'x.ai', 'grok', 'supergrok', 'x', 'twitter', 'x.com', 'x/twitter', 'x／twitter', '推特', 'cursor'] },
  { id: 'ip', label: 'IP', aliases: ['ip', 'proxy', '代理ip', '代理 ip', '住宅ip', '住宅 ip'] },
  { id: 'email', label: '邮箱', aliases: ['email', '邮箱', 'mail', 'mailbox', 'gmail', 'outlook', 'hotmail', 'yahoo', 'mail.com'] },
] as const;

// Match mailbox identities, never an account's email-provider SKU tag.
export const CATALOG_EMAIL_PRODUCT_PATTERN = '(^|[_ -])(email|mail|mailbox|gmail|outlook|hotmail)([_ -]|$)';
export const CATALOG_IP_PRODUCT_PATTERN = '(^|[_ -])ip([_ -]|$)';

const platformGroups = new Map<string, string>(CATALOG_PLATFORMS.flatMap(group =>
  group.aliases.map(alias => [alias, group.id] as const),
));

export function normalizeCatalogPlatform(platform: string): string {
  const normalized = platform.trim().toLowerCase();
  return platformGroups.get(normalized) === 'xai' ? 'xai' : normalized;
}

export function groupCatalogPlatforms(platforms: readonly string[]): string[] {
  const present = new Set(platforms.map(platform => platformGroups.get(platform.trim().toLowerCase()) ?? 'other'));
  return [...CATALOG_PLATFORMS.map(group => group.id), 'other'].filter(id => present.has(id));
}
