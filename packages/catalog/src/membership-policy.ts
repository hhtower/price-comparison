
const BASE_MEMBERSHIP_KINDS = ['account', 'top_up', 'rental', 'short_term'] as const;
type BaseMembershipKind = typeof BASE_MEMBERSHIP_KINDS[number];
export const MEMBERSHIP_BRANCH_PARENTS = { top_up_half_price: 'top_up' } as const satisfies Record<string, BaseMembershipKind>;
export const MEMBERSHIP_KINDS = BASE_MEMBERSHIP_KINDS.flatMap(kind => [kind,
  ...(Object.keys(MEMBERSHIP_BRANCH_PARENTS) as Array<keyof typeof MEMBERSHIP_BRANCH_PARENTS>)
    .filter(branch => MEMBERSHIP_BRANCH_PARENTS[branch] === kind)]);
export type MembershipKind = typeof MEMBERSHIP_KINDS[number];
export const MEMBERSHIP_GROUPS = [...MEMBERSHIP_KINDS, 'unclassified'] as const;
export type MembershipGroup = typeof MEMBERSHIP_GROUPS[number];
export const AI_MEMBERSHIP_TIERS: Readonly<Record<string, readonly string[]>> = {
  'openai/chatgpt': ['go', 'plus', 'pro_5x', 'pro_20x', 'pro_500', 'team', 'team_5x'],
  'anthropic/claude': ['pro', 'max_5x', 'max_20x', 'team', 'team_5x'],
  'google/gemini': ['plus', 'pro', 'ultra_5x', 'ultra_20x'],
  'xai/grok': ['plus', 'premium', 'super', 'ultra', 'supergrok', 'heavy'],
  'cursor/cursor': ['pro', 'pro_plus', 'ultra'],
};
export const MEMBERSHIP_POLICY_VERSION = 'ai-membership-20261110-v3';
type Identity = { family: string; product: string; tier: string };
export const MEMBERSHIP_BRANCH_POLICIES: readonly {
  identity: Identity; parent: BaseMembershipKind; defaultLabel: string;
  branches: readonly { kind: keyof typeof MEMBERSHIP_BRANCH_PARENTS; label: string }[];
}[] = [{
  identity: { family: 'openai', product: 'chatgpt', tier: 'plus' },
  parent: 'top_up', defaultLabel: '通用',
  branches: [{ kind: 'top_up_half_price', label: '半价资格' }],
}];
export function membershipGroupingVersion(): string {
  return `${MEMBERSHIP_POLICY_VERSION}:${JSON.stringify({
    parents: MEMBERSHIP_BRANCH_PARENTS, policies: MEMBERSHIP_BRANCH_POLICIES,
  })}`;
}

export function membershipBaseKind(kind: MembershipGroup | null | undefined): MembershipGroup | null | undefined {
  return kind && Object.hasOwn(MEMBERSHIP_BRANCH_PARENTS, kind)
    ? MEMBERSHIP_BRANCH_PARENTS[kind as keyof typeof MEMBERSHIP_BRANCH_PARENTS] : kind;
}

export function membershipDescendants(kind: MembershipKind): MembershipKind[] {
  return MEMBERSHIP_KINDS.filter(candidate => candidate === kind || membershipBaseKind(candidate) === kind);
}

export function isNewcomerMembership(kind: MembershipGroup | null | undefined): boolean {
  const base = membershipBaseKind(kind);
  return base === 'account' || base === 'top_up';
}

export function newcomerMembershipKinds(): MembershipKind[] {
  return MEMBERSHIP_KINDS.filter(isNewcomerMembership);
}

export function membershipBranches(identity: Identity | undefined) {
  return MEMBERSHIP_BRANCH_POLICIES.filter(policy => identity && policy.identity.family === identity.family
    && policy.identity.product === identity.product && policy.identity.tier === identity.tier);
}

