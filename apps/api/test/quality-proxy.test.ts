import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { test, type TestContext } from 'node:test';
import { createAiQualityDetector } from '../src/quality/ai-quality-detector.js';
import { createIpQualityDetector } from '../src/quality/ip-quality-detector.js';
import { parseIpTarget } from '../src/quality/quality-input.js';
import { createQualityFetch } from '../src/quality/quality-network.js';
import { createQualityModelLister } from '../src/quality/quality-models.js';
import type { AiQualityInput } from '../src/quality/quality.types.js';

// The local CONNECT proxy terminates tunnels itself; no upstream or paid API is used.
async function localProxy(t: TestContext, respond: (request: IncomingMessage, response: ServerResponse) => void, status = 200, options: { secureTarget?: boolean; secureProxy?: boolean; trustCertificate?: boolean; socks?: boolean; rejectSocks?: boolean; stallSocks?: () => void; stallConnect?: () => void; onDisconnect?: () => void } = {}) {
  const tunnels: IncomingMessage[] = [];
  const socksRequests: Array<{ address: string; port: number; username: string; password: string }> = [];
  const sockets = new Set<net.Socket>();
  const unexpectedConnections: Array<{ host?: string; port?: number }> = [];
  const proxyHost = options.secureProxy ? 'localhost' : '127.0.0.1';
  // This committed key/certificate is only for the local test fixture, never for deployment.
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/quality-proxy-tls.json', import.meta.url), 'utf8'));
  const origin = options.secureTarget ? createHttpsServer(fixture, respond) : createServer(respond);
  const proxy = options.secureProxy ? createHttpsServer(fixture) : createServer();
  if ((options.secureTarget || options.secureProxy) && options.trustCertificate !== false) {
    const previous = tls.getCACertificates();
    tls.setDefaultCACertificates([...previous, fixture.cert]);
    t.after(() => tls.setDefaultCACertificates(previous));
  }
  proxy.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => { sockets.delete(socket); options.onDisconnect?.(); }); });
  proxy.on('connect', (request, socket, head) => {
    tunnels.push(request);
    // CONNECT detaches the HTTP parser; the fixture must finish its half of a FIN.
    socket.on('end', () => socket.end());
    if (options.stallConnect) { socket.resume(); options.stallConnect(); return; }
    if (status !== 200) { socket.end('HTTP/1.1 ' + status + ' Rejected\r\nContent-Length: 0\r\n\r\n'); return; }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) socket.unshift(head);
    if (options.socks) {
      let pending = Buffer.alloc(0);
      let stage = 'greeting';
      let username = ''; let password = '';
      const handshake = (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);
        if (stage === 'greeting') {
          if (pending.length < 2 || pending.length < 2 + pending[1]) return;
          assert.equal(pending[0], 5);
          pending = pending.subarray(2 + pending[1]);
          stage = 'auth';
          if (options.stallSocks) { options.stallSocks(); return; }
          socket.write(Buffer.from([5, 2]));
        }
        if (stage === 'auth') {
          if (pending.length < 2 || pending.length < 3 + pending[1]) return;
          const end = 3 + pending[1] + pending[2 + pending[1]];
          if (pending.length < end) return;
          username = pending.subarray(2, 2 + pending[1]).toString();
          password = pending.subarray(3 + pending[1], end).toString();
          pending = pending.subarray(end);
          if (options.rejectSocks) { socket.end(Buffer.from([1, 1])); return; }
          socket.write(Buffer.from([1, 0]));
          stage = 'connect';
        }
        if (stage === 'connect') {
          if (pending.length < 4) return;
          assert.equal(pending[0], 5); assert.equal(pending[1], 1);
          assert.ok(pending[3] === 1 || pending[3] === 4, 'SOCKS destination must be a pinned IP');
          const size = pending[3] === 1 ? 4 : 16;
          if (pending.length < 6 + size) return;
          const address = size === 4 ? [...pending.subarray(4, 8)].join('.') : Array.from({ length: 8 }, (_, i) => pending.readUInt16BE(4 + i * 2).toString(16)).join(':');
          socksRequests.push({ address, port: pending.readUInt16BE(4 + size), username, password });
          pending = pending.subarray(6 + size);
          socket.off('data', handshake);
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
          if (pending.length) socket.unshift(pending);
          origin.emit('connection', socket);
        }
      };
      socket.on('data', handshake);
      return;
    }
    origin.emit('connection', socket);
  });
  await new Promise<void>(resolve => proxy.listen(0, proxyHost, resolve));
  const port = (proxy.address() as net.AddressInfo).port;
  const checkDestination = (host: string | undefined, destinationPort: number | undefined) => {
    if (host !== proxyHost || Number(destinationPort) !== port) {
      unexpectedConnections.push({ host, port: destinationPort });
      throw new Error('test must only connect to the local fixture proxy');
    }
  };
  const connect = net.connect;
  t.mock.method(net, 'connect', (...args: unknown[]) => {
    const options = args[0] as net.TcpNetConnectOpts;
    checkDestination(options.host, options.port);
    return Reflect.apply(connect, net, args);
  });
  const socketConnect = net.Socket.prototype.connect;
  t.mock.method(net.Socket.prototype, 'connect', function (this: net.Socket, ...args: unknown[]) {
    const value = Array.isArray(args[0]) ? args[0][0] : args[0];
    const options = typeof value === 'object' ? value as net.TcpNetConnectOpts : { port: Number(value), host: args[1] as string };
    checkDestination(options.host, options.port);
    return Reflect.apply(socketConnect, this, args);
  });
  const secureConnect = tls.connect;
  t.mock.method(tls, 'connect', (...args: unknown[]) => {
    const options = args[0] as tls.ConnectionOptions;
    if (!options.socket) checkDestination(options.host, options.port);
    return Reflect.apply(secureConnect, tls, args);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    assert.deepEqual(unexpectedConnections, [], 'no request may bypass the configured proxy, including failed fallbacks');
  });
  return { url: (options.secureProxy ? 'https://' : 'http://') + proxyHost + ':' + port, tunnels, socksRequests };
}

