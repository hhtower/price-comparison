export class ApiRequestError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.data = data;
  }
}

export async function requestJson(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined && options.body !== null && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(path, {
    ...options,
    headers,
  });
  if (response.status === 304 || response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data?.error?.message || data?.message || data?.error;
    const message = Array.isArray(detail)
      ? detail.filter(item => typeof item === 'string').join('；')
      : typeof detail === 'string' ? detail : '';
    throw new ApiRequestError(message || `请求失败（HTTP ${response.status}）`, response.status, data);
  }
  return data;
}

export function createProgressEventSource(path, { since, signal, onProgress, onError, onOpen } = {}) {
  if (typeof EventSource === 'undefined') return null;
  const url = new URL(path, window.location.origin);
  if (since != null) url.searchParams.set('since', String(since));
  const source = new EventSource(`${url.pathname}${url.search}`);
  const handleProgress = event => {
    try {
      onProgress?.(JSON.parse(event.data), event.lastEventId || '');
    } catch (error) {
      onError?.(error);
    }
  };
  const handleError = error => onError?.(error);
  const handleOpen = () => onOpen?.();
  source.addEventListener('open', handleOpen);
  source.addEventListener('progress', handleProgress);
  source.addEventListener('error', handleError);
  let abortHandler;
  const close = () => {
    source.removeEventListener('open', handleOpen);
    source.removeEventListener('progress', handleProgress);
    source.removeEventListener('error', handleError);
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
    source.close();
  };
  if (signal) {
    if (signal.aborted) close();
    else {
      abortHandler = close;
      signal.addEventListener('abort', abortHandler, { once: true });
    }
  }
  return { close };
}

export function formatTime(value) {
  if (!value) return '暂无时间';
  const raw = String(value).trim();
  const date = new Date(raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return raw;
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
