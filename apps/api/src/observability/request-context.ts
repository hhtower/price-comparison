import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  type CallHandler,
  type ExecutionContext,
  type LoggerService,
  type NestInterceptor,
} from '@nestjs/common';
import { Observable, type Subscription } from 'rxjs';
import type { RequestMetricsRecorder } from './metrics.js';

export interface RequestContext {
  requestId: string;
  jobId?: string;
  queryName?: string;
  durationMs?: number;
}

export interface RequestLike {
  headers?: Record<string, string | string[] | undefined>;
  id?: string;
  ip?: string;
  method?: string;
  url?: string;
  routeOptions?: { url?: string };
  requestId?: string;
  jobId?: string;
  queryName?: string;
}

export interface ResponseLike {
  header?: (name: string, value: string) => unknown;
  statusCode?: number;
}

const contextStorage = new AsyncLocalStorage<RequestContext>();
const REQUEST_ID_HEADER = 'x-request-id';
const MAX_REQUEST_ID_LENGTH = 128;
const REDACTED = '[REDACTED]';
const OMITTED_LOG_KEYS = /^(?:sql|params?|parameters?|bindings?|values?)$/iu;
const SENSITIVE_LOG_KEYS =
  /(?:password|passwd|secret|token|authorization|cookie|api[-_]?key|credential|passphrase)/iu;
const URI_WITH_CREDENTIALS = /\b(?:postgres(?:ql)?|redis(?:s)?):\/\/[^\s]+/giu;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu;

export function createRequestId(value: unknown): string {
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (
      normalized.length > 0 &&
      normalized.length <= MAX_REQUEST_ID_LENGTH &&
      /^[A-Za-z0-9._:-]+$/u.test(normalized)
    ) {
      return normalized;
    }
  }
  return randomUUID();
}

export function createRequestContext(
  input: Partial<RequestContext> & { requestId?: unknown } = {},
): RequestContext {
  return {
    requestId: createRequestId(input.requestId),
    ...(input.jobId === undefined ? {} : { jobId: String(input.jobId) }),
    ...(input.queryName === undefined ? {} : { queryName: String(input.queryName) }),
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
  };
}

export function getRequestContext(): RequestContext | undefined {
  return contextStorage.getStore();
}

export function runWithRequestContext<T>(
  context: RequestContext,
  callback: () => T,
): T {
  return contextStorage.run(context, callback);
}

export function updateRequestContext(
  fields: Partial<Pick<RequestContext, 'jobId' | 'queryName' | 'durationMs'>>,
): void {
  const context = contextStorage.getStore();
  if (!context) return;
  if (fields.jobId !== undefined) context.jobId = String(fields.jobId);
  if (fields.queryName !== undefined) context.queryName = String(fields.queryName);
  if (fields.durationMs !== undefined) context.durationMs = fields.durationMs;
}

export function runWithWorkerContext<T>(
  input: { workerId: string; jobId: string | bigint; queryName?: string },
  callback: () => T,
): T {
  return runWithRequestContext(
    createRequestContext({
      requestId: `worker-${input.workerId}-${randomUUID()}`,
      jobId: String(input.jobId),
      queryName: input.queryName ?? `worker.${input.workerId}`,
    }),
    callback,
  );
}

export function sanitizeLogFields(
  fields: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!fields) return {};
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (OMITTED_LOG_KEYS.test(key)) continue;
    output[key] = SENSITIVE_LOG_KEYS.test(key)
      ? REDACTED
      : sanitizeLogValue(value);
  }
  return output;
}

function sanitizeLogValue(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: sanitizeString(value.message) };
  }
  if (typeof value === 'string') return sanitizeString(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeLogValue(item));
  if (value && typeof value === 'object') {
    const object: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (OMITTED_LOG_KEYS.test(key)) continue;
      object[key] = SENSITIVE_LOG_KEYS.test(key)
        ? REDACTED
        : sanitizeLogValue(nested);
    }
    return object;
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function sanitizeString(value: string): string {
  return value.replace(URI_WITH_CREDENTIALS, REDACTED).replace(BEARER_TOKEN, REDACTED);
}

