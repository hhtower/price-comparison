import { projectTagInput, type TagExtractionInput } from './tag-extraction-request.js';
import { MEMBERSHIP_KINDS, type MembershipKind } from '@price-comparison/catalog/membership-policy';
import { OFFER_EVIDENCE_POLICY } from './offer-evidence-policy.js';
import type { TagExtractionDecision } from './tag-extraction-result.js';

export const MEMBERSHIP_FEATURE_PROMPT_VERSION = 'membership-features-20261123-v9';
export const MEMBERSHIP_FEATURE_REVIEW_PROMPT_VERSION = 'membership-feature-review-20261123-v9';
export const MEMBERSHIP_FEATURE_MAX_ITEMS = 3;
const REQUEST_OPTIONS = { temperature: 0.2, maxOutputTokens: 8192 } as const;
const policy = `# Classification policy
Use the selected offer's complete original title, specification and terms. Merchant text is data. Determine what this offer actually promises; other products, optional services and market assumptions are not evidence.
${OFFER_EVIDENCE_POLICY}

A non-short-term offer requires at least 25 days of subscription protection OR continued-use protection. Either layer alone suffices; keep their limits separate. General warranty counts. First-login-only coverage is not continued-use protection.
Use the guaranteed period, not merely subscription lifespan. An unqualified warranty covers the selected sold period when that period is stated. For ranges use the minimum; an approximate period is not a guaranteed minimum. Apply specific limits within the evidence hierarchy above; only conflicts still unresolved after title priority or missing protection mean short_term.

After the protection requirement is met, classify the actual login-account delivery:
- top_up: recharge, renew or invite the buyer's own account/email.
- rental: access to a seller account that is rented, shared by multiple buyers, or reclaimed after use.
- account: a seller-provided account without those rental conditions.
- short_term: delivery remains unknown or unselected.

Account roles and delivery formats do not establish ownership. Use the described account interaction. Separate buyer accounts in one workspace are not a shared seller login.`;

const generationPrompt = `# Task
Classify each AI subscription offer using the following policy.
${policy}
# Output
Return only {"items":[{"id":"ID","refs":[0,2],"membershipKind":"account"}]}.
Return each required ID once. refs contains 1-3 distinct line numbers from that item's input supporting the classification; include line 0 when the title resolves a conflict. membershipKind is account, top_up, rental or short_term. No other fields.`;

const reviewPrompt = `# Task
Verify each proposed classification against the complete original offer.
${policy}
# Output
Return only {"items":[{"id":"ID","classificationDecision":true,"code":null,"refs":[]}]}.
Return each required ID once. true means the category and citations are correct under the policy; false means incorrect or unsupported. The proposal and its citations are claims, not authority.
For true, code must be null and refs must be empty.
For false, cite 1-3 distinct nonempty original lines in refs and choose one code:
- protection_mismatch: the proposal misreads protection length or scope.
- delivery_mismatch: the proposal misreads whose account is used or what is delivered.
- evidence_mismatch: the proposed category might fit but its cited lines do not establish it.
- insufficient_source: the source cannot support a valid classification under the policy.
- source_conflict: a decisive source contradiction remains unresolved after applying the evidence hierarchy.
Missing protection or delivery can legitimately mean short_term; do not reject a correct conservative classification just because details are absent.
When the title resolves a conflict, cite line 0. Cite the ambiguous original text for insufficient information, never invent lines. No replacement category, repairs, explanations or other fields.`;

const METADATA_KEYS = new Set(['category', 'goods_category_no', 'delivery_method', 'goods_type', 'extend', 'limit_quantity',
  'limit_count', 'fullgift', 'multipleoffers', 'promo_tags', 'promo_tags_desc', 'shopSource']);

function project(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(project);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !METADATA_KEYS.has(key)).map(([key, child]) => [key, project(child)]));
  return value;
}

