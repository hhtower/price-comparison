import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { captureRatingText, sourceListingId, buildRatingManifest, rawProductContent } from '../src/platforms/source-evidence.js';

test('raw product content preserves source bytes independently of complete rating capture', () => {
  assert.deepEqual(rawProductContent(' Ａ \n', ' <p>First</p>\n', undefined, ' Tail '), {
    sourceName: ' Ａ \n', description: ' <p>First</p>\n\n\n Tail ',
  });
  assert.throws(() => rawProductContent('Name', { unexpected: 'body' }), TypeError);
  assert.throws(() => rawProductContent(null, 'Body'), TypeError);
});

test('rating capture binds the complete raw title and bodies, including explicit empty text', () => {
  const name = '  Ａ · original\n', description = ' first\n\nbody  \nsecond\t';
  assert.deepEqual(captureRatingText(42, name, ' first\n\nbody  ', 'second\t'), {
    unitId: '42', name, description,
    hash: createHash('sha256').update(JSON.stringify([name, description])).digest('hex'),
  });
  assert.equal(captureRatingText('42', name, '').description, '');
  for (const missing of [undefined, null, 0, {}]) {
    assert.equal(captureRatingText('42', name, '', missing), undefined);
  }
  assert.equal(captureRatingText('42', undefined, ''), undefined);
  assert.equal(captureRatingText('42', name), undefined);
  assert.notEqual(captureRatingText('42', name, 'a  b').hash, captureRatingText('42', name, 'a b').hash);
});

test('only known SKU protocols strip external ID suffixes', () => {
  for (const protocol of ['public-products-v1', 'acg-faka', 'orion-key', 'dujiaoka', 'emshop', 'acg-faka-v5']) {
    assert.equal(sourceListingId(protocol, '42:sku:part'), '42');
    assert.equal(sourceListingId(protocol, 42), '42');
  }
  for (const protocol of ['16688', 'liandong', 'catcard', 'xingbao', 'prism', 'future', null]) {
    assert.equal(sourceListingId(protocol, '42:sku'), '42:sku');
  }
});

test('complete manifest counts source listings once, keeps unknowns, and fails closed on conflicts', () => {
  const source = { url: 'https://shop.test', protocol: null, platform: 'custom' };
  const known = captureRatingText('42', 'Parent', 'Full body');
  const manifest = buildRatingManifest(source, 'emshop', [
    { externalId: '42:1', ratingText: known },
    { externalId: '42:2', ratingText: known },
    { externalId: '43:1' }, { externalId: '43:2' },
    { externalId: '44:1', ratingText: captureRatingText('44', 'Parent', 'First') },
    { externalId: '44:2', ratingText: captureRatingText('44', 'Parent', 'Conflicting') },
    { externalId: '45:1', ratingText: captureRatingText('45', 'Parent', 'Body') },
    { externalId: '45:2' },
  ], 123);
  assert.deepEqual(manifest, {
    sourceUrl: source.url, sourceProtocol: null, sourcePlatform: 'custom', observedAt: 123,
    units: [{ unitId: '42', hash: known.hash }, { unitId: '43', hash: null },
      { unitId: '44', hash: null }, { unitId: '45', hash: null }],
  });
  assert.deepEqual(buildRatingManifest(source, 'emshop', [], 124).units, []);
});

test('catcard preserves parent identity even when grouped detail text is unavailable', () => {
  const source = { url: 'https://shop.test', protocol: 'catcard', platform: 'custom' };
  assert.deepEqual(buildRatingManifest(source, 'catcard', [
    { externalId: '62', sourceData: { ratingUnitId: '62' }, ratingText: captureRatingText('62', 'Parent', 'Body') },
    { externalId: '61', sourceData: { ratingUnitId: '62' } },
  ], 1).units, [{ unitId: '62', hash: null }]);
});

test('best-effort catalogs cannot establish the whole-shop text denominator', () => {
  assert.equal(buildRatingManifest({ url: 'https://shop.test', protocol: 'acg-faka', platform: 'custom' },
    'acg-faka', [{ externalId: '42', ratingText: captureRatingText('42', 'Parent', 'Body') }], 1), null);
});

test('optional parent inventory and expanded rows share conflict and unknown handling', () => {
  const source = { url: 'https://shop.test', protocol: 'public-products-v1', platform: 'custom' };
  const text = captureRatingText('1', 'Parent', 'Body');
  const rows = [{ externalId: '1:2', ratingText: text }];
  Object.defineProperty(rows, 'ratingUnits', { value: [
    { unitId: '1', hash: 'b'.repeat(64) }, { unitId: '2', hash: null },
    { unitId: '3', hash: text.hash }, { unitId: '3', hash: null },
  ] });
  assert.deepEqual(buildRatingManifest(source, source.protocol, rows, 1).units,
    [{ unitId: '1', hash: null }, { unitId: '2', hash: null }, { unitId: '3', hash: null }]);
  assert.deepEqual(buildRatingManifest(source, source.protocol, [...rows], 1).units,
    [{ unitId: '1', hash: text.hash }]);
});
