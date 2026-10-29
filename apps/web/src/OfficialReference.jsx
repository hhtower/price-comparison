import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import ModalDialog from './components/ModalDialog.jsx';
import { trackUsage } from './analytics.js';
import './official-reference.css';

const referenceFlags = import.meta.glob('./assets/reference-flags/*.svg', { eager: true, query: '?url', import: 'default' });

async function readCatalog(signal) {
  const response = await fetch('/api/official-reference/catalog', {
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), credentials: 'omit',
  });
  if (!response.ok) throw new Error('参考价暂时无法读取');
  const catalog = await response.json();
  if (!Array.isArray(catalog?.apps) || !catalog.apps.every(app =>
    app && Array.isArray(app.plans) && app.plans.every(plan => plan && Array.isArray(plan.prices)))) {
    throw new Error('Invalid reference catalog');
  }
  return {
    ...catalog,
    apps: catalog.apps.map(app => ({ ...app, plans: app.plans.filter(plan => plan.kind !== 'app') }))
      .filter(app => app.plans.some(plan => plan.prices.length > 0)),
  };
}

function defaultPlan(app) {
  return app?.plans.find(plan => plan.kind === 'subscription' && plan.prices.length)
    || app?.plans.find(plan => plan.prices.length)
    || app?.plans[0];
}

function formatPeriod(period) {
  const match = /^P([1-9][0-9]*)([DWMY])$/.exec(period);
  if (!match) return period;
  const [, count, unit] = match;
  const units = { D: ['天', '天'], W: ['周', '周'], M: ['月', '个月'], Y: ['年', '年'] };
  return count === '1' ? '每' + units[unit][0] : '每' + count + units[unit][1];
}

