import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import type { DatabaseSchema, JsonValue } from '../src/database/types.js';
import { createPostgresPool } from '../src/database/database.providers.js';
import { normalizeSpec } from '../src/products/product-spec.js';
import { normalizeProductEvidence, productContentFingerprint, productContentKey } from '../src/standardization/fingerprint.js';
import { sanitizeEvidenceText } from '../src/standardization/service-evidence.js';
import { visibleEvidenceText } from '../src/standardization/evidence-text.js';
import { readCurrentMembershipFeatures } from '../src/standardization/membership-classification.js';
import { buildExtractionPayload } from '../src/ai/adaptive-batching.js';
import { validateTagCitations } from '../src/ai/standardization-evidence.js';
import { prepareTextReview, projectShopText } from '../src/shops/shop-text-review.js';

type Row = Record<string, unknown>;
type Patch = { table: string; keys: string[]; columns: string[]; before: Row[]; after: Row[] };
export interface FingerprintRebaseReport {
  applied: boolean;
  products: number;
  alreadyCurrent: number;
  preservedMembership: number;
  staleMembership: number;
  counts: Record<string, number>;
  blocked: Array<{ table: string; id: string; reason: string }>;
  stale: Array<{ table: string; id: string; reason: string }>;
}
export interface FingerprintRebaseOptions {
  apply?: boolean;
  /** Called under the same locks, before the first persistent update. CLI writes a durable backup here. */
  beforeApply?: (backup: { report: FingerprintRebaseReport; changes: Patch[] }) => void | Promise<void>;
}
const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const serialize = (value: unknown) => JSON.stringify(value, (_key, v: unknown) => typeof v === 'bigint' ? String(v) : v);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const pick = (row: Row, columns: string[]): Row => Object.fromEntries(columns.map(column => [column, row[column]]));

function exactRow(document: string): Row {
  // Preserve PostgreSQL microseconds and numeric precision in backups and full-row CAS.
  const runtime = JSON as unknown as { parse(text: string, reviver: (key: string, value: unknown, context: { source?: string }) => unknown): Row;
    rawJSON(text: string): unknown };
  return runtime.parse(document, (_key, value, context) => typeof value === 'number' && !Number.isSafeInteger(value) && context.source
    ? runtime.rawJSON(context.source) : value);
}

function preserveUnchanged(before: unknown, after: unknown, exact: unknown): unknown {
  if (isDeepStrictEqual(before, after)) return exact;
  if (Array.isArray(before) && Array.isArray(after) && Array.isArray(exact) && before.length === after.length) {
    return after.map((item, i) => preserveUnchanged(before[i], item, exact[i]));
  }
  if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
    return Object.fromEntries(Object.entries(after).map(([key, value]) => [key,
      preserveUnchanged(object(before)[key], value, object(exact)[key])]));
  }
  return after;
}

// Frozen pre-whitelist payload shape. The runtime builder no longer reproduces legacy evidenceKey.
function legacyEvidenceKey(product: { name: string; spec: string; source_category: string; source_data: JsonValue }): string {
  const normalized = normalizeProductEvidence({ name: product.name, spec: product.spec,
    sourceCategory: product.source_category, sourceData: product.source_data });
  const project = (value: JsonValue): JsonValue => typeof value === 'string' ? visibleEvidenceText(value)
    : Array.isArray(value) ? value.map(project)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, project(item)])) : value;
  const source = project(normalized.sourceData as JsonValue) as Record<string, JsonValue>;
  const payload: Record<string, JsonValue> = { id: '0', name: visibleEvidenceText(normalized.name),
    spec: visibleEvidenceText(sanitizeEvidenceText(normalized.spec)) };
  if (Object.keys(source).length) payload.sourceData = source;
  const text = projectShopText(product.source_data);
  if (text) payload.shopText = text;
  for (const [key, value] of Object.entries({ category: normalized.sourceCategory,
    vendor: normalized.sourceData.vendor ?? normalized.sourceData.brand, brand: normalized.sourceData.brand,
    family: normalized.sourceData.family, tier: normalized.sourceData.tier, model: normalized.sourceData.model })) {
    if (typeof value === 'string' || typeof value === 'number') payload[key] = visibleEvidenceText(String(value).normalize('NFKC'));
  }
  return hash(JSON.stringify(payload));
}

