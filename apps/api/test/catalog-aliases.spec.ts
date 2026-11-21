import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeCatalogAliases } from '../src/standardization/catalog-aliases.js';

test('catalog aliases normalize whitespace, width and duplicate search spellings', () => {
  assert.deepEqual(normalizeCatalogAliases(['  Ｆｏｏ  Bar  ', 'foo-bar', '中文别名', '中文 别名', '', '---']), ['Foo Bar', '中文别名']);
  assert.deepEqual(normalizeCatalogAliases(['A\u0000B', 'A B']), ['A B']);
});

test('catalog aliases preserve meaningful plan suffixes', () => {
  assert.deepEqual(normalizeCatalogAliases(['Acme Pro', 'Acme Pro+', 'Ａｃｍｅ Ｐｒｏ＋']), ['Acme Pro', 'Acme Pro+']);
});
