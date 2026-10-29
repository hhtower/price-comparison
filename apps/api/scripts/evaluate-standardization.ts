import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDeidentifiedReviewIndex, evaluateEvidenceReview } from '../src/standardization/review-evaluation.js';
import { pipelineVersionSnapshot } from '../src/ai/pipeline-versions.js';
import { createOpenAiModelCall } from '../src/ai/ai.worker.js';
import { evaluateStandardizationFlow } from '../src/standardization/flow-evaluation.js';
import { standardizationFlowCatalog, standardizationFlowControls } from '../test/fixtures/standardization-flow-controls-20261008.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const readJson = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
const writeJson = async (file: string, value: unknown) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8'); };

async function protocolSmoke() {
  let mockRequests = 0;
  const name = 'ChatGPT Plus 1 month';
  const evidence = [{ path: 'name', quote: name }];
  const request = { jobId: 1n, model: 'mock-offline', candidates: [{ id: '1', family: 'openai', product: 'chatgpt', tier: 'plus', aliases: [] }],
    inputs: [{ productId: 1n, fingerprint: 'a'.repeat(64), payload: { id: '1', name }, candidateStandardProductIds: ['1'], previousDecision: { contentVersion: '0', evidence: 'Old plan' } }] };
  let passed = 0;
  for (const [candidateRef, citations, expected] of [
    ['i1c1', evidence, 'classified'], ['i2c1', evidence, 'unclassified'],
    ['i1c1', [{ path: 'historyContext.evidence', quote: 'Old plan' }], 'unclassified'],
  ] as const) {
    const body = JSON.stringify({ items: [{ id: '1', action: 'reuse_candidate', candidateRef, ruleIds: [], evidence: citations, reason: 'Synthetic protocol control' }] });
    const call = createOpenAiModelCall({ getBatchRequest: async () => request } as never,
      { AI_BASE_URL: 'https://offline.invalid/v1', AI_API_KEY: 'mock-only', AI_MODEL: 'mock-offline' }, async (_url, init) => {
        mockRequests++;
        if (JSON.parse(String(init?.body)).stream !== true) throw new Error('Offline probe must use the shared streaming transport');
        return new Response([
          { choices: [{ delta: { content: body.slice(0, 25) } }] },
          { choices: [{ delta: { content: body.slice(25) }, finish_reason: 'stop' }] },
        ].map(chunk => 'data: ' + JSON.stringify(chunk) + '\n\n').join('') + 'data: [DONE]\n\n');
      });
    const response = await call({ id: 1n }, new AbortController().signal);
    if (response.items[0]?.status !== expected) throw new Error('Offline protocol control failed');
    passed++;
  }
  return { mode: 'mock-contract-control', cases: 3, passed, mockRequests, providerRequests: 0, actualUsage: null, modelSemanticQuality: 'unknown' };
}

async function main() {
  const args = process.argv.slice(2);
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!['--review-source', '--write-index', '--report'].includes(args[i]!) || !args[i + 1]) throw new Error('Usage: tsx apps/api/scripts/evaluate-standardization.ts [--review-source DIRECTORY --write-index FILE] [--report FILE]');
    options.set(args[i]!, args[i + 1]!);
  }
  const indexFile = path.resolve(root, options.get('--write-index') ?? 'output/standardization-review-index.json');
  if (options.has('--review-source')) {
    const source = path.resolve(options.get('--review-source')!);
    const groups = await readJson(path.join(source, 'review.json'));
    const decisions = await readJson(path.join(source, 'review-decisions.json'));
    await writeJson(indexFile, buildDeidentifiedReviewIndex(groups, decisions.rows));
  } else if (options.has('--write-index')) throw new Error('--write-index requires --review-source');
  const index = options.has('--review-source') ? await readJson(indexFile) : buildDeidentifiedReviewIndex([], []);
  const splitByCopy = new Map<string, string>();
  for (const group of index.groups) {
    if (splitByCopy.has(group.copyGroup) && splitByCopy.get(group.copyGroup) !== group.split) throw new Error('Review copy group leaked between evaluation splits');
    splitByCopy.set(group.copyGroup, group.split);
  }
  const baseline = await readJson(path.join(root, 'apps/api/test/fixtures/standardization-quality.json'));
  const recorded = await readJson(path.join(root, 'apps/api/test/fixtures/standardization-recorded-responses.json'));
  const controls = await readJson(path.join(root, 'apps/api/test/fixtures/standardization-evidence-controls-20260927.json'));
  const version = 'standardization-offline-regression-20260927-v1';
  const evaluation = evaluateEvidenceReview({ version, samples: [
    ...baseline.samples.map((sample: any) => ({ ...sample, labelState: sample.id === 'missing-evidence' ? 'pending_evidence' : 'decidable' })), ...controls.samples,
  ] }, { ...recorded, version: 'synthetic-and-recorded-controls', fixtureVersion: version, outcomes: [...recorded.outcomes, ...controls.outcomes] });
  const report = {
    version, mode: 'offline-recorded-and-mock-regression', pipeline: pipelineVersionSnapshot('mock-offline'),
    modelSemanticQuality: 'unknown', modelAccuracy: null,
    reviewIndex: { ...index.coverage, copyGroups: splitByCopy.size,
      evidenceGroups: index.groups.reduce((counts: Record<string, number>, group: any) => { counts[group.evidenceStatus] = (counts[group.evidenceStatus] ?? 0) + 1; return counts; }, {}),
      reviewActionCounts: index.reviewActionCounts, externalControlActionCounts: index.externalControlActionCounts,
      modelSemanticQuality: 'unknown', accuracy: null, actualUsage: null, providerRequests: null, latencyP95Ms: null,
      limitation: 'Historical dispositions are not independently verified target labels; no historical model response/usage observations are inferred.' },
    metricRegression: { purpose: 'Recorded and intentionally faulty synthetic outcomes validate metric calculation, not production accuracy.', ...evaluation },
    currentFlowControls: evaluateStandardizationFlow(standardizationFlowControls, standardizationFlowCatalog),
    mockProtocol: await protocolSmoke(),
  };
  if (options.has('--report')) await writeJson(path.resolve(options.get('--report')!), report);
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'Offline evaluation failed'); process.exitCode = 1; });
