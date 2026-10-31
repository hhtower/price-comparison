import test from 'node:test';
import assert from 'node:assert/strict';
import { createDevPlan } from '../../../scripts/dev.js';

const configured = {
  AI_STANDARDIZATION_ENABLED: 'true',
  AI_BASE_URL: 'http://127.0.0.1:9999/v1',
  AI_API_KEY: 'local-test-only',
  AI_MODEL: 'mock-model',
};

test('官网正价参考独立于付费模型，配置现有代理即加入开发启动', () => {
  const plan = createDevPlan({ AI_PROXY_URL: 'http://127.0.0.1:7890' });
  assert.deepEqual(plan.commands.map(command => command.name), ['api', 'web', 'official-reference']);
  assert.deepEqual(createDevPlan({ AI_PROXY_URL: 'http://127.0.0.1:7890', OFFICIAL_REFERENCE_ENABLED: 'false' }).commands.map(command => command.name), ['api', 'web']);
});

test('开发启动在 AI 已配置时同时运行页面、API 和任务消费者', () => {
  const plan = createDevPlan(configured);
  assert.deepEqual(plan.commands.map(command => command.name), ['api', 'web', 'ai']);
  assert.equal(plan.commands.find(command => command.name === 'ai')?.command, 'tsx watch apps/api/src/workers/ai.worker.ts');
});

test('开发启动仅在增量开关也开启时运行增量消费者', () => {
  const plan = createDevPlan({ ...configured, AI_INCREMENTAL_STANDARDIZATION_ENABLED: 'true' });
  assert.deepEqual(plan.commands.map(command => command.name), ['api', 'web', 'ai', 'standardization']);
  assert.equal(plan.commands.at(-1)?.command, 'tsx watch apps/api/src/workers/standardization-entrypoint.ts');
});

test('未启用 AI 时仍能开发页面，并明确提示未启动 AI', () => {
  for (const environment of [{}, { ...configured, AI_STANDARDIZATION_ENABLED: 'false', AI_INCREMENTAL_STANDARDIZATION_ENABLED: 'true' }]) {
    const plan = createDevPlan(environment);
    assert.deepEqual(plan.commands.map(command => command.name), ['api', 'web']);
    assert.match(plan.notice, /AI.*未启用/);
  }
});

test('已启用 AI 却缺少模型配置时阻止不完整的开发启动', () => {
  for (const key of ['AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL']) {
    assert.throws(() => createDevPlan({ ...configured, [key]: ' ' }), /AI_BASE_URL、AI_API_KEY 和 AI_MODEL/);
  }
});

test('导购助手可独立于商品标准化启动，默认不运行', () => {
  const plan = createDevPlan({
    AI_BASE_URL: 'http://127.0.0.1:9999/v1', AI_API_KEY: 'local-only',
    ASSISTANT_ENABLED: 'true', ASSISTANT_MODEL: 'mock-assistant',
  });
  assert.deepEqual(plan.commands.map(command => command.name), ['api', 'web', 'assistant']);
  assert.equal(plan.commands.at(-1)?.command, 'tsx watch apps/api/src/workers/assistant.worker.ts');
  assert.match(plan.notice, /导购/u);
  assert.throws(() => createDevPlan({ ASSISTANT_ENABLED: 'true' }), /ASSISTANT_MODEL/u);
});
