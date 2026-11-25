import { sql, type RawBuilder, type Selectable } from 'kysely';
import type { AiStandardizationResultTable } from '../database/types.js';
import { currentExecutionPipeline } from './pipeline-versions.js';
import { lostBatchRequest } from './request-outcome.js';

/** Read-only fallback keeps lost requests visible before finalization can save member outcomes. */
export function standardizationResultSource(
  productId: RawBuilder<unknown>,
  lost: RawBuilder<Selectable<AiStandardizationResultTable>> = lostStandardizationResults(productId),
) {
  return sql<Selectable<AiStandardizationResultTable>>`(
    select job_id,product_id,batch_id,input_id,content_version,fingerprint,status,standard_product_id,
      tags,evidence,reason_code,reason,decision,current_assignment_preserved,published_at,created_at
    from ai_standardization_results where product_id=${productId}
    union all (${lost})
  )`;
}

export function lostStandardizationResults(productId?: RawBuilder<unknown>) {
  const executing = sql<boolean>`j.status in ('queued','running') and not j.pause_requested and not j.cancel_requested
    and ${currentExecutionPipeline()}`;
  return sql<Selectable<AiStandardizationResultTable>>`select distinct on (m.job_id,m.product_id)
      m.job_id,m.product_id,b.id as batch_id,m.input_id,m.content_version,m.fingerprint,
      'unclassified'::text as status,null::bigint as standard_product_id,
      '[]'::jsonb as tags,'[]'::jsonb as evidence,'request_outcome_unknown'::text as reason_code,
      '模型请求结果未能确认，未自动重发；可手动重试'::text as reason,
      '{}'::jsonb as decision,true as current_assignment_preserved,
      coalesce(b.finished_at,b.queued_at) as published_at,b.queued_at as created_at
    from ai_job_input_members m join ai_jobs j on j.id=m.job_id
    join ai_job_batches b on b.job_id=m.job_id and b.product_ids @> jsonb_build_array(m.input_id::text)
    where ${productId === undefined ? sql`true` : sql`m.product_id=${productId}`}
      and j.job_type not in ('tag_extraction','membership_features','text_review')
      and b.step='request' and ${lostBatchRequest('b', executing)}
      and not exists(select 1 from ai_standardization_results saved where saved.job_id=m.job_id and saved.product_id=m.product_id)
    order by m.job_id,m.product_id,b.id desc`;
}
