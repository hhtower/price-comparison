export interface ModelRequestOptions {
  thinking?: 'enabled' | 'disabled';
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export function readModelRequestOptions(environment: NodeJS.ProcessEnv): ModelRequestOptions {
  const thinking = environment.AI_THINKING?.trim().toLowerCase();
  if (thinking && !['auto', 'enabled', 'disabled'].includes(thinking)) throw new Error('AI worker configuration is incomplete');
  const reasoningEffort = environment.AI_REASONING_EFFORT?.trim().toLowerCase();
  if (reasoningEffort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(reasoningEffort)) {
    throw new Error('AI_REASONING_EFFORT must be low, medium, high, xhigh or max');
  }
  return {
    ...(reasoningEffort ? { reasoningEffort: reasoningEffort as ModelRequestOptions['reasoningEffort'] } : {}),
    ...(thinking === 'enabled' || thinking === 'disabled' ? { thinking } : {}),
  };
}

/** Shared by preflight sizing and transport; select options using the frozen job model. */
export function buildModelRequestOptions(model: string, options: ModelRequestOptions, maxOutputTokens?: number) {
  if (maxOutputTokens !== undefined && (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1)) throw new Error('AI output token limit is invalid');
  const gpt = /^gpt-/iu.test(model);
  const glm = /^glm-5\.3(?:-|$)/iu.test(model);
  if (glm && options.reasoningEffort && !['low', 'high', 'max'].includes(options.reasoningEffort)) {
    throw new Error('AI_REASONING_EFFORT for GLM-5.3 must be low, high or max');
  }
  return {
    ...(maxOutputTokens === undefined ? {} : gpt ? { max_completion_tokens: maxOutputTokens } : { max_tokens: maxOutputTokens }),
    // Keep reasoning options off older GPTs and unrelated OpenAI-compatible models.
    ...(/^gpt-6\.1-sol(?:-|$)/iu.test(model) ? { reasoning_effort: options.reasoningEffort ?? 'medium' } : {}),
    // GLM-5.3 requires thinking; low effort avoids its default deep reasoning.
    ...(glm ? { reasoning_effort: options.reasoningEffort ?? 'low', thinking: { type: 'enabled' } }
      : !gpt && options.thinking ? { thinking: { type: options.thinking } } : {}),
  };
}