function formatPlanName(plan) {
  // Structured billing periods take precedence over stale or localized name suffixes.
  const suffix = /(?:\s*[-–—·]\s*|\s+)(?:monthly|annual|yearly|mensal|按月付费|按年付费)(\s+#\d+)?\s*$/i;
  return plan.kind === 'subscription' && /^P[1-9][0-9]*[DWMY]$/.test(plan.period)
    ? plan.name.replace(suffix, '$1').trim() || plan.name
    : plan.name;
}

function formatPlanLabel(plan) {
  return formatPlanName(plan) + (plan.period ? ' · ' + formatPeriod(plan.period) : '');
}

function PriceCard({ price, minimum }) {
  const converted = Number.isFinite(price.cnyAmount);
  const lowest = converted && !price.stale && price.cnyAmount === minimum;
  const flag = referenceFlags['./assets/reference-flags/' + price.country.toLowerCase() + '.svg'];
  return <article className={'reference-price-card' + (lowest ? ' reference-price-card-lowest' : '')}
    aria-label={price.countryName + '官方价格'}>
    <div className="reference-card-badges">
      {lowest && <span className="reference-lowest">最低</span>}
      {price.stale && <span className="reference-stale">待更新</span>}
    </div>
    <div className="reference-country">{flag
      ? <img className="reference-flag" src={flag} width="30" height="22" alt="" aria-hidden="true" />
      : <span className="reference-flag" aria-hidden="true">{price.country.toUpperCase()}</span>}<span>{price.countryName}</span></div>
    <div className="reference-cny-price">{converted
      ? <><span className="reference-currency" aria-label="人民币">¥</span><strong>{price.cnyAmount.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></>
      : <span className="reference-no-rate">暂无折算</span>}</div>
    <div className="reference-original-price"><span>{price.formatted}</span><small>{price.currency}</small></div>
  </article>;
}

function groupPlans(plans) {
  const groups = new Map();
  for (const plan of plans) {
    const key = plan.kind === 'subscription' ? plan.period || 'unspecified' : 'purchase';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(plan);
  }
  const rank = key => key === 'P1M' ? 0 : key === 'P1Y' ? 1 : key === 'unspecified' ? 3 : key === 'purchase' ? 4 : 2;
  const labels = { P1M: '月付', P1Y: '年付', unspecified: '周期未注明', purchase: '一次性购买' };
  return [...groups].sort(([a], [b]) => rank(a) - rank(b)).map(([key, items]) => ({ key, label: labels[key] || formatPeriod(key), items }));
}

function PlanPicker({ app, plan, onSelect, expanded, onExpandedChange }) {
  const root = useRef(null);
  const trigger = useRef(null);
  const selected = useRef(null);
  useLayoutEffect(() => {
    if (expanded) {
      selected.current?.focus({ preventScroll: true });
      selected.current?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [expanded, plan.id]);
  useEffect(() => {
    if (!expanded) return undefined;
    function dismissOutside(event) {
      // iOS/WebKit 在触摸后把焦点停在 dialog 或 body 上，不是用户移动焦点，不能据此收起
      if (event.type === 'focusin' && (event.target === root.current?.closest('dialog') || event.target === document.body)) return;
      if (!root.current?.contains(event.target)) onExpandedChange(false);
    }
    function dismissEscape(event) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onExpandedChange(false);
      trigger.current?.focus({ preventScroll: true });
    }
    document.addEventListener('pointerdown', dismissOutside);
    document.addEventListener('focusin', dismissOutside);
    document.addEventListener('keydown', dismissEscape, true);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside);
      document.removeEventListener('focusin', dismissOutside);
      document.removeEventListener('keydown', dismissEscape, true);
    };
  }, [expanded, onExpandedChange]);
  function choose(id) {
    onSelect(id);
    onExpandedChange(false);
    trigger.current?.focus({ preventScroll: true });
  }
  return <div ref={root} className={'reference-plan-picker' + (expanded ? ' is-expanded' : '')}>
    <button ref={trigger} type="button" className="reference-plan-toggle" aria-label={'切换套餐，当前：' + formatPlanLabel(plan)}
      aria-expanded={expanded} aria-controls="reference-plan-options" onClick={() => {
        onExpandedChange(!expanded);
        if (!expanded) trackUsage('reference_plans_open', { appId: app.id });
      }}>
      <span className="reference-current-plan">{formatPlanLabel(plan)}</span>
      <span className="reference-plan-toggle-action">{expanded ? '收起' : '全部套餐 ' + app.plans.length}<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
    </button>
    {expanded && <div id="reference-plan-options" className="reference-plan-options" role="region" aria-label={app.name + '全部套餐'}>
      {groupPlans(app.plans).map((group, index) => <div className="reference-plan-group" role="group" key={group.key} aria-labelledby={'reference-plan-group-' + index}>
        <h3 id={'reference-plan-group-' + index}>{group.label}<span aria-hidden="true">{group.items.length}</span></h3>
        <div className="reference-plan-choices">{group.items.map(item => <button type="button" key={item.id}
          ref={item.id === plan.id ? selected : undefined} aria-label={formatPlanLabel(item)} aria-pressed={item.id === plan.id} onClick={() => choose(item.id)}>
          <span>{formatPlanName(item)}</span>{item.id === plan.id && <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="m3 8 3 3 7-7" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>}
        </button>)}</div>
      </div>)}
    </div>}
  </div>;
}

function PlanPrices({ app, plan, onSelect }) {
  const tabs = useRef([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [countryQuery, setCountryQuery] = useState('');
  const usePicker = app.plans.length > 6;
  const query = countryQuery.trim().toLowerCase();
  const prices = plan.prices.filter(price => price.countryName.toLowerCase().includes(query) || price.country.toLowerCase().includes(query));
  const commonCountries = ['cn', 'hk', 'tw', 'us', 'jp', 'sg'].map(country => plan.prices.find(price => price.country.toLowerCase() === country)).filter(Boolean);
  const freshPrices = plan.prices.filter(price => !price.stale && Number.isFinite(price.cnyAmount));
  const minimum = freshPrices.length ? Math.min(...freshPrices.map(price => price.cnyAmount)) : null;
  function moveTab(event, index) {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % app.plans.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + app.plans.length) % app.plans.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = app.plans.length - 1;
    else return;
    event.preventDefault();
    onSelect(app.plans[next].id);
    tabs.current[next]?.focus();
  }
  return <section className="reference-comparison">
    {usePicker ? <PlanPicker app={app} plan={plan} onSelect={onSelect} expanded={pickerOpen} onExpandedChange={setPickerOpen} />
      : <div className="reference-plan-tabs" role="tablist" aria-label={app.name + '套餐'}>
      {app.plans.map((item, index) => <button key={item.id} ref={node => { tabs.current[index] = node; }} type="button" role="tab"
        id={'reference-tab-' + app.id + '-' + item.id} aria-controls="reference-price-panel" aria-selected={plan.id === item.id}
        tabIndex={plan.id === item.id ? 0 : -1} onClick={() => onSelect(item.id)} onKeyDown={event => moveTab(event, index)}>{formatPlanLabel(item)}</button>)}
    </div>}
    {!pickerOpen && plan.prices.length > 0 && <div className="reference-country-filters">
      <input type="search" aria-label="搜索国家或地区" placeholder="搜索国家 / 地区" value={countryQuery} onChange={event => setCountryQuery(event.target.value)} />
      <div className="reference-country-shortcuts" role="group" aria-label="常用地区">
        <button type="button" aria-pressed={!query} onClick={() => setCountryQuery('')}>全部</button>
        {commonCountries.map(price => <button type="button" key={price.country} aria-pressed={query === price.country.toLowerCase()}
          onClick={() => setCountryQuery(price.country)}>{price.countryName}</button>)}
      </div>
      <span className="reference-country-count" role="status">{prices.length} / {plan.prices.length} 个地区</span>
      {countryQuery && <button type="button" className="reference-filter-clear" onClick={() => setCountryQuery('')}>清除筛选</button>}
    </div>}
    <div key={plan.id + ':' + query} id="reference-price-panel" className="reference-price-panel" hidden={pickerOpen}
      role={usePicker ? 'region' : 'tabpanel'} tabIndex={0} aria-label={usePicker ? formatPlanLabel(plan) : undefined}
      aria-labelledby={usePicker ? undefined : 'reference-tab-' + app.id + '-' + plan.id}>
      {prices.length > 0
        ? <div className="reference-price-grid">{prices.map(price => <PriceCard key={price.country} price={price} minimum={minimum} />)}</div>
        : <div className="reference-empty"><p>{plan.prices.length ? '没有匹配的国家或地区' : '该套餐暂无已采集价格'}</p></div>}
    </div>
  </section>;
}

function ReferencePanel({ catalog, setCatalog, selection, setSelection }) {
  const [state, setState] = useState(catalog ? 'ready' : 'loading');
  const [reload, setReload] = useState(!catalog);
  useEffect(() => {
    if (!reload) return undefined;
    const controller = new AbortController();
    setState('loading');
    readCatalog(controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setCatalog(result);
      setSelection(previous => {
        const app = result.apps.find(item => item.id === previous.appId) || result.apps[0];
        const plan = app?.plans.find(item => item.id === previous.planId) || defaultPlan(app);
        return { appId: app?.id, planId: plan?.id };
      });
      setState('ready');
      setReload(false);
    }).catch(() => { if (!controller.signal.aborted) { setState('error'); setReload(false); } });
    return () => controller.abort();
  }, [reload, setCatalog, setSelection]);

  if (state === 'loading') return <div className="reference-body reference-state" role="status"><span className="reference-loading-mark" aria-hidden="true" /><p>正在读取已采集价格…</p></div>;
  if (state === 'error') return <div className="reference-body reference-state"><p role="alert">参考价暂时无法读取，请稍后重试。</p><button type="button" className="reference-retry" onClick={() => setReload(true)}>重试</button></div>;

  const app = catalog.apps.find(item => item.id === selection.appId);
  const plan = app?.plans.find(item => item.id === selection.planId);
  function selectProduct(item) {
    if (item.id === selection.appId) return;
    setSelection({ appId: item.id, planId: defaultPlan(item)?.id });
    trackUsage('reference_product', { appId: item.id });
  }
  function selectPlan(planId) {
    if (planId === selection.planId) return;
    setSelection({ ...selection, planId });
    trackUsage('reference_plan_select', { appId: app.id, planId });
  }
  return <div className="reference-body">
    {catalog.apps.length > 0 ? <>
      <div className="reference-products" role="group" aria-label="选择产品">{catalog.apps.map(item => <button type="button" key={item.id}
        aria-pressed={app?.id === item.id} onClick={() => selectProduct(item)}>{item.name}</button>)}</div>
      {plan ? <PlanPrices key={app.id} app={app} plan={plan} onSelect={selectPlan} />
        : <div className="reference-empty"><p>该产品暂无已采集价格</p><span>价格采集完成后会自动显示。</span></div>}
    </> : <div className="reference-empty"><p>暂无已采集价格</p><span>价格采集完成后会自动显示。</span></div>}
    <footer className="reference-footnote">
      <p>{catalog.updatedAt && <span>更新于 <time dateTime={catalog.updatedAt}>{new Date(catalog.updatedAt).toLocaleString('zh-CN', { hour12: false })}</time></span>}
        {catalog.updatedAt && catalog.exchangeDate && ' · '}{catalog.exchangeDate && <span>汇率日期 {catalog.exchangeDate}</span>}</p>
      <button type="button" className="reference-refresh" aria-label="刷新参考价" onClick={() => setReload(true)}>刷新</button>
    </footer>
  </div>;
}

export default function OfficialReference() {
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState(null);
  const [selection, setSelection] = useState({ appId: null, planId: null });
  const trigger = useRef(null);
  function close() { setOpen(false); trigger.current?.focus(); }
  useEffect(() => {
    if (!open) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [open]);
  return <>
    <button type="button" ref={trigger} className="official-reference-trigger" aria-label="官网正价参考" title="官网正价参考" aria-haspopup="dialog" aria-expanded={open} aria-controls="official-reference-dialog" onClick={() => {
      if (!open) { setOpen(true); trackUsage('reference_open'); }
    }}><span aria-hidden="true">官网<br />正价参考</span></button>
    <ModalDialog id="official-reference-dialog" className="official-reference-dialog" open={open} onClose={close} aria-labelledby="official-reference-title">
      <header className="reference-dialog-header"><div><h2 id="official-reference-title">官网正价参考</h2><p>选套餐，比较各地区官方价</p></div><button type="button" className="reference-close" aria-label="关闭官网正价参考" onClick={close}>×</button></header>
      {open && <ReferencePanel catalog={catalog} setCatalog={setCatalog} selection={selection} setSelection={setSelection} />}
    </ModalDialog>
  </>;
}
