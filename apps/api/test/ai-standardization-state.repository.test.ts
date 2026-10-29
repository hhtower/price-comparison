import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
} from 'kysely';
import { AiRepository } from '../src/ai/ai.repository.js';
import { JobsRepository } from '../src/jobs/jobs.repository.js';
import type { DatabaseSchema } from '../src/database/types.js';
import { IDENTITY_POLICY_VERSION } from '../src/standardization/identity-policy.js';
import { finalizeOrScheduleMissing, recoverAbandonedStandardizationBatches, recoverStandardizationFinalization } from '../src/ai/standardization-finalizer.js';
import { recordCandidateCatalogChanges } from '../src/catalog/catalog-version.repository.js';
import { readAiConcurrency } from '../src/ai/ai-concurrency.js';
import { STANDARDIZATION_PROMPT_VERSION } from '../src/ai/standardization-request.js';
import { PIPELINE_VERSIONS } from '../src/ai/pipeline-versions.js';

type QueryResult = { rows?: unknown[]; numAffectedRows?: bigint };

function fixture(execute: (query: CompiledQuery) => QueryResult | Promise<QueryResult>) {
  const queries: CompiledQuery[] = [];
  class Driver extends DummyDriver {
    async acquireConnection(): Promise<any> {
      return {
        executeQuery: async (query: CompiledQuery) => {
          queries.push(query);
          if (query.sql.includes('as member_names')) return { rows: [], numAffectedRows: 1n };
          const result = await execute(query);
          if (result.rows === undefined && query.sql.includes('coalesce(max(batch_index), -1)')) result.rows = [{ index: 0n }];
          if (result.rows === undefined && query.sql.startsWith('select "input_id" from "ai_job_input_members"')) {
            result.rows = query.parameters.slice(1).map(input_id => ({ input_id }));
          }
          return { rows: result.rows ?? [], numAffectedRows: result.numAffectedRows ?? 1n };
        },
      };
    }
  }
  const db = new Kysely<DatabaseSchema>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new Driver(),
      createIntrospector: database => new PostgresIntrospector(database),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, queries };
}

const activeJob = {
  id: 3n,
  status: 'queued',
  prompt_version: STANDARDIZATION_PROMPT_VERSION, pipeline_versions: PIPELINE_VERSIONS, model: 'mock',
  rule_version: IDENTITY_POLICY_VERSION,
  pause_requested: false,
  cancel_requested: false,
};

function runningBatch(overrides: Record<string, unknown> = {}) {
  return {
    id: 7n,
    job_id: 3n,
    batch_index: 0n,
    product_ids: ['11'],
    product_count: 1n,
    status: 'running',
    attempts: 1n,
    error: null,
    claimed_by: 'worker',
    claim_token: 'claim-1',
    lease_until: new Date(Date.now() + 60_000),
    step: 'request',
    reference_snapshot: { strategyVersion: 'bounded-candidate-v1', catalogVersion: '1', inputs: [], candidates: [] },
    request_budget_limit: 2,
    request_budget_used: 0,
    confirmed_requests: 0,
    unknown_requests: 0,
    ...overrides,
  };
}

test('batch reference is frozen once and later preparation reuses it', async () => {
  let frozen: unknown = null;
  let freezeUpdates = 0;
  const f = fixture((query) => {
    if (query.sql.includes('from "ai_job_batches" as "b"')) return { rows: [{ job_id: 3n, product_ids: ['11'], step: 'request', reference_snapshot: frozen, prompt_version: STANDARDIZATION_PROMPT_VERSION, pipeline_versions: PIPELINE_VERSIONS, model: 'mock', rule_version: IDENTITY_POLICY_VERSION }] };
    if (query.sql.includes('from "ai_job_inputs"')) return { rows: [{ input_id: 11n, input_bytes: 100n, estimated_tokens: 30n, previous_decision: null, payload: { id: '11', name: 'ChatGPT Plus' } }] };
    if (query.sql.includes('from "standardization_catalog_versions"')) return { rows: [{ version: 1n, alias_policy_version: IDENTITY_POLICY_VERSION }] };
    if (query.sql.includes('from "standard_products" as "sp"')) return { rows: [] };
    if (query.sql.includes('from "ai_jobs"')) return { rows: [activeJob] };
    if (query.sql.startsWith('select') && query.sql.includes('from "ai_job_batches"')) return { rows: [{ step: 'request', round: 0, request_budget_used: 0, request_budget_limit: 2, reference_snapshot: frozen }] };
    if (query.sql.startsWith('update "ai_job_batches"') && query.sql.includes('"reference_snapshot"')) {
      freezeUpdates++;
      frozen = { frozen: true };
    }
    return {};
  });

  const repository = new AiRepository(f.db);
  await repository.prepareBatch(7n);
  await repository.prepareBatch(7n);

  assert.equal(freezeUpdates, 1);
  await f.db.destroy();
});