function validCitations(value: unknown, payload: JsonValue): boolean {
  if (!Array.isArray(value)) return false;
  try {
    validateTagCitations(value as Array<{ path: string; quote: string }>, payload);
    return true;
  } catch { return false; }
}

/** Offline only: stop writers/workers first. No task is resumed, cancelled or queued here. */
export async function rebaseProductFingerprints(database: Kysely<DatabaseSchema>, options: FingerprintRebaseOptions = {}): Promise<FingerprintRebaseReport> {
  return database.transaction().execute(async tx => {
    await sql`set local lock_timeout = '2s'`.execute(tx);
    await sql`lock table shops, products, product_standardization_decisions, standard_product_members, product_tags,
      ai_jobs, ai_job_batches, ai_publication_units, ai_job_inputs, ai_job_input_members,
      ai_standardization_executions, ai_standardization_results, product_change_events,
      standardization_outbox, fetch_runs, catalog_cache_versions in access exclusive mode nowait`.execute(tx);
    const report: FingerprintRebaseReport = { applied: false, products: 0, alreadyCurrent: 0,
      preservedMembership: 0, staleMembership: 0, counts: {}, blocked: [], stale: [] };
    const block = (table: string, id: unknown, reason: string) => report.blocked.push({ table, id: String(id), reason });
    const stale = (table: string, id: unknown, reason: string) => report.stale.push({ table, id: String(id), reason });
    const changes: Patch[] = [];
    const productPatch: Patch = { table: 'products', keys: ['id'], columns: ['content_fingerprint', 'membership_features', 'text_review'], before: [], after: [] };
    const mappings = new Map<string, { id: string; version: string; old_fp: string; new_fp: string; revision: string; payload: JsonValue }>();
    let afterId = -1n;
    for (;;) {
      const products = await tx.selectFrom('products as p').innerJoin('shops as s', 's.id', 'p.shop_id').selectAll('p')
        .select(['s.url as shop_url', 's.protocol as shop_protocol', 's.platform as shop_platform'])
        .where('p.id', '>', afterId).orderBy('p.id').limit(250).execute();
      if (!products.length) break;
      afterId = products.at(-1)!.id;
      for (const p of products) {
      const input = { name: p.source_name || p.name, description: p.source_description || undefined,
        spec: p.spec, sourceCategory: p.source_category, sourceData: p.source_data };
      const next = productContentFingerprint(input);
      if (next === p.content_fingerprint) { report.alreadyCurrent++; continue; }
      if (p.content_fingerprint !== hash(JSON.stringify([p.source_name, p.source_description, normalizeSpec(p.spec)]))) {
        block('products', p.id, 'unrecognized_old_fingerprint'); continue;
      }
      const payload = buildExtractionPayload({ id: String(p.id), name: input.name, description: input.description,
        spec: p.spec, category: p.source_category, sourceData: p.source_data });
      mappings.set(String(p.id), { id: String(p.id), version: String(p.content_version), old_fp: p.content_fingerprint,
        new_fp: next, revision: String(p.standardization_revision), payload });
      const after: Row = { ...p, content_fingerprint: next, text_review_key: null };
      const features = object(p.membership_features);
      const oldValid = readCurrentMembershipFeatures(p.membership_features, p)
        && features.evidenceKey === legacyEvidenceKey(p);
      if (oldValid) {
        const facts = features.tags as Array<{ name: string; value: string }>;
        const evidence = Array.isArray(features.evidence) ? features.evidence : [];
        if (!facts.every(f => validCitations(evidence.filter(e => object(e).name === f.name && object(e).value === f.value), payload))) {
          stale('products', p.id, 'membership_citations_changed');
        } else {
          const updated: Row = { ...features, fingerprint: next }; delete updated.evidenceKey;
          after.membership_features = updated; report.preservedMembership++;
        }
      } else if (p.membership_features !== null) {
        report.staleMembership++;
        if (readCurrentMembershipFeatures(p.membership_features, { ...p, content_fingerprint: next })) {
          stale('products', p.id, 'stale_membership_would_become_current');
        }
      }
      const review = prepareTextReview(p);
      if (review && review.source.url === p.shop_url && review.source.protocol === p.shop_protocol && review.source.platform === p.shop_platform) {
        after.text_review = { ...object(p.text_review), fingerprint: next };
        after.text_review_key = p.text_review_key;
      } else if (prepareTextReview({ ...p, content_fingerprint: next })) {
        stale('products', p.id, 'stale_text_review_would_become_current');
      }
      const columns = ['id', ...productPatch.columns, 'text_review_key'];
      productPatch.before.push(pick(p, columns)); productPatch.after.push(pick(after, columns));
      }
    }
    report.products = mappings.size;
    // Temporary planning rows disappear on both dry-run commit and failed apply.
    await sql`create temporary table fingerprint_rebase_map (
      id bigint primary key, version bigint not null, old_fp text not null, new_fp text not null, revision bigint not null
    ) on commit drop`.execute(tx);
    for (const batch of batches([...mappings.values()])) await sql`insert into fingerprint_rebase_map
      select id, version, old_fp, new_fp, revision from jsonb_to_recordset(${serialize(batch)}::jsonb)
      as m(id bigint, version bigint, old_fp text, new_fp text, revision bigint)`.execute(tx);
    const titleProofs = new Map<string, Set<string>>();
    const eventTitles = await sql<{ product_id: bigint; source_name: string | null; name: string | null; description: string | null; spec: string | null }>`
      select e.product_id, e.payload->>'sourceName' as source_name, e.payload->>'name' as name,
        e.payload->>'description' as description, e.payload->>'spec' as spec
      from product_change_events e join fingerprint_rebase_map f
        on f.id=e.product_id and f.version=e.content_version and f.old_fp=e.fingerprint`.execute(tx);
    for (const event of eventTitles.rows) {
      const f = mappings.get(String(event.product_id))!;
      if (typeof event.source_name !== 'string' || typeof event.description !== 'string' || typeof event.name !== 'string'
        || hash(JSON.stringify([event.source_name, event.description, normalizeSpec(event.spec)])) !== f.old_fp) continue;
      const names = titleProofs.get(f.id) ?? new Set<string>();
      names.add(visibleEvidenceText(normalizeProductEvidence({ name: event.name }).name));
      titleProofs.set(f.id, names);
    }

    const active = await sql<Row>`select m.job_id, m.product_id, m.payload from ai_job_input_members m
      join ai_jobs j on j.id=m.job_id join fingerprint_rebase_map f on f.id=m.product_id
        and f.version=m.content_version and f.old_fp=m.fingerprint
      where j.status in ('queued','running','paused')`.execute(tx);
    for (const row of active.rows) {
      block('ai_jobs', row.job_id, 'active_task');
    }
    if (mappings.size) {
      const unfinished = await tx.selectFrom('ai_jobs').select('id').where('status', 'in', ['queued', 'running', 'paused']).execute();
      const reported = new Set(active.rows.map(row => String(row.job_id)));
      for (const job of unfinished) if (!reported.has(String(job.id))) block('ai_jobs', job.id, 'active_task');
    }
    const leased = await sql<{ id: bigint; kind: string }>`select o.id, 'standardization_outbox' as kind from standardization_outbox o
      join fingerprint_rebase_map f on f.id=o.product_id where o.status='running'
      union all select r.id, 'fetch_runs' from fetch_runs r where r.status='running'
        and exists(select 1 from products p join fingerprint_rebase_map f on f.id=p.id where p.shop_id=r.shop_id)`.execute(tx);
    for (const row of leased.rows) block(row.kind, row.id, 'active_worker_lease');

    async function plan(table: string, keys: string[], columns: string[], rows: Row[], transform: (row: Row) => Row) {
      const patch: Patch = { table, keys, columns, before: [], after: [] };
      for (const row of rows) {
        const updated = transform(row);
        if (columns.every(c => isDeepStrictEqual(row[c], updated[c]))) continue;
        patch.before.push(pick(row, [...keys, ...columns])); patch.after.push(pick(updated, [...keys, ...columns]));
      }
      if (patch.after.length) changes.push(patch);
    }
    function checkFrozen(table: string, id: string, productId: string, frozen: unknown): boolean {
      const current = object(mappings.get(productId)!.payload), prior = object(frozen);
      if (productContentKey(prior) === productContentKey(current)) return true;
      // Only a same-version event proving the original/display title pair can bridge this presentation change.
      if (typeof prior.name === 'string' && titleProofs.get(productId)?.has(prior.name)
        && productContentKey({ ...prior, name: current.name }) === productContentKey(current)) return true;
      stale(table, id, 'completed_frozen_evidence_changed');
      return false;
    }
    const decisions = await sql<Row>`select d.* from product_standardization_decisions d join fingerprint_rebase_map f
      on f.id=d.product_id and f.version=d.content_version and f.old_fp=d.content_fingerprint`.execute(tx);
    const compatibleDecisions = new Set<string>();
    for (const decision of decisions.rows) {
      const f = mappings.get(String(decision.product_id))!;
      if (!decision.evidence_known || checkFrozen('product_standardization_decisions', String(decision.id), f.id, decision.evidence_snapshot)) {
        compatibleDecisions.add(String(decision.id));
      }
    }
    const decisionMap = new Map(decisions.rows.filter(d => compatibleDecisions.has(String(d.id))).map(d => [String(d.id), d]));
    await plan('product_standardization_decisions', ['id'], ['content_fingerprint'], decisions.rows,
      r => compatibleDecisions.has(String(r.id)) ? ({ ...r, content_fingerprint: mappings.get(String(r.product_id))!.new_fp }) : r);
    const inputs = await sql<Row>`select i.* from ai_job_inputs i join ai_jobs j on j.id=i.job_id
      where i.status='succeeded' and j.status not in ('queued','running','paused') and (
        exists(select 1 from fingerprint_rebase_map f where f.id=i.input_id and f.version=i.content_version and f.old_fp=i.fingerprint)
        or exists(select 1 from product_standardization_decisions d join fingerprint_rebase_map f
          on f.id=d.product_id and f.version=d.content_version and f.old_fp=d.content_fingerprint where d.id=i.manual_decision_id))`.execute(tx);
    const compatibleInputs = new Set<string>();
    await plan('ai_job_inputs', ['job_id', 'input_id'], ['fingerprint', 'previous_decision'], inputs.rows, r => {
      const f = mappings.get(String(r.input_id)), d = decisionMap.get(String(r.manual_decision_id)), previous = object(r.previous_decision);
      let compatible = true;
      if (f && String(r.content_version) === f.version && r.fingerprint === f.old_fp) {
        compatible = checkFrozen('ai_job_inputs', `${r.job_id}/${r.input_id}`, f.id, r.payload);
      }
      if (compatible) compatibleInputs.add(`${r.job_id}/${r.input_id}`);
      return { ...r, ...(compatible && f && String(r.content_version) === f.version && r.fingerprint === f.old_fp ? { fingerprint: f.new_fp } : {}),
        ...(compatible && d && previous.fingerprint === d.content_fingerprint && previous.contentVersion === String(d.content_version)
          ? { previous_decision: { ...previous, fingerprint: mappings.get(String(d.product_id))!.new_fp } } : {}) };
    });
    inputs.rows.length = 0;
    const members = await sql<Row>`select m.* from ai_job_input_members m join ai_jobs j on j.id=m.job_id
      join fingerprint_rebase_map f on f.id=m.product_id and f.version=m.content_version and f.old_fp=m.fingerprint
      where m.status in ('classified','unclassified') and j.status not in ('queued','running','paused')`.execute(tx);
    const compatibleMembers = new Set<string>();
    for (const r of members.rows) {
      const f = mappings.get(String(r.product_id))!, output = object(r.output);
      let compatible = compatibleInputs.has(`${r.job_id}/${r.input_id}`)
        && checkFrozen('ai_job_input_members', `${r.job_id}/${r.product_id}`, f.id, r.payload);
      if (String(r.standardization_revision) === f.revision && Array.isArray(output.acceptedTags)
        && !output.acceptedTags.every(tag => validCitations(object(tag).evidence, f.payload))) {
        stale('ai_job_input_members', `${r.job_id}/${r.product_id}`, 'completed_tag_citations_changed');
        compatible = false;
      }
      if (compatible) compatibleMembers.add(`${r.job_id}/${r.product_id}`);
    }
    await plan('ai_job_input_members', ['job_id', 'product_id'], ['fingerprint', 'output'], members.rows, r => {
      const f = mappings.get(String(r.product_id))!, output = object(r.output), versions = object(output.versions);
      if (!compatibleMembers.has(`${r.job_id}/${r.product_id}`)) return r;
      return { ...r, fingerprint: f.new_fp, ...(versions.fingerprint === f.old_fp && versions.contentVersion === f.version
        ? { output: { ...output, versions: { ...versions, fingerprint: f.new_fp } } } : {}) };
    });
    const results = await sql<Row>`select r.* from ai_standardization_results r
      join ai_job_input_members m on m.job_id=r.job_id and m.product_id=r.product_id
      join ai_jobs j on j.id=r.job_id join fingerprint_rebase_map f
        on f.id=r.product_id and f.version=r.content_version and f.old_fp=r.fingerprint
      where m.content_version=f.version and m.fingerprint=f.old_fp and m.status in ('classified','unclassified')
        and j.status not in ('queued','running','paused')`.execute(tx);
    const membersByKey = new Map(members.rows.map(row => [`${row.job_id}/${row.product_id}`, row]));
    const compatibleResults = new Set<string>();
    for (const r of results.rows) {
      const f = mappings.get(String(r.product_id))!, evidence = object(r.decision).evidence;
      const key = `${r.job_id}/${r.product_id}`, member = membersByKey.get(key);
      if (r.status === 'classified' && String(member?.standardization_revision) === f.revision && !validCitations(evidence, f.payload)) {
        stale('ai_standardization_results', `${r.job_id}/${r.product_id}`, 'completed_identity_citations_changed');
      } else if (compatibleMembers.has(key) && compatibleInputs.has(`${r.job_id}/${member?.input_id}`)) {
        compatibleResults.add(key);
      }
    }
    await plan('ai_standardization_results', ['job_id', 'product_id'], ['fingerprint'], results.rows,
      r => compatibleResults.has(`${r.job_id}/${r.product_id}`)
        ? ({ ...r, fingerprint: mappings.get(String(r.product_id))!.new_fp }) : r);
    const executions = await sql<Row>`select e.* from ai_standardization_executions e join ai_jobs j on j.id=e.job_id
      join fingerprint_rebase_map f on f.id=e.product_id and f.version=e.content_version and f.old_fp=e.fingerprint
      where e.status='completed' and j.status not in ('queued','running','paused')`.execute(tx);
    const compatibleExecutions = new Set<string>();
    const resultKeys = new Set(results.rows.map(r => `${r.job_id}/${r.product_id}`));
    for (const r of executions.rows) {
      const key = `${r.job_id}/${r.product_id}`;
      const compatible = compatibleInputs.has(`${r.job_id}/${r.input_id}`) && compatibleMembers.has(key)
        && (!resultKeys.has(key) || compatibleResults.has(key));
      if (compatible && checkFrozen('ai_standardization_executions', String(r.id), String(r.product_id), r.snapshot)) {
        compatibleExecutions.add(String(r.id));
      } else if (resultKeys.has(key) && !compatibleResults.has(key)) {
        stale('ai_standardization_executions', String(r.id), 'completed_result_stale');
      }
    }
    await plan('ai_standardization_executions', ['id'], ['fingerprint'], executions.rows,
      r => compatibleExecutions.has(String(r.id)) ? ({ ...r, fingerprint: mappings.get(String(r.product_id))!.new_fp }) : r);
    const events = await sql<Row>`select e.* from product_change_events e join fingerprint_rebase_map f
      on f.id=e.product_id and f.version=e.content_version and f.old_fp=e.fingerprint`.execute(tx);
    await plan('product_change_events', ['id'], ['fingerprint'], events.rows,
      r => ({ ...r, fingerprint: mappings.get(String(r.product_id))!.new_fp }));
    const outbox = await sql<Row>`select o.* from standardization_outbox o join product_change_events e
      on e.id=o.event_id and e.product_id=o.product_id join fingerprint_rebase_map f
      on f.id=e.product_id and f.version=e.content_version and f.old_fp=e.fingerprint where o.fingerprint=f.old_fp`.execute(tx);
    await plan('standardization_outbox', ['id'], ['fingerprint'], outbox.rows,
      r => ({ ...r, fingerprint: mappings.get(String(r.product_id))!.new_fp }));
    const runs = await sql<Row>`select r.* from fetch_runs r where exists (
      select 1 from jsonb_array_elements(case when jsonb_typeof(r.settlement_payload->'products')='array'
        then r.settlement_payload->'products' else '[]'::jsonb end) item join fingerprint_rebase_map f
        on item->>'productId'=f.id::text and item->>'contentVersion'=f.version::text and item->>'fingerprint'=f.old_fp)`.execute(tx);
    await plan('fetch_runs', ['id'], ['settlement_payload'], runs.rows, r => {
      const payload = object(r.settlement_payload);
      if (!Array.isArray(payload.products)) return r;
      return { ...r, settlement_payload: { ...payload, products: payload.products.map(item => {
        const row = object(item), f = mappings.get(String(row.productId));
        return f && row.contentVersion === f.version && row.fingerprint === f.old_fp ? { ...row, fingerprint: f.new_fp } : item;
      }) } };
    });
    if (productPatch.after.length) changes.push(productPatch);
    for (const patch of changes) {
      for (let offset = 0; offset < patch.after.length; offset += 200) {
        const planned = patch.after.slice(offset, offset + 200);
        const fields = [...patch.keys, ...patch.columns, ...(patch.table === 'products' ? ['text_review_key'] : [])];
        const mutable = [...patch.columns, ...(patch.table === 'products' ? ['text_review_key'] : [])];
        const exact = await sql<{ document: string; ordinal: bigint; unchanged: string }>`select
          (select jsonb_object_agg(key,value) from jsonb_each(to_jsonb(t)) where key=any(${fields}::text[]))::text as document,
          md5((to_jsonb(t)-${mutable}::text[])::text) as unchanged, n.ordinality as ordinal
          from jsonb_populate_recordset(null::${sql.table(patch.table)},${serialize(planned)}::jsonb) with ordinality n
          join ${sql.table(patch.table)} t on ${sql.join(patch.keys.map(k => sql`${sql.ref(`t.${k}`)}=${sql.ref(`n.${k}`)}`), sql` and `)}`.execute(tx);
        assert.equal(exact.rows.length, planned.length, `${patch.table} snapshot mismatch`);
        for (const row of exact.rows) {
          const index = offset + Number(row.ordinal) - 1;
          const previous = exactRow(row.document), updated = patch.after[index]!;
          const original = patch.before[index]!;
          patch.before[index] = { ...previous, _unchanged: row.unchanged };
          patch.after[index] = { ...previous, ...Object.fromEntries(patch.columns.map(column => [column,
            preserveUnchanged(original[column], updated[column], previous[column])])),
            ...(patch.table === 'products' ? { text_review_key: updated.text_review_key } : {}), _unchanged: row.unchanged };
        }
      }
      assert.equal(new Set(patch.after.map(row => serialize(patch.keys.map(k => row[k])))).size, patch.after.length, `duplicate ${patch.table} update`);
      report.counts[patch.table] = patch.after.length;
      if (patch.table === 'ai_standardization_executions' || patch.table === 'standardization_outbox') {
        const execution = patch.table === 'ai_standardization_executions';
        const duplicate = await sql<Row>`select t.product_id from ${sql.table(patch.table)} t
          left join jsonb_populate_recordset(null::${sql.table(patch.table)}, ${serialize(patch.after)}::jsonb) n on n.id=t.id
          ${execution ? sql`` : sql`where t.status in ('queued','running')`}
          group by t.product_id, ${execution ? sql`t.content_version,` : sql``} coalesce(n.fingerprint,t.fingerprint)
          having count(*)>1`.execute(tx);
        for (const row of duplicate.rows) block(patch.table, row.product_id, 'unique_fingerprint_conflict');
      }
    }
    if (!options.apply) return report;
    if (report.blocked.length) throw new Error(`Fingerprint rebase blocked: ${serialize(report.blocked)}`);
    if (!changes.length) return report;
    await options.beforeApply?.({ report, changes });
    const triggerStates = await sql<{ tgname: string; tgenabled: string; relation: string }>`select tgname,tgenabled,tgrelid::regclass::text as relation
      from pg_trigger where (tgrelid='products'::regclass and tgname='invalidate_membership_features')
        or (tgrelid='product_standardization_decisions'::regclass and tgname='prevent_standardization_history_rewrite')`.execute(tx);
    assert.equal(triggerStates.rows.length, 2, 'Expected fingerprint and audit triggers');
    await sql`alter table products disable trigger invalidate_membership_features`.execute(tx);
    await sql`alter table product_standardization_decisions disable trigger prevent_standardization_history_rewrite`.execute(tx);
    for (const patch of changes) await applyPatch(tx, patch);
    for (const trigger of triggerStates.rows) {
      const table = trigger.tgname === 'invalidate_membership_features' ? 'products' : 'product_standardization_decisions';
      const mode = ({ O: 'enable', A: 'enable always', R: 'enable replica', D: 'disable' } as Record<string, string>)[trigger.tgenabled];
      assert.ok(mode);
      await sql`alter table ${sql.table(table)} ${sql.raw(mode)} trigger ${sql.id(trigger.tgname)}`.execute(tx);
    }
    const cache = await sql`update catalog_cache_versions set version=version+1, updated_at=clock_timestamp() where id=1 returning id`.execute(tx);
    assert.equal(cache.rows.length, 1, 'Missing catalog cache version');
    report.applied = true;
    return report;
  });
}

