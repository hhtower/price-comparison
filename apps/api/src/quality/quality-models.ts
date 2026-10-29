import { createModelListCall } from '../ai/llm-runtime.js';
import type { QualityModelInput } from './quality-input.js';
import { createQualityFetch } from './quality-network.js';

export type QualityModelLister = (input: QualityModelInput, signal: AbortSignal) => Promise<string[]>;
export function createQualityModelLister(options: { environment?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {}): QualityModelLister {
  const environment = options.environment ?? process.env;
  return async (input, signal) => {
    signal.throwIfAborted();
    const network = await createQualityFetch(undefined, { serverProxyUrl: environment.AI_PROXY_URL, signal, fetchImpl: options.fetchImpl });
    try {
      return await createModelListCall({ AI_BASE_URL: input.endpoint, AI_API_KEY: input.apiKey }, network.fetch)(signal);
    } finally { await network.close(); }
  };
}
