import React from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { emptyShoppingNeeds } from '@price-comparison/catalog/assistant-contract';
import AssistantPage from './AssistantPage.jsx';
import { createAssistantApi } from './assistant-api.js';
import App from './App.jsx';

const sessionId = '11111111-1111-4111-8111-111111111111';
const credentials = { sessionId, accessToken: 'private-token' };
const turn = overrides => ({
  id: '1', sessionId, clientMessageId: '22222222-2222-4222-8222-222222222222', inputText: '写代码',
  expectedRevision: 0, eventVersion: 1, status: 'queued', phase: 'queued', reply: null, errorCode: null, ...overrides,
});
const reply = { kind: 'question', text: '预算大概是多少？', options: ['50元以内', '暂不限制'], needs: emptyShoppingNeeds(), cards: [] };
const done = turn({ status: 'succeeded', phase: 'succeeded', eventVersion: 2, reply });
function mockApi(overrides = {}) {
  return {
    status: vi.fn(async () => ({ enabled: true })),
    createSession: vi.fn(async () => ({ ...credentials, revision: 0 })),
    readSession: vi.fn(async () => ({ id: sessionId, revision: 0, needs: emptyShoppingNeeds(), turns: [] })),
    sendTurn: vi.fn(async (_credentials, input) => ({ snapshot: turn({ clientMessageId: input.clientMessageId, inputText: input.text }), created: true })),
    subscribeTurn: vi.fn(async (_credentials, active, onSnapshot) => {
      const result = { ...done, clientMessageId: active.clientMessageId, inputText: active.inputText };
      onSnapshot(result); return result;
    }),
    cancelTurn: vi.fn(async () => turn({ status: 'cancelled', phase: 'cancelled', eventVersion: 2 })),
    deleteSession: vi.fn(async () => {}),
    ...overrides,
  };
}
afterEach(() => { cleanup(); sessionStorage.clear(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('an open SSE connection updates visible reasoning before the final answer arrives', async () => {
  let stream;
  let active;
  const streamingApi = createAssistantApi(async () => new Response(new ReadableStream({ start(controller) { stream = controller; } }),
    { headers: { 'Content-Type': 'text/event-stream' } }));
  const api = mockApi({ subscribeTurn: (...args) => { active = args[1]; return streamingApi.subscribeTurn(...args); } });
  render(<AssistantPage api={api} />);
  fireEvent.change(await screen.findByRole('textbox'), { target: { value: '写代码' } });
  fireEvent.click(screen.getByRole('button', { name: '设置', exact: true }));
  const setting = screen.getByRole('checkbox', { name: '默认展开思考过程' });
  expect(setting).not.toBeChecked();
  fireEvent.click(setting);
  fireEvent.click(screen.getByRole('button', { name: '设置', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: '发送', exact: true }));
  await waitFor(() => expect(stream).toBeDefined());
  const emit = (event, data) => stream.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  for (const text of ['先看预算', '先看预算，再看用途', '先看预算，再看用途，筛选报价']) {
    await act(async () => emit('reasoning', { turnId: active.id, text }));
    expect(await screen.findByText(text)).toBeVisible();
    expect(screen.getByRole('button', { name: '停止', exact: true })).toBeVisible();
    expect(screen.queryByText(reply.text)).not.toBeInTheDocument();
  }
  await act(async () => emit('snapshot', { ...active, ...done, clientMessageId: active.clientMessageId }));
  expect(await screen.findByText(reply.text)).toBeVisible();
  expect(screen.getByText('先看预算，再看用途，筛选报价')).toBeVisible();
});

test('reasoning expands, updates live and remains attached to its completed message', async () => {
  let update, complete;
  let sent = 0;
  const api = mockApi({
    sendTurn: vi.fn(async (_credentials, input) => ({ snapshot: turn({ id: String(++sent),
      clientMessageId: input.clientMessageId, inputText: input.text }), created: true })),
    subscribeTurn: vi.fn((_credentials, active, _onSnapshot, _signal, onReasoning) => {
    update = onReasoning;
    return new Promise(resolve => { complete = () => resolve({ ...done, ...active, status: 'succeeded', phase: 'succeeded', reply }); });
  }) });
  render(<AssistantPage api={api} />);
  const input = await screen.findByRole('textbox');
  fireEvent.change(input, { target: { value: '写代码' } });
  fireEvent.click(screen.getByRole('button', { name: '发送', exact: true }));
  await waitFor(() => expect(api.subscribeTurn).toHaveBeenCalled());
  await act(async () => update('先看预算'));
  const summary = screen.getByText('思考中');
  expect(summary.closest('details')).not.toHaveAttribute('open');
  expect(screen.getByText('先看预算')).not.toBeVisible();
  fireEvent.click(summary);
  expect(screen.getByText('先看预算')).toBeVisible();
  const thought = screen.getByText('先看预算');
  Object.defineProperties(thought, { scrollHeight: { configurable: true, value: 500 }, clientHeight: { configurable: true, value: 240 } });
  await act(async () => update('先看预算，再筛选商品。<script>test</script>'));
  expect(screen.getByText('先看预算，再筛选商品。<script>test</script>')).toBeVisible();
  expect(thought.scrollTop).toBe(500);
  thought.scrollTop = 10;
  fireEvent.scroll(thought);
  await act(async () => update('正在对比报价'));
  expect(thought.scrollTop).toBe(10);
  fireEvent.click(summary);
  await act(async () => update('先看预算，再筛选商品。<script>test</script>'));
  expect(summary.closest('details')).not.toHaveAttribute('open');
  fireEvent.click(summary);
  await act(async () => complete());
  expect(await screen.findByText(reply.text)).toBeVisible();
  expect(screen.getByText('思考过程')).toBeVisible();
  expect(screen.getByText('先看预算，再筛选商品。<script>test</script>')).toBeInTheDocument();
  expect(document.querySelector('.assistant-reasoning script')).toBeNull();
  fireEvent.change(input, { target: { value: '继续找' } });
  fireEvent.click(screen.getByRole('button', { name: '发送', exact: true }));
  await waitFor(() => expect(api.subscribeTurn).toHaveBeenCalledTimes(2));
  expect(screen.queryByText('思考中')).not.toBeInTheDocument();
  await act(async () => update('第二轮思考'));
  expect(screen.getByText('第二轮思考')).toBeInTheDocument();
  expect(screen.getByText('第二轮思考')).not.toBeVisible();
  expect(screen.getAllByText('先看预算，再筛选商品。<script>test</script>')).toHaveLength(1);
  await act(async () => complete());
});

test('restored turns show live reasoning and ignore fragments after cancellation', async () => {
  sessionStorage.setItem('shopping-assistant', JSON.stringify(credentials));
  let update;
  let latest = turn({ status: 'running', phase: 'understanding' });
  const api = mockApi({
    readSession: vi.fn(async () => ({ id: sessionId, revision: 0, needs: emptyShoppingNeeds(), turns: [latest] })),
    subscribeTurn: vi.fn((_credentials, _active, _onSnapshot, signal, onReasoning) => {
      update = onReasoning;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
    }),
    cancelTurn: vi.fn(async () => {
      latest = turn({ status: 'cancelled', phase: 'cancelled', eventVersion: 2 });
      return latest;
    }),
  });
  render(<AssistantPage api={api} />);
  await waitFor(() => expect(api.subscribeTurn).toHaveBeenCalled());
  await act(async () => update('恢复后的思考'));
  expect(screen.getByText('思考中')).toBeVisible();
  expect(screen.getByText('恢复后的思考')).not.toBeVisible();
  fireEvent.click(screen.getByText('思考中'));
  expect(screen.getByText('恢复后的思考')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '停止', exact: true }));
  expect(await screen.findByText('已停止查找。你可以继续提问。')).toBeVisible();
  await act(async () => update('取消后的分块'));
  expect(screen.queryByText('取消后的分块')).not.toBeInTheDocument();
  expect(screen.getByText('恢复后的思考')).toBeInTheDocument();
  expect(screen.queryByText('思考中')).not.toBeInTheDocument();
});

test('reasoning expansion preference survives remount and can be turned off', async () => {
  const api = mockApi();
  let view = render(<AssistantPage api={api} />);
  await screen.findByRole('textbox');
  fireEvent.click(screen.getByRole('button', { name: '设置', exact: true }));
  fireEvent.click(screen.getByRole('checkbox', { name: '默认展开思考过程' }));
  view.unmount();
  view = render(<AssistantPage api={api} />);
  await screen.findByRole('textbox');
  fireEvent.click(screen.getByRole('button', { name: '设置', exact: true }));
  expect(screen.getByRole('checkbox', { name: '默认展开思考过程' })).toBeChecked();
  fireEvent.click(screen.getByRole('checkbox', { name: '默认展开思考过程' }));
  view.unmount();
  render(<AssistantPage api={api} />);
  await screen.findByRole('textbox');
  fireEvent.click(screen.getByRole('button', { name: '设置', exact: true }));
  expect(screen.getByRole('checkbox', { name: '默认展开思考过程' })).not.toBeChecked();
});

test('unavailable preference storage does not prevent chatting or changing the setting', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function () {
    if (this === localStorage) throw new Error('Storage blocked');
    return null;
  });
  const originalSetItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (...args) {
    if (this === localStorage) throw new Error('Storage blocked');
    return originalSetItem.apply(this, args);
  });
  render(<AssistantPage api={mockApi()} />);
  await screen.findByRole('textbox');
  fireEvent.click(screen.getByRole('button', { name: '设置', exact: true }));
  const setting = screen.getByRole('checkbox', { name: '默认展开思考过程' });
  expect(setting).not.toBeChecked();
  fireEvent.click(setting);
  expect(setting).toBeChecked();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

const referencePrice = { country: 'us', countryName: '美国', currency: 'USD', amount: 19.99,
  cnyAmount: 139.93, capturedAt: '2026-11-01T00:00:00Z', stale: false,
  sourceUrl: 'https://apps.apple.com/us/app/id6448311069' };