test('candidate catalog changes share one independent version and persist final visible documents', async () => {
  const f = fixture((query) => {
    if (query.sql.includes('from standard_products sp')) return { rows: [{ standard_product_id: 1n, aliases: ['ChatGPT Plus'], active: true }] };
    if (query.sql.includes('update standardization_catalog_versions')) {
      return { rows: [{ version: 8n, alias_policy_version: IDENTITY_POLICY_VERSION }] };
    }
    if (query.sql.includes('from "standard_products" as "sp"')) {
      return { rows: [
        {
          id: 1n,
          name: 'ChatGPT Plus',
          canonical_family: 'openai',
          canonical_product: 'chatgpt',
          canonical_tier: 'plus',
          verification_state: 'verified',
          has_published_member: true,
        },
        {
          id: 2n,
          canonical_family: 'openai',
          canonical_product: 'chatgpt',
          canonical_tier: 'team',
          verification_state: 'verified',
          has_published_member: false,
        },
        {
          id: 3n,
          canonical_family: 'openai',
          canonical_product: 'chatgpt',
          canonical_tier: 'pro',
          verification_state: 'quarantined',
          has_published_member: true,
        },
      ] };
    }
    return {};
  });

  const result = await recordCandidateCatalogChanges(
    f.db,
    [3n, 1n, 2n, 1n],
    IDENTITY_POLICY_VERSION,
  );

  assert.equal(result.version, 8n);
  assert.equal(result.changeCount, 3);
  const versionUpdate = f.queries.find(query => query.sql.includes('update standardization_catalog_versions'));
  const changeInsert = f.queries.find(query => query.sql.startsWith('insert into "catalog_index_changes"'));
  assert.ok(versionUpdate);
  assert.ok(changeInsert);
  assert.ok(f.queries.indexOf(changeInsert) > f.queries.indexOf(versionUpdate));
  assert.deepEqual(changeInsert.parameters.filter(value => ['upsert', 'delete', 'isolate'].includes(String(value))), ['upsert', 'delete', 'isolate']);
  const document = changeInsert.parameters.find(value => typeof value === 'string' && value.includes('ChatGPT Plus'));
  assert.deepEqual(JSON.parse(String(document)), {
    id: '1', family: 'openai', product: 'chatgpt', tier: 'plus', displayName: 'ChatGPT Plus', aliases: ['ChatGPT Plus'],
  });
  await f.db.destroy();
});

test('candidate catalog changes refresh both owners when an alias becomes ambiguous', async () => {
  const f = fixture((query) => {
    if (query.sql.includes('from standard_products sp')) return { rows: [
      { standard_product_id: 1n, aliases: ['Shared Plus'], active: true },
      { standard_product_id: 2n, aliases: ['Shared Plus'], active: true },
    ] };
    if (query.sql.includes('update standardization_catalog_versions')) {
      return { rows: [{ version: 9n, alias_policy_version: IDENTITY_POLICY_VERSION }] };
    }
    if (query.sql.includes('from "standard_products" as "sp"')) {
      return { rows: [
        {
          id: 1n,
          name: 'First Plus',
          canonical_family: 'openai',
          canonical_product: 'chatgpt',
          canonical_tier: 'plus',
          verification_state: 'verified',
          has_published_member: true,
        },
        {
          id: 2n,
          name: 'Other Plus',
          canonical_family: 'other',
          canonical_product: 'assistant',
          canonical_tier: 'plus',
          verification_state: 'verified',
          has_published_member: true,
        },
      ] };
    }
    return {};
  });

  const result = await recordCandidateCatalogChanges(f.db, [1n], IDENTITY_POLICY_VERSION);

  assert.equal(result.changeCount, 2);
  const insert = f.queries.find(query => query.sql.startsWith('insert into "catalog_index_changes"'));
  assert.ok(insert);
  assert.ok(insert.parameters.includes(1n));
  assert.ok(insert.parameters.includes(2n));
  const documents = insert.parameters
    .filter(value => typeof value === 'string' && value.startsWith('{'))
    .map(value => JSON.parse(String(value)) as { id?: string; aliases?: string[] })
    .filter(value => value.id);
  assert.deepEqual(documents, [
    { id: '1', family: 'openai', product: 'chatgpt', tier: 'plus', displayName: 'First Plus', aliases: [] },
    { id: '2', family: 'other', product: 'assistant', tier: 'plus', displayName: 'Other Plus', aliases: [] },
  ]);
  await f.db.destroy();
});

