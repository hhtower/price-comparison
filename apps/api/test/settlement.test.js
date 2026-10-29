import test from 'node:test';
import assert from 'node:assert/strict';
import { verifiedSettlement } from '../src/platforms/settlement.js';

test('settlement amounts fit numeric(14,2) without silently rounding source totals', () => {
  for (const value of ['1000000000000', 1e30, '1e3', '98.001', 'NaN', 'Infinity', '', null, true]) {
    assert.equal(verifiedSettlement(value, 'Alipay'), undefined, String(value));
  }
  assert.equal(verifiedSettlement('999999999999.99', 'Alipay')?.price, '999999999999.99');
  assert.equal(verifiedSettlement('98.1', 'Alipay')?.price, '98.10');
  assert.equal(verifiedSettlement(0, 'Alipay')?.price, '0.00');
});

test('multi-unit settlements retain the real total and derive a precise unit price', () => {
  const quote = verifiedSettlement('51.50', 'Alipay', 5);
  assert.equal(quote?.price, '10.30');
  assert.equal(quote?.quantity, 5);
  assert.equal(quote?.totalAmount, '51.50');
  assert.equal(verifiedSettlement('0.01', 'Alipay', 5)?.price, '0.002');
  assert.equal(verifiedSettlement('1.00', 'Alipay', 3)?.price, '0.333333333333');
  assert.equal(verifiedSettlement('0.01', 'Alipay', 2147483647)?.price, '0.000000000005');
  assert.equal(verifiedSettlement('999999999999.99', 'Alipay', 412)?.price, '2427184466.019393203883');
  for (const quantity of [0, -1, 1.5, NaN, Infinity, 2147483648, '5', null]) {
    assert.equal(verifiedSettlement('51.50', 'Alipay', quantity), undefined);
  }
});
