import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ShopSubmissionsService } from '../src/shop-submissions/shop-submissions.service.js';
import { ShopsService } from '../src/shops/shops.service.js';

function harness(match: () => Promise<string>) {
  const writes: any[] = [];
  const row = { id: 1n, name: '速启AI', url: 'https://suqiai.cc/', platform: '', status: 'pending' };
  const shops = { upsert: async (input: any) => { writes.push(input); return { ...input, id: 8n }; }, enqueueRefresh: async () => [] };
  const submissions = { findById: async () => row, review: async () => ({ ...row, status: 'approved' }),
    approve: async (_id: bigint, _reviewer: string, createShop: any) => { const shop = await createShop(row, {}); return { ...row, shop_id: shop.id, status: 'approved' }; } };
  return { service: new ShopSubmissionsService(submissions as any, shops as any, { requireMatch: match } as any), writes };
}

test('approval saves the verified protocol independently of the submitted platform label', async () => {
  const { service, writes } = harness(async () => 'public-products-v1');
  await service.review(1n, 'approve', 'admin');
  assert.equal(writes[0]?.protocol, 'public-products-v1');
  assert.equal(writes[0]?.platform, '');
});

test('unverified approval never creates or enables a shop', async () => {
  const { service, writes } = harness(async () => { throw new Error('unknown protocol'); });
  await assert.rejects(service.review(1n, 'approve', 'admin'), /unknown protocol/);
  assert.deepEqual(writes, []);
});

test('rejecting a submission does not access its network endpoint', async () => {
  let detected = false;
  const { service, writes } = harness(async () => { detected = true; return 'public-products-v1'; });
  await service.review(1n, 'reject', 'admin');
  assert.equal(detected, false); assert.equal(writes.length, 0);
});

test('editing a bound shop verifies a new protocol or changed URL before persisting', async () => {
  const updates: any[] = []; const checks: any[] = [];
  const shops = { findById: async () => ({ id: 1n, url: 'https://suqiai.cc/', protocol: 'public-products-v1' }), update: async (_id: bigint, value: any) => { updates.push(value); return value; } };
  const detector = { requireMatch: async (...args: any[]) => { checks.push(args); return 'public-products-v1'; } };
  const service = new ShopsService(shops as any, detector as any);
  await service.update(1n, { url: 'https://another.example/' });
  assert.deepEqual(checks, [['https://another.example/', 'public-products-v1']]);
  assert.equal(updates[0].protocol, 'public-products-v1');
  await service.update(1n, { name: '新名称' });
  assert.equal(checks.length, 1);
});

test('shop creation normalizes fields and rejects invalid input before probing or writing', async () => {
  const writes: any[] = [], probes: any[] = [];
  const shops = { upsert: async (input: any) => { writes.push(input); return input; } };
  const protocols = { requireMatch: async (...args: any[]) => { probes.push(args); return 'public-products-v1'; } };
  const service = new ShopsService(shops as any, protocols as any);
  const input = { name: ' Shop ', platform: ' Store ', url: 'https://EXAMPLE.COM', protocol: '', enabled: true };
  for (const invalid of [{ name: ' ' }, { platform: ' ' }, { url: 'file:///tmp/shop' }]) {
    await assert.rejects(service.upsert({ ...input, ...invalid }), { code: 'url' in invalid ? 'INVALID_URL' : 'REQUIRED_FIELD' });
  }
  assert.equal(probes.length, 0);
  assert.equal(writes.length, 0);
  await service.upsert(input);
  assert.deepEqual(probes, [[input.url, undefined]]);
  assert.deepEqual(writes, [{ name: 'Shop', platform: 'Store', url: 'https://example.com/', protocol: 'public-products-v1', enabled: true }]);
});
