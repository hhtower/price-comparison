import React, { useEffect, useRef, useState } from 'react';
import { requestJson, formatTime } from './api.js';
import { formatMoney } from './money.js';
import { Pagination, IconButton, EmptyState } from './components/AdminControls.jsx';
import AiWorkbench from './AiWorkbench.jsx';
import Brand from './Brand.jsx';
import ShopProtocolReview from './ShopProtocolReview.jsx';
import VisitorAnalytics from './VisitorAnalytics.jsx';
import ModalDialog from './components/ModalDialog.jsx';
import StandardProductPicker, { StandardProductFilter } from './components/StandardProductPicker.jsx';
import './admin.css';
import './ai-workbench.css';

const PAGE_SIZE = 10;
const PROCESSING_DISPOSITIONS = { review_required: '需人工审核', retry_available: '处理失败，可重试', pending: '等待处理', handled: '已处理' };
const emptyPage = { items: [], total: 0, page: 1, pageSize: PAGE_SIZE };
const normalizePage = (data) => { const items = data.items || []; return { items, total: data.total ?? (items.length + (data.nextCursor ? PAGE_SIZE : 0)), page: data.page || 1, pageSize: data.pageSize || PAGE_SIZE }; };
const CONFLICT_FIELDS = { warranty: '质保时长', sms_verification: '接码状态', credentials: '是否带账密', renewal: '续费规则' };
const CONFLICT_SOURCES = { name: '标题', spec: '规格', 'sourceData.evidence': '描述' };
const conflictSource = (path) => CONFLICT_SOURCES[path] ?? path;
// Turns the server's evidence-conflict reason into "字段矛盾：标题「…」 ↔ 描述「…」" for reviewers.
const describeEvidenceConflict = (reason) => {
  const match = /^(\w+) conflict \([^)]*\): (\S+) declares .+?, but (\S+) declares .+?；「(.*)」 vs 「(.*)」$/u.exec(reason ?? '');
  return match ? `${CONFLICT_FIELDS[match[1]] ?? match[1]}矛盾：${conflictSource(match[2])}「${match[4]}」 ↔ ${conflictSource(match[3])}「${match[5]}」` : reason;
};
// Merge conflicts nest one "成员 #id reason" line per member; each line is translated on its own.
const describeConflictReason = reason => reason.replace(/^发布证据冲突：/u, '').split('\n')
  .map(line => line.replace(/^(\s*成员 #\d+ )?(.*)$/u, (_, member = '', text) => `${member}${describeEvidenceConflict(text)}`)).join('\n');
const evidenceConflictPrompt = (items, question) => `有 ${items.length} 项存在标题与描述矛盾：\n${items.map(item => `#${item.id} ${describeConflictReason(item.reason)}`).join('\n')}\n${question}`;
const tagIdentity =(tag) => `${tag.name}\0${tag.value}`;
const batchManagementMessage = (action, result) => {
  const details = result.conflicts.slice(0, 3).map(item => `${item.id}：${item.reason}`).join('；');
  return `${action}完成：成功 ${result.success.length}，无需变更 ${result.skipped.length}，失败 ${result.conflicts.length}${details ? `；${details}${result.conflicts.length > 3 ? '；其余失败项已保留勾选' : ''}` : ''}`;
};
const standardIdentity = (standardProduct) => {
  const fields = [
    standardProduct.canonicalFamily ?? standardProduct.canonical_family,
    standardProduct.canonicalProduct ?? standardProduct.canonical_product,
    standardProduct.canonicalTier ?? standardProduct.canonical_tier,
  ].map(value => String(value ?? '').trim());
  if (fields.every(Boolean)) return fields;
  const fromName = String(standardProduct.name ?? '').split('/').map(value => value.trim());
  return fromName.length === 3 && fromName.every(Boolean) ? fromName : null;
};

function PendingShops({ setMessage }) {
  const [data, setData] = useState(emptyPage);
  const [reload, setReload] = useState(0);
  const [protocols, setProtocols] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [reviewing, setReviewing] = useState(null);
  const activeRequest = useRef(null);
  const disabled = loading || Boolean(reviewing);
  const selectedItems = data.items.filter(item => selectedIds.includes(String(item.id)));

  useEffect(() => () => activeRequest.current?.abort(), []);

  useEffect(() => {
    let active = true;
    requestJson('/api/admin/shop-submissions/protocols').then(result => active && setProtocols(result.items))
      .catch(error => active && setMessage(error.message));
    return () => { active = false; };
  }, [setMessage]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    requestJson(`/api/admin/shop-submissions?limit=${PAGE_SIZE}&page=${data.page}`)
      .then((result) => {
        if (!active) return;
        const normalized = normalizePage(result);
        const lastPage = Math.max(1, Math.ceil(normalized.total / PAGE_SIZE));
        if (normalized.page > lastPage) {
          setData({ ...normalized, items: [], page: lastPage });
          return;
        }
        setData(normalized);
        setSelectedIds(current => current.filter(id => normalized.items.some(item => String(item.id) === id)));
        setLoading(false);
      })
      .catch((error) => { if (active) { setMessage(error.message); setLoading(false); } });
    return () => { active = false; };
  }, [data.page, reload, setMessage]);

  const reviewItems = async (items, action, batch = false) => {
    if (activeRequest.current || disabled || !items.length) return;
    if (batch && !window.confirm(action === 'approve' ? `通过选中的 ${items.length} 家商铺并抓取商品？` : `拒绝选中的 ${items.length} 家商铺？此操作不可撤销。`)) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    setReviewing({ done: 0, total: items.length });
    const success = [], failures = [];
    try {
      for (const item of items) {
        if (controller.signal.aborted) return;
        try {
          await requestJson(`/api/admin/shop-submissions/${item.id}/${action}`, {
            method: 'POST', body: JSON.stringify(action === 'approve' ? { protocol: item.protocol } : {}), signal: controller.signal,
          });
          success.push(String(item.id));
        } catch (error) {
          failures.push(`${item.name}：${error.message}`);
        }
        if (controller.signal.aborted) return;
        setReviewing({ done: success.length + failures.length, total: items.length });
      }
      setSelectedIds(current => current.filter(id => !success.includes(id)));
      if (success.length) {
        setLoading(true);
        setReload(value => value + 1);
      }
      setMessage(batch
        ? `批量${action === 'approve' ? '通过' : '拒绝'}完成：成功 ${success.length}，失败 ${failures.length}${failures.length ? `；${failures.slice(0, 3).join('；')}；失败项已保留勾选` : ''}`
        : failures[0] || (action === 'approve' ? '商铺已通过，正在抓取数据' : '商铺已拒绝'));
    } finally {
      activeRequest.current = null;
      if (!controller.signal.aborted) setReviewing(null);
    }
  };
  const review = (id, action, protocol) => reviewItems([{ ...data.items.find(item => String(item.id) === String(id)), id, protocol }], action);
  const batchReview = action => reviewItems(selectedItems, action, true);

  return (
    <section id="pending-shops" className="admin-section active-section" aria-busy={disabled}>
      <div className="product-toolbar pending-shops-toolbar">
        <strong>待审核商铺 <span>{data.total}</span></strong>
        <small>已支持协议的商铺自动通过，其余商铺需人工审核并验证采集协议</small>
      </div>
      {selectedIds.length ? <div className="batch-actions">
        <span>已选 {selectedIds.length} 家{reviewing ? ` · 正在审核 ${reviewing.done} / ${reviewing.total}` : ''}</span>
        <button type="button" disabled={disabled} onClick={() => batchReview('approve')}>批量通过并抓取</button>
        <button type="button" className="danger-text" disabled={disabled} onClick={() => batchReview('reject')}>批量拒绝</button>
        <button type="button" className="quiet-button" disabled={disabled} onClick={() => setSelectedIds([])}>清除选择</button>
      </div> : null}
      <div className="data-table-wrap pending-shops-table admin-scroll-area">
        {data.items.length ? <table aria-label="待审核商铺">
          <thead><tr>
            <th className="selection-column"><input type="checkbox" aria-label="选择本页商铺" disabled={disabled}
              checked={selectedItems.length === data.items.length}
              ref={element => { if (element) element.indeterminate = selectedItems.length > 0 && selectedItems.length < data.items.length; }}
              onChange={event => setSelectedIds(event.target.checked ? data.items.map(item => String(item.id)) : [])} /></th>
            <th>商铺 / 地址</th><th>采集协议</th><th>提交时间</th><th>操作</th>
          </tr></thead>
          <tbody>{data.items.map(item => <ShopProtocolReview key={`${item.id}:${item.url}`} item={item} protocols={protocols} onReview={review}
            disabled={disabled} selected={selectedIds.includes(String(item.id))}
            onSelect={checked => setSelectedIds(current => checked ? [...current, String(item.id)] : current.filter(id => id !== String(item.id)))} />)}</tbody>
        </table> : <EmptyState>{loading ? '正在加载待审核商铺…' : '暂无待审核商铺'}</EmptyState>}
      </div>
      <Pagination total={data.total} page={data.page} pageSize={PAGE_SIZE} disabled={disabled} onChange={page => {
        setSelectedIds([]); setLoading(true); setData({ ...data, items: [], page });
      }} label="待审核商铺" />
    </section>
  );
}

const REPORT_REASONS = {
  price_mismatch: '价格或库存不符', invalid_link: '链接失效', misleading: '描述有误导',
  unsafe: '疑似欺诈或违规', other: '其他问题',
};

function ProductReports({ setMessage }) {
  const [data, setData] = useState(emptyPage);
  const [status, setStatus] = useState('pending');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    requestJson(`/api/admin/product-reports?status=${status}&page=${data.page}&limit=${PAGE_SIZE}`)
      .then((result) => {
        if (!active) return;
        const normalized = normalizePage(result);
        if (normalized.page > 1 && !normalized.items.length) setData({ ...normalized, page: normalized.page - 1 });
        else setData(normalized);
      })
      .catch((error) => active && setMessage(error.message));
    return () => { active = false; };
  }, [status, data.page, reload, setMessage]);

  const review = async (id, action) => {
    try {
      await requestJson(`/api/admin/product-reports/${id}/${action}`, { method: 'POST' });
      setReload((value) => value + 1);
      setMessage(action === 'resolve' ? '举报已标记为处理完成' : '举报已标记为不成立');
    } catch (error) { setMessage(error.message); }
  };

  return (
    <section id="product-reports" className="admin-section active-section">
      <div className="section-toolbar"><label className="report-status-filter">查看<select aria-label="举报状态" value={status} onChange={(event) => { setStatus(event.target.value); setData(emptyPage); }}><option value="pending">待处理</option><option value="resolved">处理完成</option><option value="dismissed">不成立</option></select></label></div>
      <div className="review-list admin-scroll-area">
        {data.items.length ? data.items.map((item) => <article key={item.id} className="review-card product-report-card"><div><h3>{item.productName}</h3><p>{item.shopName} · {item.currency} {formatMoney(item.price, '')} · {REPORT_REASONS[item.reason] || item.reason}</p>{item.details ? <p className="report-details">{item.details}</p> : null}<a href={item.productUrl} target="_blank" rel="noreferrer">查看原始商品 ↗</a><small>报价采集于 {formatTime(item.priceCapturedAt)} · 举报于 {formatTime(item.createdAt)}</small></div>{status === 'pending' ? <div className="review-actions"><button type="button" className="approve" onClick={() => review(item.id, 'resolve')}>处理完成</button><button type="button" className="reject" onClick={() => review(item.id, 'dismiss')}>不成立</button></div> : null}</article>) : <EmptyState>暂无{status === 'pending' ? '待处理' : status === 'resolved' ? '已处理' : '不成立的'}举报</EmptyState>}
      </div>
      <Pagination total={data.total} page={data.page} pageSize={PAGE_SIZE} onChange={(page) => setData({ ...data, page })} label="商品举报" />
    </section>
  );
}

