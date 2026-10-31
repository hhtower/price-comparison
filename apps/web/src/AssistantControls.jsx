import React, { useEffect, useId, useRef, useState } from 'react';
import { CATALOG_PLATFORMS } from '@price-comparison/catalog/platform-groups';

export const ASSISTANT_STARTERS = ['写代码', '读论文', '日常办公'];

export function selectedAssistantPlatform(embedded, value) {
  if (!embedded) return null;
  const selected = value === undefined
    ? window.location.pathname === '/' ? new URLSearchParams(window.location.search).get('platform') : null
    : value;
  const normalized = selected?.trim().toLowerCase();
  return CATALOG_PLATFORMS.find(item => item.id === normalized || item.aliases.includes(normalized)) ?? null;
}

export function AssistantHeader({ title = '选购', labels = [], recognizeFilters, onRecognizeFilters,
  blocked = false, clearDisabled = false, onClear, onCollapse }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsButton = useRef(null);
  const settingsId = useId();
  const menu = useRef(null);
  useEffect(() => {
    if (!settingsOpen) return;
    const dismiss = event => {
      if (!menu.current?.contains(event.target)) setSettingsOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('focusin', dismiss);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('focusin', dismiss);
    };
  }, [settingsOpen]);
  return <header className="assistant-conversation-header">
    {labels.length ? <details className="assistant-title-details">
      <summary><h1>{title}</h1></summary>
      <p aria-label="已确认条件">{labels.join(' · ')}</p>
    </details> : <h1>{title}</h1>}
    <div className="assistant-menu" ref={menu} onKeyDown={event => {
      if (settingsOpen && event.key === 'Escape' && !event.nativeEvent.isComposing) {
        event.preventDefault(); event.stopPropagation();
        setSettingsOpen(false); settingsButton.current?.focus();
      }
    }}>
      <button ref={settingsButton} type="button" className="assistant-icon-button" aria-label="设置" title="设置"
        aria-expanded={settingsOpen} aria-controls={settingsId} onClick={() => setSettingsOpen(value => !value)}>
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><path d="M10 3h4l.6 2.4 2.1 1.2 2.4-.7 2 3.4-1.8 1.5v2.4l1.8 1.5-2 3.4-2.4-.7-2.1 1.2L14 21h-4l-.6-2.4-2.1-1.2-2.4.7-2-3.4 1.8-1.5v-2.4L2.9 9.3l2-3.4 2.4.7 2.1-1.2Z" /><circle cx="12" cy="12" r="3" /></svg>
      </button>
      {settingsOpen && <div id={settingsId} className="assistant-menu-panel" role="group" aria-label="设置">
        <label><input type="checkbox" checked={recognizeFilters} disabled={blocked}
          onChange={event => onRecognizeFilters(event.target.checked)} />识别当前筛选</label>
        <button type="button" disabled={clearDisabled} onClick={() => {
          setSettingsOpen(false);
          onClear(settingsButton.current);
        }}>清空对话</button>
      </div>}
    </div>
    {onCollapse && <button type="button" className="assistant-icon-button assistant-collapse" aria-label="收起导购助手" title="收起"
      onClick={onCollapse}><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg></button>}
  </header>;
}

export function AssistantSendIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5m-6 6 6-6 6 6" /></svg>;
}

export function AssistantWelcome({ disabled, onStart }) {
  return <div className="assistant-welcome">
    <h2>想用来做什么？</h2>
    <div className="assistant-starters">{ASSISTANT_STARTERS.map(text =>
      <button type="button" key={text} disabled={disabled} onClick={() => onStart(text)}>{text}</button>)}</div>
  </div>;
}

export function AssistantPlatformChip({ platform, disabled, onRemove }) {
  return platform && <div className="assistant-context">
    <button type="button" aria-label={`不参考 ${platform.label}`} disabled={disabled} onClick={onRemove}>
      {platform.label} <span aria-hidden="true">×</span>
    </button>
  </div>;
}
