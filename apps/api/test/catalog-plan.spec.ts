import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertCatalogPlan,
  sequentialScanRelations,
} from '../perf/catalog-plan.js';

test('catalog plan rejects sequential scans on offer history', () => {
  const plan = [{
    Plan: {
      'Node Type': 'Nested Loop',
      Plans: [
        { 'Node Type': 'Seq Scan', 'Relation Name': 'offers' },
        { 'Node Type': 'Seq Scan', 'Relation Name': 'product_tags' },
      ],
    },
  }];

  assert.deepEqual(sequentialScanRelations(plan), ['offers', 'product_tags']);
  assert.throws(() => assertCatalogPlan(plan), /offers/);
});

test('catalog plan allows scanning SKU tags to collect facets across the eligible catalog', () => {
  assert.doesNotThrow(() => assertCatalogPlan([{ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'product_tags' } }]));
});

test('catalog plan accepts sequential scans outside the protected hot paths', () => {
  const plan = [{
    Plan: {
      'Node Type': 'Seq Scan',
      'Relation Name': 'shops',
    },
  }];

  assert.deepEqual(sequentialScanRelations(plan), ['shops']);
  assert.doesNotThrow(() => assertCatalogPlan(plan));
});
