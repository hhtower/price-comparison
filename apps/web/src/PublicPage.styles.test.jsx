import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

test('mobile brand keeps a readable minimum height', () => {
  const css = readFileSync('apps/web/src/community.css', 'utf8');
  const brand = css.match(/\.compact-catalog \.community-header \.brand\s*\{([^}]+)\}/u)?.[1];
  expect(brand).toMatch(/min-height:\s*44px/u);
});

test('mobile catalog keeps the shared sticky search panel instead of disabling it', () => {
  const shared = readFileSync('apps/web/src/styles.css', 'utf8');
  expect(shared).toMatch(/\.compact-catalog \.search-panel\{position:sticky;top:0;/u);
  const catalog = readFileSync('apps/web/src/public-catalog.css', 'utf8');
  const overrides = [...catalog.matchAll(/\.compact-catalog \.search-panel\s*\{([^}]+)\}/gu)];
  for (const [, rule] of overrides) expect(rule).not.toMatch(/position:\s*(static|relative)/u);
  expect(overrides.some(([, rule]) => /background:\s*var\(--catalog-bg\)/u.test(rule))).toBe(true);
});

test('mobile quotes use flat rows and a price/action grid rather than wrapping the whole action row', () => {
  const css = readFileSync('apps/web/src/public-catalog.css', 'utf8');
  expect(css).toMatch(/\.compact-catalog \.shop-tile \.offer-footer\s*\{[^}]*display:\s*grid/u);
  expect(css).toMatch(/\.compact-catalog \.shop-tile \.offer-actions\s*\{[^}]*display:\s*contents/u);
  expect(css).toMatch(/\.compact-catalog \.shop-offer:last-child\s*\{[^}]*border-top:\s*1px/u);
});

test('product summaries retain sticky styles below the measured toolbar without a nested scroll container', () => {
  const css = readFileSync('apps/web/src/public-catalog.css', 'utf8');
  expect(css).toMatch(/\.compact-catalog \.standard-product-header\s*\{[^}]*position:\s*sticky/u);
  expect(css).toContain('top: var(--catalog-toolbar-height, 0px)');
  expect(css).toMatch(/\.compact-catalog \.standard-product-card\s*\{[^}]*overflow:\s*clip/u);
});

test('purchase guide keeps its return header sticky and leaves room above anchor targets', () => {
  const css = readFileSync('apps/web/src/purchase-guide.css', 'utf8');
  const heading = css.match(/\.purchase-guide-page \.guide-page-heading\s*\{([^}]+)\}/u)?.[1];
  expect(heading).toMatch(/position:\s*sticky/u);
  expect(heading).toMatch(/top:\s*0/u);
  expect(heading).toMatch(/z-index:\s*10/u);
  expect(heading).toMatch(/background:/u);
  expect(css).toMatch(/\.purchase-guide-page \[id\]\s*\{[^}]*scroll-margin-top:\s*100px/u);
});

test('self-built shop badges are tappable with a focus ring and the dialog note is tinted', () => {
  const css = readFileSync('apps/web/src/public-catalog.css', 'utf8');
  expect(css).toMatch(/\.offer-shop-badge\s*\{[^}]*cursor:\s*pointer/u);
  expect(css).toMatch(/\.compact-catalog \.offer-shop-badge:focus-visible/u);
  expect(css).toMatch(/\.offer-shop-risk-note\s*\{[^}]*color:\s*#8a6410/u);
  expect(css).toMatch(/\.catalog-shop-copy strong \.catalog-shop-name\s*\{[^}]*text-overflow:\s*ellipsis/u);
});

test('quote names carry more visual weight than merchant names', () => {
  const css = readFileSync('apps/web/src/public-catalog.css', 'utf8');
  const shop = css.match(/\.compact-catalog \.shop-tile \.offer-shop\s*\{([^}]+)\}/u)?.[1] ?? '';
  const name = css.match(/\.compact-catalog \.shop-tile \.offer-name\s*\{([^}]+)\}/u)?.[1] ?? '';
  const size = rule => Number(rule.match(/font-size:\s*(\d+)px/u)?.[1]);
  const weight = rule => Number(rule.match(/font-weight:\s*(\d+)/u)?.[1]);
  expect(size(name)).toBeGreaterThan(size(shop));
  expect(weight(name)).toBeGreaterThan(weight(shop));
  expect(shop).toMatch(/color:\s*#53656c/u);
});
