import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeEvidenceText } from '../src/standardization/service-evidence.js';
import { normalizeProductEvidence, productContentFingerprint } from '../src/standardization/fingerprint.js';
import { chooseNameConsensus, compatibleNameConsensus, nameConsensusKey, type ConsensusMember } from '../src/standardization/name-consensus.js';

const listing = (endpoint: string, seller = '商家甲') => ({ name: '通用模型 API 中转服务 充值余额', spec: '100 credits', sourceData: { service: { name: 'Relay', url: endpoint }, user: { nickname: seller }, evidence: '支持 ChatGPT、Claude 和 Gemini 模型' } });

test('quoted credential keys and values including spaces and escaped quotes are redacted',()=>{
  const text=sanitizeEvidenceText(`{"password":"hidden","api_key":"private","secret":"has spaces","access_token":"escaped\\"quote"} 'refresh_token'='single secret' password=plain`);
  for(const secret of ['hidden','private','has spaces','escaped','quote','single secret','plain']) assert.ok(!text.includes(secret),text);
  assert.equal((text.match(/\[redacted\]/gu)??[]).length,6);
});

test('controlled service endpoints remain identity evidence even when carried by URL fields', () => {
  assert.equal(productContentFingerprint(listing('https://alpha.invalid/v1')), productContentFingerprint(listing('https://beta.invalid/v1')));
  assert.notEqual(nameConsensusKey(listing('https://alpha.invalid/v1')), nameConsensusKey(listing('https://beta.invalid/v1')));
  assert.equal(productContentFingerprint(listing('https://alpha.invalid/v1', '商家甲')), productContentFingerprint(listing('https://alpha.invalid/v1', '商家乙')));
  assert.deepEqual(normalizeProductEvidence(listing('https://alpha.invalid/v1')).sourceData.serviceEvidence, { endpoints: ['https://alpha.invalid/v1'], brands: ['Relay'] });
});

test('service credentials never enter normalized payloads or change product identity', () => {
  const a = listing('https://alice:password@alpha.invalid/v1?api_key=first#token');
  const b = listing('https://bob:different@alpha.invalid/v1?api_key=second#other');
  assert.equal(productContentFingerprint(a), productContentFingerprint(b));
  const normalized = JSON.stringify(normalizeProductEvidence(a));
  for (const credential of ['alice', 'password', 'first', '#token']) assert.equal(normalized.includes(credential), false);
  assert.ok(normalized.includes('https://alpha.invalid/v1'));
});

test('labelled body endpoints are sanitized while shop, tutorial and support URLs are not service providers', () => {
  const input = { name: '模型 API 充值', sourceData: { url: 'https://shop.invalid/goods/1', description: '服务端点：https://alice:secret@relay.invalid/v1?token=hidden；教程：https://docs.invalid/help；客服：https://support.invalid' } };
  const normalized = normalizeProductEvidence(input);
  assert.deepEqual(normalized.sourceData.serviceEvidence, { endpoints: ['https://relay.invalid/v1'], brands: [] });
  for (const credential of ['alice', 'secret', 'hidden']) assert.equal(JSON.stringify(normalized).includes(credential), false);
});

test('API name consensus cannot merge different relays or establish a provider from identical generic text', () => {
  const member = (id: bigint, endpoint: string): ConsensusMember => ({ ...listing(endpoint), id, standardProductId: 1n, identity: { family: 'relay', product: 'api', tier: 'standard' }, assignmentSource: 'ai', locked: false, revision: 0n, contentVersion: 1n, contentFingerprint: 'stored-source-hash' });
  const a = member(1n, 'https://alpha.invalid/v1');
  const winners = chooseNameConsensus([a, member(2n, 'https://alpha.invalid/v1')]);
  assert.equal(compatibleNameConsensus(listing('https://beta.invalid/v1'), winners), undefined);
  assert.equal(compatibleNameConsensus(listing('https://alpha.invalid/v1'), winners), undefined, 'relay credits are excluded even with an identical provider');
  assert.equal(nameConsensusKey({ name: '通用模型 API 中转服务 充值余额', sourceData: { user: { nickname: 'Relay' }, description: '支持 ChatGPT Claude Gemini' } }), null);
});

test('normalization is idempotent and does not retain credential material in nested provider fields', () => {
  const input = { ...listing('https://relay.invalid/v1'), sourceData: { apiEndpoint: 'https://user:secret@relay.invalid/v1?key=hidden', serviceBrand: 'Relay', api_key: 'api-secret', description: 'API Key: sk-test-key Authorization: Bearer bearer-secret', price: 3, stock: 10 } };
  const first = normalizeProductEvidence(input);
  assert.deepEqual(normalizeProductEvidence(first), first);
  for (const secret of ['user:', 'secret@', 'hidden', 'api-secret', 'sk-test-key', 'bearer-secret']) assert.equal(JSON.stringify(first).includes(secret), false);
  assert.notEqual(nameConsensusKey(input), nameConsensusKey({ ...input, sourceData: { ...input.sourceData, apiEndpoint: 'https://different.invalid/v1' } }));
});

test('explicit provider labels are evidence while merchant names and unlabeled links are not', () => {
  const value = normalizeProductEvidence({ name: '通用 API 额度', sourceData: { evidence: '服务商：星云中转；服务端点：https://relay.invalid/v1；店铺：甲店', merchant: { name: '商家乙' }, url: 'https://merchant.invalid/1' } });
  assert.deepEqual(value.sourceData.serviceEvidence, { endpoints: ['https://relay.invalid/v1'], brands: ['星云中转'] });
  assert.equal(normalizeProductEvidence({ name: '通用 API 额度', sourceData: { vendor: '商家甲', url: 'https://merchant.invalid/1' } }).sourceData.serviceEvidence, undefined);
});

test('public endpoint routing remains distinct while credentials and prose separators are removed', () => {
  const route = (tenant: string, token: string) => ({ name: 'API 充值', sourceData: { description: `服务端点：https://relay.invalid/v1?tenant=${tenant}&token=${token}; 教程：https://docs.invalid` } });
  assert.notEqual(nameConsensusKey(route('alpha', 'secret')), nameConsensusKey(route('beta', 'secret')));
  assert.equal(nameConsensusKey(route('alpha', 'secret')), nameConsensusKey(route('alpha', 'replacement')));
  assert.deepEqual(normalizeProductEvidence(route('alpha', 'secret')).sourceData.serviceEvidence, { endpoints: ['https://relay.invalid/v1?tenant=alpha'], brands: [] });
});
