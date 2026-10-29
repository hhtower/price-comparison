import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyResponse } from '../src/crawler/response-guard.js';

test('403 and 429 are blocked', () => {
  assert.equal(classifyResponse(403, {}), 'blocked');
  assert.equal(classifyResponse(429, {}), 'blocked');
});

test('5xx is server error unless cf-mitigated challenge', () => {
  assert.equal(classifyResponse(503, {}), 'server_error');
  assert.equal(classifyResponse(502, {}), 'server_error');
  assert.equal(classifyResponse(503, { 'cf-mitigated': 'challenge' }), 'blocked');
  assert.equal(classifyResponse(503, { 'cf-mitigated': 'Challenge' }), 'blocked');
});

test('2xx and other 4xx are ok', () => {
  assert.equal(classifyResponse(200, {}), 'ok');
  assert.equal(classifyResponse(404, {}), 'ok'); // 业务 404 由适配器按需处理
});
