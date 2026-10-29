import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import App from './App.jsx';

vi.mock('./PublicPage.jsx', () => ({ default: () => <main>公开报价页面</main> }));
vi.mock('./AdminPage.jsx', async () => { throw new Error('Chunk download failed'); });

afterEach(() => { cleanup(); vi.restoreAllMocks(); window.history.replaceState({}, '', '/'); });

test('failed admin chunk provides reload and public-page recovery links', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  window.history.replaceState({}, '', '/admin');
  render(<App />);
  expect(await screen.findByRole('alert')).toHaveTextContent('管理端加载失败');
  expect(screen.getByRole('link', { name: '重新加载管理端' })).toHaveAttribute('href', '/admin');
  expect(screen.getByRole('link', { name: '返回公开比价页' })).toHaveAttribute('href', '/');
});
