import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    create table assistant_sessions (
      id uuid primary key,
      access_hash varchar(64) not null,
      revision integer not null default 0 check (revision >= 0),
      needs jsonb not null,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null
    );
    create index assistant_sessions_expiry on assistant_sessions (expires_at);
    create table assistant_turns (
      id bigint generated always as identity primary key,
      session_id uuid not null references assistant_sessions(id) on delete cascade,
      client_message_id uuid not null,
      expected_revision integer not null check (expected_revision >= 0),
      input_text text not null check (length(input_text) between 1 and 2000),
      status text not null default 'queued' check (status in ('queued','running','succeeded','failed','cancelled')),
      phase text not null default 'queued' check (phase in ('queued','understanding','searching','explaining')),
      event_version integer not null default 0,
      reply jsonb,
      requests_started integer not null default 0 check (requests_started between 0 and 2),
      request_in_flight boolean not null default false,
      model text,
      usage jsonb not null default '[]',
      error_code text,
      attempts bigint not null default 0,
      available_at timestamptz not null default now(),
      claimed_by text,
      claim_token text,
      lease_until timestamptz,
      created_at timestamptz not null default now(),
      started_at timestamptz,
      finished_at timestamptz,
      deadline_at timestamptz not null,
      unique(session_id, client_message_id),
      check ((status = 'succeeded') = (reply is not null))
    );
    create unique index assistant_turns_one_active on assistant_turns (session_id)
      where status in ('queued','running');
    create index assistant_turns_claim on assistant_turns (available_at, id)
      where status in ('queued','running');
    create index assistant_turns_deadline on assistant_turns (deadline_at)
      where status in ('queued','running');
  `.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`drop table assistant_turns; drop table assistant_sessions`.execute(database);
}
