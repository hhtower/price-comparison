import { readFile } from 'node:fs/promises';
import {
  auditStandardProductDuplicates,
  DUPLICATE_BLOCKING_ROUTES,
  type DuplicateAuditResult,
  type DuplicateBlockingRoute,
} from '../src/standardization/duplicate-audit.js';
import { buildCanonicalStandardKey } from '../src/standardization/canonical-key.js';
import { DUPLICATE_LINKAGE_POLICY } from '../src/standardization/duplicate-linkage-policy.js';
import { classifyDuplicatePair, extractDuplicateFeatures, type StandardProductIdentity } from '../src/standardization/duplicate-linkage.js';

interface PairFixture {
  readonly id: string;
  readonly partition: 'development' | 'holdout';
  readonly label: 'match' | 'non_match';
  readonly confirmedAlias: boolean;
  readonly hardConflictReason: string | null;
  readonly left: StandardProductIdentity;
  readonly right: StandardProductIdentity;
}

interface DuplicatePairFixture {
  readonly version: string;
  readonly truthGroups: readonly {
    readonly id: string;
    readonly members: readonly string[];
  }[];
  readonly pairs: readonly PairFixture[];
}

export interface DuplicateQualityGates {
  readonly version: string;
  readonly auditReportVersion: string;
  readonly policyVersion: string;
  readonly fixtureVersion: string;
  readonly topK: number;
  readonly minimumBlockingRecallAtK: number;
  readonly minimumSuspectRecallAtK: number;
  readonly minimumPrecisionAtReviewBudget: number;
  readonly maximumReviewPairsPerThousand: number;
  readonly maximumHardConflictLeaks: 0;
  readonly maximumDeterministicFalseMerges: 0;
  readonly maximumBudgetTruncationMisses: 0;
  readonly minimumHoldoutMatchPairs: number;
  readonly minimumHoldoutNonMatchPairs: number;
}

interface Ratio {
  readonly numerator: number;
  readonly denominator: number;
  readonly value: number | null;
}

interface WilsonInterval {
  readonly lower: number | null;
  readonly upper: number | null;
}

type GateMetricStatus = 'passed' | 'failed' | 'insufficient_sample' | 'unknown';

interface ThresholdEvaluation {
  readonly actual: number | null;
  readonly required: number;
  readonly numerator?: number;
  readonly denominator?: number;
  readonly status: GateMetricStatus;
}

interface PartitionMetrics {
  readonly blockingRecall: Ratio;
  readonly blockingRecallConfidence95: WilsonInterval;
  readonly recallAtK: Ratio;
  readonly recallAtKConfidence95: WilsonInterval;
  readonly suspectedPairPrecision: Ratio;
  readonly suspectedPairPrecisionConfidence95: WilsonInterval;
  readonly hardConflictAccuracy: Ratio;
  readonly hardConflictAccuracyConfidence95: WilsonInterval;
  readonly hardConflictLeaks: number;
  readonly deterministicFalseMergePairIds: readonly string[];
  readonly expectedManualReviewPairs: number;
  readonly candidateCountPerIdentity: Ratio;
  readonly routeFirstContribution: Readonly<Record<DuplicateBlockingRoute, number>>;
  readonly routeRemovalMisses: Readonly<Record<DuplicateBlockingRoute, readonly string[]>>;
  readonly budgetTruncationMisses: readonly string[];
  readonly matchPairs: number;
  readonly nonMatchPairs: number;
}

