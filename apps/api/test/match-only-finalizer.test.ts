import assert from 'node:assert/strict';
import test from 'node:test';
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type CompiledQuery } from 'kysely';
import type { DatabaseSchema } from '../src/database/types.js';
import * as versions from '../src/ai/pipeline-versions.js';
import { parseStandardizationProtocolResponse } from '../src/ai/ai.schemas.js';
import { finalizeOrScheduleMissing, recoverAbandonedStandardizationBatches, recoverStandardizationFinalization } from '../src/ai/standardization-finalizer.js';

function fixture(options: { stale?: boolean; missing?: boolean; review?: boolean; legacyCheckpoint?: boolean; duplicateCheckpoint?: boolean } = {}) {
  const queries: CompiledQuery[] = [];
  const job = {
    id: 3n, status: 'running', job_type: 'manual_full', model: 'mock', total: 1n,
    pause_requested: false, cancel_requested: false, configuration_blocked: false,
    prompt_version: versions.PIPELINE_VERSIONS.prompt,
    rule_version: versions.STANDARDIZATION_POLICY_VERSION,
    pipeline_versions: options.stale ? {} : versions.PIPELINE_VERSIONS,
  };
  const unmatched = parseStandardizationProtocolResponse({ items: [
    { id: '11', standardProductId: null, evidence: [{ path: 'name', quote: 'Frozen evidence' }] },
  ] }, [{ id: '11', candidateStandardProductIds: [] }]).items[0]!;
  class Driver extends DummyDriver {
    async acquireConnection(): Promise<any> {
      return { executeQuery: async (query: CompiledQuery) => {
        queries.push(query);
        if (query.sql.includes('from "ai_jobs"')) return { rows: [job] };
        if (query.sql.includes('from "ai_job_batches"') && query.sql.includes('"validated_decision"')) return { rows: [{
          step: 'done', status: 'succeeded',
          validated_decision: { items: options.duplicateCheckpoint ? [unmatched, unmatched] : [unmatched], missingIds: [], ...(options.legacyCheckpoint ? { identities: [] } : {}) },
        }] };
        if (query.sql.includes('from "ai_job_batches"') && query.parameters.includes('failed')) return { rows: options.review ? [{
          id: 8n, product_ids: ['11'], error_source: 'provider_unknown', error: 'timeout',
          reference_snapshot: { standardizationStage: 'review', generationBatchId: '7' },
        }] : [] };
        if (query.sql.includes('from "ai_job_input_members"') && !query.sql.startsWith('update')) return { rows: options.review || options.missing ? [{
          input_id: 11n, product_id: 101n, content_version: 1n, fingerprint: 'current', standardization_revision: 0n,
          payload: { name: 'Frozen evidence' }, input_bytes: 20n, estimated_tokens: 5n,
        }] : [] };
        if (query.sql.includes('max(jsonb_array_length(product_ids))')) return { rows: [{ max_items: 1 }] };
        if (query.sql.includes('coalesce(max(batch_index)')) return { rows: [{ next: 1n }] };
        if (query.sql.includes('from "ai_standardization_results"')) return { rows: [{ status: 'unclassified', count: 1 }] };
        return { rows: [], numAffectedRows: 1n };
      } };
    }
  }
  const db = new Kysely<DatabaseSchema>({ dialect: {
    createAdapter: () => new PostgresAdapter(), createDriver: () => new Driver(),
    createIntrospector: database => new PostgresIntrospector(database), createQueryCompiler: () => new PostgresQueryCompiler(),
  } });
  return { db, queries, unmatched };
}

test('stale jobs cannot finalize, materialize checkpoints or create retry rounds', async () => {
  const f = fixture({ stale: true, missing: true });
  try {
    await assert.rejects(f.db.transaction().execute(tx => finalizeOrScheduleMissing(tx, 3n)), { code: 'AI_POLICY_STALE' });
    assert.equal(f.queries.some(query => /^(insert|update)/.test(query.sql)), false);
  } finally { await f.db.destroy(); }
});

test('match-only finalization does not resubmit missing model outputs', async () => {
  const f = fixture({ missing: true });
  try {
    await f.db.transaction().execute(tx => finalizeOrScheduleMissing(tx, 3n));
    assert.equal(f.queries.some(query => query.sql.startsWith('insert into "ai_job_batches"')), false);
    assert.equal(f.queries.some(query => query.sql.includes('"missing_reprocess_count"')), false);
    assert.ok(f.queries.some(query => query.sql.startsWith('update "ai_jobs"')));
  } finally { await f.db.destroy(); }
});

test('failed review stays a technical failure and cannot accept an unreviewed unmatched proposal', async () => {
  const f = fixture({ review: true });
  try {
    await f.db.transaction().execute(tx => finalizeOrScheduleMissing(tx, 3n));
    const result = f.queries.find(query => query.sql.startsWith('insert into "ai_standardization_results"'));
    assert.ok(result);
    assert.ok(result.parameters.includes('request_outcome_unknown'));
    assert.equal(result.parameters.includes('unmatched'), false);
    assert.equal(result.parameters.includes(JSON.stringify(f.unmatched.evidence)), false);
    assert.equal(f.queries.some(query => query.sql.includes('"validated_decision"')), false);
    assert.equal(f.queries.some(query => query.sql.startsWith('insert into "ai_job_batches"')), false);
  } finally { await f.db.destroy(); }
});

test('legacy generation checkpoints are never resumed during failure materialization', async () => {
  const f = fixture({ review: true, legacyCheckpoint: true });
  try {
    await f.db.transaction().execute(tx => finalizeOrScheduleMissing(tx, 3n));
    assert.equal(f.queries.some(query => query.sql.includes('"validated_decision"')), false);
    const result = f.queries.find(query => query.sql.startsWith('insert into "ai_standardization_results"'));
    assert.ok(result?.parameters.includes('request_outcome_unknown'));
  } finally { await f.db.destroy(); }
});

test('corrupt checkpoint items cannot bypass review failure handling', async () => {
  const f = fixture({ review: true, duplicateCheckpoint: true });
  try {
    await f.db.transaction().execute(tx => finalizeOrScheduleMissing(tx, 3n));
    assert.equal(f.queries.some(query => query.sql.includes('"validated_decision"')), false);
    const result = f.queries.find(query => query.sql.startsWith('insert into "ai_standardization_results"'));
    assert.ok(result?.parameters.includes('request_outcome_unknown'));
  } finally { await f.db.destroy(); }
});

test('recovery sweeps select only current pipeline jobs', async () => {
  const f = fixture();
  try {
    await recoverAbandonedStandardizationBatches(f.db);
    await recoverStandardizationFinalization(f.db);
    const sweeps = f.queries.filter(query => query.sql.includes('with abandoned') || query.sql.includes('from "ai_jobs" as "j"'));
    assert.equal(sweeps.length, 2);
    for (const query of sweeps) {
      assert.match(query.sql, /pipeline_versions.*@>/);
      assert.ok(query.parameters.includes(Reflect.get(versions, 'STANDARDIZATION_POLICY_VERSION')));
    }
  } finally { await f.db.destroy(); }
});
