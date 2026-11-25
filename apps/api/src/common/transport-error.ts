type TransportStage = 'dns' | 'connect' | 'tls' | 'proxy' | 'headers' | 'body';

class TransportError extends Error {
  constructor(message: string, cause: unknown, readonly stage?: TransportStage) {
    super(message, { cause });
  }
}

const codeStages: Record<string, TransportStage> = {
  ENOTFOUND: 'dns', EAI_AGAIN: 'dns', EAI_FAIL: 'dns',
  ECONNREFUSED: 'connect', ECONNRESET: 'connect', ECONNABORTED: 'connect',
  ETIMEDOUT: 'connect', EHOSTUNREACH: 'connect', ENETUNREACH: 'connect', EPIPE: 'connect',
  UND_ERR_CONNECT_TIMEOUT: 'connect', UND_ERR_SOCKET: 'connect', UND_ERR_ABORTED: 'connect',
  ERR_TLS_CERT_ALTNAME_INVALID: 'tls', CERT_HAS_EXPIRED: 'tls', CERT_NOT_YET_VALID: 'tls',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'tls', SELF_SIGNED_CERT_IN_CHAIN: 'tls',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'tls', UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'tls',
  ERR_SSL_WRONG_VERSION_NUMBER: 'tls', ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION: 'tls',
  UND_ERR_HEADERS_TIMEOUT: 'headers', UND_ERR_BODY_TIMEOUT: 'body',
  UND_ERR_RES_CONTENT_LENGTH_MISMATCH: 'body',
};
const safeNames = new Set([
  'Error', 'TypeError', 'AggregateError', 'AbortError', 'TimeoutError', 'SocketError',
  'ConnectTimeoutError', 'HeadersTimeoutError', 'BodyTimeoutError', 'RequestAbortedError',
  'ResponseContentLengthMismatchError', 'ProxyAuthenticationError', 'SocksClientError',
]);

export function transportDetails(error: unknown): {
  causes: Array<{ name: string; code?: string }>; code?: string; transportStage?: TransportStage; proxyStatus?: number;
} {
  const causes: Array<{ name: string; code?: string }> = [];
  const pending = [error], seen = new Set<Error>();
  let code: string | undefined, stage: TransportStage | undefined, wrappedStage: TransportStage | undefined, proxyStatus: number | undefined;
  // Bound cyclic/aggregate causes; only known tokens and an exact CONNECT status may escape.
  for (let index = 0; index < pending.length && index < 32; index++) {
    const cause = pending[index];
    if (!(cause instanceof Error) || seen.has(cause)) continue;
    seen.add(cause);
    if (cause instanceof TransportError) wrappedStage ??= cause.stage;
    const candidate = Reflect.get(cause, 'code');
    const safeCode = typeof candidate === 'string' && Object.hasOwn(codeStages, candidate) ? candidate : undefined;
    causes.push({ name: safeNames.has(cause.name) ? cause.name : 'Error', ...(safeCode ? { code: safeCode } : {}) });
    if (safeCode) { code = safeCode; stage = codeStages[safeCode]; }
    const status = /^Proxy response \(([1-5]\d{2})\) !== 200 when HTTP Tunneling$/.exec(cause.message);
    if (status && status[1] !== '200') proxyStatus = Number(status[1]);
    if (cause.cause !== undefined && pending.length < 32) pending.push(cause.cause);
    if (cause instanceof AggregateError && Array.isArray(cause.errors)) pending.push(...cause.errors.slice(0, 32 - pending.length));
  }
  stage = proxyStatus === undefined ? wrappedStage ?? stage : 'proxy';
  return { causes, ...(code ? { code } : {}), ...(stage ? { transportStage: stage } : {}), ...(proxyStatus === undefined ? {} : { proxyStatus }) };
}

export function transportError(message: string, error: unknown, phase?: 'dns' | 'connect' | 'body'): Error {
  const details = transportDetails(error);
  const stage = phase === 'body' ? phase : details.transportStage ?? phase;
  const fields = [
    ...(stage ? [`stage=${stage}`] : []),
    ...(details.code ? [`code=${details.code}`] : []),
    ...(details.proxyStatus === undefined ? [] : [`CONNECT=${details.proxyStatus}`]),
  ];
  return new TransportError(message + (fields.length ? ` (${fields.join('; ')})` : ''), error, stage);
}