function ConnectedShops({ setMessage, initialStandardProduct = null, onViewProducts, onChanged }) {
  const [standardProduct, setStandardProduct] = useState(initialStandardProduct);
  const standardProductId = standardProduct?.id;
  const [deleted, setDeleted] = useState(false);
  const [shopQuery, setShopQuery] = useState('');
  const [data, setData] = useState(emptyPage);
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState(null);
  const [protocols, setProtocols] = useState([]);
  useEffect(() => {
    if (!editing) return undefined;
    let active = true;
    requestJson('/api/admin/shop-submissions/protocols').then(result => active && setProtocols(result.items))
      .catch(error => active && setMessage(error.message));
    return () => { active = false; };
  }, [Boolean(editing), setMessage]);

  useEffect(() => {
    let active = true;
    const keyword = shopQuery.trim() ? `&keyword=${encodeURIComponent(shopQuery.trim())}` : '';
    const scope = standardProductId ? `&standardProductId=${encodeURIComponent(standardProductId)}` : `&status=${deleted ? 'deleted' : 'active'}`;
    requestJson(`/api/admin/shops?limit=${PAGE_SIZE}&page=${data.page}${scope}${keyword}`)
      .then((result) => {
        if (!active) return;
        const normalized = normalizePage(result);
        if (normalized.page > 1 && !normalized.items.length) setData({ ...normalized, page: normalized.page - 1 });
        else setData(normalized);
      })
      .catch((error) => active && setMessage(error.message));
    return () => { active = false; };
  }, [data.page, deleted, shopQuery, reload, standardProductId, setMessage]);

  const saveShop = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = Object.fromEntries(new FormData(form));
    const payload = { ...formData, enabled: form.elements.enabled.checked };
    if (editing?.id && payload.protocol === (editing.protocol ?? '')) delete payload.protocol;
    const id = formData.id;
    delete payload.id;
    try {
      await requestJson(id ? `/api/admin/shops/${id}` : '/api/admin/shops', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
      setEditing(null);
      setReload((value) => value + 1);
      setMessage('商铺资料已保存');
      onChanged?.();
    } catch (error) {
      setMessage(error.message);
    }
  };

  const removeRecord = async (id) => {
    if (!window.confirm('删除此商铺及其商品的展示？可在回收站恢复。')) return;
    try {
      await requestJson(`/api/admin/shops/${id}`, { method: 'DELETE' });
      setReload((value) => value + 1);
      setMessage('已移入回收站');
      onChanged?.();
    } catch (error) { setMessage(error.message); }
  };

  const restoreRecord = async (id) => {
    try {
      await requestJson(`/api/admin/shops/${id}/restore`, { method: 'POST' });
      setReload((value) => value + 1);
      setMessage('已恢复');
      onChanged?.();
    } catch (error) { setMessage(error.message); }
  };

  const refreshShop = async (id) => {
    try {
      await requestJson(`/api/admin/shops/refresh`, { method: 'POST', body: JSON.stringify({ shopIds: [String(id)] }) });
      setMessage('已开始重新抓取');
    } catch (error) { setMessage(error.message); }
  };

  return (
    <section id="connected-shops" className="admin-section active-section">
      <div className="section-toolbar shop-toolbar">
        <StandardProductFilter value={standardProduct} onChange={value => { if (value?.id === standardProductId) return; setStandardProduct(value); setData(emptyPage); setDeleted(false); }} />
        <input className="shop-search" aria-label="搜索商铺" placeholder="搜索商铺名称、地址或平台" value={shopQuery} onChange={event => { setShopQuery(event.target.value); setData(current => ({ ...current, items: [], page: 1 })); }} />
        {!standardProductId ? <div className="section-actions">
          <label className="check-line"><input type="checkbox" checked={deleted} onChange={(event) => { setDeleted(event.target.checked); setData({ ...data, page: 1 }); }} />回收站</label>
          <button type="button" className="outline-button" onClick={() => setEditing({ name: '', url: '', enabled: true })}>新增商铺</button>
        </div> : null}
      </div>
      <div className="data-table-wrap admin-scroll-area">
        {data.items.length ? (
          <table>
            <thead><tr><th>商铺 / 地址</th><th>平台</th><th>状态</th><th>最近抓取</th><th>操作</th></tr></thead>
            <tbody>
              {data.items.map((shop) => (
                <tr key={shop.id}>
                  <td className="shop-cell">
                    <strong title={shop.name}>{shop.name}</strong>
                    <a className="table-url" href={shop.url} target="_blank" rel="noreferrer" title={shop.url}>{shop.url.replace(/^https?:\/\//, '')}</a>
                  </td>
                  <td><span className='platform-pill'>{shop.platform}</span><small className='shop-protocol-label'>{shop.protocol ?? '历史域名匹配'}</small></td>
                  <td><span className={`status-pill ${shop.deleted_at ? 'is-deleted' : shop.enabled ? 'is-enabled' : 'is-disabled'}`}>{shop.deleted_at ? '已删除' : shop.enabled ? '启用' : '停用'}</span></td>
                  <td className="table-time">{formatTime(shop.lastFetchAt ?? shop.last_fetch_at)}</td>
                  <td><div className="row-actions">
                    {onViewProducts ? <button type="button" className="quiet-button" onClick={() => onViewProducts(shop, standardProduct)}>{standardProduct ? '查看绑定商品' : '查看商品'}</button> : null}
                    {shop.deleted_at ? (
                      <IconButton action="restore-shop" id={shop.id} label="恢复商铺" icon="rotate-ccw" onClick={(_, id) => restoreRecord(id)} />
                    ) : (
                      <>
                        <button type="button" className="quiet-button" onClick={() => setEditing(shop)}>编辑</button>
                        <button type="button" className="quiet-button" onClick={() => refreshShop(shop.id)}>重新抓取</button>
                        <IconButton action="delete-shop" id={shop.id} label="删除商铺" icon="trash-2" onClick={(_, id) => removeRecord(id)} />
                      </>
                    )}
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <EmptyState>{shopQuery.trim() ? '没有匹配的商铺' : '暂无商铺'}</EmptyState>}
      </div>
      <Pagination total={data.total} page={data.page} pageSize={PAGE_SIZE} onChange={(page) => setData({ ...data, page })} label="商铺" />
      <ModalDialog className="shop-editor" open={Boolean(editing)} onClose={() => setEditing(null)} aria-labelledby="shop-editor-title">
        <form key={editing?.id ?? 'new'} onSubmit={saveShop}>
          <input type="hidden" name="id" defaultValue={editing?.id || ''} />
          <div className="dialog-header"><h2 id="shop-editor-title">{editing?.id ? '编辑商铺' : '新增商铺'}</h2><button type="button" aria-label="关闭" onClick={() => setEditing(null)}>×</button></div>
          <label>商铺名称<input name="name" defaultValue={editing?.name || ''} required /></label>
          <label>商铺地址<input name="url" type="url" defaultValue={editing?.url || ''} required /></label>
          <label>平台<input name="platform" defaultValue={editing?.platform || ''} placeholder="如 16688" required /></label>
          <label>采集协议<select name='protocol' defaultValue={editing?.protocol ?? ''}>
            <option value=''>自动识别并验证</option>
            {editing?.protocol && !protocols.some(protocol => protocol.id === editing.protocol) ? <option value={editing.protocol}>{editing.protocol}</option> : null}
            {protocols.map(protocol => <option key={protocol.id} value={protocol.id}>{protocol.name}</option>)}
          </select></label>
          <label className="check-line"><input name="enabled" type="checkbox" defaultChecked={editing ? Boolean(editing.enabled) : true} />启用商铺</label>
          <div className="dialog-actions"><button type="button" className="reject" onClick={() => setEditing(null)}>取消</button><button className="dialog-submit">保存商铺</button></div>
        </form>
      </ModalDialog>
    </section>
  );
}

function ProductManagement({ setMessage }) {
  const [managementTab, setManagementTab] = useState('raw');
  const [shops, setShops] = useState(emptyPage);
  const [products, setProducts] = useState(emptyPage);
  const [deletedProducts, setDeletedProducts] = useState(false);
  const [productQuery, setProductQuery] = useState('');
  const [rawShopQuery, setRawShopQuery] = useState('');
  const [rawShopId, setRawShopId] = useState('');
  const [rawStandardProduct, setRawStandardProduct] = useState(null);
  const [standardShopView, setStandardShopView] = useState(null);
  const [productReload, setProductReload] = useState(0);
  const [standardProducts, setStandardProducts] = useState(emptyPage);
  const [standardProductQuery, setStandardProductQuery] = useState('');
  const [standardProductStatus, setStandardProductStatus] = useState('active');
  const [updatingStandards, setUpdatingStandards] = useState(false);
  const [standardProductReload, setStandardProductReload] = useState(0);
  const [platforms, setPlatforms] = useState(emptyPage);
  const [platformQuery, setPlatformQuery] = useState('');
  const [platformStatus, setPlatformStatus] = useState('enabled');
  const [selectedPlatformNames, setSelectedPlatformNames] = useState([]);
  const [updatingPlatforms, setUpdatingPlatforms] = useState(false);
  const [platformReload, setPlatformReload] = useState(0);
  const [platformOpen, setPlatformOpen] = useState(false);
  const [picker, setPicker] = useState({ open: false, productId: null });
  const [tagEditor, setTagEditor] = useState(null);
  const [tagRows, setTagRows] = useState(emptyPage);
  const [tagQuery, setTagQuery] = useState('');
  const [tagReload, setTagReload] = useState(0);
  const [tagProductView, setTagProductView] = useState(null);
  const [selectedTagKeys, setSelectedTagKeys] = useState([]);
  const [selectedTagItems, setSelectedTagItems] = useState({});
  const [tagMergeOpen, setTagMergeOpen] = useState(null);
  const [selectedProductIds, setSelectedProductIds] = useState([]);
  const [updatingProducts, setUpdatingProducts] = useState(false);
  const [standardCreateOpen, setStandardCreateOpen] = useState(false);
  const [standardCreating, setStandardCreating] = useState(false);
  const [standardCreateError, setStandardCreateError] = useState('');
  const [standardCreateProducts, setStandardCreateProducts] = useState(emptyPage);
  const [standardCreateProductQuery, setStandardCreateProductQuery] = useState('');
  const [standardCreateSelectedIds, setStandardCreateSelectedIds] = useState([]);
  const [standardCreateIdentity, setStandardCreateIdentity] = useState({ family: '', product: '', tier: '' });
  const [standardCreatePlatform, setStandardCreatePlatform] = useState('');
  const [standardCreatePlatformQuery, setStandardCreatePlatformQuery] = useState('');
  const [standardCreatePlatformOpen, setStandardCreatePlatformOpen] = useState(false);
  const [standardCreateSelectedItems, setStandardCreateSelectedItems] = useState({});
  const [enabledPlatforms, setEnabledPlatforms] = useState([]);
  const [batchTagOpen, setBatchTagOpen] = useState(false);
  const [mergeTargetId, setMergeTargetId] = useState('');
  const [selectedStandardIds, setSelectedStandardIds] = useState([]);
  const [selectedStandardItems, setSelectedStandardItems] = useState({});
  const [savingStandardIds, setSavingStandardIds] = useState([]);
  const [standardProductDrafts, setStandardProductDrafts] = useState({});
  const rawStandardProductId = managementTab === 'raw' ? rawStandardProduct?.id : undefined;

  useEffect(() => {
    let active = true;
    const keyword = rawShopQuery.trim() ? `&keyword=${encodeURIComponent(rawShopQuery.trim())}` : '';
    const scope = rawStandardProductId ? `&standardProductId=${encodeURIComponent(rawStandardProductId)}` : '&status=active';
    requestJson(`/api/admin/shops?limit=${PAGE_SIZE}&page=${shops.page}${scope}${keyword}`)
      .then((result) => {
        if (!active) return;
        const normalized = normalizePage(result);
        setShops(normalized);
      })
      .catch((error) => active && setMessage(error.message));
    return () => { active = false; };
  }, [shops.page, rawShopQuery, rawStandardProductId, setMessage]);

  useEffect(() => {
    if (managementTab !== 'raw' && managementTab !== 'pending') return undefined;
    let active = true;
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), page: String(products.page) });
    if (managementTab === 'pending') params.set('pending', 'true');
    if (managementTab === 'raw' && rawShopId) params.set('shopId', rawShopId);
    if (managementTab === 'raw' && rawStandardProduct) params.set('standardProductId', rawStandardProduct.id);
    if (deletedProducts) params.set('deleted', 'true');
    if (productQuery.trim()) params.set('keyword', productQuery.trim());
    requestJson(`/api/admin/products?${params}`)
      .then((result) => {
        if (!active) return;
        const normalized = normalizePage(result);
        if (normalized.page > 1 && !normalized.items.length) setProducts({ ...normalized, page: normalized.page - 1 });
        else setProducts(normalized);
      })
      .catch((error) => active && setMessage(error.message));
    return () => { active = false; };
  }, [products.page, deletedProducts, productQuery, productReload, managementTab, rawShopId, rawStandardProduct, setMessage]);

  useEffect(() => {
    if (managementTab !== 'standard') return undefined;
    let active = true;
    const query = standardProductQuery ? `&q=${encodeURIComponent(standardProductQuery)}` : '';
    requestJson(`/api/admin/standard-products?limit=${PAGE_SIZE}&page=${standardProducts.page}&status=${standardProductStatus}${query.replace('&q=', '&keyword=')}`)
      .then((result) => {
        if (!active) return;
        const page = normalizePage(result);
        setStandardProducts(page.page > 1 && !page.items.length ? { ...page, page: Math.max(1, Math.min(page.page - 1, Math.ceil(page.total / PAGE_SIZE))) } : page);
      })
      .catch((error) => active && setMessage(error.message));
    return () => { active = false; };
  }, [managementTab, standardProducts.page, standardProductQuery, standardProductStatus, standardProductReload, setMessage]);

  useEffect(() => {
    if (managementTab !== 'platforms') return undefined;
    let active = true;
    const keyword = platformQuery.trim() ? `&keyword=${encodeURIComponent(platformQuery.trim())}` : '';
    requestJson(`/api/admin/platforms?limit=${PAGE_SIZE}&page=${platforms.page}&status=${platformStatus}${keyword}`)
      .then((result) => {
        if (!active) return;
        const page = normalizePage(result);
        setPlatforms(page.page > 1 && !page.items.length ? { ...page, page: Math.max(1, Math.min(page.page - 1, Math.ceil(page.total / PAGE_SIZE))) } : page);
      })
      .catch((error) => active && setMessage(error.message));
    return () => { active = false; };
  }, [managementTab, platforms.page, platformQuery, platformStatus, platformReload, setMessage]);

  useEffect(() => {
    if (!standardCreateOpen) return undefined;
    let active = true;
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), page: String(standardCreateProducts.page) });
    if (standardCreateProductQuery.trim()) params.set('keyword', standardCreateProductQuery.trim());
    requestJson(`/api/admin/products?${params}`)
      .then((result) => active && setStandardCreateProducts(normalizePage(result)))
      .catch((error) => active && setStandardCreateError(error.data?.error?.message || error.message));
    return () => { active = false; };
  }, [standardCreateOpen, standardCreateProducts.page, standardCreateProductQuery, setMessage]);

  useEffect(() => {
    if (!standardCreateOpen && managementTab !== 'standard') return undefined;
    let active = true;
    setEnabledPlatforms([]);
    const load = async () => {
      const first = normalizePage(await requestJson('/api/admin/platforms?limit=100&page=1&status=enabled'));
      const pages = Math.ceil(first.total / first.pageSize);
      const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, index) => requestJson(`/api/admin/platforms?limit=100&page=${index + 2}&status=enabled`)));
      if (active) setEnabledPlatforms([...first.items, ...rest.flatMap(page => page.items ?? [])].filter(platform => platform.enabled !== false));
    };
    load().catch(error => {
      if (!active) return;
      if (standardCreateOpen) setStandardCreateError(error.data?.error?.message || error.message);
      else setMessage(error.message);
    });
    return () => { active = false; };
  }, [standardCreateOpen, managementTab, platformReload, setMessage]);

  useEffect(() => {
    if (managementTab !== 'tags') return undefined;
    let active = true;
    const keyword = tagQuery.trim() ? `&keyword=${encodeURIComponent(tagQuery.trim())}` : '';
    requestJson(`/api/admin/tags?limit=${PAGE_SIZE}&page=${tagRows.page}${keyword}`)
      .then(result => active && setTagRows(normalizePage(result)))
      .catch(error => active && setMessage(error.message));
    return () => { active = false; };
  }, [managementTab, tagRows.page, tagQuery, tagReload, setMessage]);

  useEffect(() => {
    if (managementTab !== 'raw' && managementTab !== 'pending') return;
    setProducts(current => current.items.length || current.page !== 1
      ? { ...current, items: [], page: 1 }
      : current);
    setSelectedProductIds([]);
  }, [managementTab]);


  const openStandardMembers = (standardProduct, shop = null) => {
    setRawStandardProduct(standardProduct);
    setRawShopId(shop ? String(shop.id) : '');
    setRawShopQuery(shop?.name ?? '');
    setProductQuery('');
    setDeletedProducts(false);
    setProducts(emptyPage);
    setShops(emptyPage);
    setSelectedProductIds([]);
    setStandardShopView(null);
    setManagementTab('raw');
  };

  const chooseStandardProduct = async (standardProductId) => {
    try {
      if (standardProductId == null) return;
      const productIds = picker.productId == null ? selectedProductIds : [String(picker.productId)];
      let result = await requestJson('/api/admin/products/standard-products/bind', { method: 'POST', body: JSON.stringify({ productIds, standardProductId, confirmOwnershipChange: false }) });
      const ownershipConflicts = result.conflicts.filter(item => item.reason?.startsWith('当前属于标准商品'));
      if (ownershipConflicts.length && window.confirm(`有 ${ownershipConflicts.length} 件商品当前属于其他标准商品。确认转移归属？`)) {
        const confirmed = await requestJson('/api/admin/products/standard-products/bind', { method: 'POST', body: JSON.stringify({ productIds: ownershipConflicts.map(item => item.id), standardProductId, confirmOwnershipChange: true }) });
        result = { ...result, ...confirmed, success: [...result.success, ...confirmed.success], skipped: [...result.skipped, ...confirmed.skipped], conflicts: [...result.conflicts.filter(item => !ownershipConflicts.includes(item)), ...confirmed.conflicts] };
      }
      const evidenceConflicts = result.conflicts.filter(item => item.reason?.startsWith('发布证据冲突'));
      if (evidenceConflicts.length && window.confirm(evidenceConflictPrompt(evidenceConflicts, '确认仍然绑定？'))) {
        const confirmed = await requestJson('/api/admin/products/standard-products/bind', { method: 'POST', body: JSON.stringify({ productIds: evidenceConflicts.map(item => item.id), standardProductId, confirmOwnershipChange: true, confirmEvidenceConflict: true }) });
        result = { ...result, ...confirmed, success: [...result.success, ...confirmed.success], skipped: [...result.skipped, ...confirmed.skipped], conflicts: [...result.conflicts.filter(item => !evidenceConflicts.includes(item)), ...confirmed.conflicts] };
      }
      setPicker({ open: false, productId: null });
      setSelectedProductIds([]);
      setMessage(`绑定完成：成功 ${result.success.length}，跳过 ${result.skipped.length}，冲突 ${result.conflicts.length}${result.notice ? `。${result.notice}` : ''}`);
      setProductReload(value => value + 1);
    } catch (error) { setMessage(error.message); }
  };

  const editTags = async (product) => {
    try {
      const data = await requestJson(`/api/admin/products/${product.id}/tags`);
      setTagEditor({ product, items: data.items || [] });
    } catch (error) { setMessage(error.message); }
  };

  const saveTags = async (event) => {
    event.preventDefault();
    const items = tagEditor.items.map(tag => ({ name: tag.name.trim(), value: tag.value.trim() }));
    try {
      await requestJson(`/api/admin/products/${tagEditor.product.id}/tags`, { method: 'PUT', body: JSON.stringify({ items }) });
      setTagEditor(null);
      setProductReload(value => value + 1);
      setMessage('商品标签已保存');
    } catch (error) { setMessage(error.message); }
  };

  const productAction = async (product, action) => {
    if (updatingProducts) return;
    try {
      if (action === 'delete') {
        if (!window.confirm('删除此商品及所有原始名称相同的商品？忽略大小写、全半角和空白差异，不按标准商品名称判断。存在已删除同名商品时不能单独恢复，可在回收站查看和恢复。')) return;
        await requestJson(`/api/admin/products/${product.id}`, { method: 'DELETE' });
      } else if (action === 'restore') await requestJson(`/api/admin/products/${product.id}/restore`, { method: 'POST' });
      setSelectedProductIds(current => current.filter(id => id !== String(product.id)));
      setProductReload((value) => value + 1);
    } catch (error) { setMessage(error.message); }
  };

  const updateSelectedProducts = async () => {
    if (updatingProducts || !selectedProductIds.length) return;
    const productIds = [...selectedProductIds];
    const action = deletedProducts ? '恢复' : '删除';
    const endpoint = deletedProducts ? 'batch-restore' : 'batch-delete';
    if (!window.confirm(deletedProducts ? `恢复已选的 ${productIds.length} 件商品？存在手动或历史同名删除记录的商品将保留在回收站。`
      : `删除已选的 ${productIds.length} 件商品及所有原始名称相同的商品？忽略大小写、全半角和空白差异，不按标准商品名称判断。存在已删除同名商品时不能单独恢复，可在回收站查看和恢复。`)) return;
    setUpdatingProducts(true);
    try {
      const { success, failures } = await requestJson(`/api/admin/products/${endpoint}`, { method: 'POST', body: JSON.stringify({ productIds }) });
      const successIds = new Set(success);
      setSelectedProductIds(current => current.filter(id => !successIds.has(id)));
      if (successIds.size) setProductReload(value => value + 1);
      setMessage(`批量${action}完成：成功 ${successIds.size} 件，失败 ${failures.length} 件${failures.length ? `。${failures[0].reason}` : ''}`);
    } catch (error) {
      setMessage(`批量${action}完成：成功 0 件，失败 ${productIds.length} 件。${error.message}`);
    } finally {
      setUpdatingProducts(false);
    }
  };

  const editStandardProduct = (id, field, value) => {
    setStandardProductDrafts(current => ({ ...current, [id]: { ...current[id], [field]: value } }));
  };

  const saveStandardProduct = async (standardProduct, event) => {
    event.preventDefault();
    const id = String(standardProduct.id);
    if (savingStandardIds.includes(id)) return;
    const row = event.currentTarget.closest('.standard-product-row');
    try {
      const name = row.querySelector('[data-standard-product-name]')?.value.trim();
      const platform = row.querySelector('select')?.value || '';
      const familyInput = row.querySelector('[data-standard-product-family]');
      const productInput = row.querySelector('[data-standard-product-product]');
      const tierInput = row.querySelector('[data-standard-product-tier]');
      const aliasInput = row.querySelector('[data-standard-product-aliases]');
      const body = familyInput && productInput && tierInput
        ? { platform, canonicalFamily: familyInput.value.trim(), canonicalProduct: productInput.value.trim(), canonicalTier: tierInput.value.trim() }
        : { name, platform };
      if (aliasInput && aliasInput.value !== (standardProduct.aliases ?? []).join(', ')) {
        body.aliases = aliasInput.value.split(/[,，\n]/u).map(value => value.trim()).filter(Boolean);
      }
      if (!familyInput && !name) {
        setMessage('标准商品名称不能为空');
        return;
      }
      setSavingStandardIds(current => [...current, id]);
      setMessage('正在保存标准商品…');
      const updated = await requestJson(`/api/admin/standard-products/${standardProduct.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      if (updated?.id) {
        const { name, platform, canonicalFamily, canonicalProduct, canonicalTier, aliases } = updated;
        setStandardProducts(current => ({ ...current, items: current.items.map(item => String(item.id) === id
          ? { ...item, name, platform, canonicalFamily, canonicalProduct, canonicalTier, aliases } : item) }));
      }
      setStandardProductDrafts(current => { const next = { ...current }; delete next[id]; return next; });
      setMessage('标准商品已保存');
      setStandardProductReload((value) => value + 1);
    } catch (error) { setMessage(error.message); }
    finally { setSavingStandardIds(current => current.filter(value => value !== id)); }
  };

  const updateStandardVisibility = async (id, hidden) => {
    await requestJson(`/api/admin/standard-products/${id}/visibility`, { method: 'PATCH', body: JSON.stringify({ hidden }) });
  };

  const mergeSelectedStandards = async () => {
    if (!mergeTargetId || !window.confirm('合并所选标准商品并将成员转移到保留项？')) return;
    try {
      const merge = (sourceIds, confirmEvidenceConflict) => requestJson('/api/admin/standard-products/merge', { method: 'POST', body: JSON.stringify({ targetId: mergeTargetId, sourceIds, confirmEvidenceConflict }) });
      let result = await merge(selectedStandardIds.filter(id => id !== mergeTargetId), false);
      const evidenceConflicts = result.conflicts.filter(item => item.reason?.startsWith('发布证据冲突'));
      if (evidenceConflicts.length && window.confirm(evidenceConflictPrompt(evidenceConflicts, '确认仍然合并？'))) {
        const confirmed = await merge(evidenceConflicts.map(item => item.id), true);
        result = { success: [...result.success, ...confirmed.success], skipped: [...result.skipped, ...confirmed.skipped], conflicts: [...result.conflicts.filter(item => !evidenceConflicts.includes(item)), ...confirmed.conflicts] };
      }
      setMessage(`合并完成：成功 ${result.success.length}，冲突 ${result.conflicts.length}`);
      setSelectedStandardIds([]); setSelectedStandardItems({}); setMergeTargetId(''); setStandardProductReload(v => v + 1);
    } catch (error) { setMessage(error.message); }
  };
  const setSelectedStandardVisibility = async (hidden) => {
    if (updatingStandards || !selectedStandardIds.length) return;
    const action = hidden ? '隐藏' : '恢复展示';
    if (!window.confirm(`${action}已选的 ${selectedStandardIds.length} 个标准商品？${hidden ? '前台将不再展示，成员商品及历史记录保留，可在“已隐藏”中恢复。' : ''}`)) return;
    setUpdatingStandards(true);
    try {
      const result = await requestJson('/api/admin/standard-products/batch-visibility', { method: 'POST', body: JSON.stringify({ ids: selectedStandardIds, hidden }) });
      const completed = new Set([...result.success, ...result.skipped]);
      setSelectedStandardIds(current => current.filter(id => !completed.has(id)));
      setSelectedStandardItems(current => Object.fromEntries(Object.entries(current).filter(([id]) => !completed.has(id))));
      setMergeTargetId(current => completed.has(current) ? '' : current);
      setMessage(batchManagementMessage(action, result));
      setStandardProductReload((value) => value + 1);
    } catch (error) { setMessage(error.message); }
    finally { setUpdatingStandards(false); }
  };

  const setSelectedPlatformsEnabled = async (enabled) => {
    if (updatingPlatforms || !selectedPlatformNames.length) return;
    const action = enabled ? '启用' : '停用';
    if (!window.confirm(`${action}已选的 ${selectedPlatformNames.length} 个商品平台？${enabled ? '' : '停用后禁止用于新增标准商品，已有商品及前台展示保持不变，可在“已停用”中恢复。'}`)) return;
    setUpdatingPlatforms(true);
    try {
      const result = await requestJson('/api/admin/platforms/batch-status', { method: 'POST', body: JSON.stringify({ names: selectedPlatformNames, enabled }) });
      const completed = new Set([...result.success, ...result.skipped]);
      setSelectedPlatformNames(current => current.filter(name => !completed.has(name)));
      setMessage(batchManagementMessage(action, result));
      setPlatformReload(value => value + 1);
    } catch (error) { setMessage(error.message); }
    finally { setUpdatingPlatforms(false); }
  };

  const togglePlatforms = (names, checked) => {
    setSelectedPlatformNames(current => checked ? [...new Set([...current, ...names])] : current.filter(name => !names.includes(name)));
  };

  const openStandardCreate = () => {
    setStandardCreateError('');
    setStandardCreateIdentity({ family: '', product: '', tier: '' });
    setStandardCreatePlatform('');
    setStandardCreatePlatformQuery('');
    setStandardCreatePlatformOpen(false);
    setStandardCreateSelectedIds(selectedProductIds);
    setStandardCreateSelectedItems(Object.fromEntries(products.items.filter(item => selectedProductIds.includes(String(item.id))).map(item => [String(item.id), { id: String(item.id), name: item.name }])));
    setEnabledPlatforms([]);
    setStandardCreateProductQuery('');
    setStandardCreateProducts(emptyPage);
    setStandardCreateOpen(true);
  };

  const visibleStandardCreatePlatforms = enabledPlatforms.filter((platform) => {
    const query = standardCreatePlatformQuery.trim().toLocaleLowerCase();
    if (!query || platform.name === standardCreatePlatform) return true;
    return String(platform.name).toLocaleLowerCase().includes(query) || String(platform.id).toLocaleLowerCase().includes(query);
  });

  const createStandardProduct = async (event) => {
    event.preventDefault();
    if (standardCreating) return;
    setStandardCreateError('');
    try {
      const form = new FormData(event.currentTarget);
      const family = String(form.get('family') || '').trim();
      const product = String(form.get('product') || '').trim();
      const tier = String(form.get('tier') || '').trim();
      const platform = String(form.get('platform') || '');
      if (!family || !product || !tier) {
        setStandardCreateError('family、product、tier 必须填写');
        return;
      }
      if (!platform) {
        setStandardCreateError('请从下拉列表选择平台');
        return;
      }
      if (!standardCreateSelectedIds.length) {
        setStandardCreateError('请先选择商品');
        return;
      }
      setStandardCreating(true);
      const create = confirmEvidenceConflict => requestJson('/api/admin/standard-products', { method: 'POST', body: JSON.stringify({ family, product, tier, platform, productIds: standardCreateSelectedIds, confirmEvidenceConflict }) });
      try { await create(false); } catch (error) {
        const conflicts = error.data?.error?.details?.conflicts;
        if (error.data?.error?.code !== 'CATALOG_PUBLICATION_BLOCKED' || !conflicts?.length) throw error;
        if (!window.confirm(evidenceConflictPrompt(conflicts, '确认仍然创建？'))) return;
        await create(true);
      }
      setSelectedProductIds([]);
      setStandardCreateSelectedIds([]);
      setStandardCreateSelectedItems({});
      setStandardCreateOpen(false);
      setManagementTab('standard');
      setStandardProductReload((value) => value + 1);
      setProductReload(value => value + 1);
      setMessage('标准商品已创建');
    } catch (error) {
      setStandardCreateError(error.data?.error?.message || error.message);
    } finally {
      setStandardCreating(false);
    }
  };

  const removeTag = async (tag) => {
    if (!window.confirm(`删除标签“${tag.name}：${tag.value}”？`)) return;
    try {
      await requestJson(`/api/admin/tags?name=${encodeURIComponent(tag.name)}&value=${encodeURIComponent(tag.value)}`, { method: 'DELETE' });
      const key = tagIdentity(tag);
      setSelectedTagKeys(current => current.filter(selectedKey => selectedKey !== key));
      setSelectedTagItems(current => { const next = { ...current }; delete next[key]; return next; });
      setTagReload(v => v + 1);
    }
    catch (error) { setMessage(error.message); }
  };

  const renameTag = async (tag) => {
    const nextName = window.prompt('标签名', tag.name); const nextValue = window.prompt('标签值', tag.value);
    if (!nextName?.trim() || !nextValue?.trim()) return;
    try {
      await requestJson('/api/admin/tags', { method: 'PATCH', body: JSON.stringify({ name: tag.name, value: tag.value, nextName, nextValue }) });
      const key = tagIdentity(tag);
      setSelectedTagKeys(current => current.filter(selectedKey => selectedKey !== key));
      setSelectedTagItems(current => { const next = { ...current }; delete next[key]; return next; });
      setTagReload(v => v + 1);
    }
    catch (error) { setMessage(error.message); }
  };

  const mergeTag = (tagOrTags) => {
    const sources = Array.isArray(tagOrTags) ? tagOrTags : [tagOrTags];
    setTagMergeOpen({ sources });
  };

  const submitTagMerge = async (event) => {
    event.preventDefault();
    if (!tagMergeOpen?.sources?.length) return;
    const form = new FormData(event.currentTarget);
    const nextName = String(form.get('nextName') || '').trim();
    const nextValue = String(form.get('nextValue') || '').trim();
    if (!nextName || !nextValue) {
      setMessage('目标标签名和值不能为空');
      return;
    }
    if (tagMergeOpen.sources.some(source => nextName === source.name && nextValue === source.value)) {
      setMessage('目标标签不能与源标签相同');
      return;
    }
    try {
      const results = await Promise.all(tagMergeOpen.sources.map(source => requestJson('/api/admin/tags/merge', { method: 'POST', body: JSON.stringify({ name: source.name, value: source.value, nextName, nextValue }) })));
      const result = results.reduce((summary, current) => ({
        success: [...summary.success, ...(current.success || [])],
        skipped: [...summary.skipped, ...(current.skipped || [])],
      }), { success: [], skipped: [] });
      setTagMergeOpen(null);
      setSelectedTagKeys([]);
      setSelectedTagItems({});
      setMessage(`标签合并完成：新增关系 ${result.success.length}，去重 ${result.skipped.length}`);
      setTagReload(v => v + 1);
    } catch (error) { setMessage(error.message); }
  };

  const openTagProducts = async (tag) => {
    try {
      const params = new URLSearchParams({ name: tag.name, value: tag.value, limit: String(PAGE_SIZE), page: '1' });
      const data = await requestJson(`/api/admin/tags/products?${params}`);
      setTagProductView({ tag, data: normalizePage(data) });
    } catch (error) { setMessage(error.message); }
  };

  const bindSelectedTags = async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const result = await requestJson('/api/admin/products/tags/bind', { method: 'POST', body: JSON.stringify({ productIds: selectedProductIds, name: String(form.get('name')).trim(), value: String(form.get('value')).trim() }) });
      setBatchTagOpen(false);
      setSelectedProductIds([]);
      setMessage(`标签绑定完成：成功 ${result.success.length}，跳过 ${result.skipped.length}，冲突 ${result.conflicts.length}`);
      setProductReload(value => value + 1);
    } catch (error) { setMessage(error.message); }
  };

  const savePlatform = async (platform, event) => {
    event.preventDefault();
    const name = event.currentTarget.closest('.platform-row').querySelector('input:not([type=checkbox])').value.trim();
    try {
      await requestJson(`/api/admin/platforms/${encodeURIComponent(platform.id)}`, { method: 'PATCH', body: JSON.stringify({ name }) });
      setSelectedPlatformNames(current => [...new Set(current.map(selected => selected === platform.name ? name : selected))]);
      setPlatformReload((value) => value + 1);
      setStandardProductReload((value) => value + 1);
    } catch (error) { setMessage(error.message); }
  };

  const createPlatform = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const name = new FormData(form).get('name').trim();
    try {
      await requestJson('/api/admin/platforms', { method: 'POST', body: JSON.stringify({ name }) });
      form.reset();
      setPlatformOpen(false);
      setPlatformStatus('enabled');
      setPlatforms({ ...platforms, page: 1 });
      setPlatformReload((value) => value + 1);
    } catch (error) { setMessage(error.message); }
  };

  const toggleTagSelection = (tag, checked) => {
    const key = tagIdentity(tag);
    setSelectedTagKeys(current => checked
      ? [...new Set([...current, key])]
      : current.filter(selectedKey => selectedKey !== key));
    setSelectedTagItems(current => {
      const next = { ...current };
      if (checked) next[key] = { name: tag.name, value: tag.value };
      else delete next[key];
      return next;
    });
  };

  const toggleTagsOnPage = (tags, checked) => {
    const keys = tags.map(tagIdentity);
    setSelectedTagKeys(current => checked
      ? [...new Set([...current, ...keys])]
      : current.filter(key => !keys.includes(key)));
    setSelectedTagItems(current => {
      const next = { ...current };
      if (checked) tags.forEach(tag => { next[tagIdentity(tag)] = { name: tag.name, value: tag.value }; });
      else keys.forEach(key => { delete next[key]; });
      return next;
    });
  };

  const toggleStandardSelection = (standardProduct, checked) => {
    const id = String(standardProduct.id);
    if (!checked) setMergeTargetId(current => current === id ? '' : current);
    setSelectedStandardIds(current => checked
      ? [...new Set([...current, id])]
      : current.filter(selectedId => selectedId !== id));
    setSelectedStandardItems(current => {
      const next = { ...current };
      if (checked) next[id] = { id, name: standardProduct.name };
      else delete next[id];
      return next;
    });
  };

  const toggleStandardProductsOnPage = (items, checked) => {
    items = items.filter(item => !item.mergedIntoId);
    const ids = items.map(item => String(item.id));
    if (!checked) setMergeTargetId(current => ids.includes(current) ? '' : current);
    setSelectedStandardIds(current => checked
      ? [...new Set([...current, ...ids])]
      : current.filter(id => !ids.includes(id)));
    setSelectedStandardItems(current => {
      const next = { ...current };
      if (checked) items.forEach(item => { next[String(item.id)] = { id: String(item.id), name: item.name }; });
      else ids.forEach(id => { delete next[id]; });
      return next;
    });
  };

  const platformNamesOnPage = platforms.items.map(item => item.name);
  const selectedPlatformsOnPage = platformNamesOnPage.filter(name => selectedPlatformNames.includes(name));
  const allPlatformsOnPageSelected = platformNamesOnPage.length > 0 && selectedPlatformsOnPage.length === platformNamesOnPage.length;
  const somePlatformsOnPageSelected = selectedPlatformsOnPage.length > 0 && !allPlatformsOnPageSelected;
  const standardProductIdsOnPage = standardProducts.items.filter(item => !item.mergedIntoId).map((item) => String(item.id));
  const selectedStandardIdsOnPage = standardProductIdsOnPage.filter((id) => selectedStandardIds.includes(id));
  const allStandardProductsOnPageSelected = standardProductIdsOnPage.length > 0 && selectedStandardIdsOnPage.length === standardProductIdsOnPage.length;
  const someStandardProductsOnPageSelected = selectedStandardIdsOnPage.length > 0 && !allStandardProductsOnPageSelected;
  const selectedTagsOnPage = tagRows.items.filter((tag) => selectedTagKeys.includes(tagIdentity(tag)));
  const allTagsOnPageSelected = tagRows.items.length > 0 && selectedTagsOnPage.length === tagRows.items.length;
  const someTagsOnPageSelected = selectedTagsOnPage.length > 0 && !allTagsOnPageSelected;
  const selectedTags = selectedTagKeys.map(key => selectedTagItems[key]).filter(Boolean);
  const selectedStandardItemsList = selectedStandardIds.map(id => selectedStandardItems[id]).filter(Boolean);

  return (
    <section id="standard-products" className="admin-section active-section">
      <nav className="management-tabs" aria-label="商品管理入口">
        {[['raw', '原始商品'], ['task', '任务台'], ['pending', '待处理'], ['standard', '标准商品'], ['tags', '标签'], ['platforms', '商品平台']].map(([id, label]) => <button key={id} type="button" className={managementTab === id ? 'active' : ''} disabled={updatingProducts} onClick={() => { if (rawStandardProduct) openStandardMembers(null); setStandardShopView(null); setManagementTab(id); if (id !== 'pending') setSelectedProductIds([]); }}>{label}</button>)}
      </nav>
      {managementTab === 'task' ? <AiWorkbench shops={shops} onProductsChanged={() => setProductReload(value => value + 1)} /> : null}
      {managementTab === 'tags' ? <div className="management-panel">
        {tagProductView ? (
          <>
            <div className="dialog-header"><h2>{tagProductView.tag.name}：{tagProductView.tag.value}</h2><button type="button" onClick={() => setTagProductView(null)}>返回标签</button></div>
            <div className="data-table-wrap">
              <table><thead><tr><th>商品</th><th>商铺</th><th>规格</th><th>更新时间</th></tr></thead><tbody>{tagProductView.data.items.map(product => <tr key={product.id}><td><strong>{product.name}</strong><small>#{product.id}</small></td><td>{product.shopName}</td><td>{product.spec || '-'}</td><td>{formatTime(product.updatedAt)}</td></tr>)}</tbody></table>
              {!tagProductView.data.items.length ? <EmptyState>暂无绑定商品</EmptyState> : null}
            </div>
            <Pagination total={tagProductView.data.total} page={tagProductView.data.page} pageSize={PAGE_SIZE} onChange={async page => { try { const params = new URLSearchParams({ name: tagProductView.tag.name, value: tagProductView.tag.value, limit: String(PAGE_SIZE), page: String(page) }); const data = await requestJson(`/api/admin/tags/products?${params}`); setTagProductView(current => ({ ...current, data: normalizePage(data) })); } catch (error) { setMessage(error.message); } }} label="商品" />
          </>
        ) : (
          <>
            <div className="tag-list-toolbar">
              <input aria-label="搜索标签" placeholder="搜索标签名或标签值" value={tagQuery} onChange={event => { setTagQuery(event.target.value); setTagRows(current => ({ ...current, page: 1 })); setSelectedTagKeys([]); setSelectedTagItems({}); }} />
            </div>
            {selectedTagKeys.length ? <div className="batch-actions tag-batch-actions">
              <span>已选 {selectedTagKeys.length} 个标签值</span>
              <button type="button" disabled={selectedTags.length < 2} onClick={() => selectedTags.length > 1 && mergeTag(selectedTags)}>合并标签值</button>
              <button type="button" className="quiet-button" onClick={() => { setSelectedTagKeys([]); setSelectedTagItems({}); }}>清除选择</button>
            </div> : null}
            <div className="data-table-wrap">
              <table>
                <thead><tr>
                  <th className="selection-column"><input aria-label="选择当前页标签" type="checkbox" checked={allTagsOnPageSelected} ref={(element) => { if (element) element.indeterminate = someTagsOnPageSelected; }} onChange={(event) => toggleTagsOnPage(tagRows.items, event.target.checked)} /></th>
                  <th>标签名</th><th>标签值</th><th>绑定商品数</th><th>操作</th>
                </tr></thead>
                <tbody>{tagRows.items.map(tag => <tr key={tagIdentity(tag)}>
                  <td className="selection-column"><input aria-label={`选择标签 ${tag.name}：${tag.value}`} type="checkbox" checked={selectedTagKeys.includes(tagIdentity(tag))} onChange={(event) => toggleTagSelection(tag, event.target.checked)} /></td>
                  <td>{tag.name}</td><td>{tag.value}</td><td>{tag.productCount ?? tag.product_count ?? 0}</td>
                  <td><div className="row-actions"><IconButton action="view-tag-products" id={tagIdentity(tag)} label="查看商品" icon="eye" onClick={() => openTagProducts(tag)} /><IconButton action="rename-tag" id={tagIdentity(tag)} label="重命名" icon="pencil" onClick={() => renameTag(tag)} /><IconButton action="delete-tag" id={tagIdentity(tag)} label="删除标签" icon="trash-2" onClick={() => removeTag(tag)} /></div></td>
                </tr>)}</tbody>
              </table>
              {!tagRows.items.length ? <EmptyState>暂无标签</EmptyState> : null}
            </div>
            <Pagination total={tagRows.total} page={tagRows.page} pageSize={PAGE_SIZE} onChange={page => setTagRows({ ...tagRows, items: [], page })} label="标签" />
          </>
        )}
      </div> : null}
      {managementTab === 'raw' ? <fieldset role="region" className="management-panel management-operation-fields" aria-label="原始商品" disabled={updatingProducts} aria-busy={updatingProducts}>
        {rawStandardProduct ? <div className="standard-member-heading"><h2>{rawStandardProduct.name} · 原始商品</h2><button type="button" className="quiet-button" onClick={() => { openStandardMembers(null); setManagementTab('standard'); }}>返回标准商品</button></div> : null}
        <div className="product-toolbar raw-products-toolbar">
          <StandardProductFilter value={rawStandardProduct} onChange={value => { if (value?.id === rawStandardProductId) return; setRawStandardProduct(value); setProducts(emptyPage); setShops(emptyPage); setSelectedProductIds([]); }} />
          <input className="raw-shop-filter" disabled={updatingProducts} aria-label="原始商品商铺" list="raw-shop-options" placeholder="搜索商店" value={rawShopQuery} onChange={event => { const value = event.target.value; const selectedShop = shops.items.find(shop => shop.name === value); setRawShopQuery(value); setRawShopId(selectedShop ? String(selectedShop.id) : ''); setShops(current => ({ ...current, page: 1 })); setProducts(current => ({ ...current, items: [], page: 1 })); setSelectedProductIds([]); }} />
          <input className="raw-product-filter" disabled={updatingProducts} aria-label="搜索商品" placeholder="搜索商品" value={productQuery} onChange={event => { setProductQuery(event.target.value); setProducts(current => ({ ...current, items: [], page: 1 })); setSelectedProductIds([]); }} />
          <label className="check-line"><input type="checkbox" disabled={updatingProducts} checked={deletedProducts} onChange={(event) => { setDeletedProducts(event.target.checked); setProducts({ ...products, items: [], page: 1 }); setSelectedProductIds([]); }} />回收站</label>
        </div>
        <datalist id="raw-shop-options">{shops.items.map(shop => <option key={shop.id} value={shop.name} />)}</datalist>
        {selectedProductIds.length ? <div className="batch-actions"><span>已选 {selectedProductIds.length} 件</span>{!deletedProducts ? <button type="button" disabled={updatingProducts} onClick={() => setPicker({ open: true, productId: null })}>绑定标准商品</button> : null}<button type="button" className={deletedProducts ? '' : 'danger-text'} disabled={updatingProducts} onClick={updateSelectedProducts}>{deletedProducts ? updatingProducts ? '恢复中…' : '批量恢复' : updatingProducts ? '删除中…' : '批量删除'}</button><button type="button" className="quiet-button" disabled={updatingProducts} onClick={() => setSelectedProductIds([])}>清除选择</button></div> : null}
        <div className="data-table-wrap raw-products-table admin-scroll-area">
          {products.items.length ? (
            <table>
              <thead><tr><th><input aria-label="选择本页商品" type="checkbox" disabled={updatingProducts} checked={products.items.length > 0 && products.items.every(product => selectedProductIds.includes(String(product.id)))} onChange={event => setSelectedProductIds(event.target.checked ? [...new Set([...selectedProductIds, ...products.items.map(product => String(product.id))])] : selectedProductIds.filter(id => !products.items.some(product => String(product.id) === id)))} /></th><th>商品 / 规格</th><th>商铺</th><th>标准商品</th><th>最近更新</th><th>操作</th></tr></thead>
              <tbody>
                {products.items.map((product) => (
                  <tr key={product.id}>
                    <td><input aria-label={`选择 ${product.name}`} type="checkbox" disabled={updatingProducts} checked={selectedProductIds.includes(String(product.id))} onChange={event => setSelectedProductIds(event.target.checked ? [...new Set([...selectedProductIds, String(product.id)])] : selectedProductIds.filter(id => id !== String(product.id)))} /></td>
                    <td className="product-cell">
                      <strong title={product.name}>{/^https?:\/\//i.test(product.url || '')
                        ? <a className="product-name-link" href={product.url} target="_blank" rel="noopener noreferrer">{product.name}</a>
                        : product.name}</strong>
                      {product.spec && <small className="product-spec">{product.spec}</small>}
                      {product.latestPrice ? <small className="product-spec">{product.latestCurrency || 'CNY'} {formatMoney(product.latestPrice, '')}</small> : null}
                      {product.tags?.length ? <div className="tag-chips">{product.tags.map(tag => <span key={JSON.stringify(tag)} className="tag-chip">{tag.name}：{tag.value}</span>)}</div> : null}
                    </td>
                    <td>{product.shopName ?? product.shop_name ?? `商铺 #${product.shopId ?? product.shop_id ?? ''}`}</td>
                    <td className="standardization-cell">
                      <span className={`standard-product-pill ${product.standardProductName ?? product.standard_product_name ? 'is-assigned' : 'is-unassigned'}`} title={product.standardizationOutcome === 'cannot_process' ? '不能处理：当前商品信息不足或非售卖商品' : product.standardProductName ?? product.standard_product_name ?? '待处理'}>{product.standardizationOutcome === 'cannot_process' ? '不能处理' : product.standardProductName ?? product.standard_product_name ?? '待处理'}</span>
                    </td>
                    <td className="table-time">{formatTime(product.updatedAt ?? product.updated_at)}</td>
                    <td><div className="row-actions">
                      {product.deletedAt ?? product.deleted_at ? (
                        <IconButton action="restore-product" id={product.id} label="恢复商品" icon="rotate-ccw" onClick={(_, id) => productAction({ id }, 'restore')} />
                      ) : (
                        <><IconButton action="choose-standard" id={product.id} label="选择标准商品" icon="link" onClick={() => setPicker({ open: true, productId: product.id })} /><IconButton action="delete-product" id={product.id} label="删除商品" icon="trash-2" onClick={(_, id) => productAction({ id }, 'delete')} /></>
                      )}
                    </div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <EmptyState>暂无商品</EmptyState>}
        </div>
        <Pagination total={products.total} page={products.page} pageSize={PAGE_SIZE} onChange={(page) => setProducts({ ...products, items: [], page })} label="商品" />
      </fieldset> : null}

      {managementTab === 'pending' ? <fieldset role="region" className="pending-products-panel management-panel management-operation-fields" aria-label="待处理商品" disabled={updatingProducts} aria-busy={updatingProducts}>
        <div className="product-toolbar pending-products-toolbar">
          <input aria-label="搜索待处理商品" disabled={updatingProducts} placeholder="搜索商品" value={productQuery} onChange={event => { setProductQuery(event.target.value); setProducts(current => ({ ...current, items: [], page: 1 })); setSelectedProductIds([]); }} />
          <label className="check-line"><input type="checkbox" disabled={updatingProducts} checked={deletedProducts} onChange={event => { setDeletedProducts(event.target.checked); setProducts(current => ({ ...current, items: [], page: 1 })); setSelectedProductIds([]); }} />回收站</label>
        </div>
        {selectedProductIds.length ? <div className="batch-actions">
          <span>已选 {selectedProductIds.length} 件</span>
          {!deletedProducts ? <><button type="button" disabled={updatingProducts} onClick={() => setPicker({ open: true, productId: null })}>绑定标准商品</button>
          <button type="button" disabled={updatingProducts} onClick={() => setBatchTagOpen(true)}>绑定标签</button>
          <button type="button" disabled={updatingProducts} onClick={openStandardCreate}>新增标准商品</button></> : null}
          <button type="button" className={deletedProducts ? '' : 'danger-text'} disabled={updatingProducts} onClick={updateSelectedProducts}>{deletedProducts ? updatingProducts ? '恢复中…' : '批量恢复' : updatingProducts ? '删除中…' : '批量删除'}</button>
          <button type="button" className="quiet-button" disabled={updatingProducts} onClick={() => setSelectedProductIds([])}>清除选择</button>
        </div> : null}
        <div className="data-table-wrap pending-products-table admin-scroll-area">
          {products.items.length ? <table><thead><tr><th><input aria-label="选择本页商品" type="checkbox" disabled={updatingProducts} checked={products.items.length > 0 && products.items.every(product => selectedProductIds.includes(String(product.id)))} onChange={event => setSelectedProductIds(event.target.checked ? [...new Set([...selectedProductIds, ...products.items.map(product => String(product.id))])] : selectedProductIds.filter(id => !products.items.some(product => String(product.id) === id)))} /></th><th>商品 / 规格</th><th>商铺</th><th>待处理原因</th><th>最近更新</th><th>操作</th></tr></thead><tbody>
            {products.items.map(product => <tr key={product.id}><td><input aria-label={`选择 ${product.name}`} type="checkbox" disabled={updatingProducts} checked={selectedProductIds.includes(String(product.id))} onChange={event => setSelectedProductIds(event.target.checked ? [...new Set([...selectedProductIds, String(product.id)])] : selectedProductIds.filter(id => id !== String(product.id)))} /></td><td className="product-cell"><strong title={product.name}>{product.name}</strong>{product.spec && <small className="product-spec">{product.spec}</small>}{product.evidenceConflict ? <small className="evidence-conflict" role="note">{describeEvidenceConflict(product.evidenceConflict)}</small> : null}{product.latestPrice ? <small className="product-spec">{product.latestCurrency || 'CNY'} {formatMoney(product.latestPrice, '')}</small> : null}{product.tags?.length ? <div className="tag-chips">{product.tags.map(tag => <span key={JSON.stringify(tag)} className="tag-chip">{tag.name}：{tag.value}</span>)}</div> : null}</td><td>{product.shopName ?? product.shop_name ?? `商铺 #${product.shopId ?? product.shop_id ?? ''}`}</td><td className="product-cell processing-summary">{product.processingSummary ? <><strong>{PROCESSING_DISPOSITIONS[product.processingSummary.processingDisposition] || '等待处理'}</strong><small>{product.processingSummary.reason}</small></> : <small>暂无处理摘要</small>}</td><td className="table-time">{formatTime(product.updatedAt ?? product.updated_at)}</td><td><div className="row-actions">{product.deletedAt ?? product.deleted_at ? <IconButton action="restore-product" id={product.id} label="恢复商品" icon="rotate-ccw" onClick={(_, id) => productAction({ id }, 'restore')} /> : <><IconButton action="choose-standard" id={product.id} label="选择标准商品" icon="link" onClick={() => setPicker({ open: true, productId: product.id })} /><IconButton action="edit-tags" id={product.id} label="编辑标签" icon="pencil" onClick={() => editTags(product)} /><IconButton action="delete-product" id={product.id} label="删除商品" icon="trash-2" onClick={(_, id) => productAction({ id }, 'delete')} /></>}</div></td></tr>)}
          </tbody></table> : <EmptyState>暂无待处理商品</EmptyState>}
        </div>
        <Pagination total={products.total} page={products.page} pageSize={PAGE_SIZE} onChange={page => setProducts({ ...products, items: [], page })} label="待处理商品" />
      </fieldset> : null}

      {managementTab === 'standard' && standardShopView ? <section className="management-panel standard-shop-members" aria-label="标准商品商铺">
        <div className="standard-member-heading"><h2>商铺管理</h2><button type="button" className="quiet-button" onClick={() => setStandardShopView(null)}>返回标准商品</button></div>
        <ConnectedShops key={standardShopView.id} setMessage={setMessage} initialStandardProduct={standardShopView} onViewProducts={(shop, standardProduct) => openStandardMembers(standardProduct, shop)} onChanged={() => setStandardProductReload(value => value + 1)} />
      </section> : null}
      {managementTab === 'standard' && !standardShopView ? <section id="standard-name-dialog" className="management-panel" aria-label="标准商品">
        <fieldset className="dialog-body management-operation-fields" disabled={updatingStandards} aria-busy={updatingStandards}>
          {selectedStandardIds.length ? <div className="batch-actions standard-batch-actions"><span>已选 {selectedStandardIds.length} 个</span>{selectedStandardIds.length > 1 ? <><select aria-label="合并后保留" value={mergeTargetId} onChange={event => setMergeTargetId(event.target.value)}><option value="">选择保留商品</option>{selectedStandardItemsList.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button type="button" disabled={!mergeTargetId} onClick={mergeSelectedStandards}>合并</button></> : null}<button type="button" onClick={() => setSelectedStandardVisibility(true)}>批量隐藏</button><button type="button" onClick={() => setSelectedStandardVisibility(false)}>批量展示</button><button type="button" className="quiet-button" onClick={() => { setSelectedStandardIds([]); setSelectedStandardItems({}); setMergeTargetId(''); }}>清除选择</button></div> : null}
          <div className="standard-product-toolbar">
            <input className="dialog-search" aria-label="搜索标准商品" placeholder="搜索名称、family、product 或 tier" value={standardProductQuery} onChange={(event) => { setStandardProductQuery(event.target.value); setStandardProducts(current => ({ ...current, items: [], page: 1 })); }} />
            <select aria-label="标准商品状态" value={standardProductStatus} onChange={event => { setStandardProductStatus(event.target.value); setStandardProducts(current => ({ ...current, items: [], page: 1 })); }}>
              <option value="active">展示中</option><option value="hidden">已隐藏</option><option value="merged">已合并</option><option value="all">全部状态</option>
            </select>
            <button type="button" className="primary" onClick={openStandardCreate}>新增标准商品</button>
          </div>
          <p className="management-status-help">默认显示展示中的标准商品。隐藏后不再出现在前台，成员商品与历史记录保留，可切换“已隐藏”批量恢复。</p>
          <div className="standard-products">
            {standardProducts.items.length ? (
              <>
                <div className="standard-product-head"><span className="standard-product-name-head"><input aria-label="选择当前页标准商品" type="checkbox" checked={allStandardProductsOnPageSelected} ref={(element) => { if (element) element.indeterminate = someStandardProductsOnPageSelected; }} onChange={(event) => toggleStandardProductsOnPage(standardProducts.items, event.target.checked)} /><span>身份（family / product / tier）</span></span><span>商品平台</span><span>成员 / 商铺</span><span>状态</span><span>操作</span></div>
                {standardProducts.items.map((standardProduct) => {
                  const id = String(standardProduct.id);
                  const draft = standardProductDrafts[id] ?? {};
                  const identity = standardIdentity(standardProduct);
                  const saving = savingStandardIds.includes(id);
                  return (
                  <div key={standardProduct.id} className="standard-product-row">
                    <div className="standard-product-identity-cell">
                      <label className="standard-product-select"><input type="checkbox" disabled={Boolean(standardProduct.mergedIntoId)} aria-label={`选择 ${standardProduct.name}`} checked={selectedStandardIds.includes(String(standardProduct.id))} onChange={event => toggleStandardSelection(standardProduct, event.target.checked)} /></label>
                      {identity
                        ? <div className="standard-product-identity-editor">
                          <label><span>family</span><input disabled={saving} aria-label={`标准商品 family ${standardProduct.name}`} data-standard-product-family value={draft.family ?? identity[0]} onChange={event => editStandardProduct(id, 'family', event.target.value)} /></label>
                          <label><span>product</span><input disabled={saving} aria-label={`标准商品 product ${standardProduct.name}`} data-standard-product-product value={draft.product ?? identity[1]} onChange={event => editStandardProduct(id, 'product', event.target.value)} /></label>
                          <label><span>tier</span><input disabled={saving} aria-label={`标准商品 tier ${standardProduct.name}`} data-standard-product-tier value={draft.tier ?? identity[2]} onChange={event => editStandardProduct(id, 'tier', event.target.value)} /></label>
                        </div>
                        : <input disabled={saving} aria-label={`标准商品名称 ${standardProduct.name}`} data-standard-product-name value={draft.name ?? standardProduct.name} onChange={event => editStandardProduct(id, 'name', event.target.value)} />}
                      <label className="standard-product-aliases"><span>搜索别名</span><input disabled={saving || Boolean(standardProduct.mergedIntoId)} aria-label={'搜索别名 ' + standardProduct.name} data-standard-product-aliases placeholder="多个别名用逗号分隔" value={draft.aliases ?? (standardProduct.aliases ?? []).join(', ')} onChange={event => editStandardProduct(id, 'aliases', event.target.value)} /></label>
                    </div>
                    <select disabled={saving} aria-label={`标准商品平台 ${standardProduct.name}`} value={draft.platform ?? standardProduct.platform ?? ''} onChange={event => editStandardProduct(id, 'platform', event.target.value)}>
                      <option value="">未分类</option>
                      {standardProduct.platform && !enabledPlatforms.some((platform) => platform.name === standardProduct.platform) ? <option value={standardProduct.platform}>{standardProduct.platform}</option> : null}
                      {enabledPlatforms.map((platform) => <option key={platform.id} value={platform.name}>{platform.name}</option>)}
                    </select>
                    <span className="standard-product-count"><button type="button" className="standard-count-link" aria-label={`查看 ${standardProduct.name} 的原始商品`} onClick={() => openStandardMembers(standardProduct)}>{standardProduct.memberCount ?? standardProduct.member_count ?? 0} 件</button> / <button type="button" className="standard-count-link" aria-label={`查看 ${standardProduct.name} 的商铺`} onClick={() => setStandardShopView(standardProduct)}>{standardProduct.shopCount ?? standardProduct.shop_count ?? 0} 店</button></span>
                    <span className={`status-pill ${standardProduct.mergedIntoId || standardProduct.hidden ? 'is-disabled' : 'is-enabled'}`}>{standardProduct.mergedIntoId ? `已合并至 ${standardProduct.mergedIntoId}` : standardProduct.hidden ? '已隐藏' : '展示中'}</span>
                    <div className="row-actions"><button type="button" className="quiet-button" disabled={Boolean(standardProduct.mergedIntoId) || saving} onClick={(event) => saveStandardProduct(standardProduct, event)}>{saving ? '保存中…' : '保存'}</button><button type="button" className="quiet-button" disabled={Boolean(standardProduct.mergedIntoId) || saving} onClick={async () => { try { await updateStandardVisibility(standardProduct.id, !standardProduct.hidden); setMessage(standardProduct.hidden ? '标准商品已恢复展示' : '标准商品已隐藏'); setStandardProductReload(v => v + 1); } catch (error) { setMessage(error.message); } }}>{standardProduct.hidden ? '恢复展示' : '隐藏'}</button></div>
                  </div>
                  );
                })}
              </>
            ) : <EmptyState>暂无标准商品</EmptyState>}
          </div>
          <Pagination total={standardProducts.total} page={standardProducts.page} pageSize={PAGE_SIZE} onChange={(page) => setStandardProducts({ ...standardProducts, items: [], page })} label="标准商品名" />
        </fieldset>
      </section> : null}

      <ModalDialog className="management-dialog" open={Boolean(tagEditor)} onClose={() => setTagEditor(null)} aria-labelledby="tag-editor-title">
        <form className="dialog-body" onSubmit={saveTags}>
          <div className="dialog-header"><h2 id="tag-editor-title">编辑商品标签</h2><button type="button" aria-label="关闭" onClick={() => setTagEditor(null)}>×</button></div>
          <p className="admin-message">{tagEditor?.product?.name}</p>
          <div className="tag-editor-list">
            {(tagEditor?.items || []).map((tag, index) => <div key={index} className="tag-editor-row">
              <input aria-label={`标签名称 ${index + 1}`} value={tag.name} placeholder="标签名称" maxLength={80} required onChange={event => setTagEditor(current => ({ ...current, items: current.items.map((item, position) => position === index ? { ...item, name: event.target.value } : item) }))} />
              <input aria-label={`标签值 ${index + 1}`} value={tag.value} placeholder="标签值" maxLength={250} required onChange={event => setTagEditor(current => ({ ...current, items: current.items.map((item, position) => position === index ? { ...item, value: event.target.value } : item) }))} />
              <button type="button" aria-label={`删除标签 ${index + 1}`} onClick={() => setTagEditor(current => ({ ...current, items: current.items.filter((_, position) => position !== index) }))}>删除</button>
            </div>)}
          </div>
          <button type="button" onClick={() => setTagEditor(current => ({ ...current, items: [...current.items, { name: '', value: '' }] }))}>新增标签</button>
          <div className="dialog-actions"><button type="button" className="reject" onClick={() => setTagEditor(null)}>取消</button><button className="dialog-submit">保存标签</button></div>
        </form>
      </ModalDialog>

      <ModalDialog className="management-dialog" open={Boolean(tagMergeOpen)} onClose={() => setTagMergeOpen(null)} aria-labelledby="tag-merge-title">
        <form key={tagMergeOpen ? tagMergeOpen.sources.map(tagIdentity).join('|') : 'closed'} className="dialog-body tag-merge-dialog" onSubmit={submitTagMerge}>
          <div className="dialog-header"><h2 id="tag-merge-title">合并标签值</h2><button type="button" aria-label="关闭" onClick={() => setTagMergeOpen(null)}>×</button></div>
          <p className="tag-merge-help">选中的标签值会合并到同一个目标标签，重复关系会自动去重，源标签随后删除。</p>
          <label>源标签<input value={tagMergeOpen?.sources?.map(source => `${source.name}：${source.value}`).join('、') || ''} readOnly /></label>
          <label>目标标签名<input name="nextName" defaultValue={tagMergeOpen?.sources?.[0]?.name || ''} placeholder="例如：地区" required /></label>
          <label>目标标签值<input name="nextValue" defaultValue="" placeholder="例如：中国大陆" required /></label>
          <div className="dialog-actions"><button type="button" className="reject" onClick={() => setTagMergeOpen(null)}>取消</button><button className="dialog-submit">确认合并</button></div>
        </form>
      </ModalDialog>

      {managementTab === 'platforms' ? <section id="platform-dialog" className="management-panel" aria-label="商品平台">
        <fieldset className="dialog-body management-operation-fields" disabled={updatingPlatforms} aria-busy={updatingPlatforms}>
          {selectedPlatformNames.length ? <div className="batch-actions">
            <span>已选 {selectedPlatformNames.length} 个平台</span>
            <button type="button" onClick={() => setSelectedPlatformsEnabled(false)}>批量停用</button>
            <button type="button" onClick={() => setSelectedPlatformsEnabled(true)}>批量启用</button>
            <button type="button" className="quiet-button" onClick={() => setSelectedPlatformNames([])}>清除选择</button>
          </div> : null}
          <div className="platform-toolbar">
            <input aria-label="搜索商品平台" placeholder="搜索商品平台" value={platformQuery} onChange={event => { setPlatformQuery(event.target.value); setPlatforms(current => ({ ...current, items: [], page: 1 })); }} />
            <select aria-label="商品平台状态" value={platformStatus} onChange={event => { setPlatformStatus(event.target.value); setPlatforms(current => ({ ...current, items: [], page: 1 })); }}>
              <option value="enabled">已启用</option><option value="disabled">已停用</option><option value="all">全部状态</option>
            </select>
            <button type="button" className="platform-create-button" onClick={() => setPlatformOpen(true)}>新增商品平台</button>
          </div>
          <p className="management-status-help">停用后禁止用于新增标准商品，已有标准商品及前台展示保持不变；如需下架，请在标准商品页批量隐藏。</p>
          {platforms.items.length ? <label className="platform-page-selection"><input type="checkbox" aria-label="选择当前页商品平台" checked={allPlatformsOnPageSelected} ref={element => { if (element) element.indeterminate = somePlatformsOnPageSelected; }} onChange={event => togglePlatforms(platformNamesOnPage, event.target.checked)} />选择本页</label> : null}
          <div className="platform-list">
            {platforms.items.length ? platforms.items.map((platform) => (
              <div key={platform.id} className="platform-row">
                <div className="platform-identity-cell"><input type="checkbox" aria-label={`选择商品平台 ${platform.name}`} checked={selectedPlatformNames.includes(platform.name)} onChange={event => togglePlatforms([platform.name], event.target.checked)} /><input aria-label={`商品平台名称 ${platform.name}`} defaultValue={platform.name} /></div>
                <span>{platform.standardProductCount ?? platform.standard_product_count ?? 0} 个标准商品 · {platform.enabled === false ? '已停用' : '已启用'}</span>
                <button type="button" className="quiet-button" onClick={(event) => savePlatform(platform, event)}>保存</button>
                <button type="button" className="quiet-button" onClick={async () => { try { if (platform.enabled === false) await requestJson('/api/admin/platforms', { method: 'POST', body: JSON.stringify({ name: platform.name }) }); else await requestJson(`/api/admin/platforms/${encodeURIComponent(platform.id)}`, { method: 'DELETE' }); setSelectedPlatformNames(current => current.filter(name => name !== platform.name)); setPlatformReload(value => value + 1); } catch (error) { setMessage(error.message); } }}>{platform.enabled === false ? '启用' : '停用'}</button>
              </div>
            )) : <EmptyState>暂无商品平台</EmptyState>}
          </div>
          <Pagination total={platforms.total} page={platforms.page} pageSize={PAGE_SIZE} onChange={(page) => setPlatforms({ ...platforms, items: [], page })} label="商品平台" />
        </fieldset>
      </section> : null}

      <ModalDialog className="management-dialog" open={platformOpen} onClose={() => setPlatformOpen(false)} aria-labelledby="create-platform-title">
        <form className="dialog-body" onSubmit={createPlatform}>
          <div className="dialog-header"><h2 id="create-platform-title">新增商品平台</h2><button type="button" aria-label="关闭" onClick={() => setPlatformOpen(false)}>×</button></div>
          <label className="platform-create-field">平台名称<input name="name" placeholder="例如：OpenAI" required /></label>
          <div className="dialog-actions"><button type="button" className="reject" onClick={() => setPlatformOpen(false)}>取消</button><button className="dialog-submit">新增平台</button></div>
        </form>
      </ModalDialog>

      <ModalDialog className="management-dialog standard-create-dialog" open={standardCreateOpen} onClose={() => { if (!standardCreating) setStandardCreateOpen(false); }} aria-labelledby="create-standard-title">
        <form className="dialog-body" onSubmit={createStandardProduct} noValidate aria-busy={standardCreating}>
          <div className="dialog-header"><h2 id="create-standard-title">新增标准商品</h2><button type="button" aria-label="关闭" disabled={standardCreating} onClick={() => setStandardCreateOpen(false)}>×</button></div>
          <div className="standard-create-identity">
            {['family', 'product', 'tier'].map(field => <input key={field} name={field} aria-label={field} placeholder={field} required value={standardCreateIdentity[field]} onChange={event => setStandardCreateIdentity(current => ({ ...current, [field]: event.target.value }))} />)}
          </div>
          <div className="standard-create-platform-picker">
            <input className="standard-create-platform" role="combobox" aria-label="平台" aria-expanded={standardCreatePlatformOpen} aria-controls="standard-create-platform-options" placeholder="搜索平台" value={standardCreatePlatformQuery || standardCreatePlatform} onFocus={() => setStandardCreatePlatformOpen(true)} onChange={event => { setStandardCreatePlatformQuery(event.target.value); setStandardCreatePlatform(''); setStandardCreatePlatformOpen(true); }} />
            <input type="hidden" name="platform" value={standardCreatePlatform} />
            {standardCreatePlatformOpen ? <div id="standard-create-platform-options" className="standard-create-platform-options" role="listbox">
              {visibleStandardCreatePlatforms.length ? visibleStandardCreatePlatforms.map(platform => <button key={platform.id} type="button" role="option" aria-selected={standardCreatePlatform === platform.name} onClick={() => { setStandardCreatePlatform(platform.name); setStandardCreatePlatformQuery(''); setStandardCreatePlatformOpen(false); }}>{platform.name}</button>) : <span className="standard-create-platform-empty">暂无平台</span>}
            </div> : null}
          </div>
          <input className="dialog-search standard-create-search" aria-label="搜索可绑定商品" placeholder="搜索商品" value={standardCreateProductQuery} onChange={event => { setStandardCreateProductQuery(event.target.value); setStandardCreateProducts(current => ({ ...current, page: 1 })); }} />
          <p className="admin-message">可选择全部未删除商品；已绑定商品将在创建后转移至新标准商品。</p>
          {standardCreateSelectedIds.length ? <div className="standard-create-selected">
            <strong>已选 {standardCreateSelectedIds.length} 个</strong>
            <div>{Object.values(standardCreateSelectedItems).map(item => <button key={item.id} type="button" className="standard-create-selected-item" onClick={() => { setStandardCreateSelectedIds(current => current.filter(value => value !== item.id)); setStandardCreateSelectedItems(current => { const next = { ...current }; delete next[item.id]; return next; }); }}>{item.name} ×</button>)}</div>
          </div> : null}
          <div className="standard-create-product-list">
            {standardCreateProducts.items.length ? standardCreateProducts.items.map(productItem => {
              const id = String(productItem.id);
              const selected = standardCreateSelectedIds.includes(id);
              const currentStandard = productItem.standardProductName ?? productItem.standard_product_name;
              return <button key={id} type="button" className={`standard-create-product ${selected ? 'is-selected' : ''}`} aria-pressed={selected} onClick={() => {
                setStandardCreateSelectedIds(current => selected ? current.filter(value => value !== id) : [...current, id]);
                setStandardCreateSelectedItems(current => { const next = { ...current }; if (selected) delete next[id]; else next[id] = { id, name: productItem.name }; return next; });
              }}>
                <span><strong>{productItem.name}</strong><small>{productItem.shopName ?? productItem.shop_name ?? '未知商铺'}{productItem.spec ? ` · ${productItem.spec}` : ''}</small>{currentStandard ? <small>已绑定：{currentStandard}</small> : null}</span>
                <span>{selected ? '已选' : '选择'}</span>
              </button>;
            }) : <EmptyState>暂无商品</EmptyState>}
          </div>
          <Pagination total={standardCreateProducts.total} page={standardCreateProducts.page} pageSize={PAGE_SIZE} onChange={page => setStandardCreateProducts(current => ({ ...current, items: [], page }))} label="可绑定商品" />
          {standardCreateError ? <p className="standard-create-error" role="alert">{standardCreateError}</p> : null}
          <div className="dialog-actions">
            <button type="button" className="reject" disabled={standardCreating} onClick={() => setStandardCreateOpen(false)}>取消</button>
            <button type="submit" className="dialog-submit" disabled={standardCreating}>{standardCreating ? '创建中…' : '创建并绑定'}</button>
          </div>
        </form>
      </ModalDialog>
      <ModalDialog className="management-dialog" open={batchTagOpen} onClose={() => setBatchTagOpen(false)} aria-labelledby="batch-tag-title"><form className="dialog-body" onSubmit={bindSelectedTags}><div className="dialog-header"><h2 id="batch-tag-title">绑定标签</h2><button type="button" aria-label="关闭" onClick={() => setBatchTagOpen(false)}>×</button></div><input name="name" aria-label="标签名称" placeholder="标签名称" required /><input name="value" aria-label="标签值" placeholder="标签值" required /><div className="dialog-actions"><button type="button" onClick={() => setBatchTagOpen(false)}>取消</button><button className="dialog-submit">绑定到 {selectedProductIds.length} 件商品</button></div></form></ModalDialog>

      {picker.open ? <StandardProductPicker onClose={() => setPicker({ open: false, productId: null })} onSelect={item => chooseStandardProduct(item.id)} /> : null}

    </section>
  );
}

