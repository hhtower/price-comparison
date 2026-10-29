import { randomUUID } from 'node:crypto';
import { WorkerRuntime, type WorkerRuntimeOptions, type WorkerRuntimeService, type WorkerLogger } from '../workers/worker-runtime.js';
import type { AiRepository, AiBatchResultMetadata } from './ai.repository.js';
import { parseStandardizationProtocolResponse, type ParsedStandardizationResponse } from './ai.schemas.js';
import { createStreamingCall, type StreamingUsage } from './llm-runtime.js';
import { classifyRetryClass } from '../jobs/jobs.repository.js';
import { recordAiTimingSafely, type AiTimingRecorder } from '../observability/ai-metrics.js';
import { validateStandardizationEvidence } from './standardization-evidence.js';
import { classifyProviderRequestFailure } from './standardization-state.js';
import { buildStandardizationRequest, assertStandardizationRequestFits, readStandardizationRequestLimits } from './standardization-request.js';
import { buildTagExtractionRequest, parseTagExtractionResponse } from './tag-extraction-request.js';
import { validateReviewedTagExtractionDecision, type TagExtractionDecision } from './tag-extraction-result.js';
import { buildTagReviewRequest, parseTagReviewResponse, type TagReviewResponse } from './tag-review-request.js';
import { buildExtractionPayload } from './adaptive-batching.js';
import type { JsonValue } from '../database/types.js';
import { buildResponseAudit } from './response-audit.js';
import { buildStandardizationReviewRequest, parseStandardizationReviewResponse } from './standardization-review-request.js';
export { buildStandardizationRequest, estimateStandardizationRequest, assertStandardizationRequestFits, readStandardizationRequestLimits } from './standardization-request.js';

export type StandardizationModelResult = ParsedStandardizationResponse & { standardizationStage?: 'generate' | 'review'; tagExtractionItems?: TagExtractionDecision[]; tagExtractionStage?: 'extract' | 'review'; metadata?: AiBatchResultMetadata & {
  usage?: StreamingUsage | null; responseModel?: string | null; responseId?: string | null;
} };
export type StandardizationModelCall = ((job: any, signal: AbortSignal) => Promise<StandardizationModelResult>) & {
  /** Prepare the exact immutable request before spending its shared reservation. */
  prepare?: (job: any, signal: AbortSignal) => Promise<() => Promise<StandardizationModelResult>>;
};
type ProviderRequestOutcome = 'confirmed' | 'unknown';
type StructuredWorkerFailure = Error & {
  readonly retryClass: 'provider_transient' | 'provider_unknown' | 'provider_terminal' | 'provider_policy_rejection' | 'invalid_response' | 'result_not_saved';
  readonly retryable: boolean;
  readonly requestOutcome?: ProviderRequestOutcome;
  readonly responseMetadata?: AiBatchResultMetadata;
};
type FactoryOptions = Omit<Partial<WorkerRuntimeOptions>, 'service' | 'kind' | 'handler' | 'beforeExecute' | 'usesAiLease'> & {
  repository?: AiRepository;
  modelCall?: StandardizationModelCall;
  aiMetrics?: AiTimingRecorder;
};

