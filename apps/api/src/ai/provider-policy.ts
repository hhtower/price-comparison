/** Recognize explicit provider verdicts, never infer policy from an HTTP status alone. */
export function isProviderPolicyRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const nested = Reflect.get(error, 'error');
  const details = [error, nested].filter(value => value && typeof value === 'object');
  const codes = details.flatMap(value => [Reflect.get(value, 'code'), Reflect.get(value, 'type')]);
  if (codes.some(value => typeof value === 'string' && /^(?:content_policy_violation|content_filter|content_filter_error|policy_violation|safety_violation|sensitive_content|sensitive_words)$/iu.test(value))) return true;
  const messages = details.map(value => Reflect.get(value, 'message')).filter((value): value is string => typeof value === 'string');
  return messages.some(message => /(?:content|safety)\s*(?:policy|filter).{0,80}(?:reject|violat|block)|(?:reject|block|violat).{0,80}(?:content|safety)\s*(?:policy|filter)|sensitive\s+(?:words?|content).{0,40}(?:detect|reject|block)|(?:reject|block|contain).{0,40}sensitive\s+(?:words?|content)|(?:包含|含有|检测到|命中).{0,20}敏感(?:词|内容)|(?:内容|安全)政策.{0,20}(?:拒绝|违反|拦截)/iu.test(message));
}

export function providerPolicyRejection(): Error & { retryClass: 'provider_policy_rejection'; retryable: false; requestOutcome: 'confirmed' } {
  return Object.assign(new Error('Provider explicitly rejected the request under its content policy'), {
    retryClass: 'provider_policy_rejection' as const, retryable: false as const, requestOutcome: 'confirmed' as const,
  });
}