export default function AdminPage({ initialAuthenticated = false }) {
  const [authenticated, setAuthenticated] = useState(initialAuthenticated ? 'authenticated' : 'checking');
  const [activeSection, setActiveSection] = useState('pending-shops');
  const [message, setMessage] = useState('');
  const [loginError, setLoginError] = useState('');

  useEffect(() => {
    let active = true;
    requestJson('/api/auth/me')
      .then(() => active && setAuthenticated('authenticated'))
      .catch(() => active && setAuthenticated('anonymous'));
    return () => { active = false; };
  }, []);

  if (authenticated === 'checking') return <section className="login-view"><div className="login-card"><p>正在检查登录状态…</p></div></section>;

  if (authenticated !== 'authenticated') {
    const login = async (event) => {
      event.preventDefault();
      const password = new FormData(event.currentTarget).get('password');
      try {
        await requestJson('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) });
        setAuthenticated('authenticated');
        setActiveSection('pending-shops');
      } catch {
        setLoginError('密码不正确，请重试');
      }
    };
    return (
      <section className="login-view">
        <div className="login-card">
          <Brand admin className="login-brand" />
          <p className="eyebrow">PRICE RADAR / ADMIN</p><h1>管理端登录</h1><p>管理商铺、商品标准名称与分类。</p>
          <form onSubmit={login}><label>管理员密码<input name="password" type="password" required /></label><button>登录管理端</button></form>
          {loginError ? <p role="alert">{loginError}</p> : null}
          <a href="/">返回公开比价页</a>
        </div>
      </section>
    );
  }

  const sections = {
    'visitor-analytics': <VisitorAnalytics />,
    'pending-shops': <PendingShops setMessage={setMessage} />,
    'product-reports': <ProductReports setMessage={setMessage} />,
    'connected-shops': <ConnectedShops setMessage={setMessage} />,
    'standard-products': <ProductManagement setMessage={setMessage} />,
  };
  const logout = async () => {
    await requestJson('/api/auth/logout', { method: 'POST' }).catch(() => {});
    window.location.reload();
  };

  return (
    <section id="panel" className="admin-app">
      <aside className="admin-sidebar">
        <Brand admin />
        <nav>
          {[['pending-shops', '商铺审核'], ['product-reports', '商品举报'], ['connected-shops', '商铺管理'], ['standard-products', '商品管理'], ['visitor-analytics', '访问统计']].map(([id, label]) => (
            <button key={id} type="button" className={`nav-item ${activeSection === id ? 'active' : ''}`} onClick={() => { setActiveSection(id); setMessage(''); }}>{label}</button>
          ))}
        </nav>
        <div className="sidebar-bottom"><a href="/">查看前台</a><button type="button" className="quiet-button" onClick={logout}>退出登录</button></div>
      </aside>
      <main className="admin-main">
        <p className="admin-message" role="status" hidden={!message}>{message}</p>
        {sections[activeSection]}
      </main>
    </section>
  );
}