export interface DuplicateAuditReport {
  readonly reportVersion: string;
  readonly fixtureVersion: string;
  readonly policyVersion: string;
  readonly qualityGateVersion: string;
  readonly topK: number;
  readonly readOnly: true;
  readonly metrics: Readonly<Record<'development' | 'holdout', PartitionMetrics>>;
  readonly gateEvaluation: {
    readonly overallStatus: 'passed' | 'blocked';
    readonly sampleSize: {
      readonly actual: { readonly matchPairs: number; readonly nonMatchPairs: number };
      readonly required: { readonly matchPairs: number; readonly nonMatchPairs: number };
      readonly status: 'passed' | 'insufficient_sample';
    };
    readonly partitions: Readonly<Record<'development' | 'holdout', {
      readonly blockingRecallAtK: ThresholdEvaluation;
      readonly suspectRecallAtK: ThresholdEvaluation;
      readonly precisionAtReviewBudget: ThresholdEvaluation;
    }>>;
    readonly reviewPairsPerThousand: ThresholdEvaluation;
    readonly hardConflictLeaks: ThresholdEvaluation;
    readonly deterministicFalseMerges: ThresholdEvaluation;
    readonly budgetTruncationMisses: ThresholdEvaluation;
  };
  readonly deterministicGroupCount: number;
  readonly deterministicEdgeCount: number;
  readonly suspectedPairCount: number;
  readonly comparedPairs: number;
  readonly routes: Readonly<Record<string, object>>;
  readonly candidateCountPerIdentity: Ratio;
  readonly routeFirstContribution: Readonly<Record<string, number>>;
  readonly note: string;
}

const DEFAULT_PAIR_FIXTURE_URL = new URL('../test/fixtures/standard-product-duplicate-pairs.json', import.meta.url);
const DEFAULT_QUALITY_GATES_URL = new URL('../test/fixtures/standard-product-duplicate-quality-gates.json', import.meta.url);

function ratio(numerator: number, denominator: number): Ratio {
  return { numerator, denominator, value: denominator === 0 ? null : numerator / denominator };
}

function wilson95(metric: Ratio): WilsonInterval {
  if (metric.denominator === 0) return { lower: null, upper: null };
  const z = 1.959963984540054;
  const n = metric.denominator;
  const probability = metric.numerator / n;
  const zSquared = z * z;
  const denominator = 1 + zSquared / n;
  const center = (probability + zSquared / (2 * n)) / denominator;
  const margin = z * Math.sqrt((probability * (1 - probability) + zSquared / (4 * n)) / n) / denominator;
  return {
    lower: metric.numerator === 0 ? 0 : Math.max(0, center - margin),
    upper: metric.numerator === metric.denominator ? 1 : Math.min(1, center + margin),
  };
}

function fixturePairKey(pair: PairFixture): string {
  return [pair.left.id, pair.right.id].sort().join('\u0000');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, name: string, path: string = name): string {
  const value = record[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`invalid duplicate pair fixture ${path}`);
  return value;
}

function parseFixtureIdentity(value: unknown, path: string): StandardProductIdentity {
  if (!isRecord(value)) throw new Error(`invalid duplicate pair fixture ${path}`);
  const canonicalKey = value.canonicalKey;
  if (canonicalKey !== undefined && (typeof canonicalKey !== 'string' || canonicalKey.length === 0)) {
    throw new Error(`invalid duplicate pair fixture ${path}.canonicalKey`);
  }
  return {
    id: requiredString(value, 'id', `${path}.id`),
    family: requiredString(value, 'family', `${path}.family`),
    product: requiredString(value, 'product', `${path}.product`),
    tier: requiredString(value, 'tier', `${path}.tier`),
    ...(canonicalKey === undefined ? {} : { canonicalKey }),
  };
}

function parseDuplicatePairFixture(value: unknown): DuplicatePairFixture {
  if (!isRecord(value)) throw new Error('invalid duplicate pair fixture root');
  const version = requiredString(value, 'version');
  if (!Array.isArray(value.pairs)) throw new Error('invalid duplicate pair fixture pairs');
  const pairs = value.pairs.map((candidate, index): PairFixture => {
    const path = `pairs[${index}]`;
    if (!isRecord(candidate)) throw new Error(`invalid duplicate pair fixture ${path}`);
    const partition = candidate.partition;
    if (partition !== 'development' && partition !== 'holdout') throw new Error(`invalid duplicate pair fixture ${path}.partition`);
    const label = candidate.label;
    if (label !== 'match' && label !== 'non_match') throw new Error(`invalid duplicate pair fixture ${path}.label`);
    if (typeof candidate.confirmedAlias !== 'boolean') throw new Error(`invalid duplicate pair fixture ${path}.confirmedAlias`);
    if (candidate.hardConflictReason !== null && typeof candidate.hardConflictReason !== 'string') {
      throw new Error(`invalid duplicate pair fixture ${path}.hardConflictReason`);
    }
    return {
      id: requiredString(candidate, 'id', `${path}.id`),
      partition,
      label,
      confirmedAlias: candidate.confirmedAlias,
      hardConflictReason: candidate.hardConflictReason,
      left: parseFixtureIdentity(candidate.left, `${path}.left`),
      right: parseFixtureIdentity(candidate.right, `${path}.right`),
    };
  });
  if (!Array.isArray(value.truthGroups)) throw new Error('invalid duplicate pair fixture truthGroups');
  const truthGroups = value.truthGroups.map((candidate, index) => {
    const path = `truthGroups[${index}]`;
    if (!isRecord(candidate)) throw new Error(`invalid duplicate pair fixture ${path}`);
    if (!Array.isArray(candidate.members) || candidate.members.length < 2) {
      throw new Error(`invalid duplicate pair fixture ${path}.members`);
    }
    const members = candidate.members.map((member, memberIndex) => {
      if (typeof member !== 'string' || member.length === 0) throw new Error(`invalid duplicate pair fixture ${path}.members[${memberIndex}]`);
      return member;
    });
    if (new Set(members).size !== members.length) throw new Error(`duplicate member in truth group ${requiredString(candidate, 'id', `${path}.id`)}`);
    return { id: requiredString(candidate, 'id', `${path}.id`), members };
  });
  return { version, truthGroups, pairs };
}