test('candidate catalog reuses its base and applies only versioned change rows', async () => {
  let catalogVersion = 1n;
  let fullCatalogReads = 0;
  const frozen = new Map<string, unknown>();
  const f = fixture((query) => {
    if (query.sql.includes('from "ai_job_batches" as "b"')) {
      const batchId = String(query.parameters.at(-1));
      return { rows: [{
        job_id: 3n,
        product_ids: [batchId === '7' ? '11' : '12'],
        step: 'request',
        reference_snapshot: frozen.get(batchId) ?? null,
        prompt_version: STANDARDIZATION_PROMPT_VERSION, pipeline_versions: PIPELINE_VERSIONS, model: 'mock',
        rule_version: IDENTITY_POLICY_VERSION,
      }] };
    }
    if (query.sql.includes('from "ai_job_inputs"')) {
      const id = (query.parameters.find(value => value === 11n || value === 12n) ?? 11n) as bigint;
      return { rows: [{ input_id: id, input_bytes: 100n, estimated_tokens: 30n, previous_decision: null, payload: { id: id.toString(), name: id === 11n ? 'ChatGPT Plus' : 'ChatGPT Team' } }] };
    }
    if (query.sql.includes('from "standardization_catalog_versions"')) {
      return { rows: [{ version: catalogVersion, alias_policy_version: IDENTITY_POLICY_VERSION }] };
    }
    if (query.sql.includes('from "catalog_index_changes"')) {
      return { rows: [{
        version: 2n,
        standard_product_id: 2n,
        operation: 'upsert',
        document: { id: '2', family: 'openai', product: 'chatgpt', tier: 'team', aliases: [] },
      }] };
    }
    if (query.sql.includes('from "standard_products" as "sp"')) {
      fullCatalogReads++;
      return { rows: [{ id: 1n, canonical_family: 'openai', canonical_product: 'chatgpt', canonical_tier: 'plus' }] };
    }
    if (query.sql.includes('from standard_products sp')) return { rows: [
      { standard_product_id: 1n, aliases: ['Consumer Plus'], active: true },
    ] };
    if (query.sql.includes('from "ai_jobs"')) return { rows: [activeJob] };
    if (query.sql.startsWith('select') && query.sql.includes('from "ai_job_batches"')) {
      const batchId = String(query.parameters.at(-1));
      return { rows: [{ step: 'request', round: 0, request_budget_used: 0, request_budget_limit: 2, reference_snapshot: frozen.get(batchId) ?? null }] };
    }
    if (query.sql.startsWith('update "ai_job_batches"') && query.sql.includes('"reference_snapshot"')) {
      const batchId = String(query.parameters.at(-1));
      const snapshot = query.parameters.find(value => typeof value === 'string' && value.includes('strategyVersion'));
      frozen.set(batchId, JSON.parse(String(snapshot)));
    }
    return {};
  });

  const repository = new AiRepository(f.db);
  await repository.prepareBatch(7n);
  catalogVersion = 2n;
  await repository.prepareBatch(8n);

  assert.equal(fullCatalogReads, 1);
  const first = frozen.get('7') as { candidates: Array<{ id: string; aliases: string[] }> };
  assert.deepEqual(first.candidates.find(candidate => candidate.id === '1')?.aliases, ['Consumer Plus']);
  assert.ok(f.queries.some(query => query.sql.includes('from "catalog_index_changes"')));
  const second = frozen.get('8') as { catalogVersion: string; candidates: Array<{ id: string }> };
  assert.equal(second.catalogVersion, '2');
  assert.ok(second.candidates.some(candidate => candidate.id === '2'));
  await f.db.destroy();
});

test('candidate catalog keeps the applied delta when non-blocking compaction fails', async () => {
  let catalogVersion = 1n;
  let fullCatalogReads = 0;
  const frozen = new Map<string, unknown>();
  const baseDocuments = Array.from({ length: 20 }, (_, index) => ({
    id: BigInt(index + 1),
    canonical_family: `vendor-${index + 1}`,
    canonical_product: `product-${index + 1}`,
    canonical_tier: 'basic',
  }));
  const f = fixture((query) => {
    if (query.sql.includes('from "ai_job_batches" as "b"')) {
      const batchId = String(query.parameters.at(-1));
      return { rows: [{
        job_id: 3n,
        product_ids: [batchId === '7' ? '11' : '12'],
        step: 'request',
        reference_snapshot: frozen.get(batchId) ?? null,
        prompt_version: STANDARDIZATION_PROMPT_VERSION, pipeline_versions: PIPELINE_VERSIONS, model: 'mock',
        rule_version: IDENTITY_POLICY_VERSION,
      }] };
    }
    if (query.sql.includes('from "ai_job_inputs"')) {
      const id = query.parameters.includes(12n) ? 12n : 11n;
      return { rows: [{ input_id: id, input_bytes: 100n, estimated_tokens: 30n, previous_decision: null, payload: { id: id.toString(), name: id === 12n ? 'updated alpha updated beta' : 'vendor 1 product 1 basic' } }] };
    }
    if (query.sql.includes('from "standardization_catalog_versions"')) {
      return { rows: [{ version: catalogVersion, alias_policy_version: IDENTITY_POLICY_VERSION }] };
    }
    if (query.sql.includes('from "catalog_index_changes"')) {
      return { rows: [
        {
          version: 2n,
          standard_product_id: 1n,
          operation: 'upsert',
          document: { id: '1', family: 'updated', product: 'alpha', tier: 'basic', aliases: [] },
        },
        {
          version: 2n,
          standard_product_id: 2n,
          operation: 'upsert',
          document: { id: '2', family: 'updated', product: 'beta', tier: 'basic', aliases: [] },
        },
      ] };
    }
    if (query.sql.includes('from "standard_products" as "sp"')) {
      fullCatalogReads++;
      if (fullCatalogReads > 1) throw new Error('compaction rebuild unavailable');
      return { rows: baseDocuments };
    }
    if (query.sql.includes('from standard_products sp')) return { rows: [] };
    if (query.sql.includes('from "ai_jobs"')) return { rows: [activeJob] };
    if (query.sql.startsWith('select') && query.sql.includes('from "ai_job_batches"')) {
      const batchId = String(query.parameters.at(-1));
      return { rows: [{ step: 'request', round: 0, request_budget_used: 0, request_budget_limit: 2, reference_snapshot: frozen.get(batchId) ?? null }] };
    }
    if (query.sql.startsWith('update "ai_job_batches"') && query.sql.includes('"reference_snapshot"')) {
      const batchId = String(query.parameters.at(-1));
      const snapshot = query.parameters.find(value => typeof value === 'string' && value.includes('strategyVersion'));
      frozen.set(batchId, JSON.parse(String(snapshot)));
    }
    return {};
  });

  const repository = new AiRepository(f.db);
  await repository.prepareBatch(7n);
  catalogVersion = 2n;
  await repository.prepareBatch(8n);

  assert.equal(fullCatalogReads, 2);
  const second = frozen.get('8') as { catalogVersion: string; candidates: Array<{ id: string }> };
  assert.equal(second.catalogVersion, '2');
  const candidateIds = new Set(second.candidates.map(candidate => candidate.id));
  assert.equal(candidateIds.has('1'), true);
  assert.equal(candidateIds.has('2'), true);
  await f.db.destroy();
});

