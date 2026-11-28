import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { evaluateMembershipFeatures } from '../scripts/evaluate-membership-features.js';
import {
  MEMBERSHIP_FEATURE_PROMPT_VERSION,
  MEMBERSHIP_FEATURE_REVIEW_PROMPT_VERSION,
} from '../src/ai/membership-feature-request.js';
import { MEMBERSHIP_FEATURE_FIXTURE_VERSION, membershipFeatureCases } from './fixtures/membership-feature-cases.js';

// Synthetic protocol controls, never persisted or presented as model observations.
const generation = (membershipKind: string, refs = [0, 1], id = '1') =>
  JSON.stringify({ items: [{ id, refs, membershipKind }] });
const review = (classificationDecision: boolean, code: string | null, refs = classificationDecision ? [] : [0, 1]) =>
  JSON.stringify({ items: [{ id: '1', classificationDecision, code, refs }] });
const accepted = { id: '101', generation: generation('top_up'), review: review(true, null) };

test('independent fixtures retain 29 legacy IDs and three held-out cases with explicit diagnostic expectations', () => {
  assert.equal(membershipFeatureCases.length, 32);
  assert.deepEqual(membershipFeatureCases.slice(0, 29).map(item => item.id), Array.from({ length: 29 }, (_, index) => String(index + 101)));
  assert.equal(new Set(membershipFeatureCases.map(item => item.id)).size, membershipFeatureCases.length);
  for (const item of membershipFeatureCases) {
    assert.ok(item.name && item.spec && item.reason);
    assert.equal(item.reviewCode === null, item.expectedKind === item.proposedKind, item.id);
  }
  const find = (id: string) => membershipFeatureCases.find(item => item.id === id)!;
  assert.equal(find('106').reviewCode, 'delivery_mismatch');
  for (const id of ['120', '121', '122', '126', '127', '128', '129', '130']) {
    assert.notEqual(find(id).expectedKind, 'short_term', id);
    assert.equal(find(id).reviewCode, 'protection_mismatch', id);
  }
  for (const id of ['105', '109', '114', '123', '124', '125', '131']) {
    assert.equal(find(id).expectedKind, 'short_term', id);
    assert.equal(find(id).reviewCode, 'protection_mismatch', id);
  }
  assert.equal(find('107').expectedKind, 'top_up');
  assert.equal(find('118').expectedKind, 'top_up');
  assert.equal(find('132').expectedKind, 'top_up_half_price');
});

test('valid wire records restore local IDs and score reviews against the fixed proposal', () => {
  const report = evaluateMembershipFeatures({ cases: [
    accepted,
    { id: '106', generation: generation('short_term'), review: review(false, 'delivery_mismatch') },
    { id: '120', generation: generation('short_term'), review: review(false, 'protection_mismatch') },
  ] });
  assert.deepEqual(report.coverage, { total: 32, provided: 3, missing: 29, valid: 3, generationValid: 3, reviewValid: 3, ratio: 3 / 32 });
  assert.deepEqual(report.classification, { correct: 2, total: 32, accuracy: 2 / 32 });
  assert.deepEqual(report.review, { correct: 3, total: 32, accuracy: 3 / 32 });
  assert.equal(report.passed, 2);
  const ambiguousDelivery = report.cases.find(item => item.id === '106')!;
  assert.equal(ambiguousDelivery.generation?.id, '106');
  assert.equal(ambiguousDelivery.review?.id, '106');
  assert.equal(ambiguousDelivery.proposedKind, 'top_up');
  assert.equal(ambiguousDelivery.reviewCorrect, true);
  const wrongGeneration = report.cases.find(item => item.id === '120')!;
  assert.equal(wrongGeneration.classificationCorrect, false);
  assert.equal(wrongGeneration.reviewCorrect, true);
  assert.match(wrongGeneration.diagnostics.join(' '), /Expected classification top_up/);
  assert.equal(report.provenance, 'provided-recordings');
  assert.equal(report.semanticPopulationAccuracy, 'unknown');
  assert.equal(report.recordingPromptVersions, 'unknown');
  assert.equal(report.modelCalls, 0);
  assert.equal(report.fixtureVersion, MEMBERSHIP_FEATURE_FIXTURE_VERSION);
  assert.deepEqual(report.promptVersions, { generation: MEMBERSHIP_FEATURE_PROMPT_VERSION, review: MEMBERSHIP_FEATURE_REVIEW_PROMPT_VERSION });
});

test('a correct rejection with the wrong diagnostic is not a correct review', () => {
  const report = evaluateMembershipFeatures({ cases: [
    { id: '106', generation: generation('short_term'), review: review(false, 'protection_mismatch') },
    { id: '102', generation: generation('top_up'), review: review(true, null) },
  ] });
  const wrongCode = report.cases.find(item => item.id === '106')!;
  assert.equal(wrongCode.reviewVerdictCorrect, true);
  assert.equal(wrongCode.reviewCodeCorrect, false);
  assert.equal(wrongCode.reviewCorrect, false);
  assert.equal(wrongCode.passed, false);
  assert.match(wrongCode.diagnostics.join(' '), /Expected review code delivery_mismatch; received protection_mismatch/);
  assert.equal(report.reviewVerdict.correct, 1);
  assert.equal(report.reviewCode.correct, 0);
  assert.equal(report.review.correct, 0);
  assert.equal(report.protocolErrors.cases, 0);
});

