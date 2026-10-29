import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { createQualityFetch, isPublicAddress, resolvePublicHost } from '../src/quality/quality-network.js';
import { parseIpTarget } from '../src/quality/quality-input.js';

test('blocks private loopback reserved multicast and mapped addresses before any network call', async () => {
  for (const address of ['127.0.0.1', '0.0.0.0', '10.1.2.3', '100.64.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '198.18.0.1', '224.0.0.1', '255.255.255.255', '::', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1']) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  await assert.rejects(resolvePublicHost('metadata.test', async () => [{ address: '169.254.169.254', family: 4 }]), /公网/);
  await assert.rejects(resolvePublicHost('mixed.test', async () => [{ address: '8.8.8.8', family: 4 }, { address: '::1', family: 6 }]), /公网/);
});

test('rejects unsafe URLs and redirects, fixes connection addresses, and destroys its dispatchers', async () => {
  let calls = 0; let redirect: unknown;
  const client = await createQualityFetch(undefined, {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    fetchImpl: async (_url, options) => { calls++; redirect = options?.redirect; assert.ok((options as any).dispatcher); return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } }); },
  });
  for (const url of ['http://127.0.0.1', 'file:///secret', 'https://user:password@example.com']) await assert.rejects(client.fetch(url));
  assert.equal(calls, 0);
  await assert.rejects(client.fetch('https://example.com'), /重定向/);
  assert.equal(calls, 1); assert.equal(redirect, 'manual');
  await client.close();
  await assert.rejects(client.fetch('https://example.com'), /关闭/);
});

test('validates and pins proxy hosts without falling back to a direct connection', async () => {
  const proxy = parseIpTarget('socks5://user:password@proxy.example:1080')!;
  await assert.rejects(createQualityFetch(proxy, { lookup: async () => [{ address: '10.0.0.1', family: 4 }] }), /公网/);
  const client = await createQualityFetch(proxy, { lookup: async () => [{ address: '8.8.8.8', family: 4 }], fetchImpl: async () => { throw new Error('upstream secret'); } });
  await assert.rejects(client.fetch('https://example.com'), error => !String(error).includes('secret') && !String(error).includes('password'));
  await client.close();
});

test('deployment HTTP and SOCKS exits still pin public destinations and never send private targets', async () => {
  for (const serverProxyUrl of ['http://127.0.0.1:7890', 'socks5://user:password@127.0.0.1:1080']) {
    let sent = 0;
    const client = await createQualityFetch(undefined, { serverProxyUrl, lookup: async () => [{ address: '8.8.8.8', family: 4 }],
      fetchImpl: async (_url, init) => { sent++; assert.ok((init as any).dispatcher); return Response.json({ ok: true }); },
    });
    await assert.rejects(client.fetch('https://127.0.0.1/'), /公网/);
    assert.equal(sent, 0);
    assert.equal((await client.fetch('https://shop.example/')).status, 200);
    assert.equal(sent, 1);
    await client.close();
  }
});

