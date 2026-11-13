import assert from 'node:assert/strict';
import test from 'node:test';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { AiController } from '../src/ai/ai.controller.js';
import { AiAdminController } from '../src/ai/ai-admin.controller.js';
import { AiService } from '../src/ai/ai.service.js';
import { AiRepository } from '../src/ai/ai.repository.js';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { UnauthorizedException, ValidationPipe, VersioningType } from '@nestjs/common';

const routes = [
  { name: 'feature', path: 'feature-jobs', preview: 'previewFeatures', create: 'createFeatures',
    servicePreview: 'previewMembershipFeatureJob', serviceCreate: 'createMembershipFeatureJob' },
  { name: 'text review', path: 'text-review-jobs', preview: 'previewTextReview', create: 'createTextReview',
    servicePreview: 'previewProductTextReviewJob', serviceCreate: 'createProductTextReviewJob' },
] as const;

for (const route of routes) test(`${route.name} creation uses dedicated routes, bounded scope and explicit cost confirmation`, async () => {
  const calls: unknown[] = [];
  const controller = new AiController({
    [route.servicePreview]: async (input: unknown) => { calls.push(input); return { counts: { eligible: 1 } }; },
    [route.serviceCreate]: async (input: unknown) => { calls.push(input); return { id: 12n }; },
  } as never, {} as never);
  assert.ok(Reflect.getMetadata(GUARDS_METADATA, AiController).includes(AuthGuard));
  assert.equal(Reflect.getMetadata(PATH_METADATA, controller[route.preview]), `${route.path}/preview`);
  assert.equal(Reflect.getMetadata(PATH_METADATA, controller[route.create]), route.path);
  const scope = { productIds: ['3'], scopeShopId: '4', retryOfJobId: '2' };
  await controller[route.preview](scope);
  const create = { ...scope, requestId: '7310f082-cb6e-4422-8c8d-966788b25905',
    previewDigest: 'a'.repeat(64), acknowledgePossibleCharge: true };
  await assert.rejects(controller[route.create]({ ...create, acknowledgePossibleCharge: false }), { code: 'AI_RETRY_ACK_REQUIRED' });
  assert.equal(calls.length, 1);
  assert.deepEqual(await controller[route.create](create), { id: '12' });
  assert.deepEqual(calls, [
    { allPending: undefined, productIds: [3n], scopeShopId: 4n, retryOfJobId: 2n },
    { allPending: undefined, productIds: [3n], scopeShopId: 4n, retryOfJobId: 2n, requestId: create.requestId, previewDigest: create.previewDigest },
  ]);
});

test('feature result and audit routes retain authenticated generic auditing and reject invalid pagination', async () => {
  const calls: unknown[] = [];
  const controller = new AiAdminController({
    listTagJobResults: (input: unknown) => { calls.push(input); return { items: [] }; },
    tagProductAudit: (...input: unknown[]) => { calls.push(input); return {}; },
  } as never);
  assert.ok(Reflect.getMetadata(GUARDS_METADATA, AiAdminController).includes(AuthGuard));
  assert.equal(Reflect.getMetadata(PATH_METADATA, controller.featureResults), 'jobs/:id/feature-results');
  assert.equal(Reflect.getMetadata(PATH_METADATA, controller.featureAudit), 'jobs/:id/feature-results/:productId');
  await controller.featureResults('12', '10', 'cursor');
  await controller.featureAudit('12', '3');
  assert.deepEqual(calls, [{ jobId: 12n, limit: 10, cursor: 'cursor' }, [12n, 3n]]);
  assert.throws(() => controller.featureResults('12', '101'), { code: 'INVALID_PAGE_SIZE' });
  assert.throws(() => controller.featureAudit('12', '0'), { code: 'INVALID_ID' });
});

