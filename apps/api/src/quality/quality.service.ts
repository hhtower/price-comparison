import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { BadGatewayException, BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { WorkerRuntime, type WorkerRuntimeService } from '../workers/worker-runtime.js';
import type { AiConcurrencyCoordinator } from '../ai/ai-concurrency.js';
import { readAiConcurrency } from '../ai/ai-concurrency.js';
import type { ClaimedJob } from '../jobs/jobs.repository.js';
import { QUALITY_CATALOG } from './quality.catalog.js';
import { buildQualityReport, validateQualityItem, validateQualityReport } from './quality-report.js';
import { maskQualityTarget, parseIpTarget, validateQualityInput, validateQualityModelInput } from './quality-input.js';
import { createQualityModelLister, type QualityModelLister } from './quality-models.js';
import { planAiQualityWork } from './ai-quality-work.js';
import { validateQualityProgress } from './quality-evidence.js';
import type { QualityReportStore, StoredQualityReport } from './quality.repository.js';
import type { AiQualityInput, IpQualityInput, QualityDetector, QualityInput, QualityItemResult, QualityProgress, QualityReport, QualityState } from './quality.types.js';

interface Task {
  units: WorkUnit[]; accessHash: string; identityHash: string; input?: QualityInput; selected: string[];
  report: QualityReport; results: Map<string, QualityItemResult>; completedItems: Set<string>; controller: AbortController;
  listeners: Set<(report: QualityReport) => void>; timer: ReturnType<typeof setTimeout>;
  sealed: boolean; finalizing?: Promise<QualityReport>; expiresAt: number;
}
interface WorkUnit { sequence: bigint; task: Task; items: string[]; measurement: boolean; claimed: boolean; completed: boolean; progress?: QualityProgress; }
export interface QualityServiceOptions {
  repository: QualityReportStore; aiDetector: QualityDetector<AiQualityInput>; ipDetector: QualityDetector<IpQualityInput>;
  coordinator?: AiConcurrencyCoordinator; aiConcurrency?: number; taskTimeoutMs?: number; maxTasks?: number; reportTtlMs?: number;
  close?: () => void;
  modelLister?: QualityModelLister;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const terminal = (state: QualityState) => ['completed', 'cancelled', 'failed'].includes(state);
function identity(input: QualityInput): string {
  if (input.kind === 'ai') return hash(JSON.stringify([input.kind, input.endpoint, input.model]));
  const target = parseIpTarget(input.target)!;
  return hash(JSON.stringify([input.kind, target.type, target.host.toLowerCase(), target.port, target.username]));
}

/** Ephemeral credential queue, scheduled exclusively by the shared WorkerRuntime. */
export class QualityService {
  private readonly tasks = new Map<string, Task>();
  private readonly modelRequests = new Set<AbortController>();
  private readonly bySequence = new Map<bigint, WorkUnit>();
  private readonly runtime: WorkerRuntime;
  private nextSequence = 0n;
  private closed = false;
  constructor(private readonly options: QualityServiceOptions) {
    const adapter: WorkerRuntimeService = {
      claimNext: async (_kind, workerId, leaseMs) => {
        const unit = [...this.bySequence.values()].find(item => !item.claimed && !item.task.sealed && (item.measurement || item.task.units.every(other => !other.measurement || other.completed)));
        if (!unit) return null;
        unit.claimed = true;
        return { id: unit.sequence, kind: 'ai_batch', attempts: 1n, claimed_by: workerId, lease_until: new Date(Date.now() + leaseMs), row: {} } satisfies ClaimedJob;
      },
      heartbeat: async () => {}, complete: async () => {},
      fail: async (_kind, id) => { const task = this.bySequence.get(id)?.task; if (task) await this.finish(task, 'failed', '检测运行环境不可用，请稍后重试。'); },
      requeue: async (_kind, id) => { const task = this.bySequence.get(id)?.task; if (task) await this.finish(task, this.closed ? 'cancelled' : 'failed', this.closed ? '服务停止，检测取消。' : '检测执行被中断，请重试。'); },
    };
    const concurrency = options.aiConcurrency ?? readAiConcurrency();
    this.runtime = new WorkerRuntime({ service: adapter, kind: 'ai_batch', workerId: 'quality-' + randomUUID(), concurrency, aiConcurrency: concurrency, aiCoordinator: options.coordinator, aiStage: 'quality', usesAiLease: job => this.bySequence.get(job.id)?.task.input?.kind === 'ai', pollMs: 100, handler: (job, signal) => this.execute(job.id, signal) });
  }
  onModuleInit(): void { this.runtime.start(); }
  async runOnce(): Promise<number> { return this.runtime.runOnce(); }
  async onModuleDestroy(): Promise<void> {
    this.closed = true;
    for (const controller of this.modelRequests) controller.abort();
    await Promise.all([...this.tasks.values()].filter(task => !task.sealed).map(task => this.finish(task, 'cancelled', '服务停止，检测取消。')));
    await this.runtime.stop();
    for (const task of this.tasks.values()) { clearTimeout(task.timer); task.listeners.clear(); delete task.input; }
    this.tasks.clear(); this.bySequence.clear();
    this.options.close?.();
  }
  async create(value: unknown): Promise<{ id: string; accessToken: string }> {
    let input: QualityInput;
    try { input = validateQualityInput(value); } catch (error) { throw new BadRequestException(error instanceof Error ? error.message : '检测配置无效'); }
    return this.enqueue(input);
  }
  async models(value: unknown, signal: AbortSignal): Promise<{ models: string[] }> {
    let input;
    try { input = validateQualityModelInput(value); } catch { throw new BadRequestException('请检查 Base URL 和 API Key'); }
    if (this.closed || signal.aborted || this.modelRequests.size >= (this.options.maxTasks ?? 32)) throw new ServiceUnavailableException('模型列表服务暂时不可用');
    const controller = new AbortController();
    this.modelRequests.add(controller);
    try {
      const list = this.options.modelLister ?? createQualityModelLister();
      return { models: await list(input, AbortSignal.any([signal, controller.signal])) };
    } catch { throw new BadGatewayException('无法获取模型列表，请检查地址或凭据，也可手动输入模型'); }
    finally { this.modelRequests.delete(controller); }
  }
  async read(id: string, token: string): Promise<QualityReport> { return structuredClone((await this.authorize(id, token)).report); }
  async subscribe(id: string, token: string, listener: (report: QualityReport) => void): Promise<() => void> {
    const stored = await this.authorize(id, token);
    const task = this.tasks.get(id);
    if (task && !terminal(task.report.state)) {
      if (task.listeners.size >= 8) throw new ServiceUnavailableException('当前任务连接过多');
      task.listeners.add(listener);
    }
    listener(structuredClone(stored.report));
    return () => task?.listeners.delete(listener);
  }
  async cancel(id: string, token: string): Promise<QualityReport> {
    const current = await this.authorize(id, token);
    const task = this.tasks.get(id);
    return task && !terminal(task.report.state) ? this.finish(task, 'cancelled', '用户取消，尚未完成此项。') : structuredClone(current.report);
  }
  async retest(id: string, token: string, value: unknown): Promise<{ id: string; accessToken: string }> {
    const parent = await this.authorize(id, token);
    if (!terminal(parent.report.state)) throw new BadRequestException('请等待当前检测结束');
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['itemIds', 'input'].includes(key))) throw new BadRequestException('重测配置无效');
    const body = value as { itemIds: unknown; input: unknown };
    let input: QualityInput;
    try { input = validateQualityInput(body.input); } catch { throw new BadRequestException('请重新填写完整检测配置与凭据'); }
    if (identity(input) !== parent.identityHash) throw new BadRequestException('目标已变化，请创建新检测');
    const catalogue = QUALITY_CATALOG[input.kind];
    if (!Array.isArray(body.itemIds) || !body.itemIds.length || body.itemIds.length > catalogue.length || new Set(body.itemIds).size !== body.itemIds.length || body.itemIds.some(id => typeof id !== 'string' || !catalogue.some(item => item.id === id && !(input.kind === 'ip' && item.proxyOnly && parseIpTarget(input.target)?.type !== 'socks')))) throw new BadRequestException('该项需要支持的检测目标');
    return this.enqueue(input, parent.report, body.itemIds as string[]);
  }
  private enqueue(input: QualityInput, parent?: QualityReport, itemIds?: string[]): { id: string; accessToken: string } {
    if (this.closed) throw new ServiceUnavailableException('检测服务正在停止');
    for (const [id, task] of this.tasks) if (terminal(task.report.state) && task.expiresAt <= Date.now()) { this.tasks.delete(id); for (const unit of task.units) this.bySequence.delete(unit.sequence); }
    if ([...this.tasks.values()].filter(task => !task.sealed).length >= (this.options.maxTasks ?? 32)) throw new ServiceUnavailableException('检测任务已满，请稍后重试');
    // Bound retained memory; terminal reports remain available in PostgreSQL.
    if (this.tasks.size >= 128) { const old = [...this.tasks.entries()].find(([, task]) => terminal(task.report.state)); if (old) { this.tasks.delete(old[0]); for (const unit of old[1].units) this.bySequence.delete(unit.sequence); } }
    const id = randomUUID(); const accessToken = randomBytes(32).toString('base64url'); const catalogue = QUALITY_CATALOG[input.kind];
    const isPlainIp = input.kind === 'ip' && parseIpTarget(input.target)?.type !== 'socks';
    const selected = itemIds ? [...itemIds] : input.kind === 'ai' ? [...input.items] : catalogue.filter(item => !isPlainIp || !item.proxyOnly).map(item => item.id);
    const results = new Map(catalogue.map(item => {
      const existing = parent?.items.find(candidate => candidate.id === item.id);
      const result: QualityItemResult = itemIds && !selected.includes(item.id) && existing ? validateQualityItem(existing) : isPlainIp && item.proxyOnly ? { id: item.id, status: 'unavailable', score: null, summary: '需要 SOCKS5 地址执行真实出口测试。' } : { id: item.id, status: 'unrun', score: null, summary: selected.includes(item.id) ? '已选择，等待检测完成。' : '未纳入当前范围，可加入检测或单项重测。', ...(!selected.includes(item.id) ? { reason: 'not-selected' as const } : {}) };
      return [item.id, result];
    }));
    const base = { id, kind: input.kind, state: 'queued' as const, target: maskQualityTarget(input), ...(input.kind === 'ai' ? { model: input.model } : {}), createdAt: new Date().toISOString(), configuration: { runs: input.runs, mode: input.kind === 'ai' ? input.mode : null, selected }, progress: [] };
    const task: Task = { units: [], accessHash: hash(accessToken), identityHash: identity(input), input, selected, results, completedItems: new Set(), report: buildQualityReport(base, [...results.values()]), controller: new AbortController(), listeners: new Set(), sealed: false, expiresAt: Date.now() + (this.options.reportTtlMs ?? 86_400_000), timer: setTimeout(() => { void this.finish(task, 'failed', '检测超时，请重试。'); }, this.options.taskTimeoutMs ?? 600_000) };
    task.units = (input.kind === 'ai' ? planAiQualityWork(selected) : [{ items: selected, measurement: false }]).map(plan => ({ ...plan, sequence: ++this.nextSequence, task, claimed: false, completed: false }));
    task.timer.unref?.();
    this.tasks.set(id, task); for (const unit of task.units) this.bySequence.set(unit.sequence, unit);
    return { id, accessToken };
  }
  private async authorize(id: string, token: string): Promise<StoredQualityReport> {
    if (typeof token !== 'string' || token.length < 20 || token.length > 256) throw new NotFoundException('检测任务不存在或已过期');
    const task = this.tasks.get(id);
    const stored = task && task.expiresAt > Date.now() ? task : await this.options.repository.read(id);
    if (!stored || !timingSafeEqual(Buffer.from(hash(token)), Buffer.from(stored.accessHash))) throw new NotFoundException('检测任务不存在或已过期');
    return stored;
  }
  private emit(task: Task): void {
    for (const listener of task.listeners) { try { listener(structuredClone(task.report)); } catch { task.listeners.delete(listener); } }
    if (terminal(task.report.state)) task.listeners.clear();
  }
  private async execute(sequence: bigint, runtimeSignal: AbortSignal): Promise<void> {
    const unit = this.bySequence.get(sequence);
    const task = unit?.task;
    if (!unit || !task || task.sealed || !task.input) return;
    const input = task.input;
    const signal = AbortSignal.any([task.controller.signal, runtimeSignal]);
    const publish = () => {
      task.report = buildQualityReport({ ...task.report, state: 'running', progress: task.units.flatMap(current => current.progress ? [current.progress] : []) }, [...task.results.values()]); this.emit(task);
    };
    publish();
    const onProgress = (value: QualityProgress) => {
      if (unit.completed || task.sealed || signal.aborted) return;
      if (!unit.items.includes(value.itemId) || task.completedItems.has(value.itemId) || task.results.get(value.itemId)?.status !== 'unrun') throw new Error('检测器返回无效进度');
      [unit.progress] = validateQualityProgress([value], task.report.configuration, 'running');
      publish();
    };
    const onItem = (value: QualityItemResult) => {
      if (unit.completed || task.sealed || signal.aborted) return;
      if (!unit.items.includes(value.id)) throw new Error('检测器返回范围外结果');
      const result = validateQualityItem(value);
      const secrets = input.kind === 'ai' ? [input.apiKey] : [parseIpTarget(input.target)?.password];
      // Fixed IDs, status enums and scores can legitimately equal a short password.
      // Hide sensitive free text without changing the observed result or exposing it
      // in progress snapshots. Compare decoded strings, before JSON escaping.
      const sensitive = (text: string | undefined) => text && secrets.some(secret => secret && text.includes(secret));
      if (sensitive(result.summary)) result.summary = '此项结果已记录，敏感说明已隐藏。';
      if (sensitive(result.impact)) delete result.impact;
      // Validate the candidate snapshot before mutating shared task state. A bad
      // callback must not poison terminal validation or suppress the one save.
      const candidateResults = new Map(task.results); candidateResults.set(result.id, result);
      const progress = task.units.flatMap(current => current.progress && !(current === unit && current.progress.itemId === result.id) ? [current.progress] : []);
      const report = buildQualityReport({ ...task.report, state: 'running', progress }, [...candidateResults.values()]);
      task.results.set(result.id, result); task.completedItems.add(result.id);
      if (unit.progress?.itemId === result.id) delete unit.progress;
      task.report = report; this.emit(task);
    };
    try {
      const results = input.kind === 'ai' ? await this.options.aiDetector(input, unit.items, signal, onItem, onProgress) : await this.options.ipDetector(input, unit.items, signal, onItem, onProgress);
      signal.throwIfAborted();
      if (!Array.isArray(results) || results.length !== unit.items.length || new Set(results.map(item => item.id)).size !== results.length || results.some(item => !unit.items.includes(item.id))) throw new Error('检测结果不完整');
      for (const item of results) onItem(item);
      unit.completed = true; delete unit.progress;
      if (task.units.every(current => current.completed)) await this.finish(task, 'completed');
      else publish();
    } catch {
      if (!task.sealed) await this.finish(task, this.closed ? 'cancelled' : 'failed', this.closed ? '服务停止，检测取消。' : '检测请求失败或结果无效，请重试。');
    }
  }
  private finish(task: Task, state: 'completed' | 'cancelled' | 'failed', message?: string): Promise<QualityReport> {
    if (task.finalizing) return task.finalizing;
    task.sealed = true; clearTimeout(task.timer);
    if (state !== 'completed') {
      const reason = new Error(state === 'cancelled' ? '检测取消' : '检测超时或失败');
      task.controller.abort(reason);
      for (const unit of task.units) this.runtime.cancel(unit.sequence, reason);
    }
    delete task.input;
    task.finalizing = (async () => {
      if (state !== 'completed') for (const id of task.selected) {
        const current = task.results.get(id)!;
        if (!task.completedItems.has(id) && current.status === 'unrun') task.results.set(id, { id, status: state === 'cancelled' ? 'cancelled' : 'risk', score: null, summary: message ?? '检测未完成。' });
      }
      const completedAt = new Date().toISOString();
      for (const unit of task.units) delete unit.progress;
      let report = validateQualityReport(buildQualityReport({ ...task.report, state, completedAt, progress: [] }, [...task.results.values()]));
      try { await this.options.repository.save(report, task.accessHash, task.identityHash, new Date(task.expiresAt)); }
      catch {
        // No partial/fallback database write; make storage failure visible in the live report.
        const id = task.selected[0];
        if (id) task.results.set(id, { id, status: 'risk', score: null, summary: '报告保存失败，请稍后重新检测。' });
        report = buildQualityReport({ ...task.report, state: 'failed', completedAt, progress: [] }, [...task.results.values()]);
      }
      task.report = report; this.emit(task); return structuredClone(report);
    })();
    return task.finalizing;
  }
}