function sendStream(response: ServerResponse, content = 'READY', finishReason = 'stop') {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write('data: ' + JSON.stringify({ id: 'proxy-stream', model: 'target-model', choices: [{ delta: { content: content.slice(0, 2) } }] }) + '\n\n');
  response.end('data: ' + JSON.stringify({ id: 'proxy-stream', model: 'target-model', choices: [{ delta: { content: content.slice(2) }, finish_reason: finishReason }] }) + '\n\ndata: [DONE]\n\n');
}

const input: AiQualityInput = { kind: 'ai', endpoint: 'http://8.8.8.8/v1', apiKey: 'private-key', model: 'target-model', mode: 'quick', runs: 1, items: [] };
const socksTarget = parseIpTarget('socks5://socks-user:socks-secret@9.9.9.9:1080')!;

test('plain IP metadata uses AI_PROXY_URL without treating the server proxy as the tested exit', { timeout: 3000 }, async t => {
  const requests: string[] = [];
  const proxy = await localProxy(t, (request, response) => {
    requests.push(request.url!);
    response.end(JSON.stringify({ success: true, ip: '8.8.8.8', country_code: 'US' }));
  });
  const run = createIpQualityDetector({ environment: { AI_PROXY_URL: proxy.url }, identityUrl: 'http://1.1.1.1/{ip}' });
  const results = await run({ kind: 'ip', target: '8.8.8.8', runs: 1 }, ['geo', 'ai-access', 'egress'], new AbortController().signal, () => {});
  assert.deepEqual(results.map(item => item.status), ['pass', 'unavailable', 'unavailable']);
  assert.deepEqual(requests, ['/8.8.8.8']);
  assert.equal(proxy.tunnels[0]?.url, '1.1.1.1:80');
});