for (const route of routes) test(`${route.name} service uses the configured model even when tag extraction is disabled`, () => {
  const previous = { ...process.env };
  try {
    Object.assign(process.env, { AI_STANDARDIZATION_ENABLED: 'true', AI_TAG_EXTRACTION_ENABLED: 'false',
      AI_API_KEY: 'test', AI_BASE_URL: 'http://localhost:1234/v1', AI_MODEL: 'local-feature-test' });
    const calls: unknown[] = [];
    const service = new AiService({
      [route.servicePreview]: (input: unknown) => calls.push(input),
      [route.serviceCreate]: (input: unknown) => calls.push(input),
    } as never);
    service[route.servicePreview]({ productIds: [3n] });
    service[route.serviceCreate]({ allPending: true, requestId: 'request' });
    assert.deepEqual(calls, [
      { productIds: [3n], model: 'local-feature-test' },
      { allPending: true, requestId: 'request', model: 'local-feature-test' },
    ]);
    process.env.AI_STANDARDIZATION_ENABLED = 'false';
    assert.throws(() => service[route.servicePreview]({ productIds: [3n] }), { code: 'AI_STANDARDIZATION_DISABLED' });
    assert.throws(() => service[route.serviceCreate]({ allPending: true, requestId: 'request' }), { code: 'AI_STANDARDIZATION_DISABLED' });
    process.env.AI_STANDARDIZATION_ENABLED = 'true';
    delete process.env.AI_API_KEY;
    assert.throws(() => service[route.servicePreview]({ productIds: [3n] }), { code: 'AI_CONFIGURATION_INCOMPLETE' });
    assert.throws(() => service[route.serviceCreate]({ allPending: true, requestId: 'request' }), { code: 'AI_CONFIGURATION_INCOMPLETE' });
    assert.equal(calls.length, 2);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

for (const route of routes) test(`${route.name} HTTP endpoints validate scopes and reject model overrides before creating work`, async () => {
  const calls: unknown[] = [];
  const module = await Test.createTestingModule({
    controllers: [AiController, AiAdminController],
    providers: [
      { provide: AiService, useValue: {
        [route.servicePreview]: async (input: unknown) => { calls.push(input); return { counts: { eligible: 1 } }; },
        [route.serviceCreate]: async (input: unknown) => { calls.push(input); return { id: 12n }; },
      } },
      { provide: AiRepository, useValue: {
        listTagJobResults: async () => ({ items: [{ id: '3', classification: { kind: 'account' } }] }),
        tagProductAudit: async () => ({ member: { output: { classification: { kind: 'account' } } } }),
      } },
    ],
  }).overrideGuard(AuthGuard).useValue({ canActivate: (context: { switchToHttp: () => { getRequest: () => { headers: { authorization?: string } } } }) => {
    if (context.switchToHttp().getRequest().headers.authorization !== 'admin') throw new UnauthorizedException();
    return true;
  } }).compile();
  const app = module.createNestApplication(new FastifyAdapter());
  app.enableVersioning({ type: VersioningType.URI });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  try {
    await app.init();
    const server = app.getHttpAdapter().getInstance();
    const valid = { productIds: ['3'], requestId: '7310f082-cb6e-4422-8c8d-966788b25905',
      previewDigest: 'a'.repeat(64), acknowledgePossibleCharge: true };
    const url = `/v1/ai/${route.path}`;
    assert.equal((await server.inject({ method: 'POST', url, payload: valid })).statusCode, 401);
    assert.equal((await server.inject({ method: 'POST', url: `${url}/preview`, payload: { productIds: ['3'] } })).statusCode, 401);
    for (const payload of [
      { productIds: ['0'] }, { productIds: ['3', '3'] }, { productIds: [] },
      { productIds: Array.from({ length: 501 }, (_, index) => String(index + 1)) },
      { productIds: ['3'], model: 'unapproved-model' }, { allPending: false },
      { productIds: ['3'], scopeShopId: '0' }, { productIds: ['3'], retryOfJobId: '0' },
    ]) {
      const response = await server.inject({ method: 'POST', url: `${url}/preview`, headers: { authorization: 'admin' }, payload });
      assert.equal(response.statusCode, 400, response.payload);
    }
    for (const payload of [
      { ...valid, productIds: ['0'] }, { ...valid, productIds: ['3', '3'] },
      { ...valid, model: 'unapproved-model' }, { ...valid, acknowledgePossibleCharge: false },
      { ...valid, acknowledgePossibleCharge: undefined },
      { ...valid, requestId: 'invalid' }, { ...valid, previewDigest: 'invalid' },
    ]) {
      const response = await server.inject({ method: 'POST', url, headers: { authorization: 'admin' }, payload });
      assert.equal(response.statusCode, 400, response.payload);
    }
    assert.equal(calls.length, 0);
    const preview = await server.inject({ method: 'POST', url: `${url}/preview`, headers: { authorization: 'admin' }, payload: { productIds: ['3'] } });
    assert.equal(preview.statusCode, 201);
    assert.deepEqual(preview.json(), { counts: { eligible: 1 } });
    const create = await server.inject({ method: 'POST', url, headers: { authorization: 'admin' }, payload: valid });
    assert.equal(create.statusCode, 201);
    assert.deepEqual(create.json(), { id: '12' });
    assert.deepEqual(calls, [
      { allPending: undefined, productIds: [3n], scopeShopId: undefined, retryOfJobId: undefined },
      { allPending: undefined, productIds: [3n], scopeShopId: undefined, retryOfJobId: undefined, requestId: valid.requestId, previewDigest: valid.previewDigest },
    ]);
    for (const path of route.name === 'feature' ? ['feature-results', 'feature-results/3'] : []) {
      assert.equal((await server.inject({ url: `/v1/admin/ai/jobs/12/${path}` })).statusCode, 401);
      assert.equal((await server.inject({ url: `/v1/admin/ai/jobs/12/${path}`, headers: { authorization: 'admin' } })).statusCode, 200);
    }
  } finally { await app.close(); }
});
