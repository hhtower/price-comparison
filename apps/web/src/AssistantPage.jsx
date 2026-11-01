import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  AssistantRuntimeProvider, ComposerPrimitive, ExportedMessageRepository, MessagePrimitive,
  ThreadPrimitive, useAuiState, useLocalRuntime,
} from '@assistant-ui/react';
import {
  ASSISTANT_LIMITS, emptyShoppingNeeds, isTurnTerminal, validateAssistantReply,
} from '@price-comparison/catalog/assistant-contract';
import { normalizePurchaseTag, purchaseWarrantyLabel } from '@price-comparison/catalog/purchase-attributes';
import Brand from './Brand.jsx';
import { assistantApi, ASSISTANT_SERVICE_ERROR } from './assistant-api.js';
import ContactAdminButton from './ContactAdminButton.jsx';
import { displayPurchaseTagText } from './purchase-tag-values.js';
import { formatMoney } from './money.js';
import { readCatalog, formatPeriod } from './official-reference.js';
import { assistantOfficialPrice } from './assistant-official-price.js';
import OfferTagDetails, { offerConditions } from './OfferTagDetails.jsx';
import AssistantLoading from './AssistantLoading.jsx';
import { AssistantHeader, AssistantWelcome, AssistantPlatformChip, AssistantSendIcon, ASSISTANT_STARTERS, selectedAssistantPlatform } from './AssistantControls.jsx';
import './assistant.css';

const STORAGE_KEY = 'shopping-assistant';
const REASONING_EXPANDED_KEY = 'shopping-assistant-reasoning-expanded';
const ConversationContext = createContext(null);
const PHASES = { queued: '正在准备查询', understanding: '正在理解需求', searching: '正在查找报价', explaining: '正在整理推荐' };
const PREFERENCES = { lower_price: '价格优先', simple_setup: '操作简单', longer_warranty: '质保优先' };

function needsLabels(needs) {
  return [
    needs.purpose,
    needs.budget && `${needs.budget.basis === 'month' ? '每月' : '单次'} ≤ ${formatMoney(needs.budget.amount, needs.budget.currency)}`,
    needs.platform,
    needs.product,
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
  } catch { throw new Error('浏览器无法保存对话，请允许此网站保存数据后重试。'); }
}
function storedCredentials() {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (!/^[a-f0-9-]{36}$/iu.test(value?.sessionId) || typeof value?.accessToken !== 'string' || !value.accessToken
      || value.pendingMessageId && !/^[a-f0-9-]{36}$/iu.test(value.pendingMessageId)) throw new Error();
    return { sessionId: value.sessionId, accessToken: value.accessToken, pendingMessageId: value.pendingMessageId };
  } catch { throw new Error('无法读取已保存的对话，请清空对话后重新提问。'); }
}
function turnResult(turn, recentTurns) {
  if (turn.status === 'succeeded') {
    const reply = validateAssistantReply(turn.reply);
    return { content: [{ type: 'text', text: reply.text }], metadata: { custom: { reply, turnId: turn.id } } };
  }
  const code = turn.errorCode?.toLowerCase();
  const invalidResponse = turn.status === 'failed' && code === 'model_invalid_response';
  const retryExhausted = recentTurns.length === 3 && recentTurns.every(item => item.status === 'failed'
    && item.errorCode?.toLowerCase() === 'model_invalid_response' && item.inputText === turn.inputText);
  const retryText = invalidResponse && !retryExhausted ? turn.inputText : null;
  const contactAdmin = turn.status !== 'cancelled' && code !== 'input_too_large' && !retryText;
  const text = turn.status === 'cancelled' ? '已停止查找。你可以继续提问。'
    : invalidResponse ? retryText ? '这次回复没能正常生成，请点击“重试”。' : '重试后仍未能正常回复，请进群联系管理员处理。'
      : code?.includes('timeout') || code?.includes('deadline') ? '等待回复超时，请进群联系管理员处理。'
      : code === 'input_too_large' ? '对话内容太长，请清空对话后重新提问。'
        : ASSISTANT_SERVICE_ERROR;
  return { content: [{ type: 'text', text }], metadata: { custom: { contactAdmin, retryText, turnId: turn.id } } };
}
function historyMessages(session) {
  return session.turns.flatMap((turn, index) => [
    { id: 'user-' + turn.id, role: 'user', content: turn.inputText },
    ...(isTurnTerminal(turn.status) ? [{ id: 'assistant-' + turn.id, role: 'assistant', ...turnResult(turn, session.turns.slice(Math.max(0, index - 2), index + 1)) }] : []),
  ]);
}
function RunStatus() {
  const { phase, stopping } = useContext(ConversationContext);
  return <div role="status" aria-live="polite" className="assistant-run-status">
    <span className="assistant-spinner" aria-hidden="true" />
    {stopping ? '正在停止' : PHASES[phase] ?? '正在读取最新消息'}
  </div>;
}