test('held-out scores exclude examples that appeared in the previous prompt', () => {
  const report = evaluateMembershipFeatures({ cases: [
    accepted,
    { id: '130', generation: generation('top_up'), review: review(false, 'protection_mismatch') },
  ] });
  assert.deepEqual(report.splits.regression, { total: 29, provided: 1, classificationCorrect: 1, reviewCorrect: 1, passed: 1 });
  assert.deepEqual(report.splits.heldOut, { total: 3, provided: 1, classificationCorrect: 1, reviewCorrect: 1, passed: 1 });
});

test('missing records never pass and remain in all accuracy denominators', () => {
  const report = evaluateMembershipFeatures({ cases: [] });
  assert.equal(report.coverage.missing, 32);
  assert.equal(report.coverage.valid, 0);
  assert.equal(report.passed, 0);
  assert.equal(report.classification.accuracy, 0);
  assert.equal(report.review.accuracy, 0);
  assert.ok(report.cases.every(item => item.status === 'missing'
    && !item.classificationCorrect && !item.reviewVerdictCorrect && !item.reviewCodeCorrect
    && item.generation === null && item.review === null && item.diagnostics.includes('Missing recording')));
});

test('protocol failures are isolated by stage and reject invalid JSON, IDs, refs and schemas', () => {
  const report = evaluateMembershipFeatures({ cases: [
    { id: '101', generation: '{"items":', review: review(true, null) },
    { id: '102', generation: generation('top_up'), review: review(false, 'delivery_mismatch', [2]) },
    { id: '103', generation: generation('account', [0, 1], '103'), review: '{"items":[]}' },
    { id: '104', generation: generation('rental', [2]), review: review(true, 'delivery_mismatch') },
    { id: '105', generation: generation('invalid'), review: '{"items":[{"id":"1","classificationDecision":true,"code":null,"refs":[],"extra":1}]}' },
    { id: '106', generation: generation('short_term', [0, 0]), review: review(false, 'invalid') },
  ] });
  assert.deepEqual(report.protocolErrors, { cases: 6, generation: 5, review: 5 });
  assert.equal(report.coverage.valid, 0);
  assert.equal(report.classification.correct, 1);
  assert.equal(report.review.correct, 1);
  assert.equal(report.passed, 0);
  assert.equal(report.coverage.missing, 26);
  assert.ok(report.cases.filter(item => item.status === 'protocol_error')
    .every(item => item.protocolErrors.length > 0 && item.diagnostics.some(message => message.includes('protocol error'))));
});

test('recording envelope rejects duplicates, unknown IDs and malformed rows without partial scoring', () => {
  assert.throws(() => evaluateMembershipFeatures({ cases: [accepted, accepted] }), /Duplicate case ID: 101/);
  assert.throws(() => evaluateMembershipFeatures({ cases: [accepted, { ...accepted, id: '999' }] }), /Unknown case ID: 999/);
  for (const malformed of [
    null, [], 'recording', {}, { cases: null }, { cases: {} }, { cases: [], extra: true },
    { cases: [null] }, { cases: [[]] }, { cases: [{ ...accepted, id: 101 }] },
    { cases: [{ id: '101', generation: accepted.generation }] },
    { cases: [{ ...accepted, generation: { items: [] } }] },
    { cases: [{ ...accepted, review: null }] }, { cases: [{ ...accepted, extra: true }] },
  ]) {
    assert.throws(() => evaluateMembershipFeatures(malformed), /Recording must|Each recording must/);
  }
});

test('CLI writes an offline report and rejects invalid recordings without creating a report', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'membership-evaluation-test-'));
  const script = fileURLToPath(new URL('../scripts/evaluate-membership-features.ts', import.meta.url));
  const input = path.join(directory, 'synthetic-protocol-controls.json');
  const output = path.join(directory, 'report.json');
  const rejectedOutput = path.join(directory, 'rejected.json');
  try {
    await writeFile(input, JSON.stringify({ cases: [accepted] }), 'utf8');
    const valid = spawnSync(process.execPath, ['--import', 'tsx', script, input, output], { encoding: 'utf8' });
    assert.equal(valid.status, 0, valid.stderr);
    const report = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(report.coverage.provided, 1);
    assert.equal(report.passed, 1);
    assert.equal(report.provenance, 'provided-recordings');
    assert.match(valid.stdout, /Evaluated 1\/32 recordings/);
    const savedReport = await readFile(output, 'utf8');
    const overwrite = spawnSync(process.execPath, ['--import', 'tsx', script, input, output], { encoding: 'utf8' });
    assert.notEqual(overwrite.status, 0);
    assert.equal(await readFile(output, 'utf8'), savedReport);
    await writeFile(input, JSON.stringify({ cases: [accepted, accepted] }), 'utf8');
    const invalid = spawnSync(process.execPath, ['--import', 'tsx', script, input, rejectedOutput], { encoding: 'utf8' });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Duplicate case ID: 101/);
    await assert.rejects(readFile(rejectedOutput), { code: 'ENOENT' });
    const samePath = spawnSync(process.execPath, ['--import', 'tsx', script, input, input], { encoding: 'utf8' });
    assert.equal(samePath.status, 1);
    assert.match(samePath.stderr, /Report path must differ/);
  } finally {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('membership-evaluation-test-'));
    await rm(directory, { recursive: true, force: true });
  }
});