test('proxyDns deployment exit skips local resolution and CONNECTs by hostname', async () => {
  const seen: string[] = [];
  const proxy = createServer(socket => {
    socket.once('data', chunk => {
      const match = /^CONNECT (\S+) HTTP/.exec(String(chunk));
      if (!match) { socket.destroy(); return; }
      seen.push(match[1]!);
      socket.write('HTTP/1.1 200 Connection established\r\n\r\n', () => setTimeout(() => socket.destroy(), 50));
    });
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const port = (proxy.address() as AddressInfo).port;
  // 本地解析被污染时仍可工作：lookup 抛错也不影响，CONNECT 必须是域名而非预解析 IP。
  const client = await createQualityFetch(undefined, { serverProxyUrl: `http://127.0.0.1:${port}`, proxyDns: true,
    lookup: async () => { throw new Error('must not resolve locally'); } });
  await assert.rejects(client.fetch('https://shop.example/'), /检测网络请求失败/);
  assert.deepEqual(seen, ['shop.example:443']);
  await client.close(); proxy.close();
});

test('cancellation interrupts pending target and proxy DNS resolution without starting a request', async () => {
  const controller = new AbortController();
  let entered!: () => void; const resolving = new Promise<void>(resolve => { entered = resolve; });
  const lookup = async () => { entered(); return new Promise<Array<{address:string;family:number}>>(() => {}); };
  const client = await createQualityFetch(undefined, { lookup, fetchImpl: async () => { throw new Error('must not send'); } });
  const running = client.fetch('https://pending.example', { signal: controller.signal });
  await resolving; controller.abort(new Error('user cancelled'));
  await assert.rejects(Promise.race([running, new Promise((_resolve, reject) => setTimeout(() => reject(new Error('DNS ignored cancellation')), 100))]), /user cancelled/);
  await client.close();
  const proxyController = new AbortController();
  const opening = createQualityFetch(parseIpTarget('socks5://proxy.example:1080')!, { lookup, signal: proxyController.signal });
  proxyController.abort(new Error('proxy cancelled'));
  await assert.rejects(opening, /proxy cancelled/);
});

for (const action of ['cancel', 'close'] as const) test(`deployment SOCKS ${action} closes a stalled handshake immediately`, async () => {
  const sockets = new Set<Socket>();
  let accepted!: () => void, disconnected!: () => void;
  const greeting = new Promise<void>(resolve => { accepted = resolve; });
  const released = new Promise<void>(resolve => { disconnected = resolve; });
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('data', accepted); // Never answer the SOCKS greeting.
    socket.once('close', () => { sockets.delete(socket); disconnected(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const controller = new AbortController(), reason = new Error('cancel handshake');
  const client = await createQualityFetch(undefined, { serverProxyUrl: `socks5://127.0.0.1:${address.port}`, lookup: async () => [{ address: '8.8.8.8', family: 4 }] });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const running = client.fetch('https://shop.example/', { signal: controller.signal }).then(() => assert.fail('stalled handshake must not return a response'), error => error);
  try {
    await greeting;
    if (action === 'cancel') controller.abort(reason);
    else await client.close();
    const error = await running;
    assert.ok(error instanceof Error);
    if (action === 'cancel') assert.equal(error, reason);
    await client.close();
    await Promise.race([released, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('SOCKS handshake survived cancellation/close')), 300); })]);
  } finally {
    clearTimeout(timer);
    await client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('deployment SOCKS pins the actual destination and keeps concurrent handshake cancellation isolated', async () => {
  const sockets = new Set<Socket>(), destinations: number[][] = [], requests: string[] = [];
  let connections = 0, firstReady!: () => void, secondReady!: (socket: Socket) => void;
  const firstGreeting = new Promise<void>(resolve => { firstReady = resolve; });
  const secondGreeting = new Promise<Socket>(resolve => { secondReady = resolve; });
  const server = createServer(socket => {
    const first = ++connections === 1;
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    socket.once('data', () => first ? firstReady() : secondReady(socket));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const client = await createQualityFetch(undefined, { serverProxyUrl: `socks5://127.0.0.1:${address.port}`, lookup: async () => [{ address: '8.8.8.8', family: 4 }] });
  const controller = new AbortController(), reason = new Error('cancel only the first handshake');
  const first = client.fetch('http://shop.example/', { signal: controller.signal }).catch(error => error);
  try {
    await firstGreeting;
    const second = client.fetch('http://shop.example/').then(response => response.text(), error => error);
    const socket = await secondGreeting;
    controller.abort(reason);
    assert.equal(await first, reason);
    socket.once('data', data => {
      destinations.push([...data]);
      socket.once('data', request => {
        requests.push(request.toString());
        socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK');
      });
      socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
    });
    socket.write(Buffer.from([5, 0]));
    assert.equal(await second, 'OK');
    assert.deepEqual(destinations, [[5, 1, 0, 1, 8, 8, 8, 8, 0, 80]]);
    assert.match(requests[0]!, /host: shop\.example\r\n/i);
  } finally {
    await client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
