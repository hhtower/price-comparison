import {
  buildCanonicalStandardKey,
  canonicalizeMatchText,
} from './canonical-key.js';

export interface QualityIdentity {
  readonly family: string;
  readonly product: string;
  readonly tier: string;
}

export interface StandardizationQualitySample {
  readonly id: string;
  readonly shouldClassify: boolean;
  readonly identity: QualityIdentity | null;
  readonly tags: Readonly<Record<string, string>>;
  readonly differentFrom?: readonly string[];
  readonly unclassifiedReason?: string;
}

export interface StandardizationQualityFixture {
  readonly version: string;
  readonly samples: readonly StandardizationQualitySample[];
}

export interface RecordedCatalogIdentity {
  readonly standardProductId: string;
  readonly identity: QualityIdentity;
}

export type RecordedStandardizationOutcome = {
  readonly id: string;
  readonly preBudgetCandidateIds: readonly string[];
  readonly sentCandidateIds: readonly string[];
  readonly tags: Readonly<Record<string, string>>;
} & (
  | {
      readonly status: 'classified';
      readonly standardProductId?: string;
      readonly identity?: QualityIdentity;
    }
  | {
      readonly status: 'unclassified';
      readonly reasonCode: string;
    }
);

export interface RecordedStandardizationResponses {
  readonly version: string;
  readonly fixtureVersion: string;
  readonly catalog: readonly RecordedCatalogIdentity[];
  readonly outcomes: readonly RecordedStandardizationOutcome[];
}

export interface WilsonInterval {
  readonly low: number;
  readonly high: number;
}

export interface QualityRatio {
  readonly numerator: number;
  readonly denominator: number;
  readonly value: number | null;
  readonly wilson95: WilsonInterval | null;
}

export interface TagFieldQuality {
  readonly comparisons: number;
  readonly errors: number;
  readonly missing: number;
  readonly wrongValue: number;
  readonly unexpected: number;
  readonly rate: number | null;
}

export interface StandardizationQualityReport {
  readonly fixtureVersion: string;
  readonly recordedResponseVersion: string;
  readonly sampleCoverage: {
    readonly evaluated: number;
    readonly total: number;
    readonly missingResponseIds: readonly string[];
  };
  readonly candidateRecall: QualityRatio & { readonly coldStartCount: number };
  readonly budgetTruncationLoss: QualityRatio;
  readonly classificationCoverage: QualityRatio;
  readonly falseMergeRate: QualityRatio & {
    readonly pairs: readonly (readonly [string, string])[];
  };
  readonly identitySplitRate: QualityRatio & {
    readonly pairs: readonly (readonly [string, string])[];
  };
  readonly nonSaleFalsePositiveRate: QualityRatio;
  readonly unclassifiedReasons: Readonly<Record<string, number>>;
  readonly tagFields: Readonly<Record<string, TagFieldQuality>>;
}

const NON_SALE_REASONS = new Set(['non_sale_item', 'not_sellable']);

