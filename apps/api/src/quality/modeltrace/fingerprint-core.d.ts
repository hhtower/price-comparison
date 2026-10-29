export interface FingerprintModel { id: string; display_name: string; family: string; family_name: string; counts: number[]; }
export interface FingerprintArtifact { feature_mean: number[]; feature_scale: number[]; nuisance_basis: number[][]; centroids: number[][]; }
export interface FingerprintBank {
  models: FingerprintModel[];
  robust: { hellinger: FingerprintArtifact; ordered_blocks: FingerprintArtifact & { weight: number; environment_centroids: number[][][] } };
  calibration: Record<string, { beta: number; cv_accuracy: number }>;
}
export interface FingerprintOutput { text: string; expected_count: number; }
export interface FingerprintResult { model: string; display_name: string; probability: number; profile_similarity: number; score: number; }
export function parseNumbers(text: string): number[];
export function countNumbers(numbers: number[]): number[];
export function analyzeGlobalOutputs(outputs: FingerprintOutput[], bank: FingerprintBank): {
  prediction: string; probability: number; used_outputs: number; results: FingerprintResult[];
  diagnostics: Array<{ index: number; parsed_numbers: number; minimum_numbers: number; accepted: boolean }>;
};