test('IP probes chain the deployment proxy before the submitted SOCKS target and observe the SOCKS exit', { timeout: 3000 }, async t => {
  const requests: Array<{ url?: string; proxyAuth: unknown }> = [];
  const proxy = await localProxy(t, (request, response) => {
    requests.push({ url: request.url, proxyAuth: request.headers['proxy-authorization'] });
    response.end(JSON.stringify(request.url === '/exit' ? { ip: '8.8.8.8' } : { success: true, ip: '8.8.8.8', country_code: 'US' }));
  }, 200, { socks: true });
  const run = createIpQualityDetector({ environment: { AI_PROXY_URL: proxy.url.replace('http://', 'http://upstream-user:upstream-secret@') }, identityUrl: 'http://1.1.1.1/{ip}', egressUrl: 'http://1.1.1.1/exit' });
  const results = await run({ kind: 'ip', target: 'socks5://socks-user:socks-secret@9.9.9.9:1080', runs: 2 }, ['geo', 'egress'], new AbortController().signal, () => {});
  assert.deepEqual(results.map(item => item.status), ['pass', 'pass']);
  assert.deepEqual(requests.map(request => request.url), ['/exit', '/exit', '/8.8.8.8']);
  assert.ok(requests.every(request => request.proxyAuth === undefined));
  assert.ok(proxy.tunnels.length > 0);
  assert.ok(proxy.tunnels.every(request => request.url === '9.9.9.9:1080' && request.headers['proxy-authorization'] === 'Basic ' + Buffer.from('upstream-user:upstream-secret').toString('base64')));
  assert.ok(proxy.socksRequests.length > 0);
  assert.ok(proxy.socksRequests.every(request => request.address === '1.1.1.1' && request.port === 80 && request.username === 'socks-user' && request.password === 'socks-secret'));
  assert.ok(!JSON.stringify(results).includes('secret'));
});

for (const secureProxy of [false, true]) test('SOCKS chaining preserves destination TLS identity through an ' + (secureProxy ? 'HTTPS' : 'HTTP') + ' upstream', { timeout: 3000 }, async t => {
  let host: string | undefined; let servername: string | false | null = null;
  const proxy = await localProxy(t, (request, response) => {
    host = request.headers.host; servername = (request.socket as tls.TLSSocket).servername;
    response.end('chained');
  }, 200, { socks: true, secureTarget: true, secureProxy });
  const client = await createQualityFetch(socksTarget, { serverProxyUrl: proxy.url, lookup: async () => [{ address: '8.8.8.8', family: 4 }] });
  t.after(() => client.close());
  assert.equal(await (await client.fetch('https://user-endpoint.example/')).text(), 'chained');
  assert.equal(host, 'user-endpoint.example'); assert.equal(servername, 'user-endpoint.example');
  assert.equal(proxy.tunnels[0]?.url, '9.9.9.9:1080');
  assert.equal(proxy.socksRequests[0]?.address, '8.8.8.8'); assert.equal(proxy.socksRequests[0]?.port, 443);
  await assert.rejects(client.fetch('https://wrong-host.example/'), { message: '检测网络请求失败' });
});

for (const failure of ['CONNECT', 'SOCKS']) test(failure + ' authentication failure never bypasses either proxy or exposes credentials', { timeout: 3000 }, async t => {
  const proxy = await localProxy(t, () => assert.fail('rejected chain must not reach the origin'), failure === 'CONNECT' ? 407 : 200, { socks: true, rejectSocks: true });
  const client = await createQualityFetch(socksTarget, { serverProxyUrl: proxy.url });
  t.after(() => client.close());
  await assert.rejects(client.fetch('http://8.8.8.8/'), { message: '检测网络请求失败' });
  assert.equal(proxy.tunnels.length, 1); assert.equal(proxy.socksRequests.length, 0);
});

