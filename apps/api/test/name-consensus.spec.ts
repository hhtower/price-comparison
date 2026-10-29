import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseNameConsensus, compatibleNameConsensus, nameConsensusKey, type ConsensusMember } from '../src/standardization/name-consensus.js';

const identity = { family: 'microsoft', product: 'outlook', tier: 'standard' };
const member = (id: number, standard: number, overrides: Partial<ConsensusMember> = {}): ConsensusMember => ({
  id: BigInt(id), standardProductId: BigInt(standard), name: '微软邮箱长效 Outlook Hotmail OAuth2 双令牌', spec: '',
  identity, assignmentSource: 'ai', locked: false, revision: 0n, contentVersion: 1n, contentFingerprint: 'stored-source-hash', ...overrides,
});

test('uses the largest group by distinct products even without an absolute majority', () => {
  const rows = [member(1, 1), member(2, 2), member(3, 2), member(4, 3), member(5, 3), member(6, 3)];
  rows.push(rows[0]!, rows[0]!, rows[0]!);
  const winner = chooseNameConsensus(rows).get(nameConsensusKey(rows[0]!)!);
  assert.deepEqual(winner, { standardProductId: 3n, identity, count: 3, runnerUpCount: 2 });
});

test('ties preserve existing assignments regardless of input order', () => {
  const rows = [member(1, 1), member(2, 2)];
  assert.equal(chooseNameConsensus(rows).size, 0);
  assert.equal(chooseNameConsensus([...rows].reverse()).size, 0);
});

test('normalizes case, full-width text and spacing but keeps specifications separate', () => {
  const a = member(1, 1, { name: '  OUTLOOK　long term 邮箱账号', spec: '  月付  ' });
  const b = member(2, 1, { name: 'ｏｕｔｌｏｏｋ long term 邮箱账号', spec: '月付' });
  assert.equal(nameConsensusKey(a), nameConsensusKey(b));
  assert.notEqual(nameConsensusKey(a), nameConsensusKey({ ...b, spec: '年付' }));
  assert.equal(nameConsensusKey({ name: '  ' }), null);
});

test('short generic names require matching full evidence and ignore seller metadata', () => {
  const a = member(1, 1, { name: '月卡', sourceData: { evidence: '画图软件', user: { id: 1 } } });
  const b = member(2, 1, { name: '月卡', sourceData: { evidence: '画图软件', user: { id: 2 } } });
  const c = member(3, 2, { name: '月卡', sourceData: { evidence: '视频会员' } });
  assert.equal(nameConsensusKey(a), nameConsensusKey(b));
  assert.notEqual(nameConsensusKey(a), nameConsensusKey(c));
  assert.notEqual(nameConsensusKey(a), nameConsensusKey({ ...a, spec: 'annual' }));
});

test('explicit description conflicts reject the winning plan without falling back to a smaller group', () => {
  const a = member(1, 1, { name: 'ChatGPT账号定制套餐 官方订阅', identity: { family: 'openai', product: 'chatgpt', tier: 'plus' } });
  const winners = chooseNameConsensus([a, { ...a, id: 2n }]);
  assert.equal(compatibleNameConsensus({ ...a, sourceData: { evidence: 'ChatGPT Team 5x account' } }, winners), undefined);
  assert.equal(compatibleNameConsensus({ ...a, sourceData: { evidence: 'ChatGPT Plus account' } }, winners)?.standardProductId, 1n);
});

test('historical Heavy votes cannot override an explicit Super listing', () => {
  const source = member(1, 1, { name: 'Super周卡独享成品号 稳定渠道', identity: { family: 'xai', product: 'grok', tier: 'heavy' } });
  assert.equal(compatibleNameConsensus(source, chooseNameConsensus([source, { ...source, id: 2n }])), undefined);
});

test('historical X Premium Plus votes cannot promote a monthly blue-badge code', () => {
  const source = member(7328016, 4185, { name: 'X-Twitter推特蓝标 质保订阅 旧版',
    sourceData: { content: 'X-Twitter推特蓝标 月卡 自助卡密，正规IOS充值(10刀/月)' },
    identity: { family: 'x', product: 'premium_membership', tier: 'premium_plus' } });
  assert.equal(compatibleNameConsensus(source, chooseNameConsensus([source])), undefined);
});

test('same-name votes cannot publish contradictory Team delivery or genuine relay credits', () => {
  const account = member(1, 1, { name: 'Team 5X 成品账号 质保1小时', identity: { family: 'openai', product: 'chatgpt', tier: 'team_5x' },
    sourceData: { evidence: 'Team 5X成品JSON，仅支持Sub2API，质保2小时。' } });
  const winners = chooseNameConsensus([account, { ...account, id: 2n }]);
  assert.equal(compatibleNameConsensus(account, winners), undefined);
  assert.equal(compatibleNameConsensus({ ...account, sourceData: { evidence: 'Team 5X成品JSON，仅支持Sub2API，质保1小时。' } }, winners)?.standardProductId, 1n);
});
