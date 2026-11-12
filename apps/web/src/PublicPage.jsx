import OfferTagDetails, { OfferFacts } from './OfferTagDetails.jsx';
import ModalDialog from './components/ModalDialog.jsx';
import PurchaseGuide, { PurchaseGuideLink } from './PurchaseGuide.jsx';
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Virtuoso } from 'react-virtuoso';
import Brand, { logoUrl } from './Brand.jsx';
import CommunityDialog from './CommunityDialog.jsx';
import { usePageAnalytics } from './usePageAnalytics.js';
import { trackUsage } from './analytics.js';
import { keepPreviousData, QueryClient, QueryClientProvider, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { CATALOG_PLATFORMS, groupCatalogPlatforms, normalizeCatalogPlatform } from '@price-comparison/catalog/platform-groups';
import { consumeRapidSearchTerms, normalizePurchaseTag, parseCatalogSearch, purchaseWarrantyLabel, PURCHASE_ATTRIBUTE_DEFINITIONS } from '@price-comparison/catalog/purchase-attributes';
import { DurationFilterOptions, WarrantyFilter, isValidWarrantyMinimum } from './components/PurchasePeriodFilters.jsx';
import { standardProductDisplayName } from '@price-comparison/catalog/catalog-display';
import { MEMBERSHIP_GROUPS, membershipKindLabel } from '@price-comparison/catalog/membership-policy';
import { updatePageMetadata } from './page-metadata.js';
import { PRODUCT_PAGE_SIZE, catalogPageMetadata, productPagePath, publicPageNumber } from '../../api/src/seo/page-metadata.ts';
import { formatMoney } from './money.js';
import PriceHistory from './PriceHistory.jsx';
import { CatalogSeoIntro, CatalogSeoFaq } from './CatalogSeoContent.jsx';
import { displayPurchaseTagText, displayPurchaseTagValue } from './purchase-tag-values.js';

const OFFER_PAGE_SIZE = 4;
const QUERY_DEBOUNCE_MS = 240;
async function fetchCatalog(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw Object.assign(new Error('catalog failed'), { status: response.status });
  return response.json();
}
const EMPTY_LIST = [];
const NOOP = () => {};
const CATALOG_OVERSCAN = { top: 300, bottom: 500 };
const catalogItemKey = (_index, item) => item.key || item.id;
const BROWSING_MODE_KEY = 'catalog-browsing-mode';
const membershipWords = /成品号|代充|租号(?:\s*[（(]\s*(?:共享|合租)\s*[）)])?|共享|合租|短期/gu;
const membershipNegation = new RegExp(`(?:不(?:要|需要|想要?|接受|支持|提供|适合|能|是)?|没有|未明确|未说明|无需|禁止|非|是否|可能|或许|不确定)\\s*(?:是|为)?\\s*(?:${membershipWords.source})|(?:${membershipWords.source})\\s*(?:状态)?\\s*(?:不(?:要|支持|提供|可用|确定|保证)|未说明|未知)`, 'u');
const membershipFilterLabel = kind => kind === 'rental' ? '租号（共享）' : membershipKindLabel(kind);

function membershipSearch(query, enabled) {
  const kinds = new Set();
  const text = enabled && !membershipNegation.test(query) ? query.replace(membershipWords, word => {
    kinds.add(/^(?:租号|共享|合租)/u.test(word) ? 'rental' : MEMBERSHIP_GROUPS.find(kind => membershipKindLabel(kind) === word));
    return ' ';
  }).replace(/\s+/gu, ' ').trim() : query;
  return { text, kinds: MEMBERSHIP_GROUPS.filter(kind => kinds.has(kind)) };
}

function matchingProducts(products, query, platform) {
  const words = parseCatalogSearch(membershipSearch(query, true).text).text.toLowerCase().split(/\s+/u).filter(Boolean);
  return products.filter(item => (platform === '全部' || normalizeCatalogPlatform(item.platform || '') === platform)
    && words.every(word => formatStandardName(item.name).toLowerCase().includes(word)));
}

function MembershipFilter({ value, onChange }) {
  return <fieldset className="filter-group"><legend>AI会员类型</legend><div className="filter-group-content"><div className="filter-options">
    {MEMBERSHIP_GROUPS.map(kind => <label key={kind} className={value.includes(kind) ? 'is-selected' : ''}>
      <input type="checkbox" aria-label={membershipFilterLabel(kind)} checked={value.includes(kind)}
        onChange={() => onChange(MEMBERSHIP_GROUPS.filter(candidate => candidate === kind ? !value.includes(candidate) : value.includes(candidate)))} />
      <span>{membershipFilterLabel(kind)}</span>
    </label>)}
  </div></div></fieldset>;
}

function membershipName(item, kind = '') {
  const name = formatStandardName(item.name);
  const label = MEMBERSHIP_GROUPS.includes(kind) ? membershipKindLabel(kind) : '';
  return label ? `${name} · ${label}` : name;
}

function readBrowsingMode() {
  try {
    const mode = localStorage.getItem(BROWSING_MODE_KEY);
    return ['newcomer', 'browse'].includes(mode) ? mode : null;
  } catch { return null; }
}

function CatalogCoverage({ data }) {
  if (!data || ![data.shopCount, data.productCount].every(count => Number.isSafeInteger(count) && count >= 0)) return null;
  const shops = data.shopCount.toLocaleString('zh-CN');
  const products = data.productCount >= 10000 ? `${Math.floor(data.productCount / 1000) / 10}万` : data.productCount.toLocaleString('zh-CN');
  return <p className="catalog-coverage"><span>收录</span><span><strong>{shops}</strong> 家商铺</span><span aria-hidden="true">·</span><span><strong>{products}</strong>条报价</span></p>;
}

function equalTags(left, right) { return left.size === right.size && [...left].every(tag => right.has(tag)); }

function catalogParams(search, platform, selectedTags, warrantyDaysMin, standardProductId = '', newcomer = false, membershipKinds = []) {
  const params = new URLSearchParams({ q: search, platform: platform === '全部' ? '' : platform });
  for (const tag of [...selectedTags].sort()) params.append('tag', tag);
  if (warrantyDaysMin) params.set('warrantyDaysMin', warrantyDaysMin);
  if (standardProductId) params.set('standardProductId', standardProductId);
  if (newcomer || membershipKinds.length) params.set('newcomer', String(newcomer && !membershipKinds.length));
  for (const kind of membershipKinds) params.append('membershipKind', kind);
  return params;
}

function readCatalogLocation(params = new URLSearchParams(window.location.search)) {
  const mode = readBrowsingMode();
  const explicitMode = ['true', 'false'].includes(params.get('newcomer'));
  const tags = params.getAll('tag').slice(0, 50).flatMap(value => {
    try {
      const tag = JSON.parse(value);
      return typeof tag?.name === 'string' && tag.name.length <= 80 && typeof tag.value === 'string' && tag.value.length <= 250
        ? normalizePurchaseTag(tag).map(tagKey) : [];
    } catch { return []; }
  });
  const minimum = params.get('warrantyDaysMin') || '';
  const warranty = isValidWarrantyMinimum(minimum) ? minimum : '';
  // Old bookmarks allowed multiple warranty types; restore one visible requirement.
  const warrantyType = tags.find(key => JSON.parse(key).name === 'warranty_scope')
    || tags.find(key => JSON.parse(key).name === 'warranty');
  const selectedTags = tags.filter(key => !['warranty', 'warranty_scope'].includes(JSON.parse(key).name)
    || !warranty && key === warrantyType);
  return { query: (params.get('q') || '').slice(0, 500), platform: normalizeCatalogPlatform(params.get('platform') || '') || '全部',
    sort: ['price', 'updated'].includes(params.get('sort')) ? params.get('sort') : 'default',
    tags: new Set(selectedTags), warranty, product: params.get('standardProductId') || '', cursor: params.get('cursor') || '',
    membershipKinds: MEMBERSHIP_GROUPS.filter(kind => params.getAll('membershipKind').includes(kind)),
    newcomer: explicitMode ? params.get('newcomer') === 'true'
      : params.has('cursor') ? false
        : typeof window.history.state?.catalogNewcomer === 'boolean' ? window.history.state.catalogNewcomer : mode === 'newcomer' };
}

function navigateProduct(event, href) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  trackUsage('product_detail');
  const catalogScroll = window.scrollY;
  const catalogUrl = window.location.pathname + window.location.search;
  window.history.replaceState({ ...window.history.state, catalogScroll }, '', catalogUrl);
  window.history.pushState({ catalogUrl, catalogScroll }, '', href);
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo(0, 0);
}

function returnToCatalog(event) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  if (window.history.state?.catalogUrl) window.history.back();
  else { window.history.pushState({}, '', '/'); window.dispatchEvent(new PopStateEvent('popstate')); window.scrollTo(0, 0); }
}

function currentInventory(offer) {
  return !offer.stale && offer.inStock !== false;
}

function availableOffer(offer) {
  return ['verified', 'expired', 'estimated'].includes(offer?.priceStatus) && !offer.stale && offer.inStock !== false && offer.price != null && Number.isFinite(Number(offer.price)) && Number(offer.price) >= 0;
}

function OfferPrice({ offer, className = '', starting = false }) {
  const available = availableOffer(offer);
  const amount = available ? formatMoney(offer.price, offer.currency) : '—';
  const listed = Number(offer?.listedPrice);
  const listedAmount = offer?.listedPrice != null && String(offer.listedPrice).trim() && Number.isFinite(listed) && listed >= 0
    ? formatMoney(listed, available ? '' : offer.currency) : '—';
  const estimated = offer?.priceStatus === 'estimated' || offer?.paymentMethod?.includes('预估');
  const hint = available ? [offer.paymentMethod,
    offer.priceVerifiedAt ? `核价于 ${new Date(offer.priceVerifiedAt).toLocaleString('zh-CN')}` : null].filter(Boolean).join(' · ') : undefined;
  return <span className={`offer-price ${className}${available ? '' : ' price-unavailable'}`} title={hint}>
    <span aria-label={available ? `结算价 ${amount}，${hint}` : '暂无报价'}>{amount}</span>
    {available && estimated ? <span className="offer-price-suffix price-estimate">预估</span> : null}
    {starting && available ? <span className="offer-price-suffix"> 起</span> : null}
    {!starting && offer ? <span className="offer-listed-price"><span className="offer-price-separator" aria-hidden="true"> / </span>标价 {listedAmount}</span> : null}
  </span>;
}

function useCatalogRefresh(_data, refresh, enabled = true) {
  const [revision, tick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const recheck = () => { tick(value => value + 1); refresh(); };
    const visible = () => { if (document.visibilityState === 'visible') recheck(); };
    document.addEventListener('visibilitychange', visible);
    return () => document.removeEventListener('visibilitychange', visible);
  }, [refresh, enabled]);
  return revision;
}

function useDebounced(value) {
  const [settled, setSettled] = useState(value);
  useEffect(() => { const timer = setTimeout(() => setSettled(value), QUERY_DEBOUNCE_MS); return () => clearTimeout(timer); }, [value]);
  return settled;
}

function FilterCount({ params, enabled, detail = false, current }) {
  const request = useDebounced(params);
  const preview = useQuery({ queryKey: ['filter-count', request], enabled: enabled && !current,
    queryFn: ({ signal }) => fetchCatalog('/api/catalog?' + request + '&limit=1', signal) });
  useCatalogRefresh(preview.data, preview.refetch, enabled && !current);
  const result = current || preview.data;
  return <span className="filter-count" role="status">{!current && (params !== request || preview.isFetching) ? '统计中…' : !current && preview.isError ? '数量暂不可用'
    : result ? detail ? `${result.offerTotal ?? 0} 条报价` : `${result.total ?? 0} 款 · ${result.offerTotal ?? 0} 条报价` : ''}</span>;
}

const TAG_LABELS = {
  '3ds': '3DS 支持', access: '访问方式', account_age: '账号年龄', account_lifecycle: '账号类型', account_state: '账号状态', account_type: '账号类型', authentication: '验证方式',
  card_bin: '卡段', card_network: '卡组织', card_type: '卡类型', category_signal: '适用类别', channel: '渠道', cloud_status: '云端状态',
  credential_included: '是否含凭据', credential_type: '凭据类型', delivery: '交付方式', delivery_format: '交付格式', duration: '时长', email_provider: '邮箱服务商',
  email_remaining_duration: '邮箱剩余时长', email_remaining_validity: '邮箱剩余有效期', email_type: '邮箱类型', feature_support: '功能支持', intended_use: '适用场景',
  inventory_status: '库存状态', mailbox_type: '邮箱类型', minimum_order_quantity: '起订量', number_change: '换号规则', platform: '平台', quantity: '数量', refund: '退款规则',
  region: '地区', registration_network: '注册网络', registration_year: '注册年份', reset_count: '重置次数', scan_included: '是否含扫码', service_method: '服务方式',
  service_type: '服务类型', sim_type: 'SIM 类型', sms_verification: '短信验证', storage: '存储空间', token_duration: '令牌时长', token_validity: '令牌有效期',
  two_factor_auth: '双重验证', two_factor_authentication: '双重验证', usage_restriction: '使用限制', validity: '有效期', warranty: '售后保障', warranty_days: '质保时长', warranty_scope: '质保范围',
};

