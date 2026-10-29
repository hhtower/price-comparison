import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool, ChatCompletionToolChoiceOption } from 'openai/resources/chat/completions';
import { ProxyAgent } from 'undici';
import { normalizeModelIds } from './model-list.js';
import { providerPolicyRejection } from './provider-policy.js';
import { buildModelRequestOptions, readModelRequestOptions } from './model-request-options.js';
export { readAiConcurrency } from './ai-concurrency.js';

export interface StreamingToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface StreamingUsage { promptTokens: number; completionTokens: number; totalTokens: number; reasoningTokens?: number }
export interface StreamingResult {
  content: string; finishReason: string | null; firstContentMs: number | null; responseMs: number;
  toolCalls: StreamingToolCall[]; usage: StreamingUsage | null; responseModel: string | null;
  responseModels: string[]; responseId: string | null; chunkCount: number; contentChunks: number;
}
export interface StreamingInput {
  model: string; messages: ChatCompletionMessageParam[]; signal: AbortSignal;
  responseFormat?: Record<string, unknown>; tools?: ChatCompletionTool[];
  toolChoice?: ChatCompletionToolChoiceOption; includeUsage?: boolean; temperature?: number;
  maxOutputTokens?: number;
  context?: Record<string, unknown>;
}
export type StreamingCall = (input: StreamingInput) => Promise<StreamingResult>;

function createRuntimeClient(environment: NodeJS.ProcessEnv, fetchImpl: typeof fetch, timeout: number): OpenAI {
  const baseURL = environment.AI_BASE_URL?.trim(); const apiKey = environment.AI_API_KEY?.trim();
  if (!baseURL || !apiKey || !Number.isSafeInteger(timeout) || timeout < 1) throw new Error('AI worker configuration is incomplete');
  try { if (!['http:', 'https:'].includes(new URL(baseURL).protocol)) throw new Error(); } catch { throw new Error('AI worker configuration is incomplete'); }
  let dispatcher: ProxyAgent | undefined;
  if (environment.AI_PROXY_URL?.trim()) { try { dispatcher = new ProxyAgent(environment.AI_PROXY_URL.trim()); } catch { throw new Error('AI worker configuration is incomplete'); } }
  return new OpenAI({ apiKey, baseURL, timeout, maxRetries: 0, fetch: fetchImpl, ...(dispatcher ? { fetchOptions: { dispatcher } } : {}) });
}

/** Metadata GET only: no generation, stream parameter, pagination or automatic retry. */
export function createModelListCall(environment: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): (signal: AbortSignal) => Promise<string[]> {
  const timeout = Number(environment.AI_TIMEOUT_MS ?? 10_000);
  const maxBytes = Number(environment.AI_MAX_OUTPUT_BYTES ?? 262_144);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('AI model list configuration is invalid');
  const client = createRuntimeClient(environment, async (...args) => {
    const response = await fetchImpl(...args);
    // The SDK otherwise buffers arbitrary error bodies before asResponse() resolves.
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new Error('AI model list request failed');
    }
    return response;
  }, timeout);
  return async signal => {
    signal.throwIfAborted();
    const deadline = new AbortController();
    const combined = AbortSignal.any([signal, deadline.signal]);
    const timer = setTimeout(() => deadline.abort(new Error('AI model list timed out')), timeout);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancel = () => { void reader?.cancel().catch(() => {}); };
    combined.addEventListener('abort', cancel, { once: true });
    try {
      const response = await client.models.list({ signal: combined }).asResponse();
      combined.throwIfAborted();
      reader = response.body?.getReader();
      if (!reader) throw new Error('AI model list is empty');
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let bytes = 0, body = '';
      while (true) {
        combined.throwIfAborted();
        const chunk = await reader.read();
        combined.throwIfAborted();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) throw new Error('AI model list exceeds byte limit');
        body += decoder.decode(chunk.value, { stream: true });
      }
      body += decoder.decode();
      const parsed: unknown = JSON.parse(body);
      const data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as { data?: unknown }).data : undefined;
      if (!Array.isArray(data)) throw new Error('AI model list is invalid');
      return normalizeModelIds(data.map(item => item && typeof item === 'object' && !Array.isArray(item) ? item.id : undefined));
    } catch {
      if (combined.aborted) throw combined.reason;
      throw new Error('AI model list is unavailable or invalid');
    } finally {
      clearTimeout(timer); combined.removeEventListener('abort', cancel);
      if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
  };
}

