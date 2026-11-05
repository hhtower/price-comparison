import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    create table user_accounts (
      id uuid primary key,
      email varchar(254) not null unique check (email = lower(email)),
      password_hash text not null,
      email_verified_at timestamptz not null default now(),
      created_at timestamptz not null default now()
    );
    create table account_email_challenges (
      email varchar(254) primary key check (email = lower(email)),
      challenge_id varchar(43) not null unique,
      code_hash varchar(64),
      code_expires_at timestamptz not null,
      attempts integer not null default 0 check (attempts between 0 and 5),
      retry_hash varchar(64) not null,
      retry_address_hash varchar(64) not null,
      retry_expires_at timestamptz not null,
      send_after timestamptz not null,
      send_count integer not null check (send_count between 1 and 5),
      send_window_start timestamptz not null,
      registration_hash varchar(64) unique,
      registration_expires_at timestamptz
    );
  `.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`drop table account_email_challenges; drop table user_accounts`.execute(database);
}
