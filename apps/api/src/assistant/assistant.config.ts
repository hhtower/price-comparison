import { ASSISTANT_LIMITS } from '@price-comparison/catalog/assistant-contract';

export function readAssistantConfig(environment: NodeJS.ProcessEnv = process.env) {
  const enabled = environment.ASSISTANT_ENABLED === 'true';
  const model = environment.ASSISTANT_MODEL?.trim() || null;
  if (enabled && (!model || !environment.AI_BASE_URL?.trim() || !environment.AI_API_KEY?.trim())) {
    throw new Error('ASSISTANT_ENABLED requires ASSISTANT_MODEL, AI_BASE_URL and AI_API_KEY');
  }
  return { enabled, model, environment: {
    AI_BASE_URL: environment.AI_BASE_URL, AI_API_KEY: environment.AI_API_KEY, AI_PROXY_URL: environment.AI_PROXY_URL,
    AI_THINKING: environment.ASSISTANT_THINKING?.trim() || 'enabled',
    AI_REASONING_EFFORT: environment.ASSISTANT_REASONING_EFFORT?.trim() || undefined,
    AI_TIMEOUT_MS: String(ASSISTANT_LIMITS.turnDeadlineMs), AI_MAX_OUTPUT_BYTES: String(ASSISTANT_LIMITS.outputMaxBytes),
  } };
}
