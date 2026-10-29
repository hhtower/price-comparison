import { DomainValidationError } from './errors.js';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

interface IdCursorPayload {
  readonly v: 1;
  readonly id: string;
}

export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
  readonly total?: number;
  readonly page?: number;
  readonly pageSize?: number;
}

export interface PageRequest {
  readonly cursor?: string;
  readonly limit?: number;
  readonly page?: number;
}

export interface NormalizedPageRequest {
  readonly afterId?: bigint;
  readonly limit: number;
  readonly page?: number;
}

export function encodeIdCursor(id: bigint): string {
  const payload: IdCursorPayload = { v: 1, id: id.toString() };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeIdCursor(cursor: string): bigint {
  try {
    const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<IdCursorPayload>;
    if (payload.v !== 1 || typeof payload.id !== 'string' || !/^[1-9]\d*$/.test(payload.id)) {
      throw new Error('invalid cursor payload');
    }
    return BigInt(payload.id);
  } catch {
    throw new DomainValidationError('INVALID_CURSOR', '分页游标无效');
  }
}

export function parsePositiveBigint(value: string, field = 'id'): bigint {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new DomainValidationError('INVALID_ID', `${field} 必须是正整数`, { field });
  }
  return BigInt(value);
}

export function normalizePageLimit(limit?: number): number {
  const value = limit ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    throw new DomainValidationError(
      'INVALID_PAGE_SIZE',
      `每页数量必须是 1 到 ${MAX_PAGE_SIZE} 之间的整数`,
    );
  }
  return value;
}

export function normalizePageRequest(request: PageRequest = {}): NormalizedPageRequest {
  if (request.cursor !== undefined && typeof request.cursor !== 'string') {
    throw new DomainValidationError('INVALID_CURSOR', '分页游标无效');
  }
  if (request.page !== undefined && (!Number.isSafeInteger(request.page) || request.page < 1)) {
    throw new DomainValidationError('INVALID_PAGE', '页码无效');
  }
  return {
    limit: normalizePageLimit(request.limit),
    ...(request.page === undefined ? {} : { page: request.page }),
    ...(request.cursor ? { afterId: decodeIdCursor(request.cursor) } : {}),
  };
}

export function buildCursorPage<T extends { readonly id: bigint }>(
  rows: readonly T[],
  limit: number,
): CursorPage<T> {
  const hasNext = rows.length > limit;
  const items = hasNext ? rows.slice(0, limit) : [...rows];
  const last = items.at(-1);
  return {
    items,
    ...(hasNext && last ? { nextCursor: encodeIdCursor(last.id) } : {}),
  };
}
