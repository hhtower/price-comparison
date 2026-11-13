import assert from 'node:assert/strict';
import test from 'node:test';
import { ProductsService } from '../src/products/products.service.js';
import type { ProductsRepository } from '../src/products/products.repository.js';

function service() {
  const writes: unknown[] = [];
  const repository = {
    findById: async () => ({ id: 1n }),
    replaceTags: async (_id: bigint, tags: unknown) => { writes.push(tags); return tags; },
  };
  return { writes, api: new ProductsService(repository as unknown as ProductsRepository) };
}

test('product edits accept numeric duration and reject retired or contradictory fields before writing', async () => {
  const { api, writes } = service();
  await api.replaceTags(1n, [{ name: 'duration', value: 30 }]);
  assert.deepEqual(writes, [[{ name: 'duration', value: 30 }]]);
  await assert.rejects(api.replaceTags(1n, [{ name: 'access', value: 'shared' }]));
  await assert.rejects(api.replaceTags(1n, [{ name: 'duration', value: '30' }]));
  await assert.rejects(api.replaceTags(1n, [{ name: 'subscription_override', value: '有' }]));
  await assert.rejects(api.replaceTags(1n, [
    { name: 'sms_verification', value: 'verified' }, { name: 'sms_verification', value: 'unverified' },
  ]));
  assert.equal(writes.length, 1);
});
