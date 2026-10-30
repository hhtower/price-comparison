import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { registerStaticAssets } from '../src/seo/static-assets.js';

async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'price-assets-'));
  await mkdir(join(root, 'assets'));
  await mkdir(join(root, 'assets-sibling'));
  await writeFile(join(root, 'assets', 'index-1234abcd.js'), 'export const ready = true;');
  await writeFile(join(root, 'assets', 'plain.css'), 'body { color: black; }');
  await writeFile(join(root, 'assets-sibling', 'private.js'), 'private');
  const server = new FastifyAdapter().getInstance();
  registerStaticAssets(server, root);
  t.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  return server;
}

test('hashed assets stream with immutable caching while plain assets require revalidation', async t => {
  const server = await setup(t);
  const script = await server.inject('/assets/index-1234abcd.js');
  assert.equal(script.statusCode, 200);
  assert.equal(script.body, 'export const ready = true;');
  assert.match(script.headers['content-type']!, /javascript/);
  assert.equal(script.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.ok(script.headers.etag);
  assert.ok(script.headers['last-modified']);
  const plain = await server.inject('/assets/plain.css');
  assert.equal(plain.statusCode, 200);
  assert.match(plain.headers['content-type']!, /text\/css/);
  assert.equal(plain.headers['cache-control'], 'public, max-age=0, must-revalidate');
});

test('conditional asset requests return no body and honor ETag before modification time', async t => {
  const server = await setup(t);
  const first = await server.inject('/assets/index-1234abcd.js');
  assert.ok(first.headers.etag);
  assert.ok(first.headers['last-modified']);
  for (const headers of [
    { 'if-none-match': first.headers.etag! },
    { 'if-none-match': `"unrelated", ${first.headers.etag}` },
    { 'if-modified-since': first.headers['last-modified']! },
  ]) {
    const response = await server.inject({ url: '/assets/index-1234abcd.js', headers });
    assert.equal(response.statusCode, 304);
    assert.equal(response.body, '');
  }
  const changed = await server.inject({ url: '/assets/index-1234abcd.js', headers: {
    'if-none-match': '"unrelated"', 'if-modified-since': first.headers['last-modified']!,
  } });
  assert.equal(changed.statusCode, 200);
  assert.equal(changed.body, first.body);
});

test('asset paths cannot escape into a sibling directory and missing files stay uncached', async t => {
  const server = await setup(t);
  for (const url of ['/assets/missing.js', '/assets/', '/assets/%2e%2e%2fassets-sibling%2fprivate.js']) {
    const response = await server.inject(url);
    assert.equal(response.statusCode, 404);
    assert.equal(response.headers['cache-control'], undefined);
    assert.ok(!response.body.includes('private'));
  }
});
