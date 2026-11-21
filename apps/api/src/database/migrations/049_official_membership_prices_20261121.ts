import { sql, type Kysely } from 'kysely';
import { up as restorePreviousChecks } from './048_official_reference_sources_20261121.js';

const applePlan = String.raw`^\["[0-9]{5,14}",(("subscription",(null|"P[1-9][0-9]{0,3}[DWMY]"))|("purchase",null))\]$`;
const plans: Record<string, [string, string][]> = {
  cursor: [['plus', 'P1M'], ['premium', 'P1M'], ['super', 'P1M'], ['ultra', 'P1M']],
  kiro: [['pro', 'P1M'], ['pro_plus', 'P1M'], ['pro_max', 'P1M'], ['power', 'P1M']],
  '6448311069': [['business-standard-month', 'P1M'], ['business-standard-year', 'P1Y'],
    ['business-premium-month', 'P1M'], ['business-premium-year', 'P1Y']],
  '6473753684': [['team-standard-month', 'P1M'], ['team-standard-year', 'P1Y'],
    ['team-premium-month', 'P1M'], ['team-premium-year', 'P1Y']],
  '6477489729': [['google-ai-plus-month', 'P1M'], ['google-ai-pro-month', 'P1M'],
    ['google-ai-ultra-5x-month', 'P1M'], ['google-ai-ultra-20x-month', 'P1M']],
};

export async function up(database: Kysely<unknown>): Promise<void> {
  const websitePlans = Object.entries(plans).map(([app, entries]) =>
    sql`(reference_app_id = ${sql.lit(app)} and reference_plan_id in (
      ${sql.join(entries.map(([id, period]) => sql.lit(JSON.stringify([id, 'subscription', period]))))}
    ))`);
  await sql`alter table analytics_actions drop constraint analytics_actions_reference_plan_check,
    add constraint analytics_actions_reference_plan_check check (reference_plan_id is null
      or (reference_app_id not in ('cursor', 'kiro') and reference_plan_id ~ ${sql.lit(applePlan)})
      or (${sql.join(websitePlans, sql` or `)}))`.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  // Existing new-plan events prevent rollback rather than being deleted.
  await restorePreviousChecks(database);
}
