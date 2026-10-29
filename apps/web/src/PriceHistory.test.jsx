import React from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PriceHistory from './PriceHistory.jsx';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const point = { date: '2026-10-12', price: '10.30', verifiedAt: '2026-10-12T10:00:00Z', productId: '9', shop: '商铺甲', name: '月付会员', spec: '独享', quantity: 1, contentVersion: '1', paymentMethod: 'Alipay' };
function mount(props = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><PriceHistory standardProductId="42" {...props} /></QueryClientProvider>);
}
function response(points) { return Response.json({ currency: 'CNY', days: 30, startDate: '2026-09-16', endDate: '2026-10-15', points }); }

test('shows the full reporting window and price ticks with only two recent observations', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response([
    { ...point, date: '2026-10-14', price: '37.39' }, { ...point, date: '2026-10-15', price: '30.82' },
  ])));
  mount();
  const chart = await screen.findByRole('img');
  expect(chart).toHaveTextContent('09-16');
  expect(chart).toHaveTextContent('09-23');
  expect(chart).toHaveTextContent('09-30');
  expect(chart).toHaveTextContent('10-07');
  expect(chart).toHaveTextContent('10-15');
  expect(chart).toHaveTextContent('¥34');
  const dots = [...chart.querySelectorAll('circle')];
  expect(dots).toHaveLength(2);
  expect(Number(dots[0].getAttribute('cx'))).toBeGreaterThan(490);
  expect(Number(dots[1].getAttribute('cx'))).toBe(518);
});

test.each(['0', '0.10', '37.39'])('keeps a valid price scale for flat prices at %s', async price => {
  vi.stubGlobal('fetch', vi.fn(async () => response([{ ...point, price }])));
  mount();
  const chart = await screen.findByRole('img');
  expect(chart.innerHTML).not.toMatch(/NaN|Infinity/);
  const dot = chart.querySelector('circle');
  expect(Number(dot.getAttribute('cy'))).toBeGreaterThanOrEqual(24);
  expect(Number(dot.getAttribute('cy'))).toBeLessThanOrEqual(152);
});

test('loads aggregate daily history with purchase conditions and accessible data', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response([point, { ...point, date: '2026-10-13', price: '2.002', quantity: 5, productId: '10', name: '5件起购会员' }])));
  mount();
  expect(await screen.findByRole('img', { name: /每日最低结算单价走势/ })).toBeInTheDocument();
  fireEvent.click(screen.getByText('查看每日记录'));
  expect(screen.getByRole('table', { name: '每日价格记录' })).toHaveTextContent('¥2');
  expect(screen.getByRole('table')).toHaveTextContent('5件起购');
  expect(screen.getByRole('table')).toHaveTextContent('5件起购会员');
});

test('fetches individual history only when expanded and does not join changed conditions or missing days', async () => {
  const fetcher = vi.fn(async () => response([point, { ...point, date: '2026-10-13', price: '9.00' },
    { ...point, date: '2026-10-14', quantity: 5, price: '2.00' },
    { ...point, date: '2026-10-15', quantity: 5, contentVersion: '2', price: '3.00' },
    { ...point, date: '2026-10-16', quantity: 5, contentVersion: '2', paymentMethod: 'WeChat', price: '4.00' },
    { ...point, date: '2026-10-18', quantity: 5, contentVersion: '2', paymentMethod: 'WeChat', price: '8.00' }]));
  vi.stubGlobal('fetch', fetcher);
  const { container } = mount({ productId: '9' });
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('价格历史'));
  await screen.findByRole('img');
  expect(fetcher.mock.calls[0][0]).toBe('/api/catalog/products/42/price-history?currency=CNY&productId=9');
  expect(container.querySelectorAll('svg line.price-history-segment')).toHaveLength(1);
});

test('shows empty and single-point states without inventing a trend', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response([])));
  mount();
  expect(await screen.findByText(/暂无已记录的结算价格/)).toBeInTheDocument();
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  cleanup();
  vi.stubGlobal('fetch', vi.fn(async () => response([point])));
  mount();
  expect((await screen.findByRole('img')).querySelectorAll('line.price-history-segment')).toHaveLength(0);
});

test('shows loading and allows retry after a failed request', async () => {
  let resolve;
  const fetcher = vi.fn(() => new Promise(done => { resolve = done; }));
  vi.stubGlobal('fetch', fetcher);
  mount();
  expect(screen.getByRole('status')).toHaveTextContent('正在加载价格历史');
  resolve(new Response('{}', { status: 503 }));
  expect(await screen.findByRole('alert')).toHaveTextContent('价格历史加载失败');
  fetcher.mockImplementation(async () => response([point]));
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByRole('img')).toBeInTheDocument();
});
