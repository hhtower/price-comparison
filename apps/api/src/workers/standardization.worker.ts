import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { StandardizationRepository } from '../standardization/standardization.repository.js';

const CONSENSUS_INTERVAL_MS = 10 * 60_000;

@Injectable()
export class StandardizationWorker {
  private readonly workerId = `standardization-${randomUUID()}`;
  private lastConsensusAt = 0;
  constructor(@Inject(StandardizationRepository) private readonly service: StandardizationRepository) {}

  async start(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await this.service.recoverFinalization();
    while (!signal.aborted) {
      const rows = await this.service.claimOutbox(this.workerId);
      if (!rows.length) {
        await this.service.recoverFinalization();
        if (Date.now() - this.lastConsensusAt >= CONSENSUS_INTERVAL_MS) {
          this.lastConsensusAt = Date.now();
          await this.service.reconcileNameConsensus().catch(() => undefined);
        }
        await setTimeout(1000, undefined, { signal }).catch(() => undefined);
        continue;
      }
      if (signal.aborted) return;
      try {
        await this.service.createIncrementalJob({ outbox: rows, workerId: this.workerId, priority: 50, signal });
      } catch (error) {
        await Promise.all(rows.map(row => this.service.failOutbox(row, this.workerId, error instanceof Error ? error.message : String(error))));
      }
    }
  }
}
