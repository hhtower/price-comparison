import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const setup = new URL('./setup-env.js', import.meta.url).href;
const envModule = new URL('../src/config/env.ts', import.meta.url).href;
const loader = new URL('../../../node_modules/tsx/dist/loader.mjs', import.meta.url).href;

for (const dedicated of [false, true]) {
  test(`test bootstrap isolates inherited services and ignores .env (dedicated=${dedicated})`, t => {
    const directory = mkdtempSync(join(tmpdir(), 'price-test-env-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    writeFileSync(join(directory, '.env'), 'RATE_LIMIT_REDIS_URL=redis://file-business.invalid\nENV_FILE_SENTINEL=loaded\n');
    const output = execFileSync(process.execPath, [
      '--import', loader, '--import', setup, '--input-type=module', '-e',
      `await import(${JSON.stringify(envModule)});
       console.log(JSON.stringify(Object.fromEntries(
         ['NODE_ENV','DATABASE_URL','REDIS_URL','RATE_LIMIT_REDIS_URL','PGHOST','PG_SCHEMA','ENV_FILE_SENTINEL']
           .map(key => [key, process.env[key] ?? null]))));`,
    ], {
      cwd: directory,
      env: {
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        NODE_ENV: 'production', DATABASE_URL: 'postgres://business.invalid/db',
        REDIS_URL: 'redis://business.invalid', RATE_LIMIT_REDIS_URL: 'redis://rate-business.invalid',
        PGHOST: 'business.invalid', PG_SCHEMA: 'business',
        ...(dedicated ? { TEST_DATABASE_URL: 'postgres://test.invalid/db', TEST_REDIS_URL: 'redis://test.invalid' } : {}),
      },
      encoding: 'utf8',
    });
    assert.deepEqual(JSON.parse(output), {
      NODE_ENV: 'test',
      DATABASE_URL: dedicated ? 'postgres://test.invalid/db' : '',
      REDIS_URL: dedicated ? 'redis://test.invalid' : '',
      RATE_LIMIT_REDIS_URL: null, PGHOST: null, PG_SCHEMA: null, ENV_FILE_SENTINEL: null,
    });
  });
}
