export interface CapabilityEvidence {
  id: string;
  identity: { platform: string; product: string; tier: string };
  purposes: string[];
  statement: string;
  sourceUrl: string;
  checkedAt: string;
  reviewAfter: string;
}

// These keys are canonical_platform/product/tier, never deployment-specific IDs.
export const ASSISTANT_CAPABILITIES: CapabilityEvidence[] = [
  {
    id: 'claude-pro-code-20261031',
    identity: { platform: 'anthropic', product: 'claude', tier: 'pro' },
    purposes: ['写代码', '编程', 'coding', 'claude code'],
    statement: 'Claude Pro 包含 Claude Code 访问；仅在支持地区提供，有用量限制，不包含 Claude Console API 用量。',
    sourceUrl: 'https://support.claude.com/en/articles/8325606-what-is-the-pro-plan',
    checkedAt: '2026-10-31T00:00:00Z',
    reviewAfter: '2026-11-07T00:00:00Z',
  },
  {
    id: 'gemini-pro-research-20261031',
    identity: { platform: 'google', product: 'gemini', tier: 'pro' },
    purposes: ['研究', '调研', 'research', 'deep research'],
    statement: 'Google AI Pro 增加 Gemini Apps 的 Deep Research 使用额度，可辅助深入调研；需登录，官方标注此功能限 18 岁及以上，地区和功能限制适用，生成结果可能有误。',
    sourceUrl: 'https://support.google.com/googleone/answer/14534406?hl=en',
    checkedAt: '2026-10-31T00:00:00Z',
    reviewAfter: '2026-11-07T00:00:00Z',
  },
  {
    id: 'youtube-individual-playback-20261031',
    identity: { platform: 'youtube', product: 'youtube', tier: 'individual' },
    purposes: ['离线视频', '后台播放', '看视频', 'offline video', 'background play'],
    statement: 'YouTube Premium 支持下载视频离线观看及移动应用后台播放；需登录会员账号且应用在当地可用，具体内容和设备限制适用。这里指完整 Premium，不是 Premium Lite。',
    sourceUrl: 'https://support.google.com/youtube/answer/6308116?hl=en',
    checkedAt: '2026-10-31T00:00:00Z',
    reviewAfter: '2026-11-07T00:00:00Z',
  },
];

export function selectCapabilities(purpose: string, now: Date): CapabilityEvidence[] {
  return ASSISTANT_CAPABILITIES.filter(evidence => capabilitySupportsPurpose(evidence, purpose, now));
}

export function capabilitySupportsPurpose(evidence: CapabilityEvidence, purpose: string, now: Date): boolean {
  const text = purpose.normalize('NFKC').trim().toLowerCase();
  return Boolean(text) && Date.parse(evidence.checkedAt) <= now.getTime()
    && Date.parse(evidence.reviewAfter) > now.getTime()
    && evidence.purposes.some(term => {
      const normalized = term.normalize('NFKC').trim().toLowerCase();
      return normalized.length > 0 && (/^[a-z0-9 ]+$/u.test(normalized)
        ? ` ${text.replace(/[^a-z0-9]+/gu, ' ')} `.includes(` ${normalized} `)
        : text.includes(normalized));
    });
}
