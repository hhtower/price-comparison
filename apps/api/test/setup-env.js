process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? '';

// Test containers may replace REDIS_URL later; never retain a business override.
for (const key of ['RATE_LIMIT_REDIS_URL', 'PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGSERVICE', 'PGSERVICEFILE', 'PGPASSFILE', 'PG_SCHEMA']) {
  delete process.env[key];
}
