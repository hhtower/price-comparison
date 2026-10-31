import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { ShoppingNeeds } from '@price-comparison/catalog/assistant-contract';
import { applyNeedsPatch, parseUnderstanding } from '../src/assistant/assistant.schemas.js';

type Scenario = {
  id: string;
  text: string;
  initialNeeds: ShoppingNeeds;
  mockUnderstanding: unknown;
  expectedNeeds?: ShoppingNeeds;
  expectedError?: 'parse' | 'apply';
};

// These are canned outputs, not model predictions or a measurement of language understanding.
const fixture: { kind: string; scope: string; scenarios: Scenario[] } = JSON.parse(
  await readFile(new URL('./fixtures/assistant-scenarios.json', import.meta.url), 'utf8'),
);
assert.equal(fixture.kind, 'canned-understanding-contract-scenarios');
assert.ok(fixture.scenarios.length >= 30, 'Keep at least 30 offline contract scenarios');
assert.equal(new Set(fixture.scenarios.map(scenario => scenario.id)).size, fixture.scenarios.length);

for (const scenario of fixture.scenarios) {
  test(`canned understanding contract: ${scenario.id}`, () => {
    const initial = structuredClone(scenario.initialNeeds);
    const modelOutput = structuredClone(scenario.mockUnderstanding);
    try {
      if (scenario.expectedError === 'parse') {
        assert.throws(() => parseUnderstanding(modelOutput, scenario.text),
          { message: /^Invalid assistant / });
        return;
      }
      const understanding = parseUnderstanding(modelOutput, scenario.text);
      if (scenario.expectedError === 'apply') {
        assert.throws(() => applyNeedsPatch(initial, understanding.patch),
          { message: /^Invalid assistant / });
        return;
      }
      assert.ok(scenario.expectedNeeds, 'An accepted scenario needs explicit expected state');
      assert.deepEqual(applyNeedsPatch(initial, understanding.patch), scenario.expectedNeeds);
      assert.deepEqual(understanding, scenario.mockUnderstanding, 'Parsing must not silently rewrite model data');
    } finally {
      assert.deepEqual(initial, scenario.initialNeeds, 'Confirmed needs must never be mutated');
      assert.deepEqual(modelOutput, scenario.mockUnderstanding, 'Canned output must never be mutated');
    }
  });
}