test('chained requests validate both SOCKS host and final destination and still block redirects', { timeout: 3000 }, async t => {
  const proxy = await localProxy(t, (_request, response) => { response.writeHead(302, { location: 'http://127.0.0.1/' }); response.end(); }, 200, { socks: true });
  await assert.rejects(createQualityFetch(parseIpTarget('socks5://127.0.0.1:1080')!, { serverProxyUrl: proxy.url }), /公网/);
  let address = '8.8.8.8';
  const client = await createQualityFetch(socksTarget, { serverProxyUrl: proxy.url, lookup: async () => [{ address, family: 4 }] });
  t.after(() => client.close());
  await assert.rejects(client.fetch('http://127.0.0.1/'), /公网/);
  assert.equal(proxy.tunnels.length, 0);
  await assert.rejects(client.fetch('http://rebind.example/'), /重定向/);
  const before = proxy.tunnels.length;
  address = '169.254.169.254';
  await assert.rejects(client.fetch('http://rebind.example/'), /公网/);
  assert.equal(proxy.tunnels.length, before);
});

for (const stage of ['CONNECT', 'SOCKS']) for (const action of ['cancel', 'timeout']) {
  test(action + ' closes a stalled ' + stage + ' handshake without fallback or a lingering socket', { timeout: 3000 }, async t => {
    let started!: () => void; const entered = new Promise<void>(resolve => { started = resolve; });
    let closed!: () => void; const disconnected = new Promise<void>(resolve => { closed = resolve; });
    const proxy = await localProxy(t, () => assert.fail('a stalled handshake must not reach the origin'), 200, { socks: true, ...(stage === 'CONNECT' ? { stallConnect: started } : { stallSocks: started }), onDisconnect: closed });
    const controller = new AbortController();
    const run = createIpQualityDetector({ environment: { AI_PROXY_URL: proxy.url }, headersUrl: 'http://8.8.8.8/headers', timeoutMs: action === 'timeout' ? 100 : 2000 });
    const pending = run({ kind: 'ip', target: 'socks5://socks-user:socks-secret@9.9.9.9:1080', runs: 1 }, ['header-leak'], controller.signal, () => {});
    await entered;
    if (action === 'cancel') controller.abort(new Error('socks-secret'));
    const results = await pending;
    await disconnected;
    assert.equal(results[0]?.status, action === 'cancel' ? 'cancelled' : 'risk');
    if (action === 'timeout') assert.match(results[0].summary, /超时/);
    assert.equal(proxy.tunnels.length, 1); assert.equal(proxy.socksRequests.length, 0);
    assert.ok(!JSON.stringify(results).includes('secret'));
  });
}

test('closing the transport interrupts an in-flight chain even without a request signal', { timeout: 3000 }, async t => {
  let started!: () => void; const entered = new Promise<void>(resolve => { started = resolve; });
  let closed!: () => void; const disconnected = new Promise<void>(resolve => { closed = resolve; });
  const proxy = await localProxy(t, () => assert.fail('closed chain must not reach the origin'), 200, { socks: true, stallSocks: started, onDisconnect: closed });
  const client = await createQualityFetch(socksTarget, { serverProxyUrl: proxy.url });
  t.after(() => client.close());
  const pending = assert.rejects(client.fetch('http://8.8.8.8/'), { message: '检测网络请求失败' });
  await entered; await client.close(); await pending; await disconnected;
  await assert.rejects(client.fetch('http://8.8.8.8/'), /关闭/);
});

test('a timed-out chained probe does not poison a subsequent probe on the same origin', { timeout: 3000 }, async t => {
  let requests = 0;
  const proxy = await localProxy(t, (_request, response) => {
    if (++requests === 1) { response.writeHead(200); response.write('{'); return; }
    response.end(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: '8.8.8.8' }] }));
  }, 200, { socks: true });
  const run = createIpQualityDetector({ environment: { AI_PROXY_URL: proxy.url }, headersUrl: 'http://1.1.1.1/headers', dnsUrl: 'http://1.1.1.1/dns', timeoutMs: 100 });
  const results = await run({ kind: 'ip', target: 'socks5://socks-user:socks-secret@9.9.9.9:1080', runs: 1 }, ['header-leak', 'dns'], new AbortController().signal, () => {});
  assert.deepEqual(results.map(item => item.status), ['risk', 'pass']);
  assert.match(results[0].summary, /超时/); assert.equal(requests, 2);
});

