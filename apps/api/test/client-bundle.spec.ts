import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';

test('consumer entry excludes admin workspaces and their dedicated styles', async () => {
  const result = await build({ configFile: 'apps/web/vite.config.js', build: { write: false }, logLevel: 'silent' });
  const output = (Array.isArray(result) ? result : [result]).flatMap(item => 'output' in item ? item.output : []);
  const chunks = output.filter(item => item.type === 'chunk');
  const entry = chunks.find(chunk => chunk.isEntry)!;
  const initial = new Set<string>();
  function visit(fileName: string) {
    if (initial.has(fileName)) return;
    initial.add(fileName);
    const chunk = chunks.find(item => item.fileName === fileName);
    chunk?.imports.forEach(visit);
  }
  visit(entry.fileName);
  const modules = chunks.filter(chunk => initial.has(chunk.fileName)).flatMap(chunk => Object.keys(chunk.modules));
  assert.ok(modules.some(id => id.endsWith('/PublicPage.jsx')));
  assert.ok(!modules.some(id => /\/(AdminPage|AiWorkbench)\.jsx$/.test(id)), 'public entry must not eagerly load admin modules');
  assert.ok(!modules.some(id => id.endsWith('/ai-workbench.css') || id.endsWith('/admin.css')), 'admin CSS must load with the admin route');
  assert.ok(chunks.some(chunk => !initial.has(chunk.fileName) && Object.keys(chunk.modules).some(id => id.endsWith('/AdminPage.jsx'))));
});
