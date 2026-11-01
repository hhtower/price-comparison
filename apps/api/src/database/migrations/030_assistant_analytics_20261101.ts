import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`alter table analytics_visits drop constraint analytics_visits_page_check,
    add constraint analytics_visits_page_check check (page in ('catalog', 'tools_ai', 'tools_ip', 'guide', 'assistant'))`.execute(database);
  await sql`alter table analytics_actions drop constraint analytics_actions_name_check,
    add constraint analytics_actions_name_check check (name in (
      'search', 'filter', 'product_detail', 'outbound', 'shop_submit', 'report_submit', 'ai_test', 'ip_test',
      'reference_open', 'reference_product', 'reference_plans_open', 'reference_plan_select',
      'assistant_open', 'assistant_ask', 'assistant_reply', 'assistant_failure', 'assistant_cancelled',
      'assistant_connection', 'assistant_quote_detail', 'assistant_outbound'
    ))`.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  // Refuse rollback if new events exist instead of deleting analytics history.
  await sql`alter table analytics_actions drop constraint analytics_actions_name_check,
    add constraint analytics_actions_name_check check (name in (
      'search', 'filter', 'product_detail', 'outbound', 'shop_submit', 'report_submit', 'ai_test', 'ip_test',
      'reference_open', 'reference_product', 'reference_plans_open', 'reference_plan_select'
    ))`.execute(database);
  await sql`alter table analytics_visits drop constraint analytics_visits_page_check,
    add constraint analytics_visits_page_check check (page in ('catalog', 'tools_ai', 'tools_ip'))`.execute(database);
}