test('provider request cannot be reserved before the reference is frozen', async () => {
  const f = fixture((query) => {
    if (query.sql.startsWith('select "job_id" from "ai_job_batches"')) return { rows: [{ job_id: 3n }] };
    if (query.sql.includes('from "ai_jobs"')) return { rows: [activeJob] };
    if (query.sql.startsWith('select') && query.sql.includes('from "ai_job_batches"')) return { rows: [runningBatch({ reference_snapshot: null })] };
    return {};
  });

  await assert.rejects(new AiRepository(f.db).reserveBatchRequest(7n, { workerId: 'worker', attempt: 1n, token: 'claim-1' }), /reference_not_frozen/);
  assert.equal(f.queries.some(query => query.sql.startsWith('update "ai_job_batches"')), false);
  await f.db.destroy();
});

test('reservation clears a frozen reference when an active input has no candidate snapshot', async () => {
  const batch = runningBatch({ reference_snapshot: { strategyVersion: 'bounded-candidate-v1', catalogVersion: '1', inputs: [], candidates: [] } });
  const f = fixture(query => {
    if (query.sql.startsWith('select "job_id" from "ai_job_batches"')) return { rows: [{ job_id: 3n }] };
    if (query.sql.includes('from "ai_jobs"')) return { rows: [activeJob] };
    if (query.sql.startsWith('select') && query.sql.includes('from "ai_job_batches"')) return { rows: [batch] };
    if (query.sql.includes('from "ai_job_input_members" as "m"')) return { rows: [{ input_id: 11n, product_id: 101n }] };
    return {};
  });

  assert.equal(await new AiRepository(f.db).reserveBatchRequest(7n, { workerId: 'worker', attempt: 1n, token: 'claim-1' }), 'refresh');
  const refresh = f.queries.find(query => query.sql.startsWith('update "ai_job_batches"') && query.sql.includes('"reference_snapshot"'));
  assert.ok(refresh);
  const referenceParameter = /"reference_snapshot" = \$(\d+)/.exec(refresh.sql);
  assert.ok(referenceParameter);
  assert.equal(refresh.parameters[Number(referenceParameter[1]) - 1], null);
  await f.db.destroy();
});

test('tag extraction reserves requests using unique input-member IDs', async () => {
  const batch = runningBatch({
    product_ids: ['11'], product_count: 1n,
    reference_snapshot: { strategyVersion: 'bounded-candidate-v1', catalogVersion: '0', inputs: [
      { id: '11', candidateStandardProductIds: [], stats: { scanned: 0, compared: 0, truncated: false } },
    ], candidates: [] },
  });
  const f = fixture(query => {
    if (query.sql.startsWith('select "job_id" from "ai_job_batches"')) return { rows: [{ job_id: 3n }] };
    if (query.sql.includes('from "ai_jobs"')) return { rows: [{ ...activeJob, job_type: 'tag_extraction' }] };
    if (query.sql.startsWith('select') && query.sql.includes('from "ai_job_batches"')) return { rows: [batch] };
    if (query.sql.includes('from "ai_job_input_members" as "m"')) return { rows: [{ input_id: 11n, product_id: 12n }] };
    return {};
  });

  assert.equal(await new AiRepository(f.db).reserveBatchRequest(7n, { workerId: 'worker', attempt: 1n, token: 'claim-1' }), 'reserved');
  const activeProductLookup = f.queries.find(query => query.sql.includes('from "ai_job_input_members" as "m"'));
  assert.ok(activeProductLookup);
  assert.match(activeProductLookup.sql, /"p"\."deleted_at" is null/);
  assert.match(activeProductLookup.sql, /"s"\."deleted_at" is null/);
  assert.match(activeProductLookup.sql, /"s"\."enabled" =/);
  assert.match(activeProductLookup.sql, /"m"\."input_id" in/);
  await f.db.destroy();
});

test('batch claim SQL limits eligibility to the same-round rolling window', async () => {
  const f = fixture(() => ({ rows: [] }));
  assert.equal(await new JobsRepository(f.db).claimNext('ai_batch', 'worker', 30_000), null);
  const claim = f.queries.find(query => query.sql.includes('from ai_job_batches q'));
  assert.ok(claim);
  assert.match(claim.sql, /w\.round = q\.round/);
  assert.match(claim.sql, /min\(w\.batch_index\)/);
  assert.ok(claim.parameters.includes(readAiConcurrency()));
  assert.match(claim.sql, /q\.unknown_requests = 0/);
  await f.db.destroy();
});

