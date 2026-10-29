import { createHash } from 'node:crypto';
import { buildCanonicalStandardKey, canonicalizeMatchText } from './canonical-key.js';
import { evaluateStandardizationQuality, type StandardizationQualityFixture, type StandardizationQualitySample,
  type RecordedStandardizationResponses, type QualityIdentity } from './quality-evaluation.js';
import type { StreamingUsage } from '../ai/llm-runtime.js';

interface PrivateReviewGroup { ids: readonly (string | number)[]; name?: string; spec?: string }
interface PrivateReviewDecision { id: string | number; action: string }
const REVIEW_ACTIONS: Record<string, string> = {
  '归入现有标准': 'assign_existing', '继续隔离': 'retain_isolation', '保留待补证': 'needs_evidence',
  '核对独立商品/历史标准': 'inspect_history', '排除比价/保留历史': 'exclude_listing',
};
const undecidable = new Set(['needs_evidence', 'inspect_history', 'unknown_review']);
const count = (items: readonly string[]) => items.reduce<Record<string, number>>((result, item) => {
  result[item] = (result[item] ?? 0) + 1; return result;
}, {});

/** Drops all source identifiers, target identifiers, names, prose, shops, URLs and reasons. */
export function buildDeidentifiedReviewIndex(groups: readonly PrivateReviewGroup[], decisions: readonly PrivateReviewDecision[]) {
  const actions = new Map<string, string>();
  for (const row of decisions) {
    const id = String(row.id);
    if (actions.has(id)) throw new Error('duplicate private review decision');
    actions.set(id, REVIEW_ACTIONS[row.action] ?? 'unknown_review');
  }
  const copies = new Map<string, string>();
  const indexedIds = new Set<string>();
  const output = groups.map((group, position) => {
    const copyKey = JSON.stringify([canonicalizeMatchText(group.name), canonicalizeMatchText(group.spec)]);
    let copyGroup = copies.get(copyKey);
    if (!copyGroup) { copyGroup = 'copy-' + String(copies.size + 1).padStart(4, '0'); copies.set(copyKey, copyGroup); }
    const bucket = createHash('sha256').update(copyGroup).digest()[0]! % 10;
    const split = bucket < 6 ? 'train' : bucket < 8 ? 'validation' : 'test';
    const groupActions = group.ids.map(value => {
      const id = String(value);
      if (indexedIds.has(id)) throw new Error('private review groups overlap');
      indexedIds.add(id);
      return actions.get(id) ?? 'unknown_review';
    });
    const pending = groupActions.filter(action => undecidable.has(action)).length;
    return { id: 'review-' + String(position + 1).padStart(4, '0'), copyGroup, split, memberCount: group.ids.length,
      evidenceStatus: pending === 0 ? 'decidable' : pending === group.ids.length ? 'pending_evidence' : 'mixed',
      identityLabelStatus: 'review_suggestion_unverified', actionCounts: count(groupActions) };
  });
  return { version: 'standardization-review-index-20260927-v1', modelSemanticQuality: 'unknown',
    labelPolicy: 'Historical review disposition only; target identity and current evidence are not independently verified.',
    splitMethod: 'normalized-name-spec-copy-group-v1', groups: output,
    coverage: { indexedGroups: groups.length, indexedMembers: indexedIds.size, reviewDecisionRows: decisions.length,
      externalControlRows: decisions.filter(row => !indexedIds.has(String(row.id))).length },
    reviewActionCounts: count([...actions.values()]),
    externalControlActionCounts: count(decisions.filter(row => !indexedIds.has(String(row.id))).map(row => actions.get(String(row.id))!)),
  };
}

