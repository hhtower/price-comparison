import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogIdentityNames, catalogNameMatch } from '@price-comparison/catalog/catalog-search';

test('symbolic and spelled upgrade tiers remain distinct from the base plan through metadata', () => {
  const names = catalogIdentityNames('Acme Super', { family: 'acme', product: 'studio', tier: 'pro_plus' },
    ['Acme Pro+', 'Acme Pro Plus']);
  for (const query of ['Acme Pro+', 'Acme Pro Plus', 'acme studio pro_plus']) {
    assert.ok(names.some(name => catalogNameMatch(name, query) === 2), query);
  }
  for (const name of names) {
    assert.equal(catalogNameMatch(name, 'Acme Pro'), 0, name);
    assert.equal(catalogNameMatch(name, 'Acme Studio Pro'), 0, name);
  }
  assert.equal(catalogNameMatch('Acme Premium Plus', 'Acme Premium'), 0);
  assert.equal(catalogNameMatch('Acme Premium+', 'Acme Premium Plus'), 2);
  assert.equal(catalogNameMatch('Acme Pro Plus', 'AcmeProPlus'), 2);
  assert.equal(catalogNameMatch('Acme Premium Plus（旧版）', 'AcmePremiumPlus（旧版）'), 2);
  assert.equal(catalogNameMatch('Acme Plus', 'Acme'), 1, 'a brand query can include its Plus plan');
});

test('writing variants match identity names without admitting unrelated Latin substrings or tiers', () => {
  for (const [name, query] of [
    ['星河邮箱', '星河 邮箱'], ['QQ音乐豪华绿钻', 'QQ 音乐 豪华 绿钻'],
    ['ChatGPT Plus', 'Chat GPT Plus'], ['ChatGPT Plus', 'ChatGPTPlus'],
    ['Acme Pro 20x', 'Acme Pro20x'],
  ]) assert.ok(catalogNameMatch(name!, query!) > 0, query);
  for (const name of ['Acme PlusPlus', 'PLUSAI', 'Acme Pro 20x']) {
    assert.equal(catalogNameMatch(name, 'Acme Plus'), 0);
  }
  assert.equal(catalogNameMatch('Acme Pro 20x', 'Acme Pro 5x'), 0);
  assert.equal(catalogNameMatch('Acme Pro', '---'), 0);
});