export function createAiWorker(service: WorkerRuntimeService, options: FactoryOptions = {}): WorkerRuntime {
  if (options.modelCall && !options.repository) throw new Error('AI repository is required with modelCall');
  const workerId = options.workerId ?? `ai-${randomUUID()}`;
  const handler = options.modelCall ? async (job: any, signal: AbortSignal, context?: { aiLease?: { queueWaitMs: number } }) => {
    if (job.row.step === 'prepare') return;
    if (job.row.step === 'publish') {
      const claim = {
        workerId: job.claimed_by,
        attempt: job.attempts,
        token: typeof job.row.claim_token === 'string' ? job.row.claim_token : undefined,
      };
      if (job.row.job_type === 'tag_extraction') await options.repository!.publishTagExtractionBatch(BigInt(job.id), claim);
      else await options.repository!.publishBatch(BigInt(job.id), claim);
      return;
    }
    const startedAt = performance.now();
    let metadata: AiBatchResultMetadata | undefined;
    let modelReturned = false;
    try {
      let execute = options.modelCall!.prepare
        ? await options.modelCall!.prepare(job, signal)
        : () => options.modelCall!(job, signal);
      signal.throwIfAborted();
      while (true) {
        const reservation = await options.repository!.reserveBatchRequest(BigInt(job.id), {
          workerId: job.claimed_by,
          attempt: job.attempts,
          token: typeof job.row.claim_token === 'string' ? job.row.claim_token : undefined,
        });
        if (reservation === 'skipped') return;
        if (reservation !== 'refresh') break;
        if (!options.modelCall!.prepare) throw new Error('model call cannot refresh a changed batch');
        await options.repository!.prepareBatch(BigInt(job.id), signal);
        execute = await options.modelCall!.prepare(job, signal);
        signal.throwIfAborted();
      }
      let result: StandardizationModelResult;
      try {
        result = await execute();
      } catch (error) {
        const failure = classifyProviderFailure(error);
        metadata = failure.responseMetadata;
        await options.repository!.recordBatchRequestOutcome(BigInt(job.id), failure.requestOutcome ?? 'unknown', metadata, {
          workerId: job.claimed_by, attempt: job.attempts, token: typeof job.row.claim_token === 'string' ? job.row.claim_token : undefined,
        }).catch(() => {
          try { options.logger?.warn?.('ai.response_audit_failed', { batchId: String(job.id) }); } catch { /* Keep the original request failure. */ }
        });
        throw failure;
      }
      modelReturned = true;
      metadata = result.metadata;
      const tagItems = result.tagExtractionItems;
      if (tagItems) {
        await options.repository!.checkpointTagExtractionBatchDecision(BigInt(job.row.job_id), BigInt(job.id), tagItems, metadata, {
          workerId: job.claimed_by, attempt: job.attempts, token: typeof job.row.claim_token === 'string' ? job.row.claim_token : undefined,
        }, result.tagExtractionStage);
      } else {
        await options.repository!.persistBatchDecision(BigInt(job.row.job_id), BigInt(job.id), result, metadata, {
          workerId: job.claimed_by, attempt: job.attempts, token: typeof job.row.claim_token === 'string' ? job.row.claim_token : undefined,
        }, result.standardizationStage);
      }
      await recordAiTimingSafely(options.aiMetrics, timing(null), options.logger);
    } catch (error) {
      const failure = modelReturned ? workerFailure(error, 'result_not_saved', false) : error;
      const retryClass = structuredFailure(failure)?.retryClass ?? classifyRetryClass(failure instanceof Error ? failure.message : String(failure));
      await recordAiTimingSafely(options.aiMetrics, timing(retryClass), options.logger);
      throw failure;
    }
    function timing(retryClass: string | null) {
      return { stage: 'standardization' as const, workerId, jobId: BigInt(job.row.job_id), taskId: BigInt(job.id), queueWaitMs: context?.aiLease?.queueWaitMs ?? 0, firstContentMs: metadata?.firstContentMs ?? null, responseMs: metadata?.responseMs ?? Math.round(performance.now() - startedAt), inputBytes: Number(job.row.input_bytes ?? 0), outputBytes: metadata?.outputBytes ?? 0, retryClass };
    }
  } : async (_job: any, signal: AbortSignal) => { if (signal.aborted) throw signal.reason ?? new Error('cancelled'); throw new Error('worker model handler is not configured'); };

  return new WorkerRuntime({
    ...options,
    service,
    kind: 'ai_batch',
    workerId,
    beforeExecute: options.repository ? (job, signal) => job.row.step === 'prepare'
      ? options.repository!.prepareTagJob(job.id,{workerId:job.claimed_by,attempt:job.attempts,token:String(job.row.claim_token)},signal)
      : options.repository!.prepareBatch(job.id, signal) : undefined,
    usesAiLease: job => job.row.step === 'request',
    handler,
  });
}

