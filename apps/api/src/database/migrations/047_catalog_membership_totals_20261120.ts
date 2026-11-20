import { sql, type Kysely } from 'kysely';

const sources = ['catalog_membership_kinds', 'ai_job_input_members', 'products'] as const;

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`alter table catalog_read_shop_totals add column membership_policy_version text`.execute(database);
  await sql`create index catalog_read_offers_facets on catalog_read_offers
    (currency, standard_product_id, shop_id) include (facet_tags) where available`.execute(database);
  await sql`create index catalog_read_offer_prices_available on catalog_read_offer_prices
    (currency, standard_product_id, product_id) include (shop_id, price, captured_at) where available`.execute(database);
  await sql`create table catalog_read_membership_totals (
    standard_product_id bigint not null, shop_id bigint not null, currency text not null,
    membership_kind text not null, min_price numeric, max_price numeric,
    latest_captured_at timestamptz not null, product_count integer not null, winner_id bigint not null,
    primary key (standard_product_id, currency, membership_kind, shop_id)
  )`.execute(database);
  for (const table of sources) {
    for (const operation of table === 'products' ? ['update'] : ['insert', 'update', 'delete']) {
      const name = `catalog_membership_changes_${table}_${operation}`;
      const column = table === 'products' ? 'id' : 'product_id';
      const fields = table === 'products' ? ['content_version', 'content_fingerprint', 'standardization_revision', 'shop_id']
        : table === 'catalog_membership_kinds' ? ['kind', 'policy_version']
        : ['status', 'content_version', 'fingerprint', 'standardization_revision', 'payload'];
      const keys = table === 'ai_job_input_members' ? ['job_id', 'product_id'] : [column];
      const changes = operation === 'update' ? sql`
        select n.${sql.id(column)} as product_id${table === 'ai_job_input_members' ? sql`, n.job_id` : sql``}
        from new_rows n join old_rows o using (${sql.join(keys.map(key => sql.id(key)))})
        where (${sql.join(fields.map(field => sql.ref(`n.${field}`)))})
          is distinct from (${sql.join(fields.map(field => sql.ref(`o.${field}`)))})`
        : sql`select ${sql.id(column)} as product_id${table === 'ai_job_input_members' ? sql`, job_id` : sql``}
          from ${sql.table(operation === 'insert' ? 'new_rows' : 'old_rows')}`;
      await sql`create function ${sql.id(name)}() returns trigger
        language plpgsql set search_path from current as $function$
        begin
          insert into catalog_projection_changes (standard_product_id)
            select distinct r.standard_product_id from catalog_read_offer_prices r
            join (${changes}) changed using (product_id)
            ${table === 'ai_job_input_members' && operation !== 'delete' ? sql`where exists (
              select 1 from ai_jobs j where j.id = changed.job_id and j.job_type = 'membership_features'
            )` : sql``};
          return null;
        end $function$`.execute(database);
      await sql`create trigger ${sql.id(name)} after ${sql.raw(operation)} on ${sql.table(table)}
        referencing ${sql.raw(`${operation !== 'insert' ? 'old table as old_rows' : ''}
          ${operation !== 'delete' ? 'new table as new_rows' : ''}`)}
        for each statement execute function ${sql.id(name)}()`.execute(database);
    }
  }
  await sql`create function catalog_membership_shop_changed() returns trigger
    language plpgsql set search_path from current as $function$
    begin
      insert into catalog_projection_changes (standard_product_id)
        select distinct standard_product_id from catalog_read_offer_prices where shop_id = new.id;
      return null;
    end $function$`.execute(database);
  await sql`create trigger catalog_membership_shop_changed after update of url, protocol, platform on shops
    for each row when ((old.url, old.protocol, old.platform) is distinct from (new.url, new.protocol, new.platform))
    execute function catalog_membership_shop_changed()`.execute(database);
  await sql`create function catalog_membership_job_changed() returns trigger
    language plpgsql set search_path from current as $function$
    begin
      insert into catalog_projection_changes (standard_product_id)
        select distinct r.standard_product_id from catalog_read_offer_prices r
        join ai_job_input_members m using (product_id) where m.job_id = new.id;
      return null;
    end $function$`.execute(database);
  await sql`create trigger catalog_membership_job_changed after update of job_type on ai_jobs
    for each row when (old.job_type is distinct from new.job_type)
    execute function catalog_membership_job_changed()`.execute(database);
  await sql`create function catalog_membership_truncated() returns trigger
    language plpgsql set search_path from current as $function$
    begin
      insert into catalog_projection_changes (standard_product_id)
        select distinct standard_product_id from catalog_read_offer_prices;
      return null;
    end $function$`.execute(database);
  for (const table of sources.slice(0, 2)) {
    await sql`create trigger catalog_membership_truncated before truncate on ${sql.table(table)}
      for each statement execute function catalog_membership_truncated()`.execute(database);
  }
  await sql`insert into catalog_projection_changes (standard_product_id)
    select distinct r.standard_product_id from catalog_read_offer_prices r
    where not exists (select 1 from catalog_projection_changes pending
      where pending.standard_product_id = r.standard_product_id)`.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  for (const table of sources) {
    for (const operation of table === 'products' ? ['update'] : ['insert', 'update', 'delete']) {
      const name = `catalog_membership_changes_${table}_${operation}`;
      await sql`drop trigger ${sql.id(name)} on ${sql.table(table)}`.execute(database);
      await sql`drop function ${sql.id(name)}()`.execute(database);
    }
  }
  for (const table of sources.slice(0, 2)) {
    await sql`drop trigger catalog_membership_truncated on ${sql.table(table)}`.execute(database);
  }
  await sql`drop function catalog_membership_truncated()`.execute(database);
  await sql`drop trigger catalog_membership_shop_changed on shops`.execute(database);
  await sql`drop function catalog_membership_shop_changed()`.execute(database);
  await sql`drop trigger catalog_membership_job_changed on ai_jobs`.execute(database);
  await sql`drop function catalog_membership_job_changed()`.execute(database);
  await sql`drop table catalog_read_membership_totals`.execute(database);
  await sql`alter table catalog_read_shop_totals drop column membership_policy_version`.execute(database);
  await sql`drop index catalog_read_offers_facets`.execute(database);
  await sql`drop index catalog_read_offer_prices_available`.execute(database);
}
