import assert from 'node:assert/strict';
import test from 'node:test';
import { isExcludedApiRelay } from '../src/standardization/catalog-exclusion.js';
import { buildExtractionPayload } from '../src/ai/adaptive-batching.js';

test('explicit model API relay products are excluded before an LLM request', async () => {
  for (const name of [
    'Codex API 中转充值 100刀',
    'DeepSeek API 日卡 1500请求调用券',
    'Claude API credits 额度充值',
    '通用模型 API 号池月卡',
  ]) assert.equal(isExcludedApiRelay({ name }), true, name);

  assert.equal(isExcludedApiRelay({ name: '模型工具服务', sourceData: {
    evidence: '实际只交付模型中转 API URL 和 API KEY，Claude 号池余额。',
  } }), true);
  assert.equal(isExcludedApiRelay({ name: 'API积分-50条', sourceData: { description: '本卡密50积分，1积分=1条，API额度积分。' } }), true);
  const frozen = buildExtractionPayload({ id: 'relay', name: 'Codex API 中转充值 100刀', spec: '', sourceData: {} });
  assert.equal(isExcludedApiRelay(frozen, 'text'), true);
});

test('catalog relay metadata and endpoint evidence are excluded before an LLM request', async () => {
  assert.equal(isExcludedApiRelay({
    name: '100元余额卡', category: '模型 API 中转', sourceData: { apiEndpoint: 'https://relay.invalid/v1' },
  }), true);
  assert.equal(isExcludedApiRelay({
    name: '100元余额卡', category: '模型 API 中转', sourceData: {},
  }), false);
  assert.equal(isExcludedApiRelay({
    name: '100元余额卡', sourceData: { apiEndpoint: 'https://relay.invalid/v1' },
  }), false);
});

test('model API relay risk disclaimers alone remain eligible for LLM review', async () => {
  assert.equal(isExcludedApiRelay({
    name: '【正规实付】Super Grok 12个月年卡 全程质保订阅',
    sourceData: { evidence: '账号封禁无售后：官方风控导致的账号封禁，99% 是由于违规使用（例如 API 中转、频繁切换节点），因此封号不在质保范围。' },
  }), false);
  assert.equal(isExcludedApiRelay({
    name: '普通会员年卡', sourceData: { evidence: 'API中转属于违规使用，封号不在售后范围。' },
  }), false);
});

test('incidental API, balance and policy-warning evidence stays eligible for LLM review', async () => {
  const ambiguous = [
    { name: 'ChatGPT Plus 账号', sourceData: { evidence: 'API中转教程与使用说明。' } },
    { name: 'API服务', sourceData: { evidence: '实际交付 API URL 和 API KEY。' } },
    { name: 'Tavily API 每月1000次额度' },
    { name: 'Tavily API 每月1000次搜索额度' },
    { name: 'Tavily API 每月1000次额度', sourceData: { evidence: '实际交付 API Key，每月1000次搜索额度，供 Claude 和 Codex 模型调用。' } },
    { name: 'OpenAI 短信 API 接码服务' },
    { name: 'Codex API 接入教程' },
    { name: 'Codex 250额度（充值到你的账号）' },
    { name: 'Codex API 中转充值 100刀', sourceData: { evidence: '实际只交付 Codex 账号，充值到买家自己的账号。' } },
    { name: 'Claude API 服务' },
  ];
  for (const evidence of ambiguous) assert.equal(isExcludedApiRelay(evidence), false, evidence.name);
});