const referencePlan = { id: 'plus-month', name: 'ChatGPT Plus - Monthly', kind: 'subscription', period: 'P1M', prices: [referencePrice] };
const referenceCard = { standardProductId: '42', productId: '9', shopId: '7', title: 'ChatGPT Plus',
  price: '61.68', currency: 'CNY', capturedAt: '2026-11-01T00:00:00Z', priceExpiresAt: '2099-11-01T00:00:00Z',
  detailPath: '/products/42', reasons: ['商家报价'], caveats: ['下单前核对'], evidenceIds: ['e1'],
  offer: { name: 'Plus 代充', shop: 'AI源头', spec: '', productUrl: '', tags: [{ name: 'duration', value: '1 month' }, { name: 'region', value: 'us' }] } };
async function renderReferenceCards(plans = [referencePlan], cards = [referenceCard]) {
  sessionStorage.setItem('shopping-assistant', JSON.stringify(credentials));
  const fetcher = vi.fn(async () => Response.json({ exchangeDate: '2026-11-01',
    apps: [{ name: 'ChatGPT', plans }] }));
  vi.stubGlobal('fetch', fetcher);
  render(<AssistantPage api={mockApi({ readSession: vi.fn(async () => ({ id: sessionId, revision: 1,
    needs: emptyShoppingNeeds(), turns: [{ ...done, reply: { ...reply, kind: 'recommendation', options: [], cards } }] })) })} />);
  await screen.findAllByRole('button', { name: '查看报价详情' });
  await waitFor(() => expect(fetcher).toHaveBeenCalled());
  return fetcher;
}

test('cards label merchants and show their own region official price without a link', async () => {
  const india = { ...referencePrice, country: 'in', countryName: '印度', currency: 'INR', amount: 1599,
    cnyAmount: 130, sourceUrl: 'https://apps.apple.com/in/app/id6448311069' };
  const fetcher = await renderReferenceCards([{ ...referencePlan, prices: [referencePrice, india,
    { ...referencePrice, cnyAmount: 1, stale: true }, { ...referencePrice, cnyAmount: null },
  ] }], [referenceCard, { ...referenceCard, productId: '10', offer: { ...referenceCard.offer,
    tags: [{ name: 'duration', value: '1 month' }, { name: 'region', value: 'in' }] } }]);
  const us = (await screen.findByText('官方内购参考 · 美国 · 每月')).closest('article');
  const indiaCard = screen.getByText('官方内购参考 · 印度 · 每月').closest('article');
  expect(within(us).getByText(/19.99 USD.*约 ¥139.93/)).toBeVisible();
  expect(within(indiaCard).getByText(/1599 INR.*约 ¥130/)).toBeVisible();
  expect(screen.queryByRole('link', { name: /官方内购参考/ })).not.toBeInTheDocument();
  expect(screen.getAllByText('店铺：AI源头')).toHaveLength(2);
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/official-reference/catalog')).toHaveLength(1);
  expect(fetcher).toHaveBeenCalledWith('/api/official-reference/catalog', expect.objectContaining({ credentials: 'omit' }));
  fireEvent.click(within(us).getByRole('button', { name: '查看报价详情' }));
  const details = screen.getByRole('dialog');
  expect(details).toHaveTextContent('官方内购参考 · 美国 · 每月');
  expect(within(details).getByText(/19.99 USD.*约 ¥139.93/)).toBeVisible();
  expect(details).not.toHaveTextContent(/同地区|同周期|汇率/);
});

test.each([
  ['different plan', [{ ...referencePlan, name: 'ChatGPT Pro' }], referenceCard],
  ['unavailable country', [referencePlan], { ...referenceCard, offer: { ...referenceCard.offer,
    tags: [{ name: 'duration', value: '1 month' }, { name: 'region', value: 'in' }] } }],
  ['ambiguous SKU', [referencePlan, { ...referencePlan, id: 'other', name: 'ChatGPT Plus - Monthly #2' }], referenceCard],
  ['ambiguous SKU with unknown duration', [referencePlan, { ...referencePlan, id: 'other', name: 'ChatGPT Plus - Monthly #2' }],
    { ...referenceCard, offer: { ...referenceCard.offer, tags: [] } }],
  ['unavailable country with unknown duration', [referencePlan], { ...referenceCard, offer: { ...referenceCard.offer,
    tags: [{ name: 'region', value: 'in' }] } }],
  ['stale price', [{ ...referencePlan, prices: [{ ...referencePrice, stale: true }] }], referenceCard],
  ['missing exchange rate', [{ ...referencePlan, prices: [{ ...referencePrice, cnyAmount: null }] }], referenceCard],
  ['unsafe source', [{ ...referencePlan, prices: [{ ...referencePrice, sourceUrl: 'javascript:alert(1)' }] }], referenceCard],
  ['non-subscription', [{ ...referencePlan, kind: 'purchase' }], referenceCard],
])('does not invent an official comparison for %s', async (_name, plans, card) => {
  await renderReferenceCards(plans, [card]);
  expect(screen.queryByText(/官方内购参考/)).not.toBeInTheDocument();
  expect(screen.getByText('¥61.68')).toBeVisible();
});

test.each([['2 months', 'P1M', '每月'], ['30 days', 'P1M', '每月'], ['1 month', 'P1Y', '每年']])(
  'reference falls back to the actual official billing period for %s', async (duration, period, label) => {
  await renderReferenceCards([{ ...referencePlan, period }], [{ ...referenceCard, offer: { ...referenceCard.offer,
    name: 'codex Plus 两个月独享成品plus - gamil邮箱【保45天可用60天两个月】(全网独家iphone/ios pay/google pay渠道)',
    shop: 'AI批发的杂货店', tags: [{ name: 'duration', value: duration }, { name: 'delivery', value: 'account' }, { name: 'access', value: 'dedicated' }] } }]);
  expect(await screen.findByText(`官方内购参考 · 美国 · ${label}`)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '查看报价详情' }));
  const dialog = screen.getByRole('dialog');
  expect(dialog).toHaveTextContent(`官方内购参考 · 美国 · ${label}`);
  expect(dialog).toHaveTextContent('19.99 USD（约 ¥139.93）');
  expect(dialog).not.toHaveTextContent('同周期');
});

test('reference prefers the matching period over a cheaper different period', async () => {
  await renderReferenceCards([referencePlan, { ...referencePlan, id: 'plus-year', period: 'P1Y',
    prices: [{ ...referencePrice, amount: 15, cnyAmount: 105 }] }]);
  expect(await screen.findByText('官方内购参考 · 美国 · 每月')).toBeVisible();
  expect(screen.getByText(/19.99 USD.*约 ¥139.93/)).toBeVisible();
});

test.each([['12 months', 'P1Y', '每年'], ['1 year', 'P1Y', '每年'], ['1 week', 'P1W', '每周']])(
  'reference matches equivalent billing durations: %s', async (duration, period, label) => {
  await renderReferenceCards([{ ...referencePlan, period, name: 'Plus' }],
    [{ ...referenceCard, offer: { ...referenceCard.offer, tags: [{ name: 'duration', value: duration }, { name: 'region', value: 'us' }] } }]);
  expect(await screen.findByText(`官方内购参考 · 美国 · ${label}`)).toBeVisible();
});

