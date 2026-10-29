import React, { useRef, useState } from 'react';
import ModalDialog from './components/ModalDialog.jsx';
import qrCodeUrl from './assets/qq-group.png';
import './community.css';

const QQ_GROUP_NUMBER = '346347792';

export default function CommunityDialog({ onClose }) {
  const groupInput = useRef(null);
  const [copyState, setCopyState] = useState('idle');
  const [qrFailed, setQrFailed] = useState(false);

  async function copyGroupNumber(event) {
    if (copyState === 'copying') return;
    const button = event.currentTarget;
    setCopyState('copying');
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(QQ_GROUP_NUMBER);
        copied = true;
      }
    } catch { /* Browser permissions may reject asynchronous clipboard access. */ }

    // Closing the dialog unmounts the input; a stale result must not affect a reopened one.
    const input = groupInput.current;
    if (!input) return;
    if (!copied) {
      input.focus();
      input.select();
      try { copied = document.execCommand?.('copy') === true; } catch { /* Keep the number selected for manual copy. */ }
      if (copied) button.focus();
    }
    setCopyState(copied ? 'copied' : 'error');
  }

  return <ModalDialog id="community-dialog" className="community-dialog" open onClose={onClose} aria-labelledby="community-title">
    <button type="button" className="community-close" aria-label="关闭交流群弹窗" onClick={onClose}>×</button>
    <h2 id="community-title">QQ 交流群</h2>
    {qrFailed ? <p className="community-qr-error" role="alert">二维码暂时无法显示，请复制群号在 QQ 中搜索加入。</p> :
      <img className="community-qr" src={qrCodeUrl} width="498" height="482" alt="QQ 群二维码" onError={() => setQrFailed(true)} />
    }
    <div className="community-group">
      <input ref={groupInput} id="community-group-number" aria-label="QQ 群号" value={QQ_GROUP_NUMBER} readOnly onFocus={event => event.target.select()} />
      <button type="button" className="community-copy" onClick={copyGroupNumber} disabled={copyState === 'copying'}
        aria-label={copyState === 'copying' ? '复制中…' : copyState === 'copied' ? '已复制' : '复制群号'}
        title={copyState === 'copied' ? '已复制' : '复制群号'}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {copyState === 'copied' ? <path d="m5 12 4 4L19 6" /> : <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>}
        </svg>
      </button>
    </div>
    <span className="community-copy-feedback" role="status" aria-live="polite">{copyState === 'copied' ? '群号已复制' : ''}</span>
    {copyState === 'error' && <p className="community-copy-error" role="alert">复制失败，已选中群号，请长按或手动复制。</p>}
    {!qrFailed && <a className="community-save" href={qrCodeUrl} download="知途拾价-QQ群二维码.png">保存二维码</a>}
  </ModalDialog>;
}
