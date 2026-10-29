export interface TagFacts { id: string; tags: Array<{ name: string; value: string }> }
interface Counts { expected: number; predicted: number; tp: number; fp: number; fn: number; precision: number | null; recall: number | null }
const counts = (expected: Set<string>, predicted: Set<string>): Counts => {
  const tp = [...expected].filter(fact => predicted.has(fact)).length;
  return { expected: expected.size, predicted: predicted.size, tp, fp: predicted.size - tp, fn: expected.size - tp,
    precision: predicted.size ? tp / predicted.size : null, recall: expected.size ? tp / expected.size : null };
};
/** Exact canonical facts; missing responses remain false negatives, never disappear from the denominator. */
export function evaluateTagFacts(expected: TagFacts[], actual: TagFacts[]) {
  const index = (rows: TagFacts[]) => {
    const ids = new Set<string>(), facts = new Set<string>();
    for (const row of rows) {
      if (ids.has(row.id)) throw new Error('Duplicate evaluation product ID');
      ids.add(row.id);
      for (const tag of row.tags) facts.add(JSON.stringify([row.id, tag.name, tag.value]));
    }
    return { ids, facts };
  };
  const gold = index(expected), observed = index(actual);
  const names = new Set([...gold.facts, ...observed.facts].map(fact => JSON.parse(fact)[1] as string));
  const fieldFacts = (facts: Set<string>, name: string) => new Set([...facts].filter(fact => JSON.parse(fact)[1] === name));
  const fact = (encoded: string) => { const [id, name, value] = JSON.parse(encoded) as [string, string, string]; return { id, name, value }; };
  return { total: counts(gold.facts, observed.facts),
    falsePositives: [...observed.facts].filter(value => !gold.facts.has(value)).map(fact),
    falseNegatives: [...gold.facts].filter(value => !observed.facts.has(value)).map(fact),
    missingIds: [...gold.ids].filter(id => !observed.ids.has(id)), unexpectedIds: [...observed.ids].filter(id => !gold.ids.has(id)),
    fields: Object.fromEntries([...names].sort().map(name => [name, counts(fieldFacts(gold.facts, name), fieldFacts(observed.facts, name))])) };
}
export type TagQualityReport = ReturnType<typeof evaluateTagFacts>;
// Frozen before any candidate generation; exact gates also apply per supported field.
export const TAG_RELEASE_GATES = Object.freeze({ version: 'tag-gates-20261015-v1', precision: 0.98, recall: 0.90 });
export function passesTagReleaseGate(candidate: TagQualityReport, baseline: TagQualityReport | null): boolean {
  if (!baseline || candidate.missingIds.length || candidate.unexpectedIds.length
    || baseline.missingIds.length || baseline.unexpectedIds.length) return false;
  const acceptable = (next: Counts, previous: Counts) => next.expected === previous.expected
    && (next.precision ?? 1) >= TAG_RELEASE_GATES.precision && (next.recall ?? 1) >= TAG_RELEASE_GATES.recall
    && (next.precision ?? 1) >= (previous.precision ?? 1) && (next.recall ?? 1) >= (previous.recall ?? 1);
  const empty = counts(new Set(), new Set());
  const names = new Set([...Object.keys(baseline.fields), ...Object.keys(candidate.fields)]);
  return acceptable(candidate.total, baseline.total)
    && [...names].every(name => acceptable(candidate.fields[name] ?? empty, baseline.fields[name] ?? empty));
}

export interface TagEvaluationRun {
  manifest: Readonly<{ kind: 'real-model'; provider: string; requestedModel: string; responseModel: string;
    promptVersion: string; promptSha256: string; protocolVersion: string; rulesSha256: string;
    fixtureVersion: string; fixtureSha256: string; split: 'tune' | 'holdout'; capturedAt: string }>;
  responses: TagFacts[];
}
/** Accept separately saved observations; this evaluator never calls a model. */
export function compareTagEvaluationRuns(expected: TagFacts[], baseline: TagEvaluationRun | null, candidate: TagEvaluationRun | null) {
  if (!baseline || !candidate) return { passed: false, baseline: null, candidate: null };
  for (const run of [baseline, candidate]) {
    if (run.manifest.kind !== 'real-model' || Object.values(run.manifest).some(value => !value.trim())
      || !['promptSha256', 'rulesSha256', 'fixtureSha256'].every(key => /^[a-f0-9]{64}$/u.test(run.manifest[key as 'promptSha256']))) {
      throw new Error('Incomplete real-model evaluation manifest');
    }
  }
  for (const key of ['provider', 'requestedModel', 'responseModel', 'protocolVersion', 'rulesSha256', 'fixtureVersion', 'fixtureSha256', 'split'] as const) {
    if (baseline.manifest[key] !== candidate.manifest[key]) throw new Error('Evaluation runs are not comparable');
  }
  const before = evaluateTagFacts(expected, baseline.responses), after = evaluateTagFacts(expected, candidate.responses);
  return { baseline: before, candidate: after, passed: candidate.manifest.split === 'holdout' && passesTagReleaseGate(after, before) };
}
