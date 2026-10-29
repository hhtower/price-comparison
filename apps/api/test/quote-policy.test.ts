import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultQuotePolicy } from '../src/catalog/quote-policy.js';

test('quote TTL defaults to 135 minutes for missing or blank configuration', () => {
  for (const value of [undefined, '', ' \t ']) {
    assert.equal(defaultQuotePolicy({ CATALOG_QUOTE_TTL_MS: value }).ttlMs, 8_100_000);
  }
});

test('crawler target and minimum intervals do not change quote TTL', () => {
  for (const target of ['600000', '2700000', '7200000']) {
    for (const minimum of ['1000', '600000']) {
      const environment = {
        CRAWLER_TARGET_INTERVAL_MS: target,
        CRAWLER_MIN_INTERVAL_MS: minimum,
      };
      assert.equal(defaultQuotePolicy(environment).ttlMs, 8_100_000);
      assert.equal(defaultQuotePolicy({ ...environment, CATALOG_QUOTE_TTL_MS: '90000' }).ttlMs, 90_000);
    }
  }
});

test('quote TTL respects an explicit positive integer including whitespace', () => {
  assert.equal(defaultQuotePolicy({ CATALOG_QUOTE_TTL_MS: '1' }).ttlMs, 1);
  assert.equal(defaultQuotePolicy({ CATALOG_QUOTE_TTL_MS: ' 120000 ' }).ttlMs, 120_000);
});

test('quote TTL rejects invalid configuration instead of falling back', () => {
  for (const value of ['0', '-1', 'NaN', 'Infinity', '-Infinity', '1.5', 'invalid', '9007199254740992']) {
    assert.throws(
      () => defaultQuotePolicy({ CATALOG_QUOTE_TTL_MS: value }),
      /CATALOG_QUOTE_TTL_MS must be a positive integer/,
      value,
    );
  }
});

test('quote policy reads process.env when no environment is provided', () => {
  const previous = process.env.CATALOG_QUOTE_TTL_MS;
  try {
    process.env.CATALOG_QUOTE_TTL_MS = '42000';
    assert.equal(defaultQuotePolicy().ttlMs, 42_000);
  } finally {
    if (previous === undefined) delete process.env.CATALOG_QUOTE_TTL_MS;
    else process.env.CATALOG_QUOTE_TTL_MS = previous;
  }
});

test('quote policy keeps a live wall clock', () => {
  const policy = defaultQuotePolicy({});
  const before = Date.now();
  const now = policy.now();
  assert.ok(now >= before && now <= Date.now());
});
