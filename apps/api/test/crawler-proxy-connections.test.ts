import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fetch as undiciFetch } from 'undici';
import { createDispatcher, ProxyPool } from '../src/crawler/proxy-pool.js';
import { createRunFetchFactory } from '../src/crawler/fetch-client.js';
import { HostRateLimiter } from '../src/crawler/rate-limiter.js';

type Protocol = 'http' | 'https' | 'socks5';

async function localProxy(t: TestContext, protocol: Protocol, respond: (request: IncomingMessage, response: ServerResponse) => void, secureTarget = false) {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/quality-proxy-tls.json', import.meta.url), 'utf8'));
  const previousCertificates = tls.getCACertificates();
  if (protocol === 'https' || secureTarget) tls.setDefaultCACertificates([...previousCertificates, fixture.cert]);
  const origin = secureTarget ? createHttpsServer(fixture, respond) : createServer(respond);
  const server = protocol === 'socks5' ? net.createServer()
    : protocol === 'https' ? createHttpsServer(fixture) : createServer();
  const sockets = new Set<net.Socket>();
  const tunnels: net.Socket[] = [];
  const attachOrigin = (socket: net.Socket, rest = Buffer.alloc(0)) => {
    tunnels.push(socket);
    if (rest.length) socket.unshift(rest);
    origin.emit('connection', socket);
  };
  server.on('connection', (socket: net.Socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    if (protocol !== 'socks5') return;
    let pending = Buffer.alloc(0), stage = 'greeting';
    const handshake = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (stage === 'greeting') {
        if (pending.length < 2 || pending.length < 2 + pending[1]) return;
        assert.equal(pending[0], 5);
        pending = pending.subarray(2 + pending[1]);
        socket.write(Buffer.from([5, 2]));
        stage = 'auth';
      }
      if (stage === 'auth') {
        if (pending.length < 2 || pending.length < 3 + pending[1]) return;
        const length = 3 + pending[1] + pending[2 + pending[1]];
        if (pending.length < length) return;
        assert.equal(pending.subarray(2, 2 + pending[1]).toString(), 'test-user');
        assert.equal(pending.subarray(3 + pending[1], length).toString(), 'test-secret');
        pending = pending.subarray(length);
        socket.write(Buffer.from([1, 0]));
        stage = 'connect';
      }
      if (stage === 'connect') {
        if (pending.length < 5) return;
        const size = pending[3] === 3 ? 7 + pending[4] : pending[3] === 1 ? 10 : 22;
        if (pending.length < size) return;
        assert.equal(pending[1], 1);
        socket.off('data', handshake);
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
        attachOrigin(socket, pending.subarray(size));
      }
    };
    socket.on('data', handshake);
  });
  if (protocol !== 'socks5') server.on('connect', (request: IncomingMessage, stream: net.Socket, head: Buffer) => {
    assert.equal(request.headers['proxy-authorization'], 'Basic ' + Buffer.from('test-user:test-secret').toString('base64'));
    stream.on('end', () => stream.end());
    stream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    attachOrigin(stream, head);
  });
  const host = protocol === 'https' ? 'localhost' : '127.0.0.1';
  await new Promise<void>(resolve => server.listen(0, host, resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (protocol === 'https' || secureTarget) tls.setDefaultCACertificates(previousCertificates);
  });
  return {
    url: `${protocol}://test-user:test-secret@${host}:${(server.address() as net.AddressInfo).port}`,
    target: `${secureTarget ? 'https' : 'http'}://user-endpoint.example/goods`,
    tunnels,
  };
}

async function crawlerClient(t: TestContext, proxyUrl: string, timeoutMs = 1000) {
  const pool = new ProxyPool([proxyUrl]);
  const lease = await pool.acquire();
  const dispatcher = lease.dispatcher!;
  lease.release();
  t.after(() => dispatcher.destroy());
  const fetch = createRunFetchFactory({
    pool, limiter: new HostRateLimiter(new Map()), requestTimeoutMs: timeoutMs,
  })(new AbortController().signal);
  return { fetch, dispatcher };
}

