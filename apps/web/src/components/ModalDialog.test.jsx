import React, { StrictMode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import ModalDialog from './ModalDialog.jsx';

afterEach(() => vi.restoreAllMocks());

test('only dismisses when a pointer gesture starts and ends on the backdrop', () => {
  const onClose = vi.fn();
  render(<ModalDialog open onClose={onClose} aria-label="编辑"><input aria-label="名称" /></ModalDialog>);
  const dialog = screen.getByRole('dialog');
  vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue({ left: 100, right: 500, top: 100, bottom: 400 });
  const pointerDown = (target, x, y) => fireEvent(target, new MouseEvent('pointerdown', { bubbles: true, clientX: x, clientY: y }));

  // Selecting text inside the form must not dismiss it when released outside.
  pointerDown(screen.getByRole('textbox'), 150, 150);
  fireEvent.click(dialog, { clientX: 10, clientY: 10 });
  expect(onClose).not.toHaveBeenCalled();

  pointerDown(dialog, 10, 10);
  fireEvent.click(dialog, { clientX: 110, clientY: 110 });
  expect(onClose).not.toHaveBeenCalled();

  pointerDown(dialog, 10, 10);
  fireEvent.pointerCancel(dialog);
  fireEvent.click(dialog, { clientX: 10, clientY: 10 });
  expect(onClose).not.toHaveBeenCalled();

  pointerDown(dialog, 10, 10);
  fireEvent.click(dialog, { clientX: 10, clientY: 10 });
  expect(onClose).toHaveBeenCalledOnce();
});

test('syncs native close without letting stale close events dismiss a reopened modal', () => {
  const onClose = vi.fn();
  const view = open => <StrictMode><ModalDialog open={open} onClose={onClose} aria-label="编辑"><input aria-label="名称" /></ModalDialog></StrictMode>;
  const { rerender, unmount } = render(view(true));
  const dialog = screen.getByRole('dialog');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '草稿' } });
  rerender(view(false));
  expect(dialog.open).toBe(false);
  fireEvent(dialog, new Event('close'));
  expect(onClose).not.toHaveBeenCalled();
  rerender(view(true));
  fireEvent(dialog, new Event('close'));
  expect(onClose).not.toHaveBeenCalled();
  expect(dialog.open).toBe(true);
  expect(screen.getByRole('textbox')).toHaveValue('草稿');
  dialog.close();
  fireEvent(dialog, new Event('close'));
  expect(onClose).toHaveBeenCalledOnce();
  unmount();
  expect(dialog.open).toBe(false);
});