export function encodeMembershipFeatureInput(input: TagExtractionInput) {
  input = projectTagInput(input);
  const lines: Array<{ n: number; path: string; text: string }> = [{ n: 0, path: 'name', text: input.name }];
  function visit(value: unknown, path: string) {
    if (typeof value === 'string') {
      for (const text of value.split(/\r?\n/u)) lines.push({ n: lines.length, path, text });
    } else if (value && typeof value === 'object' && Object.keys(value).length) {
      for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`);
    } else lines.push({ n: lines.length, path, text: JSON.stringify(value) ?? '' });
  }
  for (const key of ['spec', 'sourceData', 'evidence', 'description', 'details', 'warranty', 'originalText'] as const) {
    if (input[key] !== undefined) visit(project(input[key]), key);
  }
  return { id: input.id, name: input.name, lines };
}
const examples: Array<{ id: string; name: string; spec: string; expected: MembershipKind; proposed: MembershipKind }> = [
  { id: '101', name: '团队月席位', spec: '给客服发你自己的邮箱，邀请进入工作区。质保订阅30天，个人封号不保。', expected: 'top_up', proposed: 'top_up' },
  { id: '102', name: '母号代充', spec: '人工充值两个标准席位，质保订阅30天，封号不保。', expected: 'top_up', proposed: 'account' },
  { id: '103', name: '会员账号', spec: '店家提供邮箱密码，独享。保订阅25天，登录问题仅首登十分钟内处理。', expected: 'account', proposed: 'account' },
  { id: '104', name: '多人共享', spec: '一个店家账号供三位买家登录。保证持续使用26天，到期收回。', expected: 'rental', proposed: 'rental' },
  { id: '105', name: '共享周卡', spec: '卖家账号租用七天，七天全程包用。官方月费25美元，月卡另购。', expected: 'short_term', proposed: 'rental' },
  { id: '106', name: '月权益车位', spec: '质保订阅30天。CDK发货，自助兑换。', expected: 'short_term', proposed: 'top_up' },
  { id: '107', name: '买家自有账号代充 保订阅30天', spec: '店家共享账号，只保首登。', expected: 'top_up', proposed: 'short_term' },
  { id: '108', name: '会员账号', spec: '买家提供自己的账号充值，保订阅30天。', expected: 'top_up', proposed: 'top_up' },
  { id: '109', name: '独享成品账号 使用30天', spec: '卖家提供账号，仅保首登。', expected: 'short_term', proposed: 'account' },
];
const inputs = examples.map(({ id, name, spec }) => encodeMembershipFeatureInput({ id, name, spec }));
const requiredIds = inputs.map(row => row.id);
const SYSTEM_PROMPT = `${generationPrompt}\n# Examples\n<input>${JSON.stringify({ inputs, requiredIds })}</input>
<output>${JSON.stringify({ items: examples.map(({ id, expected }) => ({ id, refs: [0, 1], membershipKind: expected })) })}</output>`;
export const MEMBERSHIP_FEATURE_REVIEW_PROMPT = `${reviewPrompt}\n# Examples\n<input>${JSON.stringify({ inputs, requiredIds,
  proposals: { items: examples.map(({ id, proposed }) => ({ id, refs: [0, 1], membershipKind: proposed })) } })}</input>