test.each([
  ['missing', []],
  ['unknown', [{ name: 'duration', value: 'unknown' }]],
  ['conflicting', [{ name: 'duration', value: '1 month' }, { name: 'duration', value: '12 months' }]],
])('reference uses the cheapest official billing period when quote duration is %s', async (_name, tags) => {
  await renderReferenceCards([referencePlan, { ...referencePlan, id: 'plus-year', period: 'P1Y',
    prices: [{ ...referencePrice, amount: 15, cnyAmount: 105 },
      { ...referencePrice, country: 'in', countryName: '印度', amount: 1, cnyAmount: 7 }] }],
  [{ ...referenceCard, offer: { ...referenceCard.offer, tags: [...tags, { name: 'region', value: 'us' }] } }]);
  expect(await screen.findByText('官方内购参考 · 美国 · 每年')).toBeVisible();
  expect(screen.getByText(/15 USD.*约 ¥105/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '查看报价详情' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('官方内购参考 · 美国 · 每年');
  expect(screen.getByRole('dialog')).toHaveTextContent('15 USD（约 ¥105）');
  expect(screen.getByRole('dialog')).not.toHaveTextContent(/报价周期未明确|同周期/);
});

test('reference defaults to the cheapest price when both region and duration are missing', async () => {
  await renderReferenceCards([{ ...referencePlan, prices: [referencePrice,
    { ...referencePrice, country: 'ph', countryName: '菲律宾', currency: 'PHP', amount: 999, cnyAmount: 104.29 }] },
    { ...referencePlan, id: 'plus-year', period: 'P1Y', prices: [{ ...referencePrice, amount: 200, cnyAmount: 1400 }] }],
  [{ ...referenceCard, offer: { ...referenceCard.offer,
    tags: [{ name: 'delivery', value: 'top_up' }, { name: 'access', value: 'exclusive' }] } }]);
  expect(await screen.findByText('官方内购参考 · 菲律宾 · 每月')).toBeVisible();
  expect(screen.getByText(/999 PHP.*约 ¥104.29/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '查看报价详情' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('官方内购参考 · 菲律宾 · 每月');
  expect(screen.getByRole('dialog')).toHaveTextContent('999 PHP（约 ¥104.29）');
  expect(screen.getByRole('dialog')).not.toHaveTextContent(/报价地区未明确|报价周期未明确/);
});

test.each(['US', '美国', '美区', 'usa'])('reference recognizes explicit region alias %s', async region => {
  await renderReferenceCards([{ ...referencePlan, prices: [referencePrice,
    { ...referencePrice, country: 'in', countryName: '印度', cnyAmount: 130 }] }], [{ ...referenceCard, offer: { ...referenceCard.offer,
    tags: [...referenceCard.offer.tags, { name: '地区', value: region }, { name: 'payment_region', value: 'in' }] } }]);
  expect(await screen.findByText('官方内购参考 · 美国 · 每月')).toBeVisible();
});

test.each([
  ['missing region', []],
  ['unknown region', [{ name: 'region', value: 'unknown' }]],
  ['global region', [{ name: 'region', value: 'global' }]],
  ['random region', [{ name: 'region', value: 'random' }]],
  ['broad region', [{ name: 'region', value: 'eu' }]],
  ['conflicting regions', [{ name: 'region', value: 'us' }, { name: 'region', value: 'in' }]],
  ['partially unknown region', [{ name: 'region', value: 'us' }, { name: 'region', value: 'unknown' }]],
  ['other region fields', ['payment_region', 'registration_region', 'recommended_ip_region', 'region_options']
    .map(name => ({ name, value: 'us' }))],
])('reference defaults to the cheapest valid price for %s', async (_name, tags) => {
  await renderReferenceCards([{ ...referencePlan, prices: [referencePrice,
    { ...referencePrice, country: 'in', countryName: '印度', currency: 'INR', amount: 1599, cnyAmount: 130 },
    { ...referencePrice, cnyAmount: 1, stale: true }, { ...referencePrice, cnyAmount: null },
  ] }], [{ ...referenceCard, offer: { ...referenceCard.offer,
    tags: [{ name: 'duration', value: '1 month' }, ...tags] } }]);
  expect(await screen.findByText('官方内购参考 · 印度 · 每月')).toBeVisible();
  expect(screen.getByText(/1599 INR.*约 ¥130/)).toBeVisible();
  expect(screen.queryByRole('link', { name: /官方内购参考/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '查看报价详情' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('官方内购参考 · 印度 · 每月');
  expect(screen.getByRole('dialog')).toHaveTextContent('1599 INR（约 ¥130）');
});

test('stale matching region does not fall back to a fresh foreign price', async () => {
  await renderReferenceCards([{ ...referencePlan, prices: [{ ...referencePrice, stale: true },
    { ...referencePrice, country: 'in', countryName: '印度' }] }]);
  expect(screen.queryByText(/官方内购参考/)).not.toBeInTheDocument();
});

test('reference catalog failure leaves merchant quotes and details usable', async () => {
  sessionStorage.setItem('shopping-assistant', JSON.stringify(credentials));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  render(<AssistantPage api={mockApi({ readSession: vi.fn(async () => ({ id: sessionId, revision: 1,
    needs: emptyShoppingNeeds(), turns: [{ ...done, reply: { ...reply, kind: 'recommendation', options: [], cards: [referenceCard] } }] })) })} />);
  fireEvent.click(await screen.findByRole('button', { name: '查看报价详情' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('¥61.68');
  expect(screen.queryByText(/官方内购参考/)).not.toBeInTheDocument();
});

test('each recommendation opens its exact merchant quote and returns focus on close', async () => {
  sessionStorage.setItem('shopping-assistant', JSON.stringify(credentials));
  const cards = ['9', '10'].map((id, index) => ({
    standardProductId: '42', productId: id, shopId: String(index + 1), title: 'ChatGPT Plus',
    price: String(49 + index), currency: 'CNY', capturedAt: '2026-10-31T00:00:00Z', priceExpiresAt: '2099-11-01T00:00:00Z',
    detailPath: '/products/42', reasons: ['商家提供代充'], caveats: ['请核对售后范围'], evidenceIds: ['e1'],
    offer: { name: `Plus 代充方案${index + 1}`, shop: `测试店铺${index + 1}`, spec: '一个月',
      productUrl: `https://shop.invalid/items/${id}`, tags: [{ name: 'delivery', value: 'top_up' },
        { name: 'warranty', value: 'covered' }, { name: 'warranty_scope', value: 'subscription' }] },
  }));
  const result = { ...reply, kind: 'recommendation', text: '优先有质保、代充的报价', options: [], cards };
  render(<AssistantPage api={mockApi({ readSession: vi.fn(async () => ({ id: sessionId, revision: 1,
    needs: emptyShoppingNeeds(), turns: [{ ...done, reply: result }] })) })} />);
  const buttons = await screen.findAllByRole('button', { name: '查看报价详情' });
  expect(screen.queryByRole('link', { name: /查看商品详情/ })).not.toBeInTheDocument();
  expect(screen.getAllByRole('heading', { name: 'ChatGPT Plus' })).toHaveLength(2);
  for (const card of cards) expect(screen.queryByText(card.offer.name)).not.toBeInTheDocument();
  for (const [index, button] of buttons.entries()) {
    button.focus(); fireEvent.click(button);
    const dialog = screen.getByRole('dialog', { name: cards[index].offer.name });
    expect(dialog).toHaveTextContent(cards[index].offer.shop);
    expect(dialog).toHaveTextContent(`¥${cards[index].price}`);
    expect(dialog).toHaveTextContent('仅保掉订阅');
    expect(within(dialog).getByRole('link', { name: '前往商家核对报价' })).toHaveAttribute('href', cards[index].offer.productUrl);
    expect(within(dialog).queryByRole('button', { name: '举报此报价' })).not.toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  }
});

test('quote cards show compact facts and grouped purchase notes without repeating warranty prose', async () => {
  sessionStorage.setItem('shopping-assistant', JSON.stringify(credentials));
  const warranty = '商家质保说明：质保30天（仅保掉订阅；附售后条款；不保封号）；具体限制以该报价的售后条款为准。';
  const card = { standardProductId: '42', productId: '9', shopId: '7', title: 'ChatGPT Plus',
    price: '64.90', currency: 'CNY', capturedAt: '2026-10-31T00:00:00Z', priceExpiresAt: '2099-11-01T00:00:00Z',
    detailPath: '/products/42', reasons: [warranty], caveats: [warranty, '不保事项：不保封号'], evidenceIds: ['e1'],
    offer: { name: 'Plus 优惠代充', shop: '测试商家', spec: '', productUrl: '', tags: [
      { name: 'delivery', value: 'top_up' }, { name: 'duration', value: '1 month' },
      { name: 'warranty', value: 'covered' }, { name: 'warranty_window', value: '30 days' },
      { name: 'warranty_scope', value: 'subscription' }, { name: 'warranty_exclusion', value: 'ban' },
      { name: 'usage_restriction', value: '需半价资格号' },
      { name: 'warranty_terms', value: '掉订阅按剩余天数退款' },
    ] } };
  render(<AssistantPage api={mockApi({ readSession: vi.fn(async () => ({ id: sessionId, revision: 1,
    needs: emptyShoppingNeeds(), turns: [{ ...done, reply: { ...reply, kind: 'recommendation', options: [], cards: [card] } }] })) })} />);
  const article = (await screen.findByRole('heading', { name: 'ChatGPT Plus' })).closest('article');
  expect(within(article).getByText('店铺：测试商家')).toBeVisible();
  expect(within(article).getByText('¥64.9')).toBeVisible();
  expect(within(article).getByText('代充 · 1个月')).toBeVisible();
  expect(within(article).queryByRole('group', { name: '商品标签' })).not.toBeInTheDocument();
  expect(article).not.toHaveTextContent('CNY');
  expect(article).not.toHaveTextContent('另 5 个标签');
  fireEvent.click(within(article).getByText('购买须知'));
  const notes = article.querySelector('.assistant-purchase-notes');
  expect(notes).toHaveTextContent('质保：30天（仅保掉订阅）');
  expect(notes).toHaveTextContent('购买条件：需半价资格号');
  expect(notes).toHaveTextContent('注意事项：不保封号');
  expect(within(notes).getAllByText(/不保封号/)).toHaveLength(1);
  expect(notes).not.toHaveTextContent('商家质保说明');
  expect(notes).not.toHaveTextContent('采集于');
  expect(notes).not.toHaveTextContent('具体限制以');
  fireEvent.click(within(article).getByRole('button', { name: '查看报价详情' }));
  const details = screen.getByRole('dialog');
  expect(details).toHaveTextContent('掉订阅按剩余天数退款');
  expect(details).not.toHaveTextContent('商家质保说明');
  expect(within(details).getAllByText('不保封号')).toHaveLength(1);
});

test.each([
  [[{ name: 'warranty', value: 'none' }], '无质保'],
  [[{ name: 'warranty_scope', value: 'first_login' }, { name: 'warranty_window', value: '24 hours' }], '仅保首登（24小时内）'],
  [[{ name: 'warranty_days', value: '30' }, { name: 'warranty_days', value: '60' }], '资料冲突，需核实'],
])('compact warranty retains negative, limited and conflicting facts: %s', async (tags, expected) => {
  sessionStorage.setItem('shopping-assistant', JSON.stringify(credentials));
  const card = { standardProductId: '42', productId: '9', shopId: '7', title: 'ChatGPT Plus',
    price: '49', currency: 'USD', capturedAt: '2026-10-31T00:00:00Z', priceExpiresAt: '2099-11-01T00:00:00Z',
    detailPath: '/products/42', reasons: ['商家报价'], caveats: ['下单前核对'], evidenceIds: ['e1'],
    offer: { name: '方案', shop: '店铺', spec: '', productUrl: '', tags } };
  render(<AssistantPage api={mockApi({ readSession: vi.fn(async () => ({ id: sessionId, revision: 1,
    needs: emptyShoppingNeeds(), turns: [{ ...done, reply: { ...reply, kind: 'recommendation', options: [], cards: [card] } }] })) })} />);
  fireEvent.click(await screen.findByText('购买须知'));
  expect(screen.getByText(expected)).toBeVisible();
  expect(screen.getByText('$49')).toBeVisible();
});

test('quote details reuse cleaned merchant titles and facts, with the update time beside the price', async () => {
  const delivery = '购买内容：成品号：商家提供一个账号，下单前确认登录方式、是否独享及能否改密。';
  const extra = '售后条款：二次验证不换号';
  const card = { ...referenceCard, reasons: [delivery, '使用期限：2个月', '质保天数：质保45天'],
    caveats: ['报价、库存与完整售后条款请在商品详情核对。', extra],
    offer: { ...referenceCard.offer, name: '【现货秒发】Plus 两个月独享成品号', productUrl: 'https://shop.invalid/buy', tags: [
      { name: 'delivery', value: 'account' }, { name: 'duration', value: '2 months' },
      { name: 'warranty_days', value: '45' }, { name: 'warranty_window', value: '45 days' },
      { name: 'warranty_terms', value: '封号按剩余质保时间退款' },
    ] } };
  await renderReferenceCards([], [card]);
  fireEvent.click(screen.getByRole('button', { name: '查看报价详情' }));
  const dialog = screen.getByRole('dialog', { name: 'Plus 两个月独享成品号' });
  expect(dialog).not.toHaveTextContent(/现货|秒发|购买内容：成品号|使用期限：2个月|质保天数：|保障窗口45天|下单前核对|采集于/);
  expect(within(dialog).getAllByText('质保45天')).toHaveLength(1);
  expect(within(dialog).getAllByText('2个月')).toHaveLength(1);
  expect(dialog).toHaveTextContent(extra);
  expect(dialog).toHaveTextContent('封号按剩余质保时间退款');
  const time = within(dialog).getByText(/^最近更新/);
  expect(time).toHaveAttribute('datetime', card.capturedAt);
  expect(time.parentElement).toContainElement(within(dialog).getByText('¥61.68'));
  const confirm = within(dialog).getByRole('button', { name: '确认', exact: true });
  expect(dialog).toHaveTextContent(`店铺：${card.offer.shop}`);
  const link = within(dialog).getByRole('link', { name: '前往商家核对报价' });
  expect(link).toHaveTextContent('去商家');
  expect(link.nextElementSibling).toBe(confirm);
  confirm.focus(); fireEvent.keyDown(dialog, { key: 'Tab' });
  expect(within(dialog).getByRole('button', { name: '关闭商品说明' })).toHaveFocus();
  fireEvent.click(confirm);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('legacy quotes keep warranty and delivery notes when structured facts are missing', async () => {
  const reasons = ['购买内容：成品号：商家提供一个账号，下单前确认登录方式、是否独享及能否改密。', '质保天数：质保45天'];
  const caveats = ['售后条款：二次验证不换号', '商家未明确质保时长与保障范围，请在商品详情核实不保事项和售后条款。'];
  await renderReferenceCards([], [{ ...referenceCard, reasons, caveats, offer: { ...referenceCard.offer, tags: [] } }]);
  fireEvent.click(screen.getByRole('button', { name: '查看报价详情' }));
  for (const note of [...reasons, ...caveats]) expect(screen.getByRole('dialog')).toHaveTextContent(note);
});

test.each([
  [[{ name: 'payment_platform', value: 'ios' }], 'iOS'],
  [[{ name: 'payment_platform', value: 'android' }], '安卓'],
  [[{ name: 'payment_platform', value: 'web' }, { name: 'payment_platform', value: 'ios' }], '网页 / iOS'],
  [[{ name: 'device_platform', value: 'ios' }, { name: 'payment_method', value: 'apple_pay' }], null],
])('purchase notes show recharge channels separately from devices and payment methods: %s', async (tags, expected) => {
  sessionStorage.setItem('shopping-assistant', JSON.stringify(credentials));
  const card = { standardProductId: '42', productId: '9', shopId: '7', title: 'ChatGPT Plus',
    price: '49', currency: 'CNY', capturedAt: '2026-10-31T00:00:00Z', priceExpiresAt: '2099-11-01T00:00:00Z',
    detailPath: '/products/42', reasons: ['商家报价'], caveats: ['下单前核对'], evidenceIds: ['e1'],
    offer: { name: '方案', shop: '店铺', spec: '', productUrl: '', tags: [{ name: 'delivery', value: 'top_up' }, ...tags] } };
  render(<AssistantPage api={mockApi({ readSession: vi.fn(async () => ({ id: sessionId, revision: 1,
    needs: emptyShoppingNeeds(), turns: [{ ...done, reply: { ...reply, kind: 'recommendation', options: [], cards: [card] } }] })) })} />);
  fireEvent.click(await screen.findByText('购买须知'));
  if (expected) {
    const channel = screen.getByText('充值渠道：').closest('div');
    expect(channel).toHaveTextContent(`充值渠道：${expected}`);
    expect(channel).toBeVisible();
  } else {
    expect(screen.queryByText('充值渠道：')).not.toBeInTheDocument();
  }
  expect(screen.queryByText('质保：')).not.toBeInTheDocument();
  expect(screen.queryByText('未说明')).not.toBeInTheDocument();
  expect(screen.queryByText(/(?:iOS|安卓|网页)充值/)).not.toBeInTheDocument();
});

test('new conversation stays on the skeleton until the empty session is confirmed', async () => {
  let connect;
  const api = mockApi({ createSession: vi.fn(() => new Promise(resolve => { connect = resolve; })) });
  render(<AssistantPage api={api} enabled />);
  expect(screen.getByRole('status', { name: '正在加载导购助手' })).toBeVisible();
  expect(screen.queryByRole('heading', { name: '想用来做什么？' })).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  await act(async () => connect({ ...credentials, revision: 0 }));
  expect(await screen.findByRole('textbox', { name: '告诉助手你的需求' })).toBeVisible();
  expect(screen.getByRole('heading', { name: '想用来做什么？' })).toBeVisible();
  expect(api.sendTurn).not.toHaveBeenCalled();
});

test('failed session restoration keeps the skeleton and retries without showing a new conversation', async () => {
  sessionStorage.setItem('shopping-assistant', JSON.stringify(credentials));
  let fail;
  const api = mockApi({ readSession: vi.fn().mockImplementationOnce(() => new Promise((_resolve, reject) => {
    fail = reject;
  })).mockResolvedValueOnce({ id: sessionId, revision: 0, needs: emptyShoppingNeeds(), turns: [] }) });
  render(<AssistantPage api={api} />);
  expect(screen.getByRole('status', { name: '正在加载导购助手' })).toBeVisible();
  await waitFor(() => expect(api.readSession).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole('heading', { name: '想用来做什么？' })).not.toBeInTheDocument();
  await act(async () => fail(new Error('连接失败')));
  expect(screen.getByRole('status', { name: '正在加载导购助手' })).toBeVisible();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: '想用来做什么？' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '重试连接' }));
  expect(await screen.findByRole('textbox', { name: '告诉助手你的需求' })).toBeVisible();
  expect(api.createSession).not.toHaveBeenCalled();
});

test('existing conversation stays on the skeleton until history is restored', async () => {
  sessionStorage.setItem('shopping-assistant', JSON.stringify(credentials));
  let restore;
  const api = mockApi({ readSession: vi.fn(() => new Promise(resolve => { restore = resolve; })) });
  render(<AssistantPage api={api} />);
  await waitFor(() => expect(api.readSession).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('status', { name: '正在加载导购助手' })).toBeVisible();
  expect(screen.queryByRole('heading', { name: '想用来做什么？' })).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  await act(async () => restore({ id: sessionId, revision: 1, needs: emptyShoppingNeeds(), turns: [done] }));
  expect(await screen.findByText('预算大概是多少？')).toBeVisible();
  expect(screen.queryByRole('heading', { name: '想用来做什么？' })).not.toBeInTheDocument();
});

test('platform chip and settings share state, track catalog changes, and control sent context', async () => {
  const api = mockApi();
  const view = render(<AssistantPage api={api} embedded catalogPlatform="anthropic" />);
  await screen.findByRole('textbox', { name: '告诉助手你的需求' });
  fireEvent.click(screen.getByRole('button', { name: '不参考 Claude' }));
  fireEvent.click(screen.getByRole('button', { name: '设置' }));
  expect(screen.getByRole('checkbox', { name: '识别当前筛选' })).not.toBeChecked();
  fireEvent.click(screen.getByRole('checkbox', { name: '识别当前筛选' }));
  expect(screen.getByRole('button', { name: '不参考 Claude' })).toBeVisible();
  view.rerender(<AssistantPage api={api} embedded catalogPlatform="google" />);
  expect(screen.queryByRole('button', { name: '不参考 Claude' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '不参考 Gemini / Google' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '写代码', exact: true }));
  await waitFor(() => expect(api.sendTurn).toHaveBeenCalledTimes(1));
  expect(api.sendTurn.mock.calls[0][1].text).toBe('当前页面筛选：Gemini / Google\n写代码');
});

test('status resolving after unmount cannot start session initialization', async () => {
  let resolveStatus;
  const api = mockApi({ status: vi.fn(() => new Promise(resolve => { resolveStatus = resolve; })) });
  const view = render(<AssistantPage api={api} />);
  view.unmount();
  await act(async () => { resolveStatus({ enabled: true }); });
  expect(api.createSession).not.toHaveBeenCalled();
  expect(api.readSession).not.toHaveBeenCalled();
  expect(sessionStorage.getItem('shopping-assistant')).toBeNull();
});

test('create resolving after unmount cannot overwrite a later conversations credentials', async () => {
  let resolveCreation;
  const api = mockApi({ createSession: vi.fn(() => new Promise(resolve => { resolveCreation = resolve; })) });
  const view = render(<AssistantPage api={api} enabled />);
  expect(api.createSession).toHaveBeenCalledTimes(1);
  const signal = api.createSession.mock.calls[0][0];
  view.unmount();
  const replacement = { sessionId: '33333333-3333-4333-8333-333333333333', accessToken: 'new-token' };
  sessionStorage.setItem('shopping-assistant', JSON.stringify(replacement));
  await act(async () => { resolveCreation({ ...credentials, revision: 0 }); });
  expect(signal.aborted).toBe(true);
  expect(JSON.parse(sessionStorage.getItem('shopping-assistant'))).toEqual(replacement);
});

test('superseded initialization cannot overwrite the currently mounted session', async () => {
  let resolveCreation;
  const previousApi = mockApi({ createSession: vi.fn(() => new Promise(resolve => { resolveCreation = resolve; })) });
  const replacement = { sessionId: '33333333-3333-4333-8333-333333333333', accessToken: 'new-token' };
  const nextApi = mockApi({ createSession: vi.fn(async () => ({ ...replacement, revision: 0 })) });
  const view = render(<AssistantPage api={previousApi} enabled />);
  view.rerender(<AssistantPage api={nextApi} enabled />);
  await screen.findByRole('textbox', { name: '告诉助手你的需求' });
  await act(async () => { resolveCreation({ ...credentials, revision: 0 }); });
  expect(JSON.parse(sessionStorage.getItem('shopping-assistant'))).toEqual(replacement);
  expect(nextApi.createSession).toHaveBeenCalledTimes(1);
});

test('disabled assistant has guide and catalog fallback without creating a session', async () => {
  const api = mockApi({ status: vi.fn(async () => ({ enabled: false })) });
  render(<AssistantPage api={api} />);
  expect(await screen.findByText(/导购助手暂未启用/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '查看选购指南' })).toHaveAttribute('href', '/guide');
  expect(api.createSession).not.toHaveBeenCalled();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
});

test('real assistant-ui composer sends only current text and quick options as the next user message', async () => {
  const api = mockApi();
  render(<AssistantPage api={api} />);
  const input = await screen.findByRole('textbox', { name: '告诉助手你的需求' });
  expect(input).toHaveAttribute('maxlength', '2000');
  fireEvent.change(input, { target: { value: '写代码' } });
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
  expect(await screen.findByText('预算大概是多少？')).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: '想用来做什么？' })).not.toBeInTheDocument();
  expect(api.sendTurn.mock.calls[0][1]).toEqual({ clientMessageId: expect.any(String), expectedRevision: 0, text: '写代码' });
  fireEvent.click(screen.getByRole('button', { name: '50元以内' }));
  await waitFor(() => expect(api.sendTurn).toHaveBeenCalledTimes(2));
  expect(api.sendTurn.mock.calls[1][1]).toMatchObject({ text: '50元以内', expectedRevision: 1 });
  expect(sessionStorage.getItem('shopping-assistant')).not.toMatch(/写代码|预算|needs|revision/);
});

test.each(['recommendation', 'comparison'])('refresh restores compact %s cards and preserves explicit comparisons', async kind => {
  sessionStorage.setItem('shopping-assistant', JSON.stringify(credentials));
  window.history.replaceState({}, '', '/assistant?q=secret&newcomer=true');
  const card = { standardProductId: '42', productId: '9', shopId: '7', title: 'ChatGPT Plus',
    price: '49.00', currency: 'CNY', capturedAt: '2020-01-01T00:00:00Z', priceExpiresAt: '2020-01-02T00:00:00Z',
    detailPath: '/products/42', offer: { name: '月度订阅', shop: '测试商家', spec: '完整规格描述', productUrl: '', tags: [] },
    reasons: ['本次候选中价格较低', '补充报价依据'], caveats: ['下单前确认库存'], evidenceIds: ['e1'] };
  const api = mockApi({ readSession: vi.fn(async () => ({ id: sessionId, revision: 1, needs: emptyShoppingNeeds(),
    turns: [{ ...done, reply: { ...reply, kind, text: '本次回复的完整说明', options: [], cards: [card] } }] })) });
  render(<AssistantPage api={api} />);
  await screen.findByRole('textbox', { name: '告诉助手你的需求' });
  expect(screen.getByText('写代码', { selector: 'span' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /查看报价详情/ })).toBeVisible();
  expect(screen.getByText(/¥49/)).toBeInTheDocument();
  expect(screen.queryByText('月度订阅')).not.toBeInTheDocument();
  expect(screen.queryByText('完整规格描述')).not.toBeInTheDocument();
  expect(screen.queryByText('下单前确认库存')).not.toBeInTheDocument();
  expect(screen.queryByText('报价已过期，请重新核对')).not.toBeInTheDocument();
  expect(screen.queryByText('补充报价依据')).not.toBeInTheDocument();
  expect(screen.getByText('本次回复的完整说明')).toBeVisible();
  expect(screen.queryByText('推荐说明')).not.toBeInTheDocument();
  expect(screen.queryByText('购买须知')).not.toBeInTheDocument();
  expect(screen.queryByText('未说明')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /查看报价详情/ }));
  expect(within(screen.getByRole('dialog')).getByText('下单前确认库存')).toBeVisible();
  expect(within(screen.getByRole('dialog')).getByText('补充报价依据')).toBeVisible();
  expect(screen.queryByText('报价已过期，请重新核对')).not.toBeInTheDocument();
  expect(screen.getByText(/完整规格描述/)).toBeVisible();
  expect(screen.queryByRole('link', { name: '按条件浏览商品' })).not.toBeInTheDocument();
  expect(api.sendTurn).not.toHaveBeenCalled();
});

test('stop synchronizes server completion when completion wins cancellation', async () => {
  let complete;
  const api = mockApi({
    subscribeTurn: vi.fn((_credentials, _turn, _onSnapshot, signal) => new Promise((resolve, reject) => {
      complete = resolve;
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })),
    cancelTurn: vi.fn(async () => done),
    readSession: vi.fn(async () => ({ id: sessionId, revision: 1, needs: emptyShoppingNeeds(), turns: [done] })),
  });
  render(<AssistantPage api={api} />);
  fireEvent.change(await screen.findByRole('textbox', { name: '告诉助手你的需求' }), { target: { value: '写代码' } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(api.subscribeTurn).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: '停止' }));
  expect(await screen.findByText('预算大概是多少？')).toBeInTheDocument();
  expect(api.cancelTurn).toHaveBeenCalledWith(expect.objectContaining(credentials), '1');
  expect(api.readSession).toHaveBeenCalled();
  complete?.(done);
});

test('unmount disconnects the subscription without cancelling the backend task', async () => {
  let subscriptionSignal;
  const api = mockApi({ subscribeTurn: vi.fn((_credentials, _turn, _onSnapshot, signal) => {
    subscriptionSignal = signal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
  }) });
  const view = render(<AssistantPage api={api} />);
  fireEvent.change(await screen.findByRole('textbox', { name: '告诉助手你的需求' }), { target: { value: '写代码' } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(api.subscribeTurn).toHaveBeenCalled());
  view.unmount();
  expect(subscriptionSignal.aborted).toBe(true);
  expect(api.cancelTurn).not.toHaveBeenCalled();
});

test('uncertain acceptance blocks new sends and retries the identical UUID, input and revision', async () => {
  const api = mockApi();
  api.sendTurn.mockRejectedValueOnce(new Error('连接中断'));
  render(<AssistantPage api={api} />);
  fireEvent.change(await screen.findByRole('textbox', { name: '告诉助手你的需求' }), { target: { value: '写代码' } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  expect(await screen.findByRole('button', { name: '重新连接' })).toBeInTheDocument();
  expect(screen.getByRole('textbox')).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '重新连接' }));
  expect(await screen.findByText('预算大概是多少？')).toBeInTheDocument();
  expect(api.sendTurn.mock.calls[1][1]).toEqual(api.sendTurn.mock.calls[0][1]);
});

test('clearing a conversation requires confirmation before deleting its session', async () => {
  sessionStorage.setItem('shopping-assistant', JSON.stringify(credentials));
  const api = mockApi({ readSession: vi.fn(async () => ({ id: sessionId, revision: 1,
    needs: emptyShoppingNeeds(), turns: [done] })) });
  render(<AssistantPage api={api} />);
  await screen.findByRole('textbox', { name: '告诉助手你的需求' });
  fireEvent.click(screen.getByRole('button', { name: '设置' }));
  fireEvent.click(screen.getByRole('button', { name: '清空对话' }));
  expect(api.deleteSession).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(api.deleteSession).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '设置' }));
  fireEvent.click(screen.getByRole('button', { name: '清空对话' }));
  fireEvent.click(screen.getByRole('button', { name: '确认清空' }));
  await waitFor(() => expect(api.deleteSession).toHaveBeenCalledWith(expect.objectContaining(credentials)));
  await waitFor(() => expect(api.createSession).toHaveBeenCalled());
  expect(api.deleteSession.mock.invocationCallOrder[0]).toBeLessThan(api.createSession.mock.invocationCallOrder[0]);
});