function validateFixturePartitionIsolation(fixture: DuplicatePairFixture): void {
  const productsById = new Map<string, { partition: PairFixture['partition']; signature: string }>();
  const partitionsByCanonicalIdentity = new Map<string, PairFixture['partition']>();
  const labelsByPairKey = new Map<string, PairFixture['label']>();
  const pairIds = new Set<string>();
  for (const pair of fixture.pairs) {
    if (pairIds.has(pair.id)) throw new Error(`duplicate fixture pair id ${pair.id}`);
    pairIds.add(pair.id);
    const key = fixturePairKey(pair);
    const [leftId, rightId] = [pair.left.id, pair.right.id].sort();
    const previousLabel = labelsByPairKey.get(key);
    if (previousLabel && previousLabel !== pair.label) {
      throw new Error(`pair ${leftId} ${rightId} has conflicting fixture labels`);
    }
    if (previousLabel) throw new Error(`duplicate fixture pair ${leftId} ${rightId}`);
    labelsByPairKey.set(key, pair.label);
    for (const product of [pair.left, pair.right]) {
      const signature = JSON.stringify([product.family, product.product, product.tier, product.canonicalKey ?? null]);
      const previous = productsById.get(product.id);
      if (previous && previous.partition !== pair.partition) {
        throw new Error(`product id ${product.id} crosses fixture partitions`);
      }
      if (previous && previous.signature !== signature) {
        throw new Error(`product id ${product.id} has inconsistent fixture identities`);
      }
      productsById.set(product.id, { partition: pair.partition, signature });
      const canonicalIdentity = product.canonicalKey ?? buildCanonicalStandardKey(product);
      const canonicalPartition = partitionsByCanonicalIdentity.get(canonicalIdentity);
      if (canonicalPartition && canonicalPartition !== pair.partition) {
        throw new Error(`canonical identity ${canonicalIdentity} crosses fixture partitions`);
      }
      partitionsByCanonicalIdentity.set(canonicalIdentity, pair.partition);
    }
  }
  const truthGroupIds = new Set<string>();
  const truthGroupByProduct = new Map<string, string>();
  for (const group of fixture.truthGroups) {
    if (truthGroupIds.has(group.id)) throw new Error(`duplicate truth group id ${group.id}`);
    truthGroupIds.add(group.id);
    const partitions = new Set<PairFixture['partition']>();
    for (const member of group.members) {
      const product = productsById.get(member);
      if (!product) throw new Error(`truth group ${group.id} references unknown product ${member}`);
      const previousGroup = truthGroupByProduct.get(member);
      if (previousGroup) throw new Error(`product ${member} belongs to multiple truth groups ${previousGroup} and ${group.id}`);
      truthGroupByProduct.set(member, group.id);
      partitions.add(product.partition);
    }
    if (partitions.size > 1) throw new Error(`truth group ${group.id} crosses fixture partitions`);
  }
  for (const pair of fixture.pairs) {
    const leftGroup = truthGroupByProduct.get(pair.left.id) ?? `singleton:${pair.left.id}`;
    const rightGroup = truthGroupByProduct.get(pair.right.id) ?? `singleton:${pair.right.id}`;
    if (pair.label === 'match' && leftGroup !== rightGroup) throw new Error(`match pair ${pair.id} spans truth groups`);
    if (pair.label === 'non_match' && leftGroup === rightGroup) throw new Error(`non-match pair ${pair.id} shares truth group ${leftGroup}`);
  }
}

