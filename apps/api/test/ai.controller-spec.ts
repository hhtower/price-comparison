import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { validate } from 'class-validator';
import { AiModule } from '../src/ai/ai.module.js';
import { AiController, CreateJobDto, RetryPoolDto } from '../src/ai/ai.controller.js';
import { AiRepository } from '../src/ai/ai.repository.js';
import { AppModule } from '../src/app.module.js';
import { DatabaseModule } from '../src/database/database.module.js';

test('controller stringifies every bigint in create and state transition responses', async () => {
  const service = { createJob: async () => ({ id: 1n, total: 2n, inputs: [{ productId: 3n }], batches: [{ id: 4n, productIds: [3n] }] }) };
  const repository = {
    pauseJob: async (id: bigint) => ({ id, processed: 2n }),
    resumeJob: async (id: bigint) => ({ id }),
    cancelJob: async (id: bigint) => ({ id }),
    retryJob: async (id: bigint) => ({ id, retried: 1n }),
    reapplySavedResults: async (id: bigint) => ({ id, applied: 2n }),
  };
  const controller = new AiController(service as never, repository as never); const created = await controller.createJob({ model: 'x' }); assert.doesNotThrow(() => JSON.stringify(created));
  assert.deepEqual(await controller.pause('1'), { id: '1', processed: '2' }); assert.deepEqual(await controller.resume('1'), { id: '1' }); assert.deepEqual(await controller.cancel('1'), { id: '1' }); assert.deepEqual(await controller.retry('1'), { id: '1', retried: '1' });
  assert.deepEqual(await controller.reapply('1'), { id: '1', applied: '2' });
});

test('runtime DTO rejects empty models and invalid scope IDs', async () => {
  const create = Object.assign(new CreateJobDto(), { model: '', scopeShopId: '0' });
  assert.ok((await validate(create)).length >= 2);
});

test('job creation rejects caller-controlled prompt versions', async () => {
  const create = Object.assign(new CreateJobDto(), { model: 'mock', promptVersion: 'old-policy' });
  const errors = await validate(create, { whitelist: true, forbidNonWhitelisted: true });
  assert.ok(errors.some(error => error.property === 'promptVersion'));
});

test('pool retry validates billing acknowledgment, request identity and an optional nonempty selection', async () => {
  const requestId = '7310f082-cb6e-4422-8c8d-966788b25905';
  for (const value of [undefined, false, 'true', 1]) {
    assert.ok((await validate(Object.assign(new RetryPoolDto(), { requestId, acknowledgePossibleCharge: value }))).length);
  }
  const body = Object.assign(new RetryPoolDto(), { acknowledgePossibleCharge: true, requestId, productIds: ['3', '4'] });
  assert.equal((await validate(body)).length, 0);
  for (const productIds of [null, [], ['0'], ['3', '3'], ['-1'], ['bad'], Array.from({ length: 501 }, (_, i) => String(i + 1))]) {
    assert.ok((await validate(Object.assign(new RetryPoolDto(), { ...body, productIds }))).length);
  }
  assert.equal((await validate(Object.assign(new RetryPoolDto(), { ...body, productIds: undefined }))).length, 0);
  assert.ok((await validate(Object.assign(new RetryPoolDto(), { ...body, requestId: 'bad' }))).length);
  const calls: unknown[] = [];
  const controller = new AiController({ retryPool: async (input: unknown) => { calls.push(input); return { id: 9n, total: 2n }; } } as never, {} as never);
  await assert.rejects(controller.retryPool({ ...body, acknowledgePossibleCharge: false }), (error: { code?: string }) => error.code === 'AI_RETRY_ACK_REQUIRED');
  assert.equal(calls.length, 0);
  assert.deepEqual(await controller.retryPool(body), { id: '9', total: '2' });
  assert.deepEqual(calls, [{ requestId, productIds: [3n, 4n] }]);
});

test('legacy SQLite AI workflows stay removed and the PostgreSQL AI module remains wired', () => {
  for (const path of ['../src/aiPipeline.js', '../src/semantic.js', '../src/semanticWorkflow.js', '../src/aiCanonicalization.js']) {
    assert.equal(existsSync(new URL(path, import.meta.url)), false, `${path} must stay removed`);
  }
  const appImports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule) as unknown[];
  const aiProviders = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AiModule) as unknown[];
  assert.ok(appImports.includes(DatabaseModule));
  assert.ok(appImports.includes(AiModule));
  assert.ok(aiProviders.includes(AiRepository));
});