for (const mode of ['single', 'bulk'] as const) test(mode + ' batch claims lock parents first and return the complete handler row', async () => {
  const f = fixture((query) => {
    if (query.sql.trimStart().startsWith('select j.id from ai_jobs j')) return { rows: [{ id: 3n }] };
    if (query.sql.includes('update ai_job_batches q')) return { rows: [runningBatch()] };
    if (query.sql.includes('from ai_job_progress p')) return { rows: [{ job_id: 3n, status: 'running' }] };
    return {};
  });

  const repository = new JobsRepository(f.db);
  const claims = mode === 'single'
    ? [await repository.claimNext('ai_batch', 'worker', 30_000)]
    : await repository.claimAvailable('ai_standardization', 'worker', 2, 30_000);

  assert.equal(claims.length, 1);
  assert.ok(claims[0]);
  assert.deepEqual(Object.keys(claims[0]).sort(), ['attempts', 'claimed_by', 'id', 'kind', 'lease_until', 'row']);
  assert.equal(claims[0].kind, 'ai_batch');
  assert.equal(claims[0].row.claim_token, 'claim-1');
  assert.match(f.queries[0]!.sql.trimStart(), /^select j\.id from ai_jobs j/);
  assert.match(f.queries[0]!.sql, /for update skip locked/);
  const batchClaimIndex = f.queries.findIndex(query => query.sql.includes('update ai_job_batches q'));
  assert.ok(batchClaimIndex > 0);
  assert.match(f.queries[batchClaimIndex]!.sql, /q\.job_id in/);
  await f.db.destroy();
});

