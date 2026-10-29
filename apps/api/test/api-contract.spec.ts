import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '../../..');

function normalizeRoutePath(path: string) {
  return path.split('?', 1)[0].replace(/\/+$/u, '') || '/';
}

function sourceFiles(directory: string, suffix: string): string[] {
  // Keep request modules explicit so generated output is never scanned.
  return ['AdminPage.jsx', 'AiWorkbench.jsx', 'PublicPage.jsx', 'ShopProtocolReview.jsx']
    .map((name) => join(root, directory, name))
    .filter((file) => file.endsWith(suffix));
}

function clientRoutes() {
  const routes: Array<{ method: string; path: string }> = [];
  for (const file of sourceFiles('apps/web/src', '.jsx')) {
    const source = readFileSync(file, 'utf8');
    const expression = /(?:requestJson|fetch)\(\s*(['`"])(\/api\/[^'`"]+)\1/gu;
    for (const match of source.matchAll(expression)) {
      const raw = match[2];
      const after = source.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 240);
      const method = /method\s*:\s*['"](GET|POST|PUT|PATCH|DELETE)['"]/u.exec(after)?.[1] ?? 'GET';
      routes.push({
        method,
        path: normalizeRoutePath(raw.replace(/\$\{([^}]+)\}/gu, (_value, name: string) => ['action', 'endpoint'].includes(name) ? `:${name}` : name.toLowerCase().includes('key') ? ':key' : ':id')),
      });
    }
  }
  return routes;
}

function serverRoutes() {
  const routes = new Set<string>();
  const files = ['apps/api/src/auth/auth.controller.ts', 'apps/api/src/catalog/catalog.controller.ts', 'apps/api/src/admin/admin.controller.ts', 'apps/api/src/admin/crawler-tasks.controller.ts', 'apps/api/src/shops/shops.controller.ts', 'apps/api/src/products/products.controller.ts', 'apps/api/src/product-reports/product-reports.controller.ts', 'apps/api/src/ai/ai.controller.ts', 'apps/api/src/ai/ai-admin.controller.ts', 'apps/api/src/health/health.controller.ts', 'apps/api/src/shop-submissions/shop-submissions.controller.ts'];
  for (const relative of files) {
    const lines = readFileSync(join(root, relative), 'utf8').split(/\r?\n/u);
    let prefix: string | undefined;
    for (const line of lines) {
      const controller = /@Controller\(\{\s*path:\s*'([^']+)'/u.exec(line);
      if (controller) prefix = controller[1];
      const method = /@(Get|Post|Put|Patch|Delete)\((?:'([^']*)')?\)/u.exec(line);
      if (prefix && method) routes.add(`${method[1].toUpperCase()} /v1/${prefix}${method[2] ? `/${method[2]}` : ''}`.replace(/\/{2,}/gu, '/'));
    }
  }
  return routes;
}

test('every production client request maps to an implemented server route', () => {
  const implemented = serverRoutes();
  const missing = clientRoutes()
    .map(({ method, path }) => {
      const normalized = path.replace(/^\/api/u, '/v1');
      if (normalized === '/v1/ai/jobs/:id/:action') {
        return ['pause', 'resume', 'cancel', 'retry'].map((action) => ({ method, path: path.replace(':action', action), key: `${method} /v1/ai/jobs/:id/${action}` }));
      }
      if (normalized === '/v1/admin/shop-submissions/:id/:action') {
        return ['approve', 'reject'].map((action) => ({ method, path: path.replace(':action', action), key: `${method} /v1/admin/shop-submissions/:id/${action}` }));
      }
      if (normalized === '/v1/admin/product-reports/:id/:action') {
        return ['resolve', 'dismiss'].map((action) => ({ method, path: path.replace(':action', action), key: `${method} /v1/admin/product-reports/:id/${action}` }));
      }
      if (normalized === '/v1/admin/products/:endpoint') {
        return ['batch-delete', 'batch-restore'].map((endpoint) => ({ method, path: path.replace(':endpoint', endpoint), key: `${method} /v1/admin/products/${endpoint}` }));
      }
      return [{ method, path, key: `${method} ${normalized}` }];
    })
    .flat()
    .filter(({ key }) => !implemented.has(key));
  assert.deepEqual(missing, [], `未实现的客户端接口:\n${missing.map(({ method, path }) => `${method} ${path}`).join('\n')}`);
});

test('AI workbench routes expose SSE and read-only result lists without review writes', () => {
  const implemented = serverRoutes();
  assert.ok(implemented.has('GET /v1/admin/ai/jobs/:id/events'));
  assert.ok(implemented.has('GET /v1/admin/ai/jobs/:id/standard-products'));
  assert.ok(implemented.has('GET /v1/admin/ai/jobs/:id/standard-products/:key/products'));
  assert.equal([...implemented].some(route => route.includes('/reviews')), false);
});

test('Vite keeps the browser API prefix and rewrites it to URI version 1', () => {
  const vite = readFileSync(join(root, 'apps/web/vite.config.js'), 'utf8');
  assert.match(vite, /['"]\/api['"]\s*:\s*\{/u);
  assert.match(vite, /path\.replace\(\/\^\\\/api/u);
  assert.match(vite, /['"]\/v1['"]\)/u);
});

test('requestJson preserves HTTP status and server error payloads', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: '路由不存在' }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });
  try {
    const { requestJson } = await import('../../web/src/api.js');
    await assert.rejects(requestJson('/api/missing'), (error: unknown) => {
      assert.equal((error as { status: number }).status, 404);
      assert.equal((error as { message: string }).message, '路由不存在');
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

for (const [payload, expected] of [
  [{ error: { code: 'STANDARD_PRODUCT_KEY_CONFLICT', message: '相同身份的标准商品已经存在' } }, '相同身份的标准商品已经存在'],
  [{ error: 'Bad Request', message: ['family 必须填写', 'tier 必须填写'] }, 'family 必须填写；tier 必须填写'],
  [{ error: 'Bad Request', message: '身份无效' }, '身份无效'],
  [{ error: { code: 'UNKNOWN' } }, '请求失败（HTTP 400）'],
  [null, '请求失败（HTTP 400）'],
] as const) {
  test(`requestJson presents readable API errors: ${JSON.stringify(payload)}`, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json(payload, { status: 400 });
    try {
      const { requestJson } = await import('../../web/src/api.js');
      await assert.rejects(requestJson('/api/admin/standard-products/1', { method: 'PATCH', body: '{}' }), (error: unknown) => {
        assert.equal((error as Error).message, expected);
        assert.equal((error as { status: number }).status, 400);
        assert.deepEqual((error as { data: unknown }).data, payload);
        return true;
      });
    } finally { globalThis.fetch = originalFetch; }
  });
}

test('requestJson does not label empty requests as JSON', async () => {
  const originalFetch = globalThis.fetch;
  let received: RequestInit | undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    received = init;
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const { requestJson } = await import('../../web/src/api.js');
    await requestJson('/api/admin/shop-submissions/1/reject', { method: 'POST' });
    assert.equal(received?.body, undefined);
    assert.equal((received?.headers as Record<string, string>)['content-type'], undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
