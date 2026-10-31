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
import { displayPurchaseTagText } from './purchase-tag-values.js';
import { formatMoney } from './money.js';
import { AssistantHeader, AssistantWelcome, AssistantPlatformChip, ASSISTANT_STARTERS, selectedAssistantPlatform } from './AssistantControls.jsx';
import './assistant.css';

const STORAGE_KEY = 'shopping-assistant';
const ConversationContext = createContext(null);
const PHASES = { queued: '正在排队', understanding: '正在理解需求', searching: '正在查找真实报价', explaining: '正在整理推荐依据' };
const PREFERENCES = { lower_price: '价格优先', simple_setup: '操作简单', longer_warranty: '质保优先' };

function needsLabels(needs) {
  return [
    needs.purpose,
    needs.budget && `${needs.budget.basis === 'month' ? '每月' : '单次'} ≤ ${formatMoney(needs.budget.amount, needs.budget.currency)}`,
    needs.platform,
    ...needs.requiredTags.map(tag => displayPurchaseTagText(tag)),
    needs.warrantyDaysMin && `质保至少 ${needs.warrantyDaysMin} 天`,
    ...needs.preferences.map(preference => PREFERENCES[preference]),
  ].filter(Boolean);
}
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
      : '这次未能完成，已确认的需求仍保留。可以重新发送。';
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
    {!reply?.cards.length && <MessagePrimitive.Parts />}
    {reply && <div className="assistant-cards">{reply.cards.map(card =>
      <article className="assistant-card" key={card.productId}>
        <h2>{card.title}</h2><p className="assistant-price">{formatMoney(card.price, card.currency)} <small>{card.currency}</small></p>
        {card.reasons[0] && <p className="assistant-card-reason">{card.reasons[0]}</p>}
        {card.caveats.map(caveat => <p className="assistant-caveat" key={caveat}>{caveat}</p>)}
        {Date.parse(card.priceExpiresAt) <= Date.now() && <p className="assistant-caveat">报价已过期，请重新核对</p>}
        <details className="assistant-evidence"><summary>报价依据</summary>
          {card.reasons.length > 1 && <ul>{card.reasons.slice(1).map(reason => <li key={reason}>{reason}</li>)}</ul>}
          <p>采集于 <time dateTime={card.capturedAt}>{new Date(card.capturedAt).toLocaleString('zh-CN')}</time></p>
        </details>
        {/^(?:\/products\/[1-9][0-9]*)$/u.test(card.detailPath)
          && <a href={card.detailPath}>查看商品详情<span className="assistant-card-title">：{card.title}</span></a>}
      </article>)}</div>}
    {Boolean(reply?.cards.length) && (reply.kind === 'comparison'
      ? <div className="assistant-comparison"><MessagePrimitive.Parts /></div>
      : <details className="assistant-explanation"><summary>推荐说明</summary><MessagePrimitive.Parts /></details>)}
    {reply && last && reply.options.length > 0 && <div className="assistant-options" aria-label="快捷回答">
      {reply.options.map(option => <button type="button" key={option} disabled={blocked} onClick={() => sendOption(option)}>{option}</button>)}
    </div>}
  </MessagePrimitive.Root>;
}

