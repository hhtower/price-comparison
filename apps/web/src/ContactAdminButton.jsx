import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import CommunityDialog from './CommunityDialog.jsx';

export default function ContactAdminButton({ disabled = false }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" disabled={disabled} aria-haspopup="dialog" aria-expanded={open}
      aria-controls="community-dialog" onClick={() => setOpen(true)}>进群联系管理员</button>
    {open && createPortal(<CommunityDialog onClose={() => setOpen(false)} />, document.body)}
  </>;
}
