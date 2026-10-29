import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { JobsRepository } from '../src/jobs/jobs.repository.js';
import { AiRepository } from '../src/ai/ai.repository.js';
import { PgNotifications } from '../src/database/pg-notifications.js';

class NotificationClient extends EventEmitter {
  queries: string[] = [];
  releases: unknown[] = [];
  queryFailure?: Error;
  async query(query: string) {
    this.queries.push(query);
    if (this.queryFailure) throw this.queryFailure;
    return { rows: [] };
  }
  release(error?: unknown) { this.releases.push(error); }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('worker notification disconnect rejects the wait, discards the client and allows a fresh connection', async () => {
  const clients = [new NotificationClient(), new NotificationClient()];
  let connects = 0;
  const repository = new JobsRepository({} as never, { async connect() { return clients[connects++]!; } } as never);
  const wait = repository.waitForWork('ai_job_progress_changed', new AbortController().signal);
  const failure = new Error('Connection terminated unexpectedly');
  const rejected = assert.rejects(wait, failure);
  await tick();
  // Catch EventEmitter's throw so the pre-fix test can clean up its timer.
  let unhandled: unknown;
  try { clients[0]!.emit('error', failure); } catch (error) { unhandled = error; }
  clients[0]!.emit('notification', { channel: 'ai_job_progress_changed' });
  await rejected;
  assert.equal(unhandled, undefined);
  assert.deepEqual(clients[0]!.releases, [failure]);
  assert.equal(clients[0]!.listenerCount('error'), 0);
  const next = repository.waitForWork('ai_job_progress_changed', new AbortController().signal);
  await tick();
  clients[1]!.emit('notification', { channel: 'ai_job_progress_changed' });
  await next;
  assert.deepEqual(clients[1]!.releases, [undefined]);
});

test('progress notification disconnect closes the stream instead of crashing the API', async () => {
  const client = new NotificationClient();
  const repository = new AiRepository({} as never, { async connect() { return client; } } as never);
  repository.getJobProgress = async () => null;
  const controller = new AbortController();
  const events = repository.streamJobEvents(9n, 0n, controller.signal);
  const next = events.next();
  const failure = new Error('Connection terminated unexpectedly');
  const rejected = assert.rejects(next, failure);
  await tick();
  let unhandled: unknown;
  try { client.emit('error', failure); } catch (error) { unhandled = error; }
  controller.abort();
  await rejected;
  assert.equal(unhandled, undefined);
  assert.deepEqual(client.releases, [failure]);
  assert.equal(client.listenerCount('error'), 0);
  assert.equal(client.listenerCount('notification'), 0);
});

test('LISTEN failure discards the client and cancellation releases a healthy client', async () => {
  const client = new NotificationClient();
  const repository = new JobsRepository({} as never, { async connect() { return client; } } as never);
  const failure = new Error('LISTEN connection failed');
  client.queryFailure = failure;
  await assert.rejects(repository.waitForWork('ai_job_progress_changed', new AbortController().signal), failure);
  assert.deepEqual(client.releases, [failure]);
  assert.equal(client.listenerCount('error'), 0);
  client.queryFailure = undefined;
  const controller = new AbortController();
  const wait = repository.waitForWork('ai_job_progress_changed', controller.signal);
  await tick();
  controller.abort();
  await wait;
  assert.deepEqual(client.releases, [failure, undefined]);
});

test('UNLISTEN errors discard the connection without an unhandled error event', async () => {
  const client = new NotificationClient();
  const failure = new Error('disconnect during cleanup');
  client.query = async query => {
    client.queries.push(query);
    if (query.startsWith('UNLISTEN')) client.emit('error', failure);
    return { rows: [] };
  };
  const listener = await PgNotifications.open({ async connect() { return client; } } as never, 'work');
  await listener.close();
  await listener.close();
  assert.throws(() => listener.check(), failure);
  assert.deepEqual(client.releases, [failure]);
  assert.equal(client.listenerCount('error'), 0);
});

test('cancellation during LISTEN and notification before wait do not lose wakeups', async () => {
  const client = new NotificationClient();
  const controller = new AbortController();
  client.query = async () => { controller.abort(); return { rows: [] }; };
  const listener = await PgNotifications.open({ async connect() { return client; } } as never, 'work', '9');
  await listener.wait(controller.signal);
  client.emit('notification', { channel: 'work', payload: '9' });
  // A captured notification must resolve without the one-second fallback timer.
  let resolved = false;
  const wait = listener.wait(new AbortController().signal).then(() => { resolved = true; });
  await tick();
  assert.equal(resolved, true);
  await wait;
  await listener.close();
  assert.deepEqual(client.releases, [undefined]);
});

test('disconnect while a progress event is yielded is observed on the next iteration', async () => {
  const client = new NotificationClient();
  const repository = new AiRepository({} as never, { async connect() { return client; } } as never);
  repository.getJobProgress = async () => ({ version: '1' } as never);
  const events = repository.streamJobEvents(9n, 0n, new AbortController().signal);
  assert.equal((await events.next()).value?.type, 'progress');
  const failure = new Error('disconnect while yielded');
  client.emit('error', failure);
  await assert.rejects(events.next(), failure);
  assert.deepEqual(client.releases, [failure]);
});
