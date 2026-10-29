import { sql, type Kysely } from 'kysely';

const EVENTS = [
  {
    event: 'insert',
    transition: 'referencing new table as new_rows',
    deltas: 'select facet_tags, 1::bigint as amount from new_rows',
  },
  {
    event: 'update',
    transition: 'referencing old table as old_rows new table as new_rows',
    deltas: `select facet_tags, 1::bigint as amount from new_rows
      union all select facet_tags, -1::bigint as amount from old_rows`,
  },
  {
    event: 'delete',
    transition: 'referencing old table as old_rows',
    deltas: 'select facet_tags, -1::bigint as amount from old_rows',
  },
] as const;

export async function up(database: Kysely<unknown>): Promise<void> {
  if (!database.isTransaction) return database.transaction().execute(up);
  await sql`lock table catalog_product_facts in share row exclusive mode`.execute(database);
  await sql`create table catalog_read_facet_counts (
    facet_tags text primary key,
    product_count bigint not null check (product_count >= 0)
  )`.execute(database);
  // Global prepared-set frequencies include unpublished products and products without quotes.
  await sql`insert into catalog_read_facet_counts (facet_tags, product_count)
    select facet_tags, count(*) from catalog_product_facts group by facet_tags`.execute(database);

  for (const { event, transition, deltas } of EVENTS) {
    const name = `catalog_read_facet_counts_${event}`;
    await sql.raw(`create function ${name}() returns trigger
      language plpgsql set search_path from current as $function$
      declare change record; remaining bigint;
      begin
        for change in
          select facet_tags, sum(amount)::bigint as amount from (${deltas}) changes
          group by facet_tags having sum(amount) <> 0 order by facet_tags collate "C"
        loop
          -- Lock existing keys too: DO NOTHING can race with a concurrent last-row deletion.
          insert into catalog_read_facet_counts as stored (facet_tags, product_count)
            values (change.facet_tags, 0)
          on conflict (facet_tags) do update set product_count = stored.product_count;
          update catalog_read_facet_counts set product_count = product_count + change.amount
            where facet_tags = change.facet_tags returning product_count into remaining;
          if remaining = 0 then
            delete from catalog_read_facet_counts where facet_tags = change.facet_tags;
          end if;
        end loop;
        return null;
      end
      $function$`).execute(database);
    await sql.raw(`create trigger ${name} after ${event} on catalog_product_facts ${transition}
      for each statement execute function ${name}()`).execute(database);
  }
  await sql`create function catalog_read_facet_counts_truncate() returns trigger
    language plpgsql set search_path from current as $function$
    begin
      truncate catalog_read_facet_counts;
      return null;
    end
    $function$`.execute(database);
  await sql`create trigger catalog_read_facet_counts_truncate after truncate on catalog_product_facts
    for each statement execute function catalog_read_facet_counts_truncate()`.execute(database);
  await sql`analyze catalog_read_facet_counts`.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  if (!database.isTransaction) return database.transaction().execute(down);
  await sql`lock table catalog_product_facts in share row exclusive mode`.execute(database);
  for (const event of [...EVENTS.map(({ event }) => event), 'truncate']) {
    const name = `catalog_read_facet_counts_${event}`;
    await sql.raw(`drop trigger ${name} on catalog_product_facts`).execute(database);
    await sql.raw(`drop function ${name}()`).execute(database);
  }
  await sql`drop table catalog_read_facet_counts`.execute(database);
}
