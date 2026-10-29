import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '../../..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('release performance artifacts define bounded catalog and AI scenarios', () => {
  const catalog = read('apps/api/perf/catalog.k6.js');
  const ai = read('apps/api/perf/ai-write.k6.js');
  const fixtures = read('apps/api/perf/fixtures.ts');
  const baseline = read('apps/api/test/performance-baseline.md');
  const catalogPlan = read('apps/api/perf/catalog-plan.ts');
  const catalogRepository = read('apps/api/src/catalog/catalog.repository.ts');
  const packageJson = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };

  assert.match(catalog, /p\(95\)<100/);
  assert.match(catalog, /p\(95\)<300/);
  assert.match(catalog, /limit=100|limit=20/);
  assert.match(catalog, /value\.status\s*>=\s*200\s*&&\s*value\.status\s*<\s*300/);
  assert.match(catalog, /ADMIN_COOKIE is required/);
  assert.match(ai, /http\.post/);
  assert.match(ai, /p\(95\)<500/);
  assert.match(ai, /value\.status\s*>=\s*200\s*&&\s*value\.status\s*<\s*300/);
  assert.match(ai, /ADMIN_COOKIE is required/);
  assert.match(fixtures, /1_000_000/);
  assert.match(fixtures, /5_000_000/);
  assert.match(catalogRepository, /explain\s*\(analyze,\s*buffers,\s*format\s+json\)/iu);
  assert.match(catalogPlan, /product_tags|offers/);
  assert.match(baseline, /缓存命中.*100ms/);
  assert.match(baseline, /缓存未命中.*300ms/);
  assert.match(baseline, /管理列表.*500ms/);
  assert.equal(typeof packageJson.scripts?.['perf:catalog'], 'string');
  assert.equal(typeof packageJson.scripts?.['perf:ai'], 'string');
  assert.equal(typeof packageJson.scripts?.['perf:explain'], 'string');
});

test('the PostgreSQL-only release removes SQLite runtime and test helpers', () => {
  const packageJson = read('package.json');
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
    assert.equal(fs.existsSync(path.join(root, relativePath)), false, `${relativePath} must be removed`);
  }
});
