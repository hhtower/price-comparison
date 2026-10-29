import { expect, test, vi } from 'vitest';
import { render as renderComponent, screen, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ShopProtocolReview from './ShopProtocolReview.jsx';

const render = component => renderComponent(<table><tbody>{component}</tbody></table>);

const item = { id: '7', name: '速启AI', url: 'https://suqiai.cc/', created_at: '2026-09-26' };
const protocols = [{ id: 'public-products-v1', name: 'Public Products v1（速启AI）' }, { id: '16688', name: '16688' }];

test('renders without protocol probing and approves with automatic detection', async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const review = vi.fn().mockResolvedValue();
  render(<ShopProtocolReview item={item} protocols={protocols} onReview={review} />);
  expect(fetchMock).not.toHaveBeenCalled();
  await user.click(within(screen.getByRole('row')).getByRole('button', { name: '通过并抓取' }));
  expect(review).toHaveBeenCalledWith('7', 'approve', undefined);
});

test('approves with the manually selected protocol', async () => {
  const user = userEvent.setup();
  const review = vi.fn().mockResolvedValue();
  render(<ShopProtocolReview item={item} protocols={protocols} onReview={review} />);
  await user.selectOptions(screen.getByLabelText('采集协议'), '16688');
  await user.click(screen.getByRole('button', { name: '通过并抓取' }));
  expect(review).toHaveBeenCalledWith('7', 'approve', '16688');
});

test('disables the row while a review request is in flight', async () => {
  const user = userEvent.setup();
  let finish;
  const review = vi.fn().mockReturnValue(new Promise(resolve => { finish = resolve; }));
  render(<ShopProtocolReview item={item} protocols={protocols} onReview={review} />);
  await user.click(screen.getByRole('button', { name: '通过并抓取' }));
  expect(screen.getByRole('button', { name: '通过并抓取' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '拒绝' })).toBeDisabled();
  expect(screen.getByRole('status')).toHaveTextContent('正在验证协议并审核…');
  await act(async () => finish());
  expect(screen.getByRole('button', { name: '通过并抓取' })).toBeEnabled();
});