test('assistant route applies client noindex and its own title', async () => {
  window.history.replaceState({}, '', '/assistant/');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ enabled: false })));
  render(<App />);
  expect(await screen.findByRole('heading', { name: '选购' })).toBeInTheDocument();
  expect(document.title).toMatch(/导购助手/);
  expect(document.querySelector('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
});

test('expired session asks for a new conversation instead of silently replacing the credential', async () => {
  sessionStorage.setItem('shopping-assistant', JSON.stringify(credentials));
  const api = mockApi({ readSession: vi.fn(async () => { throw Object.assign(new Error('会话已失效'), { status: 404 }); }) });
  render(<AssistantPage api={api} />);
  expect(await screen.findByRole('alert')).toHaveTextContent(/失效/);
  expect(api.createSession).not.toHaveBeenCalled();
  expect(screen.queryByRole('textbox', { name: '告诉助手你的需求' })).not.toBeInTheDocument();
});

test('an unavailable conversation can be cleared from the loading error only after confirmation', async () => {
  sessionStorage.setItem('shopping-assistant', JSON.stringify(credentials));
  const api = mockApi({
    readSession: vi.fn(async () => { throw Object.assign(new Error('这段对话已无法继续，请清空对话后重新提问。'), { status: 404 }); }),
    deleteSession: vi.fn(async () => { throw Object.assign(new Error('not found'), { status: 404 }); }),
  });
  render(<AssistantPage api={api} />);
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: '清空对话' }));
  expect(screen.getByRole('button', { name: '重试连接' })).toBeDisabled();
  expect(api.deleteSession).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(JSON.parse(sessionStorage.getItem('shopping-assistant'))).toEqual(credentials);
  expect(screen.getByRole('button', { name: '清空对话' })).toHaveFocus();
  expect(api.createSession).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '清空对话' }));
  fireEvent.click(screen.getByRole('button', { name: '确认清空' }));
  expect(await screen.findByRole('textbox', { name: '告诉助手你的需求' })).not.toBeDisabled();
  expect(api.deleteSession).toHaveBeenCalledTimes(1);
  expect(api.createSession).toHaveBeenCalledTimes(1);
});