function RestoredRunStatus() {
  const running = useAuiState(state => state.thread.isRunning);
  const { busy, reasoning, activeTurnId } = useContext(ConversationContext);
  return busy && !running ? <div className="assistant-message assistant-message-assistant">
    <Reasoning text={reasoning[activeTurnId]} running /><RunStatus />
  </div> : null;
}

function Reasoning({ text, running }) {
  const { expandReasoning } = useContext(ConversationContext);
  const [open, setOpen] = useState(expandReasoning);
  const content = useRef(null);
  const following = useRef(true);
  useEffect(() => { setOpen(expandReasoning); }, [expandReasoning]);
  useEffect(() => {
    if (open && following.current && content.current) content.current.scrollTop = content.current.scrollHeight;
  }, [text, open]);
  if (!text) return null;
  return <details className="assistant-reasoning" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{running ? '思考中' : '思考过程'}</summary>
    <div ref={content} className="assistant-reasoning-text" data-streaming={running || undefined} onScroll={event => {
      const element = event.currentTarget;
      following.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 24;
    }}>{text}</div>
  </details>;
}

function QuoteCard({ card, catalog }) {
  const [open, setOpen] = useState(false);
  const offer = card.offer ?? { name: card.title, shop: `商铺 #${card.shopId}`, tags: [] };
  const price = <p className="assistant-price">{formatMoney(card.price, card.currency)}</p>;
  const reference = assistantOfficialPrice(card, catalog);
  const facts = offerConditions(offer);
  const summary = facts.filter(fact => ['delivery', 'access'].includes(fact.name) || /^duration(?:_|$)/u.test(fact.name))
    .map(fact => displayPurchaseTagText(fact, fact.value)).join(' · ');
  const warrantyTags = offer.tags.flatMap(normalizePurchaseTag)
    .filter(tag => !['warranty_terms', 'warranty_exclusion'].includes(tag.name));
  const conflictingWarranty = warrantyTags.some(tag => tag.name.startsWith('warranty')
    && warrantyTags.some(other => other.name === tag.name && other.value !== tag.value));
  const warranty = conflictingWarranty ? '资料冲突，需核实'
    : purchaseWarrantyLabel(warrantyTags).replace(/^质保/u, '');
  const channel = facts.filter(fact => fact.name === 'payment_platform').map(fact => fact.value).join(' / ');
  const conditions = facts.filter(fact => fact.displayGroup === 'requirements' && !['subscription_override', 'payment_platform'].includes(fact.name));
  const warnings = facts.filter(fact => ['warranty_exclusion', 'subscription_override'].includes(fact.name))
    .map(fact => displayPurchaseTagText(fact, fact.value));
  if (facts.some(fact => fact.name === 'warranty_terms')) warnings.push('售后条款见详情');
  const rows = [['充值渠道', channel], ['质保', warranty], ['购买条件', conditions.map(fact => displayPurchaseTagText(fact, fact.value)).join('；')],
    ['注意事项', [...new Set(warnings)].join('；')]].filter(([, value]) => value);
  const fullNotes = <>
    {card.reasons.length > 0 && <ul className="assistant-card-reasons">{card.reasons.filter(reason => !card.caveats.includes(reason)).map(reason => <li key={reason}>{reason}</li>)}</ul>}
    {card.caveats.map(caveat => <p className="assistant-caveat" key={caveat}>{caveat}</p>)}
    <p>采集于 <time dateTime={card.capturedAt}>{new Date(card.capturedAt).toLocaleString('zh-CN')}</time></p>
  </>;
  return <article className="assistant-card">
    <div className="assistant-card-heading"><h2>{card.title}</h2>{price}</div>
    <div className="assistant-offer-meta"><span>店铺：{offer.shop}</span>{summary && <span>{summary}</span>}</div>
    {reference && <p className="assistant-official-price">
      <span>官方内购参考 · {reference.countryName} · {formatPeriod(reference.period)}</span>
      <span>{formatMoney(reference.amount, '')} {reference.currency}
        {reference.currency !== 'CNY' && `（约 ${formatMoney(reference.cnyAmount)}）`}</span>
    </p>}
    {rows.length > 0 && <details className="assistant-purchase-notes"><summary>购买须知{conditions.some(fact => fact.name === 'usage_restriction') && <small>有使用限制</small>}</summary>
      <dl>{rows.map(([label, value]) => <div key={label}><dt>{label}：</dt><dd>{value}</dd></div>)}</dl>
    </details>}
    <button type="button" className="assistant-offer-details" aria-haspopup="dialog" onClick={() => setOpen(true)}>查看报价详情</button>
    {open && <OfferTagDetails offer={offer} item={{ name: card.title }} onClose={() => setOpen(false)}>
      {price}{fullNotes}
      {reference && <p className="assistant-quote-note">{!reference.regionMatched && '报价地区未明确，'}{!reference.periodMatched && '报价周期未明确，'}
        官方参考取已采集有效报价中{reference.regionMatched && '同地区、'}同套餐{reference.periodMatched && '、同周期'}的最低折算价，来自 {reference.countryName} App Store，地区账号和支付条件适用。
        采集于 <time dateTime={reference.capturedAt}>{new Date(reference.capturedAt).toLocaleString('zh-CN')}</time>
        {reference.exchangeDate && `；汇率日期 ${reference.exchangeDate}`}。</p>}
      <p className="assistant-quote-note">这是本次推荐的报价快照，下单前请到商家核对价格、库存和完整条款。</p>
      {offer.productUrl && <p><a href={offer.productUrl} target="_blank" rel="noopener noreferrer">前往商家核对报价</a></p>}
    </OfferTagDetails>}
  </article>;
}

