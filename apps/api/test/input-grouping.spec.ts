import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { planSimilarityGroups } from '../src/standardization/input-grouping.js';

const ids = (groups: ReturnType<typeof planSimilarityGroups>['groups']) =>
  groups.map((group) => ({ anchorId: group.anchorId, memberIds: [...group.memberIds] }));

test('similarity grouping is stable across input ordering', () => {
  const input = [
    { id: '3', text: 'Microsoft Outlook email account annual' },
    { id: '1', text: 'OpenAI ChatGPT Plus monthly shared' },
    { id: '2', text: 'Chat GPT Plus OpenAI one month shared' },
    { id: '4', text: 'Outlook Microsoft mailbox yearly account' },
  ];
  const options = { similarityThreshold: 0.25, maxGroupSize: 4 };

  const forward = planSimilarityGroups(input, options);
  const reversed = planSimilarityGroups([...input].reverse(), options);

  assert.deepEqual(reversed, forward);
  assert.deepEqual(ids(forward.groups), [
    { anchorId: '3', memberIds: ['3', '4'] },
    { anchorId: '1', memberIds: ['1', '2'] },
  ]);
});

test('similarity grouping forms bounded stars instead of transitive components', () => {
  const plan = planSimilarityGroups([
    { id: 'a', text: 'aa11aa bb22bb' },
    { id: 'b', text: 'aa11aa bb22bb cc33cc dd44dd' },
    { id: 'c', text: 'cc33cc dd44dd ee55ee ff66ff' },
    { id: 'd', text: 'ee55ee ff66ff' },
  ], { similarityThreshold: 0.3, maxGroupSize: 10 });

  assert.equal(plan.groups.some((group) => group.memberIds.length === 4), false);
  assert.deepEqual(ids(plan.groups), [
    { anchorId: 'b', memberIds: ['b', 'a', 'c'] },
    { anchorId: 'd', memberIds: ['d'] },
  ]);
});

test('similarity grouping enforces posting, scan, comparison, and group-size bounds', () => {
  const input = Array.from({ length: 1_000 }, (_, index) => ({
    id: String(index).padStart(4, '0'),
    text: `common shared service product-${index}`,
  }));
  const plan = planSimilarityGroups(input, {
    maxPostingsPerFeature: 8,
    maxScannedPerInput: 16,
    maxComparedPerInput: 4,
    maxGroupSize: 5,
    similarityThreshold: 0.1,
  });

  assert.ok(plan.stats.scanned <= input.length * 16);
  assert.ok(plan.stats.compared <= input.length * 4);
  assert.equal(plan.stats.plannedPairCount, plan.stats.compared);
  assert.ok(plan.stats.retainedNeighborCount <= input.length * 4);
  assert.equal(plan.stats.truncated, true);
  assert.ok(plan.groups.every((group) => group.memberIds.length <= 5));
  assert.deepEqual(new Set(plan.groups.flatMap((group) => group.memberIds)).size, input.length);
});

test('selection work and retained features stay bounded for no-edge, all-similar, and high-frequency inputs', () => {
  const maxGroupSize = 8;
  const maxFeaturesPerInput = 24;
  for (const size of [1_000, 5_000, 10_000]) {
    const cases = [
      Array.from({ length: size }, (_, index) => ({
        id: `none-${String(index).padStart(5, '0')}`,
        text: `unique-${index}-${'x'.repeat(512)}-${String.fromCodePoint(0x4e00 + (index % 1_000))}`,
      })),
      Array.from({ length: size }, (_, index) => ({
        id: `same-${String(index).padStart(5, '0')}`,
        text: 'same exact product identity',
      })),
      Array.from({ length: size }, (_, index) => ({
        id: `common-${String(index).padStart(5, '0')}`,
        text: `common shared popular service product-${index % 20} tier-${index % 7}`,
      })),
    ];

    for (const input of cases) {
      const plan = planSimilarityGroups(input, {
        maxFeaturesPerInput,
        maxPostingsPerFeature: 64,
        maxScannedPerInput: 128,
        maxComparedPerInput: 32,
        maxGroupSize,
        similarityThreshold: 0.35,
      });
      assert.ok(plan.stats.selectionVisits <= size * (4 * maxGroupSize + 2));
      assert.ok(plan.stats.peakScratchCandidates <= size * maxGroupSize);
      assert.ok(plan.stats.retainedFeatureCount <= size * maxFeaturesPerInput);
    }
  }
});

test('all-similar inputs are split by maxGroupSize without losing members', () => {
  const input = Array.from({ length: 11 }, (_, index) => ({ id: String(index + 1).padStart(2, '0'), text: 'same exact product identity' }));
  const plan = planSimilarityGroups(input, { maxGroupSize: 4, similarityThreshold: 0.9 });

  assert.deepEqual(plan.groups.map((group) => group.memberIds.length), [4, 4, 3]);
  assert.equal(new Set(plan.groups.flatMap((group) => group.memberIds)).size, input.length);
});

test('maxGroupSize is clamped to the available peers before neighbor storage is allocated', () => {
  const plan = planSimilarityGroups([
    { id: 'a', text: 'same exact product identity' },
    { id: 'b', text: 'same exact product identity' },
    { id: 'c', text: 'same exact product identity' },
  ], { maxGroupSize: Number.MAX_SAFE_INTEGER, similarityThreshold: 0.9 });

  assert.deepEqual(plan.groups.map((group) => group.memberIds.length), [3]);
  assert.equal(plan.stats.retainedNeighborCount, 6);
});

test('default 2k grouping keeps retained neighbors and peak memory bounded', () => {
  const script = `
    import { planSimilarityGroups } from './apps/api/src/standardization/input-grouping.ts';
    const size = 2000;
    const inputs = Array.from({ length: size }, (_, index) => ({
      id: 'input-' + String(index).padStart(6, '0'),
      text: 'BenchmarkBrand' + (index % 64) + ' Service ' + index
        + ' tier-' + (index % 7) + ' duration-' + (index % 12 + 1) + ' category-' + (index % 11),
    }));
    const result = planSimilarityGroups(inputs);
    console.log(JSON.stringify({
      maxRssKb: process.resourceUsage().maxRSS,
      retainedNeighborCount: result.stats.retainedNeighborCount,
    }));
  `;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout) as { maxRssKb: number; retainedNeighborCount: number };
  assert.equal(result.retainedNeighborCount, 2_000 * 31);
  assert.ok(result.maxRssKb < 512 * 1_024, `peak RSS ${result.maxRssKb} KiB exceeded 512 MiB`);
});
