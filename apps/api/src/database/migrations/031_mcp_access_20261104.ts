import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    create table mcp_applications (
      id uuid primary key,
      name varchar(100) not null,
      email varchar(254) not null unique check (email = lower(email)),
      purpose varchar(2000) not null,
      expected_usage varchar(200) not null,
      status text not null default 'unverified' check (status in ('unverified','pending','approved','rejected')),
      created_at timestamptz not null default now(),
      email_verified_at timestamptz,
      verification_hash varchar(64) unique,
      verification_expires_at timestamptz,
      reviewed_at timestamptz,
      reviewed_by text,
      review_note varchar(1000) not null default '',
      notification_status text not null default 'pending' check (notification_status in ('pending','sent','failed')),
      notification_version integer not null default 0,
      claim_hash varchar(64) unique,
      claim_expires_at timestamptz,
      claimed_at timestamptz,
      key_hash varchar(64) unique,
      key_prefix varchar(16),
      key_expires_at timestamptz,
      key_revoked_at timestamptz,
      key_updated_at timestamptz,
      key_updated_by text,
      requests_per_minute integer not null default 60 check (requests_per_minute between 1 and 1000),
      last_used_at timestamptz,
      request_count bigint not null default 0 check (request_count >= 0),
      check (status = 'unverified' or email_verified_at is not null),
      check (key_hash is null or (status = 'approved' and claimed_at is not null and key_expires_at is not null))
    );
    create index mcp_applications_review on mcp_applications (status, created_at desc, id);
  `.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`drop table mcp_applications`.execute(database);
}