const TAG_VALUE_LABELS = {
  dedicated: '专属', 'first login': '首登', 'long term': '长期', 'redemption link': '兑换链接', 'residential broadband': '家庭宽带',
  'single use': '单次', unverified: '未验证', verified: '已验证', us: '美国', usa: '美国', philippines: '菲律宾', vietnam: '越南', ios: 'iOS', web: '网页',
};

const PURCHASE_DISPLAY_VALUES = {
  region: { eu: '欧洲', global: '全球', random: '随机地区', sea: '东南亚' },
  intended_use: { rapid: '速刷' },
  account_lifecycle: { new: '新号', aged: '老号' },
  account_type: { sub_account: '子号', parent_account: '母号', seat: '席位', personal: '个人', enterprise: '企业' },
  warranty_scope: { first_login: '仅保首登', activation: '仅保激活', first_code: '仅保首次接码', subscription: '仅保掉订阅' },
};
const FILTER_DEFINITIONS = [
  ...PURCHASE_ATTRIBUTE_DEFINITIONS.map(definition => definition.name === 'warranty_scope'
    ? { ...definition, values: [...definition.values, { value: 'activation' }, { value: 'first_code' }, { value: 'subscription' }] } : definition),
  { name: 'account_lifecycle', label: '账号类型', values: Object.keys(PURCHASE_DISPLAY_VALUES.account_lifecycle).map(value => ({ value })) },
];
const LIMITED_WARRANTY_SCOPES = ['first_login', 'activation', 'first_code', 'subscription'];

const PLATFORM_LABELS = {
  anthropic: 'Anthropic', apple: 'Apple', email: '邮箱', google: 'Google',
  microsoft: 'Microsoft', openai: 'OpenAI', payment: '支付', platform: '平台', xai: 'xAI',
  ...Object.fromEntries(CATALOG_PLATFORMS.map(group => [group.id, group.label])), other: '其它',
};

const TAG_GROUPS = [
  ...['delivery', 'access', 'account_lifecycle', 'duration', 'warranty', 'sms_verification', 'intended_use']
    .map(name => {
      if (name === 'warranty') return { id: 'warranty_conditions', label: '质保要求', names: ['warranty', 'warranty_scope', 'warranty_days'] };
      const definition = FILTER_DEFINITIONS.find(item => item.name === name);
      return { id: name, label: definition.label, names: [name] };
    }),
  { id: 'other', label: '其他规格', names: [] },
];

function tagKey(tag) { return JSON.stringify({ name: tag.name, value: tag.value }); }