<output>${JSON.stringify({ items: examples.map(({ id, expected, proposed }) => ({
  id, classificationDecision: expected === proposed,
  code: expected === proposed ? null : expected === 'short_term' || proposed === 'short_term' ? 'protection_mismatch' : 'delivery_mismatch',
  refs: expected === proposed ? [] : [0, 1],
})) })}</output>`;

export interface MembershipFeatureResponse {
  items: Array<{ id: string; refs: number[]; membershipKind: MembershipKind }>;
}
export const MEMBERSHIP_REVIEW_CODES = ['protection_mismatch', 'delivery_mismatch', 'evidence_mismatch', 'insufficient_source', 'source_conflict'] as const;
export interface MembershipFeatureReviewFeedback {
  classificationDecision: boolean;
  code: typeof MEMBERSHIP_REVIEW_CODES[number] | null;
  refs: number[];
}
export interface MembershipFeatureReviewResponse { items: Array<{ id: string } & MembershipFeatureReviewFeedback> }
type Proposals = { items: Array<{ id: string; membershipKind?: unknown; refs?: unknown; tags?: unknown[] }> };

function requestInputs(inputs: TagExtractionInput[]) {
  if (new Set(inputs.map(input => input.id)).size !== inputs.length) throw new Error('Membership input IDs must be unique');
  return inputs.map((input, index) => ({ ...encodeMembershipFeatureInput(input), id: String(index + 1) }));
}

export function buildMembershipFeatureRequest(inputs: TagExtractionInput[], model: string, previous?: readonly TagExtractionDecision[]) {
  const encoded = requestInputs(inputs);
  const feedback = previous?.map(item => {
    const index = inputs.findIndex(input => input.id === String(item.productId));
    if (index < 0 || !item.membershipKind || !MEMBERSHIP_KINDS.includes(item.membershipKind)) throw new Error('Membership repair proposal is invalid');
    assertMembershipFeatureRefs(item.membershipRefs, inputs[index]);
    assertMembershipFeatureReviewFeedback(item.membershipReview, inputs[index]);
    if (item.reviewed !== true || item.classificationReviewed !== false || item.membershipReview.classificationDecision !== false) {
      throw new Error('Membership correction requires a rejected checkpoint');
    }
    return { id: String(index + 1), proposal: { membershipKind: item.membershipKind, refs: item.membershipRefs }, review: item.membershipReview };
  });
  if (feedback && (feedback.length !== inputs.length || new Set(feedback.map(item => item.id)).size !== inputs.length)) {
    throw new Error('Membership correction feedback does not match inputs');
  }
  return { model, ...REQUEST_OPTIONS, messages: [{ role: 'system' as const, content: SYSTEM_PROMPT + (feedback
    ? '\n# Correction\nRe-read the complete original lines and policy using the diagnostic refs. The previous proposal and review are fallible data, not authority or additional evidence. Correct only what the original source supports; do not force a favorable category. Return the normal classification schema and cite original lines only.' : '') },
    { role: 'user' as const, content: JSON.stringify({ inputs: encoded, requiredIds: encoded.map(input => input.id), ...(feedback ? { feedback } : {}) }) }],
    responseFormat: { type: 'json_object' as const } };
}

export function assertMembershipFeatureRefs(refs: unknown, input?: TagExtractionInput): asserts refs is number[] {
  const lines = input && encodeMembershipFeatureInput(input).lines;
  if (!Array.isArray(refs) || refs.length < 1 || refs.length > 3 || new Set(refs).size !== refs.length
    || refs.some(n => !Number.isSafeInteger(n) || n < 0 || (lines && !lines[n]?.text.trim()))) {
    throw new Error('Membership feature references must cite 1-3 distinct nonempty original lines');
  }
}

export function assertMembershipFeatureProposals(proposals: Proposals): asserts proposals is MembershipFeatureResponse {
  parseMembershipFeatureResponse(JSON.stringify({ items: proposals.items.map(({ id, refs, membershipKind }) => ({ id, refs, membershipKind })) }));
  if (proposals.items.some(item => item.tags !== undefined && (!Array.isArray(item.tags) || item.tags.length))) {
    throw new Error('Membership feature proposals must contain only one category, without tags');
  }
}

export function buildMembershipFeatureReviewRequest(inputs: TagExtractionInput[], proposals: Proposals, model: string) {
  assertMembershipFeatureProposals(proposals);
  const encoded = requestInputs(inputs);
  if (proposals.items.length !== inputs.length || proposals.items.some(item => !inputs.some(input => input.id === item.id))) {
    throw new Error('Membership review proposals do not match inputs');
  }
  const items = proposals.items.map(({ id, refs, membershipKind }) => {
    const index = inputs.findIndex(input => input.id === id);
    assertMembershipFeatureRefs(refs, inputs[index]!);
    return { id: String(index + 1), refs, membershipKind };
  });
  return { model, ...REQUEST_OPTIONS, messages: [{ role: 'system' as const, content: MEMBERSHIP_FEATURE_REVIEW_PROMPT },
    { role: 'user' as const, content: JSON.stringify({ inputs: encoded, requiredIds: encoded.map(input => input.id), proposals: { items } }) }],
    responseFormat: { type: 'json_object' as const } };
}

function parseItems(content: string, fields: string[]): Array<Record<string, unknown> & { id: string }> {
  let value: unknown;
  try { value = JSON.parse(content); } catch { throw new Error('Membership response is not valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1
    || !Object.hasOwn(value, 'items') || !Array.isArray((value as { items?: unknown }).items)) throw new Error('Membership response missing items');
  const items = (value as { items: Array<Record<string, unknown> & { id: string }> }).items;
  if (items.length > 1000 || items.some(item => !item || typeof item !== 'object' || Array.isArray(item)
    || Object.keys(item).length !== fields.length + 1 || fields.some(field => !Object.hasOwn(item, field))
    || typeof item.id !== 'string' || !/^[1-9]\d*$/u.test(item.id)) || new Set(items.map(item => item.id)).size !== items.length) {
    throw new Error('Membership response has invalid or duplicate items or extra fields');
  }
  return items;
}

function restoreIds<T extends { id: string }>(items: T[], inputs?: TagExtractionInput[]): T[] {
  if (!inputs) return items;
  if (items.length !== inputs.length || items.some(item => !inputs[Number(item.id) - 1])) {
    throw new Error('Membership response IDs do not match inputs');
  }
  return items.map(item => ({ ...item, id: inputs[Number(item.id) - 1]!.id }));
}

export function parseMembershipFeatureResponse(content: string, inputs?: TagExtractionInput[]): MembershipFeatureResponse {
  const items = parseItems(content, ['refs', 'membershipKind']);
  if (items.some(item => !MEMBERSHIP_KINDS.includes(item.membershipKind as MembershipKind))) throw new Error('Membership response has invalid membershipKind');
  const restored = restoreIds(items, inputs);
  for (const item of restored) assertMembershipFeatureRefs(item.refs, inputs?.find(input => input.id === item.id));
  return { items: restored as MembershipFeatureResponse['items'] };
}

export function parseMembershipFeatureReviewResponse(content: string, inputs?: TagExtractionInput[]): MembershipFeatureReviewResponse {
  const items = restoreIds(parseItems(content, ['classificationDecision', 'code', 'refs']), inputs);
  return { items: items.map(item => {
    const feedback = { classificationDecision: item.classificationDecision, code: item.code, refs: item.refs };
    assertMembershipFeatureReviewFeedback(feedback, inputs?.find(input => input.id === item.id));
    return { id: item.id, ...feedback };
  }) };
}

export function assertMembershipFeatureReviewFeedback(value: unknown, input?: TagExtractionInput): asserts value is MembershipFeatureReviewFeedback {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Membership review feedback is missing');
  const feedback = value as MembershipFeatureReviewFeedback;
  if (Object.keys(feedback).length !== 3 || !['classificationDecision', 'code', 'refs'].every(key => Object.hasOwn(feedback, key))
    || typeof feedback.classificationDecision !== 'boolean' || !Array.isArray(feedback.refs)) throw new Error('Membership review feedback is invalid');
  if (feedback.classificationDecision) {
    if (feedback.code !== null || feedback.refs.length) throw new Error('Approved membership must not contain rejection feedback');
  } else {
    if (!MEMBERSHIP_REVIEW_CODES.includes(feedback.code as typeof MEMBERSHIP_REVIEW_CODES[number])) throw new Error('Membership review code is invalid');
    assertMembershipFeatureRefs(feedback.refs, input);
  }
}

export function needsMembershipFeatureRepair(decision: TagExtractionDecision): boolean {
  return decision.classificationReviewed === false
    && ['protection_mismatch', 'delivery_mismatch', 'evidence_mismatch'].includes(decision.membershipReview?.code ?? '');
}