export interface EvidenceReviewSample extends StandardizationQualitySample {
  readonly labelState: 'decidable' | 'pending_evidence';
  readonly manualIsolation?: boolean;
  readonly evidenceChanged?: boolean;
  readonly previousIdentity?: QualityIdentity;
}
export interface EvidenceReviewFixture extends StandardizationQualityFixture { readonly samples: readonly EvidenceReviewSample[] }
export interface EvaluationTelemetry { readonly providerRequests?: number; readonly usage?: StreamingUsage | null; readonly latencyMs?: number; readonly validStructure?: boolean }
export interface EvidenceReviewResponses extends RecordedStandardizationResponses { readonly telemetry?: Readonly<Record<string, EvaluationTelemetry>> }
const fraction = (numerator: number, denominator: number) => ({ numerator, denominator, value: denominator ? numerator / denominator : null });
const measuredCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export type FlowDisposition = 'release' | 'review' | 'exclude';
export type FlowTagValues = Readonly<Record<string, string | readonly string[]>>;
export interface StandardizationStageObservation {
  readonly id: string;
  readonly proposalSource: 'model' | 'synthetic-control' | null;
  readonly expectedIdentity: QualityIdentity | null;
  readonly expectedDisposition: FlowDisposition;
  readonly expectedTags: FlowTagValues;
  readonly proposedIdentity: QualityIdentity | null;
  readonly proposalDisposition: FlowDisposition | null;
  readonly proposedTags: FlowTagValues;
  readonly identityRejected: boolean | null;
  readonly candidateTargetId?: string;
  readonly recalledCandidateIds: readonly string[] | null;
  readonly finalIdentity: QualityIdentity | null;
  readonly finalDisposition: FlowDisposition | null;
  readonly finalTags: FlowTagValues;
}

const sameIdentity = (left: QualityIdentity | null, right: QualityIdentity | null) =>
  left !== null && right !== null && buildCanonicalStandardKey(left) === buildCanonicalStandardKey(right);
const tagFacts = (value: string | readonly string[] | undefined): readonly string[] =>
  value === undefined ? [] : typeof value === 'string' ? [value] : value;
const supportedTags = (actual: FlowTagValues, expected: FlowTagValues) => Object.entries(actual)
  .every(([name, value]) => tagFacts(value).every(fact => tagFacts(expected[name]).includes(fact)));
const sameTags = (left: FlowTagValues, right: FlowTagValues) => supportedTags(left, right) && supportedTags(right, left);

/** Synthetic proposals exercise guards, never supply a real model-accuracy denominator. */
export function evaluateStandardizationStages(rows: readonly StandardizationStageObservation[]) {
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('duplicate stage observation');
  const proposalCorrect = (row: StandardizationStageObservation) => row.proposalDisposition === row.expectedDisposition
    && (row.expectedDisposition !== 'release' || (sameIdentity(row.proposedIdentity, row.expectedIdentity)
      && sameTags(row.proposedTags, row.expectedTags)));
  const models = rows.filter(row => row.proposalSource === 'model' && row.proposalDisposition !== null);
  const synthetic = rows.filter(row => row.proposalSource === 'synthetic-control' && row.proposalDisposition !== null);
  const correctIdentityProposals = rows.filter(row => row.proposalSource !== null && row.proposalDisposition === 'release'
    && row.identityRejected !== null && row.expectedDisposition === 'release' && sameIdentity(row.proposedIdentity, row.expectedIdentity));
  const retrieval = rows.filter(row => row.candidateTargetId !== undefined && row.recalledCandidateIds !== null);
  const releases = rows.filter(row => row.finalDisposition === 'release');
  return {
    modelSemanticQuality: models.length ? 'observed' : 'unknown',
    modelProposalCorrectness: fraction(models.filter(proposalCorrect).length, models.length),
    syntheticProposalCorrectness: fraction(synthetic.filter(proposalCorrect).length, synthetic.length),
    identityRuleFalseRejection: fraction(correctIdentityProposals.filter(row => row.identityRejected).length, correctIdentityProposals.length),
    candidateRecallMiss: fraction(retrieval.filter(row => !row.recalledCandidateIds!.includes(row.candidateTargetId!)).length, retrieval.length),
    finalErroneousRelease: fraction(releases.filter(row => row.expectedDisposition !== 'release'
      || !sameIdentity(row.finalIdentity, row.expectedIdentity) || !supportedTags(row.finalTags, row.expectedTags)).length, releases.length),
  };
}

