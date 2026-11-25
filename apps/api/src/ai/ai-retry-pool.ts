import { sql, type Kysely, type RawBuilder, type Selectable } from 'kysely';
import type { DatabaseSchema, AiStandardizationResultTable, ProductTable } from '../database/types.js';
import { unknownRequestReason } from './request-outcome.js';
import { hasActiveStandardizationWork, RETRYABLE_RESULT_REASONS } from './product-standardization-state.js';
import { PIPELINE_VERSIONS, STANDARDIZATION_POLICY_VERSION, taskResultVersions } from './pipeline-versions.js';
import { API_RELAY_EXCLUSION_CODE } from '../standardization/catalog-exclusion.js';
import { hasUsableOffer } from './offer-eligibility.js';
import { standardizationResultSource } from './standardization-result-source.js';

export const currentManualDecision = sql<boolean>`exists (
  select 1 from product_standardization_decisions d where d.product_id = p.id
    and d.evidence_known and d.content_version = p.content_version and d.content_fingerprint = p.content_fingerprint
    and not exists (select 1 from product_standardization_decisions newer_decision
      where newer_decision.product_id = d.product_id and newer_decision.id > d.id)
)`;

/** The latest result for current product evidence and revision, with no current assignment. */
export function currentUnclassifiedQuery(db: Kysely<DatabaseSchema>, jobId?: RawBuilder<bigint>) {
  // Restrict a per-task report before evaluating the latest result across all tasks.
  const products = (jobId ? sql<ProductTable>`(
    select product.* from ai_job_input_members scope_member
    join products product on product.id = scope_member.product_id
    where scope_member.job_id = ${jobId} offset 0
  )` : sql<ProductTable>`products`).as('p');
  return db.selectFrom(products)
    .innerJoinLateral(sql<Selectable<AiStandardizationResultTable>>`(
      select result.* from ${standardizationResultSource(sql.ref('p.id'))} result
      join ai_job_input_members member on member.job_id = result.job_id and member.product_id = result.product_id
      join ai_jobs result_job on result_job.id = result.job_id
      where result.content_version = p.content_version and result.fingerprint = p.content_fingerprint
        and member.content_version = p.content_version and member.fingerprint = p.content_fingerprint
        and member.standardization_revision = p.standardization_revision
        and (result.reason_code = 'request_outcome_unknown' or (
          result_job.prompt_version = ${PIPELINE_VERSIONS.prompt} and result_job.rule_version = ${STANDARDIZATION_POLICY_VERSION}
          and result_job.pipeline_versions @> ${JSON.stringify(taskResultVersions('standardization'))}::jsonb))
      order by result.job_id desc limit 1
    )`.as('r'), join => join.onTrue())
    .innerJoin('shops as s', 's.id', 'p.shop_id')
    .leftJoin('ai_job_batches as b', 'b.id', 'r.batch_id')
    .where('r.status', '=', 'unclassified')
    .where(eb => eb.or([eb('r.reason_code', 'is', null), eb('r.reason_code', '!=', API_RELAY_EXCLUSION_CODE)]))
    .where('p.deleted_at', 'is', null).where('s.deleted_at', 'is', null).where('s.enabled', '=', true)
    .where('p.standardization_locked', '=', false)
    .where(sql<boolean>`not ${currentManualDecision}`)
    .where(sql<boolean>`not exists (
      select 1 from standard_product_members assignment
      join standard_products standard on standard.id = assignment.standard_product_id
      where assignment.product_id = p.id and assignment.publication_state = 'published'
        and standard.verification_state = 'verified' and standard.merged_into_id is null
    )`);
}

/** Current unmatched results and technical failures share the existing explicit retry controls. */
export function retryPoolQuery(db: Kysely<DatabaseSchema>) {
  return currentUnclassifiedQuery(db)
    .where(hasUsableOffer())
    .where('r.reason_code', 'in', RETRYABLE_RESULT_REASONS)
    .where(sql<boolean>`not ${hasActiveStandardizationWork}`);
}

export async function readRetryPool(db: Kysely<DatabaseSchema>, input: { limit: number; afterId?: bigint }) {
  return db.transaction().setIsolationLevel('repeatable read').execute(async tx => {
    await sql`set local jit = off`.execute(tx);
    const unresolved = currentUnclassifiedQuery(tx).where('r.reason_code', 'in', RETRYABLE_RESULT_REASONS)
      .select(['p.id as productId', 'r.job_id as sourceJobId']);
    const details = tx.selectFrom('products as p')
      .innerJoin(sql<{ productId: bigint; sourceJobId: bigint }>`page`.as('page'), 'page.productId', 'p.id')
      .innerJoin('shops as s', 's.id', 'p.shop_id')
      .innerJoinLateral(standardizationResultSource(sql.ref('p.id')).as('r'),
        join => join.onRef('r.job_id', '=', 'page.sourceJobId'))
      .leftJoin('ai_job_batches as b', 'b.id', 'r.batch_id')
      .select([
      'p.id as productId', 'p.name', 'p.spec', 's.name as shopName', 'r.job_id as sourceJobId',
      'r.reason_code as reasonCode', 'r.reason', 'r.evidence', 'r.published_at as failedAt', 'b.error as requestError',
    ]);
    type Candidate = Awaited<ReturnType<typeof details.execute>>[number];
    const result = await sql<Candidate & { total: number }>`
      with unresolved as materialized (${unresolved}),
      candidates as materialized (
        select u.* from unresolved u join products p on p.id=u."productId"
        where ${hasUsableOffer()} and not ${hasActiveStandardizationWork}
      ),
      totals as (select count(*)::int as total from candidates),
      page as (
        select * from candidates ${input.afterId === undefined ? sql`` : sql`where "productId" > ${input.afterId}`}
        order by "productId" limit ${input.limit + 1}
      )
      select details.*, totals.total from totals left join (${details}) details on true order by details."productId"
    `.execute(tx);
    const total = result.rows[0]!.total;
    const rows = result.rows.filter(row => row.productId !== null).map(({ total: _total, ...row }) => row);
    const items = rows.slice(0, input.limit).map(({ requestError, ...row }) => ({
      ...row, productId: String(row.productId), sourceJobId: String(row.sourceJobId),
      reason: row.reasonCode === 'request_outcome_unknown' ? unknownRequestReason(requestError) : row.reason,
    }));
    return { items, total, nextCursor: rows.length > input.limit ? items.at(-1)!.productId : null };
  });
}
