import { Redis } from 'ioredis';
import type { OnApplicationShutdown } from '@nestjs/common';
import { ASSISTANT_LIMITS } from '@price-comparison/catalog/assistant-contract';

const channel = 'assistant:reasoning';
type Writer = { text: string; publishedAt: number; publishing?: Promise<void>; timer?: ReturnType<typeof setTimeout> };

/** Pub/sub only: partial model output must never enter Redis keys or the database. */
export class AssistantReasoning implements OnApplicationShutdown {
  private publisher?: Redis;
  private subscriber?: Redis;
  private connecting?: Promise<void>;
  private readonly writers = new Map<string, Writer>();
  private readonly listeners = new Map<string, Set<(text: string) => void>>();

  constructor(private readonly createRedis = () => {
    if (!process.env.REDIS_URL?.trim()) throw new Error('Redis is not configured');
    const redis = new Redis(process.env.REDIS_URL, {
      lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0,
      connectTimeout: 1000, commandTimeout: 1000,
    });
    redis.on('error', () => undefined);
    return redis;
  }) {}

  private async connect(): Promise<void> {
    this.connecting ??= (async () => {
      this.publisher = this.createRedis();
      this.subscriber = this.createRedis();
      this.subscriber.on('message', (_channel: string, raw: string) => {
        if (raw.length > ASSISTANT_LIMITS.sseBufferMaxBytes) return;
        let event;
        try { event = JSON.parse(raw); } catch { return; }
        if (!event || typeof event.turnKey !== 'string') return;
        if (event.replay === true) {
          const writer = this.writers.get(event.turnKey);
          if (writer?.text) void this.publish(event.turnKey, writer.text);
        } else if (typeof event.text === 'string' && event.text.length <= ASSISTANT_LIMITS.reasoningMaxChars) {
          this.listeners.get(event.turnKey)?.forEach(listener => listener(event.text));
        }
      });
      await Promise.all([this.publisher.connect(), this.subscriber.connect()]);
      await this.subscriber.subscribe(channel);
    })().catch(error => {
      this.publisher?.disconnect(); this.subscriber?.disconnect();
      this.connecting = undefined;
      throw error;
    });
    return this.connecting;
  }

  private async publish(turnKey: string, text: string): Promise<void> {
    // Progress is optional; losing it must not fail a validated answer.
    await this.publisher?.publish(channel, JSON.stringify({ turnKey, text })).catch(() => undefined);
  }

  async start(turnKey: string) {
    await this.connect();
    const writer: Writer = { text: '', publishedAt: 0 };
    this.writers.set(turnKey, writer);
    const schedule = () => {
      if (this.writers.get(turnKey) !== writer || writer.publishing || writer.timer) return;
      const wait = 100 - (Date.now() - writer.publishedAt);
      if (wait > 0) {
        writer.timer = setTimeout(() => { writer.timer = undefined; schedule(); }, wait);
        return;
      }
      const text = writer.text;
      writer.publishing = this.publish(turnKey, text).finally(() => {
        writer.publishedAt = Date.now();
        writer.publishing = undefined;
        // Flush trailing fragments even if the model pauses or starts producing its answer.
        if (writer.text !== text) schedule();
      });
    };
    return {
      append: async (fragment: string) => {
        if (this.writers.get(turnKey) !== writer) return;
        const limit = ASSISTANT_LIMITS.reasoningMaxChars;
        const suffix = '\n（思考内容过长，后续省略）';
        if (writer.text.length >= limit) return;
        const next = writer.text + fragment;
        writer.text = next.length > limit ? next.slice(0, limit - suffix.length) + suffix : next;
        schedule();
      },
      close: async () => {
        if (this.writers.get(turnKey) !== writer) return;
        this.writers.delete(turnKey);
        clearTimeout(writer.timer);
        await writer.publishing;
        if (writer.text) await this.publish(turnKey, writer.text);
      },
    };
  }

  async subscribe(turnKey: string, listener: (text: string) => void): Promise<() => void> {
    await this.connect();
    const listeners = this.listeners.get(turnKey) ?? new Set();
    listeners.add(listener);
    this.listeners.set(turnKey, listeners);
    await this.publisher!.publish(channel, JSON.stringify({ turnKey, replay: true })).catch(() => undefined);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(turnKey);
    };
  }

  onApplicationShutdown(): void {
    this.publisher?.disconnect(); this.subscriber?.disconnect();
    this.writers.forEach(writer => clearTimeout(writer.timer));
    this.writers.clear(); this.listeners.clear();
  }
}