test('chained proxy and destination can both use pinned IPv6 addresses', { timeout: 3000 }, async t => {
  const proxy = await localProxy(t, (_request, response) => response.end('IPv6 chain'), 200, { socks: true });
  const client = await createQualityFetch(parseIpTarget('socks5://socks-user:socks-secret@proxy.example:1080')!, { serverProxyUrl: proxy.url, lookup: async host => [{ address: host === 'proxy.example' ? '2606:4700:4700::1111' : '2001:4860:4860::8888', family: 6 }] });
  t.after(() => client.close());
  assert.equal(await (await client.fetch('http://target.example/')).text(), 'IPv6 chain');
  assert.equal(proxy.tunnels[0]?.url, '[2606:4700:4700::1111]:1080');
  assert.equal(proxy.socksRequests[0]?.address, '2001:4860:4860:0:0:0:0:8888');
});

test('an untrusted upstream TLS certificate prevents the SOCKS handshake', { timeout: 3000 }, async t => {
  const proxy = await localProxy(t, () => assert.fail('untrusted upstream must not reach the origin'), 200, { socks: true, secureProxy: true, trustCertificate: false });
  const client = await createQualityFetch(socksTarget, { serverProxyUrl: proxy.url });
  t.after(() => client.close());
  await assert.rejects(client.fetch('http://8.8.8.8/'), { message: '检测网络请求失败' });
  assert.equal(proxy.tunnels.length, 0); assert.equal(proxy.socksRequests.length, 0);
});

test('AI quality probes inherit AI_PROXY_URL and send streaming requests through the actual proxy', { timeout: 3000 }, async t => {
  const requests: Array<{ url: string | undefined; authorization: string | undefined; proxyAuth: string | string[] | undefined; body: any }> = [];
  const proxy = await localProxy(t, (request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push({ url: request.url, authorization: request.headers.authorization, proxyAuth: request.headers['proxy-authorization'], body: JSON.parse(body) });
      sendStream(response, requests.length === 1 ? 'READY' : 'READY-7');
    });
  });
  const run = createAiQualityDetector({ environment: { AI_PROXY_URL: proxy.url.replace('http://', 'http://proxy-user:proxy-secret@') } });
  const results = await run(input, ['connectivity', 'streaming', 'instruction-following'], new AbortController().signal, () => {});
  assert.deepEqual(results.map(item => item.status), ['pass', 'pass', 'pass']);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(request => request.url === '/v1/chat/completions' && request.body.stream === true && request.authorization === 'Bearer private-key'));
  assert.ok(requests.every(request => request.proxyAuth === undefined));
  assert.ok(proxy.tunnels.length > 0);
  assert.ok(proxy.tunnels.every(request => request.url === '8.8.8.8:80' && request.headers['proxy-authorization'] === 'Basic ' + Buffer.from('proxy-user:proxy-secret').toString('base64')));
  assert.ok(!JSON.stringify(results).includes('private-key') && !JSON.stringify(results).includes('proxy-secret'));
});

test('model discovery uses the configured proxy and only requests authenticated metadata', { timeout: 3000 }, async t => {
  const requests: Array<{ url?: string; method?: string; authorization?: string }> = [];
  const proxy = await localProxy(t, (request, response) => {
    requests.push({ url: request.url, method: request.method, authorization: request.headers.authorization });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: [{ id: 'model-b' }, { id: 'model-a' }] }));
  });
  const list = createQualityModelLister({ environment: { AI_PROXY_URL: proxy.url } });
  assert.deepEqual(await list({ endpoint: 'http://8.8.8.8/v1', apiKey: 'private-key' }, new AbortController().signal), ['model-a', 'model-b']);
  assert.deepEqual(requests, [{ url: '/v1/models', method: 'GET', authorization: 'Bearer private-key' }]);
  assert.ok(proxy.tunnels.length > 0);
  assert.ok(proxy.tunnels.every(request => request.url === '8.8.8.8:80'));
  await assert.rejects(list({ endpoint: 'http://127.0.0.1/v1', apiKey: 'private-key' }, new AbortController().signal));
  assert.equal(requests.length, 1, 'private targets cannot be accessed through discovery');
});

