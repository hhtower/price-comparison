import '../config/env.js';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Kysely, PostgresDialect } from 'kysely';
import { createPostgresPool } from '../database/database.providers.js';
import type { DatabaseSchema } from '../database/types.js';
import { publishNextCatalogChange } from '../catalog/catalog-projection.js';

export async function runCatalogWorker(publish: () => Promise<boolean>, signal: AbortSignal,
  logger: Pick<Console, 'error'> = console): Promise<void> {
  while (!signal.aborted) {
    let delay = 1000;
    try { if (await publish()) continue; }
    catch { logger.error('catalog.projection_failed'); delay = 5000; }
    await setTimeout(delay, undefined, { signal }).catch(error => { if (!signal.aborted) throw error; });
  }
}

async function main() {
  const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool: createPostgresPool() }) });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try { await runCatalogWorker(() => publishNextCatalogChange(database), controller.signal); }
  finally { await database.destroy(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) void main();
