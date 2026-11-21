import { sql, type Kysely } from 'kysely';

const legacyApps = ['6448311069', '6473753684', '6477489729', '1232780281',
  '897446215', '544007664', '324684580', '570060128'];
const applePlan = String.raw`^\["[0-9]{5,14}",(("subscription",(null|"P[1-9][0-9]{0,3}[DWMY]"))|("purchase",null))\]$`;

async function replaceChecks(database: Kysely<unknown>, websites: boolean): Promise<void> {
  const apps = websites ? [...legacyApps, '6670324846', 'cursor', 'kiro'] : legacyApps;
  const monthlyPlans = (plans: string[]) => sql.join(plans.map(id => sql.lit(JSON.stringify([id, 'subscription', 'P1M']))));
  const planCheck = websites ? sql`
    (reference_app_id not in ('cursor', 'kiro') and reference_plan_id ~ ${sql.lit(applePlan)})
    or (reference_app_id = 'cursor' and reference_plan_id in (${monthlyPlans(['plus', 'premium', 'super', 'ultra'])}))
    or (reference_app_id = 'kiro' and reference_plan_id in (${monthlyPlans(['pro', 'pro_plus', 'pro_max', 'power'])}))
  ` : sql`reference_plan_id ~ ${sql.lit(applePlan)}`;
  await sql`alter table analytics_actions
    drop constraint analytics_actions_reference_check,
    drop constraint analytics_actions_reference_plan_check,
    add constraint analytics_actions_reference_check check (
      (name not in ('reference_product', 'reference_plans_open', 'reference_plan_select')
        and reference_app_id is null and reference_plan_id is null)
      or (name in ('reference_product', 'reference_plans_open', 'reference_plan_select')
        and reference_app_id is not null and reference_app_id in (${sql.join(apps.map(id => sql.lit(id)))})
        and ((name in ('reference_product', 'reference_plans_open') and reference_plan_id is null)
          or (name = 'reference_plan_select' and reference_plan_id is not null)))
    ),
    add constraint analytics_actions_reference_plan_check check (reference_plan_id is null or (${planCheck}))`.execute(database);
}

export async function up(database: Kysely<unknown>): Promise<void> {
  await replaceChecks(database, true);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  // Refuse rollback when new-source events exist; never discard analytics history.
  await replaceChecks(database, false);
}
