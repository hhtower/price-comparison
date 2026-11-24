import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Kysely, PostgresDialect } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';
import '../src/config/env.js';
import { createPostgresPool } from '../src/database/database.providers.js';
import type { DatabaseSchema } from '../src/database/types.js';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationFolder = path.resolve(scriptDirectory, '../src/database/migrations');
export const migrationProvider = new FileMigrationProvider({
  fs,
  path: {
    join: (...parts: string[]): string => pathToFileURL(path.join(...parts)).href,
  },
  migrationFolder,
});

export async function migrateToLatest(database: Kysely<DatabaseSchema>): Promise<void> {
  const migrator = new Migrator({
    db: database,
    provider: migrationProvider,
    migrationTableSchema: process.env.PG_SCHEMA?.trim() || 'public',
  });
  const { error, results } = await migrator.migrateToLatest();

  for (const result of results ?? []) {
    const message = `${result.status}: ${result.migrationName}`;
    if (result.status === 'Success') {
      console.info(message);
    } else {
      console.error(message);
    }
  }

  if (error) {
    throw error;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--to' || !args[1]?.trim())) {
    throw new Error('Usage: db:migrate [--to migration_name]');
  }
  const pool = createPostgresPool();
  const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
  try {
    if (args.length) {
      const { error, results } = await new Migrator({ db: database, provider: migrationProvider,
        migrationTableSchema: process.env.PG_SCHEMA?.trim() || 'public' }).migrateTo(args[1]!);
      for (const result of results ?? []) console.info(`${result.status}: ${result.migrationName}`);
      if (error) throw error;
    } else await migrateToLatest(database);
  } finally {
    await database.destroy();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
