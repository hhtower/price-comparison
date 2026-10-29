import { isProviderPolicyRejection } from './provider-policy.js';

export interface ProviderFailureClassification {
  readonly retryClass: 'provider_policy_rejection' | 'provider_transient' | 'provider_terminal' | 'provider_unknown' | 'invalid_response';
  readonly retryable: boolean;
  readonly requestOutcome: 'confirmed' | 'unknown';
}

/** Retry eligibility is separate from reservation: shared budgets still authorize every send. */
export function classifyProviderRequestFailure(error: unknown): ProviderFailureClassification {
  if (error && typeof error === 'object' && Reflect.get(error, 'retryClass') === 'invalid_response' && Reflect.get(error, 'retryable') === false && Reflect.get(error, 'requestOutcome') === 'confirmed') {
    return { retryClass: 'invalid_response', retryable: false, requestOutcome: 'confirmed' };
  }
  if (isProviderPolicyRejection(error)) return { retryClass: 'provider_policy_rejection', retryable: false, requestOutcome: 'confirmed' };
  const status = error && typeof error === 'object' ? Reflect.get(error, 'status') : undefined;
  if (typeof status === 'number' && Number.isInteger(status)) {
    const rejectedFormat = error instanceof Error && /response[ _-]?format/u.test(error.message) && /unavailable/u.test(error.message);
    const retryable = status === 429 || status >= 500 || rejectedFormat;
    return { retryClass: retryable ? 'provider_transient' : 'provider_terminal', retryable, requestOutcome: 'confirmed' };
  }
  return { retryClass: 'provider_unknown', retryable: false, requestOutcome: 'unknown' };
}
