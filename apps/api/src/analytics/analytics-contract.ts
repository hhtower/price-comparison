import { REFERENCE_APPS } from '../official-reference/official-reference.catalog.js';

// Keep categories and reference identities bounded: never accept URLs or free-form labels.
export const ANALYTICS_PAGES = { catalog: '商品比价', tools_ai: 'AI 检测', tools_ip: 'IP 检测' } as const;
export const REFERENCE_ACTIONS = { reference_open: '打开官网正价参考', reference_product: '切换参考产品', reference_plans_open: '展开参考套餐', reference_plan_select: '选择参考套餐' } as const;
const referenceActions = Object.keys(REFERENCE_ACTIONS) as (keyof typeof REFERENCE_ACTIONS)[];
export const ANALYTICS_ACTIONS = { search: '商品搜索', filter: '筛选商品', product_detail: '查看商品详情', outbound: '前往商家', shop_submit: '提交商铺', report_submit: '提交举报', ai_test: '发起 AI 检测', ip_test: '发起 IP 检测', ...REFERENCE_ACTIONS } as const;
export const PAGE_ACTIONS = { catalog: ['search', 'filter', 'product_detail', 'outbound', 'shop_submit', 'report_submit', ...referenceActions], tools_ai: ['ai_test', ...referenceActions], tools_ip: ['ip_test', ...referenceActions] } as const;
export const ANALYTICS_DEVICES = { desktop: '桌面', mobile: '手机', tablet: '平板' } as const;
export const ANALYTICS_BROWSERS = { chrome: 'Chrome', edge: 'Edge', firefox: 'Firefox', safari: 'Safari', other: '其他' } as const;
export const ANALYTICS_SOURCES = { direct: '直接访问', internal: '站内跳转', external: '外部来源' } as const;
export type AnalyticsPage = keyof typeof ANALYTICS_PAGES;
export interface AnalyticsReference { appId: string; planId?: string; }
export function validReferenceContext(name: unknown, value: unknown): boolean {
  if (name !== 'reference_product' && name !== 'reference_plans_open' && name !== 'reference_plan_select') return value === undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const context = value as Record<string, unknown>;
  const hasPlan = name === 'reference_plan_select';
  const allowed = hasPlan ? ['appId', 'planId'] : ['appId'];
  if (Object.keys(context).some(key => !allowed.includes(key)) || !REFERENCE_APPS.some(app => app.id === context.appId)) return false;
  if (!hasPlan) return true;
  // This is the exact catalog key: stable numeric Apple SKU, purchase kind, ISO period.
  return typeof context.planId === 'string' && context.planId.length <= 96
    && /^\["[0-9]{5,14}",(?:(?:"subscription",(?:null|"P[1-9][0-9]{0,3}[DWMY]"))|(?:"purchase",null))\]$/.test(context.planId);
}
export interface AnalyticsCollection {
  visitId: string; visitorId: string; sessionId: string; page: AnalyticsPage;
  device: keyof typeof ANALYTICS_DEVICES; browser: keyof typeof ANALYTICS_BROWSERS; source: keyof typeof ANALYTICS_SOURCES;
  activeMs: number; actions: { id: string; name: keyof typeof ANALYTICS_ACTIONS; reference?: AnalyticsReference }[];
}
export interface AnalyticsQuery { days: number; page: number; limit: number; }
export interface AnalyticsPeriod { start: string; end: string; days: number; timezone: 'Asia/Shanghai'; }
