import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Test } from '@nestjs/testing';
import { VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { OfficialReferenceController } from '../src/official-reference/official-reference.controller.js';
import { OfficialReferenceService } from '../src/official-reference/official-reference.service.js';

test('public catalog reads stored snapshots and retires visitor-triggered upstream endpoints', async t => {
  let reads = 0;
  const service = new OfficialReferenceService({ readPublished: async () => { reads++; return []; } });
  const module = await Test.createTestingModule({ controllers: [OfficialReferenceController], providers: [{ provide: OfficialReferenceService, useValue: service }] }).compile();
  const app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.enableVersioning({ type: VersioningType.URI }); await app.init(); await app.getHttpAdapter().getInstance().ready();
  t.after(() => app.close()); const http = app.getHttpAdapter().getInstance();
  const response = await http.inject({ method: 'GET', url: '/v1/official-reference/catalog' });
  assert.equal(response.statusCode, 200); assert.equal(response.headers['cache-control'], 'public, max-age=60');
  assert.equal(response.json().apps.length, 8); assert.equal(response.json().updatedAt, null); assert.equal(reads, 1);
  for (const url of ['/v1/official-reference/apps?q=ChatGPT', '/v1/official-reference/prices?appId=6448311069&country=us']) {
    assert.equal((await http.inject({ method: 'GET', url })).statusCode, 404);
  }
  assert.equal(reads, 1);
});
