import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { parseTagExtractionResponse } from '../src/ai/tag-extraction-request.js';
import { PURCHASE_GUIDE_FIELDS } from '@price-comparison/catalog/purchase-guide-content';
import { validateReviewedTagExtractionDecision } from '../src/ai/tag-extraction-result.js';

test('synthetic references use the compact tag protocol while retaining cited ground truth', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/tag-extraction-quality-expanded-20261016.json', import.meta.url), 'utf8'));
  assert.equal(fixture.samples.length, 51);
  assert.equal(new Set(fixture.samples.map((sample: any) => sample.id)).size, 51);
  const inputs = fixture.samples.map((sample: any) => JSON.stringify({ ...sample.input, id: undefined }));
  assert.equal(new Set(inputs).size, 51);
  const response = { items: fixture.samples.map((sample: any) => ({
    id: sample.id, tags: sample.expected.map(({ name, value }: any) => ({ name, value })),
  })) };
  assert.deepEqual(parseTagExtractionResponse(JSON.stringify(response)), response);
  for (const sample of fixture.samples) {
    assert.equal(sample.provenance.kind, 'synthetic-control');
    const proposed = sample.expected.map(({ name, value }: any, proposalIndex: number) =>
      ({ name, value, proposalIndex, evidence: [] }));
    const mockVotes = proposed.map(() => true);
    assert.deepEqual(validateReviewedTagExtractionDecision(BigInt(sample.id), proposed, [], sample.input, mockVotes, true).rejectedTags, [], sample.id);
    for (const tag of sample.expected) {
      const value = tag.path.split('.').reduce((field: any, key: string) => field[key], sample.input);
      assert.ok(typeof value === 'string' && value.includes(tag.quote));
    }
  }
  const groups = new Set(fixture.samples.flatMap((sample: any) => sample.expected.map((tag: any) => PURCHASE_GUIDE_FIELDS[tag.name].collectionGroup)));
  assert.equal(groups.size, 7);
  assert.ok(fixture.samples.filter((sample: any) => !sample.expected.length).length >= 6);
  assert.match(fixture.annotationScope, /synthetic/);
});
