import React, { useLayoutEffect, useRef } from 'react';
import './modal-dialog.css';

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]';

function isBackdropEvent(event) {
  if (event.target !== event.currentTarget) return false;
  const bounds = event.currentTarget.getBoundingClientRect();
  return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
}

// The open attribute alone is non-modal: only showModal() enters the browser top layer.
export default function ModalDialog({ open, onClose, children, className = '', ...props }) {
  const ref = useRef(null);
  const backdropPointerDown = useRef(false);

  useLayoutEffect(() => {
    const dialog = ref.current;
    backdropPointerDown.current = false;
    if (!open) { if (dialog.open) dialog.close(); return; }
    const opener = document.activeElement;
    if (!dialog.open) dialog.showModal();
    if (!dialog.contains(document.activeElement)) dialog.querySelector(FOCUSABLE)?.focus();
    return () => { if (dialog.open) dialog.close(); if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, [open]);

  function onKeyDown(event) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
    if (event.key !== 'Tab') return;
    const elements = [...ref.current.querySelectorAll('*')].filter(element => element.matches(FOCUSABLE));
    const first = elements[0]; const last = elements.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }

  return <dialog {...props} ref={ref} className={`modal-dialog ${className}`} aria-modal="true"
    onKeyDown={onKeyDown}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClose={event => { if (open && !event.currentTarget.open) onClose(); }}
    onPointerDown={event => { backdropPointerDown.current = isBackdropEvent(event); }}
    onPointerCancel={() => { backdropPointerDown.current = false; }}
    onClick={event => {
      const dismiss = backdropPointerDown.current && isBackdropEvent(event);
      backdropPointerDown.current = false;
      if (dismiss) onClose();
    }}>
    {children}
  </dialog>;
}