for (const protocol of ['http', 'https', 'socks5'] as const) for (const secureTarget of [false, true]) {
  test(`crawler ${protocol} proxy uses a fresh tunnel per ${secureTarget ? 'HTTPS' : 'HTTP'} request`, { timeout: 5000 }, async t => {
    const originSockets: net.Socket[] = [];
    const proxy = await localProxy(t, protocol, (request, response) => {
      originSockets.push(request.socket);
      assert.equal(request.headers['proxy-authorization'], undefined);
      response.setHeader('content-type', 'application/json');
      response.setHeader('connection', 'keep-alive');
      response.end('{"code":1}');
    }, secureTarget);
    const { fetch } = await crawlerClient(t, proxy.url);
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(await (await fetch(proxy.target, { method: 'POST' })).json(), { code: 1 });
      // Give the old reusable connection an opportunity to return to the pool.
      await sleep(10);
    }
    assert.equal(new Set(originSockets).size, 3);
    assert.equal(proxy.tunnels.length, 3);
  });
}

test('crawler concurrent requests and a follow-up never share proxy tunnels', { timeout: 5000 }, async t => {
  const sockets: net.Socket[] = [];
  const proxy = await localProxy(t, 'http', (request, response) => {
    sockets.push(request.socket);
    response.setHeader('content-type', 'application/json');
    response.write('{"code":');
    const timer = setTimeout(() => response.end('1}'), 30);
    response.on('close', () => clearTimeout(timer));
  });
  const { fetch } = await crawlerClient(t, proxy.url);
  const responses = await Promise.all(Array.from({ length: 3 }, () => fetch(proxy.target)));
  for (const response of responses) assert.deepEqual(await response.json(), { code: 1 });
  await sleep(10);
  assert.deepEqual(await (await fetch(proxy.target)).json(), { code: 1 });
  assert.equal(new Set(sockets).size, 4);
  assert.equal(proxy.tunnels.length, 4);
});

for (const action of ['complete', 'cancel', 'timeout'] as const) {
  test(`crawler proxy ${action} releases its socket without ending a live body early`, { timeout: 5000 }, async t => {
    let started!: () => void, disconnected!: () => void;
    const receiving = new Promise<void>(resolve => { started = resolve; });
    const closed = new Promise<void>(resolve => { disconnected = resolve; });
    let firstSocket: net.Socket | undefined;
    const requestSockets: net.Socket[] = [];
    let finish!: () => void;
    let count = 0;
    const proxy = await localProxy(t, 'http', (request, response) => {
      requestSockets.push(request.socket);
      response.setHeader('content-type', 'application/json');
      if (++count > 1) { response.end('{"next":true}'); return; }
      firstSocket = request.socket;
      request.socket.once('close', disconnected);
      response.write('{"complete":');
      finish = () => response.end('true}');
      started();
    });
    const { dispatcher } = await crawlerClient(t, proxy.url);
    const controller = new AbortController();
    const signal = action === 'timeout' ? AbortSignal.timeout(150) : controller.signal;
    const response = await undiciFetch(proxy.target, { dispatcher, signal });
    const body = response.text();
    const checked = action === 'complete' ? body : assert.rejects(body);
    await receiving;
    assert.equal(firstSocket?.destroyed, false);
    if (action === 'complete') finish();
    if (action === 'cancel') controller.abort();
    if (action === 'complete') assert.equal(await checked, '{"complete":true}');
    else await checked;
    await closed;
    assert.deepEqual(await (await undiciFetch(proxy.target, { dispatcher })).json(), { next: true });
    assert.equal(count, 2, 'cancellation must not replay the HTTP request');
    assert.equal(new Set(requestSockets).size, 2);
    // Undici may open an unused replacement CONNECT after cancellation.
    assert.ok(proxy.tunnels.length >= 2);
  });
}

test('the shared dispatcher factory keeps non-crawler connection reuse unchanged', { timeout: 5000 }, async t => {
  const sockets: net.Socket[] = [];
  const proxy = await localProxy(t, 'http', (request, response) => {
    sockets.push(request.socket);
    response.end('ok');
  });
  // Official-reference supplies this factory explicitly rather than the crawler default.
  const dispatcher = createDispatcher(proxy.url);
  t.after(() => dispatcher.destroy());
  for (let i = 0; i < 3; i++) {
    assert.equal(await (await undiciFetch(proxy.target, { dispatcher })).text(), 'ok');
    await sleep(10);
  }
  assert.equal(new Set(sockets).size, 1);
  assert.equal(proxy.tunnels.length, 1);
});

test('direct crawler requests still receive no proxy dispatcher', async () => {
  const lease = await new ProxyPool([]).acquire();
  assert.equal(lease.proxyUrl, null);
  assert.equal(lease.dispatcher, undefined);
});