function QuoteCards({ cards }) {
  const [catalog, setCatalog] = useState(null);
  const hasCards = cards.length > 0;
  useEffect(() => {
    if (!hasCards) return undefined;
    const controller = new AbortController();
    readCatalog(controller.signal).then(result => {
      if (!controller.signal.aborted) setCatalog(result);
    }).catch(() => { /* Reference prices are optional; merchant quotes remain usable. */ });
    return () => controller.abort();
  }, [hasCards]);
  return <div className="assistant-cards">{cards.map(card =>
    <QuoteCard card={card} catalog={catalog} key={card.productId} />)}</div>;
}

function Message() {
  const role = useAuiState(state => state.message.role);
  const reply = useAuiState(state => state.message.metadata.custom?.reply);
  const contactAdmin = useAuiState(state => state.message.metadata.custom?.contactAdmin);
  const retryText = useAuiState(state => state.message.metadata.custom?.retryText);
  const last = useAuiState(state => state.message.isLast);
  const running = useAuiState(state => state.message.status?.type === 'running');
  const turnId = useAuiState(state => state.message.metadata.custom?.turnId);
  const { sendOption, retry, blocked, reasoning, activeTurnId } = useContext(ConversationContext);
  return <MessagePrimitive.Root className={'assistant-message assistant-message-' + role}>
    {role === 'assistant' && <Reasoning text={reasoning[running ? activeTurnId : turnId]} running={running} />}
    {running ? <RunStatus /> : <MessagePrimitive.Parts />}
    {contactAdmin && <div className="assistant-options"><ContactAdminButton /></div>}
    {retryText && last && <div className="assistant-options">
      <button type="button" disabled={blocked} onClick={() => retry(retryText)}>重试</button>
    </div>}
    {reply && <QuoteCards cards={reply.cards} />}
    {reply && last && reply.options.length > 0 && <div className="assistant-options" aria-label="快捷回答">
      {reply.options.map(option => <button type="button" key={option} disabled={blocked} onClick={() => sendOption(option)}>{option}</button>)}
    </div>}
  </MessagePrimitive.Root>;
}