test.each([
  ['cancelled', null, '已停止查找。你可以继续提问。'],
  ['failed', 'deadline_exceeded', '等待回复超时，请进群联系管理员处理。'],
  ['failed', 'TURN_TIMEOUT', '等待回复超时，请进群联系管理员处理。'],
  ['failed', 'MODEL_INVALID_RESPONSE', '这次回复没能正常生成，请点击“重试”。'],
  ['failed', 'MODEL_UNAVAILABLE', '导购服务出现异常，请进群联系管理员处理。'],
  ['failed', 'INPUT_TOO_LARGE', '对话内容太长，请清空对话后重新提问。'],
  ['failed', 'EVIDENCE_TOO_LARGE', '导购服务出现异常，请进群联系管理员处理。'],
  ['failed', 'REQUEST_OUTCOME_UNKNOWN', '导购服务出现异常，请进群联系管理员处理。'],
  ['failed', 'RESULT_NOT_SAVED', '导购服务出现异常，请进群联系管理员处理。'],
  ['failed', 'UNKNOWN_FAILURE', '导购服务出现异常，请进群联系管理员处理。'],
  ['failed', 'CONSTRUCTOR', '导购服务出现异常，请进群联系管理员处理。'],
])('restored %s turn exposes a readable terminal state and permits a new message', async (status, errorCode, expected) => {
  sessionStorage.setItem('shopping-assistant', JSON.stringify(credentials));
  const api = mockApi({ readSession: vi.fn(async () => ({ id: sessionId, revision: 0, needs: emptyShoppingNeeds(),
    turns: [turn({ status, phase: status, errorCode })] })) });
  render(<AssistantPage api={api} />);
  expect(await screen.findByText(expected)).toBeInTheDocument();
  expect(screen.getByRole('textbox')).not.toBeDisabled();
  expect(Boolean(screen.queryByRole('button', { name: '进群联系管理员' })))
    .toBe(status === 'failed' && !['INPUT_TOO_LARGE', 'MODEL_INVALID_RESPONSE'].includes(errorCode));
});