test('job creation registers each content version and fingerprint idempotently', async () => {
  const product = {
    id: 11n,
    name: 'ChatGPT Plus',
    spec: 'monthly',
    source_category: 'account',
    source_data: {},
    standardization_revision: 0n,
    content_version: 2n,
  };
  const job = { ...activeJob, total: 1n, model: 'mock', phase: 'standardizing' };
  const f = fixture((query) => {
    if (query.sql.includes('from "products"') && query.sql.includes('inner join "shops"')) return { rows: [product] };
    if (query.sql.startsWith('insert into "ai_jobs"')) return { rows: [job] };
    if (query.sql.includes('from ai_job_progress p')) return { rows: [{ job_id: 3n, version: 1n, phase: 'standardizing', status: 'queued', total: 1n }] };
    if (query.sql.startsWith('insert into "ai_job_batches"')) return { rows: [{ id: 7n, product_ids: ['11'] }] };
    if (query.sql.startsWith('select') && query.sql.includes('from "ai_jobs"')) return { rows: [job] };
    return {};
  });

  await new AiRepository(f.db).createJob({
    model: 'mock', productIds: [11n], jobType: 'incremental', sourceEvents: [{ productId: 11n, eventId: 21n }],
  });
  const registration = f.queries.find(query => query.sql.startsWith('insert into "ai_standardization_executions"'));
  assert.ok(registration);
  assert.match(registration.sql, /on conflict \("product_id", "content_version", "fingerprint"\) do update set/);
  assert.match(registration.sql, /where not exists \(select 1 from ai_jobs previous_job/);
  assert.match(registration.sql, /previous_job\.pipeline_versions @>/);
  assert.ok(registration.parameters.includes(JSON.stringify(PIPELINE_VERSIONS)));
  assert.ok(registration.parameters.includes(21n));
  const superseded = f.queries.find(query => query.sql.includes('update ai_standardization_executions as execution') && query.parameters.includes('superseded'));
  assert.ok(superseded);
  assert.match(superseded.sql, /from \(values .*execution\.content_version < current\.content_version/s);
  await f.db.destroy();
});

test('oversized inputs get an explicit terminal result without a provider request', async () => {
  const previousLimit = process.env.AI_BATCH_MAX_INPUT_BYTES;
  process.env.AI_BATCH_MAX_INPUT_BYTES = '1';
  const product = {
    id: 11n, name: 'ChatGPT Plus', spec: 'monthly', source_category: 'account', source_data: {},
    standardization_revision: 0n, content_version: 2n,
  };
  const job = { ...activeJob, total: 1n, model: 'mock', phase: 'standardizing' };
  const f = fixture((query) => {
    if (query.sql.includes('from "products"') && query.sql.includes('inner join "shops"')) return { rows: [product] };
    if (query.sql.startsWith('insert into "ai_jobs"')) return { rows: [job] };
    if (query.sql.includes('from ai_job_progress p')) return { rows: [{ job_id: 3n, version: 1n, phase: 'standardizing', status: 'queued', total: 1n }] };
    if (query.sql.startsWith('select') && query.sql.includes('from "ai_jobs"')) return { rows: [job] };
    return {};
  });
  try {
    await new AiRepository(f.db).createJob({ model: 'mock', productIds: [11n] });
    const result = f.queries.find(query => query.sql.startsWith('insert into "ai_standardization_results"'));
    assert.ok(result);
    assert.ok(result.parameters.includes('input_too_large'));
    assert.equal(f.queries.some(query => query.sql.startsWith('insert into "ai_job_batches"')), false);
  } finally {
    if (previousLimit === undefined) delete process.env.AI_BATCH_MAX_INPUT_BYTES;
    else process.env.AI_BATCH_MAX_INPUT_BYTES = previousLimit;
    await f.db.destroy();
  }
});

test('unknown outcomes and exhausted budgets cannot reserve another provider request', async () => {
  for (const state of [
    runningBatch({ request_budget_used: 1, confirmed_requests: 0, unknown_requests: 1, reference_snapshot: {
      strategyVersion: 'bounded-candidate-v1', catalogVersion: '1', inputs: [
        { id: '11', candidateStandardProductIds: [], stats: { scanned: 0, compared: 0, truncated: false } },
      ], candidates: [],
    } }),
    runningBatch({ request_budget_used: 2, confirmed_requests: 2, unknown_requests: 0, reference_snapshot: {
      strategyVersion: 'bounded-candidate-v1', catalogVersion: '1', inputs: [
        { id: '11', candidateStandardProductIds: [], stats: { scanned: 0, compared: 0, truncated: false } },
      ], candidates: [],
    } }),
  ]) {
    const f = fixture((query) => {
      if (query.sql.startsWith('select "job_id" from "ai_job_batches"')) return { rows: [{ job_id: 3n }] };
      if (query.sql.includes('from "ai_jobs"')) return { rows: [activeJob] };
      if (query.sql.includes('from "ai_job_input_members" as "m"')) return { rows: [{ input_id: 11n, product_id: 101n }] };
      if (query.sql.startsWith('select') && query.sql.includes('from "ai_job_batches"')) return { rows: [state] };
      return {};
    });
    await assert.rejects(new AiRepository(f.db).reserveBatchRequest(7n, { workerId: 'worker', attempt: 1n, token: 'claim-1' }), /request_outcome_unknown|request_budget_exhausted/);
    const reservations = f.queries.filter(query => query.sql.startsWith('update "ai_job_batches"') && query.sql.includes('"request_budget_used"'));
    assert.equal(reservations.some(query => query.parameters.includes(2)), false);
    await f.db.destroy();
  }
});

test('interruption requeues only local work and never resends uncertain or confirmed requests', async () => {
  for (const scenario of [
    { step: 'publish', used: 1, confirmed: 1, unknown: 0, status: 'queued', source: 'local' },
    { step: 'done', used: 1, confirmed: 1, unknown: 0, status: 'succeeded', source: null },
    { step: 'request', used: 0, confirmed: 0, unknown: 0, status: 'queued', source: 'local' },
    { step: 'request', used: 1, confirmed: 0, unknown: 0, status: 'failed', source: 'request_outcome_unknown' },
    { step: 'request', used: 1, confirmed: 0, unknown: 1, status: 'failed', source: 'request_outcome_unknown' },
    { step: 'request', used: 1, confirmed: 1, unknown: 0, status: 'failed', source: 'result_not_saved' },
  ]) {
    const batch = runningBatch({ step: scenario.step, request_budget_used: scenario.used, confirmed_requests: scenario.confirmed, unknown_requests: scenario.unknown });
    const f = fixture(query => {
      if (query.sql.includes('from "ai_job_batches"')) return { rows: [batch] };
      if (query.sql.includes('from "ai_jobs"')) return { rows: [{ ...activeJob, status: 'paused', pause_requested: true }] };
      return {};
    });
    await new JobsRepository(f.db).requeue('ai_batch', 7n, 'worker', 0);
    const update = f.queries.find(query => query.sql.startsWith('update "ai_job_batches"'))!;
    const valueOf = (column: string) => {
      const match = new RegExp(`"${column}" = \\$(\\d+)`).exec(update.sql);
      assert.ok(match, column);
      return update.parameters[Number(match[1]) - 1];
    };
    assert.equal(valueOf('status'), scenario.status, JSON.stringify(scenario));
    assert.equal(valueOf('error_source'), scenario.source, JSON.stringify(scenario));
    assert.doesNotMatch(update.sql, /request_budget_(?:used|limit)|confirmed_requests|unknown_requests/);
    await f.db.destroy();
  }
});

test('local publication retry leaves provider budget and extraction progress unchanged', async () => {
  const batch = runningBatch({ step: 'publish', request_budget_used: 1, confirmed_requests: 1 });
  const f = fixture((query) => {
    if (query.sql.startsWith('select') && query.sql.includes('from "ai_job_batches"')) return { rows: [batch] };
    if (query.sql.includes('from "ai_jobs"')) return { rows: [activeJob] };
    if (query.sql.startsWith('select 1 from ai_job_batches')) return { rows: [{ '?column?': 1 }] };
    if (query.sql.includes('from ai_job_progress p')) return { rows: [{ job_id: 3n, version: 1n, phase: 'standardizing', status: 'running', total: 1n }] };
    return {};
  });

  await new JobsRepository(f.db).fail('ai_batch', 7n, 'worker', 'database connection reset', { retry: true, backoffMs: 25, retryClass: 'local' });

  const batchUpdates = f.queries.filter(query => query.sql.startsWith('update ai_job_batches') || query.sql.startsWith('update "ai_job_batches"'));
  assert.ok(batchUpdates.some(query => query.parameters.includes('queued')));
  assert.equal(batchUpdates.some(query => /request_budget_(?:used|limit)|confirmed_requests|unknown_requests/.test(query.sql)), false);
  assert.equal(f.queries.some(query => query.sql.includes('ai_job_progress')), false);
  assert.equal(f.queries.some(query => query.sql.includes('"ai_job_inputs"')), false);
  await f.db.destroy();
});

test('finalization locks the job and creates exactly one round-1 batch for missing inputs', async () => {
  const f = fixture((query) => {
    if (query.sql.includes('from "ai_jobs"') && query.sql.includes('for update')) return { rows: [activeJob] };
    if (query.sql.includes('from "ai_job_batches"') && query.sql.includes('"status" in')) return { rows: [] };
    if (query.sql.includes('from "ai_job_input_members"') && query.sql.includes('"reason_code"')) {
      return { rows: [
        { input_id: 11n, product_id: 101n, content_version: 1n, fingerprint: 'a', payload: { id: '11' }, input_bytes: 10n, estimated_tokens: 3n },
        { input_id: 11n, product_id: 102n, content_version: 1n, fingerprint: 'a', payload: { id: '11' }, input_bytes: 10n, estimated_tokens: 3n },
      ] };
    }
    if (query.sql.includes('max(jsonb_array_length(product_ids))')) return { rows: [{ max_items: 1 }] };
    if (query.sql.includes('from "ai_job_batches"') && query.sql.includes('"round" =')) return { rows: [] };
    if (query.sql.includes('coalesce(max(batch_index)')) return { rows: [{ next: 1n }] };
    return {};
  });

  await f.db.transaction().execute(tx => finalizeOrScheduleMissing(tx, 3n));

  const roundOne = f.queries.find(query => query.sql.startsWith('insert into "ai_job_batches"'));
  assert.ok(roundOne);
  assert.match(roundOne.sql, /"round".*"request_budget_limit"/);
  assert.ok(roundOne.parameters.includes(1));
  assert.equal(roundOne.parameters.includes(2), false, 'round 1 gets one provider request');
  assert.ok(f.queries.find(query => query.sql.startsWith('update "ai_job_inputs"'))?.parameters.includes(1));
  assert.ok(f.queries.find(query => query.sql.startsWith('update "ai_job_input_members"'))?.parameters.includes(1));
  const lockIndex = f.queries.findIndex(query => query.sql.includes('from "ai_jobs"') && query.sql.includes('for update'));
  const insertIndex = f.queries.findIndex(query => query.sql.startsWith('insert into "ai_job_batches"'));
  assert.ok(lockIndex >= 0 && insertIndex > lockIndex);
  await f.db.destroy();
});

test('finalization never schedules round 2 and completes a job after round-1 omission', async () => {
  const f = fixture((query) => {
    if (query.sql.includes('from "ai_jobs"') && query.sql.includes('for update')) return { rows: [activeJob] };
    if (query.sql.includes('from "ai_jobs"')) return { rows: [{ ...activeJob, job_type: 'manual_full', total: 1n }] };
    if (query.sql.includes('from "ai_job_batches"') && query.sql.includes('"status" in')) return { rows: [] };
    if (query.sql.includes('from "ai_job_input_members"') && query.sql.includes('"reason_code"')) return { rows: [] };
    if (query.sql.includes('from "ai_standardization_results"')) return { rows: [{ status: 'unclassified', count: 1 }] };
    return {};
  });

  await f.db.transaction().execute(tx => finalizeOrScheduleMissing(tx, 3n));

  assert.equal(f.queries.some(query => query.sql.startsWith('insert into "ai_job_batches"')), false);
  const completion = f.queries.find(query => query.sql.startsWith('update "ai_jobs"'));
  assert.ok(completion);
  assert.ok(completion.parameters.includes('succeeded'));
  assert.ok(completion.parameters.includes('completed'));
  await f.db.destroy();
});

test('paused and cancelled jobs cannot schedule missing reprocessing', async () => {
  for (const job of [
    { ...activeJob, status: 'paused', pause_requested: true },
    { ...activeJob, status: 'cancelled', cancel_requested: true },
  ]) {
    const f = fixture((query) => query.sql.includes('from "ai_jobs"') ? { rows: [job] } : {});
    await f.db.transaction().execute(tx => finalizeOrScheduleMissing(tx, 3n));
    assert.equal(f.queries.some(query => query.sql.includes('"ai_job_input_members"')), false);
    assert.equal(f.queries.some(query => query.sql.startsWith('insert into "ai_job_batches"')), false);
    await f.db.destroy();
  }
});

test('terminal batch failure records provider_error for every unresolved member and finalizes', async () => {
  const batch = runningBatch({ request_budget_used: 1, confirmed_requests: 1 });
  const f = fixture((query) => {
    if (query.sql.startsWith('select "job_id" from "ai_job_batches"')) return { rows: [{ job_id: 3n }] };
    if (query.sql.includes('from "ai_jobs"') && query.sql.includes('for update')) return { rows: [activeJob] };
    if (query.sql.includes('from "ai_jobs"')) return { rows: [{ ...activeJob, job_type: 'manual_full', total: 1n }] };
    if (query.sql.includes('from "ai_job_batches"') && query.sql.includes('"status" =') && query.parameters.includes('failed')) {
      return { rows: [{ id: 7n, product_ids: ['11'], error_source: 'provider_terminal' }] };
    }
    if (query.sql.startsWith('select') && query.sql.includes('from "ai_job_batches"') && query.sql.includes('for update')) return { rows: [batch] };
    if (query.sql.includes('from "ai_job_input_members"') && query.sql.includes('"input_id" in')) {
      return { rows: [{ input_id: 11n, product_id: 101n, content_version: 1n, fingerprint: 'a', payload: { id: '11' } }] };
    }
    if (query.sql.includes('from "ai_job_batches"') && query.sql.includes('"status" in')) return { rows: [] };
    if (query.sql.includes('from "ai_job_input_members"') && query.sql.includes('"reason_code"')) return { rows: [] };
    if (query.sql.includes('from "ai_standardization_results"')) return { rows: [{ status: 'unclassified', count: 1 }] };
    return {};
  });

  await new JobsRepository(f.db).fail('ai_batch', 7n, 'worker', 'provider rejected request', { retry: false, retryClass: 'provider_terminal' });

  const result = f.queries.find(query => query.sql.startsWith('insert into "ai_standardization_results"'));
  assert.ok(result);
  assert.ok(result.parameters.includes('provider_error'));
  assert.ok(f.queries.some(query => query.sql.startsWith('update "ai_standardization_executions"')));
  assert.ok(f.queries.some(query => query.sql.startsWith('update "ai_jobs"')));
  await f.db.destroy();
});

test('cancelling a job marks members and executions terminal', async () => {
  const f = fixture((query) => {
    if (query.sql.startsWith('select') && query.sql.includes('from "ai_jobs"')) return { rows: [activeJob] };
    if (query.sql.startsWith('update "ai_jobs"') && query.sql.includes('returning')) return { rows: [{ ...activeJob, status: 'cancelled', cancel_requested: true }] };
    if (query.sql.includes('from ai_job_progress p')) return { rows: [{ job_id: 3n, version: 2n, phase: 'standardizing', status: 'cancelled', total: 1n }] };
    return {};
  });

  await new AiRepository(f.db).cancelJob(3n);

  assert.ok(f.queries.some(query => query.sql.startsWith('update "ai_job_input_members"') && query.parameters.includes('cancelled')));
  assert.ok(f.queries.some(query => query.sql.startsWith('update "ai_standardization_executions"') && query.parameters.includes('cancelled')));
  await f.db.destroy();
});

test('recovery scans only active standardization jobs with no live batches', async () => {
  let jobScan = true;
  const f = fixture((query) => {
    if (jobScan && query.sql.includes('from "ai_jobs" as "j"')) {
      jobScan = false;
      return { rows: [{ id: 3n }] };
    }
    if (query.sql.includes('from "ai_jobs"') && query.sql.includes('for update')) return { rows: [activeJob] };
    if (query.sql.includes('from "ai_jobs"')) return { rows: [{ ...activeJob, job_type: 'manual_full', total: 1n }] };
    if (query.sql.includes('from "ai_job_batches"') && query.sql.includes('"status" in')) return { rows: [] };
    if (query.sql.includes('from "ai_job_input_members"') && query.sql.includes('"reason_code"')) return { rows: [] };
    if (query.sql.includes('from "ai_standardization_results"')) return { rows: [] };
    return {};
  });

  assert.equal(await recoverStandardizationFinalization(f.db, 7), 1);

  const scan = f.queries.find(query => query.sql.includes('from "ai_jobs" as "j"'));
  assert.ok(scan);
  assert.match(scan.sql, /"j"\."phase" = .*not exists/);
  assert.ok(scan.parameters.includes('standardizing'));
  assert.ok(scan.parameters.includes(7));
  assert.ok(f.queries.some(query => query.sql.startsWith('update "ai_jobs"') && query.parameters.includes('succeeded')));
  await f.db.destroy();
});

test('recovery fails running request batches the claim window can never readmit', async () => {
  const reaperQuery = (sql: string) => sql.includes('with abandoned as') && sql.includes('update ai_job_batches');
  const f = fixture((query) => {
    if (reaperQuery(query.sql)) return { rows: [{ id: 7n }] };
    return {};
  });

  assert.equal(await recoverAbandonedStandardizationBatches(f.db, 25), 1);

  const update = f.queries.find(query => reaperQuery(query.sql))!;
  assert.ok(update);
  // A batch is abandoned exactly when its lease is gone and the claim filter's
  // request-budget condition can never be true again (crash between the unknown
  // outcome commit and the terminal failure marking).
  assert.match(update.sql, /q\.status = 'running' and q\.step = 'request'/);
  assert.match(update.sql, /\(q\.lease_until is null or q\.lease_until <= now\(\)\)/);
  assert.match(update.sql, /not \(q\.request_budget_used < q\.request_budget_limit and q\.unknown_requests = 0\)/);
  // The claim path only services jobs it considers active, so reap only those.
  assert.match(update.sql, /join ai_jobs j on j\.id = q\.job_id/);
  assert.match(update.sql, /j\.status not in \('paused', 'cancelled', 'failed', 'succeeded'\)/);
  assert.match(update.sql, /not j\.pause_requested and not j\.cancel_requested/);
  // Terminal state mirrors reserveBatchRequest's own failure semantics.
  assert.match(update.sql, /set status = 'failed'/);
  assert.match(update.sql, /error_source = case/);
  assert.match(update.sql, /'request_outcome_unknown'[^,]*else 'request_budget_exhausted'/);
  assert.match(update.sql, /claimed_by = null, claim_token = null, lease_until = null, finished_at = now\(\)/);
  // No row locks: repeated sweeps stay a no-op via the outer status re-check.
  assert.match(update.sql, /where q\.id = abandoned\.id and q\.status = 'running'/);
  assert.doesNotMatch(update.sql, /for update/);
  assert.ok(update.parameters.includes(25));
  await f.db.destroy();
});
