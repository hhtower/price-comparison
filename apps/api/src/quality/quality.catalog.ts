import type { QualityCatalogItem, QualityKind, QualityMode } from './quality.types.js';
const all: QualityMode[] = ['quick', 'standard', 'full'];
const standard: QualityMode[] = ['standard', 'full'];
const full: QualityMode[] = ['full'];
const ai = (id: string, label: string, group: string, modes = standard, required = false): QualityCatalogItem => ({ id, label, group, modes, ...(required ? { required } : {}) });
const ip = (id: string, label: string, group: string, proxyOnly = false): QualityCatalogItem => ({ id, label, group, ...(proxyOnly ? { proxyOnly } : {}) });
// Public metadata only. Probe content and scoring policy never enter this response.
export const QUALITY_CATALOG: Record<QualityKind, QualityCatalogItem[]> = {
  ai: [
    ai('connectivity', '基础连通性', '协议兼容', all, true),
    ai('model-identity', '模型名称一致性', '模型真实性', all),
    ai('fingerprint-match', '指纹一致性', '模型真实性'),
    ai('iq-test', '智商测试', '推理能力'),
    ai('math-reasoning', '数学推理', '推理能力'),
    ai('logic-reasoning', '逻辑推理', '推理能力'),
    ai('instruction-following', '指令遵循', '推理能力'),
    ai('tool-calling', '工具调用', '能力完整度'),
    ai('structured-output', '结构化输出', '能力完整度'),
    ai('long-context', '长上下文', '能力完整度', full),
    ai('multimodal', '多模态', '能力完整度', full),
    ai('pdf', 'PDF', '能力完整度', full),
    ai('multi-turn', '多轮一致性', '推理能力', full),
    ai('streaming', '流式协议', '协议兼容', all, true),
    ai('token-usage', 'Token 用量', '协议兼容'),
    ai('stability', '请求稳定性', '稳定性与性能'),
    ai('latency', '响应速度', '稳定性与性能', all),
  ],
  ip: [
    ip('geo', '归属信息', 'IP 身份'), ip('asn', 'ASN / 组织', 'IP 身份'), ip('reverse-dns', '反向解析', 'IP 身份'),
    ip('ip-type', '出口类型', 'IP 类型'), ip('provider', '网络组织', 'IP 类型'),
    ip('risk-score', '风险信号', '风险信誉'), ip('blacklist', '黑名单', '风险信誉'), ip('abuse', '滥用记录', '风险信誉'),
    ip('ai-access', 'AI 服务可达', 'AI 服务', true), ip('region-limit', '地区限制', 'AI 服务', true),
    ip('latency', '延迟', '网络质量', true), ip('packet-loss', 'TCP 丢包', '网络质量', true), ip('dns', 'DNS', '网络质量', true),
    ip('success-rate', '成功率', '连通稳定', true), ip('egress', '出口一致性', '连通稳定', true),
    ip('header-leak', '代理头暴露', '匿名性', true),
    ip('streaming', '流媒体', '扩展服务', true), ip('mail', '邮箱端口', '扩展服务', true),
  ],
};
