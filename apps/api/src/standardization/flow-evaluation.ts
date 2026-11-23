import { buildCandidateSearchQuery, buildExtractionPayload, estimateInputSize, planAdaptiveBatches } from '../ai/adaptive-batching.js';
import { tagValueKey } from '@price-comparison/catalog/purchase-attributes';
import { parseStandardizationProtocolResponse, type StandardizationNullReason,
  type StandardizationReviewFeedback, type StandardizationTag } from '../ai/ai.schemas.js';
import { validateStandardizationEvidence } from '../ai/standardization-evidence.js';
import { parseStandardizationReviewResponse } from '../ai/standardization-review-request.js';
import { validateReviewedTagExtractionDecision } from '../ai/tag-extraction-result.js';
import { BoundedCandidateIndex, type CandidateDocument } from './candidate-index.js';
import { buildCanonicalStandardKey } from './canonical-key.js';
import { normalizeIdentity, type Identity } from './identity-policy.js';
import { evaluateStandardizationStages, type FlowDisposition, type FlowTagValues, type StandardizationStageObservation } from './review-evaluation.js';

export interface StandardizationFlowControl {
  readonly id: string;
  readonly name: string;
  readonly body: string;
  readonly soldObject: string;
  readonly expectedIdentity: Identity | null;
  readonly expectedDisposition: FlowDisposition;
  readonly expectedTags?: FlowTagValues;
  readonly expectedReasonCode?: string;
  readonly proposalIdentity: Identity | null;
  readonly proposalNullReason?: StandardizationNullReason;
  readonly mockMatchReview: StandardizationReviewFeedback;
  readonly proposalTags?: readonly Pick<StandardizationTag, 'name' | 'value'>[];
  readonly mockTagReview?: { readonly accepted: readonly boolean[]; readonly complete: boolean };
  readonly inputBudgetBytes?: number;
}

function tagValues(tags: readonly Pick<StandardizationTag, 'name' | 'value'>[]): FlowTagValues {
  const grouped = new Map<string, Set<string>>();
  for (const tag of tags) {
    const values = grouped.get(tag.name) ?? new Set<string>();
    values.add(typeof tag.value === 'string' ? tag.value : tagValueKey(tag.value));
    grouped.set(tag.name, values);
  }
  return Object.fromEntries([...grouped].map(([name, values]) => [name, values.size === 1 ? [...values][0]! : [...values].sort()]));
}