function Conversation({ api, credentials, initialSession, onNew, locked, focusInput, onActivity, embedded,
  onCollapse, recognizeFilters, onRecognizeFilters, catalogPlatform, initialDraft, notice }) {
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
  const [draftError, setDraftError] = useState('');
  const [phase, setPhase] = useState(active.current?.phase ?? '');
  const [needs, setNeeds] = useState(initialSession.needs);
  const [completed, setCompleted] = useState(null);
  const [started, setStarted] = useState(initialSession.turns.length > 0);
  const [topic, setTopic] = useState(() => {
    const text = initialSession.turns[0]?.inputText.split('\n').at(-1);
    return ASSISTANT_STARTERS.includes(text) ? text : '';
  });
  const input = useRef(null);

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
    if (mounted.current) {
      setUncertain(false); setNeeds(session.current.needs); setPhase('');
      setCompleted(turn.id + ':' + turn.eventVersion);
    }
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
          return { content: [{ type: 'text', text: '对话已更新，正在恢复记录。' }] };
        }
        if (mounted.current) { setError(failure.message); setUncertain(true); }
        return { content: [{ type: 'text', text: '连接中断，请重新连接查看这条消息的结果。' }] };
      } finally { if (mounted.current) setBusy(false); }
    },
  }), [api, credentials]);
  const runtime = useLocalRuntime(adapter, { initialMessages: historyMessages(initialSession), maxSteps: 1 });
  const draftRestored = useRef(false);
  useEffect(() => {
    if (!draftRestored.current) {
      draftRestored.current = true;
      if (initialDraft) runtime.thread.composer.setText(initialDraft);
    }
  }, [runtime, initialDraft]);
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
  useEffect(() => {
    onActivity?.({ busy, attention: uncertain || Boolean(error), completed });
  }, [busy, uncertain, error, completed, onActivity]);
  useEffect(() => {
    if (focusInput) input.current?.focus({ preventScroll: true });
  }, [focusInput]);
  const blocked = busy || uncertain || locked;
  const link = assistantListLink(needs);
  const labels = needsLabels(needs);
  const platform = recognizeFilters ? selectedAssistantPlatform(embedded, catalogPlatform) : null;
  const purpose = needs.purpose || topic;
  const title = purpose ? purpose === '比较报价' ? purpose : `${purpose}选购` : '帮你选购';
  const hasListFilters = Boolean(new URL(link.href, window.location.origin).searchParams.get('platform')
    || needs.requiredTags.length || needs.warrantyDaysMin);
  function messageWithContext(text) {
    if (blocked || !text.trim()) return null;
    const selected = recognizeFilters ? selectedAssistantPlatform(embedded, catalogPlatform) : null;
    const message = selected ? `当前页面筛选：${selected.label}\n${text}` : text;
    if (message.length > ASSISTANT_LIMITS.userTextMaxChars) {
      setDraftError('包含筛选信息后最多 2,000 字，请缩短内容或取消识别当前筛选。');
      return null;
    }
    setDraftError('');
    if (!started && ASSISTANT_STARTERS.includes(text)) setTopic(text);
    setStarted(true);
    return message;
  }
  function sendOption(text) {
    const message = messageWithContext(text);
    if (message) runtime.thread.append({ role: 'user', content: [{ type: 'text', text: message }] });
  }
  function sendDraft(event) {
    event.preventDefault();
    const text = messageWithContext(runtime.thread.composer.getState().text);
    if (!text) return;
    runtime.thread.composer.setText(text);
    runtime.thread.composer.send();
  }
  return <AssistantRuntimeProvider runtime={runtime}>
    <ConversationContext.Provider value={{ blocked, sendOption }}>
      <AssistantHeader title={title} labels={labels} recognizeFilters={recognizeFilters}
        onRecognizeFilters={value => { onRecognizeFilters(value); setDraftError(''); }} blocked={blocked}
        clearDisabled={busy || stopping || locked} onClear={onNew} onCollapse={onCollapse} />
      {notice}
      <ThreadPrimitive.Root className={'assistant-thread' + (!started ? ' assistant-thread-empty' : '')}>
        {!started && <AssistantWelcome disabled={blocked} onStart={sendOption} />}
        <ThreadPrimitive.Viewport className="assistant-viewport" turnAnchor="top">
          <ThreadPrimitive.Messages components={{ UserMessage: Message, AssistantMessage: Message }} />
        </ThreadPrimitive.Viewport>
        <div role="status" aria-live="polite" className="assistant-progress">{busy ? PHASES[phase] ?? '正在同步会话' : ''}</div>
        {error && <div role="alert" className="assistant-error"><p>{error}</p>
          <button type="button" disabled={busy} onClick={() => void reconnect()}>重新连接</button></div>}
        {hasListFilters && <details className="assistant-list-link"><summary>浏览更多商品</summary>
          <a href={link.href}>按条件浏览商品</a><p>预算、用途与偏好未带入</p></details>}
        {draftError && <p role="alert" className="assistant-draft-error">{draftError}</p>}
        <AssistantPlatformChip platform={platform} disabled={blocked} onRemove={() => onRecognizeFilters(false)} />
        <ComposerPrimitive.Root className="assistant-composer" onSubmit={sendDraft}>
          <ComposerPrimitive.Input ref={input} aria-label="告诉助手你的需求" placeholder={started ? '用途、预算，或想买的商品…' : '也可以直接说说你的需求…'}
            maxLength={ASSISTANT_LIMITS.userTextMaxChars} disabled={uncertain || locked} addAttachmentOnPaste={false}
            cancelOnEscape={false} unstable_focusOnRunStart={false} unstable_focusOnScrollToBottom={false}
            unstable_focusOnThreadSwitched={false}
            onChange={() => setDraftError('')}
            onKeyDown={event => {
              if (blocked && event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) event.preventDefault();
            }} />
          {busy && <button type="button" className="assistant-stop" onClick={() => void stop()} disabled={stopping}>{stopping ? '停止中' : '停止'}</button>}
          <ComposerPrimitive.Send disabled={blocked} aria-label="发送" onClick={sendDraft}>发送</ComposerPrimitive.Send>
        </ComposerPrimitive.Root>
        <p className="assistant-input-note">内容由AI生成，仅供参考</p>
      </ThreadPrimitive.Root>
    </ConversationContext.Provider>
  </AssistantRuntimeProvider>;
}

