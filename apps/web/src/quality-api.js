import { validateQualityReport } from '../../api/src/quality/quality-report.ts';
import { normalizeModelIds } from '../../api/src/ai/model-list.ts';

const API_ROOT = '/api/quality';
const TERMINAL = new Set(['completed', 'cancelled', 'failed']);
export const isQualityTerminal = state => TERMINAL.has(state);

function publicError(status) {
  if (status === 400 || status === 422) return '请检查地址、凭据与检测配置，修改后重新提交。';
  if (status === 401 || status === 403 || status === 404 || status === 410) return '任务访问已失效或已过期，请重新填写配置并开始检测。';
  if (status === 429) return '当前检测任务较多，请稍后重新提交。';
  return '检测服务暂时不可用，请稍后重试。';
}
function checkSnapshot(value, id) {
  try {
    const checked = validateQualityReport(value);
    if (checked.id !== id) throw new Error('报告任务不匹配');
    return checked;
  } catch {
    throw new Error('报告格式异常，请重新连接或重新开始检测。');
  }
}

export function createQualityApi(fetcher = (...args) => fetch(...args)) {
  async function request(path, { method = 'GET', body, task, signal } = {}) {
    let response;
    try {
      response = await fetcher(API_ROOT + path, {
        method, signal, cache: 'no-store', credentials: 'omit', redirect: 'error',
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(task ? { Authorization: 'Bearer ' + task.accessToken } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw error;
      throw new Error('网络连接失败，请检查网络后重试。');
    }
    if (!response.ok) throw new Error(publicError(response.status));
    if (response.status === 204) return null;
    try { return await response.json(); } catch { throw new Error('检测服务响应异常，请重试。'); }
  }
  const path = task => '/tasks/' + encodeURIComponent(task.id);
  async function creation(route, body, options = {}) {
    const value = await request(route, { ...options, method: 'POST', body });
    if (typeof value?.id !== 'string' || !value.id || typeof value?.accessToken !== 'string' || !value.accessToken) throw new Error('创建任务失败，请重新提交。');
    return { id: value.id, accessToken: value.accessToken };
  }
  async function get(task, signal) { return checkSnapshot(await request(path(task), { task, signal }), task.id); }
  async function watch(task, onSnapshot, signal) {
    const publish = value => {
      const checked = checkSnapshot(value, task.id);
      if (!signal?.aborted) onSnapshot(checked);
      return TERMINAL.has(checked.state);
    };
    if (signal?.aborted) return;
    if (publish(await get(task, signal)) || signal?.aborted) return;
    let reader;
    const abortReader = () => { reader?.cancel().catch(() => {}); };
    let terminal = false;
    try {
      const response = await fetcher(API_ROOT + path(task) + '/events', {
        signal, cache: 'no-store', credentials: 'omit', redirect: 'error',
        headers: { Accept: 'text/event-stream', Authorization: 'Bearer ' + task.accessToken },
      });
      if (!response.ok) throw new Error(publicError(response.status));
      if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) throw new Error('进度连接异常。');
      reader = response.body.getReader();
      signal?.addEventListener('abort', abortReader, { once: true });
      if (signal?.aborted) { abortReader(); return; }
      const decoder = new TextDecoder();
      let buffer = '';
      while (!signal?.aborted) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        if (buffer.length > 1024 * 1024) throw new Error('进度响应过长。');
        let boundary;
        while ((boundary = /\r?\n\r?\n/u.exec(buffer))) {
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const data = frame.split(/\r?\n/u).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /u, '')).join('\n');
          if (!data || signal?.aborted) continue;
          terminal = publish(JSON.parse(data));
          if (terminal) return;
        }
      }
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') return;
      // A disconnected or malformed event stream is never evidence of completion.
      // Read the authoritative snapshot once; the UI offers explicit reconnection.
    } finally {
      signal?.removeEventListener('abort', abortReader);
      if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
    if (signal?.aborted || terminal) return;
    if (!publish(await get(task, signal))) throw new Error('进度连接已中断，已保留收到的结果，请重新连接或取消检测。');
  }
  return {
    catalog: signal => request('/catalog', { signal }),
    models: async (input, signal) => {
      const value = await request('/models', { method: 'POST', body: input, signal });
      return normalizeModelIds(value?.models);
    },
    start: (input, signal) => creation('/tasks', input, { signal }),
    get, watch,
    cancel: async (task, signal) => {
      const value = await request(path(task) + '/cancel', { method: 'POST', task, signal });
      return value?.id ? checkSnapshot(value, task.id) : get(task, signal);
    },
    retest: (task, itemIds, input, signal) => creation(path(task) + '/retest', { itemIds, input }, { task, signal }),
  };
}
export const qualityApi = createQualityApi();