/** Runs public-safe synthetic probes through the current functions; does not publish or call a provider. */
export function evaluateStandardizationFlow(controls: readonly StandardizationFlowControl[], catalog: readonly CandidateDocument[]) {
  if (new Set(controls.map(control => control.id)).size !== controls.length) throw new Error('duplicate flow control');
  const index = new BoundedCandidateIndex(catalog);
  const rows = controls.map(control => {
    const raw = { id: control.id, name: control.name, spec: '', sourceData: { evidence: `<p>${control.body}</p>` } };
    const payload = buildExtractionPayload(raw);
    const query = buildCandidateSearchQuery(payload);
    const candidates = index.search(query).candidates;
    const candidateTargetId = control.expectedIdentity ? catalog.find(candidate =>
      buildCanonicalStandardKey(candidate) === buildCanonicalStandardKey(control.expectedIdentity!))?.id : undefined;
    const evidence = [{ path: 'name', quote: String(payload.name) }];
    const proposalTags = control.proposalTags ?? [];
    if (proposalTags.length && !control.mockTagReview) throw new Error('Tag controls require explicit mock review decisions');
    const votes = control.mockTagReview?.accepted ?? [];
    const tags = proposalTags.map((tag, proposalIndex) => ({ ...tag, proposalIndex, evidence: [] }));
    const reviewed = validateReviewedTagExtractionDecision(1n, tags.filter(tag => votes[tag.proposalIndex] === true),
      tags.filter(tag => votes[tag.proposalIndex] !== true).map(tag => ({
        ...tag, reasonCode: 'review_rejected', reason: '模拟复核拒绝该标签',
      })), payload, votes, control.mockTagReview?.complete ?? true);
    const proposedCandidate = control.proposalIdentity ? candidates.find(candidate =>
      buildCanonicalStandardKey(candidate) === buildCanonicalStandardKey(control.proposalIdentity!)) : undefined;
    if (control.proposalIdentity && !proposedCandidate) throw new Error(`Control proposal candidate was not recalled: ${control.id}`);
    if (!control.mockMatchReview) throw new Error('Match controls require explicit mock review decisions');
    const input = { id: '1', candidateStandardProductIds: candidates.map(candidate => candidate.id), payload };
    const parsed = parseStandardizationProtocolResponse({ items: [
      { id: input.id, standardProductId: proposedCandidate?.id ?? null,
        nullReason: proposedCandidate ? null : control.proposalNullReason, evidence },
    ] }, [input]);
    const validated = validateStandardizationEvidence(parsed, [input], candidates);
    const reviewedMatch = parseStandardizationReviewResponse(JSON.stringify({
      items: [{ id: input.id, ...control.mockMatchReview }],
    }), validated, { model: 'mock-offline', candidates,
      inputs: [{ productId: 1n, payload, candidateStandardProductIds: input.candidateStandardProductIds }] });
    const decision = reviewedMatch.items[0]!;
    const choice = decision.identity;
    const chosen = choice ? candidates.find(candidate => candidate.id === choice.standardProductId) : undefined;
    const size = estimateInputSize(payload);
    const planned = planAdaptiveBatches([{ productId: 1n, payload, ...size }], {
      maxItems: 1, maxInputBytes: control.inputBudgetBytes ?? Number.MAX_SAFE_INTEGER, maxInputTokens: Number.MAX_SAFE_INTEGER,
    }).length > 0;
    const finalDisposition: FlowDisposition = !planned || decision.status !== 'classified' ? 'review' : 'release';
    const finalIdentity = finalDisposition === 'release' && chosen ? normalizeIdentity(chosen) : null;
    const finalTags = finalDisposition === 'release' ? tagValues(reviewed.tags) : {};
    const finalReasonCode = !planned ? 'input_too_large' : decision.reasonCode;
    const observation: StandardizationStageObservation = {
      id: control.id, proposalSource: 'synthetic-control', expectedIdentity: control.expectedIdentity,
      expectedDisposition: control.expectedDisposition, expectedTags: control.expectedTags ?? {},
      proposedIdentity: control.proposalIdentity ? normalizeIdentity(control.proposalIdentity) : null,
      proposalDisposition: control.proposalIdentity ? 'release' : 'review',
      proposedTags: tagValues(proposalTags), identityRejected: !decision.review!.approved,
      candidateTargetId, recalledCandidateIds: candidates.map(candidate => candidate.id),
      finalIdentity, finalDisposition, finalTags,
    };
    const expectedIdentityKey = control.expectedIdentity ? buildCanonicalStandardKey(control.expectedIdentity) : null;
    const frozenSource = payload.sourceData as Record<string, unknown> | undefined;
    const frozenEvidenceLength = typeof frozenSource?.evidence === 'string' ? frozenSource.evidence.length : 0;
    const matchesExpected = finalDisposition === control.expectedDisposition
      && JSON.stringify(Object.entries(finalTags).sort()) === JSON.stringify(Object.entries(control.expectedTags ?? {}).sort())
      && (finalDisposition !== 'release' || (finalIdentity && buildCanonicalStandardKey(finalIdentity) === expectedIdentityKey))
      && (control.expectedReasonCode === undefined || finalReasonCode === control.expectedReasonCode)
      && (candidateTargetId === undefined || observation.recalledCandidateIds!.includes(candidateTargetId))
      && (!control.inputBudgetBytes || (!planned && frozenEvidenceLength === control.body.length));
    return { ...observation, mockTagReview: { accepted: [...votes], complete: reviewed.complete },
      mockMatchReview: { ...decision.review! }, soldObject: control.soldObject, finalEvidence: decision.evidence,
      protocolReasonCode: parsed.items[0]!.reasonCode, finalReasonCode, planned, frozenEvidenceLength,
      matchesExpected: Boolean(matchesExpected) };
  });
  const grouped = new Map<string, typeof rows>();
  controls.forEach((control, index) => {
    const key = JSON.stringify([control.name, control.body]);
    const members = grouped.get(key) ?? []; members.push(rows[index]!); grouped.set(key, members);
  });
  const evidenceGroups = [...grouped.values()].map((members, index) => ({
    id: `evidence-${index + 1}`, controlIds: members.map(member => member.id),
    identityLabelState: members.some(member => member.expectedIdentity) ? 'reviewed_identity' : 'no_reviewed_identity',
    passed: members.every(member => member.matchesExpected),
  }));
  const released = rows.filter(row => row.finalDisposition === 'release');
  const tagValuesArray = (value: string | readonly string[] | undefined): readonly string[] => value === undefined ? [] : typeof value === 'string' ? [value] : value;
  return {
    version: 'standardization-flow-controls-20261123-v5', mode: 'synthetic-pure-function-controls',
    purpose: 'Hand-reviewed candidate matches with synthetic proposals, explicit null reasons, structured match feedback and tag-review votes; not production or model accuracy.',
    providerRequests: 0, actualUsage: null, metrics: evaluateStandardizationStages(rows),
    metricDefinitions: {
      modelProposalCorrectness: 'Correct observed model dispositions, identities and tags / observed model proposals; no observations means null.',
      syntheticProposalCorrectness: 'Same comparison for deliberately generated control proposals only.',
      identityRuleFalseRejection: 'Mock binary-review rejections / correct-identity proposals on hand-labeled releasable products.',
      candidateRecallMiss: 'Missing target / observed searches whose hand-reviewed identity exists in this control catalog.',
      finalErroneousRelease: 'Wrong identity, unsupported tags or hand-labeled blocked product / final pure-validator releases.',
    },
    controls: rows, failedControlIds: rows.filter(row => !row.matchesExpected).map(row => row.id),
    evidenceGroups,
    groupedCoverage: { groups: evidenceGroups.length, reviewedIdentityGroups: evidenceGroups.filter(group => group.identityLabelState === 'reviewed_identity').length,
      noReviewedIdentityGroups: evidenceGroups.filter(group => group.identityLabelState === 'no_reviewed_identity').length },
    tagRegression: {
      missingExpectedValues: released.reduce((count, row) => count + Object.entries(row.expectedTags).reduce((sum, [name, value]) =>
        sum + tagValuesArray(value).filter(expected => !tagValuesArray(row.finalTags[name]).includes(expected)).length, 0), 0),
      unsupportedOrContradictoryValues: released.reduce((count, row) => count + Object.entries(row.finalTags).reduce((sum, [name, value]) =>
        sum + tagValuesArray(value).filter(actual => !tagValuesArray(row.expectedTags[name]).includes(actual)).length, 0), 0),
    },
    limitations: [
      'No real model responses, provider usage, production distribution or production accuracy observed.',
      'Match diagnostics, null reasons and tag semantics are supplied as explicit mock responses; the program checks objective constraints only.',
      'Candidate recall uses a small public-safe control catalog, not the production catalog or request-budget pruning.',
      'Final release means frozen pure-function validation only; no database, atomic publication, manual locks, outbox or retries exercised.',
      'Oversize control verifies full payload and batch-planner rejection under an explicit offline byte budget, not repository review routing.',
    ],
  };
}
