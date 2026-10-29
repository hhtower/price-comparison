import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCanonicalStandardKey } from '../src/standardization/canonical-key.ts';

test('canonical key is stable across case, Unicode normalization, whitespace and tag order', () => {
  const a = buildCanonicalStandardKey({ platform: ' 淘宝 ', family: 'ＧＰＵ', product: 'RTX  4090', tier: '高端', tags: [{ name: '显存', value: '24 GB' }, { name: '颜色', value: '黑' }] });
  const b = buildCanonicalStandardKey({ platform: '淘宝', family: 'gpu', product: 'rtx 4090', tier: '高端', tags: [{ name: '颜色', value: '黑' }, { name: '显存', value: '24 GB' }] });
  assert.equal(a, b);
  assert.match(a, /^v3:[0-9a-f]{64}$/u);
});

test('platform and SKU tags do not split a product identity', () => {
  const base = { family: 'gpu', product: 'x', tier: 'pro' };
  assert.equal(buildCanonicalStandardKey({ ...base, platform: 'amazon' }), buildCanonicalStandardKey({ ...base, platform: 'ebay' }));
  const normalized = { platform: ' Web ', family: 'OpenAI', product: 'ChatGPT', tier: 'Pro', tags: [{ name: 'Region', value: 'US' }, { name: 'Seats', value: '10' }] };
  assert.equal(buildCanonicalStandardKey(normalized), buildCanonicalStandardKey({ ...normalized, platform: 'ｗｅｂ', tags: [...normalized.tags].reverse() }));
  assert.equal(buildCanonicalStandardKey(normalized), buildCanonicalStandardKey({ ...normalized, platform: 'api', tags: [{ name: 'duration', value: 'annual' }] }));
  assert.notEqual(buildCanonicalStandardKey(normalized), buildCanonicalStandardKey({ ...normalized, tier: 'plus' }));
});

test('official aliases share canonical keys while quota variants stay distinct', () => {
  assert.equal(buildCanonicalStandardKey({ family: 'OpenAI', product: 'Codex', tier: 'Business 5X' }), buildCanonicalStandardKey({ family: 'openai', product: 'chatgpt', tier: 'team_5x' }));
  assert.equal(buildCanonicalStandardKey({ family: 'Anthropic', product: 'Claude Code', tier: 'Max 20X' }), buildCanonicalStandardKey({ family: 'anthropic', product: 'claude', tier: 'max_20x' }));
  assert.notEqual(buildCanonicalStandardKey({ family: 'openai', product: 'chatgpt', tier: 'pro_5x' }), buildCanonicalStandardKey({ family: 'openai', product: 'chatgpt', tier: 'pro_20x' }));
});
