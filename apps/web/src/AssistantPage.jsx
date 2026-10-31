import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  AssistantRuntimeProvider, ComposerPrimitive, ExportedMessageRepository, MessagePrimitive,
  ThreadPrimitive, useAuiState, useLocalRuntime,
} from '@assistant-ui/react';
import {
  ASSISTANT_LIMITS, emptyShoppingNeeds, isTurnTerminal, validateAssistantReply,
} from '@price-comparison/catalog/assistant-contract';
import Brand from './Brand.jsx';
import { assistantApi, assistantListLink } from './assistant-api.js';
import './assistant.css';

const STORAGE_KEY = 'shopping-assistant';
const ConversationContext = createContext(null);
const PHASES = { queued: '正在排队', understanding: '正在理解需求', searching: '正在查找真实报价', explaining: '正在整理推荐依据' };
function saveCredentials(credentials, pendingMessageId) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
      sessionId: credentials.sessionId, accessToken: credentials.accessToken,
      ...(pendingMessageId ? { pendingMessageId } : {}),
    }));
  } catch { throw new Error('浏览器无法保存会话凭证，请允许当前标签页使用会话存储后重试。'); }
}
function storedCredentials() {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (!/^[a-f0-9-]{36}$/iu.test(value?.sessionId) || typeof value?.accessToken !== 'string' || !value.accessToken
      || value.pendingMessageId && !/^[a-f0-9-]{36}$/iu.test(value.pendingMessageId)) throw new Error();
    return { sessionId: value.sessionId, accessToken: value.accessToken, pendingMessageId: value.pendingMessageId };
  } catch { throw new Error('保存的会话已失效，请开始新对话。'); }
}
function turnResult(turn) {
  if (turn.status === 'succeeded') {
    const reply = validateAssistantReply(turn.reply);
    return { content: [{ type: 'text', text: reply.text }], metadata: { custom: { reply } } };
  }
  const code = turn.errorCode?.toLowerCase();
  const text = turn.status === 'cancelled' ? '已停止本轮，可以继续描述需求。'
    : code?.includes('timeout') || code?.includes('deadline') ? '本轮等待超时，请稍后再试。'
      : '本轮未完成，已确认的需求保持不变。重新发送会开始新一轮，可能产生新的模型调用。';
  return { content: [{ type: 'text', text }] };
}
function historyMessages(session) {
  return session.turns.flatMap(turn => [
    { id: 'user-' + turn.id, role: 'user', content: turn.inputText },
    ...(isTurnTerminal(turn.status) ? [{ id: 'assistant-' + turn.id, role: 'assistant', ...turnResult(turn) }] : []),
  ]);
}
function Message() {
  const role = useAuiState(state => state.message.role);
  const reply = useAuiState(state => state.message.metadata.custom?.reply);
  const last = useAuiState(state => state.message.isLast);
  const { sendOption, blocked } = useContext(ConversationContext);
  return <MessagePrimitive.Root className={'assistant-message assistant-message-' + role}>
    <span className="assistant-speaker">{role === 'user' ? '你' : '拾价助手'}</span>
    <MessagePrimitive.Parts />
    {reply && <div className="assistant-cards">{reply.cards.map(card =>
      <article className="assistant-card" key={card.productId}>
        <h2>{card.title}</h2><p className="assistant-price">{card.price} <small>{card.currency}</small></p>
        <ul>{card.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
        {card.caveats.map(caveat => <p className="assistant-caveat" key={caveat}>{caveat}</p>)}
        <p className="assistant-quote-time">报价采集：<time dateTime={card.capturedAt}>{new Date(card.capturedAt).toLocaleString('zh-CN')}</time></p>
        <p className="assistant-quote-time">{Date.parse(card.priceExpiresAt) <= Date.now() ? '此报价已过期，请重新核对。' : '报价与库存以详情页和商铺为准。'}</p>
        {/^(?:\/products\/[1-9][0-9]*)$/u.test(card.detailPath)
          && <a href={card.detailPath}>查看商品详情<span className="assistant-card-title">：{card.title}</span></a>}
      </article>)}</div>}
    {reply && last && reply.options.length > 0 && <div className="assistant-options" aria-label="快捷回答">
      {reply.options.map(option => <button type="button" key={option} disabled={blocked} onClick={() => sendOption(option)}>{option}</button>)}
    </div>}
  </MessagePrimitive.Root>;
}

function Conversation({ api, credentials, initialSession, onNew }) {
  const session = useRef(initialSession);
  const pending = useRef(null);
  const active = useRef(initialSession.turns.find(turn => !isTurnTerminal(turn.status)) ?? null);
  const connection = useRef(null);
  const accepting = useRef(null);
  const syncOnIdle = useRef(false);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(Boolean(active.current));
  const [stopping, setStopping] = useState(false);
  const [uncertain, setUncertain] = useState(Boolean(credentials.pendingMessageId));
  const [error, setError] = useState('');
  const [phase, setPhase] = useState(active.current?.phase ?? '');
  const [needs, setNeeds] = useState(initialSession.needs);

  function acceptSnapshot(turn) {
    active.current = turn;
    if (mounted.current) setPhase(turn.phase);
  }
  function finish(turn) {
    if (!isTurnTerminal(turn.status)) throw new Error('消息尚未完成，请重新连接。');
    const turns = session.current.turns.filter(item => item.id !== turn.id);
    turns.push(turn);
    session.current = { ...session.current, turns,
      revision: turn.status === 'succeeded' ? Math.max(turn.expectedRevision + 1, session.current.revision) : session.current.revision,
      needs: turn.reply && turn.expectedRevision + 1 >= session.current.revision ? turn.reply.needs : session.current.needs };
    saveCredentials(credentials);
    pending.current = null;
    active.current = null;
    if (mounted.current) { setUncertain(false); setNeeds(session.current.needs); setPhase(''); }
    return turnResult(turn);
  }
  async function watch(turn, signal) {
    acceptSnapshot(turn);
    if (isTurnTerminal(turn.status)) return turn;
    try { return await api.subscribeTurn(credentials, turn, acceptSnapshot, signal); }
    catch (failure) {
      if (active.current && isTurnTerminal(active.current.status)) return active.current;
      throw failure;
    }
  }
  async function sendPending(signal) {
    const input = pending.current;
    if (!input) throw new Error('无法确认上一条消息内容，请开始新对话；不会自动重复发送。');
    try {
      accepting.current = api.sendTurn(credentials, input, signal);
      return (await accepting.current).snapshot;
    } catch (failure) {
      if (signal.aborted) throw failure;
      const restored = await api.readSession(credentials, signal);
      session.current = restored;
      const existing = restored.turns.find(turn => turn.clientMessageId === input.clientMessageId);
      if (existing) return existing;
      throw failure;
    } finally { accepting.current = null; }
  }
  const adapter = useMemo(() => ({
    // ChatModelAdapter receives the runtime history; only the last user's text crosses the API boundary.
    async run({ messages }) {
      const current = messages.at(-1);
      const text = current?.role === 'user' ? current.content.filter(part => part.type === 'text').map(part => part.text).join('') : '';
      if (!text.trim() || text.length > ASSISTANT_LIMITS.userTextMaxChars || pending.current) {
        return { content: [{ type: 'text', text: '请检查输入长度，或先重新连接上一条消息。' }] };
      }
      connection.current = new AbortController();
      const signal = connection.current.signal;
      pending.current = { clientMessageId: crypto.randomUUID(), expectedRevision: session.current.revision, text };
      setBusy(true); setError(''); setPhase('queued');
      try {
        saveCredentials(credentials, pending.current.clientMessageId);
        return finish(await watch(await sendPending(signal), signal));
      } catch (failure) {
        if (failure.status === 409) {
          pending.current = null;
          active.current = null;
          saveCredentials(credentials);
          syncOnIdle.current = true;
          if (mounted.current) { setUncertain(false); setNeeds(session.current.needs); }
          return { content: [{ type: 'text', text: '会话版本已变化，已同步服务器记录。' }] };
        }
        if (mounted.current) { setError(failure.message); setUncertain(true); }
        return { content: [{ type: 'text', text: '消息状态待确认，请重新连接。' }] };
      } finally { if (mounted.current) setBusy(false); }
    },
  }), [api, credentials]);
  const runtime = useLocalRuntime(adapter, { initialMessages: historyMessages(initialSession), maxSteps: 1 });
  const importHistory = () => runtime.thread.import(ExportedMessageRepository.fromArray(historyMessages(session.current)));
  useEffect(() => runtime.thread.subscribe(() => {
    if (syncOnIdle.current && !runtime.thread.getState().isRunning) {
      syncOnIdle.current = false;
      importHistory();
    }
  }), [runtime]);

  async function reconnect() {
    if (busy && !active.current) return;
    setBusy(true); setError('');
    connection.current?.abort();
    connection.current = new AbortController();
    const signal = connection.current.signal;
    try {
      session.current = await api.readSession(credentials, signal);
      const messageId = pending.current?.clientMessageId ?? credentials.pendingMessageId;
      let turn = session.current.turns.find(item => item.clientMessageId === messageId)
        ?? session.current.turns.find(item => !isTurnTerminal(item.status));
      if (!turn && messageId) turn = await sendPending(signal);
      if (turn) {
        pending.current = { clientMessageId: turn.clientMessageId, expectedRevision: turn.expectedRevision, text: turn.inputText };
        saveCredentials(credentials, turn.clientMessageId);
        finish(await watch(turn, signal));
      } else { setUncertain(false); setNeeds(session.current.needs); }
      if (mounted.current) importHistory();
    } catch (failure) {
      if (mounted.current) { setError(failure.message); setUncertain(true); }
    } finally { if (mounted.current) setBusy(false); }
  }
  async function stop() {
    if (stopping) return;
    setStopping(true);
    try {
      await accepting.current?.catch(() => {});
      let turn = active.current;
      if (!turn) {
        const restored = await api.readSession(credentials);
        turn = restored.turns.find(item => item.clientMessageId === pending.current?.clientMessageId);
      }
      if (!turn) throw new Error('消息状态待确认，请重新连接后再停止。');
      const cancelled = await api.cancelTurn(credentials, turn.id);
      const restored = await api.readSession(credentials);
      const authoritative = restored.turns.find(item => item.id === turn.id);
      session.current = restored;
      acceptSnapshot(authoritative && authoritative.eventVersion >= cancelled.eventVersion ? authoritative : cancelled);
      if (!isTurnTerminal(active.current.status)) throw new Error('停止状态待确认，请重新连接。');
      connection.current?.abort();
    } catch (failure) { if (mounted.current) setError(failure.message); }
    finally { if (mounted.current) setStopping(false); }
  }
  useEffect(() => {
    mounted.current = true;
    if (active.current || credentials.pendingMessageId) void reconnect();
    return () => { mounted.current = false; connection.current?.abort(); };
  }, []);
  const blocked = busy || uncertain;
  const link = assistantListLink(needs);
  return <AssistantRuntimeProvider runtime={runtime}>
    <ConversationContext.Provider value={{ blocked, sendOption: text => {
      if (!blocked) runtime.thread.append({ role: 'user', content: [{ type: 'text', text }] });
    } }}>
      <div className="assistant-toolbar"><p>独立会话 · 不读取商品列表筛选</p><button type="button" disabled={busy || stopping} onClick={onNew}>新对话</button></div>
      <ThreadPrimitive.Root className="assistant-thread">
        <ThreadPrimitive.Viewport className="assistant-viewport">
          <ThreadPrimitive.Empty><div className="assistant-welcome"><span>从用途开始</span><h2>你想用 AI 做些什么？</h2><p>例如读论文、写代码或练英语。也可以直接说预算和不能接受的购买条件。</p></div></ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages components={{ UserMessage: Message, AssistantMessage: Message }} />
        </ThreadPrimitive.Viewport>
        <div role="status" aria-live="polite" className="assistant-progress">{busy ? PHASES[phase] ?? '正在同步会话' : ''}</div>
        {error && <div role="alert" className="assistant-error"><p>{error}</p>
          <button type="button" disabled={busy} onClick={() => void reconnect()}>重新连接</button></div>}
        <ComposerPrimitive.Root className="assistant-composer">
          <ComposerPrimitive.Input aria-label="告诉助手你的需求" placeholder="说说你的用途、预算或购买要求…"
            maxLength={ASSISTANT_LIMITS.userTextMaxChars} disabled={blocked} addAttachmentOnPaste={false} />
          {busy ? <button type="button" onClick={() => void stop()} disabled={stopping}>{stopping ? '正在停止…' : '停止'}</button>
            : <ComposerPrimitive.Send disabled={uncertain} aria-label="发送">发送</ComposerPrimitive.Send>}
        </ComposerPrimitive.Root>
        <p className="assistant-input-note">最多 2,000 字 · Enter 发送，Shift + Enter 换行。离开页面只断开连接，任务会继续。</p>
      </ThreadPrimitive.Root>
      <footer className="assistant-list-link"><a href={link.href}>在商品列表中查看</a><p>{link.note}</p></footer>
    </ConversationContext.Provider>
  </AssistantRuntimeProvider>;
}

export default function AssistantPage({ api = assistantApi, embedded = false, enabled = false }) {
  const [state, setState] = useState({ loading: true });
  const [generation, setGeneration] = useState(0);
  const credentials = useRef(null);
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    async function initialize() {
      try {
        const status = enabled ? { enabled: true } : await api.status(controller.signal);
        if (!live || controller.signal.aborted) return;
        if (!status.enabled) { setState({ disabled: true }); return; }
        let currentCredentials = storedCredentials();
        let session;
        if (currentCredentials) {
          session = await api.readSession(currentCredentials, controller.signal);
          if (!live || controller.signal.aborted) return;
        } else {
          const created = await api.createSession(controller.signal);
          if (!live || controller.signal.aborted) return;
          currentCredentials = created;
          saveCredentials(currentCredentials);
          session = { id: currentCredentials.sessionId, revision: 0, needs: emptyShoppingNeeds(), turns: [] };
        }
        credentials.current = currentCredentials;
        setState({ session });
      } catch (failure) { if (live && !controller.signal.aborted) setState({ error: failure.message }); }
    }
    void initialize();
    return () => { live = false; controller.abort(); };
  }, [api, generation, enabled]);
  async function newConversation() {
    setState({ loading: true });
    try {
      if (credentials.current) {
        try { await api.deleteSession(credentials.current); }
        catch (failure) { if (![404, 410].includes(failure.status)) throw failure; }
      }
      sessionStorage.removeItem(STORAGE_KEY);
      credentials.current = null;
      setGeneration(value => value + 1);
    } catch (failure) { setState({ error: failure.message }); }
  }
  const Container = embedded ? 'div' : 'main';
  return <Container className={'assistant-page' + (embedded ? ' assistant-embedded' : '')}>
    {!embedded && <><header className="assistant-header"><Brand /><a href="/guide">选购指南</a></header>
      <div className="assistant-heading"><span>知途 · 拾价 / 独立导购</span><h1>导购助手</h1><p>先聊需求，再看有依据的选择。</p></div></>}
    <p className="assistant-disclaimer">本站提供第三方报价信息，不参与交易；推荐仅覆盖本次候选，下单前请核对价格、库存与售后。不要输入账号密码或支付信息。</p>
    {state.loading ? <p role="status">正在连接导购服务…</p>
      : state.session ? <Conversation key={generation} api={api} credentials={credentials.current} initialSession={state.session} onNew={() => void newConversation()} />
        : <section className="assistant-fallback">
          <h2>{state.disabled ? '导购助手暂未启用' : '暂时无法连接导购助手'}</h2>
          {state.error && <p role="alert">{state.error}</p>}
          <p>可以先了解购买条件，或直接比较目录中的报价。</p>
          <a href="/guide">查看选购指南</a><a href="/">返回商品列表</a>
          {state.error && <button type="button" onClick={() => void newConversation()}>新对话</button>}
        </section>}
  </Container>;
}
