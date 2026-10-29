import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`create table analytics_excluded_ips (
    ip inet primary key,
    constraint analytics_excluded_ips_host_check check (masklen(ip) = case when family(ip) = 4 then 32 else 128 end)
  )`.execute(database);
  await sql`insert into analytics_excluded_ips (ip) values ('127.0.0.1'), ('::1')`.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`drop table analytics_excluded_ips`.execute(database);
}
