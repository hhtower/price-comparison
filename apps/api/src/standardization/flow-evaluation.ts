import { buildCandidateSearchQuery, buildExtractionPayload, estimateInputSize, planAdaptiveBatches } from '../ai/adaptive-batching.js';
import { parseStandardizationProtocolResponse, type StandardizationTag } from '../ai/ai.schemas.js';
import { validateStandardizationEvidence, validateStandardizationTags } from '../ai/standardization-evidence.js';
import { BoundedCandidateIndex, type CandidateDocument } from './candidate-index.js';
import { buildCanonicalStandardKey } from './canonical-key.js';
import { identityEvidenceConflict, normalizeIdentity, type Identity } from './identity-policy.js';
import { publicationEvidenceConflict } from './publication-evidence.js';
import { evaluateStandardizationStages, type FlowDisposition, type FlowTagValues, type StandardizationStageObservation } from './review-evaluation.js';

export interface StandardizationFlowControl {
  readonly id: string;
  readonly name: string;
  readonly body: string;
  readonly soldObject: string;
  readonly expectedIdentity: Identity | null;
  readonly expectedDisposition: FlowDisposition;
  readonly expectedTags?: FlowTagValues;
  readonly expectedIdentityConflict?: boolean;
  readonly expectedPublicationConflict?: boolean;
  readonly expectedReasonCode?: string;
  readonly proposalIdentity: Identity;
  readonly proposalAction?: 'create_identity' | 'reuse_candidate';
  readonly proposalTags?: readonly StandardizationTag[];
  readonly inputBudgetBytes?: number;
}

function tagValues(tags: readonly StandardizationTag[]): FlowTagValues {
  const grouped = new Map<string, Set<string>>();
  for (const tag of tags) {
    const values = grouped.get(tag.name) ?? new Set<string>();
    values.add(tag.value);
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
    const candidateRefs = Object.fromEntries(candidates.map((candidate, position) => ['i1c' + (position + 1), candidate.id]));
    const evidence = [{ path: 'name', quote: control.name }];
    const proposalTags = control.proposalTags ?? [];
    const proposedCandidate = candidates.find(candidate =>
      buildCanonicalStandardKey(candidate) === buildCanonicalStandardKey(control.proposalIdentity));
    const candidateRef = Object.keys(candidateRefs).find(ref => candidateRefs[ref] === proposedCandidate?.id);
    const proposal = control.proposalAction === 'reuse_candidate'
      ? { action: 'reuse_candidate', candidateRef: candidateRef ?? 'unrecalled' }
      : { action: 'create_identity', identity: { ...control.proposalIdentity, reason: 'Synthetic identity probe', evidence } };
    const parsed = parseStandardizationProtocolResponse({ items: [{
      id: control.id, ...proposal, evidence, ruleIds: [], reason: 'Synthetic control, not model observation',
    }] }, [{ id: control.id, candidateStandardProductIds: candidates.map(candidate => candidate.id), candidateRefs }]);
    const validated = validateStandardizationEvidence(parsed, [{ id: control.id, payload }], candidates);
    const decision = validated.items[0]!;
    const choice = decision.identity;
    const chosen = choice?.kind === 'new' ? validated.identities.find(identity => identity.ref === choice.ref)
      : choice?.kind === 'existing' ? candidates.find(candidate => candidate.id === choice.standardProductId) : undefined;
    const identityConflict = {
      raw: identityEvidenceConflict(control.proposalIdentity, raw),
      text: identityEvidenceConflict(control.proposalIdentity, payload, 'text'),
    };
    const publicationConflict = { raw: publicationEvidenceConflict(raw), text: publicationEvidenceConflict(payload, 'text') };
    const size = estimateInputSize(payload);
    const planned = planAdaptiveBatches([{ productId: 1n, payload, ...size }], {
      maxItems: 1, maxInputBytes: control.inputBudgetBytes ?? Number.MAX_SAFE_INTEGER, maxInputTokens: Number.MAX_SAFE_INTEGER,
    }).length > 0;
    // Publication guard results are observations only: the actual validator must enforce them.
    const finalDisposition: FlowDisposition = !planned || decision.status !== 'classified' ? 'review' : 'release';
    const finalIdentity = finalDisposition === 'release' && chosen ? normalizeIdentity(chosen) : null;
    const finalTags = finalDisposition === 'release' ? tagValues(validateStandardizationTags(proposalTags, payload).tags) : {};
    const finalReasonCode = !planned ? 'input_too_large' : decision.reasonCode;
    const observation: StandardizationStageObservation = {
      id: control.id, proposalSource: 'synthetic-control', expectedIdentity: control.expectedIdentity,
      expectedDisposition: control.expectedDisposition, expectedTags: control.expectedTags ?? {},
      proposedIdentity: normalizeIdentity(control.proposalIdentity), proposalDisposition: 'release',
      proposedTags: tagValues(proposalTags), identityRejected: Boolean(identityConflict.text),
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
      && parsed.items[0]!.reasonCode === null
      && (control.inputBudgetBytes || (
        Boolean(identityConflict.raw) === (control.expectedIdentityConflict ?? false)
        && Boolean(identityConflict.text) === (control.expectedIdentityConflict ?? false)))
      && Boolean(publicationConflict.raw) === (control.expectedPublicationConflict ?? false)
      && Boolean(publicationConflict.text) === (control.expectedPublicationConflict ?? false)
      && (candidateTargetId === undefined || observation.recalledCandidateIds!.includes(candidateTargetId))
      && (!control.inputBudgetBytes || (!planned && frozenEvidenceLength === control.body.length));
    return { ...observation, soldObject: control.soldObject, identityConflict, publicationConflict,
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
    version: 'standardization-flow-controls-20261013-v3', mode: 'synthetic-pure-function-controls',
    purpose: 'Hand-reviewed identities/publication labels with synthetic proposals; not production or model accuracy.',
    providerRequests: 0, actualUsage: null, metrics: evaluateStandardizationStages(rows),
    metricDefinitions: {
      modelProposalCorrectness: 'Correct observed model dispositions, identities and tags / observed model proposals; no observations means null.',
      syntheticProposalCorrectness: 'Same comparison for deliberately generated control proposals only.',
      identityRuleFalseRejection: 'Identity-guard rejections / correct-identity proposals on hand-labeled releasable products; publication holds are separate.',
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
      'Candidate recall uses a small public-safe control catalog, not the production catalog or request-budget pruning.',
      'Final release means frozen pure-function validation only; no database, atomic publication, manual locks, outbox or retries exercised.',
      'Oversize control verifies full payload and batch-planner rejection under an explicit offline byte budget, not repository review routing.',
    ],
  };
}
