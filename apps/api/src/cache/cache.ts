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

  async set<T>(key: string, value: T, ttl = this.options.ttl): Promise<T> {
    let admitted = value !== undefined;
    if (admitted && this.options.maxBytes !== undefined) {
      try { admitted = Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8') <= this.options.maxBytes; }
      catch { admitted = false; }
    }
    if (!admitted) {
      await this.del(key);
      return value;
    }
    await Promise.all(this.stores.map(store => attempt(() => store.set(key, value, ttl))));
    return value;
  }

  async wrap<T>(key: string, load: () => T | Promise<T>, ttl = this.options.ttl): Promise<T> {
    const existing = this.pending.get(key);
    if (existing) return existing as Promise<T>;
    const task = (async () => {
      for (let index = 0; index < this.stores.length; index++) {
        const record = await this.record<T>(this.stores[index]!, key);
        if (record?.value === undefined) continue;
        // Promotion keeps the secondary tier's absolute expiry rather than renewing its TTL.
        await Promise.all(this.stores.slice(0, index).map(store => attempt(() => store.setRaw(key, record))));
        return record.value;
      }
      const value = await load();
      await this.set(key, value, ttl);
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
    await Promise.all(this.stores.map(store => attempt(() => store.delete(key))));
    return true;
  }

  async mdel(keys: string[]): Promise<boolean> {
    await Promise.all(keys.map(key => this.del(key)));
    return true;
  }

  async disconnect(): Promise<void> {
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
