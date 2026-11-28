import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MEMBERSHIP_FEATURE_PROMPT_VERSION,
  MEMBERSHIP_FEATURE_REVIEW_PROMPT_VERSION,
  parseMembershipFeatureResponse,
  parseMembershipFeatureReviewResponse,
} from '../src/ai/membership-feature-request.js';
import {
  MEMBERSHIP_FEATURE_FIXTURE_VERSION,
  MEMBERSHIP_FEATURE_HELD_OUT_IDS,
  membershipFeatureCases,
} from '../test/fixtures/membership-feature-cases.js';

interface Recording {
  id: string;
  generation: string;
  review: string;
}

function hasFields(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
}

// Each response is the original wire content for a single-item request (local ID "1").
// Its review must assess fixture.proposedKind with refs [0, 1], not the generated answer.
export function evaluateMembershipFeatures(recording: unknown) {
  if (!hasFields(recording, ['cases']) || !Array.isArray(recording.cases)) {
    throw new Error('Recording must contain exactly a cases array');
  }
  const knownIds = new Set(membershipFeatureCases.map(item => item.id));
  const records = new Map<string, Recording>();
  for (const item of recording.cases) {
    if (!hasFields(item, ['id', 'generation', 'review'])
      || typeof item.id !== 'string' || typeof item.generation !== 'string' || typeof item.review !== 'string') {
      throw new Error('Each recording must contain exactly string id, generation and review fields');
    }
    if (!knownIds.has(item.id)) throw new Error(`Unknown case ID: ${item.id}`);
    if (records.has(item.id)) throw new Error(`Duplicate case ID: ${item.id}`);
    records.set(item.id, { id: item.id, generation: item.generation, review: item.review });
  }

  const cases = membershipFeatureCases.map(fixture => {
    const record = records.get(fixture.id);
    const input = [{ id: fixture.id, name: fixture.name, spec: fixture.spec }];
    const expectedVerdict = fixture.expectedKind === fixture.proposedKind;
    const protocolErrors: Array<{ stage: 'generation' | 'review'; message: string }> = [];
    let generation: ReturnType<typeof parseMembershipFeatureResponse>['items'][number] | null = null;
    let review: ReturnType<typeof parseMembershipFeatureReviewResponse>['items'][number] | null = null;
    if (record) {
      try {
        generation = parseMembershipFeatureResponse(record.generation, input).items[0]!;
      } catch (error) {
        protocolErrors.push({ stage: 'generation', message: error instanceof Error ? error.message : String(error) });
      }
      try {
        review = parseMembershipFeatureReviewResponse(record.review, input).items[0]!;
      } catch (error) {
        protocolErrors.push({ stage: 'review', message: error instanceof Error ? error.message : String(error) });
      }
    }
    const classificationCorrect = generation !== null && generation.membershipKind === fixture.expectedKind;
    const reviewVerdictCorrect = review !== null && review.classificationDecision === expectedVerdict;
    const reviewCodeCorrect = review !== null && review.code === fixture.reviewCode;
    const diagnostics: string[] = [];
    if (!record) diagnostics.push('Missing recording');
    if (generation && !classificationCorrect) {
      diagnostics.push(`Expected classification ${fixture.expectedKind}; received ${generation.membershipKind}`);
    }
    if (review && !reviewVerdictCorrect) {
      diagnostics.push(`Expected review verdict ${expectedVerdict} for proposal ${fixture.proposedKind}; received ${review.classificationDecision}`);
    }
    if (review && !reviewCodeCorrect) {
      diagnostics.push(`Expected review code ${fixture.reviewCode}; received ${review.code}`);
    }
    diagnostics.push(...protocolErrors.map(error => `${error.stage} protocol error: ${error.message}`));
    return {
      id: fixture.id,
      split: MEMBERSHIP_FEATURE_HELD_OUT_IDS.includes(fixture.id) ? 'heldOut' : 'regression',
      name: fixture.name,
      expectedKind: fixture.expectedKind,
      proposedKind: fixture.proposedKind,
      proposalRefs: [0, 1],
      expectedReview: { classificationDecision: expectedVerdict, code: fixture.reviewCode },
      reason: fixture.reason,
      status: !record ? 'missing' : protocolErrors.length ? 'protocol_error' : 'valid',
      generation,
      review,
      classificationCorrect,
      reviewVerdictCorrect,
      reviewCodeCorrect,
      reviewCorrect: reviewVerdictCorrect && reviewCodeCorrect,
      passed: classificationCorrect && reviewVerdictCorrect && reviewCodeCorrect,
      protocolErrors,
      diagnostics,
    };
  });
  const total = cases.length;
  const metric = (correct: number) => ({ correct, total, accuracy: correct / total });
  const splitSummary = (split: 'heldOut' | 'regression') => {
    const rows = cases.filter(item => item.split === split);
    return { total: rows.length, provided: rows.filter(item => item.status !== 'missing').length,
      classificationCorrect: rows.filter(item => item.classificationCorrect).length,
      reviewCorrect: rows.filter(item => item.reviewCorrect).length, passed: rows.filter(item => item.passed).length };
  };
  return {
    provenance: 'provided-recordings' as const,
    fixtureVersion: MEMBERSHIP_FEATURE_FIXTURE_VERSION,
    promptVersions: {
      generation: MEMBERSHIP_FEATURE_PROMPT_VERSION,
      review: MEMBERSHIP_FEATURE_REVIEW_PROMPT_VERSION,
    },
    recordingPromptVersions: 'unknown' as const,
    semanticPopulationAccuracy: 'unknown' as const,
    modelCalls: 0,
    notes: [
      'Prompt versions identify the evaluator source; supplied recordings do not attest their originating prompt versions.',
      'Reviews are scored against fixture.proposedKind with refs [0, 1], independently of generation.',
      'Accuracy uses all fixtures as denominator; missing and malformed responses never pass.',
      'Citation structure and line existence are checked by production parsers; semantic citation support is not independently scored.',
      'Provided recordings are not authenticated model observations. No network, database or model calls are made.',
      'Regression cases appeared in the v13 prompt; use the separate held-out cases for comparisons without those examples.',
    ],
    coverage: {
      total,
      provided: records.size,
      missing: total - records.size,
      valid: cases.filter(item => item.status === 'valid').length,
      generationValid: cases.filter(item => item.generation !== null).length,
      reviewValid: cases.filter(item => item.review !== null).length,
      ratio: records.size / total,
    },
    classification: metric(cases.filter(item => item.classificationCorrect).length),
    reviewVerdict: metric(cases.filter(item => item.reviewVerdictCorrect).length),
    reviewCode: metric(cases.filter(item => item.reviewCodeCorrect).length),
    review: metric(cases.filter(item => item.reviewCorrect).length),
    passed: cases.filter(item => item.passed).length,
    splits: { regression: splitSummary('regression'), heldOut: splitSummary('heldOut') },
    protocolErrors: {
      cases: cases.filter(item => item.protocolErrors.length > 0).length,
      generation: cases.filter(item => item.protocolErrors.some(error => error.stage === 'generation')).length,
      review: cases.filter(item => item.protocolErrors.some(error => error.stage === 'review')).length,
    },
    cases,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    throw new Error('Usage: tsx apps/api/scripts/evaluate-membership-features.ts responses.json report.json');
  }
  const [inputPath, outputPath] = args as [string, string];
  if (path.resolve(inputPath) === path.resolve(outputPath)) throw new Error('Report path must differ from recording path');
  const report = evaluateMembershipFeatures(JSON.parse(await readFile(inputPath, 'utf8')));
  await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  console.log(`Evaluated ${report.coverage.provided}/${report.coverage.total} recordings; ${report.passed} passed; report: ${outputPath}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