test('a failed live query gives administrator contact guidance without exposing internal diagnostics or claiming the requirements were saved', async () => {
  const api = mockApi({ subscribeTurn: vi.fn(async (_credentials, active) => ({ ...active,
    status: 'failed', phase: 'explaining', eventVersion: 2, errorCode: 'MODEL_UNAVAILABLE' })) });
  render(<AssistantPage api={api} />);
  fireEvent.change(await screen.findByRole('textbox'), { target: { value: '我想找一个靠谱的代充，gpt plus会员的' } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  expect(await screen.findByText('导购服务出现异常，请进群联系管理员处理。')).toBeVisible();
  expect(screen.queryByText(/回答无效|生成可用的推荐|MODEL_INVALID_RESPONSE|已确认的需求|本轮|这次未能完成/)).not.toBeInTheDocument();
  expect(screen.getByRole('textbox')).not.toBeDisabled();
  expect(api.sendTurn).toHaveBeenCalledTimes(1);
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: '保留草稿' } });
  const contact = screen.getByRole('button', { name: '进群联系管理员' });
  contact.focus();
  fireEvent.click(contact);
  const community = screen.getByRole('dialog', { name: 'QQ 交流群' });
  expect(within(community).getByRole('textbox', { name: 'QQ 群号' })).toHaveValue('346347792');
  expect(within(community).getByAltText('QQ 群二维码')).toBeVisible();
  fireEvent.click(within(community).getByRole('button', { name: '关闭交流群弹窗' }));
  expect(contact).toHaveFocus();
  expect(input).toHaveValue('保留草稿');
  expect(api.sendTurn).toHaveBeenCalledTimes(1);
});

test.each(['initialization', 'subscription', 'clearing'])('server failure during %s provides group contact without losing conversation', async stage => {
  const { createAssistantApi } = await import('./assistant-api.js');
  let failure;
  try { await createAssistantApi(async () => new Response('private provider details', { status: 503 })).status(); }
  catch (error) { failure = error; }
  const api = mockApi();
  if (stage === 'initialization') api.status.mockRejectedValueOnce(failure);
  if (stage === 'subscription') api.subscribeTurn.mockRejectedValueOnce(failure);
  if (stage === 'clearing') {
    sessionStorage.setItem('shopping-assistant', JSON.stringify(credentials));
    api.readSession.mockResolvedValue({ id: sessionId, revision: 1, needs: emptyShoppingNeeds(), turns: [done] });
    api.deleteSession.mockRejectedValueOnce(failure);
  }
  render(<AssistantPage api={api} />);
  if (stage === 'subscription') {
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: '买plus呢' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
  }
  if (stage === 'clearing') {
    await screen.findByText(reply.text);
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.click(screen.getByRole('button', { name: '清空对话' }));
    fireEvent.click(screen.getByRole('button', { name: '确认清空' }));
  }
  const contact = await screen.findByRole('button', { name: '进群联系管理员' });
  expect(screen.getByRole('alert')).toHaveTextContent('请进群联系管理员处理');
  expect(screen.queryByText(/private provider details/)).not.toBeInTheDocument();
  fireEvent.click(contact);
  expect(screen.getByRole('dialog', { name: 'QQ 交流群' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '关闭交流群弹窗' }));
  if (stage === 'clearing') {
    expect(screen.getByText(reply.text)).toBeVisible();
    expect(JSON.parse(sessionStorage.getItem('shopping-assistant'))).toEqual(credentials);
  }
  expect(api.sendTurn).toHaveBeenCalledTimes(stage === 'subscription' ? 1 : 0);
});

test('restored no-match keeps the authoritative hard budget and displays no invented cards', async () => {
  sessionStorage.setItem('shopping-assistant', JSON.stringify(credentials));
  const needs = { ...emptyShoppingNeeds(), budget: { amount: '50', currency: 'CNY', basis: 'month' } };
  const api = mockApi({ readSession: vi.fn(async () => ({ id: sessionId, revision: 1, needs,
    turns: [{ ...done, reply: { ...reply, kind: 'no_match', text: '当前没有符合条件的报价。', options: [], needs } }] })) });
  render(<AssistantPage api={api} />);
  expect(await screen.findByText('当前没有符合条件的报价。')).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /查看商品详情/ })).not.toBeInTheDocument();
  expect(screen.getByLabelText('已确认条件')).toHaveTextContent('每月 ≤ ¥50');
  expect(screen.queryByRole('link', { name: '按条件浏览商品' })).not.toBeInTheDocument();
});

test('starter choices send a short message immediately and update the conversation title', async () => {
  const api = mockApi();
  render(<AssistantPage api={api} />);
  await screen.findByRole('textbox', { name: '告诉助手你的需求' });
  fireEvent.click(screen.getByRole('button', { name: '写代码', exact: true }));
  await waitFor(() => expect(api.sendTurn).toHaveBeenCalledTimes(1));
  expect(api.sendTurn.mock.calls[0][1].text).toBe('写代码');
  expect(screen.getByRole('heading', { name: '写代码' })).toBeVisible();
  expect(screen.queryByRole('heading', { name: '想用来做什么？' })).not.toBeInTheDocument();
});

test('standalone mobile page does not automatically focus the input', async () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
  render(<AssistantPage api={mockApi()} />);
  expect(await screen.findByRole('textbox', { name: '告诉助手你的需求' })).not.toHaveFocus();
});

test('starter shortcut does not overwrite an existing draft', async () => {
  const api = mockApi();
  render(<AssistantPage api={api} />);
  const input = await screen.findByRole('textbox', { name: '告诉助手你的需求' });
  fireEvent.change(input, { target: { value: '我自己的需求' } });
  fireEvent.click(screen.getByRole('button', { name: '写代码', exact: true }));
  await waitFor(() => expect(api.sendTurn).toHaveBeenCalledTimes(1));
  expect(api.sendTurn.mock.calls[0][1].text).toBe('写代码');
  expect(input).toHaveValue('我自己的需求');
});

test('cancelling clear returns focus to the options menu when input autofocus is off', async () => {
  render(<AssistantPage api={mockApi()} focusInput={false} />);
  await screen.findByRole('textbox', { name: '告诉助手你的需求' });
  fireEvent.click(screen.getByRole('button', { name: '写代码', exact: true }));
  await screen.findByText('预算大概是多少？');
  const menu = screen.getByRole('button', { name: '设置' });

  fireEvent.click(screen.getByRole('button', { name: '设置' }));
  fireEvent.click(screen.getByRole('button', { name: '清空对话' }));
  expect(screen.getByRole('button', { name: '取消' })).toHaveFocus();
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(menu).toHaveFocus();
});

