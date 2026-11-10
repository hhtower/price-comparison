import React from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import OfferTagDetails, { OfferFacts, offerConditions } from './OfferTagDetails.jsx';

afterEach(() => window.history.replaceState({}, '', '/'));

const offer = { productId: '9', shop: '甲店', name: '商品甲', spec: '月付规格', settlementQuantity: 5, tags: [
  { name: 'access', value: 'shared' }, { name: 'delivery', value: 'top_up' },
  { name: 'delivery', value: 'top_up' }, { name: 'usage_restriction', value: '禁止改密' },
  { name: 'minimum_quantity', value: '10' }, { name: 'duration', value: '30d' },
] };

test.each([['有', '租号'], ['无', '非租号'], [undefined, null]])('rental %s remains explicit in chips and details while no warranty stays hidden', (value, label) => {
  const tags = [{ name: 'warranty', value: 'none' }, ...(value ? [{ name: 'rental', value }] : [])];
  render(<><OfferFacts tags={tags} /><OfferTagDetails offer={{ ...offer, settlementQuantity: 1, tags }} item={{ name: '标准商品' }} onClose={() => {}} /></>);
  if (label) expect(screen.getAllByText(label, { exact: true })).toHaveLength(2);
  else expect(screen.queryByText(/租号/)).not.toBeInTheDocument();
  expect(screen.queryByText('无质保')).not.toBeInTheDocument();
});

test.each([['access', 'uncertain', '共享情况不确定'], ['rental', '不确定', '租用情况不确定']])('explicit %s uncertainty is readable in chips and details', (name, value, label) => {
  const tags = [{ name, value }];
  render(<><OfferFacts tags={tags} /><OfferTagDetails offer={{ ...offer, settlementQuantity: 1, tags }} item={{ name: '标准商品' }} onClose={() => {}} /></>);
  expect(within(screen.getByRole('group', { name: '商品标签' })).getByText(label, { exact: true })).toBeInTheDocument();
  expect(within(screen.getByRole('dialog')).getByText(label, { exact: true })).toBeInTheDocument();
  expect(screen.queryByText('uncertain', { exact: true })).not.toBeInTheDocument();
});

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
  expect(within(dialog).getByRole('banner')).toContainElement(within(dialog).getByText('店铺：甲店 · 月付规格'));
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
  for (const text of ['自动发货', '邮箱验证码登录', '可选埃及', '建议全球网络', '首登起保', '不保封号', '保订阅']) expect(dialog).toHaveTextContent(text);
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

test.each([['45 days', false], ['30 days', true]])('only merges an equivalent warranty window: %s', (window, separate) => {
  render(<OfferTagDetails offer={{ ...offer, tags: [
    { name: 'warranty_days', value: '45' }, { name: 'warranty_window', value: window },
    { name: 'warranty_terms', value: '封号退款，二次验证不换号' },
  ] }} item={{ name: '标准商品' }} onClose={() => {}} />);
  const dialog = screen.getByRole('dialog');
  expect(dialog).toHaveTextContent('质保45天');
  expect(dialog.textContent.includes('保障窗口')).toBe(separate);
  expect(dialog).toHaveTextContent('封号退款,二次验证不换号');
});

test.each(['none', 'unknown', 'covered'])('omits %s warranty states in chips and details while retaining sale terms', state => {
  const tags = [{ name: 'warranty', value: state }, { name: 'warranty_terms', value: '二次验证不换号' }];
  const view = render(<OfferFacts tags={tags} />);
  expect(view.container.querySelector('.offer-warranty')).toBeNull();
  view.unmount();
  render(<OfferTagDetails offer={{ ...offer, tags }} item={{ name: '标准商品' }} onClose={() => {}} />);
  const dialog = screen.getByRole('dialog');
  expect(dialog).not.toHaveTextContent(/有质保|无质保|未说明|未注明/);
  expect(dialog).toHaveTextContent('二次验证不换号');
});

test.each([
  [[{ name: 'warranty_days', value: '30' }, { name: 'warranty_scope', value: 'period' }], '质保30天'],
  [[{ name: 'warranty_scope', value: 'subscription' }, { name: 'warranty_detail', value: 'subscription coverage' }], '保订阅'],
  [[{ name: 'warranty_scope', value: 'subscription' }, { name: 'warranty_days', value: '30' }], '保订阅30天'],
  [[{ name: 'warranty_scope', value: 'first_login' }, { name: 'warranty_window', value: '24 hours' }], '仅保首登'],
])('uses one concise warranty promise and keeps limitations in details: %s', (coverage, label) => {
  const tags = [{ name: 'warranty', value: 'covered' }, ...coverage,
    { name: 'warranty_trigger', value: 'purchase' }, { name: 'warranty_exclusion', value: 'ban' },
    { name: 'warranty_terms', value: '修改2fa不售后' }];
  const view = render(<OfferFacts tags={tags} />);
  expect(view.container.querySelector('.offer-warranty')).toHaveTextContent(label);
  expect(view.container.querySelector('.offer-warranty').textContent).toBe(label);
  expect(view.container).not.toHaveTextContent(/购买起保|不保封号|售后条款|小时|有质保/);
  view.unmount();
  render(<OfferTagDetails offer={{ ...offer, tags }} item={{ name: '标准商品' }} onClose={() => {}} />);
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getAllByText(label, { exact: true })).toHaveLength(1);
  expect(dialog).not.toHaveTextContent(/有质保|无质保|未说明|未注明|按质保时长/);
  for (const text of ['购买起保', '不保封号', '修改2fa不售后']) expect(dialog).toHaveTextContent(text);
  if (label === '仅保首登') expect(dialog).toHaveTextContent('保障窗口24小时');
});
