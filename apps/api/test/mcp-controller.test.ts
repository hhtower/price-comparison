import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';
import { VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { McpController, AdminMcpController } from '../src/mcp/mcp.controller.js';
import { McpAccess } from '../src/mcp/mcp-access.js';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { AuthService } from '../src/auth/auth.service.js';
import { AccountGuard } from '../src/account/account.guard.js';
import { AccountService } from '../src/account/account.service.js';
import { registerPublicPages } from '../src/seo/public-pages.js';
import { McpCaptcha } from '../src/mcp/mcp-captcha.js';
import { DomainValidationError } from '../src/common/errors.js';

async function harness(t: TestContext) {
  const module = await Test.createTestingModule({
    controllers: [McpController, AdminMcpController],
    providers: [
      AuthGuard,
      { provide: AuthService, useValue: { validate: async (token?: string) => token === 'b'.repeat(43) ? { userId: 'admin' } : null } },
      AccountGuard,
      { provide: AccountService, useValue: {
        validate: async (token?: string) => token === 'a'.repeat(43) ? { id: 'account-a', email: 'owner@example.com' } : null,
      } },
      { provide: McpCaptcha, useValue: {
        create: async () => ({ id: 'a'.repeat(43), image: 'data:image/png;base64,iVBORw0KGgo=', expiresInSeconds: 300 }),
        verify: async (id: string, answer: string) => {
          if (id !== 'a'.repeat(43) || answer !== '12345') throw new DomainValidationError('MCP_CAPTCHA_INVALID', '图形验证码错误或已过期');
        },
      } },
      { provide: McpAccess, useValue: {
        config: () => ({ enabled: true, endpoint: '/api/mcp' }),
        applyForAccount: async (input: unknown, email: string) => {
          assert.deepEqual(input, { name: 'applicant', purpose: 'quotes', expectedUsage: '100/day' });
          assert.equal(email, 'owner@example.com');
          return { ok: true };
        },
        getForAccount: async (email: string) => ({ application: { email, status: 'pending', canClaim: false } }),
        claimForAccount: async (email: string) => {
          assert.equal(email, 'owner@example.com');
          return { apiKey: 'account-secret', endpoint: '/api/mcp', expiresAt: '2027-01-01', requestsPerMinute: 60 };
        },
        verify: async (token: string) => token === 'valid' ? { status: 'pending' } : assert.fail('Unexpected token'),
        claim: async () => ({ apiKey: 'test-secret', endpoint: '/api/mcp', expiresAt: '2027-01-01', requestsPerMinute: 60 }),
        recover: async () => ({ ok: true }), list: () => assert.fail('Unauthenticated admin access'),
        viewKey: async (id: string) => {
          assert.equal(id, 'applicant-id');
          return { apiKey: 'admin-visible-key' };
        },
      } },
    ],
  }).compile();
  const app = module.createNestApplication(new FastifyAdapter({ logger: false }));
  app.enableVersioning({ type: VersioningType.URI });
  await app.init();
  t.after(() => app.close());
  return app.getHttpAdapter().getInstance();
}

test('MCP application HTTP routes validate credential envelopes and disable key response caching', async t => {
  const http = await harness(t);
  assert.equal((await http.inject('/v1/mcp/config')).json().enabled, true);
  const verified = await http.inject({ method: 'POST', url: '/v1/mcp/applications/verify', payload: { token: 'valid' } });
  assert.equal(verified.statusCode, 201);
  assert.deepEqual(verified.json(), { status: 'pending' });
  for (const payload of [{}, { token: 1 }, { token: 'valid', unwanted: true }]) {
    assert.equal((await http.inject({ method: 'POST', url: '/v1/mcp/applications/verify', payload })).statusCode, 400);
  }
  const claimed = await http.inject({ method: 'POST', url: '/v1/mcp/applications/claim', payload: { token: 'valid' } });
  assert.equal(claimed.headers['cache-control'], 'no-store');
  assert.equal(claimed.json().apiKey, 'test-secret');
  assert.equal((await http.inject('/v1/admin/mcp/applications')).statusCode, 401);
  for (const action of ['approve', 'reject', 'reissue', 'resend', 'revoke']) {
    const response = await http.inject({ method: 'POST', url: `/v1/admin/mcp/applications/example/${action}`, payload: {} });
    assert.equal(response.statusCode, 401, action);
  }
});

test('full keys require an administrator session and are never cacheable', async t => {
  const http = await harness(t);
  const url = '/v1/admin/mcp/applications/applicant-id/key';
  for (const cookie of ['', `account_session=${'a'.repeat(43)}`, 'admin_session=invalid']) {
    const response = await http.inject({ url, headers: { cookie } });
    assert.equal(response.statusCode, 401);
    assert.ok(!response.body.includes('admin-visible-key'));
  }
  const response = await http.inject({ url, headers: { cookie: `admin_session=${'b'.repeat(43)}` } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(response.json(), { apiKey: 'admin-visible-key' });
});

test('account application routes require a user session and derive identity from it', async t => {
  const http = await harness(t);
  const challenge = await http.inject('/v1/mcp/captcha');
  assert.equal(challenge.statusCode, 200);
  assert.equal(challenge.headers['cache-control'], 'no-store');
  assert.ok(challenge.json().image.startsWith('data:image/png;base64,'));
  const input = { name: 'applicant', purpose: 'quotes', expectedUsage: '100/day' };
  for (const cookie of ['', `admin_session=${'a'.repeat(43)}`, 'account_session=invalid']) {
    for (const [method, url] of [
      ['GET', '/v1/mcp/application'], ['POST', '/v1/mcp/applications'], ['POST', '/v1/mcp/application/claim'],
    ] as const) {
      const result = await http.inject({ method, url, headers: { cookie }, ...(method === 'POST' ? { payload: input } : {}) });
      assert.equal(result.statusCode, 401, `${method} ${url}`);
    }
  }
  const headers = { cookie: `account_session=${'a'.repeat(43)}` };
  const applied = await http.inject({ method: 'POST', url: '/v1/mcp/applications', payload: input, headers });
  assert.equal(applied.statusCode, 201);
  assert.equal(applied.headers['cache-control'], 'no-store');
  const own = await http.inject({ url: '/v1/mcp/application?email=other@example.com&id=other', headers });
  assert.equal(own.statusCode, 200);
  assert.equal(own.headers['cache-control'], 'no-store');
  assert.equal(own.json().application.email, 'owner@example.com');
  const claimed = await http.inject({ method: 'POST', url: '/v1/mcp/application/claim', headers, payload: { email: 'other@example.com', id: 'other' } });
  assert.equal(claimed.statusCode, 201);
  assert.equal(claimed.headers['cache-control'], 'no-store');
  assert.equal(claimed.json().apiKey, 'account-secret');
  assert.equal((await http.inject({ method: 'POST', url: '/v1/mcp/applications/recover', payload: { email: 'owner@example.com' } })).statusCode, 404);
});

test('MCP application page renders on direct email navigation with no-store and no-referrer', async t => {
  const adapter = new FastifyAdapter();
  const http = adapter.getInstance();
  registerPublicPages(adapter, {
    template: readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8'), siteUrl: 'https://quotes.example',
    getCatalog: async () => ({ items: [], total: 0, platformFacets: [] }),
    getProducts: async () => ({ items: [] }), getProduct: async () => null,
  });
  t.after(() => http.close());
  const page = await http.inject('/mcp');
  assert.equal(page.statusCode, 200);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.match(page.body, /MCP/);
  assert.match(page.body, /提交申请/);
  const trailingSlash = await http.inject('/mcp/');
  assert.equal(trailingSlash.statusCode, 308);
  assert.equal(trailingSlash.headers.location, '/mcp');
});