test('configured proxy tunnels pin validated DNS results while preserving the original HTTP host', { timeout: 3000 }, async t => {
  let host: string | undefined;
  const proxy = await localProxy(t, (request, response) => { host = request.headers.host; response.end('proxied'); });
  const client = await createQualityFetch(undefined, { serverProxyUrl: proxy.url, lookup: async () => [{ address: '8.8.8.8', family: 4 }] });
  t.after(() => client.close());
  assert.equal(await (await client.fetch('http://user-endpoint.example:8080/health')).text(), 'proxied');
  assert.equal(host, 'user-endpoint.example:8080');
  assert.equal(proxy.tunnels[0]?.url, '8.8.8.8:8080');
});

test('configured proxy still blocks private targets, DNS rebinding and redirects', { timeout: 3000 }, async t => {
  const proxy = await localProxy(t, (_request, response) => { response.writeHead(302, { location: 'http://127.0.0.1/admin' }); response.end(); });
  let address = '8.8.8.8';
  const client = await createQualityFetch(undefined, { serverProxyUrl: proxy.url, lookup: async () => [{ address, family: 4 }] });
  t.after(() => client.close());
  await assert.rejects(client.fetch('http://127.0.0.1/'), /公网/);
  assert.equal(proxy.tunnels.length, 0);
  await assert.rejects(client.fetch('http://rebind.example/'), /重定向/);
  const before = proxy.tunnels.length;
  address = '169.254.169.254';
  await assert.rejects(client.fetch('http://rebind.example/'), /公网/);
  assert.equal(proxy.tunnels.length, before);
});

test('proxy authentication failure is sanitized and never falls back to a direct request', { timeout: 3000 }, async t => {
  const proxy = await localProxy(t, () => assert.fail('failed CONNECT must not send an upstream request'), 407);
  const client = await createQualityFetch(undefined, { serverProxyUrl: proxy.url.replace('http://', 'http://user:proxy-secret@') });
  t.after(() => client.close());
  await assert.rejects(client.fetch('http://8.8.8.8/'), { message: '检测网络请求失败' });
  assert.equal(proxy.tunnels.length, 1);
});

test('invalid server proxy configuration fails closed without exposing its credentials', async () => {
  for (const serverProxyUrl of ['not-a-proxy', 'ftp://user:secret@example.com', 'http://user:secret@example.com/#fragment']) {
    await assert.rejects(createQualityFetch(undefined, { serverProxyUrl }), error => error instanceof Error && error.message === 'AI 代理配置无效');
  }
});

for (const secureProxy of [false, true]) test('HTTPS targets preserve TLS identity through an ' + (secureProxy ? 'HTTPS' : 'HTTP') + ' proxy', { timeout: 3000 }, async t => {
  let host: string | undefined;
  let servername: string | false | null = null;
  const proxy = await localProxy(t, (request, response) => {
    host = request.headers.host;
    servername = (request.socket as tls.TLSSocket).servername;
    response.end('secure-proxied');
  }, 200, { secureTarget: true, secureProxy });
  const client = await createQualityFetch(undefined, { serverProxyUrl: proxy.url, lookup: async () => [{ address: '8.8.8.8', family: 4 }] });
  t.after(() => client.close());
  assert.equal(await (await client.fetch('https://user-endpoint.example/health')).text(), 'secure-proxied');
  assert.equal(host, 'user-endpoint.example');
  assert.equal(servername, 'user-endpoint.example');
  assert.equal(proxy.tunnels[0]?.url, '8.8.8.8:443');
  await assert.rejects(client.fetch('https://wrong-host.example/'), { message: '检测网络请求失败' });
});

