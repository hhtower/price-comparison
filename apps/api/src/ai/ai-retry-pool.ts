import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/types.js';
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
export function currentUnclassifiedQuery(db: Kysely<DatabaseSchema>) {
  return db.selectFrom('products as p')
    .innerJoinLateral(standardizationResultSource(sql.ref('p.id')).as('r'), join => join.onTrue())
    .innerJoin('shops as s', 's.id', 'p.shop_id')
    .innerJoin('ai_jobs as result_job', 'result_job.id', 'r.job_id')
    .innerJoin('ai_job_input_members as m', join => join.onRef('m.job_id', '=', 'r.job_id').onRef('m.product_id', '=', 'r.product_id'))
    .leftJoin('ai_job_batches as b', 'b.id', 'r.batch_id')
    .where('r.status', '=', 'unclassified')
    .where(eb => eb.or([eb('r.reason_code', 'is', null), eb('r.reason_code', '!=', API_RELAY_EXCLUSION_CODE)]))
    .where(sql<boolean>`(r.reason_code='request_outcome_unknown' or (
      result_job.prompt_version=${PIPELINE_VERSIONS.prompt} and result_job.rule_version=${STANDARDIZATION_POLICY_VERSION}
      and result_job.pipeline_versions @> ${JSON.stringify(taskResultVersions('standardization'))}::jsonb))`)
    .where('p.deleted_at', 'is', null).where('s.deleted_at', 'is', null).where('s.enabled', '=', true)
    .where('p.standardization_locked', '=', false)
    .where(sql<boolean>`not ${currentManualDecision}`)
    .whereRef('p.standardization_revision', '=', 'm.standardization_revision')
    .whereRef('p.content_version', '=', 'm.content_version')
    .whereRef('p.content_version', '=', 'r.content_version')
    .whereRef('p.content_fingerprint', '=', 'r.fingerprint')
    .whereRef('p.content_fingerprint', '=', 'm.fingerprint')
    .where(sql<boolean>`not exists (
      select 1 from standard_product_members assignment
      join standard_products standard on standard.id = assignment.standard_product_id
      where assignment.product_id = p.id and assignment.publication_state = 'published'
        and standard.verification_state = 'verified' and standard.merged_into_id is null
    )`)
    // Task order wins over completion order: a late old result cannot resurrect an error.
    .where(sql<boolean>`not exists (
      select 1 from ${standardizationResultSource(sql.ref('p.id'))} newer
      join ai_job_input_members newer_member on newer_member.job_id = newer.job_id and newer_member.product_id = newer.product_id
      join ai_jobs newer_result_job on newer_result_job.id = newer.job_id
      where newer.product_id = r.product_id and newer.job_id > r.job_id
        and (newer.reason_code='request_outcome_unknown' or (
          newer_result_job.prompt_version = ${PIPELINE_VERSIONS.prompt} and newer_result_job.rule_version = ${STANDARDIZATION_POLICY_VERSION}
          and newer_result_job.pipeline_versions @> ${JSON.stringify(taskResultVersions('standardization'))}::jsonb))
        and newer.content_version = p.content_version and newer_member.content_version = p.content_version
        and newer.fingerprint = p.content_fingerprint and newer_member.fingerprint = p.content_fingerprint
        and newer_member.standardization_revision = p.standardization_revision
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
    const query = retryPoolQuery(tx);
    const count = await query.select(sql<number>`count(*)::int`.as('total')).executeTakeFirstOrThrow();
    const rows = await query.select([
      'p.id as productId', 'p.name', 'p.spec', 's.name as shopName', 'r.job_id as sourceJobId',
      'r.reason_code as reasonCode', 'r.reason', 'r.evidence', 'r.published_at as failedAt', 'b.error as requestError',
    ]).$if(input.afterId !== undefined, q => q.where('p.id', '>', input.afterId!))
      .orderBy('p.id').limit(input.limit + 1).execute();
    const items = rows.slice(0, input.limit).map(({ requestError, ...row }) => ({
      ...row, productId: String(row.productId), sourceJobId: String(row.sourceJobId),
      reason: row.reasonCode === 'request_outcome_unknown' ? unknownRequestReason(requestError) : row.reason,
    }));
    return { items, total: count.total, nextCursor: rows.length > input.limit ? items.at(-1)!.productId : null };
  });
}
