import { Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ShopsRepository } from '../shops/shops.repository.js';

@Injectable()
export class FetchSchedulerWorker {
  private readonly workerId: string;
  constructor(
    @Inject(ShopsRepository) private readonly shops: ShopsRepository,
    @Optional() workerId?: string,
    @Optional() private readonly logger?: { error?: (...args: unknown[]) => void },
    @Optional() private readonly enqueueSettlements?: () => Promise<number>,
  ) { this.workerId = workerId ?? `fetch-scheduler-${randomUUID()}`; }

  async start(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      try {
        const claims = await this.shops.claimDueShops(this.workerId, 32);
        for (const shop of claims) {
          if (signal.aborted) break;
          await this.shops.enqueueFetchRun(shop.id, 'scheduler');
        }
        if (!signal.aborted) await this.enqueueSettlements?.();
        failures = 0;
      } catch (error) {
        failures += 1;
        this.logger?.error?.('fetch_scheduler.claim_failed', error);
      }
      const backoffMs = failures ? Math.min(30_000, 1_000 * 2 ** Math.min(failures - 1, 5)) : 1_000;
      await waitForSignal(signal, backoffMs);
    }
  }
}

function waitForSignal(signal: AbortSignal, ms: number): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    const onAbort = () => done();
    function done() { clearTimeout(timer); signal.removeEventListener('abort', onAbort); resolve(); }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