test('empty conversation disables clearing and settings dismisses outside or on Escape', async () => {
  const onCollapse = vi.fn();
  render(<AssistantPage api={mockApi()} embedded catalogPlatform="anthropic" onCollapse={onCollapse} />);
  const input = await screen.findByRole('textbox', { name: '告诉助手你的需求' });
  expect(input).toHaveAttribute('placeholder', '说说你的需求…');
  expect(input.closest('.assistant-composer')).toContainElement(screen.getByRole('button', { name: '不参考 Claude' }));
  expect(screen.getByRole('button', { name: '日常办公' })).toBeVisible();
  const settings = screen.getByRole('button', { name: '设置' });
  fireEvent.click(settings);
  expect(screen.getByRole('button', { name: '清空对话' })).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: '识别当前筛选' }));
  expect(settings).toHaveAttribute('aria-expanded', 'true');
  fireEvent.pointerDown(input);
  expect(settings).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(settings);
  fireEvent.keyDown(screen.getByRole('checkbox', { name: '识别当前筛选' }), { key: 'Escape' });
  expect(settings).toHaveAttribute('aria-expanded', 'false');
  expect(settings).toHaveFocus();
  expect(onCollapse).not.toHaveBeenCalled();
});

test('confirmed needs stay visible without a separate modify action', async () => {
  sessionStorage.setItem('shopping-assistant', JSON.stringify(credentials));
  const needs = { ...emptyShoppingNeeds(), platform: 'OpenAI', purpose: '写代码',
    budget: { amount: '50', currency: 'CNY', basis: 'month' } };
  const api = mockApi({ readSession: vi.fn(async () => ({ id: sessionId, revision: 1, needs,
    turns: [{ ...done, reply: { ...reply, needs } }] })) });
  render(<AssistantPage api={api} />);
  await screen.findByRole('textbox', { name: '告诉助手你的需求' });
  expect(screen.queryByRole('button', { name: '修改需求' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('已确认条件')).toHaveTextContent('每月 ≤ ¥50');
  expect(screen.queryByText('浏览更多商品')).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: '按条件浏览商品' })).not.toBeInTheDocument();
  expect(api.sendTurn).not.toHaveBeenCalled();
});

test.each([false, true])('running progress stays in the reply area, including restored sessions (%s)', async restored => {
  let update, finish;
  const active = turn({ status: 'running', phase: 'searching' });
  if (restored) sessionStorage.setItem('shopping-assistant', JSON.stringify(credentials));
  const api = mockApi({
    readSession: vi.fn(async () => ({ id: sessionId, revision: 0, needs: emptyShoppingNeeds(), turns: [active] })),
    subscribeTurn: vi.fn((_credentials, _turn, onSnapshot) => new Promise(resolve => { update = onSnapshot; finish = resolve; })),
  });
  render(<AssistantPage api={api} />);
  await screen.findByRole('textbox');
  if (!restored) fireEvent.click(screen.getByRole('button', { name: '写代码', exact: true }));
  await waitFor(() => expect(api.subscribeTurn).toHaveBeenCalled());
  act(() => update(active));
  const progress = screen.getByRole('status');
  expect(progress).toHaveTextContent('正在查找报价');
  expect(progress.closest('.assistant-viewport')).not.toBeNull();
  if (!restored) expect(progress.closest('.assistant-message-assistant')).not.toBeNull();
  expect(screen.queryByText('拾价助手')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '发送' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '停止' })).toBeEnabled();
  act(() => update({ ...active, phase: 'explaining', eventVersion: 2 }));
  expect(progress).toHaveTextContent('正在整理推荐');
  await act(async () => finish(done));
  expect(await screen.findByText('预算大概是多少？')).toBeVisible();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '发送' })).toBeInTheDocument();
  if (restored) expect(api.sendTurn).not.toHaveBeenCalled();
});

test('while a reply is pending users can prepare a draft but cannot submit another turn', async () => {
  let finish;
  const api = mockApi({ subscribeTurn: vi.fn((_credentials, active) => new Promise(resolve => {
    finish = () => resolve({ ...done, clientMessageId: active.clientMessageId });
  })) });
  render(<AssistantPage api={api} />);
  const input = await screen.findByRole('textbox', { name: '告诉助手你的需求' });
  fireEvent.change(input, { target: { value: '写代码' } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(api.subscribeTurn).toHaveBeenCalled());
  expect(input).not.toBeDisabled();
  fireEvent.change(input, { target: { value: '预算每月50元' } });
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
  fireEvent.submit(input.closest('form'));
  expect(api.sendTurn).toHaveBeenCalledTimes(1);
  await act(async () => finish());
  expect(input).toHaveValue('预算每月50元');
});

test('initialization retry restores the existing conversation without deleting it', async () => {
  sessionStorage.setItem('shopping-assistant', JSON.stringify(credentials));
  const api = mockApi();
  api.readSession.mockRejectedValueOnce(new Error('连接中断'));
  render(<AssistantPage api={api} />);
  fireEvent.click(await screen.findByRole('button', { name: '重试连接' }));
  await screen.findByRole('textbox', { name: '告诉助手你的需求' });
  expect(api.readSession).toHaveBeenCalledTimes(2);
  expect(api.deleteSession).not.toHaveBeenCalled();
  expect(api.createSession).not.toHaveBeenCalled();
});

test('failed clearing preserves history and allows retrying the deletion', async () => {
  sessionStorage.setItem('shopping-assistant', JSON.stringify(credentials));
  const api = mockApi({ readSession: vi.fn(async () => ({ id: sessionId, revision: 1,
    needs: emptyShoppingNeeds(), turns: [done] })) });
  api.deleteSession.mockRejectedValueOnce(new Error('连接中断'));
  render(<AssistantPage api={api} />);
  await screen.findByText('预算大概是多少？');
  fireEvent.click(screen.getByRole('button', { name: '设置' }));
  fireEvent.click(screen.getByRole('button', { name: '清空对话' }));
  fireEvent.click(screen.getByRole('button', { name: '确认清空' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('连接中断');
  expect(screen.getByText('预算大概是多少？')).toBeInTheDocument();
  expect(JSON.parse(sessionStorage.getItem('shopping-assistant'))).toEqual(credentials);
  fireEvent.click(screen.getByRole('button', { name: '确认清空' }));
  await waitFor(() => expect(api.createSession).toHaveBeenCalled());
});

test('refresh recovers a pending accepted message by UUID without sending again', async () => {
  sessionStorage.setItem('shopping-assistant', JSON.stringify({ ...credentials, pendingMessageId: done.clientMessageId }));
  const api = mockApi({ readSession: vi.fn(async () => ({ id: sessionId, revision: 0, needs: emptyShoppingNeeds(), turns: [turn()] })) });
  render(<AssistantPage api={api} />);
  expect(await screen.findByText('预算大概是多少？')).toBeInTheDocument();
  expect(api.sendTurn).not.toHaveBeenCalled();
  expect(api.createSession).not.toHaveBeenCalled();
  expect(JSON.parse(sessionStorage.getItem('shopping-assistant'))).toEqual(credentials);
});

test('unknown pending UUID without server input never invents a replay after reload', async () => {
  sessionStorage.setItem('shopping-assistant', JSON.stringify({ ...credentials, pendingMessageId: done.clientMessageId }));
  const api = mockApi();
  render(<AssistantPage api={api} />);
  expect(await screen.findByRole('alert')).toHaveTextContent(/无法找回上一条消息/);
  expect(screen.getByRole('textbox')).toBeDisabled();
  expect(api.sendTurn).not.toHaveBeenCalled();
  expect(api.createSession).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '设置' }));
  expect(screen.getByRole('button', { name: '清空对话' })).not.toBeDisabled();
});

test('version conflict restores authoritative history and allows a new message at its revision', async () => {
  const api = mockApi({ readSession: vi.fn(async () => ({ id: sessionId, revision: 1, needs: emptyShoppingNeeds(), turns: [done] })) });
  api.sendTurn.mockRejectedValueOnce(Object.assign(new Error('会话版本已变化'), { status: 409 }));
  render(<AssistantPage api={api} />);
  fireEvent.change(await screen.findByRole('textbox', { name: '告诉助手你的需求' }), { target: { value: '更便宜' } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(api.readSession).toHaveBeenCalled());
  expect(await screen.findByText('预算大概是多少？')).toBeInTheDocument();
  expect(screen.getByRole('textbox')).not.toBeDisabled();
  expect(api.sendTurn).toHaveBeenCalledTimes(1);
});


test('new embedded conversation defaults to checked platform context without filling the draft', async () => {
  window.history.replaceState({}, '', '/?platform=anthropic');
  const api = mockApi();
  render(<AssistantPage api={api} embedded />);
  const input = await screen.findByRole('textbox', { name: '告诉助手你的需求' });
  expect(input).toHaveValue('');
  fireEvent.click(screen.getByRole('button', { name: '设置' }));
  expect(screen.getByRole('checkbox', { name: '识别当前筛选' })).toBeChecked();
  expect(api.sendTurn).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '设置' }));
  fireEvent.click(screen.getByRole('button', { name: '写代码' }));
  expect(input).toHaveValue('');
  await waitFor(() => expect(api.sendTurn).toHaveBeenCalledTimes(1));
  expect(api.sendTurn.mock.calls[0][1].text).toContain('Claude');
  expect(await screen.findByText('预算大概是多少？')).toBeInTheDocument();
  expect(input).toHaveValue('');
  fireEvent.click(screen.getByRole('button', { name: '设置' }));
  expect(screen.getByRole('checkbox', { name: '识别当前筛选' })).toBeChecked();
  fireEvent.change(input, { target: { value: '预算50元' } });
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
  await waitFor(() => expect(api.sendTurn).toHaveBeenCalledTimes(2));
  expect(api.sendTurn.mock.calls[1][1].text).toBe('当前页面筛选：Claude\n预算50元');
  expect(screen.getByText('内容由AI生成，仅供参考')).toBeVisible();
  expect(screen.getByRole('button', { name: '设置' })).toBeVisible();
  expect(screen.queryByText('说明')).not.toBeInTheDocument();

});

