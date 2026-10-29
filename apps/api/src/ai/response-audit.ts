import { createHash } from 'node:crypto';
import { StandardizationValidationError, type ParsedStandardizationResponse, type StandardizationDiagnostic } from './ai.schemas.js';
import type { StreamingResult } from './llm-runtime.js';
import { sanitizeTagAuditText } from './tag-extraction-result.js';

type AuditIssue = Pick<StandardizationDiagnostic, 'stage' | 'code' | 'fieldPath' | 'expectedType' | 'actualType' | 'actualCount' | 'maxCount'> & { itemId?: string };
export interface ResponseDiagnostic {
  version: 'response-audit-20261023-v1';
  phase: 'json' | 'schema' | 'evidence';
  code: string;
  fieldPath: string | null;
  contentSha256: string;
  outputBytes: number;
  outputChars: number;
  chunkCount: number;
  contentChunks: number;
  firstContentMs: number | null;
  finishReason: string | null;
  inputCount: number;
  returnedItemCount: number | null;
  rejectedItemCount: number;
  missingItemCount: number;
  issues: AuditIssue[];
  issuesTruncated: boolean;
  constraint?: Pick<StandardizationDiagnostic, 'expectedType' | 'actualType' | 'actualCount' | 'maxCount'>;
}

/** Summaries contain coordinates and counts, never model text or proposed identity values. */
export function buildResponseAudit(response: StreamingResult, inputCount: number,
  phase: ResponseDiagnostic['phase'], result?: ParsedStandardizationResponse, error?: unknown) {
  const diagnostic = error instanceof StandardizationValidationError ? error.diagnostic : undefined;
  const constraint = (value: StandardizationDiagnostic) => ({
    ...(value.expectedType !== undefined ? { expectedType: value.expectedType } : {}),
    ...(value.actualType !== undefined ? { actualType: value.actualType } : {}),
    ...(value.actualCount !== undefined ? { actualCount: value.actualCount } : {}),
    ...(value.maxCount !== undefined ? { maxCount: value.maxCount } : {}),
  });
  const issue = (value: StandardizationDiagnostic, itemId?: string): AuditIssue => ({
    stage: value.stage, code: value.code, ...(value.fieldPath ? { fieldPath: sanitizeTagAuditText(value.fieldPath, 250) } : {}),
    ...(itemId && /^[1-9]\d{0,29}$/u.test(itemId) ? { itemId } : {}),
    ...constraint(value),
  });
  const rejected = result?.items.filter(item => item.diagnostic) ?? [];
  const responseDiagnostic: ResponseDiagnostic = {
    version: 'response-audit-20261023-v1', phase,
    code: diagnostic?.code ?? (error ? phase === 'json' ? 'invalid_json' : 'invalid_response'
      : rejected.length ? 'items_rejected' : result?.missingIds.length ? 'items_missing' : 'accepted'),
    fieldPath: diagnostic?.fieldPath ? sanitizeTagAuditText(diagnostic.fieldPath, 250) : null,
    contentSha256: createHash('sha256').update(response.content).digest('hex'),
    outputBytes: Buffer.byteLength(response.content), outputChars: response.content.length,
    chunkCount: response.chunkCount, contentChunks: response.contentChunks,
    firstContentMs: response.firstContentMs,
    finishReason: response.finishReason, inputCount,
    returnedItemCount: result?.items.length ?? (diagnostic?.fieldPath === 'items' ? diagnostic.actualCount ?? null : null),
    rejectedItemCount: rejected.length, missingItemCount: result?.missingIds.length ?? 0,
    issues: diagnostic ? [issue(diagnostic, diagnostic.itemId)] : rejected.slice(0, 20).map(item => issue(item.diagnostic!, item.id)),
    issuesTruncated: rejected.length > 20,
    ...(diagnostic ? { constraint: constraint(diagnostic) } : {}),
  };
  // Leave headroom for PostgreSQL JSONB spacing; counts survive detail truncation.
  while (responseDiagnostic.issues.length && Buffer.byteLength(JSON.stringify(responseDiagnostic, null, 2)) > 12000) {
    responseDiagnostic.issues.pop();
    responseDiagnostic.issuesTruncated = true;
  }
  return {
    firstContentMs: response.firstContentMs, responseMs: response.responseMs,
    outputBytes: responseDiagnostic.outputBytes, usage: response.usage,
    responseModel: response.responseModel ? sanitizeTagAuditText(response.responseModel, 256) : null,
    responseId: response.responseId ? sanitizeTagAuditText(response.responseId, 256) : null,
    responseDiagnostic,
  };
}
