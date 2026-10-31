import { afterEach, expect, test, vi } from 'vitest';
import { emptyShoppingNeeds } from '@price-comparison/catalog/assistant-contract';
import { createAssistantApi, assistantListLink } from './assistant-api.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const credentials = { sessionId, accessToken: 'secret' };
const messageId = '22222222-2222-4222-8222-222222222222';
const turn = (overrides = {}) => ({
  id: '1', sessionId, clientMessageId: messageId, inputText: '写代码',
  expectedRevision: 0, eventVersion: 1, status: 'running', phase: 'understanding', reply: null, errorCode: null, ...overrides,
});
const reply = { kind: 'question', text: '有预算要求吗？', options: ['没有'], needs: emptyShoppingNeeds(), cards: [] };
const finished = turn({ eventVersion: 3, status: 'succeeded', phase: 'succeeded', reply });
function events(chunks) {
  return new Response(new ReadableStream({
    start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}
afterEach(() => vi.restoreAllMocks());

test('requests use isolated Bearer credentials, no-store and only the current input', async () => {
  const fetcher = vi.fn(async () => Response.json({ snapshot: turn(), created: true }));
  const api = createAssistantApi(fetcher);
  const input = { clientMessageId: messageId, expectedRevision: 0, text: '写代码' };
  expect((await api.sendTurn(credentials, input)).snapshot.id).toBe('1');
  const [path, init] = fetcher.mock.calls[0];
  expect(path).toBe(`/api/assistant/sessions/${sessionId}/turns`);
  expect(init).toMatchObject({ cache: 'no-store', credentials: 'omit', redirect: 'error', headers: { Authorization: 'Bearer secret' } });
  expect(JSON.parse(init.body)).toEqual(input);
});

test('fragmented multiline SSE ignores duplicate versions and exposes only validated final replies', async () => {
  const data = JSON.stringify(finished).replace(',"eventVersion"', ',\n"eventVersion"');
  const frames = `: heartbeat\r\n\r\nevent: snapshot\r\ndata: ${JSON.stringify(turn())}\r\n\r\n`
    + `event: snapshot\ndata: ${JSON.stringify(turn({ eventVersion: 0 }))}\n\n`
    + 'event: snapshot\n' + data.split('\n').map(line => 'data: ' + line).join('\n') + '\n\n';
  const api = createAssistantApi(async () => events([frames.slice(0, 27), frames.slice(27, 133), frames.slice(133)]));
  const snapshots = [];
  expect(await api.subscribeTurn(credentials, turn(), value => snapshots.push(value))).toEqual(finished);
  expect(snapshots.map(value => value.eventVersion)).toEqual([3]);
});

test('disconnect recovers from authoritative session without posting another message', async () => {
  const fetcher = vi.fn(async path => path.endsWith('/events') ? events(['event: snapshot\ndata: {broken}\n\n'])
    : Response.json({ id: sessionId, revision: 1, needs: emptyShoppingNeeds(), turns: [finished] }));
  const api = createAssistantApi(fetcher);
  expect(await api.subscribeTurn(credentials, turn(), () => {})).toEqual(finished);
  expect(fetcher.mock.calls.every(([, options]) => options.method !== 'POST')).toBe(true);
});

test('unfinished streams stop reconnecting after a bounded number of reads', async () => {
  const fetcher = vi.fn(async path => path.endsWith('/events') ? events([])
    : Response.json({ id: sessionId, revision: 0, needs: emptyShoppingNeeds(), turns: [turn()] }));
  await expect(createAssistantApi(fetcher).subscribeTurn(credentials, turn(), () => {})).rejects.toThrow(/重新连接/);
  expect(fetcher.mock.calls.length).toBeLessThanOrEqual(6);
});

test('abort closes only the SSE reader and does not call cancel or replay', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const fetcher = vi.fn(async () => new Response(new ReadableStream({
    start() {},
    cancel() { cancelled = true; },
  }), { headers: { 'Content-Type': 'text/event-stream' } }));
  const task = createAssistantApi(fetcher).subscribeTurn(credentials, turn(), () => {}, controller.signal);
  await new Promise(resolve => setTimeout(resolve, 0));
  controller.abort();
  await expect(task).rejects.toThrow();
  expect(cancelled).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toMatch(/\/events$/);
});

test('malformed successful response is never accepted as a final answer', async () => {
  const api = createAssistantApi(async () => Response.json({ snapshot: { ...finished, reply: { ...reply, text: 'x'.repeat(1201) } }, created: true }));
  await expect(api.sendTurn(credentials, { clientMessageId: messageId, expectedRevision: 0, text: '写代码' })).rejects.toThrow(/响应/);
});

test('invalid snapshots and foreign turn identities cannot become assistant answers', async () => {
  const fetcher = vi.fn(async () => Response.json({ snapshot: { ...finished, sessionId: '33333333-3333-4333-8333-333333333333' }, created: true }));
  await expect(createAssistantApi(fetcher).sendTurn(credentials, {
    clientMessageId: messageId, expectedRevision: 0, text: '写代码',
  })).rejects.toThrow(/响应/);
});

test('cancel accepts completion winning the race and delete supports an empty 204', async () => {
  const fetcher = vi.fn(async (_path, init) => init.method === 'DELETE'
    ? new Response(null, { status: 204 }) : Response.json(finished));
  const api = createAssistantApi(fetcher);
  expect(await api.cancelTurn(credentials, '1')).toEqual(finished);
  await expect(api.deleteSession(credentials)).resolves.toBeUndefined();
});

test('public errors never render backend secrets and a send is never automatically retried', async () => {
  const fetcher = vi.fn(async () => new Response('provider secret', { status: 409 }));
  await expect(createAssistantApi(fetcher).sendTurn(credentials, {
    clientMessageId: messageId, expectedRevision: 0, text: '写代码',
  })).rejects.toThrow(/版本|同步/);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('list link carries only supported hard requirements and opts out of newcomer defaults', () => {
  const needs = { ...emptyShoppingNeeds(), purpose: '论文', platform: 'openai',
    budget: { amount: '50', currency: 'CNY', basis: 'month' }, preferences: ['lower_price'],
    requiredTags: [{ name: 'access', value: 'dedicated' }], warrantyDaysMin: 30 };
  const link = assistantListLink(needs);
  const params = new URL(link.href, 'https://local.example').searchParams;
  expect([...params.keys()].sort()).toEqual(['newcomer', 'platform', 'tag', 'warrantyDaysMin']);
  expect(params.get('newcomer')).toBe('false');
  expect(JSON.parse(params.get('tag'))).toEqual({ name: 'access', value: 'dedicated' });
  expect(link.note).toMatch(/预算/);
  expect(link.note).toMatch(/用途/);
  expect(link.note).toMatch(/偏好/);
});