test('an untrusted HTTPS proxy certificate is rejected before tunneling', { timeout: 3000 }, async t => {
  const proxy = await localProxy(t, () => assert.fail('untrusted proxy must not receive a target request'), 200, { secureProxy: true, trustCertificate: false });
  const client = await createQualityFetch(undefined, { serverProxyUrl: proxy.url });
  t.after(() => client.close());
  await assert.rejects(client.fetch('http://8.8.8.8/'), { message: '检测网络请求失败' });
  assert.equal(proxy.tunnels.length, 0);
});

test('IPv6 CONNECT authority uses the validated bracketed address and explicit port', { timeout: 3000 }, async t => {
  const proxy = await localProxy(t, (_request, response) => response.end('IPv6-proxied'));
  const client = await createQualityFetch(undefined, { serverProxyUrl: proxy.url, lookup: async () => [{ address: '2606:4700:4700::1111', family: 6 }] });
  t.after(() => client.close());
  assert.equal(await (await client.fetch('http://ipv6.example/')).text(), 'IPv6-proxied');
  assert.equal(proxy.tunnels[0]?.url, '[2606:4700:4700::1111]:80');
});

test('cancelling a proxied AI stream closes the request and does not publish partial output', { timeout: 3000 }, async t => {
  let started!: () => void;
  const receiving = new Promise<void>(resolve => { started = resolve; });
  let closed!: () => void;
  const disconnected = new Promise<void>(resolve => { closed = resolve; });
  let requests = 0;
  const proxy = await localProxy(t, (_request, response) => {
    requests++;
    response.on('close', closed);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ id: 'partial', model: input.model, choices: [{ delta: { content: 'private-partial-output' } }] }) + '\n\n');
    started();
  });
  const controller = new AbortController();
  const run = createAiQualityDetector({ environment: { AI_PROXY_URL: proxy.url } });
  const running = run(input, ['connectivity', 'math-reasoning'], controller.signal, () => {});
  await receiving;
  controller.abort();
  const results = await running;
  await disconnected;
  assert.deepEqual(results.map(item => item.status), ['cancelled', 'cancelled']);
  assert.equal(requests, 1);
  assert.ok(!JSON.stringify(results).includes('private-partial-output'));
});

test('a stalled proxied AI response times out once and closes the connection', { timeout: 3000 }, async t => {
  let closed!: () => void;
  const disconnected = new Promise<void>(resolve => { closed = resolve; });
  let requests = 0;
  const proxy = await localProxy(t, (_request, response) => {
    requests++;
    response.on('close', closed);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(': waiting\n\n');
  });
  const run = createAiQualityDetector({ environment: { AI_PROXY_URL: proxy.url }, timeoutMs: 100 });
  const results = await run(input, ['connectivity'], new AbortController().signal, () => {});
  await disconnected;
  assert.equal(results[0]?.status, 'risk');
  assert.equal(results[0]?.evidence?.attempts?.[0]?.outcome, 'timeout');
  assert.equal(requests, 1);
});

for (const [id, content, finishReason] of [['connectivity', 'private-truncated', 'length'], ['structured-output', 'private-invalid-json', 'stop']]) {
  test('proxied ' + id + ' rejects incomplete or invalid responses without retrying', { timeout: 3000 }, async t => {
    let requests = 0;
    const proxy = await localProxy(t, (_request, response) => { requests++; sendStream(response, content, finishReason); });
    const run = createAiQualityDetector({ environment: { AI_PROXY_URL: proxy.url } });
    const results = await run(input, [id], new AbortController().signal, () => {});
    assert.equal(results[0]?.status, 'risk');
    assert.equal(requests, 1);
    assert.ok(!JSON.stringify(results).includes('private-'));
  });
}
