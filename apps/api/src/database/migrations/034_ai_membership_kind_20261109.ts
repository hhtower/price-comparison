import { sql, type Kysely } from 'kysely';
import { AI_MEMBERSHIP_TIERS } from '@price-comparison/catalog/membership-policy';

async function lockTables(database: Kysely<unknown>): Promise<void> {
  await sql`do $locks$
    begin
      for attempt in 1..40 loop
        begin
          lock table shops, products, standard_products, ai_jobs in access exclusive mode nowait;
          return;
        exception when lock_not_available then
          if attempt = 40 then
            raise exception 'Membership feature schema migration could not acquire table locks'
              using errcode = '55P03', hint = 'Pause application writers and workers, then retry the migration.';
          end if;
        end;
        perform pg_sleep(0.25);
      end loop;
    end
  $locks$`.execute(database);
}

export async function up(database: Kysely<unknown>): Promise<void> {
  await lockTables(database);
  const identities = Object.entries(AI_MEMBERSHIP_TIERS).flatMap(([pair, tiers]) =>
    tiers.map(tier => `${pair}/${tier}`));
  const list = identities.map(value => `(${value.split('/').map(part => `'${part.replaceAll("'", "''")}'`).join(',')})`).join(',');
  await sql.raw(`create function is_ai_membership(family text, product text, tier text)
    returns boolean language sql immutable parallel safe as $function$
      select coalesce((family, product, tier) in (${list}), false)
    $function$`).execute(database);
  await sql`alter table products add column membership_features jsonb`.execute(database);
  await sql`alter table ai_jobs drop constraint if exists ai_jobs_job_type_check`.execute(database);
  await sql`alter table ai_jobs add constraint ai_jobs_job_type_check check
    (job_type in ('incremental', 'calibration', 'manual_full', 'tag_extraction', 'membership_features'))`.execute(database);
  await sql`create unique index ai_membership_feature_parent on ai_jobs(parent_identity_job_id)
    where job_type = 'membership_features' and parent_identity_job_id is not null and retry_of_job_id is null`.execute(database);
  await sql`create function invalidate_membership_features() returns trigger language plpgsql as $function$
    begin
      update products set membership_features = null,
        standardization_revision = standardization_revision + 1
        where id = new.id and membership_features is not null;
      return new;
    end
  $function$`.execute(database);
  await sql`create trigger invalidate_membership_features after update on products
    for each row when (old.content_version is distinct from new.content_version
      or old.content_fingerprint is distinct from new.content_fingerprint or old.shop_id is distinct from new.shop_id)
    execute function invalidate_membership_features()`.execute(database);
  await sql`create function invalidate_membership_shop_features() returns trigger language plpgsql as $function$
    begin
      update products set membership_features = null,
        standardization_revision = standardization_revision + 1
        where shop_id = new.id and membership_features is not null;
      return new;
    end
  $function$`.execute(database);
  await sql`create trigger invalidate_membership_shop_features after update of url, protocol, platform on shops
    for each row when (old.url is distinct from new.url or old.protocol is distinct from new.protocol
      or old.platform is distinct from new.platform) execute function invalidate_membership_shop_features()`.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await lockTables(database);
  await sql`drop trigger invalidate_membership_shop_features on shops`.execute(database);
  await sql`drop function invalidate_membership_shop_features()`.execute(database);
  await sql`drop trigger invalidate_membership_features on products`.execute(database);
  await sql`drop function invalidate_membership_features()`.execute(database);
  await sql`drop index ai_membership_feature_parent`.execute(database);
  await sql`alter table ai_jobs drop constraint ai_jobs_job_type_check`.execute(database);
  await sql`alter table ai_jobs add constraint ai_jobs_job_type_check check
    (job_type in ('incremental', 'calibration', 'manual_full', 'tag_extraction'))`.execute(database);
  await sql`alter table products drop column membership_features`.execute(database);
  await sql`drop function is_ai_membership(text, text, text)`.execute(database);
}
