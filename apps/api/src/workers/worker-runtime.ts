import { classifyRetryClass, type ClaimedJob, type QueueKind, type QueueName } from '../jobs/jobs.repository.js';
import {
  runWithWorkerContext,
  updateRequestContext,
} from '../observability/request-context.js';
import type { MetricsRegistry } from '../observability/metrics.js';
import type { AiConcurrencyCoordinator, AiLease, AiStage } from '../ai/ai-concurrency.js';

export interface WorkerLogger {
  log?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

export interface WorkerRuntimeService {
  claimNext(kind: QueueKind, workerId: string, leaseMs: number): Promise<ClaimedJob | null>;
  claimAvailable?(queue: QueueName, workerId: string, limit: number, leaseMs?: number): Promise<ReadonlyArray<ClaimedJob>>;
  waitForWork?(channel: string, signal: AbortSignal): Promise<void>;
  queueDepth?(kind: QueueKind): Promise<number>;
  heartbeat(kind: QueueKind, id: bigint, workerId: string, leaseMs?: number, claimToken?: string): Promise<void>;
  complete(kind: QueueKind, id: bigint, workerId: string): Promise<void>;
  fail(kind: QueueKind, id: bigint, workerId: string, error: string, options?: { retry?: boolean; backoffMs?: number; retryClass?: string | null; claimToken?: string }): Promise<void>;
  requeue(kind: QueueKind, id: bigint, workerId: string, backoffMs?: number, claimToken?: string): Promise<void>;
  /** Synchronous local cleanup after all execution/state-transition attempts have ended. */
  onSettled?(kind: QueueKind, id: bigint, workerId: string): void;
}

export interface WorkerRuntimeOptions {
  readonly service: WorkerRuntimeService;
  readonly kind: QueueKind;
  readonly workerId: string;
  readonly handler: (job: ClaimedJob, signal: AbortSignal, context?: { aiLease?: AiLease }) => Promise<void>;
  readonly concurrency?: number;
  readonly aiConcurrency?: number;
  readonly aiCoordinator?: AiConcurrencyCoordinator;
  readonly aiStage?: AiStage;
  readonly usesAiLease?: (job: ClaimedJob) => boolean;
  readonly beforeExecute?: (job: ClaimedJob, signal: AbortSignal) => Promise<void>;
  readonly leaseMs?: number;
  readonly heartbeatMs?: number;
  readonly pollMs?: number;
  readonly maxRetries?: number;
  readonly retryBaseMs?: number;
  readonly transientMaxAttempts?: number;
  readonly transientRetryBaseMs?: number;
  readonly transientRetryMaxMs?: number;
  readonly logger?: WorkerLogger;
  readonly metrics?: MetricsRegistry;
}

export class WorkerRuntime {
  private readonly options: Required<Omit<WorkerRuntimeOptions, 'logger' | 'metrics' | 'usesAiLease' | 'beforeExecute'>>
    & Pick<WorkerRuntimeOptions, 'logger' | 'metrics' | 'usesAiLease' | 'beforeExecute'>;
  private readonly active = new Map<bigint, { controller: AbortController; heartbeat: ReturnType<typeof setInterval> }>();
  private readonly inFlightRuns = new Set<Promise<number>>();
  private stopping = false;
  private started = false;
  private timer?: ReturnType<typeof setTimeout>;
  private wakeController = new AbortController();
  private lastQueueSampleAt = 0;
  private claimFailureCount = 0;

