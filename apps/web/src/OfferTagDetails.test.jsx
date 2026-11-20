import React from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import OfferTagDetails, { OfferFacts, offerConditions } from './OfferTagDetails.jsx';

afterEach(() => window.history.replaceState({}, '', '/'));
const offer = { productId: '9', shop: '甲店', name: 'AI 会员账号', spec: '10个一包；禁止改密', settlementQuantity: 5, tags: [
  { name: 'region', value: 'us' }, { name: 'region', value: 'us' }, { name: 'region', value: 'jp' },
  { name: 'bulk_purchase', value: 'supported' }, { name: 'duration', value: 30 },
  { name: 'usage_warranty', value: '首登' },
] };

test('conditions deduplicate values while preserving multiple regions and actual settlement quantity', () => {
  const conditions = offerConditions(offer);
  expect(conditions[0].name).toBe('settlement_quantity');
  expect(conditions.find(fact => fact.name === 'settlement_quantity').value).toBe('5件起购');
  expect(conditions.filter(fact => fact.name === 'region').map(fact => fact.value)).toEqual(['美区', '日区']);
});

test.each(['supported', 'required', 'bundle'])('bulk %s never invents minimum quantity or price', value => {
  const tags = [{ name: 'bulk_purchase', value }];
  expect(offerConditions({ tags }).some(fact => fact.name === 'settlement_quantity')).toBe(false);
  expect(offerConditions({ tags, settlementQuantity: 1 }).some(fact => fact.name === 'settlement_quantity')).toBe(false);
  expect(offerConditions({ tags, settlementQuantity: 5 }).find(fact => fact.name === 'settlement_quantity').value).toBe('5件起购');
});

test.each([1, 2])('the %s-tag summary prioritizes short coverage and opens full conditions', limit => {
  const onOpenDetails = vi.fn();
  render(<OfferFacts limit={limit} onOpenDetails={onOpenDetails} tags={offer.tags} />);
  const summary = screen.getByRole('group', { name: '商品标签' });
  expect(summary.querySelectorAll('span')).toHaveLength(limit);
  expect(summary.querySelector('span')).toHaveAttribute('title', '首登');
  expect(summary.querySelector('span')).toHaveTextContent('首登');
  expect(summary).not.toHaveTextContent('封号不保');
  fireEvent.click(within(summary).getByRole('button', { name: `查看全部商品条件，另有 ${5 - limit} 项` }));
  expect(onOpenDetails).toHaveBeenCalledOnce();
});

test('details retain actual SKU conditions, membership warranty, report action and keyboard focus', () => {
  const opener = document.createElement('button'); document.body.append(opener); opener.focus();
  const close = vi.fn(); const report = vi.fn();
  const view = render(<OfferTagDetails offer={offer} item={{ name: '标准商品' }} onClose={close} onReport={report} />);
  const dialog = screen.getByRole('dialog', { name: offer.name });
  expect(within(dialog).getByRole('region', { name: '商品条件' })).toHaveAttribute('tabindex', '0');
  expect(dialog).toHaveTextContent('10个一包；禁止改密');
  expect(dialog).toHaveTextContent('5件起购');
  expect(dialog).toHaveTextContent('支持批量购买');
  expect(within(dialog).getAllByText(offer.tags.at(-1).value, { exact: true })).toHaveLength(1);
  for (const group of ['地区', '使用期限', '批量购买', '使用保障']) expect(within(dialog).getByRole('heading', { name: group })).toBeInTheDocument();
  expect(dialog).toHaveTextContent('标签不是无条件承诺');
  expect(within(dialog).queryByRole('heading', { name: '保障条款' })).not.toBeInTheDocument();
  const first = within(dialog).getByRole('button', { name: '关闭商品说明' });
  const last = within(dialog).getByRole('button', { name: '确认', exact: true });
  last.focus(); fireEvent.keyDown(dialog, { key: 'Tab' }); expect(first).toHaveFocus();
  fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true }); expect(last).toHaveFocus();
  fireEvent.click(within(dialog).getByRole('button', { name: '举报此报价' })); expect(report).toHaveBeenCalledWith(offer);
  fireEvent.click(last); expect(close).toHaveBeenCalledOnce();
  fireEvent.keyDown(dialog, { key: 'Escape' }); expect(close).toHaveBeenCalledTimes(2);
  view.unmount(); expect(opener).toHaveFocus(); opener.remove();
});

