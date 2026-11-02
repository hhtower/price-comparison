import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const containerRequire = createRequire(require.resolve('testcontainers'));
const archiver = containerRequire('archiver');
const archiveRequire = createRequire(containerRequire.resolve('archiver'));
const { globSync } = createRequire(archiveRequire.resolve('archiver-utils'))('glob');
const readdirGlob = archiveRequire('readdir-glob');
const tar = archiveRequire('tar-stream');

async function archiveFiles(append) {
  const archive = archiver('tar');
  const extract = tar.extract();
  const files = new Map();
  extract.on('entry', (header, stream, next) => {
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('error', next);
    stream.on('end', () => {
      if (header.type === 'file') files.set(header.name, Buffer.concat(chunks).toString());
      next();
    });
  });
  const extracting = pipeline(archive, extract);
  append(archive);
  await archive.finalize();
  await extracting;
  return files;
}

test('testcontainers archive dependencies preserve directory contents and glob filtering', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'testcontainers-archive-'));
  try {
    for (const name of ['nested', 'skip', '.hidden']) await mkdir(join(directory, name));
    const fixture = [
      ['one.txt', 'one'], ['nested/two.json', '{"two":2}'],
      ['skip/skip.txt', 'skip'], ['.hidden/hidden.txt', 'hidden'],
    ];
    for (const [name, content] of fixture) await writeFile(join(directory, name), content);
    const normalize = value => value.replaceAll('\\', '/');
    assert.deepEqual(globSync('**/*.{txt,json}', { cwd: directory, nodir: true, ignore: '**/skip/**' })
      .map(normalize).sort(), ['nested/two.json', 'one.txt']);
    const matches = await new Promise((resolveMatches, reject) => {
      const files = [];
      readdirGlob(directory, { pattern: '**/*.txt', ignore: '**/skip/**', nodir: true })
        .on('match', entry => files.push(normalize(entry.relative)))
        .on('error', reject).on('end', () => resolveMatches(files.sort()));
    });
    assert.deepEqual(matches, ['one.txt']);
    const full = await archiveFiles(archive => archive.directory(directory, 'payload'));
    for (const [name, content] of fixture) assert.equal(full.get('payload/' + name), content);
    const filtered = await archiveFiles(archive => archive.glob('**/*.txt',
      { cwd: directory, ignore: '**/skip/**' }, { prefix: 'selected' }));
    assert.deepEqual([...filtered.entries()], [['selected/one.txt', 'one']]);
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)
      && basename(directory).startsWith('testcontainers-archive-'));
    await rm(directory, { recursive: true, force: true });
  }
});