  constructor(options: WorkerRuntimeOptions) {
    this.options = {
      ...options,
      concurrency: Math.min(options.concurrency ?? 2, options.aiConcurrency ?? Number.MAX_SAFE_INTEGER),
      leaseMs: options.leaseMs ?? 30_000,
      heartbeatMs: options.heartbeatMs ?? 10_000,
      pollMs: options.pollMs ?? 250,
      maxRetries: options.maxRetries ?? 3,
      retryBaseMs: options.retryBaseMs ?? 500,
      transientMaxAttempts: options.transientMaxAttempts ?? 8,
      transientRetryBaseMs: options.transientRetryBaseMs ?? 5_000,
      transientRetryMaxMs: options.transientRetryMaxMs ?? 60_000,
      logger: options.logger,
    } as typeof this.options;
    if (this.options.concurrency < 1) throw new Error('concurrency must be positive');
    if (!Number.isSafeInteger(this.options.maxRetries) || this.options.maxRetries < 0) throw new Error('maxRetries must be a nonnegative integer');
    if (!Number.isSafeInteger(this.options.retryBaseMs) || this.options.retryBaseMs < 1) throw new Error('retryBaseMs must be a positive integer');
    if (!Number.isSafeInteger(this.options.transientMaxAttempts) || this.options.transientMaxAttempts < 1) throw new Error('transientMaxAttempts must be a positive integer');
    if (!Number.isSafeInteger(this.options.transientRetryBaseMs) || !Number.isSafeInteger(this.options.transientRetryMaxMs)
      || this.options.transientRetryBaseMs < 1 || this.options.transientRetryMaxMs < 1) throw new Error('transient retry timing must be positive integers');
    if (this.options.transientRetryBaseMs > this.options.transientRetryMaxMs) throw new Error('transientRetryBaseMs must not exceed transientRetryMaxMs');
  }

  get workerId(): string { return this.options.workerId; }
  get concurrency(): number { return this.options.concurrency; }

  /** Cancel this job's execution or pending shared-resource acquisition. */
  cancel(id: bigint, reason: Error = new Error('worker task cancelled')): void {
    this.active.get(id)?.controller.abort(reason);
  }

  start(): void {
    if (this.started) return;
    if (this.wakeController.signal.aborted) this.wakeController = new AbortController();
    this.started = true;
    this.stopping = false;
    void this.pump();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.wakeController.abort(new Error('worker shutdown'));
    if (this.timer) clearTimeout(this.timer);
    for (const task of this.active.values()) {
      task.controller.abort(new Error('worker shutdown'));
      clearInterval(task.heartbeat);
    }
    while (this.inFlightRuns.size) await Promise.allSettled([...this.inFlightRuns]);
    while (this.active.size) await new Promise((resolve) => setTimeout(resolve, 5));
    this.started = false;
  }

  async runOnce(): Promise<number> {
    const run = this.runOnceInternal();
    this.inFlightRuns.add(run);
    try { return await run; } finally { this.inFlightRuns.delete(run); }
  }

  private async runOnceInternal(): Promise<number> {
    if (this.stopping) return 0;
    const jobs = await this.claimBatch(this.options.concurrency - this.active.size);
    let claimed = 0;
    for (const job of jobs) {
      if (this.stopping) {
        await this.abandonClaim(job);
        continue;
      }
      claimed += 1;
      this.launch(job);
    }
    await this.sampleQueueDepth();
    return claimed;
  }

  private async pump(): Promise<void> {
    if (this.stopping) return;
    try {
      const claimed = await this.runOnce();
      this.claimFailureCount = 0;
      if (!this.stopping && claimed === 0 && this.options.service.waitForWork) {
        await this.options.service.waitForWork(waitChannel(this.options.kind), this.wakeController.signal);
        if (!this.stopping) return void this.pump();
      }
    } catch (error) {
      this.claimFailureCount += 1;
      const startedAt = performance.now();
      await runWithWorkerContext(
        {
          workerId: this.options.workerId,
          jobId: 'none',
          queryName: `worker.${this.options.kind}.claim`,
        },
        () => {
          updateRequestContext({ durationMs: performance.now() - startedAt });
          this.options.logger?.error?.('worker claim failed', error);
        },
      );
    }
    if (!this.stopping) {
      const backoff = this.claimFailureCount
        ? Math.min(30_000, Math.max(this.options.pollMs, this.options.retryBaseMs) * 2 ** Math.min(this.claimFailureCount - 1, 6))
        : this.options.pollMs;
      this.timer = setTimeout(() => void this.pump(), backoff);
    }
  }

