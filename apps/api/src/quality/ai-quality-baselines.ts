import bank from './modeltrace/bank.js';
import { analyzeGlobalOutputs, parseNumbers, type FingerprintOutput } from './modeltrace/fingerprint-core.js';
export { generateChallenges as createFingerprintChallenges } from './modeltrace/challenge-browser.js';

// Pinned community reference labels; neither the label nor a closed-set score proves provenance.
export const BUILTIN_FINGERPRINT_MODELS: readonly string[] = Object.freeze(bank.models.map(model => model.id));
export function supportsBuiltinFingerprint(model: string): boolean {
  return BUILTIN_FINGERPRINT_MODELS.includes(model);
}
export function validFingerprintSample(text: string, expectedCount: number): boolean {
  return text.length <= 16384 && parseNumbers(text).length >= Math.max(80, Math.ceil(expectedCount * 0.55));
}
export function compareBuiltinFingerprint(model: string, outputs: FingerprintOutput[]) {
  if (!supportsBuiltinFingerprint(model) || outputs.length < 1 || outputs.some(output => !validFingerprintSample(output.text, output.expected_count))) throw new Error('Incomplete fingerprint observations');
  const result = analyzeGlobalOutputs(outputs, bank);
  const target = result.results.find(item => item.model === model)!;
  if (result.used_outputs !== outputs.length || !Number.isFinite(target.probability)) throw new Error('Invalid fingerprint analysis');
  return {
    fingerprint: Math.round(100 * target.probability),
    fingerprintMatches: result.prediction === model && target.probability >= 0.8,
    predictedModel: result.prediction,
  };
}
