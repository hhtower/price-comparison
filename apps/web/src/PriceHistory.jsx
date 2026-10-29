import React, { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { requestJson } from './api.js';
import { formatMoney } from './money.js';

function sameConditions(a, b) {
  return a.productId === b.productId && a.contentVersion === b.contentVersion
    && a.quantity === b.quantity && a.paymentMethod === b.paymentMethod;
}

function HistoryChart({ points, currency, individual, startDate, endDate }) {
  const start = Date.parse(startDate);
  const end = Date.parse(endDate);
  const prices = points.map(point => Number(point.price));
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const rawStep = Math.max((high - low || Math.max(high * 0.1, 0.02)) / 4, 0.01);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 5, 10].find(value => value * magnitude >= rawStep) * magnitude;
  const bottom = Math.floor(low / step) * step;
  const top = Math.max(bottom + step, Math.ceil(high / step) * step);
  const priceTicks = Array.from({ length: Math.round((top - bottom) / step) + 1 }, (_, index) => bottom + index * step);
  const x = date => 66 + (Date.parse(date) - start) / (end - start) * 452;
  const y = price => 24 + (top - Number(price)) / (top - bottom) * 128;
  const label = individual ? '该报价每日最低结算单价走势' : '商品每日最低结算单价走势';
  return <svg className="price-history-chart" viewBox="0 0 540 190" role="img" aria-label={label}>
    <title>{label}，最低 {formatMoney(low, currency)}，最高 {formatMoney(high, currency)}</title>
    {priceTicks.map(price => <g key={price}>
      <line x1="66" y1={y(price)} x2="518" y2={y(price)} className="price-history-grid" />
      <text x="4" y={y(price) + 4}>{formatMoney(price, currency)}</text>
    </g>)}
    {[0, 7, 14, 21, 29].map((day, index) => {
      const date = new Date(start + day * 86400000).toISOString().slice(0, 10);
      return <g key={date}>
        <line x1={x(date)} y1="24" x2={x(date)} y2="157" className="price-history-grid" />
        <text x={x(date)} y="181" textAnchor={index === 0 ? 'start' : index === 4 ? 'end' : 'middle'}>{date.slice(5)}</text>
      </g>;
    })}
    {points.map((point, index) => {
      const previous = points[index - 1];
      const adjacent = previous && Date.parse(point.date) - Date.parse(previous.date) === 86400000;
      return <g key={point.date}>
        {adjacent && (!individual || sameConditions(previous, point)) ? <line className="price-history-segment" x1={x(previous.date)} y1={y(previous.price)} x2={x(point.date)} y2={y(point.price)} /> : null}
        <circle cx={x(point.date)} cy={y(point.price)} r="4"><title>{point.date} · {formatMoney(point.price, currency)} · {point.shop} · {point.name} · {point.quantity}件起购</title></circle>
      </g>;
    })}
  </svg>;
}

export default function PriceHistory({ standardProductId, productId, currency = 'CNY' }) {
  const [open, setOpen] = useState(!productId);
  const id = useId();
  const params = new URLSearchParams({ currency, ...(productId ? { productId } : {}) });
  const url = `/api/catalog/products/${encodeURIComponent(standardProductId)}/price-history?${params}`;
  const query = useQuery({ queryKey: ['price-history', url], enabled: open,
    queryFn: ({ signal }) => requestJson(url, { signal }), staleTime: 60000, retry: false });
  const points = query.data?.points || [];
  const individual = Boolean(productId);
  return <section className={`price-history${individual ? ' price-history-individual' : ''}`} aria-label={individual ? '商家报价价格历史' : '商品价格历史'}>
    <button type="button" className="price-history-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
      <span>{individual ? '价格历史' : '近30天价格走势'}</span><span aria-hidden="true">{open ? '收起 −' : '展开 +'}</span>
    </button>
    {open ? <div id={id} className="price-history-content">
      {query.isPending ? <p role="status">正在加载价格历史…</p> : query.isError ? <div role="alert">价格历史加载失败 <button type="button" className="text-button" onClick={() => query.refetch()}>重试</button></div>
        : !points.length ? <p>近30天暂无已记录的结算价格，后续核验后会逐步积累。</p> : <>
          <div className="price-history-summary"><span>记录内最低 <strong>{formatMoney(Math.min(...points.map(point => Number(point.price))), currency)}</strong></span><span>{points.length} 天有记录 · {currency}</span></div>
          <HistoryChart points={points} currency={currency} individual={individual} startDate={query.data.startDate} endDate={query.data.endDate} />
          <details className="price-history-records"><summary>查看每日记录</summary><div className="price-history-table"><table aria-label="每日价格记录">
            <thead><tr><th scope="col">日期</th><th scope="col">最低单价</th><th scope="col">对应报价与条件</th></tr></thead>
            <tbody>{points.map(point => <tr key={point.date}><td><time dateTime={point.date}>{point.date}</time></td><td>{formatMoney(point.price, currency)}</td><td>{point.shop} · {point.name}<br />{point.quantity > 1 ? `${point.quantity}件起购` : '单件'} · {point.paymentMethod}{point.spec ? ` · ${point.spec}` : ''}<br /><time dateTime={point.verifiedAt}>{new Date(point.verifiedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} 核验</time></td></tr>)}</tbody>
          </table></div></details>
        </>}
    </div> : null}
  </section>;
}