export function evaluateStandardizationQuality(
  fixture: StandardizationQualityFixture,
  responses: RecordedStandardizationResponses,
): StandardizationQualityReport {
  if (responses.fixtureVersion !== fixture.version) {
    throw new Error(
      `quality fixture version mismatch: expected ${fixture.version}, received ${responses.fixtureVersion}`,
    );
  }

  const samples = uniqueById(fixture.samples, 'quality sample');
  const outcomes = uniqueById(responses.outcomes, 'recorded outcome');
  const catalog = new Map<string, QualityIdentity>();
  for (const entry of responses.catalog) {
    if (catalog.has(entry.standardProductId)) {
      throw new Error(`duplicate catalog standard product ID: ${entry.standardProductId}`);
    }
    catalog.set(entry.standardProductId, entry.identity);
  }
  for (const outcome of outcomes.values()) {
    if (!samples.has(outcome.id)) throw new Error(`recorded outcome references unknown sample: ${outcome.id}`);
    validateOutcome(outcome, catalog);
  }

  const missingResponseIds = [...samples.keys()]
    .filter((id) => !outcomes.has(id))
    .sort(compareText);
  const predictedKeys = new Map<string, string>();
  const unclassifiedReasons: Record<string, number> = {};
  for (const outcome of outcomes.values()) {
    if (outcome.status === 'classified') {
      predictedKeys.set(outcome.id, resolveOutcomeKey(outcome, catalog));
    } else {
      unclassifiedReasons[outcome.reasonCode] = (unclassifiedReasons[outcome.reasonCode] ?? 0) + 1;
    }
  }

  let candidateDenominator = 0;
  let candidateNumerator = 0;
  let coldStartCount = 0;
  let budgetTruncationLoss = 0;
  let shouldClassifyCount = 0;
  let classifiedExpectedCount = 0;
  let nonSaleCount = 0;
  let nonSaleFalsePositiveCount = 0;
  const tagFields = new Map<string, MutableTagFieldQuality>();

  for (const sample of samples.values()) {
    const outcome = outcomes.get(sample.id);
    if (sample.shouldClassify) {
      shouldClassifyCount += 1;
      if (!sample.identity) throw new Error(`classified quality sample is missing identity: ${sample.id}`);
      if (outcome?.status === 'classified') classifiedExpectedCount += 1;
      if (outcome) {
        const expectedKey = buildCanonicalStandardKey(sample.identity);
        const preBudgetKeys = candidateKeys(outcome.preBudgetCandidateIds, catalog);
        const sentKeys = candidateKeys(outcome.sentCandidateIds, catalog);
        if (preBudgetKeys.has(expectedKey)) {
          candidateDenominator += 1;
          if (sentKeys.has(expectedKey)) candidateNumerator += 1;
          else budgetTruncationLoss += 1;
        } else {
          coldStartCount += 1;
        }
      }
    } else if (NON_SALE_REASONS.has(sample.unclassifiedReason ?? '')) {
      nonSaleCount += 1;
      if (outcome?.status === 'classified') nonSaleFalsePositiveCount += 1;
    }
    if (outcome) compareTags(sample.tags, outcome.tags, tagFields);
  }

  const falseMergePairs = collectFalseMergePairs(samples, predictedKeys);
  const falseMergeDenominator = collectComparableDifferentPairs(samples, predictedKeys).length;
  const split = collectIdentitySplitPairs(samples, predictedKeys);

  return {
    fixtureVersion: fixture.version,
    recordedResponseVersion: responses.version,
    sampleCoverage: {
      evaluated: outcomes.size,
      total: samples.size,
      missingResponseIds,
    },
    candidateRecall: {
      ...ratio(candidateNumerator, candidateDenominator),
      coldStartCount,
    },
    budgetTruncationLoss: ratio(budgetTruncationLoss, candidateDenominator),
    classificationCoverage: ratio(classifiedExpectedCount, shouldClassifyCount),
    falseMergeRate: {
      ...ratio(falseMergePairs.length, falseMergeDenominator),
      pairs: falseMergePairs,
    },
    identitySplitRate: {
      ...ratio(split.pairs.length, split.denominator),
      pairs: split.pairs,
    },
    nonSaleFalsePositiveRate: ratio(nonSaleFalsePositiveCount, nonSaleCount),
    unclassifiedReasons: Object.freeze(sortRecord(unclassifiedReasons)),
    tagFields: Object.freeze(
      Object.fromEntries(
        [...tagFields.entries()]
          .sort(([left], [right]) => compareText(left, right))
          .map(([name, metric]) => [
            name,
            {
              ...metric,
              rate: metric.comparisons === 0 ? null : metric.errors / metric.comparisons,
            } satisfies TagFieldQuality,
          ]),
      ),
    ),
  };
}

function validateOutcome(
  outcome: RecordedStandardizationOutcome,
  catalog: ReadonlyMap<string, QualityIdentity>,
): void {
  for (const id of [...outcome.preBudgetCandidateIds, ...outcome.sentCandidateIds]) {
    if (!catalog.has(id)) throw new Error(`recorded outcome ${outcome.id} references unknown candidate: ${id}`);
  }
  const preBudget = new Set(outcome.preBudgetCandidateIds);
  for (const id of outcome.sentCandidateIds) {
    if (!preBudget.has(id)) throw new Error(`sent candidate ${id} was not present before budget truncation for ${outcome.id}`);
  }
  if (outcome.status === 'classified') {
    if ((outcome.identity === undefined) === (outcome.standardProductId === undefined)) {
      throw new Error(`classified outcome must select exactly one identity source: ${outcome.id}`);
    }
    if (outcome.standardProductId !== undefined && !catalog.has(outcome.standardProductId)) {
      throw new Error(`recorded outcome ${outcome.id} references unknown standard product: ${outcome.standardProductId}`);
    }
  }
}

function resolveOutcomeKey(
  outcome: Extract<RecordedStandardizationOutcome, { status: 'classified' }>,
  catalog: ReadonlyMap<string, QualityIdentity>,
): string {
  const identity = outcome.identity ?? catalog.get(outcome.standardProductId!);
  if (!identity) throw new Error(`unable to resolve classified identity for ${outcome.id}`);
  return buildCanonicalStandardKey(identity);
}

function candidateKeys(
  ids: readonly string[],
  catalog: ReadonlyMap<string, QualityIdentity>,
): ReadonlySet<string> {
  return new Set(ids.map((id) => buildCanonicalStandardKey(catalog.get(id)!)));
}

function collectComparableDifferentPairs(
  samples: ReadonlyMap<string, StandardizationQualitySample>,
  predictedKeys: ReadonlyMap<string, string>,
): Array<readonly [string, string]> {
  const pairs = new Map<string, readonly [string, string]>();
  for (const sample of samples.values()) {
    for (const otherId of sample.differentFrom ?? []) {
      if (!samples.has(otherId)) throw new Error(`quality sample ${sample.id} references unknown differentFrom ID: ${otherId}`);
      const pair = stablePair(sample.id, otherId);
      if (predictedKeys.has(pair[0]) && predictedKeys.has(pair[1])) pairs.set(pair.join('\0'), pair);
    }
  }
  return [...pairs.values()].sort(comparePair);
}