export default function AssistantPage({ api = assistantApi, embedded = false, enabled = false,
  focusInput = !embedded && !window.matchMedia?.('(max-width: 600px)').matches, onActivity, onCollapse, catalogPlatform }) {
  const [state, setState] = useState({ loading: true });
  const [generation, setGeneration] = useState(0);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState('');
  const [recognizeFilters, setRecognizeFilters] = useState(true);
  const [connectingDraft, setConnectingDraft] = useState('');
  const cancelClear = useRef(null);
  const clearOpener = useRef(null);
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
        credentials.current = currentCredentials;
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
  useEffect(() => {
    if (confirmClear) cancelClear.current?.focus();
    else clearOpener.current?.focus({ preventScroll: true });
  }, [confirmClear]);
  async function newConversation() {
    if (clearing) return;
    setClearing(true); setClearError('');
    try {
      if (credentials.current) {
        try { await api.deleteSession(credentials.current); }
        catch (failure) { if (![404, 410].includes(failure.status)) throw failure; }
      }
      sessionStorage.removeItem(STORAGE_KEY);
      credentials.current = null;
      setConnectingDraft('');
      setRecognizeFilters(true);
      setConfirmClear(false);
      setState({ loading: true });
      setGeneration(value => value + 1);
    } catch (failure) { setClearError(failure.message); }
    finally { setClearing(false); }
  }
  const Container = embedded ? 'div' : 'main';
  const onNew = opener => { clearOpener.current = opener; setConfirmClear(true); };
  const confirmation = confirmClear && <section className="assistant-clear" aria-label="清空当前对话">
      <p>清空后无法恢复这段对话。</p>
      {clearError && <p role="alert">{clearError}</p>}
      <div><button ref={cancelClear} type="button" disabled={clearing} onClick={() => {
        setConfirmClear(false); setClearError('');
      }}>取消</button>
        <button type="button" disabled={clearing} onClick={() => void newConversation()}>{clearing ? '正在清空' : '确认清空'}</button></div>
    </section>;
  return <Container className={'assistant-page' + (embedded ? ' assistant-embedded' : '')}>
    {!embedded && <header className="assistant-header"><Brand /><a href="/guide">选购指南</a></header>}
    {state.session ? <Conversation key={generation} api={api} credentials={credentials.current} initialSession={state.session} embedded={embedded}
      onNew={onNew} locked={confirmClear || clearing} focusInput={focusInput && !confirmClear} onActivity={onActivity}
      onCollapse={onCollapse} recognizeFilters={recognizeFilters} onRecognizeFilters={setRecognizeFilters}
      catalogPlatform={catalogPlatform} initialDraft={connectingDraft} notice={confirmation} />
      : <>
        <AssistantHeader recognizeFilters={recognizeFilters} onRecognizeFilters={setRecognizeFilters}
          blocked={confirmClear || clearing} clearDisabled={state.loading || confirmClear || clearing}
          onClear={onNew} onCollapse={onCollapse} />
        {confirmation}
        {state.disabled ? <section className="assistant-fallback">
          <h2>导购助手暂未启用</h2><a href="/guide">查看选购指南</a><a href="/">返回商品列表</a>
        </section> : <div className="assistant-thread assistant-thread-empty">
          <AssistantWelcome disabled />
          {state.error && <div className="assistant-error">
            <p role="alert">{state.error}</p>
            <button type="button" disabled={confirmClear} onClick={() => {
              setState({ loading: true }); setGeneration(value => value + 1);
            }}>重试连接</button>
          </div>}
          <AssistantPlatformChip platform={recognizeFilters ? selectedAssistantPlatform(embedded, catalogPlatform) : null}
            disabled={confirmClear || clearing} onRemove={() => setRecognizeFilters(false)} />
          <div className="assistant-composer">
            <textarea aria-label="先写下需求" placeholder="也可以直接说说你的需求…" rows={2}
              maxLength={ASSISTANT_LIMITS.userTextMaxChars} value={connectingDraft} disabled={confirmClear || clearing}
              onChange={event => setConnectingDraft(event.target.value)} />
            <button type="button" aria-label="发送" disabled>{state.loading ? <span role="status">连接中</span> : '发送'}</button>
          </div>
          <p className="assistant-input-note">内容由AI生成，仅供参考</p>
        </div>}
      </>}
  </Container>;
}
