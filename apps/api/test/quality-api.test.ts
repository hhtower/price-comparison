import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Test } from '@nestjs/testing';
import { VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { QualityController } from '../src/quality/quality.controller.js';
import { QualityService } from '../src/quality/quality.service.js';

test('model discovery accepts credentials in a POST body and returns only uncached model IDs', async t => {
  const calls: unknown[] = [];
  const service = new QualityService({
    repository: { async save() {}, async read() { return null; } }, aiDetector: async () => [], ipDetector: async () => [],
    modelLister: async (input, signal) => { calls.push(input); assert.ok(signal instanceof AbortSignal); return ['model-a', 'model-b']; },
  });
  const module = await Test.createTestingModule({ controllers: [QualityController], providers: [{ provide: QualityService, useValue: service }] }).compile();
  const app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.enableVersioning({ type: VersioningType.URI }); await app.init(); await app.getHttpAdapter().getInstance().ready();
  t.after(() => app.close());
  const http = app.getHttpAdapter().getInstance();
  const response = await http.inject({ method: 'POST', url: '/v1/quality/models', payload: { endpoint: 'https://relay.example/v1/', apiKey: 'private-key' } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { models: ['model-a', 'model-b'] });
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(calls, [{ endpoint: 'https://relay.example/v1', apiKey: 'private-key' }]);
  for (const payload of [{ endpoint: 'file:///secret', apiKey: 'private-key' }, { endpoint: 'https://relay.example', apiKey: '' }, { endpoint: 'https://relay.example', apiKey: 'private-key', proxy: 'http://private-proxy' }]) {
    const rejected = await http.inject({ method: 'POST', url: '/v1/quality/models', payload });
    assert.equal(rejected.statusCode, 400);
    assert.ok(!rejected.body.includes('private-'));
  }
  assert.equal(calls.length, 1);
});

test('quality HTTP API validates input and protects reports, cancellation, retests and SSE without URL tokens', async t => {
  const records = new Map();
  const service = new QualityService({ repository: { async save(report, accessHash, identityHash) { records.set(report.id, { report, accessHash, identityHash }); }, async read(id) { return records.get(id) ?? null; } }, aiDetector: async () => [], ipDetector: async () => [] });
  const module = await Test.createTestingModule({ controllers: [QualityController], providers: [{ provide: QualityService, useValue: service }] }).compile();
  const app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.enableVersioning({ type: VersioningType.URI }); await app.init(); await app.getHttpAdapter().getInstance().ready();
  t.after(() => app.close());
  const http = app.getHttpAdapter().getInstance();
  const catalogue = await http.inject({ method: 'GET', url: '/v1/quality/catalog' });
  assert.equal(catalogue.statusCode, 200); assert.equal(catalogue.json().ai.length, 17);
  assert.equal(/weight|prompt|threshold|samples/.test(catalogue.body), false);
  const bad = await http.inject({ method: 'POST', url: '/v1/quality/tasks', payload: { kind: 'ip', target: 'socks5://', secret: 'must-not-echo' } });
  assert.equal(bad.statusCode, 400); assert.equal(bad.body.includes('must-not-echo'), false);
  const created = await http.inject({ method: 'POST', url: '/v1/quality/tasks', payload: { kind: 'ip', target: '8.8.8.8' } });
  assert.equal(created.statusCode, 201);
  const { id, accessToken } = created.json(); const url = '/v1/quality/tasks/' + id; const headers = { authorization: 'Bearer ' + accessToken };
  assert.equal((await http.inject({ method: 'GET', url })).statusCode, 404);
  assert.equal((await http.inject({ method: 'GET', url: url + '?accessToken=' + accessToken })).statusCode, 404);
  assert.equal((await http.inject({ method: 'GET', url, headers })).statusCode, 200);
  const cancelled = await http.inject({ method: 'POST', url: url + '/cancel', headers });
  assert.equal(cancelled.statusCode, 200); assert.ok(['completed', 'cancelled'].includes(cancelled.json().state));
  const event = await http.inject({ method: 'GET', url: url + '/events', headers });
  assert.equal(event.statusCode, 200); assert.match(event.headers['content-type'], /text\/event-stream/);
  assert.match(event.body, /data: /); assert.equal(event.body.includes(accessToken), false);
  assert.equal((await http.inject({ method: 'POST', url: url + '/retest', headers, payload: { itemIds: ['ai-access'], input: { kind: 'ip', target: '8.8.8.8' } } })).statusCode, 400);
});
