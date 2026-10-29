import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function read(file) {
  return fs.readFileSync(path.resolve(file), 'utf8');
}

test('React entry routes the public catalog and admin shell', () => {
  const entry = read('apps/web/index.html');
  const app = read('apps/web/src/App.jsx');
  const main = read('apps/web/src/main.jsx');
  assert.match(entry, /<div id="root"><\/div>/);
  assert.match(entry, /src\/main\.jsx/);
  assert.match(main, /createRoot\(document\.getElementById\('root'\)\)/);
  assert.match(app, /window\.location\.pathname/);
  assert.match(app, /<AdminPage \/>/);
  assert.match(app, /<PublicPage\b[^>]*\/>/);
  assert.match(app, /admin-shell/);
  assert.match(app, /public-shell/);
});

test('React pages retain the public and admin workflows', () => {
  const publicPage = read('apps/web/src/PublicPage.jsx');
  const adminPage = read('apps/web/src/AdminPage.jsx');
  // Quote-detail and pagination behavior is exercised by PublicPage.test.jsx.
  for (const token of ['catalog', 'platform-tabs', 'shop-submit', 'compact-catalog', '/api/shop-submissions', 'product-reports', '本站展示第三方商铺报价', '举报此报价']) {
    assert.match(publicPage, new RegExp(token));
  }
  for (const token of ['pending-shops', 'connected-shops', 'standard-products', 'shop-editor', 'standard-name-dialog', 'platform-dialog', 'StandardProductPicker', 'AiWorkbench']) {
    assert.match(adminPage, new RegExp(token));
  }
  for (const token of ['商品 / 规格', '/api/admin/products', '/api/admin/standard-products', '/api/admin/platforms', 'formatTime', 'PAGE_SIZE']) {
    assert.match(adminPage, new RegExp(token));
  }
  const aiWorkbench = read('apps/web/src/AiWorkbench.jsx');
  for (const token of ['AiWorkbench', '/api/admin/ai/jobs', 'ai-workbench-tabs', 'fetch-runs']) {
    assert.match(aiWorkbench, new RegExp(token));
  }
  assert.doesNotMatch(aiWorkbench, /标准商品与抽查|全局待处理商品|\/api\/admin\/ai\/standard-products|\/api\/admin\/ai\/results/);
});

test('client tests force Vite test mode even when the project env is production', () => {
  const packageJson = JSON.parse(read('package.json'));
  assert.match(packageJson.scripts['test:web'], /cross-env NODE_ENV=test vitest run --config apps\/web\/vite\.config\.js --mode test/);
});

test('admin modules continue to scroll only their data panes', () => {
  const adminPage = read('apps/web/src/AdminPage.jsx');
  const styles = read('apps/web/src/admin.css');
  assert.match(adminPage, /id="panel" className="admin-app"/);
  for (const token of ['review-list admin-scroll-area', 'data-table-wrap admin-scroll-area']) assert.match(adminPage, new RegExp(token));
  assert.match(read('apps/web/src/AiWorkbench.jsx'), /className="ai-workbench-body"/);
  assert.match(read('apps/web/src/ai-workbench.css'), /\.ai-workbench-body\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(styles, /body\.admin-shell:has\(#panel:not\(\[hidden\]\)\)\{height:100dvh;overflow:hidden\}/);
  assert.match(styles, /\.admin-app\{display:grid;grid-template-columns:230px 1fr;height:100dvh;min-height:0;overflow:hidden\}/);
  assert.match(styles, /\.admin-scroll-area\{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable\}/);
});