test('restored conversation ignores catalog platform and clearing reads the current platform', async () => {
  sessionStorage.setItem('shopping-assistant', JSON.stringify(credentials));
  window.history.replaceState({}, '', '/?platform=anthropic');
  const api = mockApi({ readSession: vi.fn(async () => ({ id: sessionId, revision: 1,
    needs: emptyShoppingNeeds(), turns: [done] })) });
  render(<AssistantPage api={api} embedded />);
  expect(await screen.findByRole('textbox', { name: '告诉助手你的需求' })).toHaveValue('');
  window.history.replaceState({}, '', '/?platform=google');
  fireEvent.click(screen.getByRole('button', { name: '设置' }));
  fireEvent.click(screen.getByRole('button', { name: '清空对话' }));
  fireEvent.click(screen.getByRole('button', { name: '确认清空' }));
  await screen.findByRole('button', { name: '写代码' });
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '找报价' } });
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', code: 'Enter' });
  await waitFor(() => expect(api.sendTurn).toHaveBeenCalledTimes(1));
  expect(api.sendTurn.mock.calls[0][1].text).toBe('当前页面筛选：Gemini / Google\n找报价');
  expect(screen.getByRole('textbox')).toHaveValue('');
});

test.each(['click', 'enter'])('unchecked platform context is omitted on %s send', async method => {
  window.history.replaceState({}, '', '/?platform=anthropic');
  const api = mockApi();
  render(<AssistantPage api={api} embedded />);
  const input = await screen.findByRole('textbox', { name: '告诉助手你的需求' });
  fireEvent.click(screen.getByRole('button', { name: '设置' }));
  fireEvent.click(screen.getByRole('checkbox', { name: '识别当前筛选' }));
  fireEvent.change(input, { target: { value: '帮我选写代码的商品' } });
  if (method === 'enter') fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
  else fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(api.sendTurn).toHaveBeenCalledTimes(1));
  expect(api.sendTurn.mock.calls[0][1].text).toBe('帮我选写代码的商品');
});

test('context exceeding the request limit preserves draft and can be disabled to send it', async () => {
  window.history.replaceState({}, '', '/?platform=anthropic');
  const api = mockApi();
  render(<AssistantPage api={api} embedded />);
  const input = await screen.findByRole('textbox', { name: '告诉助手你的需求' });
  const draft = '字'.repeat(2000);
  fireEvent.change(input, { target: { value: draft } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  expect(api.sendTurn).not.toHaveBeenCalled();
  expect(input).toHaveValue(draft);
  expect(screen.getByRole('alert')).toHaveTextContent('2,000');
  fireEvent.click(screen.getByRole('button', { name: '设置' }));
  fireEvent.click(screen.getByRole('checkbox', { name: '识别当前筛选' }));
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(api.sendTurn).toHaveBeenCalledTimes(1));
  expect(api.sendTurn.mock.calls[0][1].text).toBe(draft);
});

test('checked context reads the latest platform at send time and reconnect reuses the original request', async () => {
  window.history.replaceState({}, '', '/?platform=anthropic');
  const api = mockApi();
  api.sendTurn.mockRejectedValueOnce(new Error('连接中断'));
  render(<AssistantPage api={api} embedded />);
  const input = await screen.findByRole('textbox', { name: '告诉助手你的需求' });
  fireEvent.change(input, { target: { value: '帮我选' } });
  window.history.replaceState({}, '', '/?platform=google');
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
  await screen.findByRole('button', { name: '重新连接' });
  expect(api.sendTurn.mock.calls[0][1].text).toBe('当前页面筛选：Gemini / Google\n帮我选');
  window.history.replaceState({}, '', '/?platform=anthropic');
  fireEvent.click(screen.getByRole('button', { name: '重新连接' }));
  await screen.findByText('预算大概是多少？');
  expect(api.sendTurn.mock.calls[1][1]).toEqual(api.sendTurn.mock.calls[0][1]);
});

test.each(['/?platform=other', '/?platform=unknown', '/guide?platform=anthropic', '/products/42?platform=anthropic'])(
  'does not invent a platform context for %s', async path => {
    window.history.replaceState({}, '', path);
    render(<AssistantPage api={mockApi()} embedded />);
    expect(await screen.findByRole('textbox', { name: '告诉助手你的需求' })).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
  expect(screen.getByRole('checkbox', { name: '识别当前筛选' })).toBeChecked();
  },
);

test('invalid model replies allow two explicit retries of the exact input, then offer administrator contact', async () => {
  const original = '当前页面筛选：ChatGPT / Codex\n买plus呢';
  let attempt = 0;
  const api = mockApi({
    sendTurn: vi.fn(async (_credentials, input) => ({ snapshot: turn({ id: String(++attempt), inputText: input.text,
      clientMessageId: input.clientMessageId, expectedRevision: input.expectedRevision }), created: true })),
    subscribeTurn: vi.fn(async (_credentials, active) => ({ ...active, status: 'failed', phase: 'understanding',
      errorCode: 'MODEL_INVALID_RESPONSE', eventVersion: 2 })),
  });
  render(<AssistantPage api={api} embedded catalogPlatform="openai" />);
  fireEvent.change(await screen.findByRole('textbox'), { target: { value: '买plus呢' } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  for (let retry = 1; retry <= 2; retry++) {
    const button = await screen.findByRole('button', { name: '重试' });
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(api.sendTurn).toHaveBeenCalledTimes(retry);
    expect(screen.queryByRole('button', { name: '进群联系管理员' })).not.toBeInTheDocument();
    fireEvent.click(button);
  }
  expect(await screen.findByText('重试后仍未能正常回复，请进群联系管理员处理。')).toBeVisible();
  expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '进群联系管理员' })).toBeVisible();
  expect(api.sendTurn).toHaveBeenCalledTimes(3);
  expect(new Set(api.sendTurn.mock.calls.map(([, input]) => input.clientMessageId)).size).toBe(3);
  for (const [, input] of api.sendTurn.mock.calls) expect(input).toMatchObject({ text: original, expectedRevision: 0 });
});

test.each([1, 2, 3])('restoring %i consecutive invalid replies retains the retry allowance', async count => {
  sessionStorage.setItem('shopping-assistant', JSON.stringify(credentials));
  const turns = Array.from({ length: count }, (_, i) => turn({ id: String(i + 1), status: 'failed',
    phase: 'understanding', errorCode: 'MODEL_INVALID_RESPONSE' }));
  const api = mockApi({ readSession: vi.fn(async () => ({ id: sessionId, revision: 0, needs: emptyShoppingNeeds(), turns })) });
  render(<AssistantPage api={api} />);
  await screen.findByRole('textbox');
  expect(Boolean(screen.queryByRole('button', { name: '重试' }))).toBe(count < 3);
  expect(Boolean(screen.queryByRole('button', { name: '进群联系管理员' }))).toBe(count === 3);
  expect(api.sendTurn).not.toHaveBeenCalled();
});

test('retry succeeds using the existing requirements and removes the retry action', async () => {
  sessionStorage.setItem('shopping-assistant', JSON.stringify(credentials));
  const needs = { ...emptyShoppingNeeds(), purpose: '写代码', platform: 'openai' };
  const api = mockApi({ readSession: vi.fn(async () => ({ id: sessionId, revision: 4, needs,
    turns: [turn({ status: 'failed', phase: 'understanding', errorCode: 'MODEL_INVALID_RESPONSE', expectedRevision: 4 })] })),
    sendTurn: vi.fn(async (_credentials, input) => ({ snapshot: turn({ id: '2', clientMessageId: input.clientMessageId,
      inputText: input.text, expectedRevision: input.expectedRevision }), created: true })),
    subscribeTurn: vi.fn(async (_credentials, active) => ({ ...active, status: 'succeeded', phase: 'succeeded',
      reply: { ...reply, needs } })),
  });
  render(<AssistantPage api={api} />);
  fireEvent.click(await screen.findByRole('button', { name: '重试' }));
  expect(await screen.findByText(reply.text)).toBeVisible();
  expect(api.sendTurn.mock.calls[0][1]).toMatchObject({ text: '写代码', expectedRevision: 4 });
  expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '进群联系管理员' })).not.toBeInTheDocument();
});

test.each(['different input', 'successful reply'])('a %s starts a fresh retry allowance', async scenario => {
  sessionStorage.setItem('shopping-assistant', JSON.stringify(credentials));
  const failed = turn({ status: 'failed', errorCode: 'MODEL_INVALID_RESPONSE' });
  const turns = [{ ...failed, id: '1' }, scenario === 'successful reply' ? { ...done, id: '2' } : { ...failed, id: '2' },
    { ...failed, id: '3', inputText: scenario === 'different input' ? '读论文' : '写代码' }];
  render(<AssistantPage api={mockApi({ readSession: vi.fn(async () => ({ id: sessionId, revision: 0,
    needs: emptyShoppingNeeds(), turns })) })} />);
  expect(await screen.findByRole('button', { name: '重试' })).toBeVisible();
  expect(screen.queryByRole('button', { name: '进群联系管理员' })).not.toBeInTheDocument();
});

test('repeated clicks on retry cannot submit concurrent requests', async () => {
  sessionStorage.setItem('shopping-assistant', JSON.stringify(credentials));
  let finish;
  const api = mockApi({
    readSession: vi.fn(async () => ({ id: sessionId, revision: 0, needs: emptyShoppingNeeds(),
      turns: [turn({ status: 'failed', errorCode: 'MODEL_INVALID_RESPONSE' })] })),
    sendTurn: vi.fn(async (_credentials, input) => ({ snapshot: turn({ id: '2', inputText: input.text,
      clientMessageId: input.clientMessageId }), created: true })),
    subscribeTurn: vi.fn(async () => new Promise(resolve => { finish = resolve; })),
  });
  render(<AssistantPage api={api} />);
  const button = await screen.findByRole('button', { name: '重试' });
  fireEvent.click(button);
  fireEvent.click(button);
  await waitFor(() => expect(api.subscribeTurn).toHaveBeenCalledTimes(1));
  expect(api.sendTurn).toHaveBeenCalledTimes(1);
  await act(async () => finish({ ...done, id: '2' }));
});
