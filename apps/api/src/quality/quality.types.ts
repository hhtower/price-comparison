export type QualityKind = 'ai' | 'ip';
export type QualityStatus = 'pass' | 'risk' | 'unrun' | 'unavailable' | 'cancelled';
export type QualityState = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';
export type QualityMode = 'quick' | 'standard' | 'full';
export interface AiQualityInput {
  kind: 'ai'; endpoint: string; apiKey: string; model: string;
  mode: QualityMode; runs: number; items: string[];
}
export interface IpQualityInput { kind: 'ip'; target: string; runs: number; }
export type QualityInput = AiQualityInput | IpQualityInput;
export type QualityAttemptOutcome = 'pass' | 'mismatch' | 'invalid-response' | 'timeout' | 'request-error';
export interface QualityAttempt { run: number; outcome: QualityAttemptOutcome; }
export interface QualityMeasurement { run: number; firstTokenMs: number | null; responseMs: number; tokensPerSecond: number | null; }
export interface QualityEvidence { attempts?: QualityAttempt[]; measurements?: QualityMeasurement[]; }
export interface QualityProgress { itemId: string; stage: 'measurement' | 'baseline' | 'probe'; attempt: number; total: number; startedAt: string; }
export interface QualityConfiguration { runs: number; mode: QualityMode | null; selected: string[]; }
export interface QualityItemResult {
  id: string; status: QualityStatus; score: number | null; summary: string; impact?: string;
  reason?: 'not-selected' | 'unsupported' | 'insufficient-samples'; evidence?: QualityEvidence;
}
export interface QualityCatalogItem {
  id: string; label: string; group: string; required?: boolean; modes?: QualityMode[]; proxyOnly?: boolean;
}
export interface QualitySummary {
  score: number | null; tested: number; risk: number; unrun: number; unavailable: number; cancelled: number; total: number;
  overall: '通过' | '存在风险' | '存在未覆盖风险' | '检测未完成';
}
export interface QualityReport {
  id: string; kind: QualityKind; state: QualityState; target: string; model?: string;
  items: Array<QualityItemResult & Pick<QualityCatalogItem, 'label' | 'group'>>;
  summary: QualitySummary; createdAt: string; completedAt?: string;
  configuration: QualityConfiguration; progress: QualityProgress[];
}
export type QualityDetector<I extends QualityInput> = (
  input: I, itemIds: string[], signal: AbortSignal, onItem: (item: QualityItemResult) => void,
  onProgress?: (progress: QualityProgress) => void,
) => Promise<QualityItemResult[]>;
