import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';

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

test('deployment benchmark container is isolated and requires an explicit resource fingerprint', () => {
  const dockerfile = readFileSync('Dockerfile', 'utf8');
  const parsed = parseDocument(readFileSync('docker-compose.benchmark.yml', 'utf8'));
  const environment = readFileSync('.env.example', 'utf8');
  const benchmarkTarget = /^FROM build AS benchmark$[\s\S]*?(?=^FROM |$(?![\s\S]))/m.exec(dockerfile)?.[0];
  assert.deepEqual(parsed.errors, []);
  const compose = parsed.toJS() as { services: Record<string, Record<string, unknown>> };
  const service = compose.services['standardization-benchmark'];

  assert.ok(benchmarkTarget, 'Dockerfile benchmark target must exist');
  assert.match(benchmarkTarget, /USER node/);
  assert.match(benchmarkTarget, /STOPSIGNAL SIGINT/);
  assert.match(benchmarkTarget, /standardization-database-benchmark\.ts/);
  assert.deepEqual(Object.keys(compose.services), ['standardization-benchmark']);
  assert.deepEqual(service?.profiles, ['standardization-benchmark']);
  assert.deepEqual(service?.build, { context: '.', target: 'benchmark' });
  assert.match(String(service?.cpus), /^\$\{STANDARDIZATION_BENCHMARK_CPU_LIMIT:\?/u);
  assert.match(String(service?.mem_limit), /^\$\{STANDARDIZATION_BENCHMARK_MEMORY_LIMIT_BYTES:\?/u);
  assert.equal(service?.init, true);
  assert.equal(service?.restart, 'no');
  assert.equal(service?.stop_grace_period, '15m');
  assert.deepEqual(service?.command, [
    '--output', '/reports/standardization-deployment-benchmark.json', '--check',
  ]);
  const vars = service?.environment as Record<string, string>;
  assert.match(vars.TEST_DATABASE_URL, /^\$\{STANDARDIZATION_BENCHMARK_DATABASE_URL:\?/u);
  assert.match(vars.STANDARDIZATION_BENCHMARK_CPU_LIMIT, /^\$\{STANDARDIZATION_BENCHMARK_CPU_LIMIT:\?/u);
  assert.match(vars.STANDARDIZATION_BENCHMARK_MEMORY_LIMIT_BYTES, /^\$\{STANDARDIZATION_BENCHMARK_MEMORY_LIMIT_BYTES:\?/u);
  assert.equal('AI_API_KEY' in vars, false);
  assert.equal('AI_STANDARDIZATION_ENABLED' in vars, false);
  assert.equal('AI_INCREMENTAL_STANDARDIZATION_ENABLED' in vars, false);
  assert.deepEqual(service?.volumes, [
    '${STANDARDIZATION_BENCHMARK_REPORT_DIR:?Set a writable host report directory}:/reports',
  ]);
  assert.match(environment, /^# STANDARDIZATION_BENCHMARK_CPU_LIMIT=$/m);
  assert.match(environment, /^# STANDARDIZATION_BENCHMARK_MEMORY_LIMIT_BYTES=$/m);
  assert.match(environment, /^# STANDARDIZATION_BENCHMARK_DATABASE_URL=$/m);
  assert.match(environment, /^# STANDARDIZATION_BENCHMARK_REPORT_DIR=/m);
});
