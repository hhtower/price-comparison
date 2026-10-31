import React, { lazy, Suspense, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { assistantApi } from './assistant-api.js';
import './assistant.css';

const AssistantPage = lazy(() => import('./AssistantPage.jsx'));
const MOBILE = '(max-width: 600px)';
export default function AssistantWidget({ api = assistantApi }) {
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const [visited, setVisited] = useState(false);
  const [mobile, setMobile] = useState(() => window.matchMedia?.(MOBILE).matches ?? false);
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
    panel.querySelector('button')?.focus();
    return () => {
      if (panel.open) panel.close();
      launcher.current?.focus({ preventScroll: true });
    };
  }, [open, mobile]);
  if (!enabled) return null;
  const collapse = () => setOpen(false);
  return <div className="assistant-widget">
    <button type="button" className="assistant-launcher" ref={launcher}
      aria-label="打开导购助手" aria-expanded={open} aria-controls={id} aria-haspopup="dialog"
      onClick={() => { setVisited(true); setOpen(value => !value); }}>
      <span aria-hidden="true">聊</span><span>导购助手</span>
    </button>
    <dialog id={id} ref={dialog} className="assistant-widget-panel" aria-label="导购助手"
      aria-modal={mobile ? 'true' : 'false'}
      onCancel={event => { event.preventDefault(); collapse(); }}
      onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
        event.preventDefault(); event.stopPropagation(); collapse();
      } }}>
      <div className="assistant-widget-heading"><div><strong>导购助手</strong><span>聊聊需求，看看真实报价</span></div>
        <button type="button" aria-label="收起导购助手" onClick={collapse}>收起 <span aria-hidden="true">↓</span></button></div>
      {/* Keep the runtime mounted while collapsed, including its draft and read subscription. */}
      {visited && <Suspense fallback={<p role="status">正在加载导购助手…</p>}>
        <AssistantPage api={api} embedded enabled />
      </Suspense>}
    </dialog>
  </div>;
}