function deterministicPairKeys(audit: DuplicateAuditResult): Set<string> {
  const result = new Set<string>();
  for (const group of audit.deterministicGroups) {
    for (let left = 0; left < group.members.length; left += 1) {
      for (let right = left + 1; right < group.members.length; right += 1) {
        result.add([group.members[left]!, group.members[right]!].sort().join('\u0000'));
      }
    }
  }
  return result;
}

function blockingKeys(audit: DuplicateAuditResult): Set<string> {
  return new Set([...audit.allCandidatePairs.map(pair => pair.pairKey), ...deterministicPairKeys(audit)]);
}

function recalledKeys(audit: DuplicateAuditResult): Set<string> {
  return new Set([...audit.suspectedPairs.map(pair => pair.pairKey), ...deterministicPairKeys(audit)]);
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`invalid duplicate quality gate ${name}`);
  return value;
}

function probability(value: unknown, name: string): number {
  const parsed = finiteNumber(value, name);
  if (parsed < 0 || parsed > 1) throw new Error(`invalid duplicate quality gate ${name}`);
  return parsed;
}

function positiveInteger(value: unknown, name: string): number {
  const parsed = finiteNumber(value, name);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`invalid duplicate quality gate ${name}`);
  return parsed;
}

export async function loadDuplicateQualityGates(source: URL = DEFAULT_QUALITY_GATES_URL): Promise<DuplicateQualityGates> {
  const raw = JSON.parse(await readFile(source, 'utf8')) as Record<string, unknown>;
  for (const name of ['version', 'auditReportVersion', 'policyVersion', 'fixtureVersion'] as const) {
    if (typeof raw[name] !== 'string' || raw[name].length === 0) throw new Error(`invalid duplicate quality gate ${name}`);
  }
  if (raw.maximumHardConflictLeaks !== 0) throw new Error('maximumHardConflictLeaks must remain zero');
  if (raw.maximumDeterministicFalseMerges !== 0) throw new Error('maximumDeterministicFalseMerges must remain zero');
  if (raw.maximumBudgetTruncationMisses !== 0) throw new Error('maximumBudgetTruncationMisses must remain zero');
  return {
    version: raw.version as string,
    auditReportVersion: raw.auditReportVersion as string,
    policyVersion: raw.policyVersion as string,
    fixtureVersion: raw.fixtureVersion as string,
    topK: positiveInteger(raw.topK, 'topK'),
    minimumBlockingRecallAtK: probability(raw.minimumBlockingRecallAtK, 'minimumBlockingRecallAtK'),
    minimumSuspectRecallAtK: probability(raw.minimumSuspectRecallAtK, 'minimumSuspectRecallAtK'),
    minimumPrecisionAtReviewBudget: probability(raw.minimumPrecisionAtReviewBudget, 'minimumPrecisionAtReviewBudget'),
    maximumReviewPairsPerThousand: finiteNumber(raw.maximumReviewPairsPerThousand, 'maximumReviewPairsPerThousand'),
    maximumHardConflictLeaks: 0,
    maximumDeterministicFalseMerges: 0,
    maximumBudgetTruncationMisses: 0,
    minimumHoldoutMatchPairs: positiveInteger(raw.minimumHoldoutMatchPairs, 'minimumHoldoutMatchPairs'),
    minimumHoldoutNonMatchPairs: positiveInteger(raw.minimumHoldoutNonMatchPairs, 'minimumHoldoutNonMatchPairs'),
  };
}

function minimumThreshold(metric: Ratio, required: number): ThresholdEvaluation {
  return {
    actual: metric.value,
    required,
    numerator: metric.numerator,
    denominator: metric.denominator,
    status: metric.value === null ? 'unknown' : metric.value >= required ? 'passed' : 'failed',
  };
}

