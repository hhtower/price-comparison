import { readFile } from 'node:fs/promises';
import { DUPLICATE_LINKAGE_POLICY, type LinkageBin } from '../src/standardization/duplicate-linkage-policy.js';
import { duplicateFeatureBins, extractDuplicateFeatures, type StandardProductIdentity } from '../src/standardization/duplicate-linkage.js';
import { loadDuplicateQualityGates } from './standard-product-duplicate-audit.js';

interface FixturePair {
  readonly partition: 'development' | 'holdout';
  readonly label: 'match' | 'non_match';
  readonly confirmedAlias: boolean;
  readonly left: StandardProductIdentity;
  readonly right: StandardProductIdentity;
}

const BOOLEAN_BINS: readonly LinkageBin[] = ['yes', 'no'];
const SIMILARITY_BINS: readonly LinkageBin[] = ['high', 'medium', 'low'];
const DEFAULT_FIXTURE_URL = new URL('../test/fixtures/standard-product-duplicate-pairs.json', import.meta.url);
const DEFAULT_QUALITY_GATES_URL = new URL('../test/fixtures/standard-product-duplicate-quality-gates.json', import.meta.url);
const DEFAULT_REPORT_URL = new URL('../test/fixtures/standard-product-duplicate-audit.md', import.meta.url);

export async function calibrateDuplicateLinkage(source: URL = DEFAULT_FIXTURE_URL): Promise<Record<string, Partial<Record<LinkageBin, number>>>> {
  const fixture = JSON.parse(await readFile(source, 'utf8')) as { pairs: FixturePair[] };
  const development = fixture.pairs.filter(pair => pair.partition === 'development');
  if (development.some(pair => pair.partition !== 'development')) throw new Error('holdout data entered calibration');
  const features = development.map(pair => ({ pair, bins: duplicateFeatureBins(extractDuplicateFeatures(pair.left, pair.right, DUPLICATE_LINKAGE_POLICY)) }));
  const featureNames = Object.keys(features[0]?.bins ?? {});
  const result: Record<string, Partial<Record<LinkageBin, number>>> = {};
  for (const feature of featureNames) {
    const bins = feature.endsWith('Exact') ? BOOLEAN_BINS : SIMILARITY_BINS;
    result[feature] = {};
    for (const bin of bins) {
      const matchCount = features.filter(item => item.pair.label === 'match' && item.bins[feature] === bin).length;
      const nonMatchCount = features.filter(item => item.pair.label === 'non_match' && item.bins[feature] === bin).length;
      const matchTotal = features.filter(item => item.pair.label === 'match').length;
      const nonMatchTotal = features.filter(item => item.pair.label === 'non_match').length;
      const matchProbability = (matchCount + 1) / (matchTotal + bins.length);
      const nonMatchProbability = (nonMatchCount + 1) / (nonMatchTotal + bins.length);
      result[feature]![bin] = Number(Math.log(matchProbability / nonMatchProbability).toFixed(6));
    }
  }
  return result;
}

export async function checkDuplicateLinkageCalibration(options: {
  readonly fixtureUrl?: URL;
  readonly qualityGatesUrl?: URL;
  readonly auditReportUrl?: URL;
} = {}): Promise<void> {
  const fixtureUrl = options.fixtureUrl ?? DEFAULT_FIXTURE_URL;
  const qualityGatesUrl = options.qualityGatesUrl ?? DEFAULT_QUALITY_GATES_URL;
  const auditReportUrl = options.auditReportUrl ?? DEFAULT_REPORT_URL;
  const [calibrated, gates, fixtureText, reportText] = await Promise.all([
    calibrateDuplicateLinkage(fixtureUrl),
    loadDuplicateQualityGates(qualityGatesUrl),
    readFile(fixtureUrl, 'utf8'),
    readFile(auditReportUrl, 'utf8'),
  ]);
  for (const [feature, bins] of Object.entries(calibrated)) for (const [bin, expected] of Object.entries(bins)) {
    const actual = DUPLICATE_LINKAGE_POLICY.weights[feature]?.[bin as LinkageBin];
    if (actual !== expected) throw new Error(`linkage policy drift: ${feature}.${bin} expected ${expected}, received ${actual}`);
  }
  const fixture = JSON.parse(fixtureText) as { version?: unknown };
  if (gates.policyVersion !== DUPLICATE_LINKAGE_POLICY.version) {
    throw new Error(`quality gate policy version mismatch: expected ${DUPLICATE_LINKAGE_POLICY.version}, received ${gates.policyVersion}`);
  }
  if (gates.fixtureVersion !== fixture.version) {
    throw new Error(`quality gate fixture version mismatch: expected ${String(fixture.version)}, received ${gates.fixtureVersion}`);
  }
  const reportMetadata = Object.fromEntries(
    [...reportText.matchAll(/^(审计报告版本|审计策略|样本|质量门槛)：`([^`]+)`。?$/gmu)].map(match => [match[1]!, match[2]!]),
  );
  const expectedMetadata: Record<string, string> = {
    审计报告版本: gates.auditReportVersion,
    审计策略: gates.policyVersion,
    样本: gates.fixtureVersion,
    质量门槛: gates.version,
  };
  for (const [name, expected] of Object.entries(expectedMetadata)) {
    if (reportMetadata[name] !== expected) throw new Error(`duplicate audit report ${name} mismatch: expected ${expected}, received ${reportMetadata[name] ?? 'missing'}`);
  }
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/calibrate-standard-product-linkage.ts')) {
  const check = process.argv.includes('--check');
  (check ? checkDuplicateLinkageCalibration() : calibrateDuplicateLinkage().then(value => console.log(JSON.stringify(value, null, 2))))
    .catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}