function displayTagName(name) {
  const raw = String(name || '').trim();
  if (!raw) return '规格';
  if (TAG_LABELS[raw]) return TAG_LABELS[raw];
  if (raw.includes(':')) return raw.split(':').at(-1) || raw;
  return raw.replace(/[_-]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function displayTagValue(value) {
  const raw = String(value ?? '').replace(/[_-]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  return TAG_VALUE_LABELS[raw.toLowerCase()] || raw;
}
function displayPlatform(value) {
  const raw = String(value || '').trim();
  return PLATFORM_LABELS[raw.toLowerCase()] || raw || '未分类';
}
function displayTag(tag) {
  return `${displayTagName(tag.name)}：${displayPurchaseValue(tag)}`;
}

function displayPurchaseValue(tag) {
  return PURCHASE_DISPLAY_VALUES[tag.name]?.[tag.value] ?? displayPurchaseTagValue(tag, value => displayTagValue(value.value));
}

function isReadableFilter(tag) {
  if (['unknown', 'unspecified'].includes(tag.value)) return false;
  const definition = FILTER_DEFINITIONS.find(item => item.name === tag.name);
  if (tag.name === 'duration') return /^[1-9][0-9]{0,3} (months?|days)$/u.test(tag.value);
  if (tag.name === 'warranty_days') return /^[1-9][0-9]{0,4}$/u.test(tag.value);
  if (definition) return definition.values.some(item => item.value === tag.value);
  // Merchant prose is available on each quote, but is not a verified filter.
  return false;
}

function searchIntentTags(query) {
  const parsed = parseCatalogSearch(query);
  const tags = parsed.tags.filter((tag) => !(parsed.warrantyDaysMin && (tag.name === 'warranty' || tag.name === 'warranty_scope' || tag.name === 'warranty_days')));
  if (parsed.warrantyDaysMin) tags.push({ name: 'warranty_days', value: String(parsed.warrantyDaysMin) });
  return tags;
}

function removeSearchIntent(query, tag) {
  if (tag.name === 'intended_use') return consumeRapidSearchTerms(query).replace(/[ \t]{2,}/gu, ' ').trim();
  const expressions = {
    sms_verification: { verified: /已接码|已接马|verified[ \t]+sms|sms[ \t]+verified/iu, unverified: /未接码|未接马|unverified[ \t]+sms|sms[ \t]+unverified/iu },
    warranty_days: /(?:质保|保修|warranty)[ \t]*(?:至少|不少于|不低于|>=)?[ \t]*[+-]?[0-9]+(?:[ \t]*-[ \t]*[0-9]+)?[ \t]*(?:天|days?)|[+-]?[0-9]+(?:[ \t]*-[ \t]*[0-9]+)?[ \t]*(?:天|days?)[ \t]*(?:质保|保修|warranty)/iu,
    warranty: /无质保|不质保|没有质保|有质保|covered[ \t]+warranty|warranty|质保/iu,
    warranty_scope: /质保首登|首登质保|首登|first[ -]?login(?:[ \t]+only|[ \t]+warranty)?/iu,
    access: /独享|独用|共享|合租|dedicated|shared/iu,
    delivery: /成品账号|成品帐号|现成账号|代充|充值|top[ -]?up|topup|兑换码|激活码|redemption/iu,
    duration: /[0-9]+[ \t]*(?:个月|月|months?|month)|月卡|monthly/iu,
  };
  const expression = expressions[tag.name];
  if (!expression) return query;
  const pattern = expression instanceof RegExp ? expression : expression[tag.value] || expression;
  return query.replace(pattern, ' ').replace(/[ \t]{2,}/gu, ' ').trim();
}

function formatRelativeTime(value) {
  if (!value) return '更新时间未知';
  const raw = String(value);
  const date = new Date(raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return '更新时间未知';
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return '刚刚更新';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前更新`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前更新`;
  if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)} 天前更新`;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} 更新`;
}

function formatStandardName(value) {
  return standardProductDisplayName(String(value || ''));
}

async function readApiError(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function uniqueTags(items) {
  const unique = new Map();
  for (const tag of items.flatMap(item => item || [])) {
    for (const normalized of normalizePurchaseTag(tag)) {
      const key = tagKey(normalized);
      const previous = unique.get(key);
      unique.set(key, { ...tag, ...normalized, priority: Math.max(Number(previous?.priority ?? 0), Number(tag.priority ?? 0)) });
    }
  }
  return [...unique.values()];
}

function groupTags(tags) {
  const groups = TAG_GROUPS.map((group) => ({ ...group, tags: [] }));
  for (const tag of tags) {
    const group = groups.find((candidate) => candidate.names.includes(tag.name)) || groups.find((candidate) => candidate.id === 'other');
    group.tags.push(tag);
  }
  return groups.filter((group) => group.tags.length);
}

function useDesktopFilters() {
  const query = '(min-width: 761px)';
  const [desktop, setDesktop] = useState(() => window.matchMedia?.(query).matches ?? true);
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return undefined;
    const update = event => setDesktop(event.matches);
    setDesktop(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return desktop;
}

function FilterPanel({ open, inline, covered, tags, loading, error, onRetry, draftTags, draftWarrantyDaysMin, draftProduct = '', onWarrantyChange, onToggle, onClear, onApply, onClose, preview, children, extraCount = 0, id = 'catalog-purchase-filters' }) {
  const [expandedGroups, setExpandedGroups] = useState(() => new Set());
  const dialogRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    setExpandedGroups(new Set());
    const previousFocus = document.activeElement;
    const panel = dialogRef.current;
    const toolbar = panel?.parentElement?.previousElementSibling;
    if (inline && toolbar?.matches('.catalog-sticky-header')) {
      // Native focus scrolling can put a long panel underneath the sticky toolbar.
      panel.focus({ preventScroll: true });
      const overlap = toolbar.getBoundingClientRect().bottom - panel.getBoundingClientRect().top;
      if (overlap > 0) window.scrollBy(0, -overlap);
    } else panel?.focus();
    return () => previousFocus?.focus();
  }, [open]);
  useEffect(() => {
    if (!open || inline || covered) return;
    if (!dialogRef.current?.contains(document.activeElement)) dialogRef.current?.focus();
  }, [open, inline, covered]);
  useEffect(() => {
    if (!open || inline) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, [open, inline]);
  if (!open) return null;
  const readableTags = uniqueTags([[...draftTags].map(tag => JSON.parse(tag)), tags]).filter(tag => isReadableFilter(tag) || draftTags.has(tagKey(tag)));
  const groups = groupTags(readableTags);
  if (draftWarrantyDaysMin && !groups.some(group => group.id === 'warranty_conditions')) groups.push({ id: 'warranty_conditions', label: '质保要求', tags: [] });
  const warrantyTags = groups.find(group => group.id === 'warranty_conditions')?.tags || [];
  const warrantyChoices = uniqueTags([[{ name: 'warranty_scope', value: 'period' }],
    warrantyTags.filter(tag => tag.name === 'warranty_scope' && LIMITED_WARRANTY_SCOPES.includes(tag.value))])
    .map(tag => ({ name: tag.name, key: tagKey(tag), label: tag.value === 'period' ? '按质保时长' : purchaseWarrantyLabel([tag]) }));
  const draftCount = draftTags.size + Number(Boolean(draftWarrantyDaysMin)) + Number(Boolean(draftProduct)) + extraCount;
  return (
    <div className={inline ? 'filter-panel-container' : 'filter-drawer-layer'} hidden={!inline && covered} aria-hidden={covered || undefined} inert={covered || undefined} onMouseDown={(event) => { if (!inline && event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} id={id} className={`filter-drawer ${inline ? 'filter-panel--inline' : ''}`} role={inline ? 'region' : 'dialog'} tabIndex={-1} aria-modal={inline || covered ? undefined : true} aria-label="筛选报价" onKeyDown={inline || covered ? undefined : trapDialogFocus}>
        <div className="filter-drawer-body">
          {children}
          {loading ? <p role="status">正在加载筛选条件…</p> : error ? <div role="alert"><p>{error}</p><button type="button" className="text-button" onClick={onRetry}>重试筛选</button></div> : groups.length ? groups.map((group) => {
            if (group.id === 'duration' || group.id === 'warranty_conditions') return <fieldset className="filter-group" key={group.id}>
              <legend>{group.label}</legend>
              <div className="filter-group-content">{group.id === 'duration'
                ? <DurationFilterOptions tags={group.tags} selectedTags={draftTags} onToggle={onToggle} />
                : <WarrantyFilter choices={warrantyChoices} selectedTags={draftTags} value={draftWarrantyDaysMin} onChange={onWarrantyChange} />}</div>
            </fieldset>;
            const ranked = [...group.tags].sort((a, b) => Number(a.value === 'unknown') - Number(b.value === 'unknown') || Number(b.priority ?? 0) - Number(a.priority ?? 0) || a.value.localeCompare(b.value, 'zh-CN', { numeric: true }));
            const expanded = expandedGroups.has(group.id);
            const visible = expanded ? ranked : ranked.filter((tag, index) => index < 6 || draftTags.has(tagKey(tag)));
            return (
            <fieldset className="filter-group" key={group.id}>
              <legend>{group.label}</legend>
              <div className="filter-group-content">
                <div className="filter-options">
                  {visible.map((tag) => {
                    const key = tagKey(tag);
                    return <label key={key} className={draftTags.has(key) ? 'is-selected' : ''}><input type="checkbox" aria-label={displayTag(tag)} checked={draftTags.has(key)} onChange={() => onToggle(key)} /><span>{displayPurchaseValue(tag)}</span></label>;
                  })}
                </div>
                {ranked.length > 6 ? <button type="button" className="filter-expand" aria-expanded={expanded} onClick={() => setExpandedGroups(current => { const next = new Set(current); if (next.has(group.id)) next.delete(group.id); else next.add(group.id); return next; })}>{expanded ? '收起' : `展开全部 ${ranked.length} 项`}</button> : null}
              </div>
            </fieldset>
            );
          }) : <p className="filter-empty">暂无明确的可选条件，可尝试搜索商品名称</p>}
        </div>
        <footer className="filter-drawer-footer"><button type="button" className="text-button" onClick={onClear}>清除全部</button>{preview}<div className="filter-drawer-actions">{inline ? null : <button type="button" className="text-button" aria-label="取消筛选" onClick={onClose}>取消</button>}<button type="button" className="primary-button" disabled={!isValidWarrantyMinimum(draftWarrantyDaysMin)} onClick={onApply}>应用筛选{draftCount ? `（${draftCount}）` : ''}</button></div></footer>
      </section>
    </div>
  );
}

function CatalogSkeleton() {
  return <div className="catalog-skeleton" aria-label="正在加载商品" role="status">{[1, 2].map((item) => <div className="skeleton-card" key={item}><span /><span /><span /><span /></div>)}</div>;
}

function trapDialogFocus(event) {
  if (event.key !== 'Tab') return;
  const candidates = [...event.currentTarget.querySelectorAll(':is(button, input, a[href], select):not(:disabled)')];
  const checkedGroups = new Set(candidates.filter(element => element.type === 'radio' && element.checked).map(element => element.name));
  const focusable = candidates.filter(element => element.type !== 'radio' || !element.name || element.checked || !checkedGroups.has(element.name));
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
}

const COMPARISON_FACTS = [['delivery', '交付'], ['region', '地区'], ['access', '使用'], ['account_lifecycle', '账号类型'], ['intended_use', '用途'], ['duration', '使用期限'], ['minimum_quantity', '起购数量'], ['warranty', '售后']];
function offerFact(offer, name) {
  if (name === 'minimum_quantity') return offer.settlementQuantity > 1 ? `${offer.settlementQuantity}件起购` : '';
  if (name === 'warranty') return purchaseWarrantyLabel(offer.tags || []);
  const facts = uniqueTags([offer.tags]).filter(tag => tag.value && !['unknown', 'unspecified'].includes(tag.value)
    && tag.name === name);
  return [...new Set(facts.map(displayPurchaseValue))].join(' · ');
}

function offerIdentity(offer, index) {
  return String(offer.productId || offer.productUrl || `${offer.shopId || offer.shop || 'offer'}-${offer.name || index}`);
}

const SHOP_RISK_NOTE = '风险相对更高';
function ShopScore({ offer }) {
  const [open, setOpen] = useState(false);
  const details = offer.shopScoreDetails;
  const score = offer.shopScore;
  if ((typeof score !== 'string' && typeof score !== 'number') || String(score).trim() === '') return null;
  const value = Number(score);
  return Number.isFinite(value) && value >= 0 && value <= 100
    ? <><span className="shop-score" role="button" tabIndex={0} aria-haspopup="dialog" aria-expanded={open}
      aria-label={`商铺评分 ${Number(value.toFixed(2))}`}
      onClick={event => { event.stopPropagation(); event.currentTarget.focus(); setOpen(true); }}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault(); event.stopPropagation(); setOpen(true);
        }
      }}>评分 {Number(value.toFixed(2))}</span>
      {open && createPortal(<div onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
        <ModalDialog open className="shop-score-dialog" aria-label="商铺评分说明" onClose={() => setOpen(false)}>
          <header className="dialog-header"><h2>商铺评分说明</h2><button type="button" aria-label="关闭评分说明" onClick={() => setOpen(false)}>×</button></header>
          <p className="shop-score-summary">{offer.shop || '商铺'} · <strong>{Number(value.toFixed(2))} / 100</strong></p>
          {details ? <table className="shop-score-breakdown">
            <thead><tr><th scope="col">计分项</th><th scope="col">依据</th><th scope="col">得分贡献</th></tr></thead>
            <tbody>
              <tr><th scope="row">押金</th><td>{details.deposit?.amountMinor != null
                ? `${Number((details.deposit.amountMinor / 100).toFixed(2)).toLocaleString('zh-CN')} ${details.deposit.currency === 'CNY' ? '元' : details.deposit.currency || ''}` : '未取得'}</td><td>{details.deposit ? `${Number(details.deposit.contribution)} 分` : '—'}</td></tr>
              <tr><th scope="row">公示销量</th><td>{details.volume
                ? details.volume.count.toLocaleString('zh-CN') : '未取得'}</td><td>{details.volume ? `${Number(details.volume.contribution)} 分` : '—'}</td></tr>
              <tr><th scope="row">信息披露</th><td>{details.text ? `已审核 ${details.text.reviewed} / ${details.text.total} 件商品` : '未取得'}</td><td>{details.text ? `${Number(details.text.disclosureContribution)} 分` : '—'}</td></tr>
              <tr><th scope="row">描述一致性</th><td>{details.text ? `已审核 ${details.text.reviewed} / ${details.text.total} 件商品` : '未取得'}</td><td>{details.text ? `${Number(details.text.consistencyContribution)} 分` : '—'}</td></tr>
            </tbody>
          </table> : <p>暂无评分明细</p>}
          {details?.volume ? <p className="shop-score-note">销售数据未经真实性核验。</p> : null}
        </ModalDialog>
      </div>, document.body)}</> : null;
}
function ShopBadge({ offer }) {
  const [expanded, setExpanded] = useState(false);
  if (!offer?.independentShop) return null;
  return <span className="offer-shop-badge" role="button" tabIndex={0} aria-expanded={expanded} title={SHOP_RISK_NOTE}
    onClick={event => { event.stopPropagation(); event.currentTarget.focus(); setExpanded(value => !value); }}
    onKeyDown={event => {
      if (event.key === 'Enter' || event.key === ' ') { event.stopPropagation(); event.preventDefault(); setExpanded(value => !value); }
      else if (event.key === 'Escape' && expanded) { event.stopPropagation(); event.preventDefault(); setExpanded(false); }
    }}>
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 2.5a1.15 1.15 0 0 1 2 0l5.3 9.2a1.15 1.15 0 0 1-1 1.8H2.7a1.15 1.15 0 0 1-1-1.8Z" /><path d="M8 6v3M8 11v.1" /></svg>
    {expanded ? SHOP_RISK_NOTE : '自建站'}
  </span>;
}

function OfferCard({ offer, item, rank, onOfferDetails, comparison, onCompare, best = rank === 1, showHistory = false, membershipKinds = EMPTY_LIST, newcomer = false }) {
  const checked = comparison?.some(entry => offerIdentity(entry.offer) === offerIdentity(offer));
  const rankClass = `rank-${Math.min(rank, 4)}`;
  return (
    <div className="shop-offer" key={offerIdentity(offer, rank)}>
      <div className="shop-tile">
        <span className="offer-meta">
          <span className="offer-shop-identity"><span className={`offer-rank ${rankClass}`} aria-label={`第 ${rank} 条报价`}>{rank}</span><span className="offer-shop">{offer.shop || '未知商铺'}</span><ShopScore offer={offer} /><ShopBadge offer={offer} /></span>
          <span className="offer-updated">{formatRelativeTime(offer.capturedAt)}</span>
        </span>
        <strong className="offer-name" title={offer.name || item.name}>{offer.name || item.name}</strong>
        <OfferFacts formatValue={displayPurchaseValue} tags={offer.tags} settlementQuantity={offer.settlementQuantity} />
        <span className="offer-footer">
          <OfferPrice offer={offer} className={`tile-price ${best && availableOffer(offer) ? 'best' : ''}`} />
          <span className="offer-actions">{onCompare ? <label><input type="checkbox" aria-label={`对比报价 ${offer.name || item.name}`} checked={Boolean(checked)} disabled={!checked && comparison.length >= 3} onChange={() => onCompare(offer, item)} />对比</label> : null}<button type="button" className="offer-details-button" onClick={() => onOfferDetails(offer, item)}>商品说明</button>{offer.productUrl ? <a href={offer.productUrl} target="_blank" rel="noreferrer" onClick={() => trackUsage('outbound')}>去商家</a> : null}</span>
        </span>
        {showHistory && offer.productId ? <PriceHistory standardProductId={item.id} productId={String(offer.productId)} currency={offer.currency} membershipKinds={membershipKinds} newcomer={newcomer} /> : null}
      </div>
    </div>
  );
}

function OfferComparison({ entries, onRemove, onClose, onOfferDetails }) {
  useCatalogRefresh({ items: [{ offers: entries.map(entry => entry.offer) }] }, NOOP);
  entries = entries.filter(({ offer }) => currentInventory(offer));
  return <ModalDialog open className="offer-comparison" style={{ '--comparison-columns': entries.length }} aria-labelledby="offer-comparison-title" onClose={onClose}>
    <header className="dialog-header"><h2 id="offer-comparison-title">报价对比</h2><button type="button" aria-label="关闭报价对比" onClick={onClose}>×</button></header>
    <div className="comparison-scroll" tabIndex={0} role="region" aria-label="报价对比表"><div className="comparison-table"><table><thead><tr><th scope="col">报价</th>{entries.map(({ offer, item }) => <th scope="col" key={offerIdentity(offer)}><div className="comparison-offer-heading"><strong>{offer.name || item.name}</strong><button type="button" aria-label={`移除${offer.name || item.name}`} onClick={() => onRemove(offer, item)}>×</button></div></th>)}</tr></thead><tbody>
      {[['商品', ({ item }) => formatStandardName(item.name)], ['商铺', ({ offer }) => <>{offer.shop}<ShopScore offer={offer} /><ShopBadge offer={offer} /></>], ['价格', ({ offer }) => <OfferPrice offer={offer} />], ...COMPARISON_FACTS.filter(([name]) => entries.some(({ offer }) => offerFact(offer, name))).map(([name, label]) => [label, ({ offer }) => offerFact(offer, name) || '—']), ['规格', ({ offer }) => offer.spec || '—'], ['更新', ({ offer }) => formatRelativeTime(offer.capturedAt)]].map(([label, value]) => <tr key={label} className={label === '价格' ? 'comparison-price-row' : undefined}><th scope="row">{label}</th>{entries.map(entry => <td key={offerIdentity(entry.offer)}>{value(entry)}</td>)}</tr>)}
      <tr><th scope="row">商品说明</th>{entries.map(({ offer, item }) => <td key={offerIdentity(offer)}><button type="button" onClick={() => onOfferDetails(offer, item)}>商品说明</button></td>)}</tr>
      <tr><th scope="row">购买</th>{entries.map(({ offer }) => <td key={offerIdentity(offer)}>{offer.productUrl ? <a className="comparison-merchant-link" href={offer.productUrl} target="_blank" rel="noreferrer" onClick={() => trackUsage('outbound')}>去商家</a> : '—'}</td>)}</tr>
    </tbody></table></div></div>
  </ModalDialog>;
}

function priceRangeError({ priceMin, priceMax }) {
  if ([priceMin, priceMax].some(value => value !== '' && !/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$/u.test(value))) return '价格须为非负金额，最多两位小数';
  return priceMin !== '' && priceMax !== '' && Number(priceMin) > Number(priceMax) ? '最低价不能高于最高价' : '';
}

function readDetailSearch(params, item) {
  const { query, tags, warranty, newcomer, membershipKinds } = readCatalogLocation(params);
  const membership = membershipSearch(query, item.isAiMembership && params.get('searchMode') !== 'literal');
  // Preserve inherited purchase intent as visible filters; new detail searches stay literal.
  const literal = params.get('searchMode') === 'literal' || item.isAiMembership && membershipNegation.test(query);
  const parsed = literal ? { text: query, tags: [] } : parseCatalogSearch(membership.text);
  const explicitNames = new Set([...tags].map(key => JSON.parse(key).name));
  const inferred = parsed.tags.filter(tag => !explicitNames.has(tag.name)
    && !(parsed.warrantyDaysMin !== undefined && tag.name === 'warranty_days'));
  return { keyword: [parsed.text, params.get('shopQuery')].filter(Boolean).join(' ').slice(0, 500),
    tags: [...new Set([...tags, ...inferred.map(tagKey)])], warranty: warranty || String(parsed.warrantyDaysMin || ''),
    newcomer: item.isAiMembership || params.has('newcomer') ? newcomer : false,
    membershipKinds: item.isAiMembership ? membershipKinds.length ? membershipKinds : membership.kinds : [] };
}

function CatalogDetailDialog({ detail, onClose, onOfferDetails, comparison, onCompare, onOpenComparison, desktop, standalone = false, referenceRef }) {
  const fixedMembershipKind = detail.membershipKind;
  const title = membershipName(detail.item, fixedMembershipKind);
  const initial = { keyword: '', tags: [], warranty: '', shopId: '', shopName: '', priceMin: '', priceMax: '', currency: 'CNY',
    pageSize: PRODUCT_PAGE_SIZE, page: 1, offerSort: 'price', kind: detail.kind, scrollTop: 0 };
  const [queryState, setState] = useState(() => {
    if (!standalone) return { ...initial, ...readDetailSearch(new URLSearchParams(detail.query), detail.item) };
    const params = new URLSearchParams(window.location.search);
    return { ...initial, ...readDetailSearch(params, detail.item),
      priceMin: params.get('priceMin') || '', priceMax: params.get('priceMax') || '',
      shopId: params.get('shopId') || '',
      page: publicPageNumber(params.getAll('page')) ?? 1,
      kind: params.get('detailKind') === 'shops' ? 'shops' : 'offers', offerSort: ['price', 'priceDesc', 'updated'].includes(params.get('offerSort')) ? params.get('offerSort') : 'price' };
  });
  const state = fixedMembershipKind ? { ...queryState, membershipKinds: [fixedMembershipKind], newcomer: false } : queryState;
  const [draft, setDraft] = useState(() => ({ ...state, tags: new Set(state.tags) }));
  const [keyword, setKeyword] = useState(state.keyword);
  const [filterOpen, setFilterOpen] = useState(false);
  const [rangeError, setRangeError] = useState('');
  const [scrollElement, setScrollElement] = useState(null);
  const toolbar = useRef(null);
  const shopListState = useRef(null);
  const restoreScroll = useRef(null);
  const scrollFrame = useRef(null);
  const onHeightChanged = useCallback(height => {
    if (height > 0 && restoreScroll.current !== null) {
      cancelAnimationFrame(scrollFrame.current);
      scrollFrame.current = requestAnimationFrame(() => {
        if (restoreScroll.current === null) return;
        if (standalone) window.scrollTo(0, restoreScroll.current);
        else if (scrollElement) scrollElement.scrollTop = restoreScroll.current;
        restoreScroll.current = null;
      });
    }
  }, [standalone, scrollElement]);
  useEffect(() => () => cancelAnimationFrame(scrollFrame.current), []);
  const isShops = state.kind === 'shops';
  const label = isShops ? '商铺' : '报价';
  const countUnit = isShops ? '家商铺' : '条报价';
  const detailProducts = page => (page?.items || []).filter(item => item.id === detail.item.id);
  function queryFor(values) {
    const params = new URLSearchParams(detail.query);
    params.set('standardProductId', detail.item.id);
    params.set('q', values.keyword);
    params.set('searchMode', 'literal');
    params.set('newcomer', String(values.newcomer && !values.membershipKinds.length));
    params.delete('membershipKind');
    for (const kind of values.membershipKinds) params.append('membershipKind', kind);
    params.delete('tag');
    for (const tag of values.tags) params.append('tag', tag);
    params.delete('warrantyDaysMin');
    if (values.warranty) params.set('warrantyDaysMin', values.warranty);
    params.delete('shopQuery');
    for (const name of ['priceMin', 'priceMax']) {
      params.delete(name);
      if (values[name] !== '') params.set(name, values[name]);
    }
    params.set('currency', 'CNY');
    params.delete('shopId');
    if (state.shopId) params.set('shopId', state.shopId);
    return params;
  }
  const params = queryFor(state);
  params.set('limit', '1');
  params.set('detailKind', state.kind); params.set('detailPage', String(state.page - 1));
  params.set('detailPageSize', String(state.pageSize)); params.set('offerSort', state.offerSort);
  const url = '/api/catalog?' + params;
  useEffect(() => {
    if (!standalone) return;
    const next = new URLSearchParams(url.split('?')[1]);
    for (const name of ['standardProductId', 'limit', 'platform', 'detailPage', 'detailPageSize']) next.delete(name);
    next.delete('page');
    if (state.page > 1) next.set('page', String(state.page));
    if (!next.get('q')) next.delete('q');
    window.history.replaceState(window.history.state, '', window.location.pathname + '?' + next);
  }, [standalone, url]);
  const detailQuery = useInfiniteQuery({ queryKey: ['details', url],
    initialPageParam: state.page - 1,
    queryFn: ({ signal, pageParam }) => {
      const next = new URLSearchParams(params);
      next.set('detailPage', String(pageParam));
      return fetchCatalog('/api/catalog?' + next, signal);
    },
    getNextPageParam: (lastPage, _pages, page) => {
      return detailProducts(lastPage).some(item => item.detail?.entries?.length && (page + 1) * state.pageSize < item.detail.total) ? page + 1 : undefined;
    },
  });
  const detailData = useMemo(() => {
    const pages = detailQuery.data?.pages || EMPTY_LIST;
    return { ...pages[0], items: pages.flatMap(page => page.items || []) };
  }, [detailQuery.data]);
  const priceRevision = useCatalogRefresh(detailData, detailQuery.refetch);
  const firstDetailItems = detailProducts(detailQuery.data?.pages[0]);
  const missingPage = standalone && state.page > 1 && detailQuery.data !== undefined
    && !firstDetailItems.some(item => item.detail?.entries?.length && (state.page - 1) * state.pageSize < item.detail.total);
  useEffect(() => {
    if (!standalone) return;
    if (missingPage) {
      updatePageMetadata('product-error', { id: detail.item.id, name: '商品分页不存在' }, state.page, fixedMembershipKind);
      return;
    }
    updatePageMetadata('product', detail.item, state.page, fixedMembershipKind);
  }, [standalone, detail.item, state.page, missingPage, fixedMembershipKind]);
  const facetParams = queryFor(state).toString();
  const facets = useQuery({ queryKey: ['detail-facets', facetParams], enabled: filterOpen,
    queryFn: ({ signal }) => fetchCatalog('/api/catalog/facets?' + facetParams, signal) });
  useCatalogRefresh(facets.data, facets.refetch, filterOpen);
  const loading = detailQuery.isPending;
  const error = detailQuery.isError && !detailQuery.data;
  const entries = useMemo(() => {
    if (loading || error) return EMPTY_LIST;
    const all = detailQuery.data?.pages.flatMap(page => {
      return detailProducts(page).flatMap(product => product.detail?.entries || EMPTY_LIST);
    }) || EMPTY_LIST;
    return [...new Map(all.filter(entry => currentInventory(entry.offer || entry)).map(entry => [isShops ? entry.key : offerIdentity(entry), entry])).values()];
  }, [loading, error, detailQuery.data, detail.item.id, isShops, priceRevision]);
  const total = firstDetailItems[0]?.detail?.total ?? 0;
  const visible = entries;
  const columns = !isShops && desktop ? 2 : 1;
  const rows = useMemo(() => Array.from({ length: Math.ceil(visible.length / columns) }, (_, index) => visible.slice(index * columns, (index + 1) * columns)), [visible, columns]);
  const loadNextPage = useCallback(() => {
    if (detailQuery.hasNextPage && !detailQuery.isFetching && !detailQuery.isError) void detailQuery.fetchNextPage({ cancelRefetch: false });
  }, [detailQuery.hasNextPage, detailQuery.isFetching, detailQuery.isError, detailQuery.fetchNextPage]);
  const queryScrollTop = () => window.scrollY + (toolbar.current?.getBoundingClientRect().top ?? 0);
  const update = patch => {
    restoreScroll.current = null;
    if (standalone) window.scrollTo(0, queryScrollTop());
    else if (scrollElement) scrollElement.scrollTop = 0;
    setState(current => ({ ...current, scrollTop: 0, page: 1, ...patch }));
  };
  useEffect(() => {
    if (keyword.trim() === state.keyword) return undefined;
    const timer = window.setTimeout(() => update({ keyword: keyword.trim() }), QUERY_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [keyword, state.keyword]);
  useEffect(() => {
    if (!filterOpen) return undefined;
    const dismiss = event => { if (!toolbar.current?.contains(event.target)) setFilterOpen(false); };
    document.addEventListener('mousedown', dismiss);
    return () => document.removeEventListener('mousedown', dismiss);
  }, [filterOpen]);
  function apply(event) {
    event?.preventDefault();
    if (!isValidWarrantyMinimum(draft.warranty)) { setFilterOpen(true); return; }
    if (priceRangeError(draft)) { setRangeError(priceRangeError(draft)); return; }
    setRangeError('');
    update({ priceMin: draft.priceMin, priceMax: draft.priceMax, tags: [...draft.tags], warranty: draft.warranty,
      membershipKinds: draft.membershipKinds, newcomer: draft.membershipKinds.length ? false : state.newcomer });
    setFilterOpen(false);
  }
  function navigate(patch) {
    restoreScroll.current = patch.scrollTop ?? null;
    if (standalone) window.scrollTo(0, patch.scrollTop ?? queryScrollTop());
    else if (scrollElement) scrollElement.scrollTop = patch.scrollTop ?? 0;
    const values = { ...state, scrollTop: 0, page: 1, ...patch };
    setState(values); setKeyword(values.keyword); setDraft({ ...values, tags: new Set(values.tags) }); setRangeError(''); setFilterOpen(false);
  }
  const field = (name, value) => { setDraft(current => ({ ...current, [name]: value })); setRangeError(''); };
  const selectedCount = state.tags.length + Number(Boolean(state.warranty)) + Number(Boolean(state.priceMin || state.priceMax)) + (fixedMembershipKind ? 0 : state.membershipKinds.length);
  function openShop(entry) {
    shopListState.current = { ...state, scrollTop: standalone ? window.scrollY : scrollElement?.scrollTop || 0 };
    navigate({ kind: 'offers', shopId: entry.key, shopName: entry.name });
  }
  function renderEntry(entry, index) {
    const rank = index + 1;
    return isShops ? <button type="button" className="catalog-shop-entry" key={entry.key} onClick={() => openShop(entry)}>
      <span className="catalog-shop-identity"><span className="offer-rank">{rank}</span><span className="catalog-shop-copy"><strong><span className="catalog-shop-name">{entry.name}</span><ShopScore offer={entry.offer} /><ShopBadge offer={entry.offer} /></strong><span>{entry.count} 条报价</span></span></span><strong className="catalog-shop-price"><OfferPrice offer={entry.offer} /> →</strong>
    </button> : <OfferCard key={offerIdentity(entry, index)} offer={entry} item={detail.item} membershipKinds={state.membershipKinds} newcomer={state.newcomer} rank={rank} best={state.offerSort === 'price' && rank === 1} onOfferDetails={onOfferDetails} comparison={comparison} onCompare={onCompare} showHistory />;
  }
  if (missingPage) return <section className="product-route-state" role="alert"><h1>商品分页不存在</h1><header className="product-page-heading"><a href={productPagePath(detail.item.id, 1, fixedMembershipKind)}>返回商品首页</a><a href="/" onClick={returnToCatalog}>返回商品列表</a><span className="official-reference-slot" ref={referenceRef} /></header></section>;
  const Container = standalone ? 'section' : ModalDialog;
  const Controls = standalone ? 'div' : React.Fragment;
  return <Container {...(standalone ? {} : { open: true, onClose })} className={standalone ? 'product-page-details' : 'catalog-detail-dialog'} aria-labelledby="catalog-detail-title">
    {standalone ? <header className="product-page-heading"><a className="product-back-link" href={window.history.state?.catalogUrl || '/'} onClick={returnToCatalog}>返回商品列表</a><h1>{title}</h1><span className="platform-pill">{displayPlatform(detail.item.platform)}</span><span className="product-page-kind">{detail.item.kind}</span><span className="official-reference-slot" ref={referenceRef} /></header> : null}
    {standalone ? <CatalogSeoIntro product /> : null}
    <Controls {...(standalone ? { className: 'product-detail-controls', id: 'catalog-quotes' } : {})}>
    <header className="dialog-header"><div>{state.shopId ? <button type="button" className="text-button" onClick={() => navigate(shopListState.current || { shopId: '', shopName: '', kind: 'shops' })}>← 返回商铺列表</button> : null}<h2 id="catalog-detail-title">{standalone ? label : title + ' · ' + label}{state.shopName ? ` · ${state.shopName}` : ''}</h2><p>{loading ? '…' : total} {countUnit}</p></div><div className="detail-header-actions">{comparison.length ? <button type="button" className="text-button" onClick={onOpenComparison}>对比（{comparison.length}）</button> : null}{standalone ? <div className="detail-kind-tabs" role="group" aria-label="报价视图"><button type="button" aria-pressed={!isShops} onClick={() => navigate({ kind: 'offers', shopId: '', shopName: '' })}>全部报价</button><button type="button" aria-pressed={isShops} onClick={() => navigate({ kind: 'shops', shopId: '', shopName: '' })}>按商铺</button></div> : <button type="button" aria-label={`关闭${label}详情`} onClick={onClose}>×</button>}</div></header>
    <div className="detail-query-panel" ref={toolbar} onKeyDown={event => {
      if (event.key === 'Escape' && filterOpen) { event.preventDefault(); event.stopPropagation(); setFilterOpen(false); }
    }}>
      <form id="detail-query-form" className="detail-toolbar" aria-label="详情查询" onSubmit={event => { event.preventDefault(); if (keyword.trim() !== state.keyword) update({ keyword: keyword.trim() }); }} noValidate>
        <label className="search-field"><span aria-hidden="true">⌕</span><input aria-label="搜索商铺或报价" placeholder="搜索商铺、报价或规格" maxLength={500} value={keyword} onChange={event => setKeyword(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); }} />{keyword ? <button type="button" className="text-button" aria-label="清除搜索" onClick={() => setKeyword('')}>×</button> : null}</label>
        <select aria-label="报价排序" value={state.offerSort} onChange={event => update({ offerSort: event.target.value })}><option value="price">价格从低到高</option><option value="priceDesc">价格从高到低</option><option value="updated">最近更新</option></select>
        {detail.item.isAiMembership && !fixedMembershipKind ? <label className="catalog-newcomer-toggle"><input type="checkbox" role="switch" aria-label="新手" checked={state.newcomer && !state.membershipKinds.length}
          onChange={event => update({ newcomer: event.target.checked, membershipKinds: [] })} /><span>新手</span></label> : null}
        <button type="button" className={`filter-open-button ${selectedCount ? 'has-selection' : ''}`} aria-expanded={filterOpen} aria-controls="detail-purchase-filters" onClick={() => { if (filterOpen) setFilterOpen(false); else { setDraft({ ...state, tags: new Set(state.tags) }); setRangeError(''); setFilterOpen(true); } }}>筛选{selectedCount ? `（${selectedCount}）` : ''}<span className="filter-chevron" aria-hidden="true" /></button>
        <button type="button" className="text-button" onClick={() => navigate({ keyword: '', tags: [], warranty: '', priceMin: '', priceMax: '', offerSort: 'price', membershipKinds: [] })}>重置</button>
      </form>
      <div className="detail-filter-popover">
      <FilterPanel id="detail-purchase-filters" open={filterOpen} inline extraCount={Number(Boolean(draft.priceMin || draft.priceMax)) + (fixedMembershipKind ? 0 : draft.membershipKinds.length)} tags={facets.data?.tagFacets || EMPTY_LIST} loading={facets.isFetching && !facets.data} error={facets.isError ? '筛选条件加载失败' : ''} onRetry={() => facets.refetch()}
        draftTags={draft.tags} draftWarrantyDaysMin={draft.warranty} onWarrantyChange={(warranty, tags) => setDraft(current => ({ ...current, warranty, tags }))}
        onToggle={key => setDraft(current => { const tags = new Set(current.tags); if (tags.has(key)) tags.delete(key); else tags.add(key); return { ...current, tags }; })}
        onClear={() => { setDraft(current => ({ ...current, tags: new Set(), warranty: '', priceMin: '', priceMax: '', membershipKinds: [] })); setRangeError(''); }} onApply={apply} onClose={() => setFilterOpen(false)}>
        {detail.item.isAiMembership && !fixedMembershipKind ? <MembershipFilter value={draft.membershipKinds} onChange={membershipKinds => field('membershipKinds', membershipKinds)} /> : null}
        <fieldset className="filter-group"><legend>价格区间</legend><div className="filter-group-content"><div className="detail-price-range" role="group" aria-label="人民币金额区间"><label><span aria-hidden="true">¥</span><input type="number" aria-label="最低价格" placeholder="最低价" min="0" max="999999999999.99" step="0.01" value={draft.priceMin} aria-invalid={Boolean(rangeError)} aria-describedby={rangeError ? 'detail-price-error' : undefined} onChange={event => field('priceMin', event.target.value)} /></label><span>—</span><label><span aria-hidden="true">¥</span><input type="number" aria-label="最高价格" placeholder="最高价" min="0" max="999999999999.99" step="0.01" value={draft.priceMax} aria-invalid={Boolean(rangeError)} aria-describedby={rangeError ? 'detail-price-error' : undefined} onChange={event => field('priceMax', event.target.value)} /></label></div>{rangeError ? <span id="detail-price-error" role="alert" className="report-error detail-query-error">{rangeError}</span> : null}</div></fieldset>
      </FilterPanel>
      </div>
    </div>
    </Controls>
    {standalone ? <PurchaseGuide /> : null}
    <div className="detail-scroll" ref={setScrollElement}>
      <PriceHistory key={`${detail.item.id}:${state.currency}`} standardProductId={detail.item.id} currency={state.currency} membershipKinds={state.membershipKinds} newcomer={state.newcomer} />
      {loading ? <p role="status" className="detail-loading">正在加载{label}…</p> : error ? <div role="alert" className="catalog-error"><span>报价加载失败，请重试</span><button type="button" onClick={() => detailQuery.refetch()}>重试</button></div> : !visible.length ? <p className="detail-empty">没有匹配的{label}</p> : standalone || scrollElement ? <Virtuoso key={url} useWindowScroll={standalone} customScrollParent={standalone ? undefined : scrollElement} data={rows} computeItemKey={(_index, row) => isShops ? row[0].key : offerIdentity(row[0])} increaseViewportBy={CATALOG_OVERSCAN} totalListHeightChanged={onHeightChanged} endReached={loadNextPage} itemContent={(index, row) => <div className={isShops ? 'product-shop-row' : 'product-offer-row'}>{row.map((entry, column) => renderEntry(entry, index * columns + column))}</div>} /> : null}
      {detailQuery.isFetchingNextPage ? <p className="catalog-infinite-end" role="status">正在加载更多{label}…</p> : detailQuery.isError && visible.length ? <div className="catalog-error" role="alert"><span>{detailQuery.isFetchNextPageError ? `更多${label}加载失败` : `${label}刷新失败`}</span><button type="button" onClick={() => detailQuery.isFetchNextPageError ? detailQuery.fetchNextPage() : detailQuery.refetch()}>重试加载</button></div> : detailQuery.hasNextPage ? <button type="button" className="text-button product-load-more" disabled={detailQuery.isFetching} onClick={() => detailQuery.fetchNextPage()}>加载更多{label}</button> : visible.length ? <p className="catalog-infinite-end">{state.page > 1 ? '已显示本页起的全部 ' + visible.length : '已显示全部 ' + total} {countUnit}</p> : null}
      {standalone && !isShops && !state.keyword && !state.tags.length && !state.warranty && !state.shopId
        && !state.priceMin && !state.priceMax && !state.newcomer && (fixedMembershipKind || !state.membershipKinds.length) && state.offerSort === 'price' && total > 0
        ? <nav className="catalog-pagination" aria-label="报价分页">
          {state.page > 1 ? <a rel="prev" href={productPagePath(detail.item.id, state.page - 1, fixedMembershipKind)}>上一页报价</a> : null}
          <span>第{state.page}页</span>
          {state.page * PRODUCT_PAGE_SIZE < total ? <a rel="next" href={productPagePath(detail.item.id, state.page + 1, fixedMembershipKind)}>下一页报价</a> : null}
        </nav> : null}
      {standalone ? <p className="product-trade-note">报价仅供比较参考，下单前请以商家页面的实际价格和交易条件为准。本站不参与交易，交易与售后请联系商家。</p> : null}
    </div>
    {standalone ? <CatalogSeoFaq product /> : null}
  </Container>;
}

const StandardProductCard = memo(function StandardProductCard({ item, group, expanded, onToggle, activeTagLabels, onOpenDetail, onOfferDetails, comparison, onCompare, newcomer }) {
  const kind = group?.kind || '';
  const currency = group?.offers[0]?.currency || 'CNY';
  const offers = group?.offers || item.offers || EMPTY_LIST;
  const shopOffers = offers.filter(currentInventory);
  const visible = shopOffers.slice(0, OFFER_PAGE_SIZE);
  const minOffer = shopOffers.find(availableOffer);
  const latestCapturedAt = group ? group.latestCapturedAt : item.latestCapturedAt;
  const updatedLabel = formatRelativeTime(latestCapturedAt);
  const shopCount = Number(group ? group.shopCount : item.shopCount ?? new Set(offers.map((offer) => offer.shopId || offer.shop)).size);
  const productCount = Number(group ? group.productCount : item.productCount ?? offers.length);
  const titleId = `product-${item.id}-${kind || 'standard'}-title`;
  const offersId = `${titleId}-offers`;
  const detailParams = new URLSearchParams({ newcomer: String(newcomer && !kind) });
  const detailHref = kind ? productPagePath(item.id, 1, kind) : productPagePath(item.id) + '?' + detailParams;

  return (
    <article className="standard-product-card" aria-labelledby={titleId}>
      <header className="standard-product-header" onClick={event => {
        if (!event.target.closest('a, button')) onToggle(`${item.id}:${kind || 'standard'}`);
      }}>
        <div className="product-heading">
          <h2 id={titleId}><a href={detailHref} aria-label={membershipName(item, kind)} onClick={event => navigateProduct(event, detailHref)}>{formatStandardName(item.name)}{kind ? <span className="product-kind">{membershipKindLabel(kind)}</span> : null}</a></h2>
          <p className="product-counts">
            <button type="button" className="count-link" onClick={() => onOpenDetail(item, 'shops', kind ? [kind] : [])}>{shopCount} 家商铺</button><span aria-hidden="true">·</span>
            <button type="button" className="count-link" onClick={() => onOpenDetail(item, 'offers', kind ? [kind] : [])}>{productCount} 条报价</button><span aria-hidden="true">·</span>
            {updatedLabel === '更新时间未知' ? <span className="product-updated">{updatedLabel}</span> : <time className="product-updated" dateTime={latestCapturedAt} title={new Date(latestCapturedAt).toLocaleString('zh-CN')}>{updatedLabel}</time>}
          </p>
          {activeTagLabels.length ? <div className="product-active-tags">{activeTagLabels.map((label) => <span key={label}>{label}</span>)}</div> : null}
        </div>
        <div className="standard-product-summary">{group ? <>
          <span className="offer-price lowest-note"><span>{formatMoney(group.minPrice, currency)}</span>{group.minPrice != null && (minOffer?.priceStatus === 'estimated' || minOffer?.paymentMethod?.includes('预估')) ? <span className="offer-price-suffix price-estimate">预估</span> : null}{group.minPrice != null ? <span className="offer-price-suffix"> 起</span> : null}</span>
          {expanded && group.minPrice != null && group.maxPrice != null && Number(group.maxPrice) > Number(group.minPrice) ? <small>{formatMoney(group.minPrice, currency)} – {formatMoney(group.maxPrice, currency)}</small> : null}
        </> : <OfferPrice offer={minOffer} className="lowest-note" starting />}
          <button type="button" className="product-offers-toggle" aria-label={`${expanded ? '收起报价' : '查看报价'}：${membershipName(item, kind)}`} title={expanded ? '收起报价' : '查看报价'} aria-expanded={expanded} aria-controls={offersId} onClick={() => onToggle(`${item.id}:${kind || 'standard'}`)}>
            <span className="filter-chevron" aria-hidden="true" />
          </button>
        </div>
      </header>
      {expanded ? <div className="product-offers-panel" id={offersId}>
        <div className="shop-grid">
        {visible.map((offer, index) => <OfferCard key={offerIdentity(offer, index)} offer={offer} item={item} rank={index + 1} onOfferDetails={onOfferDetails} comparison={comparison} onCompare={onCompare} />)}
        </div>
        {productCount > visible.length ? <div className="product-offers-more"><span>展示前 {visible.length} 条报价</span><button type="button" className="count-link" onClick={() => onOpenDetail(item, 'offers', kind ? [kind] : [])}>查看全部 {productCount} 条报价</button></div> : null}
      </div> : null}
    </article>
  );
});

const CatalogList = memo(function CatalogList({ items, activeTagLabels, onOpenDetail, onOfferDetails, onEndReached, comparison, onCompare, priceRevision, onHeightChanged, newcomer }) {
  const [expandedProducts, setExpandedProducts] = useState(() => new Set());
  const toggleProduct = useCallback(key => {
    setExpandedProducts(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);
  const renderItem = useCallback((_index, entry) => (
    <div className="catalog-virtual-item"><StandardProductCard item={entry.item} group={entry.group} expanded={expandedProducts.has(entry.key)} onToggle={toggleProduct} priceRevision={priceRevision} activeTagLabels={activeTagLabels} onOpenDetail={onOpenDetail} onOfferDetails={onOfferDetails} comparison={comparison} onCompare={onCompare} newcomer={newcomer} /></div>
  ), [expandedProducts, toggleProduct, activeTagLabels, onOpenDetail, onOfferDetails, comparison, onCompare, priceRevision, newcomer]);
  if (!items.length) return null;
  return <div className="catalog-list-surface"><Virtuoso useWindowScroll data={items} computeItemKey={catalogItemKey} itemContent={renderItem} endReached={onEndReached} totalListHeightChanged={onHeightChanged} increaseViewportBy={CATALOG_OVERSCAN} /></div>;
});

function PublicCatalog({ productId, membershipKind, invalidProductRoute, onPlatformChange, assistantEnabled, referenceRef }) {
  usePageAnalytics('catalog');
  const requestedProductPage = publicPageNumber(new URLSearchParams(window.location.search).getAll('page'));
  const invalidProductPage = Boolean(productId && requestedProductPage === null);
  const [initial] = useState(readCatalogLocation);
  const [newcomer, setNewcomer] = useState(initial.newcomer);
  useEffect(() => {
    if (productId) return;
    try { localStorage.setItem(BROWSING_MODE_KEY, newcomer ? 'newcomer' : 'browse'); }
    catch { /* Storage restrictions should not prevent browsing. */ }
  }, [newcomer, productId]);
  const [query, setQuery] = useState(initial.query);
  const [search, setSearch] = useState(initial.query);
  const [platform, setPlatform] = useState(initial.platform);
  useEffect(() => { onPlatformChange?.(productId || platform === '全部' ? null : platform); }, [platform, productId, onPlatformChange]);
  const [sort, setSort] = useState(initial.sort);
  const [cursor, setCursor] = useState(initial.cursor);
  const [selectedProduct, setSelectedProduct] = useState(initial.product);
  const [draftProduct, setDraftProduct] = useState(initial.product);
  const [membershipKinds, setMembershipKinds] = useState(initial.membershipKinds);
  const [draftMembershipKinds, setDraftMembershipKinds] = useState(initial.membershipKinds);
  const [listMeasured, setListMeasured] = useState(false);
  const onHeightChanged = useCallback(height => { if (height > 0) setListMeasured(true); }, []);
  const [shopDialogOpen, setShopDialogOpen] = useState(false);
  const [communityOpen, setCommunityOpen] = useState(false);
  const [disclaimerOpen, setDisclaimerOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [platformPickerOpen, setPlatformPickerOpen] = useState(false);
  const desktopFilters = useDesktopFilters();
  useEffect(() => { if (desktopFilters) setPlatformPickerOpen(false); }, [desktopFilters]);
  const [draftTags, setDraftTags] = useState(() => new Set());
  const [submittingShop, setSubmittingShop] = useState(false);
  const [selectedTags, setSelectedTags] = useState(initial.tags);
  const [warrantyDaysMin, setWarrantyDaysMin] = useState(initial.warranty);
  const [draftWarrantyDaysMin, setDraftWarrantyDaysMin] = useState('');
  const [offerDetails, setOfferDetails] = useState(null);
  const openOfferDetails = useCallback((offer, item) => setOfferDetails({ offer, item }), []);
  const [reportOffer, setReportOffer] = useState(null);
  const [catalogDetail, setCatalogDetail] = useState(null);
  const [comparison, setComparison] = useState([]);
  const [comparisonOpen, setComparisonOpen] = useState(false);
  const [reportError, setReportError] = useState('');
  const [submittingReport, setSubmittingReport] = useState(false);
  const [toast, setToast] = useState('');
  const toastTimer = useRef(null);
  const brandHeader = useRef(null);
  const [brandVisible, setBrandVisible] = useState(true);
  const catalogToolbar = useRef(null);
  useEffect(() => {
    const header = brandHeader.current;
    if (!header || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => setBrandVisible(entry.isIntersecting));
    observer.observe(header);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const panel = catalogToolbar.current;
    if (!panel) return;
    const measure = () => panel.closest('.compact-catalog').style.setProperty('--catalog-toolbar-height', `${Math.ceil(panel.getBoundingClientRect().height)}px`);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(panel, { box: 'border-box' });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (query.trim() === search) return undefined;
    const timer = window.setTimeout(() => {
      setSearch(query.trim());
      if (query.trim()) trackUsage('search');
    }, QUERY_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, search]);
  useEffect(() => {
    if (!filterOpen && !shopDialogOpen && !communityOpen && !reportOffer && !catalogDetail) return undefined;
    const onKeyDown = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (communityOpen) { setCommunityOpen(false); return; }
      if (reportOffer) { if (!submittingReport) setReportOffer(null); return; }
      if (catalogDetail) { setCatalogDetail(null); return; }
      if (shopDialogOpen) { setShopDialogOpen(false); return; }
      setFilterOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [filterOpen, shopDialogOpen, communityOpen, reportOffer, catalogDetail, submittingReport]);
  useEffect(() => () => { if (toastTimer.current) window.clearTimeout(toastTimer.current); }, []);

  const queryClient = useQueryClient();
  const coverageQuery = useQuery({
    queryKey: ['catalog-coverage'], staleTime: 5_000, enabled: !productId,
    queryFn: ({ signal }) => fetchCatalog('/api/catalog/coverage', signal),
  });
  const lookupProductId = productId || selectedProduct;
  const productQuery = useQuery({ queryKey: ['product', lookupProductId], enabled: Boolean(lookupProductId) && !invalidProductPage && !invalidProductRoute, queryFn: ({ signal }) => fetchCatalog('/api/catalog/products/' + encodeURIComponent(lookupProductId), signal) });
  const invalidFeature = invalidProductRoute || Boolean(membershipKind && productQuery.data && !productQuery.data.mergedIntoId && !productQuery.data.isAiMembership);
  const hasMembershipWords = Boolean(search.match(membershipWords));
  const productsQuery = useQuery({ queryKey: ['public-products'], enabled: !productId && (filterOpen || hasMembershipWords || Boolean(membershipKinds.length)),
    queryFn: ({ signal }) => fetchCatalog('/api/catalog/products', signal) });
  const products = productsQuery.data?.items || EMPTY_LIST;
  const matchedProducts = matchingProducts(products, search, platform);
  const aiSearch = selectedProduct ? productQuery.data?.isAiMembership === true
    : matchedProducts.length > 0 && matchedProducts.every(item => item.isAiMembership);
  const searchMembership = useMemo(() => membershipSearch(search, aiSearch), [search, aiSearch]);
  const selectedNonAi = selectedProduct ? productQuery.data?.isAiMembership === false
    : matchedProducts.length > 0 && matchedProducts.every(item => item.isAiMembership === false);
  const effectiveKinds = selectedNonAi ? EMPTY_LIST : membershipKinds.length ? membershipKinds : searchMembership.kinds;
  const effectiveNewcomer = newcomer && !effectiveKinds.length;
  const request = catalogParams(searchMembership.text, platform, selectedTags, warrantyDaysMin, selectedProduct, effectiveNewcomer, effectiveKinds).toString();
  const membershipReady = (!hasMembershipWords && !membershipKinds.length || !productsQuery.isPending) && (!selectedProduct || !productQuery.isPending);
  useEffect(() => {
    if (!productId) return;
    if (invalidFeature || invalidProductPage) {
      updatePageMetadata('product-error', { id: productId, name: invalidFeature ? '商品特性不存在' : '商品分页不存在' }, requestedProductPage || 1, membershipKind);
      return;
    }
    const product = productQuery.data;
    if (product?.mergedIntoId) {
      window.history.replaceState(window.history.state, '', productPagePath(product.mergedIntoId, 1, membershipKind) + window.location.search);
      window.dispatchEvent(new PopStateEvent('popstate')); return;
    }
    if (productQuery.isError) updatePageMetadata('product-error', { id: productId, name: productQuery.error?.status === 404 ? '商品不存在或已下架' : '商品暂时无法加载' }, requestedProductPage || 1, membershipKind);
  }, [productId, productQuery.data, productQuery.isError, productQuery.error, invalidProductPage, invalidFeature, membershipKind, requestedProductPage]);
  const locationReady = useRef(false);
  const unfilteredCatalog = !search && platform === '全部' && !selectedTags.size && !warrantyDaysMin && !selectedProduct && !newcomer && !membershipKinds.length && sort === 'default';
  const startCursor = unfilteredCatalog ? cursor : '';
  useEffect(() => {
    if (productId || !membershipReady || window.location.pathname !== '/') return;
    const next = new URL(window.location.href);
    for (const key of ['q', 'platform', 'tag', 'warrantyDaysMin', 'sort', 'standardProductId', 'newcomer', 'cursor', 'membershipKind']) next.searchParams.delete(key);
    if (startCursor) next.searchParams.set('cursor', startCursor);
    if (!unfilteredCatalog && cursor) setCursor('');
    for (const [key, value] of new URLSearchParams(request)) if (value) next.searchParams.append(key, value);
    next.searchParams.delete('q');
    if (search) next.searchParams.set('q', search);
    next.searchParams.delete('membershipKind');
    if (!selectedNonAi) for (const kind of membershipKinds) next.searchParams.append('membershipKind', kind);
    if (sort !== 'default') next.searchParams.set('sort', sort);
    if (newcomer || new URLSearchParams(window.location.search).has('newcomer')) next.searchParams.set('newcomer', String(effectiveNewcomer));
    const historyState = { ...window.history.state, catalogNewcomer: newcomer };
    if (next.href !== window.location.href) {
      window.history[locationReady.current ? 'pushState' : 'replaceState'](historyState, '', next);
    } else if (window.history.state?.catalogNewcomer !== newcomer) {
      window.history.replaceState(historyState, '', next);
    }
    locationReady.current = true;
    updatePageMetadata('public');
  }, [request, sort, productId, newcomer, effectiveNewcomer, search, membershipKinds, selectedNonAi, membershipReady, startCursor, unfilteredCatalog, cursor]);
  useEffect(() => {
    const restore = () => {
      const value = readCatalogLocation();
      setSelectedProduct(value.product); setDraftProduct(value.product);
      setQuery(value.query); setSearch(value.query); setPlatform(value.platform); setSort(value.sort);
      setSelectedTags(value.tags); setDraftTags(new Set(value.tags)); setWarrantyDaysMin(value.warranty); setDraftWarrantyDaysMin(value.warranty);
      setNewcomer(value.newcomer);
      setMembershipKinds(value.membershipKinds); setDraftMembershipKinds(value.membershipKinds);
      setCursor(value.cursor);
      setCatalogDetail(null); setFilterOpen(false);
    };
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  const catalogQuery = useInfiniteQuery({
    queryKey: ['catalog', request, sort, startCursor],
    enabled: !productId && membershipReady,
    // platformFacets do not depend on the platform param (global navigation),
    // so keep the previous page rendered while a switched request loads.
    placeholderData: keepPreviousData,
    initialPageParam: startCursor || null,
    queryFn: ({ signal, pageParam }) => {
      const params = new URLSearchParams(request);
      params.set('limit', '20'); params.set('sort', sort);
      if (pageParam) params.set('cursor', pageParam);
      return fetchCatalog('/api/catalog?' + params, signal);
    },
    getNextPageParam: (lastPage, _pages, _lastParam, pageParams) => lastPage.nextCursor && !pageParams.includes(lastPage.nextCursor) ? lastPage.nextCursor : undefined,
  });
  const facetQuery = useQuery({
    queryKey: ['facets', request],
    enabled: !productId && filterOpen && membershipReady,
    queryFn: ({ signal }) => fetchCatalog('/api/catalog/facets?' + request, signal),
  });
  useCatalogRefresh(facetQuery.data, facetQuery.refetch, !productId && filterOpen);
  const data = useMemo(() => {
    const pages = catalogQuery.data?.pages || EMPTY_LIST;
    const last = pages.at(-1) || {};
    return { ...last, items: pages.flatMap(page => page.items || EMPTY_LIST),
      platformFacets: last.platformFacets || EMPTY_LIST };
  }, [catalogQuery.data]);
  const priceRevision = useCatalogRefresh(data, catalogQuery.refetch, !productId);
  useEffect(() => {
    const position = window.history.state?.catalogScroll;
    if (!productId && listMeasured && catalogQuery.data && Number.isFinite(position)) {
      const frame = requestAnimationFrame(() => window.scrollTo(0, position));
      return () => cancelAnimationFrame(frame);
    }
  }, [productId, Boolean(catalogQuery.data), listMeasured]);
  const loading = catalogQuery.isFetching || !membershipReady;
  const error = catalogQuery.isError ? '商品加载失败' : '';
  const facetTags = facetQuery.data?.tagFacets || EMPTY_LIST;
  const facetLoading = filterOpen && facetQuery.isFetching && !facetQuery.data;
  const facetError = facetQuery.isError ? '筛选条件加载失败' : '';
  const platforms = useMemo(() => ['全部', ...groupCatalogPlatforms([...data.platformFacets.filter(item => item !== '全部'), ...(platform === '全部' ? [] : [platform])])], [data.platformFacets, platform]);
  const allTags = useMemo(() => uniqueTags([[...selectedTags].map(tag => JSON.parse(tag)), facetTags]), [selectedTags, facetTags]);
  const intentTags = aiSearch && membershipNegation.test(query) ? EMPTY_LIST : searchIntentTags(membershipSearch(query, aiSearch).text);
  const hasRecognizedIntent = intentTags.length > 0 || searchMembership.kinds.length > 0;
  const selectedTagList = useMemo(() => allTags.filter(tag => selectedTags.has(tagKey(tag))), [allTags, selectedTags]);
  const activeTagLabels = useMemo(() => [...selectedTagList.map(displayTag), ...(warrantyDaysMin ? ['质保时长：至少' + warrantyDaysMin + '天'] : [])], [selectedTagList, warrantyDaysMin]);
  const selectedCount = selectedTags.size + Number(Boolean(warrantyDaysMin)) + Number(Boolean(selectedProduct)) + effectiveKinds.length;
  const draftProductData = products.find(item => item.id === draftProduct) || (draftProduct === selectedProduct ? productQuery.data : undefined);
  const showMembershipFilter = draftProduct ? draftProductData?.isAiMembership : matchedProducts.some(item => item.isAiMembership);
  const draftKinds = draftProductData?.isAiMembership === false ? EMPTY_LIST : draftMembershipKinds;
  const draftRequest = catalogParams(searchMembership.text, platform, draftTags, draftWarrantyDaysMin, draftProduct, newcomer, draftKinds).toString();
  // Platform switches return the same `platformFacets`, so only the list blanks behind the skeleton.
  const visibleItems = useMemo(() => catalogQuery.isPlaceholderData || !membershipReady ? EMPTY_LIST
    : data.items.flatMap(item => {
      if (!item.isAiMembership && item.offers?.length && !item.offers.some(currentInventory)) return [];
      if (!item.isAiMembership) return [{ item, group: null, key: `${item.id}:standard` }];
      const groups = (item.membershipGroups || EMPTY_LIST).filter(group => (group.offers || EMPTY_LIST).some(currentInventory));
      return groups.map(group => ({ item, group, key: `${item.id}:${group.kind}` }));
    }),
  [catalogQuery.isPlaceholderData, data.items, priceRevision, membershipReady]);
  const clearFilters = () => { if (selectedCount) { setSelectedTags(new Set()); setWarrantyDaysMin(''); setSelectedProduct(''); setMembershipKinds([]); if (searchMembership.kinds.length) changeSearch(searchMembership.text); trackUsage('filter'); } setDraftTags(new Set()); setDraftWarrantyDaysMin(''); setDraftProduct(''); setDraftMembershipKinds([]); };
  const toggleDraftTag = key => {
    setDraftTags(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  };
  const changeDraftWarranty = (value, tags) => {
    setDraftWarrantyDaysMin(value);
    setDraftTags(tags);
  };
  const applyFilters = () => {
    if (!isValidWarrantyMinimum(draftWarrantyDaysMin)) return;
    const days = draftWarrantyDaysMin ? String(Number(draftWarrantyDaysMin)) : '';
    if (!equalTags(selectedTags, draftTags) || warrantyDaysMin !== days || selectedProduct !== draftProduct || membershipKinds.join() !== draftKinds.join()) {
      setSelectedTags(new Set(draftTags)); setWarrantyDaysMin(days); setSelectedProduct(draftProduct); setMembershipKinds(draftKinds);
      if (draftKinds.length) setNewcomer(false);
      if (searchMembership.kinds.length) { setQuery(searchMembership.text); setSearch(searchMembership.text); }
      trackUsage('filter');
    }
    setFilterOpen(false);
  };
  const changeSort = event => { setSort(event.target.value); trackUsage('filter'); };
  const changeNewcomer = enabled => {
    setNewcomer(enabled); setComparison([]);
    if (enabled) { setMembershipKinds([]); setDraftMembershipKinds([]); setQuery(searchMembership.text); setSearch(searchMembership.text); }
    trackUsage('filter');
  };
  const loadNextPage = useCallback(() => {
    if (!catalogQuery.isFetching && catalogQuery.hasNextPage && !catalogQuery.isError) void catalogQuery.fetchNextPage({ cancelRefetch: false });
  }, [catalogQuery.isFetching, catalogQuery.hasNextPage, catalogQuery.isError, catalogQuery.fetchNextPage]);
  const openDetail = useCallback((item, kind, detailMembershipKinds = []) => {
    const key = `${request}:${item.id}:${kind}:${detailMembershipKinds.join(',')}`;
    const params = new URLSearchParams(request);
    params.set('newcomer', String(effectiveNewcomer && !detailMembershipKinds.length));
    params.delete('membershipKind');
    for (const membershipKind of detailMembershipKinds) params.append('membershipKind', membershipKind);
    setCatalogDetail({ kind, item, membershipKind: detailMembershipKinds[0], query: params.toString(), key }); trackUsage('product_detail');
  }, [request, effectiveNewcomer]);
  const toggleComparison = useCallback((offer, item) => setComparison(current => current.some(entry => offerIdentity(entry.offer) === offerIdentity(offer))
    ? current.filter(entry => offerIdentity(entry.offer) !== offerIdentity(offer)) : current.length < 3 ? [...current, { offer, item }] : current), []);
  useEffect(() => { if (!comparison.length) setComparisonOpen(false); }, [comparison.length]);
  const report = useCallback(offer => { setReportOffer(offer); setReportError(''); }, []);
  const refreshCatalog = () => { void queryClient.resetQueries(); };

  const showToast = (message) => {
    setToast(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 3200);
  };

  const submitShop = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = Object.fromEntries(new FormData(form));
    setSubmittingShop(true);
    try {
      const response = await fetch('/api/shop-submissions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(formData) });
      if (!response.ok) {
        const payload = await readApiError(response);
        const fallback = response.status === 409 ? '这个商铺已经提交过了，无需重复提交' : response.status === 400 ? '商铺信息格式不正确，请检查后重试' : '提交失败，请稍后重试';
        const message = payload?.error?.code === 'SHOP_SUBMISSION_EXISTS' ? '这个商铺已经提交过了，无需重复提交' : payload?.error?.message || fallback;
        throw new Error(message);
      }
      form.reset(); setShopDialogOpen(false); showToast('已提交审核');
      trackUsage('shop_submit');
    } catch (cause) { showToast(cause instanceof Error ? cause.message : '提交失败，请稍后重试'); } finally { setSubmittingShop(false); }
  };

  const submitReport = async (event) => {
    event.preventDefault();
    if (!reportOffer) return;
    const formData = new FormData(event.currentTarget);
    setReportError(''); setSubmittingReport(true);
    try {
      const response = await fetch('/api/product-reports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ productId: String(reportOffer.productId), reason: formData.get('reason'), details: formData.get('details') }) });
      if (!response.ok) throw new Error('report failed');
      setReportOffer(null);
      showToast('举报已提交，我们会核查此报价');
      trackUsage('report_submit');
    } catch { setReportError('提交失败，请稍后重试'); } finally { setSubmittingReport(false); }
  };

  const productDetail = useMemo(() => productQuery.data ? { item: productQuery.data, kind: 'offers', membershipKind, query: '' } : null, [productQuery.data, membershipKind]);
  const selectedProductName = formatStandardName(productQuery.data?.name || data.items.find(item => item.id === selectedProduct)?.name || '已选商品');
  const changeSearch = value => { setQuery(value); setSelectedProduct(''); setDraftProduct(''); };
  const changePlatform = value => {
    setPlatformPickerOpen(false);
    if (value === platform) return;
    setPlatform(value); setSelectedProduct(''); setDraftProduct(''); setMembershipKinds([]); setDraftMembershipKinds([]); trackUsage('filter');
    window.scrollTo(0, 0);
  };
  const platformLabel = platform === '全部' ? '全部平台' : displayPlatform(platform);

  return (
    <main className={`public-layout compact-catalog${productId ? ' product-detail-layout' : ''}`}>
      {!productId ? <>
      <header ref={brandHeader} className="site-header community-header">
        <div className="brand-block"><div className="public-brand-row"><Brand /><CatalogCoverage data={coverageQuery.data} /></div></div>
        <div className="public-header-actions">
          <span className="community-links">
            <a className="community-trigger mcp-access-link" href="/mcp" aria-label="Skill / MCP 接入" title="Skill / MCP 接入">
              {/* Official symbol geometry: modelcontextprotocol/modelcontextprotocol docs/favicon.svg. */}
              <svg width="24" height="24" viewBox="0 0 180 180" fill="none" stroke="currentColor" strokeWidth="11.0667" strokeLinecap="round" aria-hidden="true" focusable="false">
                <path d="M23.5996 85.2532L86.2021 22.6507C94.8457 14.0071 108.86 14.0071 117.503 22.6507C126.147 31.2942 126.147 45.3083 117.503 53.9519L70.2254 101.23" />
                <path d="M70.8789 100.578L117.504 53.952C126.148 45.3083 140.163 45.3083 148.806 53.952L149.132 54.278C157.776 62.9216 157.776 76.9357 149.132 85.5792L92.5139 142.198C89.6327 145.079 89.6327 149.75 92.5139 152.631L104.14 164.257" />
                <path d="M101.853 38.3013L55.553 84.6011C46.9094 93.2447 46.9094 107.258 55.553 115.902C64.1966 124.546 78.2106 124.546 86.8543 115.902L133.154 69.6025" />
              </svg>
            </a>
            <a className="community-trigger" href="/tools" aria-label="检测工具">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                <path d="M14.7 6.3a5 5 0 0 0-6.4 6.4L3 18a2.1 2.1 0 0 0 3 3l5.3-5.3a5 5 0 0 0 6.4-6.4L14 13l-3-3Z" />
              </svg>
            </a>
            {assistantEnabled && <a className="community-trigger" href="/assistant" aria-label="导购助手">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" focusable="false">
                <path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3v-3a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" /><path d="M7 9h10M7 13h6" />
              </svg>
            </a>}
            <a className="community-trigger" href="https://github.com/hhtower/price-comparison" target="_blank" rel="noopener noreferrer" aria-label="GitHub 开源仓库">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
                <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
              </svg>
            </a>
            <button type="button" className="community-trigger" aria-label="QQ 交流群" aria-haspopup="dialog" aria-expanded={communityOpen} aria-controls="community-dialog" onClick={() => setCommunityOpen(true)}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
                <path d="M21.395 15.035a40 40 0 0 0-.803-2.264l-1.079-2.695c.001-.032.014-.562.014-.836C19.526 4.632 17.351 0 12 0S4.474 4.632 4.474 9.241c0 .274.013.804.014.836l-1.08 2.695a39 39 0 0 0-.802 2.264c-1.021 3.283-.69 4.643-.438 4.673.54.065 2.103-2.472 2.103-2.472 0 1.469.756 3.387 2.394 4.771-.612.188-1.363.479-1.845.835-.434.32-.379.646-.301.778.343.578 5.883.369 7.482.189 1.6.18 7.14.389 7.483-.189.078-.132.132-.458-.301-.778-.483-.356-1.233-.646-1.846-.836 1.637-1.384 2.393-3.302 2.393-4.771 0 0 1.563 2.537 2.103 2.472.251-.03.581-1.39-.438-4.673" />
              </svg>
            </button>
          </span>
          <span className="official-reference-slot" ref={referenceRef} />
          <button type="button" className="submit-shop-button" onClick={() => setShopDialogOpen(true)}>提交商铺</button>
        </div>
        <div className="catalog-notice">
          <span>本站不参与交易<span aria-hidden="true"> · </span></span>
          <button type="button" className="catalog-disclaimer-trigger" aria-haspopup="dialog" aria-expanded={disclaimerOpen} aria-controls="catalog-disclaimer-dialog" onClick={() => setDisclaimerOpen(true)}>免责声明</button>
          <span aria-hidden="true">·</span>
          <PurchaseGuideLink>选购指南 →</PurchaseGuideLink>
        </div>
      </header>
      <div ref={catalogToolbar} className="catalog-sticky-header">
      <section className="search-panel" aria-label="搜索和筛选">
        <div className="catalog-search-row">
        {!brandVisible ? <a className="catalog-home-link" href="/" aria-label="返回首页"><img src={logoUrl} width="28" height="28" alt="" aria-hidden="true" /></a> : null}
        <label className="search-field"><span aria-hidden="true">⌕</span><input aria-label="搜索商品" value={query} maxLength={500} placeholder="搜索商品，如 Plus、Claude" autoComplete="off" onChange={(event) => changeSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && query.trim() !== search) { setSearch(query.trim()); if (query.trim()) trackUsage('search'); } }} />{query ? <button type="button" className="text-button" aria-label="清除搜索" onClick={() => changeSearch('')}>×</button> : null}</label>
        <button type="button" className={`icon-button ${loading ? 'is-refreshing' : ''}`} title={loading ? '正在刷新价格' : '刷新价格'} aria-label={loading ? '正在刷新价格' : '刷新价格'} aria-busy={loading} onClick={refreshCatalog}><span className="refresh-icon" aria-hidden="true">↻</span></button>
        </div>
        <div className="catalog-toolbar" role="group" aria-label="平台与排序">
          {desktopFilters ? <div className="platform-tabs" role="group" aria-label="商品平台">{platforms.map((item) => <button key={item} type="button" aria-pressed={item === platform} className={item === platform ? 'active' : ''} onClick={() => changePlatform(item)}>{displayPlatform(item)}</button>)}</div>
            : <button type="button" className={`platform-picker-trigger${platform !== '全部' ? ' has-selection' : ''}`} aria-label={`选择平台：${platformLabel}`} aria-haspopup="dialog" aria-expanded={platformPickerOpen} aria-controls="catalog-platform-picker" onClick={() => setPlatformPickerOpen(true)}><span>{platformLabel}</span><span className="filter-chevron" aria-hidden="true" /></button>}
          <div className="catalog-actions">
            <label className="catalog-newcomer-toggle"><input type="checkbox" role="switch" aria-label="新手" checked={effectiveNewcomer} onChange={event => changeNewcomer(event.target.checked)} /><span>新手</span></label>
            <label className="sort-control"><select value={sort} onChange={changeSort} aria-label="商品排序"><option value="default">默认顺序</option><option value="price">起价最低</option><option value="updated">最近更新</option></select></label>
            <button type="button" className={`filter-open-button ${selectedCount ? 'has-selection' : ''}`} aria-expanded={filterOpen} aria-controls="catalog-purchase-filters" onClick={() => { if (filterOpen) setFilterOpen(false); else { setDraftTags(new Set(selectedTags)); setDraftWarrantyDaysMin(warrantyDaysMin); setDraftProduct(selectedProduct); setDraftMembershipKinds(effectiveKinds); setFilterOpen(true); } }}>筛选{selectedCount ? `（${selectedCount}）` : ''}<span className="filter-chevron" aria-hidden="true" /></button>
          </div>
        </div>
      </section>
      </div>
      </> : null}
      {productId ? <div className="product-page-content">
        {invalidFeature || invalidProductPage || productQuery.isPending || productQuery.isError ? <header className="product-page-heading"><a className="product-back-link" href={window.history.state?.catalogUrl || '/'} onClick={returnToCatalog}>返回商品列表</a><span className="official-reference-slot" ref={referenceRef} /></header> : null}
        {invalidFeature || invalidProductPage ? <section className="product-route-state" role="alert"><h1>{invalidFeature ? '商品特性不存在' : '商品分页不存在'}</h1></section> : productQuery.isPending ? <p role="status">正在加载商品…</p> : productQuery.isError ? <section className="product-route-state" role="alert"><h1>{productQuery.error?.status === 404 ? '商品不存在或已下架' : '商品暂时无法加载'}</h1>{productQuery.error?.status !== 404 ? <button type="button" className="primary-button" onClick={() => productQuery.refetch()}>重试</button> : null}</section> : productDetail && !productQuery.data.mergedIntoId ? <>
          <CatalogDetailDialog key={productId} standalone desktop={desktopFilters} detail={productDetail} onOfferDetails={openOfferDetails} comparison={comparison} onCompare={toggleComparison} onOpenComparison={() => setComparisonOpen(true)} referenceRef={referenceRef} />
        </> : null}
      </div> : <>
      {!desktopFilters && platformPickerOpen ? <ModalDialog open id="catalog-platform-picker" className="platform-picker-dialog" aria-labelledby="platform-picker-title" onClose={() => setPlatformPickerOpen(false)}>
        <div className="dialog-header"><h2 id="platform-picker-title">选择平台</h2><button type="button" aria-label="关闭平台选择" onClick={() => setPlatformPickerOpen(false)}>×</button></div>
        <div className="platform-picker-options" role="group" aria-label="商品平台">{platforms.map(item => <button key={item} type="button" aria-pressed={item === platform} onClick={() => changePlatform(item)}><span>{item === '全部' ? '全部平台' : displayPlatform(item)}</span><span aria-hidden="true">{item === platform ? '✓' : ''}</span></button>)}</div>
      </ModalDialog> : null}
      <FilterPanel open={filterOpen} inline={desktopFilters} covered={Boolean(platformPickerOpen || catalogDetail || reportOffer || shopDialogOpen || communityOpen || comparisonOpen || disclaimerOpen)} tags={allTags} loading={facetLoading} error={facetError} onRetry={() => facetQuery.refetch()} draftTags={draftTags} draftWarrantyDaysMin={draftWarrantyDaysMin} draftProduct={draftProduct} extraCount={draftKinds.length} onWarrantyChange={changeDraftWarranty} onToggle={toggleDraftTag} onClear={() => { setDraftTags(new Set()); setDraftWarrantyDaysMin(''); setDraftProduct(''); setDraftMembershipKinds([]); }} onClose={() => setFilterOpen(false)} onApply={applyFilters}
        preview={filterOpen && membershipReady && isValidWarrantyMinimum(draftWarrantyDaysMin) ? <FilterCount params={draftRequest} enabled current={draftRequest === request && catalogQuery.data && !catalogQuery.isPlaceholderData ? data : undefined} /> : null}>
        {products.length ? <fieldset className="filter-group"><legend>标准商品</legend><div className="filter-group-content"><select className="catalog-standard-select" aria-label="标准商品" value={draftProduct} onChange={event => {
          const product = products.find(item => item.id === event.target.value);
          setDraftProduct(event.target.value);
          if (product?.isAiMembership === false) setDraftMembershipKinds([]);
        }}><option value="">全部商品</option>{products.filter(item => platform === '全部' || normalizeCatalogPlatform(item.platform || '') === platform).map(item => <option key={item.id} value={item.id}>{membershipName(item)}</option>)}</select></div></fieldset> : null}
        {showMembershipFilter ? <MembershipFilter value={draftKinds} onChange={setDraftMembershipKinds} /> : null}
      </FilterPanel>
      <div className="catalog-scroll">
        {intentTags.length ? <div className="intent-chips" aria-label="已识别购买条件">{intentTags.map((tag) => <button type="button" key={tagKey(tag)} aria-label={`移除${displayPurchaseValue(tag)}`} onClick={() => { setQuery(removeSearchIntent(query, tag)); }}>{displayPurchaseValue(tag)} <span aria-hidden="true">×</span></button>)}<button type="button" className="intent-clear" onClick={() => { setQuery(parseCatalogSearch(searchMembership.text).text); }}>清除已识别条件</button></div> : null}
        {selectedCount ? <div className="selected-filters" aria-label="已选筛选条件">{selectedProduct ? <button type="button" onClick={() => { setSelectedProduct(''); setDraftProduct(''); trackUsage('filter'); }}>{selectedProductName} ×</button> : null}
          {effectiveKinds.map(kind => <button type="button" key={kind} onClick={() => {
            const next = effectiveKinds.filter(value => value !== kind); setMembershipKinds(next); setDraftMembershipKinds(next);
            if (searchMembership.kinds.length) { setQuery(searchMembership.text); setSearch(searchMembership.text); }
          }}>AI会员：{membershipKindLabel(kind)} ×</button>)}
          {selectedTagList.map((tag) => <button type="button" key={tagKey(tag)} onClick={() => { const next = new Set(selectedTags); next.delete(tagKey(tag)); setSelectedTags(next); setDraftTags(next); trackUsage('filter'); }}>{displayPurchaseTagText(tag, displayPurchaseValue(tag))} ×</button>)}{warrantyDaysMin ? <button type="button" onClick={() => { setWarrantyDaysMin(''); setDraftWarrantyDaysMin(''); trackUsage('filter'); }}>质保至少{warrantyDaysMin}天 ×</button> : null}<button type="button" className="clear-filter-button" onClick={clearFilters}>清除全部</button></div> : null}
        {error ? <div className="catalog-error" role="alert"><span>{error}</span><button type="button" onClick={() => catalogQuery.isFetchNextPageError ? catalogQuery.fetchNextPage() : catalogQuery.refetch()}>重新加载</button></div> : null}
        {loading && !visibleItems.length ? <CatalogSkeleton /> : null}
        <section id="catalog-quotes" className="catalog" aria-label="商品列表"><CatalogList items={visibleItems} priceRevision={priceRevision} onHeightChanged={onHeightChanged} activeTagLabels={activeTagLabels} onOpenDetail={openDetail} onOfferDetails={openOfferDetails} onEndReached={loadNextPage} comparison={comparison} onCompare={toggleComparison} newcomer={effectiveNewcomer} /></section>
        {unfilteredCatalog && data.nextCursor ? <nav className="catalog-pagination" aria-label="商品分页"><a rel="next" href={catalogPageMetadata(data.nextCursor).path}>下一页商品</a></nav> : null}
        {!catalogQuery.hasNextPage && visibleItems.length ? <p className="catalog-infinite-end">已显示当前条件下的全部商品</p> : null}
        <section className="empty-state" hidden={Boolean(visibleItems.length) || loading || Boolean(error)}><strong>{hasRecognizedIntent || selectedCount ? '没有同时满足这些条件的报价' : '还没有匹配结果'}</strong><span>{hasRecognizedIntent ? '可以移除一个条件，或换个关键词继续找。' : selectedCount ? '清除部分筛选，或换个关键词试试。' : '试试其他关键词或商品平台。'}</span>{hasRecognizedIntent ? <button type="button" className="primary-button" onClick={() => { setQuery(parseCatalogSearch(searchMembership.text).text); }}>清除已识别条件</button> : selectedCount ? <button type="button" className="primary-button" onClick={clearFilters}>清除筛选</button> : null}</section>
      </div>
      <section className="catalog-seo-panel" aria-label="比价说明与常见问题">
        <CatalogSeoIntro />
        <CatalogSeoFaq />
      </section>
      </>}
      {toast ? <div className="catalog-toast" role="status" aria-live="polite">{toast}</div> : null}
      {comparison.length ? <div className="comparison-bar"><button type="button" className="primary-button" onClick={() => setComparisonOpen(true)}>对比（{comparison.length}）</button><button type="button" className="text-button" onClick={() => setComparison([])}>清空</button></div> : null}
      {catalogDetail ? <CatalogDetailDialog key={catalogDetail.key} desktop={desktopFilters} detail={catalogDetail} onClose={() => setCatalogDetail(null)} onOfferDetails={openOfferDetails} comparison={comparison} onCompare={toggleComparison} onOpenComparison={() => setComparisonOpen(true)} /> : null}
      {comparisonOpen && comparison.length ? <OfferComparison onOfferDetails={openOfferDetails} entries={comparison} onRemove={toggleComparison} onClose={() => setComparisonOpen(false)} /> : null}
      {offerDetails ? <OfferTagDetails formatValue={displayPurchaseValue} {...offerDetails} onClose={() => setOfferDetails(null)} onReport={report} /> : null}
      {reportOffer ? <ModalDialog open className="report-dialog" aria-labelledby="report-dialog-title" onClose={() => { if (!submittingReport) setReportOffer(null); }}><form onSubmit={submitReport}><div className="dialog-header"><h2 id="report-dialog-title">举报此报价</h2><button type="button" aria-label="关闭举报" disabled={submittingReport} onClick={() => setReportOffer(null)}>×</button></div><p className="report-product-name">{reportOffer.name} · {reportOffer.shop}</p><label>举报原因<select name="reason" required defaultValue=""><option value="" disabled>请选择原因</option><option value="price_mismatch">价格或库存与商家页面不符</option><option value="invalid_link">商品链接失效</option><option value="misleading">商品描述有误导</option><option value="unsafe">疑似欺诈或违规商品</option><option value="other">其他问题</option></select></label><label>补充说明<textarea name="details" rows="4" maxLength="1000" placeholder="可填写实际价格、问题位置等信息" /></label><p className="report-help">本站会核查举报；下单前请以商家页面的实际信息为准。</p>{reportError ? <p className="report-error" role="alert">{reportError}</p> : null}<div className="report-dialog-actions"><button type="button" className="text-button" disabled={submittingReport} onClick={() => setReportOffer(null)}>取消</button><button type="submit" className="primary-button" disabled={submittingReport}>{submittingReport ? '提交中…' : '提交举报'}</button></div></form></ModalDialog> : null}
      {communityOpen && <CommunityDialog onClose={() => setCommunityOpen(false)} />}
      {disclaimerOpen ? createPortal(<ModalDialog open id="catalog-disclaimer-dialog" className="catalog-disclaimer-dialog" aria-labelledby="catalog-disclaimer-title" onClose={() => setDisclaimerOpen(false)}>
        <header className="dialog-header"><h2 id="catalog-disclaimer-title">免责声明</h2><button type="button" aria-label="关闭免责声明" onClick={() => setDisclaimerOpen(false)}>×</button></header>
        <p>本站汇总、整理和展示公开渠道及商家主动提交的商品、商家与报价信息，仅供用户查询和价格比较参考。本站不销售商品，不参与交易，不代收货款，也不提供交易担保或商品售后服务。</p>
        <p>信息可能存在更新延迟、缺失或偏差，商家提交的内容亦不代表已获本站认可或担保。商品价格、库存、规格、优惠条件及售后政策，请以商家最新说明及实际确认为准。信息的收录、展示或排序，不构成购买建议，也不代表本站对商家资质、商品质量或履约能力作出保证。</p>
        <p>如需购买，请自行核实商品信息、商家资质及交易条件。下单、付款、交付、退款及售后等事项，由您与商家直接沟通处理。</p>
        <p>如发现信息错误、链接失效、疑似违规内容或涉及您的合法权益，请通过对应报价的举报入口反馈，我们将核实处理。</p>
      </ModalDialog>, document.body) : null}
      <ModalDialog className="shop-dialog" open={shopDialogOpen} onClose={() => setShopDialogOpen(false)} aria-labelledby="shop-submit-title"><form onSubmit={submitShop}><div className="dialog-header"><h2 id="shop-submit-title">提交商铺地址</h2><button type="button" aria-label="关闭" onClick={() => setShopDialogOpen(false)}>×</button></div><label>商铺名称<input name="name" required /></label><label>商铺地址<input name="url" type="url" placeholder="https://" required /></label><button className="dialog-submit" disabled={submittingShop}>{submittingShop ? '提交中…' : '提交审核'}</button></form></ModalDialog>
    </main>
  );
}


export default function PublicPage({ productId, membershipKind, invalidProductRoute = false, onPlatformChange, assistantEnabled = false, referenceRef }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: {
    staleTime: 5_000, gcTime: 300_000, retry: false, refetchOnWindowFocus: false,
  } } }));
  useEffect(() => () => client.clear(), [client]);
  return <QueryClientProvider client={client}><PublicCatalog key={productId ? `${productId}:${membershipKind || ''}:${invalidProductRoute}` : 'catalog'} productId={productId} membershipKind={membershipKind} invalidProductRoute={invalidProductRoute} onPlatformChange={onPlatformChange} assistantEnabled={assistantEnabled} referenceRef={referenceRef} /></QueryClientProvider>;
}
