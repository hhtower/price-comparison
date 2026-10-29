import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jitteredIntervalMs } from '../src/crawler/jitter.js';

test('jitteredIntervalMs includes the 45-minute lower bound', (context) => {
  context.mock.method(Math, 'random', () => 0);
  assert.equal(jitteredIntervalMs(3_600_000), 2_700_000);
});

test('jitteredIntervalMs includes the 60-minute upper bound without exceeding it', (context) => {
  context.mock.method(Math, 'random', () => 1 - Number.EPSILON);
  assert.equal(jitteredIntervalMs(3_600_000), 3_600_000);
});

test('jitteredIntervalMs draws a new delay on every scheduling attempt', (context) => {
  const samples = [0, 0.5, 1 - Number.EPSILON];
  context.mock.method(Math, 'random', () => samples.shift()!);
  assert.deepEqual([
    jitteredIntervalMs(3_600_000),
    jitteredIntervalMs(3_600_000),
    jitteredIntervalMs(3_600_000),
  ], [2_700_000, 3_150_000, 3_600_000]);
});

test('jitteredIntervalMs scales the random window with the configured upper bound', (context) => {
  context.mock.method(Math, 'random', () => 0);
  assert.equal(jitteredIntervalMs(4_000), 3_000);
});

test('jitteredIntervalMs clamps short intervals to one second', (context) => {
  context.mock.method(Math, 'random', () => 0.5);
  assert.equal(jitteredIntervalMs(0), 1_000);
  assert.equal(jitteredIntervalMs(500), 1_000);
});

test('jitteredIntervalMs supports an explicit 10-45 minute window', (context) => {
  const samples = [0, 0.5, 1 - Number.EPSILON];
  context.mock.method(Math, 'random', () => samples.shift()!);
  assert.deepEqual([
    jitteredIntervalMs(2_700_000, 600_000),
    jitteredIntervalMs(2_700_000, 600_000),
    jitteredIntervalMs(2_700_000, 600_000),
  ], [600_000, 1_650_000, 2_700_000]);
});

test('jitteredIntervalMs supports equal bounds and rejects invalid explicit minimums', (context) => {
  context.mock.method(Math, 'random', () => 0.5);
  assert.equal(jitteredIntervalMs(600_000, 600_000), 600_000);
  for (const minimum of [0, 999, 1_000.5, 600_001, NaN, Infinity]) {
    assert.throws(() => jitteredIntervalMs(600_000, minimum), /minimum/i);
  }
});
