import React, { lazy, Suspense, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { assistantApi } from './assistant-api.js';
import './assistant.css';

const AssistantPage = lazy(() => import('./AssistantPage.jsx'));
const MOBILE = '(max-width: 600px)';
export default function AssistantWidget({ api = assistantApi, catalogPlatform }) {
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const [visited, setVisited] = useState(false);
  const [mobile, setMobile] = useState(() => window.matchMedia?.(MOBILE).matches ?? false);
  const [activity, setActivity] = useState({ busy: false, attention: false, completed: null });
  const [unread, setUnread] = useState(false);
  const lastCompleted = useRef(null);
  const launcher = useRef(null);
  const dialog = useRef(null);
  const id = useId();
  useEffect(() => {
    const controller = new AbortController();
    api.status(controller.signal).then(status => {
      if (!controller.signal.aborted) setEnabled(status.enabled);
    }).catch(() => {});
    const media = window.matchMedia?.(MOBILE);
    const resize = () => setMobile(media.matches);
    media?.addEventListener('change', resize);
    return () => { controller.abort(); media?.removeEventListener('change', resize); };
  }, [api]);
  useLayoutEffect(() => {
    const panel = dialog.current;
    if (!panel) return;
    if (!open) { if (panel.open) panel.close(); return; }
    if (mobile) panel.showModal();
    else panel.show();
    (mobile ? panel.querySelector('[aria-label="收起导购助手"]') : panel.querySelector('textarea:not(:disabled)') ?? panel.querySelector('[aria-label="收起导购助手"]'))?.focus({ preventScroll: true });
    return () => {
      if (panel.open) panel.close();
      launcher.current?.focus({ preventScroll: true });
    };
  }, [open, mobile]);
  useEffect(() => {
    if (open) setUnread(false);
    else if (activity.completed && activity.completed !== lastCompleted.current) setUnread(true);
    lastCompleted.current = activity.completed;
  }, [activity.completed, open]);
  if (!enabled) return null;
  const collapse = () => setOpen(false);
  return <div className="assistant-widget">
    <button type="button" className="assistant-launcher" ref={launcher}
      aria-label="打开导购助手" aria-expanded={open} aria-controls={id} aria-haspopup="dialog"
      onClick={() => { setVisited(true); setOpen(value => !value); }}>
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3v-3a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" /><path d="M7 9h10M7 13h6" /></svg>
      <span>导购助手</span>
      <span className="assistant-launcher-status" role="status">{activity.busy ? '正在查找' : activity.attention ? '连接中断' : unread ? '有新回复' : ''}</span>
    </button>
    <dialog id={id} ref={dialog} className="assistant-widget-panel" aria-label="导购助手"
      aria-modal={mobile ? 'true' : 'false'}
      onCancel={event => { event.preventDefault(); collapse(); }}
      onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
        event.preventDefault(); event.stopPropagation(); collapse();
      } }}>
      {/* Keep the runtime mounted while collapsed, including its draft and read subscription. */}
      {visited && <Suspense fallback={<div className="assistant-module-loading">
        <button type="button" className="assistant-icon-button" aria-label="收起导购助手" title="收起" onClick={collapse}>
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
        </button>
        <p role="status">正在加载…</p>
      </div>}>
        <AssistantPage api={api} embedded enabled focusInput={open && !mobile} onActivity={setActivity}
          onCollapse={collapse} catalogPlatform={catalogPlatform} />
      </Suspense>}
    </dialog>
  </div>;
}