function collectFalseMergePairs(
  samples: ReadonlyMap<string, StandardizationQualitySample>,
  predictedKeys: ReadonlyMap<string, string>,
): Array<readonly [string, string]> {
  return collectComparableDifferentPairs(samples, predictedKeys)
    .filter(([left, right]) => predictedKeys.get(left) === predictedKeys.get(right));
}

function collectIdentitySplitPairs(
  samples: ReadonlyMap<string, StandardizationQualitySample>,
  predictedKeys: ReadonlyMap<string, string>,
): { denominator: number; pairs: Array<readonly [string, string]> } {
  const expectedGroups = new Map<string, string[]>();
  for (const sample of samples.values()) {
    if (!sample.shouldClassify || !sample.identity) continue;
    const key = buildCanonicalStandardKey(sample.identity);
    const ids = expectedGroups.get(key) ?? [];
    ids.push(sample.id);
    expectedGroups.set(key, ids);
  }
  let denominator = 0;
  const pairs: Array<readonly [string, string]> = [];
  for (const ids of expectedGroups.values()) {
    ids.sort(compareText);
    for (let leftIndex = 0; leftIndex < ids.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < ids.length; rightIndex += 1) {
        const left = ids[leftIndex]!;
        const right = ids[rightIndex]!;
        if (!predictedKeys.has(left) || !predictedKeys.has(right)) continue;
        denominator += 1;
        if (predictedKeys.get(left) !== predictedKeys.get(right)) pairs.push([left, right]);
      }
    }
  }
  pairs.sort(comparePair);
  return { denominator, pairs };
}

interface MutableTagFieldQuality {
  comparisons: number;
  errors: number;
  missing: number;
  wrongValue: number;
  unexpected: number;
}

function compareTags(
  expected: Readonly<Record<string, string>>,
  actual: Readonly<Record<string, string>>,
  metrics: Map<string, MutableTagFieldQuality>,
): void {
  const expectedTags = normalizeTags(expected);
  const actualTags = normalizeTags(actual);
  const names = new Set([...expectedTags.keys(), ...actualTags.keys()]);
  for (const name of names) {
    const metric = metrics.get(name) ?? {
      comparisons: 0,
      errors: 0,
      missing: 0,
      wrongValue: 0,
      unexpected: 0,
    };
    metric.comparisons += 1;
    const expectedValue = expectedTags.get(name);
    const actualValue = actualTags.get(name);
    if (expectedValue === undefined) {
      metric.errors += 1;
      metric.unexpected += 1;
    } else if (actualValue === undefined) {
      metric.errors += 1;
      metric.missing += 1;
    } else if (expectedValue !== actualValue) {
      metric.errors += 1;
      metric.wrongValue += 1;
    }
    metrics.set(name, metric);
  }
}

function normalizeTags(tags: Readonly<Record<string, string>>): Map<string, string> {
  const normalized = new Map<string, string>();
  for (const [rawName, rawValue] of Object.entries(tags)) {
    const name = canonicalizeMatchText(rawName);
    const value = canonicalizeMatchText(rawValue);
    if (!name || !value) throw new Error('quality tag name and value must be non-empty');
    if (normalized.has(name)) throw new Error(`duplicate quality tag after normalization: ${name}`);
    normalized.set(name, value);
  }
  return normalized;
}

function ratio(numerator: number, denominator: number): QualityRatio {
  return {
    numerator,
    denominator,
    value: denominator === 0 ? null : numerator / denominator,
    wilson95: denominator === 0 ? null : wilsonInterval(numerator, denominator),
  };
}

function wilsonInterval(numerator: number, denominator: number): WilsonInterval {
  const z = 1.959963984540054;
  const observed = numerator / denominator;
  const zSquared = z * z;
  const scale = 1 + zSquared / denominator;
  const center = (observed + zSquared / (2 * denominator)) / scale;
  const margin = z * Math.sqrt(
    (observed * (1 - observed) + zSquared / (4 * denominator)) / denominator,
  ) / scale;
  return {
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
  };
}

function uniqueById<T extends { readonly id: string }>(
  values: readonly T[],
  label: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    if (result.has(value.id)) throw new Error(`duplicate ${label} ID: ${value.id}`);
    result.set(value.id, value);
  }
  return result;
}

function stablePair(left: string, right: string): readonly [string, string] {
  return compareText(left, right) <= 0 ? [left, right] : [right, left];
}

function comparePair(
  left: readonly [string, string],
  right: readonly [string, string],
): number {
  return compareText(left[0], right[0]) || compareText(left[1], right[1]);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortRecord(values: Readonly<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(values).sort(([left], [right]) => compareText(left, right)),
  );
}
