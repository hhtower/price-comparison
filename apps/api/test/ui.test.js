import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function read(file) {
  return fs.readFileSync(path.resolve(file), 'utf8');
}

test('client tests force Vite test mode even when the project env is production', () => {
  const packageJson = JSON.parse(read('package.json'));
  assert.match(packageJson.scripts['test:web'], /cross-env NODE_ENV=test vitest run --config apps\/web\/vite\.config\.js --mode test/);
});
