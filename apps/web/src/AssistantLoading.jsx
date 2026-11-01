import React from 'react';
import Brand from './Brand.jsx';
import { AssistantCollapseButton } from './AssistantControls.jsx';
import ContactAdminButton from './ContactAdminButton.jsx';
import './assistant.css';

export default function AssistantLoading({ embedded = false, onCollapse, error, onRetry, onClear, notice, blocked = false }) {
  const Container = embedded ? 'div' : 'main';
  return <Container className={'assistant-page assistant-loading' + (embedded ? ' assistant-embedded' : '')}>
    {!embedded && <header className="assistant-header"><Brand /><a href="/guide">选购指南</a></header>}
    <header className="assistant-conversation-header">
      <h1>选购</h1>
      <AssistantCollapseButton onCollapse={onCollapse} />
    </header>
    {notice}
    <div className="assistant-thread assistant-thread-empty" role="status" aria-label="正在加载导购助手">
      <div className="catalog-skeleton" aria-hidden="true">
        {[1, 2].map(item => <div className="skeleton-card" key={item}><span /><span /><span /><span /></div>)}
      </div>
    </div>
    {error && <div className="assistant-error"><p role="alert">{error.message}</p>
      {error.contactAdmin && <ContactAdminButton disabled={blocked} />}
      <button type="button" disabled={blocked} onClick={onRetry}>重试连接</button>
      {onClear && <button type="button" disabled={blocked} onClick={onClear}>清空对话</button>}</div>}
  </Container>;
}