test('access channels and tools share a group without adding exclusive support', () => {
  render(<OfferTagDetails offer={{ ...offer, tags: [{ name: 'access_channel', value: 'web' }, { name: 'supported_client', value: 'codex' }] }} item={{}} onClose={() => {}} />);
  const section = screen.getByRole('heading', { name: '使用入口与支持工具' }).closest('section');
  expect(section).toHaveTextContent('网页'); expect(section).toHaveTextContent('支持Codex');
  expect(section).not.toHaveTextContent('仅支持');
});

test.each(['none', 'unknown', 'covered', '首次进入遇到异常，请提交截图，我们会重新发放一份'])('rejects retired terms %s without a detail or summary fallback', value => {
  const tags = [{ name: 'warranty_terms', value }];
  const view = render(<OfferFacts tags={tags} />);
  expect(view.container.querySelector('.offer-warranty')).toBeNull();
  expect(view.container.querySelector('button')).toBeNull();
  view.unmount();
  render(<OfferTagDetails offer={{ ...offer, tags, settlementQuantity: 1 }} item={{}} onClose={() => {}} />);
  expect(screen.getByRole('dialog')).toHaveTextContent('10个一包；禁止改密');
  expect(screen.getByRole('dialog')).not.toHaveTextContent(/无售后|有质保|无质保|未知|未说明/);
  expect(within(screen.getByRole('dialog')).queryByText(value, { exact: true })).not.toBeInTheDocument();
  expect(screen.getByText('暂无商品条件信息')).toBeInTheDocument();
});

test('independent coverage labels show only current fields without a retired terms button', () => {
  const tags = [
    { name: 'subscription_warranty', value: '质保 12 天' },
    { name: 'usage_warranty', value: '首登' },
    { name: 'warranty_terms', value: '订阅保30天，首登交付后5分钟内反馈；封号不保，退款扣手续费。' },
  ];
  const open = vi.fn();
  const view = render(<OfferFacts tags={tags} onOpenDetails={open} />);
  expect([...view.container.querySelectorAll('span')].map(item => item.textContent)).toEqual(['订阅质保12天', '首登']);
  expect(screen.queryByRole('button', { name: '保障条款' })).not.toBeInTheDocument();
  expect(open).not.toHaveBeenCalled();
  view.unmount();
  render(<OfferTagDetails offer={{ ...offer, tags }} item={{}} onClose={() => {}} />);
  for (const title of ['订阅保障', '使用保障']) expect(screen.getByRole('heading', { name: title })).toBeVisible();
  expect(screen.getByRole('dialog')).not.toHaveTextContent('封号不保，退款扣手续费');
});
test('malformed warranty values leave an empty summary and preserve the original specification', () => {
  const tags = [{ name: 'warranty_terms', value: { days: 30 } }];
  const view = render(<OfferFacts tags={tags} />);
  expect(screen.queryByRole('group', { name: '商品标签' })).not.toBeInTheDocument();
  view.unmount();
  render(<OfferTagDetails offer={{ ...offer, tags, settlementQuantity: 1 }} item={{}} onClose={() => {}} />);
  expect(screen.getByRole('dialog')).toHaveTextContent('10个一包；禁止改密');
  expect(screen.getByText('暂无商品条件信息')).toBeInTheDocument();
});

