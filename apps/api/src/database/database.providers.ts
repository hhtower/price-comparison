import { Inject, Injectable, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool, types as pgTypes, type PoolConfig } from 'pg';
import {
  createDatabaseMetricsPlugin,
  getConnectionBudget,
  MetricsRegistry,
} from '../observability/metrics.js';
import { StructuredLogger } from '../observability/request-context.js';
import type { DatabaseSchema } from './types.js';

export const PG_POOL = Symbol('PG_POOL');
export const DATABASE = Symbol('DATABASE');

/** PostgreSQL int8 (OID 20) values are part of our bigint runtime contract. */
pgTypes.setTypeParser(20, (value: string) => BigInt(value));

const DEFAULT_POOL_MAX = 10;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function postgresPoolConfig(environment: NodeJS.ProcessEnv = process.env): PoolConfig {
  const connectionString = environment.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error('DATABASE_URL is required');
  }

  const schema = environment.PG_SCHEMA?.trim();
  return {
    connectionString,
    max: positiveInteger(environment.PG_POOL_MAX, DEFAULT_POOL_MAX, 'PG_POOL_MAX'),
    idleTimeoutMillis: positiveInteger(
      environment.PG_IDLE_TIMEOUT_MS,
      DEFAULT_IDLE_TIMEOUT_MS,
      'PG_IDLE_TIMEOUT_MS',
    ),
    connectionTimeoutMillis: positiveInteger(
      environment.PG_CONNECTION_TIMEOUT_MS,
      DEFAULT_CONNECTION_TIMEOUT_MS,
      'PG_CONNECTION_TIMEOUT_MS',
    ),
    statement_timeout: positiveInteger(
      environment.PG_STATEMENT_TIMEOUT_MS,
      DEFAULT_STATEMENT_TIMEOUT_MS,
      'PG_STATEMENT_TIMEOUT_MS',
    ),
    ...(schema
      ? {
          options: `-c search_path=${quoteIdentifier(schema)},public`,
        }
      : {}),
  };
}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error('PG_SCHEMA must be a valid PostgreSQL identifier');
  }
  return `"${identifier}"`;
}

export interface PoolErrorLogger {
  error: (...args: unknown[]) => void;
}

/** Attach an idle-client error listener without ever logging connection secrets. */
export function registerPoolErrorHandler(
  pool: Pool,
  logger: PoolErrorLogger = console,
): void {
  pool.on('error', (error: unknown) => {
    const candidate = error instanceof Error ? error : new Error(String(error));
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : undefined;
    logger.error('PostgreSQL pool idle client error', {
      ...(code ? { code } : {}),
      message: candidate.message,
    });
  });
}

export function createPostgresPool(
  environment: NodeJS.ProcessEnv = process.env,
  logger: PoolErrorLogger = console,
): Pool {
  getConnectionBudget(environment);
  const pool = new Pool(postgresPoolConfig(environment));
  registerPoolErrorHandler(pool, logger);
  return pool;
}

export const databaseProviders: Provider[] = [
  {
    provide: PG_POOL,
    useFactory: (): Pool => createPostgresPool(),
  },
  {
    provide: DATABASE,
    inject: [PG_POOL, MetricsRegistry, StructuredLogger],
    useFactory: (
      pool: Pool,
      metrics: MetricsRegistry,
      logger: StructuredLogger,
    ): Kysely<DatabaseSchema> =>
      new Kysely<DatabaseSchema>({
        dialect: new PostgresDialect({ pool }),
        plugins: [createDatabaseMetricsPlugin(metrics, logger)],
      }),
  },
];

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>) {}

  async onApplicationShutdown(): Promise<void> {
    await this.database.destroy();
  }
}
