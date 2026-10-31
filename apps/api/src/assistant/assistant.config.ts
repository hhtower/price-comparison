export function readAssistantConfig(environment: NodeJS.ProcessEnv = process.env) {
  const enabled = environment.ASSISTANT_ENABLED === 'true';
  const model = environment.ASSISTANT_MODEL?.trim() || null;
  if (enabled && (!model || !environment.AI_BASE_URL?.trim() || !environment.AI_API_KEY?.trim())) {
    throw new Error('ASSISTANT_ENABLED requires ASSISTANT_MODEL, AI_BASE_URL and AI_API_KEY');
  }
  return { enabled, model };
}