  private async claimBatch(limit: number): Promise<ClaimedJob[]> {
    if (limit < 1) return [];
    const queue = queueName(this.options.kind);
    if (this.options.service.claimAvailable) {
      const claimed = await this.options.service.claimAvailable(queue, this.options.workerId, limit, this.options.leaseMs);
      return [...claimed];
    }
    const jobs: ClaimedJob[] = [];
    try {
      while (!this.stopping && jobs.length < limit) {
        const job = await this.options.service.claimNext(this.options.kind, this.options.workerId, this.options.leaseMs);
        if (!job) break;
        jobs.push(job);
      }
    } catch (error) {
      for (const job of jobs) await this.abandonClaim(job);
      throw error;
    }
    return jobs;
  }

  private settle(job: ClaimedJob): void {
    try { this.options.service.onSettled?.(this.options.kind, job.id, this.options.workerId); }
    catch (error) { this.options.logger?.warn?.('worker.local_cleanup_failed', error); }
  }

  private async abandonClaim(job: ClaimedJob): Promise<void> {
    try { await this.options.service.requeue(this.options.kind, job.id, this.options.workerId, 0, job.row.claim_token as string | undefined); }
    catch (error) { this.options.logger?.warn?.('worker.unstarted_requeue_failed', error); }
    finally { this.settle(job); }
  }

  private launch(job: ClaimedJob): void {
    const controller = new AbortController();
    const heartbeat = setInterval(() => {
      void this.options.service.heartbeat(this.options.kind, job.id, this.options.workerId, this.options.leaseMs, job.row.claim_token as string | undefined).catch((error) => {
        controller.abort(error);
      });
    }, this.options.heartbeatMs);
    this.active.set(job.id, { controller, heartbeat });
    void this.execute(job, controller).finally(() => {
      clearInterval(heartbeat);
      this.active.delete(job.id);
      this.settle(job);
    });
  }

