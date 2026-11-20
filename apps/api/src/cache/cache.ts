import { Keyv, jsonSerializer, type KeyvValue } from 'keyv';
import { LRUCache } from 'lru-cache';

export const CACHE = Symbol('CACHE');

export interface CacheOptions {
  stores?: Keyv[];
  ttl?: number;
  maxBytes?: number;
}

export function createMemoryStore(ttl?: number, entries = 128): Keyv {
  const memory = new LRUCache<string, string>({ max: entries });
  return new Keyv({
    // Keyv passes a TTL to set(); lru-cache's third argument is an options object.
    store: {
      get: (key: string) => memory.get(key),
      set: (key: string, value: string) => { memory.set(key, value); },
      has: (key: string) => memory.has(key),
      delete: (key: string) => memory.delete(key),
      clear: () => memory.clear(),
      entries: () => memory.entries(),
    },
    serialization: jsonSerializer,
    ttl,
  });
}

// Cache storage is optional; a failed tier must not fail a successful business request.
async function attempt<T>(operation: () => Promise<T>): Promise<T | undefined> {
  try { return await operation(); } catch { return undefined; }
}

export class Cache {
  readonly stores: Keyv[];
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly writes = new Map<string, Promise<unknown>>();

  constructor(private readonly options: CacheOptions = {}) {
    this.stores = options.stores ?? [createMemoryStore(options.ttl)];
    for (const store of this.stores) store.on('error', () => {});
  }

  async get<T>(key: string): Promise<T | undefined> {
    for (const store of this.stores) {
      const value = await attempt(() => store.get<T>(key));
      if (value !== undefined) return value;
    }
    return undefined;
  }

  async mget<T>(keys: string[]): Promise<Array<T | undefined>> {
    const values: Array<T | undefined> = keys.map(() => undefined);
    for (const store of this.stores) {
      const missing = keys.flatMap((key, index) => values[index] === undefined ? [{ key, index }] : []);
      if (!missing.length) break;
      const found = await attempt(() => store.getMany<T>(missing.map(item => item.key)));
      found?.forEach((value, index) => { values[missing[index]!.index] = value; });
    }
    return values;
  }

  async set<T>(key: string, value: T, ttl = this.options.ttl, waitForSecondary = true): Promise<T> {
    const expires = ttl ? Date.now() + ttl : undefined;
    await this.writes.get(key);
    if (expires !== undefined) {
      ttl = expires - Date.now();
      if (ttl <= 0) { await this.del(key); return value; }
    }
    let admitted = value !== undefined;
    if (admitted && this.options.maxBytes !== undefined) {
      try { admitted = Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8') <= this.options.maxBytes; }
      catch { admitted = false; }
    }
    if (!admitted) {
      await this.del(key);
      return value;
    }
    const [first, ...secondary] = this.stores;
    const stored = first && await attempt(() => first.set(key, value, ttl));
    const record = stored ? await this.record<T>(first, key) : undefined;
    const write = Promise.all(secondary.map(store => attempt(() => record
      ? store.setRaw(key, record) : store.set(key, value, ttl))));
    this.writes.set(key, write);
    void write.finally(() => { if (this.writes.get(key) === write) this.writes.delete(key); });
    if (waitForSecondary) await write;
    return value;
  }

  async wrap<T>(key: string, load: () => T | Promise<T>, ttl: number | (() => number) | undefined = this.options.ttl): Promise<T> {
    const existing = this.pending.get(key);
    if (existing) return existing as Promise<T>;
    const task = (async () => {
      for (let index = 0; index < this.stores.length; index++) {
        const record = await this.record<T>(this.stores[index]!, key);
        if (record?.value === undefined || (record.expires != null && record.expires <= Date.now())) continue;
        // Promotion keeps the secondary tier's absolute expiry rather than renewing its TTL.
        await Promise.all(this.stores.slice(0, index).map(store => attempt(() => store.setRaw(key, record))));
        return record.value;
      }
      const value = await load();
      const remaining = typeof ttl === 'function' ? ttl() : ttl;
      // Keyv treats zero as unlimited; an exhausted read budget must not be cached.
      // Warm memory before returning; a remote cache write must not delay a successful read.
      if (remaining === undefined || remaining > 0) await this.set(key, value, remaining, false);
      return value;
    })();
    this.pending.set(key, task);
    try { return await task; }
    finally { this.pending.delete(key); }
  }

  async ttl(key: string): Promise<number | undefined> {
    for (const store of this.stores) {
      const record = await this.record(store, key);
      if (record?.value !== undefined) return record.expires;
    }
    return undefined;
  }

  async del(key: string): Promise<boolean> {
    await this.writes.get(key);
    await Promise.all(this.stores.map(store => attempt(() => store.delete(key))));
    return true;
  }

  async mdel(keys: string[]): Promise<boolean> {
    await Promise.all(keys.map(key => this.del(key)));
    return true;
  }

  async disconnect(): Promise<void> {
    await Promise.all(this.writes.values());
    await Promise.all(this.stores.map(store => attempt(() => store.disconnect())));
  }

  onModuleDestroy(): Promise<void> { return this.disconnect(); }

  private async record<T>(store: Keyv, key: string): Promise<KeyvValue<T> | undefined> {
    const raw = await attempt(() => store.getRaw<T>(key));
    return typeof raw === 'string' ? attempt(() => store.decode<T>(raw)) : raw;
  }
}

export function createCache(options: CacheOptions = {}): Cache {
  return new Cache(options);
}