function maximumThreshold(actual: number, required: number): ThresholdEvaluation {
  return { actual, required, status: actual <= required ? 'passed' : 'failed' };
}

export async function buildDuplicateAuditReport(options: {
  readonly fixtureUrl?: URL;
  readonly qualityGatesUrl?: URL;
  readonly maxReportedSuspectPairs?: number;
} = {}): Promise<DuplicateAuditReport> {
  const [fixtureText, gates] = await Promise.all([
    readFile(options.fixtureUrl ?? DEFAULT_PAIR_FIXTURE_URL, 'utf8'),
    loadDuplicateQualityGates(options.qualityGatesUrl ?? DEFAULT_QUALITY_GATES_URL),
  ]);
  const fixture = parseDuplicatePairFixture(JSON.parse(fixtureText) as unknown);
  if (gates.policyVersion !== DUPLICATE_LINKAGE_POLICY.version) throw new Error(`quality gate policy version mismatch: expected ${DUPLICATE_LINKAGE_POLICY.version}, received ${gates.policyVersion}`);
  if (gates.fixtureVersion !== fixture.version) throw new Error(`quality gate fixture version mismatch: expected ${fixture.version}, received ${gates.fixtureVersion}`);
  validateFixturePartitionIsolation(fixture);
  const partitionResults = Object.fromEntries((['development', 'holdout'] as const).map(partition => {
    const pairs = fixture.pairs.filter(pair => pair.partition === partition);
    const products = pairs.flatMap(pair => [pair.left, pair.right]).filter((item, index, all) => all.findIndex(candidate => candidate.id === item.id) === index);
    const aliases = pairs.filter(pair => pair.confirmedAlias).map(pair => ({ fromId: pair.left.id, toId: pair.right.id, confirmed: true }));
    const auditOptions = {
      snapshotVersion: `${fixture.version}:${partition}`,
      aliasVersion: `${fixture.version}:${partition}`,
      topSuspectsPerIdentity: gates.topK,
      maxReportedSuspectPairs: options.maxReportedSuspectPairs === undefined
        ? 10_000
        : positiveInteger(options.maxReportedSuspectPairs, 'maxReportedSuspectPairs'),
    } as const;
    const audit = auditStandardProductDuplicates(products, aliases, auditOptions);
    if (audit.nextCursor !== null) {
      throw new Error(`duplicate audit pagination is incomplete for ${partition}`);
    }
    const exhaustiveLimit = Math.max(1, products.length * Math.max(1, products.length - 1));
    const exhaustiveAudit = auditStandardProductDuplicates(products, aliases, {
      ...auditOptions,
      maxPostingsPerFeature: Math.max(1, products.length),
      maxScannedPerRoutePerIdentity: exhaustiveLimit,
      maxComparedPerIdentity: Math.max(1, products.length - 1),
      topSuspectsPerIdentity: Math.max(1, products.length - 1),
    });
    const candidateKeys = blockingKeys(audit);
    const suspectedKeys = recalledKeys(audit);
    const decisions = pairs.map(pair => {
      const features = extractDuplicateFeatures(pair.left, pair.right, DUPLICATE_LINKAGE_POLICY);
      features.confirmedAlias = pair.confirmedAlias;
      const key = fixturePairKey(pair);
      return { pair, key, decision: classifyDuplicatePair(features, DUPLICATE_LINKAGE_POLICY) };
    });
    const decisionsByKey = new Map(decisions.map(item => [item.key, item]));
    const unlabeledSuspect = audit.suspectedPairs.find(pair => !decisionsByKey.has(pair.pairKey));
    if (unlabeledSuspect) {
      throw new Error(`unlabeled suspected pair ${unlabeledSuspect.ids[0]} ${unlabeledSuspect.ids[1]}`);
    }
    const matches = decisions.filter(item => item.pair.label === 'match');
    const blocked = matches.filter(item => candidateKeys.has(item.key));
    const recalled = matches.filter(item => suspectedKeys.has(item.key));
    const suspects = audit.suspectedPairs.map(pair => decisionsByKey.get(pair.pairKey)!);
    const trueSuspects = suspects.filter(item => item.pair.label === 'match');
    const hardConflicts = decisions.filter(item => item.pair.hardConflictReason !== null);
    const correctHardConflicts = hardConflicts.filter(item => item.decision.conclusion === 'distinct' && item.decision.hardConflicts.includes(item.pair.hardConflictReason!));
    const hardConflictLeaks = hardConflicts.filter(item => suspectedKeys.has(item.key)).length;
    const deterministicKeys = deterministicPairKeys(audit);
    const deterministicFalseMergePairIds = decisions
      .filter(item => item.pair.label === 'non_match' && deterministicKeys.has(item.key))
      .map(item => item.pair.id);
    const blockingRecall = ratio(blocked.length, matches.length);
    const recallAtK = ratio(recalled.length, matches.length);
    const suspectedPairPrecision = ratio(trueSuspects.length, suspects.length);
    const hardConflictAccuracy = ratio(correctHardConflicts.length, hardConflicts.length);
    const routeRemovalMisses = Object.fromEntries(DUPLICATE_BLOCKING_ROUTES.map(route => {
      const withoutRoute = auditStandardProductDuplicates(products, aliases, { ...auditOptions, disabledRoutes: [route] });
      const withoutRouteKeys = recalledKeys(withoutRoute);
      return [route, matches.filter(item => suspectedKeys.has(item.key) && !withoutRouteKeys.has(item.key)).map(item => item.pair.id)];
    })) as Readonly<Record<DuplicateBlockingRoute, readonly string[]>>;
    const exhaustiveKeys = recalledKeys(exhaustiveAudit);
    const budgetTruncationMisses = matches
      .filter(item => exhaustiveKeys.has(item.key) && !suspectedKeys.has(item.key))
      .map(item => item.pair.id);
    const metrics: PartitionMetrics = {
      blockingRecall,
      blockingRecallConfidence95: wilson95(blockingRecall),
      recallAtK,
      recallAtKConfidence95: wilson95(recallAtK),
      suspectedPairPrecision,
      suspectedPairPrecisionConfidence95: wilson95(suspectedPairPrecision),
      hardConflictAccuracy,
      hardConflictAccuracyConfidence95: wilson95(hardConflictAccuracy),
      hardConflictLeaks,
      deterministicFalseMergePairIds,
      expectedManualReviewPairs: audit.suspectedPairs.length,
      candidateCountPerIdentity: ratio(audit.stats.comparedPairs * 2, products.length),
      routeFirstContribution: Object.fromEntries(DUPLICATE_BLOCKING_ROUTES.map(route => [route, audit.stats.routes[route]!.contributedPairs])) as Readonly<Record<DuplicateBlockingRoute, number>>,
      routeRemovalMisses,
      budgetTruncationMisses,
      matchPairs: matches.length,
      nonMatchPairs: decisions.length - matches.length,
    };
    return [partition, { metrics, audit, productCount: products.length }];
  })) as unknown as Readonly<Record<'development' | 'holdout', { metrics: PartitionMetrics; audit: DuplicateAuditResult; productCount: number }>>;
  const metrics = Object.fromEntries((['development', 'holdout'] as const).map(partition => [partition, partitionResults[partition].metrics])) as unknown as DuplicateAuditReport['metrics'];
  const holdout = metrics.holdout;
  const sampleSize = {
    actual: { matchPairs: holdout.matchPairs, nonMatchPairs: holdout.nonMatchPairs },
    required: { matchPairs: gates.minimumHoldoutMatchPairs, nonMatchPairs: gates.minimumHoldoutNonMatchPairs },
    status: holdout.matchPairs >= gates.minimumHoldoutMatchPairs && holdout.nonMatchPairs >= gates.minimumHoldoutNonMatchPairs
      ? 'passed' as const
      : 'insufficient_sample' as const,
  };
  const partitionEvaluation = Object.fromEntries((['development', 'holdout'] as const).map(partition => [partition, {
    blockingRecallAtK: minimumThreshold(metrics[partition].blockingRecall, gates.minimumBlockingRecallAtK),
    suspectRecallAtK: minimumThreshold(metrics[partition].recallAtK, gates.minimumSuspectRecallAtK),
    precisionAtReviewBudget: minimumThreshold(metrics[partition].suspectedPairPrecision, gates.minimumPrecisionAtReviewBudget),
  }])) as unknown as DuplicateAuditReport['gateEvaluation']['partitions'];
  const audits = Object.values(partitionResults);
  const productCount = audits.reduce((sum, result) => sum + result.productCount, 0);
  const suspectedPairCount = audits.reduce((sum, result) => sum + result.audit.suspectedPairs.length, 0);
  const comparedPairs = audits.reduce((sum, result) => sum + result.audit.stats.comparedPairs, 0);
  const reviewPairsPerThousandValue = productCount === 0 ? null : suspectedPairCount / productCount * 1_000;
  const reviewPairsPerThousand = reviewPairsPerThousandValue === null
    ? { actual: null, required: gates.maximumReviewPairsPerThousand, status: 'unknown' as const }
    : maximumThreshold(reviewPairsPerThousandValue, gates.maximumReviewPairsPerThousand);
  const hardConflictLeakCount = metrics.development.hardConflictLeaks + metrics.holdout.hardConflictLeaks;
  const hardConflictLeaks = maximumThreshold(hardConflictLeakCount, gates.maximumHardConflictLeaks);
  const deterministicFalseMergeCount = metrics.development.deterministicFalseMergePairIds.length
    + metrics.holdout.deterministicFalseMergePairIds.length;
  const deterministicFalseMerges = maximumThreshold(deterministicFalseMergeCount, gates.maximumDeterministicFalseMerges);
  const budgetTruncationMissCount = metrics.development.budgetTruncationMisses.length
    + metrics.holdout.budgetTruncationMisses.length;
  const budgetTruncationMisses = maximumThreshold(budgetTruncationMissCount, gates.maximumBudgetTruncationMisses);
  const routes = Object.fromEntries(DUPLICATE_BLOCKING_ROUTES.map(route => [route, {
    scannedPostings: audits.reduce((sum, result) => sum + result.audit.stats.routes[route]!.scannedPostings, 0),
    scanLimit: audits.reduce((sum, result) => sum + result.audit.stats.routes[route]!.scanLimit, 0),
    truncatedFeatures: audits.reduce((sum, result) => sum + result.audit.stats.routes[route]!.truncatedFeatures, 0),
    contributedPairs: audits.reduce((sum, result) => sum + result.audit.stats.routes[route]!.contributedPairs, 0),
  }]));
  const statuses: GateMetricStatus[] = [
    sampleSize.status,
    reviewPairsPerThousand.status,
    hardConflictLeaks.status,
    deterministicFalseMerges.status,
    budgetTruncationMisses.status,
    ...Object.values(partitionEvaluation).flatMap(partition => Object.values(partition).map(metric => metric.status)),
  ];
  return {
    reportVersion: gates.auditReportVersion,
    fixtureVersion: fixture.version,
    policyVersion: DUPLICATE_LINKAGE_POLICY.version,
    qualityGateVersion: gates.version,
    topK: gates.topK,
    readOnly: true,
    metrics,
    gateEvaluation: {
      overallStatus: statuses.every(status => status === 'passed') ? 'passed' : 'blocked',
      sampleSize,
      partitions: partitionEvaluation,
      reviewPairsPerThousand,
      hardConflictLeaks,
      deterministicFalseMerges,
      budgetTruncationMisses,
    },
    deterministicGroupCount: audits.reduce((sum, result) => sum + result.audit.deterministicGroups.filter(group => group.members.length > 1).length, 0),
    deterministicEdgeCount: audits.reduce((sum, result) => sum + result.audit.deterministicGroups.reduce((edgeSum, group) => edgeSum + group.edges.length, 0), 0),
    suspectedPairCount,
    comparedPairs,
    routes,
    candidateCountPerIdentity: ratio(comparedPairs * 2, productCount),
    routeFirstContribution: Object.fromEntries(DUPLICATE_BLOCKING_ROUTES.map(route => [route, audits.reduce((sum, result) => sum + result.audit.stats.routes[route]!.contributedPairs, 0)])),
    note: 'Frozen gates are evaluated independently of calibration. Development and holdout candidate generation is isolated. Fixed labels prove linkage regression metrics only; production model semantic quality remains unknown without real responses.',
  };
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/standard-product-duplicate-audit.ts')) {
  buildDuplicateAuditReport().then(report => console.log(JSON.stringify(report, null, 2))).catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}
