import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function workerEntrypoints(value: string, pattern: RegExp): Set<string> {
  return new Set([...value.matchAll(pattern)].map((match) => match[1]));
}

test('deployment excludes local artifacts', () => {
  const ignored = readFileSync('.dockerignore', 'utf8').split(/\r?\n/);
  for (const path of ['docs/', 'output/', '.playwright-cli/', '.playwright-mcp/', '.omc/', '.env', '.env.*', '.claude/', '.local/']) {
    assert.ok(ignored.includes(path), path + ' must not enter the Docker build context');
  }
});

test('dependency lockfile is portable and matches workspace manifests without a root self-dependency', () => {
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  const checkPaths = (value: unknown): void => {
    if (typeof value === 'string') {
      assert.ok(!/^(?:file:)?(?:[A-Za-z]:[\\/]|\/|\\\\)/u.test(value), 'lockfile must not contain absolute filesystem paths');
    } else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        checkPaths(key);
        checkPaths(item);
      }
    }
  };
  checkPaths(lock);
  for (const directory of ['', 'apps/api', 'apps/web', 'packages/catalog']) {
    const manifest = JSON.parse(readFileSync(directory ? `${directory}/package.json` : 'package.json', 'utf8'));
    const entry = lock.packages[directory];
    assert.equal(entry.version, manifest.version);
    for (const section of ['dependencies', 'devDependencies']) assert.deepEqual(entry[section], manifest[section]);
    assert.equal(entry.dependencies?.[manifest.name], undefined, 'workspace must not depend on itself');
  }
  assert.equal(lock.packages[`node_modules/${lock.name}`], undefined, 'root package must not appear as its own dependency');
});

test('standardization runtime entrypoint and migration chain are present', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts?: Record<string, string> };
  assert.equal(packageJson.scripts?.['worker:standardization'], 'tsx apps/api/src/workers/standardization-entrypoint.ts');
  assert.match(readFileSync('apps/api/src/database/migrations/001_initial.ts', 'utf8'), /export async function up/);
});

test('deployed worker commands resolve to the current worker set', () => {
  const compose = readFileSync('docker-compose.yml', 'utf8');
  const composeEntrypoints = workerEntrypoints(
    compose,
    /dist\/server\/workers\/([a-z0-9.-]+)\.js/g,
  );
  const expectedEntrypoints = ['ai.worker', 'crawler.worker', 'official-reference.worker', 'standardization-entrypoint'];

  assert.deepEqual(sorted(composeEntrypoints), expectedEntrypoints);
  for (const entrypoint of composeEntrypoints) {
    assert.equal(
      existsSync(`apps/api/src/workers/${entrypoint}.ts`),
      true,
      `Compose worker ${entrypoint} must resolve to apps/api/src/workers/${entrypoint}.ts`,
    );
  }

  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts?: Record<string, string> };
  const workerScripts = Object.entries(packageJson.scripts ?? {})
    .filter(([name]) => name.startsWith('worker:'))
    .map(([name, command]) => {
      const match = /^tsx apps\/api\/src\/workers\/([a-z0-9.-]+)\.ts$/.exec(command);
      assert.ok(match, `${name} must directly execute a TypeScript worker entrypoint`);
      assert.equal(
        existsSync(`apps/api/src/workers/${match[1]}.ts`),
        true,
        `${name} must resolve to apps/api/src/workers/${match[1]}.ts`,
      );
      return match[1];
    });

  assert.deepEqual(sorted(workerScripts), expectedEntrypoints);
});

test('local AI standardization deployment remains disabled until explicitly enabled', () => {
  const compose = readFileSync('docker-compose.dev.yml', 'utf8');
  const environment = readFileSync('.env.example', 'utf8');
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts?: Record<string, string> };
  const aiEntrypoint = readFileSync('apps/api/src/workers/ai.worker.ts', 'utf8');
  const incrementalEntrypoint = readFileSync('apps/api/src/workers/standardization-entrypoint.ts', 'utf8');

  assert.match(environment, /^AI_STANDARDIZATION_ENABLED=false$/m);
  assert.match(environment, /^AI_INCREMENTAL_STANDARDIZATION_ENABLED=false$/m);
  for (const service of ['worker-ai', 'worker-standardization']) {
    const block = new RegExp(`^  ${service}:[\\s\\S]*?(?=^  [a-z][a-z0-9-]*:|^volumes:)`, 'm').exec(compose)?.[0];
    assert.ok(block, `${service} Compose service must exist`);
    assert.match(block, /profiles:\s*\["ai-standardization"\]/);
  }
  assert.match(packageJson.scripts?.['dev:ai-standardization'] ?? '', /ai\.worker/);
  assert.match(packageJson.scripts?.['dev:ai-standardization'] ?? '', /standardization-entrypoint/);
  assert.match(aiEntrypoint, /requireAiStandardizationWorker\(\);[\s\S]*?NestFactory\.createApplicationContext/);
  assert.match(incrementalEntrypoint, /requireIncrementalStandardizationWorker\(\);[\s\S]*?NestFactory\.createApplicationContext/);
});

test('the PostgreSQL-only release removes SQLite runtime and test helpers', () => {
  const packageJson = readFileSync('package.json', 'utf8');
  assert.doesNotMatch(packageJson, /better-sqlite3/);

  for (const relativePath of [
    'apps/api/src/config.js',
    'apps/api/src/aiRequest.js',
    'apps/api/src/aiStream.js',
    'scripts/import-source.js',
    'test/test-db.js',
    'test/db.test.js',
    'test/importer.test.js',
    'test/normalize.test.js',
    'test/server-static.test.js',
    'test/aiRequest.test.js',
    'test/aiStream.test.js',
  ]) {
    assert.equal(existsSync(relativePath), false, `${relativePath} must be removed`);
  }
});
