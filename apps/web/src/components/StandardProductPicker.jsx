import React, { useEffect, useId, useState } from 'react';
import { requestJson } from '../api.js';
import { EmptyState, Pagination } from './AdminControls.jsx';
import ModalDialog from './ModalDialog.jsx';
import { CATALOG_PLATFORMS } from '@price-comparison/catalog/platform-groups';

const PAGE_SIZE = 10;

export default function StandardProductPicker({ onSelect, onClose, title = '选择标准商品', status = 'unmerged' }) {
  const titleId = useId();
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [platform, setPlatform] = useState('');
  const [platforms, setPlatforms] = useState([]);
  const [platformError, setPlatformError] = useState('');

  useEffect(() => {
    let active = true;
    const load = async () => {
      const result = await requestJson(`/api/admin/standard-products/platforms?status=${status}`);
      const priority = name => CATALOG_PLATFORMS.findIndex(group => group.aliases.some(alias => alias === name.toLowerCase()));
      const items = [...(result.items ?? [])].sort((a, b) => (priority(a) < 0 ? 99 : priority(a)) - (priority(b) < 0 ? 99 : priority(b)));
      if (active) setPlatforms(items);
    };
    load().catch(error => { if (active) setPlatformError(`分类加载失败：${error.message}`); });
    return () => { active = false; };
  }, [status]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), page: String(page), status });
    if (query.trim()) params.set('keyword', query.trim());
    if (platform) params.set('platform', platform);
    requestJson(`/api/admin/standard-products?${params}`)
      .then(result => { if (active) setData({ items: result.items ?? [], total: result.total ?? 0 }); })
      .catch(error => { if (active) setError(error.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [query, page, platform, status]);

  return <ModalDialog className="management-dialog" open onClose={onClose} aria-labelledby={titleId}>
    <div className="dialog-body">
      <div className="dialog-header"><h2 id={titleId}>{title}</h2><button type="button" aria-label="关闭" onClick={onClose}>×</button></div>
      <label className="picker-platform">平台分类<select value={platform} onChange={event => { setPlatform(event.target.value); setPage(1); }}><option value="">全部分类</option>{platforms.map(name => <option key={name} value={name}>{name.toLowerCase() === 'openai' ? 'OpenAI' : CATALOG_PLATFORMS.find(group => group.aliases.some(alias => alias === name.toLowerCase()))?.label ?? name}</option>)}</select></label>
      {platformError ? <p role="alert">{platformError}</p> : null}
      <input className="dialog-search" aria-label="搜索标准商品名" placeholder="在当前分类搜索名称或别名，如 Pro500" value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} />
      {error ? <p role="alert">{error}</p> : loading ? <p role="status">正在加载标准商品…</p> : <>
        <div className="picker-list">{data.items.length ? data.items.map(item => <button key={item.id} type="button" className="picker-item" onClick={() => onSelect(item)}><strong>{item.name}</strong><small>#{item.id} · {item.platform || '未分类'} · {item.memberCount ?? item.member_count ?? 0} 件商品 · {item.shopCount ?? item.shop_count ?? 0} 家商铺</small></button>) : <EmptyState>没有匹配的标准商品名</EmptyState>}</div>
        <Pagination total={data.total} page={page} pageSize={PAGE_SIZE} onChange={setPage} label="标准商品" />
      </>}
    </div>
  </ModalDialog>;
}

export function StandardProductFilter({ value, onChange }) {
  const [open, setOpen] = useState(false);
  return <div className="standard-product-filter">
    <span>标准商品</span>
    <button type="button" className="standard-filter-value" aria-label="标准商品筛选" aria-haspopup="dialog" title={value ? `${value.name}（#${value.id}）` : '全部标准商品'} onClick={() => setOpen(true)}>{value ? `${value.name}（#${value.id}）` : '全部标准商品'}</button>
    {value ? <button type="button" className="standard-filter-clear" aria-label="清除标准商品筛选" title="清除标准商品筛选" onClick={() => onChange(null)}>×</button> : null}
    {open ? <StandardProductPicker title="筛选标准商品" status="all" onClose={() => setOpen(false)} onSelect={item => { onChange(item); setOpen(false); }} /> : null}
  </div>;
}
