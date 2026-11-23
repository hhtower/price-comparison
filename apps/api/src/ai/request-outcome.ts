import { sql, type RawBuilder } from 'kysely';

export function lostBatchRequest(batch: string, executionCurrent: RawBuilder<boolean>) {
  const field = (name: string) => sql.ref(`${batch}.${name}`);
  return sql<boolean>`(${field('unknown_requests')} > 0 or (
    ${field('request_budget_used')} > ${field('confirmed_requests')} + ${field('unknown_requests')}
    and not coalesce(${field('status')}='running' and ${field('lease_until')}>clock_timestamp()
      and (${executionCurrent}),false)))`;
}

/** Batch counters survive crashes and cancellation before a member outcome can be saved. */
export function hasUncertainMemberRequest(member = 'm') {
  return sql<boolean>`exists (select 1 from ai_job_batches uncertain_batch
    where uncertain_batch.job_id = ${sql.ref(member + '.job_id')} and uncertain_batch.step = 'request'
      and uncertain_batch.product_ids @> jsonb_build_array(${sql.ref(member + '.input_id')}::text)
      and (uncertain_batch.unknown_requests > 0
        or uncertain_batch.request_budget_used > uncertain_batch.confirmed_requests + uncertain_batch.unknown_requests))`;
}

/** Display lost requests as unknown without mislabelling an ordinary live stream. */
export function hasLostMemberRequest(member = 'm', executionCurrent: RawBuilder<boolean> = sql<boolean>`true`) {
  return sql<boolean>`exists (select 1 from ai_job_batches lost_batch
    where lost_batch.job_id = ${sql.ref(member + '.job_id')} and lost_batch.step = 'request'
      and lost_batch.product_ids @> jsonb_build_array(${sql.ref(member + '.input_id')}::text)
      and ${lostBatchRequest('lost_batch', executionCurrent)})`;
}

/** Explain stored provider failures without exposing arbitrary upstream response content. */
export function unknownRequestReason(error?: string | null): string {
  const message = error ?? '';
  const timeout = /timed out after (\d+)ms/iu.exec(message);
  if (timeout) return `模型请求超时（${Number(timeout[1]) / 1000} 秒），结果未知`;
  if (/timeout|timed out/iu.test(message)) return '模型请求超时，结果未知';
  if (/busy|overload/iu.test(message)) return '模型服务繁忙，未取得完整结果';
  if (/unavailable/iu.test(message)) return '模型上游服务暂时不可用，未取得完整结果';
  if (/stream|terminated|socket|connection/iu.test(message)) return '模型响应连接中断，未取得完整结果';
  if (/openai_error/iu.test(message)) return '模型上游服务返回错误，未取得完整结果';
  return '模型请求结果未能确认，未自动重发；可手动重试';
}
