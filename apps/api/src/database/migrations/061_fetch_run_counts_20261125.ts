import { sql, type Kysely } from 'kysely';

const EVENTS = [
  {
    event: 'insert',
    transition: 'referencing new table as new_rows',
    deltas: 'select shop_id, status, 1::bigint as amount from new_rows',
  },
  {
    event: 'update',
    transition: 'referencing old table as old_rows new table as new_rows',
    deltas: `select shop_id, status, 1::bigint as amount from new_rows
      union all select shop_id, status, -1::bigint as amount from old_rows`,
  },
  {
    event: 'delete',
    transition: 'referencing old table as old_rows',
    deltas: 'select shop_id, status, -1::bigint as amount from old_rows',
  },
] as const;

export async function up(database: Kysely<unknown>): Promise<void> {
  if (!database.isTransaction) return database.transaction().execute(up);
  await sql`lock table fetch_runs in share row exclusive mode`.execute(database);
  // No shop FK: cascading source deletions must subtract counts before any derived row disappears.
  await sql`create table fetch_run_counts (
    shop_id bigint not null,
    status text not null,
    run_count bigint not null check (run_count >= 0),
    primary key (shop_id, status)
  )`.execute(database);
  await sql`insert into fetch_run_counts (shop_id, status, run_count)
    select shop_id, status, count(*) from fetch_runs group by shop_id, status`.execute(database);

  for (const { event, transition, deltas } of EVENTS) {
    const name = `fetch_run_counts_${event}`;
    await sql.raw(`create function ${name}() returns trigger
      language plpgsql set search_path from current as $function$
      declare change record;
      begin
        for change in
          select shop_id, status, sum(amount)::bigint as amount from (${deltas}) changes
          group by shop_id, status having sum(amount) <> 0 order by shop_id, status collate "C"
        loop
          -- Keep zero rows so concurrent arrivals cannot race a deleted counter.
          insert into fetch_run_counts (shop_id, status, run_count)
            values (change.shop_id, change.status, 0) on conflict (shop_id, status) do nothing;
          update fetch_run_counts set run_count = run_count + change.amount
            where shop_id = change.shop_id and status = change.status;
        end loop;
        return null;
      end
      $function$`).execute(database);
    await sql.raw(`create trigger ${name} after ${event} on fetch_runs ${transition}
      for each statement execute function ${name}()`).execute(database);
  }
  await sql`create function fetch_run_counts_truncate() returns trigger
    language plpgsql set search_path from current as $function$
    begin
      truncate fetch_run_counts;
      return null;
    end
    $function$`.execute(database);
  await sql`create trigger fetch_run_counts_truncate after truncate on fetch_runs
    for each statement execute function fetch_run_counts_truncate()`.execute(database);
  await sql`analyze fetch_run_counts`.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  if (!database.isTransaction) return database.transaction().execute(down);
  await sql`lock table fetch_runs in share row exclusive mode`.execute(database);
  for (const event of [...EVENTS.map(({ event }) => event), 'truncate']) {
    const name = `fetch_run_counts_${event}`;
    await sql.raw(`drop trigger ${name} on fetch_runs`).execute(database);
    await sql.raw(`drop function ${name}()`).execute(database);
  }
  await sql`drop table fetch_run_counts`.execute(database);
}
