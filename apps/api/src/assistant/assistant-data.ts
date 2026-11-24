import { emptyShoppingNeeds, validateShoppingNeeds, type ShoppingNeeds } from '@price-comparison/catalog/assistant-contract';
import { catalogNameMatch } from '@price-comparison/catalog/catalog-search';
import { membershipGroupKinds, membershipFilterKinds, membershipKindLabel, isNewcomerMembership } from '@price-comparison/catalog/membership-policy';
import { CATALOG_PLATFORMS, groupCatalogPlatforms } from '@price-comparison/catalog/platform-groups';
import { PURCHASE_ATTRIBUTE_DEFINITIONS, purchaseTagLabel } from '@price-comparison/catalog/purchase-attributes';
import type { CatalogPage, PublicCatalogProduct } from '../catalog/catalog.repository.js';
import { normalizeCatalogQuery, type CatalogQuery, type CatalogService } from '../catalog/catalog.service.js';
import { matchesRequestedProduct } from './assistant-candidates.js';

export interface CatalogDataRequest {
  tool: 'statistics' | 'history';
  scope: 'catalog' | 'current';
  filters?: Partial<ShoppingNeeds>;
  groupBy?: 'none' | 'membership' | 'platform';
  currency?: string;
}

export interface AssistantFact {
  id: string;
  title: string;
  text: string;
  summary?: string;
  critical?: boolean;
  path?: string;
}