function* batches<T>(rows: readonly T[], size = 200): Generator<T[]> {
  for (let offset = 0; offset < rows.length; offset += size) yield rows.slice(offset, offset + size);
}

async function applyPatch(tx: Transaction<DatabaseSchema>, patch: Patch): Promise<void> {
  const mutable = [...patch.columns, ...(patch.table === 'products' ? ['text_review_key'] : [])];
  for (let offset = 0; offset < patch.after.length; offset += 200) {
    const before = serialize(patch.before.slice(offset, offset + 200)), after = serialize(patch.after.slice(offset, offset + 200));
    const join = (a: string, b: string) => sql.join(patch.keys.map(k => sql`${sql.ref(`${a}.${k}`)}=${sql.ref(`${b}.${k}`)}`), sql` and `);
    const equal = (a: string, b: string) => sql.join(mutable.map(k => sql`${sql.ref(`${a}.${k}`)} is not distinct from ${sql.ref(`${b}.${k}`)}`), sql` and `);
    const changed = await sql`update ${sql.table(patch.table)} t set
      ${sql.join(patch.columns.map(c => sql`${sql.id(c)}=${sql.ref(`n.${c}`)}`))}
      from jsonb_populate_recordset(null::${sql.table(patch.table)},${after}::jsonb) n,
        jsonb_array_elements(${before}::jsonb) document,
        lateral jsonb_populate_record(null::${sql.table(patch.table)},document.value) b
      where ${join('t','n')} and ${join('t','b')} and ${equal('t','b')}
        and md5((to_jsonb(t)-${mutable}::text[])::text)=document.value->>'_unchanged' returning ${sql.ref(`t.${patch.keys[0]}`)}`.execute(tx);
    assert.equal(changed.rows.length, patch.after.slice(offset, offset + 200).length, `${patch.table} CAS failed`);
    // A separate statement observes AFTER-trigger effects; UPDATE RETURNING alone does not.
    const verified = await sql<{ count: number }>`select count(*)::int as count from ${sql.table(patch.table)} t
      cross join jsonb_array_elements(${after}::jsonb) document
      cross join lateral jsonb_populate_record(null::${sql.table(patch.table)},document.value) n
      where ${join('t','n')} and ${equal('t','n')}
        and md5((to_jsonb(t)-${mutable}::text[])::text)=document.value->>'_unchanged'`.execute(tx);
    assert.equal(verified.rows[0]!.count, changed.rows.length, `${patch.table} post-update verification failed`);
  }
}

async function main() {
  assert.ok(process.argv.slice(2).every(arg => arg === '--apply'), 'Only --apply is supported; default is dry-run');
  await import('../src/config/env.js');
  const db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool: createPostgresPool() }) });
  try {
    const report = await rebaseProductFingerprints(db, { apply: process.argv.includes('--apply'), beforeApply: backup => {
      const directory = path.resolve('.local/product-fingerprint-rebase');
      mkdirSync(directory, { recursive: true });
      const filename = path.join(directory, `backup-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
      writeFileSync(filename, serialize(backup), { flag: 'wx', flush: true });
      console.info(`Backup: ${filename}`);
    } });
    console.info(serialize(report));
    if (report.blocked.length) process.exitCode = 1;
  } finally { await db.destroy(); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
