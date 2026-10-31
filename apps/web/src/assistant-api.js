import {
  ASSISTANT_LIMITS, isTurnTerminal, validateTurnSnapshot, validateSessionSnapshot, validateShoppingNeeds,
} from '@price-comparison/catalog/assistant-contract';
import { normalizeCatalogPlatform } from '@price-comparison/catalog/platform-groups';

const ROOT = '/api/assistant';
function publicError(status) {
  const message = status === 404 || status === 410 ? '会话已失效，请开始新对话。'
    : status === 409 ? '会话版本已变化，请重新连接以同步状态。'
      : status === 429 ? '请求较多，请稍后重新连接。'
        : status === 400 || status === 422 ? '请检查输入内容和长度。'
          : '导购服务暂时不可用，请稍后重新连接。';
  return Object.assign(new Error(message), { status });
}
function checked(parse) {
  try { return parse(); } catch { throw new Error('导购服务响应异常，请重新连接。'); }
}
export function createAssistantApi(fetcher = (...args) => fetch(...args)) {
  const sessionPath = credentials => '/sessions/' + encodeURIComponent(credentials.sessionId);
  const turnPath = (credentials, id) => sessionPath(credentials) + '/turns/' + encodeURIComponent(id);
  async function request(path, { credentials, method = 'GET', body, signal, stream = false } = {}) {
    let response;
    try {
      response = await fetcher(ROOT + path, {
        method, signal, cache: 'no-store', credentials: 'omit', redirect: 'error',
        headers: { Accept: stream ? 'text/event-stream' : 'application/json',
          ...(credentials ? { Authorization: 'Bearer ' + credentials.accessToken } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw error;
      throw new Error('连接中断，请重新连接以确认消息状态。');
    }
    if (!response.ok) throw publicError(response.status);
    if (stream) return response;
    if (response.status === 204) return undefined;
    try { return await response.json(); } catch { throw new Error('导购服务响应异常，请重新连接。'); }
  }
  function checkTurn(value, credentials, id) {
    return checked(() => {
      const snapshot = validateTurnSnapshot(value);
      if (snapshot.sessionId !== credentials.sessionId || id && snapshot.id !== id) throw new Error();
      return snapshot;
    });
  }
  async function readSession(credentials, signal) {
    const value = await request(sessionPath(credentials), { credentials, signal });
    return checked(() => {
      const session = validateSessionSnapshot(value);
      if (session.id !== credentials.sessionId) throw new Error();
      return session;
    });
  }
  async function subscribeTurn(credentials, initial, onSnapshot, signal) {
    let latest = checkTurn(initial, credentials, initial.id);
    const publish = value => {
      const snapshot = checkTurn(value, credentials, initial.id);
      if (snapshot.clientMessageId !== initial.clientMessageId || snapshot.inputText !== initial.inputText
        || snapshot.expectedRevision !== initial.expectedRevision) throw new Error('导购服务响应异常，请重新连接。');
      if (snapshot.eventVersion > latest.eventVersion) {
        latest = snapshot;
        if (!signal?.aborted) onSnapshot(snapshot);
      }
      return isTurnTerminal(latest.status);
    };
    if (isTurnTerminal(latest.status)) return latest;
    // Reconnect only the read channel; creating a turn is always an explicit operation.
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      let reader;
      const connection = new AbortController();
      const abort = () => { connection.abort(); reader?.cancel().catch(() => {}); };
      const timeout = setTimeout(abort, ASSISTANT_LIMITS.turnDeadlineMs + 5000);
      signal?.addEventListener('abort', abort, { once: true });
      try {
        const response = await request(turnPath(credentials, initial.id) + '/events',
          { credentials, signal: connection.signal, stream: true });
        if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) throw new Error();
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!connection.signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let boundary;
          while ((boundary = /\r?\n\r?\n/u.exec(buffer))) {
            const frame = buffer.slice(0, boundary.index);
            buffer = buffer.slice(boundary.index + boundary[0].length);
            if (frame.length > ASSISTANT_LIMITS.sseBufferMaxBytes) throw new Error();
            const lines = frame.split(/\r?\n/u);
            const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
            if (event !== 'snapshot') continue;
            const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /u, '')).join('\n');
            if (data && publish(JSON.parse(data))) return latest;
          }
          if (buffer.length > ASSISTANT_LIMITS.sseBufferMaxBytes) throw new Error();
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        if ([404, 410, 429].includes(error?.status)) throw error;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      }
      signal?.throwIfAborted();
      const session = await readSession(credentials, signal);
      const current = session.turns.find(turn => turn.id === initial.id);
      if (!current) throw new Error('轮次已失效，请重新连接。');
      if (publish(current)) return latest;
    }
    throw new Error('进度连接已中断，请重新连接；消息仍保留在服务器。');
  }
  return {
    async status(signal) {
      const value = await request('/status', { signal });
      if (typeof value?.enabled !== 'boolean') throw new Error('导购服务响应异常。');
      return { enabled: value.enabled };
    },
    async createSession(signal) {
      const value = await request('/sessions', { method: 'POST', signal });
      if (typeof value?.sessionId !== 'string' || !/^[a-f0-9-]{36}$/iu.test(value.sessionId)
        || typeof value.accessToken !== 'string' || !value.accessToken || value.revision !== 0) throw new Error('导购服务响应异常。');
      return { sessionId: value.sessionId, accessToken: value.accessToken, revision: 0 };
    },
    readSession,
    async sendTurn(credentials, input, signal) {
      const { clientMessageId, expectedRevision, text } = input;
      if (typeof text !== 'string' || !text.trim() || text.length > ASSISTANT_LIMITS.userTextMaxChars
        || !/^[a-f0-9-]{36}$/iu.test(clientMessageId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw publicError(400);
      const value = await request(sessionPath(credentials) + '/turns', { credentials, signal, method: 'POST',
        body: { clientMessageId, expectedRevision, text } });
      const snapshot = checkTurn(value?.snapshot, credentials);
      if (typeof value?.created !== 'boolean' || snapshot.clientMessageId !== clientMessageId
        || snapshot.expectedRevision !== expectedRevision || snapshot.inputText !== text) throw new Error('导购服务响应异常，请重新连接。');
      return { snapshot, created: value.created };
    },
    subscribeTurn,
    async cancelTurn(credentials, id, signal) {
      return checkTurn(await request(turnPath(credentials, id) + '/cancel', { credentials, signal, method: 'POST' }), credentials, id);
    },
    async deleteSession(credentials, signal) {
      await request(sessionPath(credentials), { credentials, signal, method: 'DELETE' });
    },
  };
}
export const assistantApi = createAssistantApi();

export function assistantListLink(value) {
  const needs = validateShoppingNeeds(value);
  const params = new URLSearchParams({ newcomer: 'false' });
  const platform = normalizeCatalogPlatform(needs.platform || '');
  if (platform) params.set('platform', platform);
  for (const tag of needs.requiredTags) params.append('tag', JSON.stringify(tag));
  if (needs.warrantyDaysMin) params.set('warrantyDaysMin', String(needs.warrantyDaysMin));
  return { href: '/?' + params, note: '仅带入列表支持的平台、标签与质保硬条件。预算、用途与偏好未带入，请在列表中自行核对。' };
}
