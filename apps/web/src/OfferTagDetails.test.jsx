import React from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import OfferTagDetails, { offerConditions } from './OfferTagDetails.jsx';

afterEach(() => window.history.replaceState({}, '', '/'));

const offer = { productId: '9', shop: '甲店', name: '商品甲', spec: '月付规格', settlementQuantity: 5, tags: [
  { name: 'access', value: 'shared' }, { name: 'delivery', value: 'top_up' },
  { name: 'delivery', value: 'top_up' }, { name: 'usage_restriction', value: '禁止改密' },
  { name: 'minimum_quantity', value: '10' }, { name: 'duration', value: '30d' },
] };
test('conditions are canonical, prioritized, deduplicated and retain actual minimum quantity', () => {
  const conditions = offerConditions(offer);
  expect(conditions.slice(0, 3).map(fact => fact.name)).toEqual(['minimum_quantity', 'usage_restriction', 'delivery']);
  expect(conditions.filter(fact => fact.name === 'delivery')).toHaveLength(1);
  expect(conditions.find(fact => fact.name === 'minimum_quantity').value).toBe('5件起购');
});
test('details bind the exact merchant SKU, show only known conditions and preserve nested focus', () => {
  const opener = document.createElement('button'); document.body.append(opener); opener.focus();
  const close = vi.fn(); const report = vi.fn();
  const view = render(<OfferTagDetails offer={offer} item={{ name: '标准商品' }} onClose={close} onReport={report} />);
  const dialog = screen.getByRole('dialog', { name: offer.name });
  expect(within(dialog).getByRole('heading', { name: offer.name })).toHaveAttribute('id', 'offer-tag-details-title');
  expect(within(dialog).getByRole('region', { name: '商品条件' })).toHaveAttribute('tabindex', '0');
  expect(within(dialog).getByRole('banner')).toContainElement(within(dialog).getByText('甲店 · 月付规格'));
  expect(within(dialog).getByRole('region', { name: '商品条件' })).not.toHaveTextContent('甲店');
  for (const group of ['购买内容', '使用方式', '使用前提', '期限额度']) expect(within(dialog).getByRole('heading', { name: group })).toBeInTheDocument();
  for (const group of ['售后保障', '其他条件']) expect(within(dialog).queryByRole('heading', { name: group })).not.toBeInTheDocument();
  expect(dialog).toHaveTextContent('代充');
  expect(dialog).toHaveTextContent('5件起购');
  expect(dialog).not.toHaveTextContent(/尚未确认|请向商家核实|区分成品账号|新手指南|了解购买内容/);
  expect(within(dialog).queryByRole('link')).not.toBeInTheDocument();
  const first = within(dialog).getByRole('button', { name: '关闭商品说明' });
  const last = within(dialog).getByRole('button', { name: '确认', exact: true });
  last.focus(); fireEvent.keyDown(dialog, { key: 'Tab' }); expect(first).toHaveFocus();
  fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true }); expect(last).toHaveFocus();
  fireEvent.click(within(dialog).getByRole('button', { name: '举报此报价' })); expect(report).toHaveBeenCalledWith(offer);
  fireEvent.click(last); expect(close).toHaveBeenCalledOnce();
  fireEvent.keyDown(dialog, { key: 'Escape' }); expect(close).toHaveBeenCalledTimes(2);
  view.unmount(); expect(opener).toHaveFocus(); opener.remove();
});

test('condition formatting localizes canonical periods and renewal timing without merging equal field values', () => {
  const facts = offerConditions({ tags: [
    { name: 'single_use', value: '有' }, { name: 'renewable', value: '有' }, { name: 'sms_required', value: '有' },
    { name: 'renewal_timing', value: 'after_expiry' }, { name: 'account_age', value: '1 year' },
    { name: 'token_validity', value: '2-3 months' }, { name: 'duration', value: '1 year' },
  ] });
  expect(facts).toHaveLength(7);
  expect(offerConditions({ tags: [{ name: 'renewal_timing', value: 'any_time' }] })[0].value).toBe('随时续费');
  expect(facts.find(fact => fact.name === 'renewal_timing').value).toBe('到期后续费');
  expect(facts.find(fact => fact.name === 'account_age').value).toBe('1年');
  expect(facts.find(fact => fact.name === 'token_validity').value).toBe('2-3个月');
  expect(facts.find(fact => fact.name === 'duration').value).toBe('1年');
});

test('partial conditions retain known values without merchant links', () => {
  render(<OfferTagDetails offer={{ ...offer, spec: '', settlementQuantity: 10, productUrl: 'https://example.com/buy', tags: [{ name: 'delivery_format', value: 'credentials' }] }} item={{ name: '标准商品' }} onClose={() => {}} onReport={() => {}} />);
  const dialog = screen.getByRole('dialog', { name: offer.name });
  expect(dialog).toHaveTextContent('账密');
  expect(dialog).toHaveTextContent('10件起购');
  expect(dialog).not.toHaveTextContent(/尚未确认|请向商家核实|商家实际提供|下单要求/);
  expect(within(dialog).queryByRole('link')).not.toBeInTheDocument();
});

test('localizes delivery, login, regional and warranty values in details', () => {
  render(<OfferTagDetails offer={{ ...offer, tags: [
    { name: 'delivery_mode', value: 'automatic' }, { name: 'login_method', value: 'email_code' },
    { name: 'region_options', value: 'eg' }, { name: 'recommended_ip_region', value: 'global' },
    { name: 'warranty_trigger', value: 'first_login' }, { name: 'warranty_exclusion', value: 'ban' },
    { name: 'warranty_detail', value: 'subscription coverage' },
  ] }} item={{ name: '标准商品' }} onClose={() => {}} onReport={() => {}} />);
  const dialog = screen.getByRole('dialog', { name: offer.name });
  for (const text of ['自动发货', '邮箱验证码登录', '可选埃及', '建议全球网络', '首登起保', '不保封号', '订阅保障']) expect(dialog).toHaveTextContent(text);
  expect(dialog).not.toHaveTextContent(/automatic|email_code|first_login|subscription coverage/);
});

test('offers without known conditions show one concise empty state', () => {
  render(<OfferTagDetails offer={{ shop: '甲店', tags: [{ name: 'access', value: 'unknown' }] }} item={{ name: '标准商品' }} onClose={() => {}} onReport={() => {}} />);
  const dialog = screen.getByRole('dialog', { name: '标准商品' });
  expect(within(dialog).getByRole('heading', { name: '标准商品' })).toBeInTheDocument();
  expect(within(dialog).getByText('暂无商品条件信息')).toBeInTheDocument();
  expect(within(dialog).getAllByRole('heading')).toHaveLength(1);
  expect(dialog).not.toHaveTextContent(/尚未确认|请向商家核实/);
});
