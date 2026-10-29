import type { Pool, PoolClient, Notification } from 'pg';

/** Own a checked-out LISTEN client, including errors that occur between queries. */
export class PgNotifications {
  private failure?: Error;
  private closed = false;
  private pending = false;
  private wake?: () => void;
  private readonly onError = (error: Error) => { this.failure ??= error; this.wake?.(); };
  private readonly onNotification = (message: Notification) => {
    if (message.channel === this.channel && (this.payload === undefined || message.payload === this.payload)) {
      this.pending = true;
      this.wake?.();
    }
  };

  private constructor(private readonly client: PoolClient, private readonly channel: string, private readonly payload?: string) {
    client.on('error', this.onError);
    client.on('notification', this.onNotification);
  }

  static async open(pool: Pool, channel: string, payload?: string): Promise<PgNotifications> {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(channel)) throw new Error('invalid notification channel');
    const listener = new PgNotifications(await pool.connect(), channel, payload);
    try {
      await listener.client.query(`LISTEN "${channel}"`);
      listener.check();
      return listener;
    } catch (error) {
      listener.onError(error instanceof Error ? error : new Error(String(error)));
      await listener.close();
      throw error;
    }
  }

  check(): void { if (this.failure) throw this.failure; }

  async wait(signal: AbortSignal): Promise<void> {
    this.check();
    if (!signal.aborted && !this.pending && !this.closed) {
      await new Promise<void>(resolve => {
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', finish);
          this.wake = undefined;
          resolve();
        };
        const timer = setTimeout(finish, 1_000);
        this.wake = finish;
        signal.addEventListener('abort', finish, { once: true });
        if (signal.aborted || this.failure || this.pending) finish();
      });
    }
    this.pending = false;
    this.check();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.wake?.();
    try {
      if (!this.failure) await this.client.query(`UNLISTEN "${this.channel}"`);
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.client.off('notification', this.onNotification);
      // pg-pool reinstalls its idle error handler in release; retain ours until then.
      this.client.release(this.failure);
      this.client.off('error', this.onError);
    }
  }
}