export function membershipGroupKinds(identity: Identity | undefined): MembershipGroup[] {
  const enabled = new Set(membershipBranches(identity).flatMap(policy => policy.branches.map(branch => branch.kind)));
  return MEMBERSHIP_GROUPS.filter(kind => !(kind in MEMBERSHIP_BRANCH_PARENTS) || enabled.has(kind as keyof typeof MEMBERSHIP_BRANCH_PARENTS));
}

export function membershipFilterKinds(kind: MembershipGroup, identity: Identity | undefined): MembershipGroup[] {
  return identity || kind === 'unclassified' ? [kind] : membershipDescendants(kind);
}

export function membershipSelections(kinds: readonly MembershipGroup[], identity: Identity | undefined) {
  const remaining = new Set(kinds);
  return MEMBERSHIP_GROUPS.flatMap(kind => {
    const group = membershipFilterKinds(kind, identity);
    const selection = group.every(value => remaining.has(value)) ? group : remaining.has(kind) ? [kind] : [];
    if (!selection.length) return [];
    selection.forEach(value => remaining.delete(value));
    return [{ kind, kinds: selection }];
  });
}

export function normalizeMembershipSelection(kinds: readonly MembershipGroup[], identity: Identity | undefined): MembershipGroup[] {
  const available = membershipGroupKinds(identity);
  const selected = new Set(kinds.flatMap(kind => {
    const group = available.includes(kind) ? kind : MEMBERSHIP_BRANCH_PARENTS[kind as keyof typeof MEMBERSHIP_BRANCH_PARENTS];
    return membershipFilterKinds(group, identity);
  }));
  return MEMBERSHIP_GROUPS.filter(kind => selected.has(kind));
}

export interface MembershipClassification {
  kind: MembershipKind;
  reason: string;
}

export function isAiMembership(identity: Identity): boolean {
  return AI_MEMBERSHIP_TIERS[`${identity.family}/${identity.product}`]?.includes(identity.tier) ?? false;
}

export function membershipKindLabel(kind: MembershipGroup, identity?: Identity): string {
  const base = membershipBaseKind(kind) as BaseMembershipKind | 'unclassified';
  const label = { account: '成品号', top_up: '代充',
    rental: '租号', short_term: '短期', unclassified: '未分类' }[base];
  for (const policy of membershipBranches(identity)) {
    if (policy.parent === kind) return `${label} · ${policy.defaultLabel}`;
    const branch = policy.branches.find(branch => branch.kind === kind);
    if (branch) return `${label} · ${branch.label}`;
  }
  const branch = MEMBERSHIP_BRANCH_POLICIES.flatMap(policy => policy.branches).find(branch => branch.kind === kind);
  return branch ? `${label} · ${branch.label}` : label;
}

export function membershipSearchKinds(term: string): MembershipKind[] {
  for (const policy of MEMBERSHIP_BRANCH_POLICIES) {
    if (!term.includes(membershipKindLabel(policy.parent))) continue;
    const branch = policy.branches.find(branch => term.includes(branch.label));
    if (branch) return [branch.kind];
    if (term.includes(policy.defaultLabel)) return [policy.parent];
  }
  if (term === '短期') return ['short_term'];
  if (/成品|现成|account/iu.test(term)) return membershipDescendants('account');
  if (/充|^top/iu.test(term)) return membershipDescendants('top_up');
  return membershipDescendants('rental');
}

export function membershipSearchPattern(): string {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const branches = MEMBERSHIP_BRANCH_POLICIES.flatMap(policy => {
    const parent = escape(membershipKindLabel(policy.parent));
    const labels = [policy.defaultLabel, ...policy.branches.map(branch => branch.label)].map(escape).join('|');
    return [`(?:需)?(?:${labels})(?:号)?\\s*${parent}`, `${parent}\\s*[·]?\\s*(?:需)?(?:${labels})`];
  });
  return [...new Set(branches), '成品账号|成品帐号|现成账号|成品号|代充|充值|租号(?:\\s*[（(]\\s*(?:共享|合租)\\s*[）)])?|共享|合租|短期|\\b(?:ready\\s+account|account\\s+ready|top[ -]?up|shared(?:\\s+access)?)\\b'].join('|');
}
