import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`alter table mcp_applications add column key_ciphertext text`.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`alter table mcp_applications drop column key_ciphertext`.execute(database);
}
