import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';

describe('admin desktop layout', () => {
  test('keeps management workspaces desktop-only', () => {
    const css = ['apps/web/src/styles.css', 'apps/web/src/admin.css'].map(file => readFileSync(file, 'utf8')).join('\n');

    expect(css).not.toContain('.admin-app{display:flex;flex-direction:column}');
    expect(css).not.toContain('.standard-layout');
    expect(css).not.toContain('.shop-filter');
    expect(css).not.toContain('.compact-form{grid-template-columns:1fr}');
    expect(css).not.toContain('.platform-row{grid-template-columns:1fr auto auto}');
    expect(css).toContain('.standard-product-pill{display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis');
    expect(css).not.toContain('.standardization-cell{display:grid');
  });

});
