import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ASSISTANT_LIMITS } from '@price-comparison/catalog/assistant-contract';
import { readAssistantConfig } from '../src/assistant/assistant.config.js';
import { readModelRequestOptions, buildModelRequestOptions } from '../src/ai/model-request-options.js';
import { createStreamingCall } from '../src/ai/llm-runtime.js';

test('assistant thinking and timeout are independent of background task settings', () => {
  const config = readAssistantConfig({ ASSISTANT_ENABLED: 'true', ASSISTANT_MODEL: 'gpt-6.1-sol',
    AI_BASE_URL: 'http://mock.invalid/v1', AI_API_KEY: 'mock', AI_MODEL: 'background',
    AI_THINKING: 'disabled', AI_REASONING_EFFORT: 'max', AI_TIMEOUT_MS: '1', AI_MAX_OUTPUT_BYTES: '1' });
  assert.equal(config.model, 'gpt-6.1-sol');
  assert.equal(config.environment.AI_TIMEOUT_MS, String(ASSISTANT_LIMITS.turnDeadlineMs));
  assert.equal(config.environment.AI_MAX_OUTPUT_BYTES, String(ASSISTANT_LIMITS.outputMaxBytes));
  assert.deepEqual(readModelRequestOptions(config.environment), { thinking: 'enabled' });
  const request = buildModelRequestOptions(config.model!, readModelRequestOptions(config.environment), ASSISTANT_LIMITS.outputMaxTokens);
  assert.equal(request.max_completion_tokens, 8192);
  assert.equal(request.reasoning_effort, 'medium');
  assert.equal(buildModelRequestOptions('glm-5.3-flash', readModelRequestOptions(config.environment)).reasoning_effort, 'low');
  const custom = readAssistantConfig({ ASSISTANT_REASONING_EFFORT: 'low', ASSISTANT_THINKING: 'disabled' });
  assert.deepEqual(readModelRequestOptions(custom.environment), { thinking: 'disabled', reasoningEffort: 'low' });
});

test('DeepSeek assistant effort reaches the streaming request independently of background settings', async () => {
  for (const model of ['deepseek-v4-pro', 'deepseek-flash']) {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', undefined]) {
      const config = readAssistantConfig({ ASSISTANT_ENABLED: 'true', ASSISTANT_MODEL: model,
        AI_BASE_URL: 'http://mock.invalid/v1', AI_API_KEY: 'mock', AI_REASONING_EFFORT: 'max',
        ASSISTANT_REASONING_EFFORT: effort });
      let sent: Record<string, unknown> = {};
      const call = createStreamingCall(config.environment, async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return new Response('data: {"choices":[{"delta":{"content":"{}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } });
      });
      await call({ model: config.model!, messages: [], signal: new AbortController().signal, maxOutputTokens: 8192 });
      assert.equal(sent.reasoning_effort, effort);
      assert.equal(sent.stream, true);
      assert.equal(sent.max_tokens, 8192);
      assert.deepEqual(sent.thinking, { type: 'enabled' });
    }
  }
});