export function formatLogTimestamp(value: Date): string {
  const pad = (part: number): string => String(part).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}
export interface StructuredLogRecord {
  readonly timestamp: string;
  readonly level: string;
  readonly message: string;
  readonly requestId: string;
  readonly jobId: string | null;
  readonly queryName: string | null;
  readonly duration: number;
  readonly [key: string]: unknown;
}

export type StructuredLogSink = (line: string) => void;

export class StructuredLogger implements LoggerService {
  constructor(
    private readonly sink: StructuredLogSink = (line) =>
      process.stdout.write(`${line}\n`),
  ) {}

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write('info', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write('warn', message, optionalParams);
  }

  private write(level: string, message: unknown, optionalParams: unknown[]): void {
    const context = getRequestContext();
    const fields =
      optionalParams.find(
        (value): value is Record<string, unknown> =>
          Boolean(value && typeof value === 'object' && !Array.isArray(value)),
      ) ?? {};
    const record: StructuredLogRecord = {
      timestamp: formatLogTimestamp(new Date()),
      level,
      message: message instanceof Error ? message.message : String(message),
      requestId: context?.requestId ?? 'system',
      jobId: context?.jobId ?? null,
      queryName: context?.queryName ?? null,
      duration: context?.durationMs ?? 0,
      ...sanitizeLogFields(fields),
    };
    this.sink(JSON.stringify(record));
  }
}

export class RequestContextInterceptor implements NestInterceptor {
  constructor(
    private readonly metrics?: RequestMetricsRecorder,
    private readonly logger?: StructuredLogger,
  ) {}

  intercept(
    executionContext: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    const request = executionContext.switchToHttp().getRequest<RequestLike>();
    const response = executionContext.switchToHttp().getResponse<ResponseLike>();
    const requestId = createRequestId(
      request.headers?.[REQUEST_ID_HEADER] ?? request.id,
    );
    const queryName =
      request.routeOptions?.url ??
      request.url?.split('?', 1)[0] ??
      `${request.method ?? 'UNKNOWN'} request`;
    const requestContext = createRequestContext({
      requestId,
      jobId: request.jobId,
      queryName,
    });
    request.requestId = requestId;
    request.queryName = queryName;
    response.header?.(REQUEST_ID_HEADER, requestId);

    return new Observable((subscriber) => {
      let subscription: Subscription | undefined;
      const startedAt = performance.now();
      const finish = (error?: unknown): void => {
        const durationMs = performance.now() - startedAt;
        requestContext.durationMs = durationMs;
        const statusCode = resolveStatusCode(error, response);
        this.metrics?.observeRequest({
          route: queryName,
          method: request.method ?? 'UNKNOWN',
          statusCode,
          durationMs,
        });
        runWithRequestContext(requestContext, () => {
          this.logger?.log('request.completed', {
            statusCode,
          });
        });
      };

      runWithRequestContext(requestContext, () => {
        try {
          subscription = next.handle().subscribe({
            next: (value) => subscriber.next(value),
            error: (error) => {
              finish(error);
              subscriber.error(error);
            },
            complete: () => {
              finish();
              subscriber.complete();
            },
          });
        } catch (error) {
          finish(error);
          subscriber.error(error);
        }
      });

      return () => subscription?.unsubscribe();
    });
  }
}

function resolveStatusCode(error: unknown, response: ResponseLike): number {
  if (error) {
    if (typeof error === 'object' && 'getStatus' in error) {
      const getStatus = (error as { getStatus?: unknown }).getStatus;
      if (typeof getStatus === 'function') {
        const statusCode = getStatus.call(error);
        if (Number.isInteger(statusCode) && statusCode >= 100) return statusCode;
      }
    }
    return 500;
  }
  return response.statusCode ?? 200;
}

export { REQUEST_ID_HEADER };