test('equal warranty durations remain distinct in badges and details', () => {
  const tags = [
    { name: 'subscription_warranty', value: '质保 30 天' },
    { name: 'usage_warranty', value: '质保 30 天' },
  ];
  const view = render(<OfferFacts tags={tags} />);
  expect([...screen.getByLabelText('商品标签').querySelectorAll('span')].map(tag => tag.textContent))
    .toEqual(['订阅质保30天', '使用质保30天']);
  view.unmount();
  render(<OfferTagDetails offer={{ ...offer, tags }} item={{}} onClose={() => {}} />);
  expect(within(screen.getByRole('dialog')).getByText('订阅质保30天')).toBeVisible();
  expect(within(screen.getByRole('dialog')).getByText('使用质保30天')).toBeVisible();
});

test.each(['account', 'top_up'])('%s omits subscription warranty and preserves usage coverage', membershipKind => {
  const tags = [
    { name: 'subscription_warranty', value: '质保 30 天' },
    { name: 'usage_warranty', value: '质保 7 天' },
    { name: 'region', value: 'us' },
  ];
  const view = render(<OfferFacts tags={tags} membershipKind={membershipKind} />);
  expect([...screen.getByLabelText('商品标签').querySelectorAll('span')].map(tag => tag.textContent))
    .toEqual(['使用质保7天', '美区']);
  expect(screen.queryByRole('button', { name: /查看全部商品条件/ })).not.toBeInTheDocument();
  view.unmount();
  render(<OfferTagDetails offer={{ ...offer, tags, membershipKind }} item={{}} onClose={() => {}} />);
  expect(screen.queryByRole('heading', { name: '订阅保障' })).not.toBeInTheDocument();
  expect(within(screen.getByRole('dialog')).getByText('使用质保7天')).toBeVisible();
  expect(tags).toHaveLength(3);
});

test.each(['account', 'top_up'])('%s never turns subscription warranty into usage warranty', membershipKind => {
  const tags = [{ name: 'subscription_warranty', value: '质保（期限未注明）' }];
  const view = render(<OfferFacts tags={tags} membershipKind={membershipKind} />);
  expect(screen.queryByLabelText('商品标签')).not.toBeInTheDocument();
  view.rerender(<OfferFacts tags={[...tags, { name: 'usage_warranty', value: '首登' }]} membershipKind={membershipKind} />);
  expect(screen.getByLabelText('商品标签')).toHaveTextContent(/^首登$/);
});

test.each(['rental', 'short_term', null, undefined])('%s retains both warranties without inferring kind from the name', membershipKind => {
  const facts = offerConditions({ name: '成品号 代充', membershipKind, tags: [
    { name: 'subscription_warranty', value: '质保 30 天' }, { name: 'usage_warranty', value: '质保 7 天' },
  ] });
  expect(facts.map(fact => fact.name)).toEqual(['subscription_warranty', 'usage_warranty']);
});

test.each([30, 90, 365, 360, 31, 0.5, { kind: 'range', min: 30, max: 90 }, { kind: 'min', days: 30 }, { kind: 'permanent' }])('typed duration %j renders safely in details', value => {
  render(<OfferTagDetails offer={{ ...offer, tags: [{ name: 'duration', value }] }} item={{}} onClose={() => {}} />);
  expect(screen.getByRole('heading', { name: '使用期限' })).toBeInTheDocument();
  expect(screen.getByRole('dialog')).not.toHaveTextContent('[object Object]');
});

test('network advice in an ordinary account specification never creates a product region', () => {
  render(<OfferTagDetails offer={{ name: '普通账号', spec: '建议使用美区IP；禁止改密', tags: [] }} item={{}} onClose={() => {}} />);
  const dialog = screen.getByRole('dialog');
  expect(dialog).toHaveTextContent('建议使用美区IP；禁止改密');
  expect(within(dialog).queryByRole('heading', { name: '地区' })).not.toBeInTheDocument();
});
test('an IP product with an explicit region shows the region without a payment prefix', () => {
  render(<OfferTagDetails offer={{ name: '美区 IP 商品', tags: [{ name: 'region', value: 'us' }] }} item={{}} onClose={() => {}} />);
  expect(within(screen.getByRole('dialog')).getByText('美区', { exact: true })).toBeInTheDocument();
  expect(screen.getByRole('dialog')).not.toHaveTextContent('付款');
});