  private async execute(job: ClaimedJob, controller: AbortController): Promise<void> {
    const startedAt = performance.now();
    await runWithWorkerContext(
      {
        workerId: this.options.workerId,
        jobId: job.id,
        queryName: `worker.${this.options.kind}`,
      },
      async () => {
        updateRequestContext({ durationMs: 0 });
        let lease: AiLease | undefined;
        let aiHeartbeat: ReturnType<typeof setInterval> | undefined;
        let phase: 'prepare' | 'acquire' | 'handle' | 'complete' = 'prepare';
        try {
          await this.options.beforeExecute?.(job, controller.signal);
          phase = 'acquire';
          if (this.options.aiCoordinator && this.options.aiStage && (this.options.usesAiLease?.(job) ?? true)) {
            lease = await this.options.aiCoordinator.acquire({ workerId: this.options.workerId, stage: this.options.aiStage, signal: controller.signal });
            aiHeartbeat = setInterval(() => { void lease!.heartbeat().catch((error) => controller.abort(error)); }, this.options.heartbeatMs);
          }
          phase = 'handle';
          await this.options.handler(job, controller.signal, lease ? { aiLease: lease } : undefined);
          phase = 'complete';
          if (controller.signal.aborted) {
            await this.options.service.requeue(this.options.kind, job.id, this.options.workerId, 0, job.row.claim_token as string | undefined);
            this.recordWorker('requeued', startedAt);
            this.logWorker('worker.requeued', startedAt);
          } else {
            await this.options.service.complete(this.options.kind, job.id, this.options.workerId);
            this.recordWorker('succeeded', startedAt);
            this.logWorker('worker.completed', startedAt);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (controller.signal.aborted) {
            try {
              await this.options.service.requeue(this.options.kind, job.id, this.options.workerId, 0, job.row.claim_token as string | undefined);
            } catch (failure) {
              this.logWorker('worker.requeue_failed', startedAt, 'warn', failure);
            }
            this.recordWorker('requeued', startedAt);
            this.logWorker('worker.requeued', startedAt);
            return;
          }
          const structured = readStructuredFailure(error);
          const infrastructureFailure = message === 'AI_CONCURRENCY_UNAVAILABLE' || message === 'AI_CONCURRENCY_QUEUE_TIMEOUT';
          const localFailure = this.options.kind === 'ai_batch'
            && (phase === 'prepare' || phase === 'acquire' || job.row.step === 'publish' || job.row.step === 'done');
          const retryClass = structured?.retryClass ?? (localFailure ? 'local' : infrastructureFailure ? 'network' : classifyRetryClass(message));
          const transientRetry = retryClass === 'network' && Number(job.attempts) < this.options.transientMaxAttempts;
          // Retry only failures that may recover without changing the business input.
          // Semantic, validation, policy, and configuration errors are terminal.
          // maxRetries counts retries after the first local attempt. Batch
          // attempts restart when a validated decision enters publish.
          const retry = infrastructureFailure || (localFailure
            ? Number(job.attempts) <= this.options.maxRetries && (structured?.retryable ?? true)
            : (structured?.retryable ?? transientRetry));
          const ordinaryDelay = boundedBackoff(this.options.retryBaseMs, job.attempts, this.options.transientRetryMaxMs);
          const transientDelay = boundedBackoff(this.options.transientRetryBaseMs, job.attempts, this.options.transientRetryMaxMs);
          const delay = transientRetry || retryClass === 'provider_transient' ? transientDelay : ordinaryDelay;
          try {
            await this.options.service.fail(this.options.kind, job.id, this.options.workerId, message, {
              retry,
              backoffMs: retry ? delay : 0,
              retryClass,
              ...(this.options.kind === 'assistant_turn' && typeof job.row.claim_token === 'string'
                ? { claimToken: job.row.claim_token } : {}),
            });
            this.recordWorker(retry ? 'requeued' : 'failed', startedAt);
            this.logWorker('worker.failed', startedAt, 'error', { error });
          } catch (failure) {
            this.logWorker('worker.state_transition_failed', startedAt, 'warn', failure);
          }
        } finally {
          if (aiHeartbeat) clearInterval(aiHeartbeat);
          if (lease) {
            try { await lease.release(); }
            catch (error) { this.logWorker('worker.ai_lease_release_failed', startedAt, 'warn', error); }
          }
        }
      },
    );
  }

  private recordWorker(
    status: 'succeeded' | 'failed' | 'requeued',
    startedAt: number,
  ): void {
    this.options.metrics?.recordWorker({
      kind: this.options.kind,
      status,
      durationMs: performance.now() - startedAt,
    });
  }

  private logWorker(
    message: string,
    startedAt: number,
    level: 'log' | 'error' | 'warn' = 'log',
    details?: unknown,
  ): void {
    updateRequestContext({ durationMs: performance.now() - startedAt });
    this.options.logger?.[level]?.(message, details);
  }

  private async sampleQueueDepth(): Promise<void> {
    const queueDepth = this.options.service.queueDepth;
    if (!this.options.metrics || !queueDepth) return;
    const now = Date.now();
    if (now - this.lastQueueSampleAt < 10_000) return;
    this.lastQueueSampleAt = now;
    try {
      this.options.metrics.setQueueDepth(
        this.options.kind,
        await queueDepth.call(this.options.service, this.options.kind),
      );
    } catch (error) {
      const startedAt = performance.now();
      await runWithWorkerContext(
        {
          workerId: this.options.workerId,
          jobId: 'none',
          queryName: `worker.${this.options.kind}.queue_depth`,
        },
        () => {
          updateRequestContext({ durationMs: performance.now() - startedAt });
          this.options.logger?.warn?.('worker queue depth failed', error);
        },
      );
    }
  }
}

function boundedBackoff(baseMs: number, attempts: bigint, maxMs: number): number {
  const maxExponent = Math.max(0, Math.ceil(Math.log2(maxMs / baseMs)));
  const exponent = Math.min(Math.max(0, Number(attempts - 1n)), maxExponent);
  return Math.min(baseMs * 2 ** exponent, maxMs);
}

function readStructuredFailure(error: unknown): { retryClass: string; retryable: boolean } | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const retryClass = Reflect.get(error, 'retryClass');
  const retryable = Reflect.get(error, 'retryable');
  return typeof retryClass === 'string' && typeof retryable === 'boolean' ? { retryClass, retryable } : undefined;
}

function queueName(kind: QueueKind): QueueName {
  switch (kind) {
    case 'fetch_run': return 'fetch';
    case 'ai_batch': return 'ai_standardization';
    case 'assistant_turn': return 'assistant';
  }
}

function waitChannel(kind: QueueKind): string {
  return kind === 'ai_batch' ? 'ai_job_progress_changed' : `queue_${queueName(kind)}`;
}