/** Reuse existing identity/pair/tag scoring, adding evidence-version and observability boundaries. */
export function evaluateEvidenceReview(fixture: EvidenceReviewFixture, responses: EvidenceReviewResponses) {
  const ids = new Set(fixture.samples.map(sample => sample.id));
  if (ids.size !== fixture.samples.length) throw new Error('duplicate evaluation sample');
  const seen = new Set<string>();
  for (const outcome of responses.outcomes) {
    if (!ids.has(outcome.id) || seen.has(outcome.id)) throw new Error('unknown or duplicate evaluation outcome');
    seen.add(outcome.id);
  }
  const eligible = fixture.samples.filter(sample => sample.labelState === 'decidable' && seen.has(sample.id));
  const eligibleIds = new Set(eligible.map(sample => sample.id));
  const outcomes = responses.outcomes.filter(outcome => eligibleIds.has(outcome.id));
  const quality = evaluateStandardizationQuality({ ...fixture, samples: eligible.map(sample => ({ ...sample,
    differentFrom: sample.differentFrom?.filter(id => eligibleIds.has(id)),
  })) }, { ...responses, outcomes });
  const outcomeById = new Map(outcomes.map(outcome => [outcome.id, outcome]));
  const catalog = new Map(responses.catalog.map(row => [row.standardProductId, buildCanonicalStandardKey(row.identity)]));
  const key = (id: string): string | undefined => {
    const outcome = outcomeById.get(id);
    return outcome?.status === 'classified' ? outcome.identity ? buildCanonicalStandardKey(outcome.identity) : catalog.get(outcome.standardProductId!) : undefined;
  };
  const shouldClassify = eligible.filter(sample => sample.shouldClassify);
  const isolated = eligible.filter(sample => sample.manualIsolation && !sample.evidenceChanged);
  const changed = eligible.filter(sample => sample.evidenceChanged && sample.previousIdentity && sample.shouldClassify && sample.identity);
  const knownTargets = shouldClassify.filter(sample => sample.identity && [...catalog.values()].includes(buildCanonicalStandardKey(sample.identity)));
  const recall = knownTargets.filter(sample => outcomeById.get(sample.id)!.sentCandidateIds.some(id => catalog.get(id) === buildCanonicalStandardKey(sample.identity!))).length;
  const telemetry = responses.outcomes.map(outcome => responses.telemetry?.[outcome.id]);
  const observed = (field: 'providerRequests' | 'latencyMs') => telemetry.length > 0 && telemetry.every(row => typeof row?.[field] === 'number' && Number.isFinite(row[field]) && row[field]! >= 0);
  const requests = telemetry.length > 0 && telemetry.every(row => measuredCount(row?.providerRequests))
    ? telemetry.reduce((sum, row) => sum + row!.providerRequests!, 0) : null;
  const actualUsage = telemetry.length > 0 && telemetry.every(row => row?.usage != null
    && measuredCount(row.usage.promptTokens) && measuredCount(row.usage.completionTokens) && measuredCount(row.usage.totalTokens))
    ? telemetry.reduce((sum, row) => ({ promptTokens: sum.promptTokens + row!.usage!.promptTokens,
      completionTokens: sum.completionTokens + row!.usage!.completionTokens, totalTokens: sum.totalTokens + row!.usage!.totalTokens }), { promptTokens: 0, completionTokens: 0, totalTokens: 0 }) : null;
  const latencies = observed('latencyMs') ? telemetry.map(row => row!.latencyMs!).sort((a, b) => a - b) : [];
  const structural = telemetry.filter(row => typeof row?.validStructure === 'boolean');
  const correct = shouldClassify.filter(sample => sample.identity && key(sample.id) === buildCanonicalStandardKey(sample.identity)).length;
  return { ...quality, evaluatedDecidableCount: eligible.length,
    pendingEvidenceCount: fixture.samples.filter(sample => sample.labelState === 'pending_evidence').length,
    unobservedCount: fixture.samples.filter(sample => !seen.has(sample.id)).length,
    budgetRetention: quality.candidateRecall, candidateRecall: fraction(recall, knownTargets.length),
    falseRejectionRate: fraction(shouldClassify.filter(sample => outcomeById.get(sample.id)?.status === 'unclassified').length, shouldClassify.length),
    isolationOverrideRate: fraction(isolated.filter(sample => key(sample.id) !== undefined).length, isolated.length),
    staleIdentityRetentionRate: fraction(changed.filter(sample => key(sample.id) === buildCanonicalStandardKey(sample.previousIdentity!)
      && buildCanonicalStandardKey(sample.previousIdentity!) !== buildCanonicalStandardKey(sample.identity!)).length, changed.length),
    structuralValidity: fraction(structural.filter(row => row!.validStructure).length, structural.length),
    providerRequests: requests, actualUsage, latencyP95Ms: latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1]! : null,
    requestsPerCorrectClassification: requests !== null && correct > 0 ? requests / correct : null,
  };
}
