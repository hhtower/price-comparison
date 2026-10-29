import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DomainError } from '../src/common/errors.js';
import { ShopSubmissionsRepository } from '../src/shop-submissions/shop-submissions.repository.js';
import type { ShopsRepository } from '../src/shops/shops.repository.js';

function failingRepository(error: unknown) {
  return new ShopSubmissionsRepository({
    transaction: () => ({ execute: async () => { throw error; } }),
  } as never);
}

const input = { name: 'Submission', platform: '', url: 'https://submission.example/' };
const shops = {} as ShopsRepository;

test('submission lock timeout becomes a structured 503 after the transaction rejects', async () => {
  const repository = failingRepository(Object.assign(new Error('private database diagnostic'), { code: '55P03' }));
  await assert.rejects(repository.create(input, shops), error => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.getStatus(), 503);
    const response = error.getResponse() as { error: { code: string; message: string } };
    assert.equal(response.error.code, 'SHOP_SUBMISSION_BUSY');
    assert.ok(response.error.message);
    assert.ok(!JSON.stringify(response).includes('private database diagnostic'));
    return true;
  });
});

test('submission errors other than 55P03 retain their identity without being classified as busy', async () => {
  for (const error of [
    new Error('lock timeout'),
    Object.assign(new Error('statement cancelled'), { code: '57014' }),
    Object.assign(new Error('deadlock'), { code: '40P01' }),
    Object.assign(new Error('connection lost'), { code: '08006' }),
    null,
  ]) {
    await assert.rejects(failingRepository(error).create(input, shops), actual => actual === error);
  }
});

test('submission unique violations retain the existing duplicate contract', async () => {
  const repository = failingRepository({ code: '23505' });
  await assert.rejects(repository.create(input, shops), { code: 'SHOP_SUBMISSION_EXISTS' });
});
