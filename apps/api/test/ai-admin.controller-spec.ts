import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AiAdminController } from '../src/ai/ai-admin.controller.js';

test('admin AI read endpoints map IDs and pagination', async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const service = {
    adminStatus: async () => ({ job: { id: 8n }, progress: { total: 1n } }),
    adminJobSnapshot: async (id: bigint) => { calls.push({ method: 'detail', args: [id] }); return { job: { id } }; },
    listStandardProductsByCursor: async (...args: unknown[]) => { calls.push({ method: 'groups', args }); return { items: [], nextCursor: null }; },
    listStandardProductItemsByCursor: async (...args: unknown[]) => { calls.push({ method: 'products', args }); return { items: [], nextCursor: null }; },
  };
  const controller = new AiAdminController(service as never);
  assert.deepEqual(await controller.status(), { job: { id: '8' }, progress: { total: '1' } });
  assert.deepEqual(await controller.detail('8'), { job: { id: '8' } });
  await controller.standardProducts('8', '25', 'cursor-1', 'chat', 'true');
  await controller.products('8', 'openai-key', '15', 'cursor-2');
  assert.deepEqual(calls, [
    { method: 'detail', args: [8n] },
    { method: 'groups', args: [{ jobId: 8n, limit: 25, cursor: 'cursor-1', query: 'chat', includeTotal: true }] },
    { method: 'products', args: [{ jobId: 8n, key: 'openai-key', limit: 15, cursor: 'cursor-2' }] },
  ]);
});

test('admin AI endpoints reject malformed identifiers and page values', async () => {
  const controller = new AiAdminController({ listStandardProductItemsByCursor: async () => ({ items: [], nextCursor: null }) } as never);
  await assert.rejects(() => controller.detail('0'), (error: { code?: string }) => error.code === 'INVALID_ID');
  assert.throws(() => controller.standardProducts('1', '0'), (error: { code?: string }) => error.code === 'INVALID_PAGE_SIZE');
  await assert.rejects(() => controller.products('1', 'k', '101'), (error: { code?: string }) => error.code === 'INVALID_PAGE_SIZE');
});

test('global review endpoints accept pagination and standard ID without any task ID', async () => {
  const calls: unknown[] = [];
  const controller = new AiAdminController({
    listGlobalStandardProducts: async (input: unknown) => { calls.push(input); return { items: [] }; },
    listGlobalStandardProductItems: async (input: unknown) => { calls.push(input); return { items: [] }; },
    listGlobalResults: async (input: unknown) => { calls.push(input); return { items: [] }; },
  } as never);
  await controller.globalStandardProducts('25', '10', 'chat', 'true');
  await controller.globalProducts('11', '15', '3');
  await controller.globalResults('50', '9');
  assert.deepEqual(calls, [
    { limit: 25, cursor: '10', query: 'chat', includeTotal: true },
    { standardProductId: 11n, limit: 15, cursor: '3' },
    { limit: 50, cursor: '9' },
  ]);
  assert.throws(() => controller.globalProducts('0'), (error: { code?: string }) => error.code === 'INVALID_ID');
  assert.throws(() => controller.globalStandardProducts('101'), (error: { code?: string }) => error.code === 'INVALID_PAGE_SIZE');
  assert.throws(() => controller.globalResults('0'), (error: { code?: string }) => error.code === 'INVALID_PAGE_SIZE');
});