/** The single streaming transport for workers and quality probes. It never retries. */
export function createStreamingCall(environment: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch, logger?: { log?: (...args: unknown[]) => void }): StreamingCall {
  const timeout = Number(environment.AI_TIMEOUT_MS ?? 30_000);
  const maxOutputBytes = Number(environment.AI_MAX_OUTPUT_BYTES ?? 1_048_576);
  const modelOptions = readModelRequestOptions(environment);
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) throw new Error('AI worker configuration is incomplete');
  const client = createRuntimeClient(environment, fetchImpl, timeout);
  return async ({ model, messages, responseFormat, signal, context, tools, toolChoice, includeUsage, temperature, maxOutputTokens }) => {
    const startedAt = performance.now();
    const deadline = new AbortController();
    const combined = AbortSignal.any([signal, deadline.signal]);
    const timer = setTimeout(() => deadline.abort(new Error(`AI response timed out after ${timeout}ms`)), timeout);
    const parts: string[] = []; let outputBytes = 0; let firstContentMs: number | null = null; let finishReason: string | null = null;
    const calls = new Map<number, StreamingToolCall>();
    const responseModels = new Set<string>();
    let responseId: string | null = null; let chunkCount = 0; let contentChunks = 0; let usage: StreamingUsage | null = null;
    let validationFailure: string | undefined; let invalidUsage = false; let failureReason = 'transport_error';
    const invalidStream = (message: string) => { failureReason = 'validation_error'; return new Error(message); };
    // Confirm validation only after clean completion; transport failures remain unknown.
    const invalidResponse = (message: string) => Object.assign(invalidStream(message), finishReason === null ? {} : {
      retryClass: 'invalid_response' as const, retryable: false as const, requestOutcome: 'confirmed' as const,
    });
    try {
      signal.throwIfAborted();
      failureReason = 'validation_error';
      const requestOptions = buildModelRequestOptions(model, modelOptions, maxOutputTokens);
      failureReason = 'transport_error';
      const stream = await client.chat.completions.create({ model, stream: true, messages,
        ...(responseFormat ? { response_format: responseFormat as never } : {}),
        ...(tools ? { tools } : {}), ...(toolChoice ? { tool_choice: toolChoice } : {}),
        ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
        ...(temperature !== undefined ? { temperature } : {}), ...requestOptions }, { signal: combined });
      const trackOutput = (text: string) => {
        outputBytes += Buffer.byteLength(text, 'utf8');
        if (outputBytes > maxOutputBytes) {
          stream.controller.abort();
          throw invalidStream(`AI output exceeds ${maxOutputBytes} bytes limit`);
        }
      };
      for await (const chunk of stream) {
        combined.throwIfAborted();
        chunkCount++;
        if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) throw invalidStream('AI response has invalid chunk');
        if (typeof chunk.model === 'string' && chunk.model.length <= 256) {
          if (responseModels.size && !responseModels.has(chunk.model)) throw invalidStream('AI response model identity changed during streaming');
          responseModels.add(chunk.model);
        }
        if (typeof chunk.id === 'string' && chunk.id.length <= 256) {
          if (responseId !== null && responseId !== chunk.id) throw invalidStream('AI response message identity changed during streaming');
          responseId ??= chunk.id;
        }
        if (!Array.isArray(chunk.choices)) throw invalidStream('AI response has invalid choices');
        const choice = chunk.choices[0];
        if (choice?.finish_reason === 'content_filter' || (typeof choice?.delta?.refusal === 'string' && choice.delta.refusal.trim())) {
          finishReason = choice.finish_reason ?? finishReason;
          stream.controller.abort();
          failureReason = 'provider_error';
          throw providerPolicyRejection();
        }
        if (choice && finishReason !== null) throw invalidStream('AI response contains choices after completion');
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (chunk.usage) {
          const current = chunk.usage;
          if (![current.prompt_tokens, current.completion_tokens, current.total_tokens].every(value => Number.isSafeInteger(value) && value >= 0) || current.total_tokens !== current.prompt_tokens + current.completion_tokens) invalidUsage = true;
          const reasoning = current.completion_tokens_details?.reasoning_tokens;
          if (reasoning != null && (!Number.isSafeInteger(reasoning) || reasoning < 0 || reasoning > current.completion_tokens)) invalidUsage = true;
          if (invalidUsage) validationFailure ??= 'AI response has invalid token usage';
          if (!invalidUsage) usage = { promptTokens: current.prompt_tokens, completionTokens: current.completion_tokens, totalTokens: current.total_tokens, ...(reasoning != null ? { reasoningTokens: reasoning } : {}) };
        }
        const toolDeltas = choice?.delta?.tool_calls ?? [];
        if (!Array.isArray(toolDeltas)) throw invalidStream('AI response has invalid tool calls');
        const delta = choice?.delta?.content ?? '';
        if (typeof delta !== 'string') validationFailure ??= 'AI response has invalid content';
        if (!validationFailure && (delta || toolDeltas.length) && firstContentMs === null) { firstContentMs = Math.round(performance.now() - startedAt); logger?.log?.('ai.first_content', { ...context, firstContentMs }); }
        if (typeof delta === 'string' && delta) {
          trackOutput(delta);
          if (!validationFailure) {
            parts.push(delta);
            contentChunks++;
          }
        }
        for (const tool of toolDeltas) {
          if (!tool || typeof tool !== 'object' || Array.isArray(tool)) throw invalidStream('AI response has invalid tool entry');
          if (!Number.isSafeInteger(tool.index) || tool.index < 0 || tool.index > 127) throw invalidStream('AI response has invalid tool index');
          const current = calls.get(tool.index) ?? { id: '', type: 'function' as const, function: { name: '', arguments: '' } };
          if (tool.type && tool.type !== 'function') throw invalidStream('AI response has invalid tool type');
          for (const value of [tool.id, tool.function?.name, tool.function?.arguments]) if (value !== undefined) {
            if (typeof value !== 'string') throw invalidStream('AI response has invalid tool fragment');
            trackOutput(value);
          }
          if (validationFailure) continue;
          if (tool.id) current.id += tool.id;
          if (tool.function?.name) current.function.name += tool.function.name;
          if (tool.function?.arguments) current.function.arguments += tool.function.arguments;
          calls.set(tool.index, current);
        }
      }
      combined.throwIfAborted();
      if (finishReason === null) { failureReason = 'missing_finish_reason'; throw new Error('AI response incomplete: missing finish reason'); }
      if (finishReason !== 'stop' && finishReason !== 'tool_calls') throw invalidResponse(`AI response incomplete: ${finishReason ?? 'missing finish reason'}`);
      if (validationFailure) throw invalidResponse(validationFailure);
      const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, value]) => value);
      if (finishReason === 'tool_calls' && !toolCalls.length) throw invalidResponse('AI response has no completed tool calls');
      if (toolCalls.length && finishReason !== 'tool_calls') throw invalidResponse('AI tool response has an invalid finish reason');
      for (const tool of toolCalls) {
        if (!tool.id || !tool.function.name) throw invalidResponse('AI response has incomplete tool metadata');
        let args: unknown;
        try { args = JSON.parse(tool.function.arguments); } catch { throw invalidResponse('AI response has invalid tool JSON arguments'); }
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw invalidResponse('AI response has invalid tool JSON arguments');
      }
      const responseMs = Math.round(performance.now() - startedAt);
      const content = parts.join('');
      logger?.log?.('ai.response_completed', { ...context, firstContentMs, responseMs, outputChars: content.length });
      return { content, finishReason, firstContentMs, responseMs, toolCalls, usage, responseModel: [...responseModels][0] ?? null, responseModels: [...responseModels], responseId, chunkCount, contentChunks };
    } catch (error) {
      const failure = combined.aborted ? combined.reason : error;
      try {
        const jobContext: Record<string, string | number> = {};
        for (const key of ['jobId', 'parentJobId', 'batchId']) {
          const value = context?.[key];
          if (typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))) jobContext[key] = value;
        }
        logger?.log?.('ai.response_failed', {
          ...jobContext, model, responseModel: [...responseModels][0] ?? null, responseId,
          responseMs: Math.round(performance.now() - startedAt), firstContentMs, chunkCount, contentChunks,
          outputBytes, finishReason: ['stop', 'length', 'tool_calls', 'content_filter', 'function_call'].includes(finishReason ?? '') ? finishReason : null,
          usage: invalidUsage ? null : usage,
          failureReason: combined.aborted ? (signal.aborted ? 'cancelled' : 'timeout')
            : failureReason === 'transport_error' && error instanceof OpenAI.APIError && !(error instanceof OpenAI.APIConnectionError)
              ? (Number.isInteger(error.status) ? 'http_error' : 'provider_error') : failureReason,
        });
      } catch { /* Diagnostics must not replace the request failure. */ }
      throw failure;
    }
    finally { clearTimeout(timer); }
  };
}