export function createOpenAiModelCall(repository: AiRepository, environment: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch, logger?: WorkerLogger): StandardizationModelCall {
  const baseUrl = environment.AI_BASE_URL?.trim();
  const apiKey = environment.AI_API_KEY?.trim();
  const model = environment.AI_MODEL?.trim();
  const timeoutMs = Number(environment.AI_TIMEOUT_MS ?? 30_000);
  if (!baseUrl || !apiKey || !model || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('AI worker configuration is incomplete');
  const streamCall = createStreamingCall(environment, fetchImpl, logger);
  const limits = readStandardizationRequestLimits(environment);
  const prepare: NonNullable<StandardizationModelCall['prepare']> = async (claimed, signal) => {
    signal.throwIfAborted();
    // Tag extraction jobs take a different path: no candidate catalog, simpler prompt.
    if (claimed.row?.job_type === 'tag_extraction') {
      const { jobId, model, inputs, stage = 'extract', proposals } = await repository.getTagExtractionBatchInputs(BigInt(claimed.id));
      const payloads = inputs.map(i => ({ ...(i.payload && typeof i.payload === 'object' && !Array.isArray(i.payload) ? i.payload : {}),
        id: i.productId.toString(), name: i.name, spec: i.spec as string | null, sourceData: i.sourceData }));
      if (stage === 'review' && !proposals) throw new Error('tag review proposals are missing');
      const built = stage === 'review' ? buildTagReviewRequest(payloads, proposals!, model) : buildTagExtractionRequest(payloads, model);
      assertStandardizationRequestFits(built, limits);
      signal.throwIfAborted();
      const context = { parentJobId: String(jobId), batchId: String(claimed.id), model, inputCount: inputs.length, tagStage: stage };
      return async () => {
        const response = await streamCall({
          model: built.model, messages: built.messages, responseFormat: built.responseFormat,
          includeUsage: true, maxOutputTokens: limits.outputReserveTokens, signal, context,
        });
        let phase: 'json' | 'schema' | 'evidence' = 'json';
        try {
          if (response.finishReason !== 'stop') throw new Error('AI response has invalid completion reason');
          phase = 'schema';
          const parsed = stage === 'review' ? parseTagReviewResponse(response.content) : parseTagExtractionResponse(response.content);
          if (parsed.items.length !== inputs.length || new Set(parsed.items.map(item => item.id)).size !== parsed.items.length
            || parsed.items.some(item => !inputs.some(input => String(input.productId) === item.id)))
            throw new Error('Tag extraction response IDs do not match inputs');
          if (stage === 'review') {
            for (const proposed of proposals!.items) {
              const reviewed = (parsed as TagReviewResponse).items.find(item => item.id === proposed.id);
              if (!reviewed || reviewed.decisions.length !== proposed.tags.length) {
                throw new Error('Tag review must return one binary decision per proposed tag');
              }
            }
          }
          phase = 'evidence';
          const items = parsed.items.map(item => {
            const input = inputs.find(i => i.productId.toString() === item.id);
            const payload = input!.payload ?? buildExtractionPayload({ id: item.id, name: input!.name, spec: input!.spec, sourceData: input!.sourceData as JsonValue });
            if (stage === 'review') {
              const reviewed = item as TagReviewResponse['items'][number];
              const proposed = proposals!.items.find(candidate => candidate.id === item.id)!;
              const original = proposed.tags.map((tag, proposalIndex) => ({ proposalIndex, name: tag.name, value: tag.value, evidence: [{ path: tag.path, quote: tag.quote }] }));
              return validateReviewedTagExtractionDecision(input!.productId,
                original.filter((_tag, index) => reviewed.decisions[index]),
                original.filter((_tag, index) => !reviewed.decisions[index]).map(tag =>
                  ({ ...tag, reasonCode: 'review_rejected', reason: 'LLM 对该标签判定为否' })), payload, reviewed.decisions, reviewed.textReview);
            }
            const tags = (item as ReturnType<typeof parseTagExtractionResponse>['items'][number]).tags
              .map(t => ({ name: t.name, value: t.value, evidence: [{ path: t.path, quote: t.quote }] }));
            return { productId: input!.productId, tags, rejectedTags: [] };
          });
          const metadata = { ...buildResponseAudit(response, inputs.length, phase), retryClass: null };
          metadata.responseDiagnostic.returnedItemCount = items.length;
          metadata.responseDiagnostic.missingItemCount = inputs.length - items.length;
          metadata.responseDiagnostic.rejectedItemCount = items.filter(item => item.rejectedTags.length > 0).length;
          metadata.responseDiagnostic.code = metadata.responseDiagnostic.rejectedItemCount ? 'items_rejected'
            : items.length < inputs.length ? 'items_missing' : 'accepted';
          return { items: [], identities: [], missingIds: [], metadata, tagExtractionItems: items, tagExtractionStage: stage };
        } catch (error) {
          // The tag parser uses generic errors; classify JSON only on failure to avoid parsing successes twice.
          if (phase === 'schema') {
            try { JSON.parse(response.content); } catch { phase = 'json'; }
          }
          const failure = workerFailure(error instanceof SyntaxError ? new Error('AI response JSON is invalid') : error, 'invalid_response', false, 'confirmed');
          const responseMetadata = buildResponseAudit(response, inputs.length, phase, undefined, error);
          Object.assign(failure, { responseMetadata });
          try { logger?.log?.('ai.validation_failed', { ...context, ...responseMetadata }); } catch { /* Preserve the original validation failure. */ }
          throw failure;
        }
      };
    }
    const request = structuredClone(await repository.getBatchRequest(BigInt(claimed.id)));
    const stage = request.stage ?? 'generate';
    if (stage === 'review' && !request.proposals) throw new Error('standardization review proposals are missing');
    const generation = stage === 'generate' ? buildStandardizationRequest(request) : undefined;
    const built = generation ?? buildStandardizationReviewRequest(request, request.proposals!);
    assertStandardizationRequestFits(built, limits);
    signal.throwIfAborted();
    const context = { parentJobId: String(request.jobId), batchId: String(claimed.id), model: request.model, inputCount: request.inputs.length, standardizationStage: stage };
    return async () => {
      const response = await streamCall({
        model: built.model, messages: built.messages, responseFormat: built.responseFormat,
        includeUsage: true, maxOutputTokens: limits.outputReserveTokens, signal, context,
      });
      let result: StandardizationModelResult;
      let phase: 'json' | 'schema' | 'evidence' = 'json';
      try {
        if (response.finishReason !== 'stop') throw new Error('AI response has invalid completion reason');
        const parsed = generation?.parseResponse(response.content);
        phase = 'schema';
        const decisions = stage === 'review'
          ? parseStandardizationReviewResponse(response.content, request.proposals!)
          : parseStandardizationProtocolResponse(parsed, generation!.protocolInputs);
        phase = 'evidence';
        result = stage === 'review' ? decisions : validateStandardizationEvidence(
          decisions,
          request.inputs.map(input => ({ id: input.productId.toString(), payload: input.payload })), request.candidates, 'boundary',
        ) as StandardizationModelResult;
      } catch (error) {
        if (stage === 'review' && phase === 'schema') {
          try { JSON.parse(response.content); } catch { phase = 'json'; }
        }
        const failure = workerFailure(error instanceof SyntaxError ? new Error('AI response JSON is invalid') : error, 'invalid_response', false, 'confirmed');
        const responseMetadata = buildResponseAudit(response, request.inputs.length, phase, undefined, error);
        Object.assign(failure, { responseMetadata });
        try { logger?.log?.('ai.validation_failed', { ...context, ...responseMetadata }); } catch { /* Preserve the original validation failure. */ }
        throw failure;
      }
      result.metadata = { ...buildResponseAudit(response, request.inputs.length, 'evidence', result), retryClass: null };
      result.standardizationStage = stage;
      return result;
    };
  };
  return Object.assign(async (claimed: any, signal: AbortSignal) => (await prepare(claimed, signal))(), { prepare });
}

function classifyProviderFailure(error: unknown): StructuredWorkerFailure {
  const classification = classifyProviderRequestFailure(error);
  if (classification.retryClass === 'provider_policy_rejection') return workerFailure(error, classification.retryClass, classification.retryable, classification.requestOutcome);
  const marked = structuredFailure(error);
  if (marked) return marked;
  return workerFailure(error, classification.retryClass, classification.retryable, classification.requestOutcome);
}

function structuredFailure(error: unknown): StructuredWorkerFailure | undefined {
  if (!error || typeof error !== 'object') return undefined;
  return typeof Reflect.get(error, 'retryClass') === 'string' && typeof Reflect.get(error, 'retryable') === 'boolean'
    ? error as StructuredWorkerFailure
    : undefined;
}

function workerFailure(
  error: unknown,
  retryClass: StructuredWorkerFailure['retryClass'],
  retryable: boolean,
  requestOutcome?: ProviderRequestOutcome,
): StructuredWorkerFailure {
  const failure = new Error(error instanceof Error ? error.message : String(error)) as StructuredWorkerFailure;
  Object.assign(failure, { retryClass, retryable, ...(requestOutcome ? { requestOutcome } : {}) });
  return failure;
}