export async function readAssistantData(
  request: CatalogDataRequest, needs: ShoppingNeeds, catalog: CatalogService, signal: AbortSignal, now: Date,
): Promise<Array<Omit<AssistantFact, 'id'>>> {
  signal.throwIfAborted();
  const scope = request.scope === 'catalog' ? '全目录（本次筛选）' : '当前条件（含本次调整）';
  const prefix = `查询时间 ${now.toISOString()}；范围：${scope}。`;
  const fact = (title: string, text: string, summary: string, path = '/', critical = false): Omit<AssistantFact, 'id'> =>
    ({ title, text: `${title}：${text}`, summary, path, ...(critical ? { critical: true } : {}) });
  const unavailable = (text: string) => [fact('数据不可用', prefix + text, text, '/', true)];
  let reads = 0;
  const read = async <T>(loader: () => Promise<T>): Promise<T> => {
    signal.throwIfAborted();
    if (++reads > 8) throw new Error('Assistant data read limit');
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
    });
    try {
      // CatalogService has no abort parameter; stop awaiting and never schedule another read.
      const value = await Promise.race([loader(), cancelled]);
      signal.throwIfAborted();
      return value;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  };

  let selected: ShoppingNeeds;
  let query: CatalogQuery;
  try {
    if (!['statistics', 'history'].includes(request.tool) || !['catalog', 'current'].includes(request.scope)
      || (request.groupBy !== undefined && !['none', 'membership', 'platform'].includes(request.groupBy))) {
      return unavailable('查询类型或范围无效。');
    }
    selected = validateShoppingNeeds({
      ...(request.scope === 'catalog' ? { ...emptyShoppingNeeds(), newcomer: false } : needs),
      ...request.filters,
    });
    if (request.currency !== undefined && selected.budget && request.currency !== selected.budget.currency) {
      return unavailable('请求币种与预算币种冲突；不支持保留原金额换币查询，请明确新预算或清除预算。');
    }
    if (selected.purpose && !selected.platform && !selected.product) {
      return unavailable('不支持仅凭用途统计或查询历史，请先指定平台或商品。');
    }
    const tags = [...selected.requiredTags];
    if (selected.budget?.basis === 'month') {
      const duration = tags.find(tag => tag.name === 'duration');
      if (duration && duration.value !== 30) {
        return unavailable('月预算仅支持精确 30 天，已有期限条件与月预算冲突；不进行年价折月价或期限换算。');
      }
      if (!duration) tags.push({ name: 'duration', value: 30 });
    }
    query = normalizeCatalogQuery({
      platform: selected.platform ?? undefined, tags, limit: 1,
      priceMax: selected.budget?.amount,
      currency: request.currency ?? selected.budget?.currency ?? 'CNY',
      newcomer: selected.newcomer ?? true, membershipKinds: selected.membershipKinds ?? undefined,
    });
  } catch {
    return unavailable('筛选条件无效或不支持；未执行目录查询。');
  }

  const currency = query.currency!;
  const currencyLabel = `${currency}${!request.currency && !selected.budget ? '（默认币种）' : ''}`;
  const membership = query.membershipKinds?.map(kind => membershipKindLabel(kind)).join('、')
    ?? (query.newcomer ? '新手范围（AI会员限成品号、代充；保留非会员）' : '全部类别');
  const scopeFact = () => fact('查询范围', [
    prefix,
    `币种 ${currencyLabel}；平台 ${selected.platform ?? '全部'}；商品 ${selected.product ?? '全部'}；类别 ${membership}。`,
    ...(query.priceMax ? [`预算上限 ${query.priceMax} ${currency}，${selected.budget?.basis === 'month' ? '月预算仅精确 30 天' : '单次购买预算'}。`] : []),
    ...(query.tags.length ? [`标签：${query.tags.map(tag =>
      `${PURCHASE_ATTRIBUTE_DEFINITIONS.find(field => field.name === tag.name)?.label ?? tag.name}=${purchaseTagLabel(tag)}`).join('；')}。`] : []),
    '统计数量不代表所有商品都符合实际购买要求；是否适合用途、购买数量和具体条件仍需逐项核对，偏好不用于排除商品。',
  ].join(''), '按本次条件统计；商品是否符合实际购买要求仍需核对，完整筛选条件见详情。');

  try {
    if (request.tool === 'history' && (query.priceMax !== undefined || query.tags.length)) {
      return unavailable(`币种 ${currencyLabel}；历史暂不支持预算和商品标签筛选（包括期限），本次保留这些条件，未查询历史价格。`);
    }
    if (request.tool === 'history' && !selected.product && !selected.platform) {
      return unavailable(`币种 ${currencyLabel}；请指定可唯一确定的公开商品后查询历史。`);
    }
    let product: PublicCatalogProduct | undefined;
    if (selected.product || request.tool === 'history') {
      const products = (await read(() => catalog.getProducts())).items
        .filter(product => !product.mergedIntoId && matchesRequestedProduct(product, selected));
      const requestedProduct = selected.product;
      const exact = requestedProduct ? products.filter(product => [product.name, ...product.identityNames ?? []]
        .some(name => catalogNameMatch(name, requestedProduct) === 2)) : [];
      const unique = [...new Map((exact.length ? exact : products).map(product => [product.id, product])).values()];
      if (!unique.length) return unavailable(`币种 ${currencyLabel}；未找到符合平台与商品名称的公开商品。`);
      if (unique.length !== 1) {
        return unavailable(`币种 ${currencyLabel}；名称匹配多个公开标准商品（${unique.length} 个），无法唯一确定，请补充平台或套餐名。`);
      }
      product = unique[0]!;
      query = normalizeCatalogQuery({ ...query, standardProductId: product.id });
    }

    if (request.tool === 'history') {
      const path = `/products/${query.standardProductId!}`;
      const history = await read(() => catalog.getPriceHistory(query.standardProductId!, undefined, currency, {
        ...(query.membershipKinds ? { membershipKinds: query.membershipKinds } : {}),
        ...(query.newcomer ? { newcomer: true } : {}),
      }));
      if (!history) return unavailable(`币种 ${currencyLabel}；该公开商品的历史数据当前不可用。`);
      if (history.currency !== currency) return unavailable(`币种 ${currencyLabel}；历史返回币种与请求不一致，不能提供此摘要。`);
      const window = `${prefix}商品 ${product!.name}；币种 ${currencyLabel}；类别 ${membership}；${history.startDate} 至 ${history.endDate}（Asia/Shanghai，${history.days} 天窗口）。`;
      const summaryWindow = `价格历史（${currency}）：${history.startDate}至${history.endDate}`;
      if (!history.points.length) return [fact('价格历史', `${window}暂无已核验历史记录；不能据此认定价格未变。`,
        `${summaryWindow}，暂无已核验历史记录，不能据此认定价格未变。`, path, true)];
      const points = [...history.points].sort((a, b) => a.date.localeCompare(b.date));
      const first = points[0]!;
      const last = points.at(-1)!;
      const observation = (point: typeof first) => `${point.date}：${point.price} ${currency}，该笔数量 ${point.quantity} 件`;
      const summary = `${summaryWindow}，${points.length}天有记录。每日最低结算总价：`
        + `最早 ${first.price} ${currency}（${first.quantity} 件），最近 ${last.price} ${currency}（${last.quantity} 件）。`;
      return [fact('价格历史', `${window}共有 ${points.length} 天的每日最低已核验结算总价记录。`
        + `最早记录 ${observation(first)}；最近记录 ${observation(last)}。`
        + '缺测日期不补值；记录可能来自不同商家、规格、数量及期限，不代表同一报价连续涨跌，不按件或按月折算。'
        + '会员类别依据当前分类；仅包含当前仍公开关联商品的历史，非全市场历史价格。',
      summary, path)];
    }

    const total = await read(() => catalog.getCatalog(query));
    const counts = (page: CatalogPage) => `公开标准商品 ${page.total} 个；报价 ${page.offerTotal === undefined ? '计数不可用' : `${page.offerTotal} 条`}。`;
    const countSummary = (label: string, page: CatalogPage) =>
      `${label}：标准商品 ${page.total} 个，报价 ${page.offerTotal === undefined ? '计数不可用' : `${page.offerTotal} 条`}（${currency}）。`;
    const facts = [scopeFact(), fact('目录总计', `${currencyLabel}；${counts(total)}按全部匹配记录统计，不仅是当前页面展示的条目。`,
      countSummary(request.scope === 'catalog' ? '公开目录' : '当前筛选', total), '/', total.offerTotal === undefined)];
    if (request.groupBy === 'membership') {
      const kinds = query.membershipKinds ?? membershipGroupKinds(product?.identity)
        .filter(kind => !query.newcomer || isNewcomerMembership(kind));
      for (const kind of kinds) {
        const group = await read(() => catalog.getCatalog(normalizeCatalogQuery({ ...query,
          membershipKinds: query.membershipKinds ? [kind] : membershipFilterKinds(kind, product?.identity) })));
        const label = `会员分组：${membershipKindLabel(kind, product?.identity)}`;
        facts.push(fact(label, `${currency}；保留相同筛选，${counts(group)}`,
          countSummary(label, group), '/', group.offerTotal === undefined));
      }
      facts.push(fact('会员分组口径', '仅对AI会员分组，非会员不在会员分组内；标准商品可能跨组重复，分组标准商品数不能相加作为总数。',
        '会员分组仅覆盖AI会员，同一标准商品可能跨组出现，不能相加。'));
    } else if (request.groupBy === 'platform') {
      if (query.platform || product) {
        const platform = query.platform ?? product!.platformGroup ?? groupCatalogPlatforms([product!.platform])[0]!;
        const label = CATALOG_PLATFORMS.find(group => group.id === platform)?.label ?? (platform === 'other' ? '其他' : platform);
        facts.push(fact(`平台分组：${label}`, `${currency}；保留已选平台与商品范围，${counts(total)}`,
          countSummary(`平台分组：${label}`, total), '/', total.offerTotal === undefined));
      } else {
        for (const platform of [...CATALOG_PLATFORMS, { id: 'other', label: '其他' }]) {
          const group = await read(() => catalog.getCatalog(normalizeCatalogQuery({ ...query, platform: platform.id })));
          facts.push(fact(`平台分组：${platform.label}`, `${currency}；保留相同筛选，${counts(group)}`,
            countSummary(`平台分组：${platform.label}`, group), '/', group.offerTotal === undefined));
        }
      }
    } else if (request.scope === 'catalog' && !query.platform && !query.standardProductId
      && !query.priceMax && !query.tags.length && !query.newcomer && !query.membershipKinds) {
      const coverage = await read(() => catalog.getCoverage());
      facts.push(fact('采集覆盖', `全站采集覆盖 ${coverage.shopCount} 家店铺、${coverage.productCount} 个来源商品；`
        + '不按本次币种或公开状态筛选，不是公开标准商品数或当前报价数。',
      `采集覆盖：${coverage.shopCount} 家店铺、${coverage.productCount} 个来源商品，不等于公开目录的商品或报价数。`));
    }
    facts.push(fact('统计说明', '价格分布和平均价：暂不支持统计，不能用当前页面的少量报价估算。分组数据可能存在更新时差。',
      '暂不支持价格分布和平均价；各分组数据可能有更新时差。'));
    return facts;
  } catch {
    signal.throwIfAborted();
    return unavailable(`币种 ${currencyLabel}；目录数据暂时不可用，未生成估算结果，请稍后重试。`);
  }
}
