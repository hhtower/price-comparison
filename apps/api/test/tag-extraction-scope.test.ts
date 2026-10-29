import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type CompiledQuery } from 'kysely';
import { createManualTagJob, previewTagJob } from '../src/ai/tag-extraction-jobs.js';
import type { DatabaseSchema } from '../src/database/types.js';

function database(products: Record<string, unknown>[] = [], sourceType = 'tag_extraction') {
  const queries: CompiledQuery[] = [];
  class Driver extends DummyDriver {
    async acquireConnection(): Promise<any> {
      return { executeQuery: async (query: CompiledQuery) => {
        queries.push(query);
        if (query.sql.includes('from "products"')) return { rows: products };
        if (query.sql.includes('from "ai_jobs"') && query.sql.includes('"job_type"')) return { rows: [{ id: 77n, job_type: sourceType, parent_identity_job_id: null }] };
        if (query.sql.includes('from "ai_job_input_members"')) return { rows: [{ product_id: 1n }] };
        return { rows: [] };
      } };
    }
  }
  const db = new Kysely<DatabaseSchema>({ dialect: {
    createAdapter: () => new PostgresAdapter(), createDriver: () => new Driver(),
    createIntrospector: db => new PostgresIntrospector(db), createQueryCompiler: () => new PostgresQueryCompiler(),
  } });
  return { db, queries };
}

const product = {
  id: 1n, name: 'Product', spec: '', source_category: '', source_data: {}, content_version: 1n,
  content_fingerprint: 'evidence', standardization_revision: 0n, standardization_locked: false,
  deleted_at: null, enabled: true, shop_deleted_at: null, standard_product_id: 1n,
  shop_url: 'https://example.invalid/', shop_protocol: null, shop_platform: 'test',
  manual: false, human: false, published: true,
};

test('all-pending preview rejects before issuing any database query', async () => {
  const { db, queries } = database();
  try {
    await assert.rejects(previewTagJob(db, { allPending: true, model: 'mock' }), { code: 'AI_TAG_PREVIEW_SCOPE_INVALID' });
    assert.equal(queries.length, 0);
  } finally { await db.destroy(); }
});

for (const previewDigest of ['a'.repeat(64), '', 'invalid', null]) {
  test(`all-pending creation rejects a supplied preview digest (${JSON.stringify(previewDigest)}) without queries`, async () => {
    const { db, queries } = database();
    try {
      await assert.rejects(createManualTagJob(db, {
        allPending: true, model: 'mock', requestId: randomUUID(), previewDigest: previewDigest as unknown as string,
      }), { code: 'AI_TAG_PREVIEW_NOT_ALLOWED' });
      assert.equal(queries.length, 0);
    } finally { await db.destroy(); }
  });
}

for (const products of [[], [product]]) {
  test(`missing retry IDs reject before querying source members (${products.length} products found)`, async () => {
    const { db, queries } = database(products);
    try {
      await assert.rejects(previewTagJob(db, {
        productIds: products.length ? [1n, 999999n] : [999999n], retryOfJobId: 77n, model: 'mock',
      }), { code: 'AI_TAG_RETRY_SCOPE_INVALID' });
      assert.ok(queries.some(query => query.sql.includes('from "ai_jobs"')), 'retry source is still validated');
      assert.ok(queries.every(query => !query.sql.includes('from "ai_job_input_members"')));
    } finally { await db.destroy(); }
  });
}

test('valid retry preview constrains its member query to the requested IDs', async () => {
  const { db, queries } = database([product]);
  try {
    const result = await previewTagJob(db, { productIds: [1n], retryOfJobId: 77n, model: 'mock' });
    assert.deepEqual(result.productIds, ['1']);
    assert.equal(result.counts.eligible, 1);
    const query = queries.find(query => query.sql.includes('from "ai_job_input_members"'))!;
    assert.match(query.sql, /"product_id" in \(\$\d+\)/u);
    assert.deepEqual(query.parameters, [77n, 1n]);
    const lookup = queries.find(query => query.sql.includes('from "products"'))!;
    assert.equal(lookup.parameters.at(-1), 501);
  } finally { await db.destroy(); }
});

test('bounded previews preserve protected and missing product counts', async () => {
  const { db, queries } = database([{ ...product, standardization_locked: true }]);
  try {
    const result = await previewTagJob(db, { productIds: [1n, 999999n], model: 'mock' });
    assert.deepEqual(result.productIds, ['1']);
    assert.equal(result.counts.selected, 1);
    assert.equal(result.counts.missing, 1);
    assert.equal(result.counts.protected, 1);
    assert.equal(result.counts.eligible, 0);
    assert.equal(queries.length, 1);
  } finally { await db.destroy(); }
});

test('a normal preview with no matching products reports missing IDs without a member lookup', async () => {
  const { db, queries } = database();
  try {
    const result = await previewTagJob(db, { productIds: [999999n], model: 'mock' });
    assert.deepEqual(result.productIds, []);
    assert.equal(result.counts.missing, 1);
    assert.equal(result.counts.selected, 0);
    assert.equal(queries.length, 1);
  } finally { await db.destroy(); }
});

test('valid retry previews still report protected source members', async () => {
  const { db } = database([{ ...product, standardization_locked: true }]);
  try {
    const result = await previewTagJob(db, { productIds: [1n], retryOfJobId: 77n, model: 'mock' });
    assert.deepEqual(result.productIds, ['1']);
    assert.equal(result.counts.protected, 1);
    assert.equal(result.counts.missing, 0);
    assert.equal(result.counts.eligible, 0);
  } finally { await db.destroy(); }
});

test('retry source validation is preserved for a missing selection', async () => {
  const { db, queries } = database([], 'manual_full');
  try {
    await assert.rejects(previewTagJob(db, {
      productIds: [999999n], retryOfJobId: 77n, model: 'mock',
    }), { code: 'AI_TAG_RETRY_SOURCE_INVALID' });
    assert.ok(queries.every(query => !query.sql.includes('from "ai_job_input_members"')));
  } finally { await db.destroy(); }
});
