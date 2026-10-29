import { ANALYTICS_PAGES, PAGE_ACTIONS, validReferenceContext } from '../../api/src/analytics/analytics-contract.ts';
const SESSION_IDLE_MS = 30 * 60 * 1000;
const VISITOR_TTL_MS = 365 * 86400000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VISITOR_KEY = 'price-radar:visitor';
const SESSION_KEY = 'price-radar:session';
function id() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function read(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
function write(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Private mode still works for this page lifetime. */ } }
function validIdentity(value) { return value && UUID.test(value.id) && Number.isFinite(value.at) && value.at <= Date.now(); }
function categories() {
  const ua = navigator.userAgent || '';
  const device = /iPad|Tablet|Android(?!.*Mobile)/i.test(ua) || /Macintosh/.test(ua) && navigator.maxTouchPoints > 1 ? 'tablet' : /Mobi|iPhone|Android/i.test(ua) ? 'mobile' : 'desktop';
  const browser = /Edg/i.test(ua) ? 'edge' : /Firefox|FxiOS/i.test(ua) ? 'firefox' : /Chrome|CriOS/i.test(ua) ? 'chrome' : /Safari/i.test(ua) ? 'safari' : 'other';
  let source = 'direct';
  try { if (document.referrer) source = new URL(document.referrer).origin === location.origin ? 'internal' : 'external'; } catch { /* Keep category only. */ }
  return { device, browser, source };
}

export function createVisitTracker() {
  let current = null;
  let visitor = null;
  let session = null;
  function identities() {
    const now = Date.now();
    const savedVisitor = read(VISITOR_KEY) || visitor;
    visitor = validIdentity(savedVisitor) && now - savedVisitor.at < VISITOR_TTL_MS ? savedVisitor : { id: id(), at: now };
    const savedSession = read(SESSION_KEY) || session;
    session = { id: validIdentity(savedSession) && now - savedSession.at < SESSION_IDLE_MS ? savedSession.id : id(), at: now };
    write(VISITOR_KEY, visitor); write(SESSION_KEY, session);
    return { visitorId: visitor.id, sessionId: session.id };
  }
  function newVisit(page) {
    const identity = identities();
    return { ...identity, visitId: id(), page, ...categories(), activeMs: 0, actions: [], tick: Date.now(), lastActivity: Date.now(), visible: document.visibilityState !== 'hidden' };
  }
  function accrue() {
    if (!current) return;
    const now = Date.now();
    if (current.visible) current.activeMs = Math.min(86400000, current.activeMs + Math.max(0, Math.min(now, current.lastActivity + SESSION_IDLE_MS) - current.tick));
    current.tick = now;
  }
  function send() {
    if (!current) return;
    accrue();
    const { tick, lastActivity, visible, ...payload } = current;
    current.actions = [];
    try {
      // No credentials, URLs, user input or raw UA can enter this fixed payload.
      void fetch('/api/analytics/collect', { method: 'POST', credentials: 'omit', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, activeMs: Math.floor(payload.activeMs) }) }).catch(() => {});
    } catch { /* Telemetry must never interrupt the consumer flow. */ }
  }
  function activity() {
    if (!current || document.visibilityState === 'hidden') return;
    accrue();
    const saved = read(SESSION_KEY);
    if (Date.now() - current.lastActivity >= SESSION_IDLE_MS || validIdentity(saved) && saved.id !== current.sessionId) {
      const page = current.page; send(); current = newVisit(page); send();
    }
    current.lastActivity = Date.now();
    session = { id: current.sessionId, at: current.lastActivity }; write(SESSION_KEY, session);
  }
  function action(name, reference) {
    try {
      if (!current || !PAGE_ACTIONS[current.page]?.includes(name) || !validReferenceContext(name, reference)) return;
      activity();
      current.actions.push({ id: id(), name, ...(reference ? { reference } : {}) });
      send();
    } catch { /* A browser restriction must not break the action being measured. */ }
  }
  function start(page) {
    if (!Object.hasOwn(ANALYTICS_PAGES, page)) return () => {};
    try { current = newVisit(page); } catch { return () => {}; }
    send();
    const onVisibility = () => {
      accrue(); current.visible = document.visibilityState !== 'hidden';
      if (current.visible) activity();
      else send();
    };
    const onPageShow = event => {
      if (!current) return;
      if (event.persisted) { current = newVisit(current.page); send(); }
      else { current.visible = document.visibilityState !== 'hidden'; current.tick = Date.now(); activity(); }
    };
    const onPageHide = () => { send(); if (current) current.visible = false; };
    const interval = window.setInterval(() => { if (current?.visible) send(); }, 30000);
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('pointerdown', activity, { passive: true });
    document.addEventListener('keydown', activity);
    document.addEventListener('scroll', activity, { passive: true, capture: true });
    window.addEventListener('pagehide', onPageHide); window.addEventListener('pageshow', onPageShow);
    let stopped = false;
    return () => {
      if (stopped) return; stopped = true; send(); current = null;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('pointerdown', activity); document.removeEventListener('keydown', activity);
      document.removeEventListener('scroll', activity, true);
      window.removeEventListener('pagehide', onPageHide); window.removeEventListener('pageshow', onPageShow);
    };
  }
  return { start, action };
}
const tracker = createVisitTracker();
export const startPageVisit = tracker.start;
export const trackUsage = tracker.action;
