import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../../../skills/price-comparison/scripts/query.mjs', import.meta.url));
const key = 'mcp_' + 'a'.repeat(43);

async function fixture(t, respond) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const message = JSON.parse(text);
    requests.push({ message, authorization: request.headers.authorization, path: request.url });
    if (message.method === 'notifications/initialized') { response.writeHead(202).end(); return; }
    response.setHeader('Content-Type', 'application/json');
    if (message.method === 'initialize') {
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'price-comparison', version: '1' },
      } }));
      return;
    }
    respond(message, response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const env = { ...process.env, PRICE_COMPARISON_URL: `http://127.0.0.1:${server.address().port}`,
    PRICE_COMPARISON_API_KEY: key, DSH_SHELL: '' };
  return { requests, env, run: (args, overrides = {}) => exec(process.execPath, [script, ...args],
    { env: { ...env, ...overrides }, timeout: 20000 }) };
}

test('standalone skill initializes and queries with the shared bearer key without MCP configuration', async t => {
  const fixtureState = await fixture(t, (message, response) => response.end(JSON.stringify({
    jsonrpc: '2.0', id: message.id, result: { structuredContent: { items: [{ id: '9007199254740993', name: 'Monthly plan' }], nextCursor: 'next' } },
  })));
  const { stdout, stderr } = await fixtureState.run(['search_products', '{"q":"monthly"}']);
  assert.equal(stderr, '');
  assert.equal(JSON.parse(stdout).items[0].id, '9007199254740993');
  assert.equal(JSON.parse(stdout).nextCursor, 'next');
  assert.deepEqual(fixtureState.requests.map(item => item.message.method), ['initialize', 'notifications/initialized', 'tools/call']);
  assert.ok(fixtureState.requests.every(item => item.authorization === `Bearer ${key}` && item.path === '/api/mcp'));
  assert.deepEqual(fixtureState.requests.at(-1).message.params, { name: 'search_products', arguments: { q: 'monthly' } });
});

test('check verifies server tools without printing the secret', async t => {
  const { run } = await fixture(t, (message, response) => response.end(JSON.stringify({
    jsonrpc: '2.0', id: message.id, result: { tools: [
      { name: 'search_products' }, { name: 'get_product_offers' }, { name: 'get_price_history' },
    ] },
  })));
  const { stdout } = await run(['check']);
  assert.equal(JSON.parse(stdout).ok, true);
  assert.ok(!stdout.includes(key));
});

test('key-only configuration uses the default site, including keys stored in Harness native configuration', async t => {
  const { env, requests } = await fixture(t, (message, response) => response.end(JSON.stringify({
    jsonrpc: '2.0', id: message.id, result: { tools: [
      { name: 'search_products' }, { name: 'get_product_offers' }, { name: 'get_price_history' },
    ] },
  })));
  const home = await mkdtemp(join(tmpdir(), 'price-skill-default-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, '.env'), `PRICE_COMPARISON_API_KEY=${key}\n`);
  // Intercept the default origin so this test never sends a key to a public service.
  const preload = `import assert from 'node:assert/strict';
    const request = globalThis.fetch;
    globalThis.fetch = (url, options) => {
      assert.equal(String(url), 'https://price.yufu.pub/api/mcp');
      return request(${JSON.stringify(env.PRICE_COMPARISON_URL + '/api/mcp')}, options);
    };`;
  for (const overrides of [
    { PRICE_COMPARISON_URL: undefined },
    { PRICE_COMPARISON_URL: '' },
    { PRICE_COMPARISON_URL: '', PRICE_COMPARISON_API_KEY: '', DSH_SHELL: '1', DSH_HOME: home },
  ]) {
    const { stdout, stderr } = await exec(process.execPath, [
      '--import', 'data:text/javascript,' + encodeURIComponent(preload), script, 'check',
    ], { env: { ...env, ...overrides }, timeout: 20000 });
    assert.equal(JSON.parse(stdout).ok, true);
    assert.equal(stderr, '');
  }
  assert.equal(requests.length, 9);
  assert.ok(requests.every(item => item.authorization === `Bearer ${key}`));
});

test('invalid arguments, missing keys and unsafe URLs fail before any network request', async t => {
  const { run, requests } = await fixture(t, () => assert.fail('Unexpected tool request'));
  for (const [args, env] of [
    [['unknown'], {}], [['search_products', '[]'], {}], [['search_products', '{'], {}],
    [['check'], { PRICE_COMPARISON_API_KEY: '' }],
    [['check'], { PRICE_COMPARISON_URL: 'http://remote.example' }],
    [['check'], { PRICE_COMPARISON_URL: 'https://user:password@example.com' }],
    [['check'], { PRICE_COMPARISON_URL: 'https://example.com/?key=secret' }],
  ]) {
    await assert.rejects(run(args, env), error => error.code === 1 && /^price-comparison: /u.test(error.stderr) && !error.stderr.includes(key));
  }
  assert.equal(requests.length, 0);
});

test('redirects are refused and server error details never expose a credential', async t => {
  let status = 302;
  const { run, env } = await fixture(t, (_message, response) => {
    response.statusCode = status;
    response.setHeader('Location', 'https://example.com');
    response.end(key);
  });
  for (const code of [302, 401, 429, 503]) {
    status = code;
    await assert.rejects(run(['check']), error => error.code === 1 && /^price-comparison: /u.test(error.stderr) && !error.stderr.includes(key)
      && !error.stdout.includes(key));
  }
  assert.ok(env.PRICE_COMPARISON_URL.startsWith('http://127.0.0.1:'));
});

test('malformed, oversized and tool-error responses fail without treating them as prices', async t => {
  let reply;
  const { run } = await fixture(t, (_message, response) => response.end(reply));
  for (const body of [
    'not json', 'x'.repeat(300000),
    JSON.stringify({ jsonrpc: '2.0', id: 2, error: { message: key } }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, result: { isError: true, content: [{ type: 'text', text: key }] } }),
    JSON.stringify({ jsonrpc: '2.0', id: 999, result: { structuredContent: { items: [] } } }),
  ]) {
    reply = body;
    await assert.rejects(run(['search_products']), error => error.code === 1 && /^price-comparison: /u.test(error.stderr) && !error.stderr.includes(key));
  }
});

test('DeepSeek reads only service variables from its native home env without a separate skill config', async t => {
  const home = await mkdtemp(join(tmpdir(), 'price-skill-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const { run, env } = await fixture(t, (message, response) => response.end(JSON.stringify({
    jsonrpc: '2.0', id: message.id, result: { tools: [
      { name: 'search_products' }, { name: 'get_product_offers' }, { name: 'get_price_history' },
    ] },
  })));
  await writeFile(join(home, '.env'), `PRICE_COMPARISON_URL="${env.PRICE_COMPARISON_URL}"\nPRICE_COMPARISON_API_KEY=${key}\nUNRELATED_SECRET=keep-private\n`);
  const { stdout } = await run(['check'], { PRICE_COMPARISON_URL: '', PRICE_COMPARISON_API_KEY: '', DSH_SHELL: '1', DSH_HOME: home });
  assert.equal(JSON.parse(stdout).ok, true);
  assert.ok(!stdout.includes('keep-private'));
});

test('an unresponsive service hits the bounded timeout instead of waiting indefinitely', { timeout: 20000 }, async t => {
  const { run } = await fixture(t, () => {});
  await assert.rejects(run(['check']), error => error.code === 1 && error.stderr.includes('timed out'));
});