function Conversation({ api, credentials, initialSession, onNew, locked, focusInput, onActivity, embedded,
  onCollapse, recognizeFilters, onRecognizeFilters, expandReasoning, onExpandReasoning, catalogPlatform, notice }) {
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
  const [reasoning, setReasoning] = useState({});
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
    if (!isTurnTerminal(turn.status)) throw new Error('还没有收到回复，请点击“重新连接”继续等待。');
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
    return turnResult(turn, turns.slice(-3));
  }
  async function watch(turn, signal) {
    acceptSnapshot(turn);
    if (isTurnTerminal(turn.status)) return turn;
    try { return await api.subscribeTurn(credentials, turn, acceptSnapshot, signal, text => {
      if (mounted.current && !signal.aborted && active.current?.id === turn.id && !isTurnTerminal(active.current.status)) {
        setReasoning(previous => ({ ...previous, [turn.id]: text }));
      }
    }); }
    catch (failure) {
      if (active.current && isTurnTerminal(active.current.status)) return active.current;
      throw failure;
    }
  }
  async function sendPending(signal) {
    const input = pending.current;
    if (!input) throw new Error('无法找回上一条消息，请清空对话后重新提问。');
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
        return { content: [{ type: 'text', text: pending.current
          ? '上一条消息还没收到回复，请点击“重新连接”查看结果。' : '请输入 1 至 2,000 字的问题。' }] };
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
          return { content: [{ type: 'text', text: '正在读取最新消息，请稍候。' }] };
        }
        if (mounted.current) { setError(failure); setUncertain(true); }
        return { content: [{ type: 'text', text: failure.contactAdmin ? failure.message : '暂时无法查看回复，请点击“重新连接”。' }] };
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
      if (mounted.current) { setError(failure); setUncertain(true); }
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
      if (!turn) throw new Error('暂时无法停止查找，请点击“重新连接”后再试。');
      const cancelled = await api.cancelTurn(credentials, turn.id);
      const restored = await api.readSession(credentials);
      const authoritative = restored.turns.find(item => item.id === turn.id);
      session.current = restored;
      acceptSnapshot(authoritative && authoritative.eventVersion >= cancelled.eventVersion ? authoritative : cancelled);
      if (!isTurnTerminal(active.current.status)) throw new Error('还没确认是否停止，请点击“重新连接”查看结果。');
      connection.current?.abort();
    } catch (failure) { if (mounted.current) setError(failure); }
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
  const labels = needsLabels(needs);
  const platform = recognizeFilters ? selectedAssistantPlatform(embedded, catalogPlatform) : null;
  const purpose = needs.purpose || topic;
  const title = purpose || '选购';
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
  function retry(text) {
    if (blocked || pending.current || runtime.thread.getState().isRunning) return;
    runtime.thread.append({ role: 'user', content: [{ type: 'text', text }] });
  }
  function sendDraft(event) {
    event.preventDefault();
    const text = messageWithContext(runtime.thread.composer.getState().text);
    if (!text) return;
    runtime.thread.composer.setText(text);
    runtime.thread.composer.send();
  }
  return <AssistantRuntimeProvider runtime={runtime}>
    <ConversationContext.Provider value={{ blocked, sendOption, retry, busy, phase, stopping, reasoning, expandReasoning, activeTurnId: active.current?.id }}>
      <AssistantHeader title={title} labels={labels} recognizeFilters={recognizeFilters}
        expandReasoning={expandReasoning} onExpandReasoning={onExpandReasoning}
        onRecognizeFilters={value => { onRecognizeFilters(value); setDraftError(''); }} blocked={blocked}
        clearDisabled={busy || stopping || locked || (!started && !uncertain)} onClear={onNew} onCollapse={onCollapse} />
      {notice}
      <ThreadPrimitive.Root className={'assistant-thread' + (!started ? ' assistant-thread-empty' : '')}>
        {!started && <AssistantWelcome disabled={blocked} onStart={sendOption} />}
        <ThreadPrimitive.Viewport className="assistant-viewport" turnAnchor="top">
          <ThreadPrimitive.Messages components={{ UserMessage: Message, AssistantMessage: Message }} />
          <RestoredRunStatus />
        </ThreadPrimitive.Viewport>
        {error && <div role="alert" className="assistant-error"><p>{error.message}</p>
          {error.contactAdmin && <ContactAdminButton disabled={locked} />}
          <button type="button" disabled={busy} onClick={() => void reconnect()}>重新连接</button></div>}
        {draftError && <p role="alert" className="assistant-draft-error">{draftError}</p>}
        <ComposerPrimitive.Root className="assistant-composer" onSubmit={sendDraft}>
          <AssistantPlatformChip platform={platform} disabled={blocked} onRemove={() => { onRecognizeFilters(false); setDraftError(''); }} />
          <div className="assistant-composer-row">
            <ComposerPrimitive.Input ref={input} aria-label="告诉助手你的需求" placeholder="说说你的需求…" minRows={1} maxRows={4}
              maxLength={ASSISTANT_LIMITS.userTextMaxChars} disabled={uncertain || locked} addAttachmentOnPaste={false}
              cancelOnEscape={false} unstable_focusOnRunStart={false} unstable_focusOnScrollToBottom={false}
              unstable_focusOnThreadSwitched={false}
              onChange={() => setDraftError('')}
              onKeyDown={event => {
                if (blocked && event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) event.preventDefault();
              }} />
            {busy ? <button type="button" className="assistant-stop" onClick={() => void stop()} disabled={stopping}>{stopping ? '停止中' : '停止'}</button>
              : <ComposerPrimitive.Send disabled={blocked} aria-label="发送" title="发送" className="assistant-send" onClick={sendDraft}><AssistantSendIcon /></ComposerPrimitive.Send>}
          </div>
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
  const [expandReasoning, setExpandReasoning] = useState(() => {
    try { return localStorage.getItem(REASONING_EXPANDED_KEY) === 'true'; }
    catch { return false; }
  });
  function changeExpandReasoning(value) {
    setExpandReasoning(value);
    try { localStorage.setItem(REASONING_EXPANDED_KEY, String(value)); }
    catch { /* Keep the preference usable in memory when browser storage is unavailable. */ }
  }
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
      } catch (failure) { if (live && !controller.signal.aborted) setState({ error: failure }); }
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
      setRecognizeFilters(true);
      setConfirmClear(false);
      setState({ loading: true });
      setGeneration(value => value + 1);
    } catch (failure) { setClearError(failure); }
    finally { setClearing(false); }
  }
  const Container = embedded ? 'div' : 'main';
  const onNew = opener => { clearOpener.current = opener; setConfirmClear(true); };
  const confirmation = confirmClear && <section className="assistant-clear" aria-label="清空当前对话">
      <p>清空后无法恢复这段对话。</p>
      {clearError && <><p role="alert">{clearError.message}</p>
        {clearError.contactAdmin && <ContactAdminButton disabled={clearing} />}</>}
      <div><button ref={cancelClear} type="button" disabled={clearing} onClick={() => {
        setConfirmClear(false); setClearError('');
      }}>取消</button>
        <button type="button" disabled={clearing} onClick={() => void newConversation()}>{clearing ? '正在清空' : '确认清空'}</button></div>
    </section>;
  if (!state.session && !state.disabled) return <AssistantLoading embedded={embedded} onCollapse={onCollapse} error={state.error}
    notice={confirmation} blocked={confirmClear || clearing} onClear={event => onNew(event.currentTarget)}
    onRetry={() => { setState({ loading: true }); setGeneration(value => value + 1); }} />;
  return <Container className={'assistant-page' + (embedded ? ' assistant-embedded' : '')}>
    {!embedded && <header className="assistant-header"><Brand /><a href="/guide">选购指南</a></header>}
    {state.session ? <Conversation key={generation} api={api} credentials={credentials.current} initialSession={state.session} embedded={embedded}
      onNew={onNew} locked={confirmClear || clearing} focusInput={focusInput && !confirmClear} onActivity={onActivity}
      onCollapse={onCollapse} recognizeFilters={recognizeFilters} onRecognizeFilters={setRecognizeFilters}
      expandReasoning={expandReasoning} onExpandReasoning={changeExpandReasoning}
      catalogPlatform={catalogPlatform} notice={confirmation} />
      : <>
        <AssistantHeader recognizeFilters={recognizeFilters} onRecognizeFilters={setRecognizeFilters}
          expandReasoning={expandReasoning} onExpandReasoning={changeExpandReasoning}
          blocked={confirmClear || clearing} clearDisabled={confirmClear || clearing}
          onClear={onNew} onCollapse={onCollapse} />
        {confirmation}
        <section className="assistant-fallback">
          <h2>导购助手暂未启用</h2><a href="/guide">查看选购指南</a><a href="/">返回商品列表</a>
        </section>
      </>}
  </Container>;
}
