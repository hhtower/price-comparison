import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildMigrationAudit, collectManualRecords, loadMigrationAudit,
} from '../scripts/plan-standardization-migration.mjs';

function fixture() {
  const snapshot = '2026-11-19T00:00:00Z';
  const definition = (key, name, existingIds, sourceIds) => ({
    definitionKey: key, name, definition: `${name} product boundary`, kind: 'official_plan',
    existingIds, sourceIds, primaryExistingId: existingIds[0] ?? null, evidence: [],
  });
  const definitions = [
    definition('D001', 'Plan Pro', ['1'], ['1', '2']),
    definition('D002', 'Plan Standard', [], ['2']),
    definition('D003', 'Hidden Plan', ['3'], ['3']),
  ];
  const row = (id, keys) => ({
    currentId: id, resolution: keys.length > 1 ? 'split' : 'keep',
    targets: keys.map(key => {
      const item = definitions.find(value => value.definitionKey === key);
      return { definitionKey: key, name: item.name, existingId: item.primaryExistingId };
    }),
    factStatus: 'established', publishedMemberAssociations: 1,
  });
  return {
    approval: { canonicalDefinitions: 3, productionApplied: false },
    closure: {
      summary: { canonicalDefinitions: 3, snapshotAt: snapshot },
      definitions, rows: [row('1', ['D001']), row('2', ['D001', 'D002']), row('3', ['D003'])],
      historicalCoordination: [{ historicalId: '3', primaryId: '1', name: 'Plan Pro' }],
    },
    inventory: {
      captured_at: snapshot, read_only: 'on',
      rows: ['1', '2', '3'].map(id => ({
        id, family: 'vendor', product: 'plan', tier: id === '2' ? 'standard' : 'pro',
        hidden: id === '3', public: id !== '3', merged_into_id: null, verification_state: 'verified',
      })),
    },
    attribution: {
      summary: { snapshotAt: snapshot },
      rows: [{
        productId: '100', previousStandardId: '2', decision: 'assign',
        existingTargetStandardIds: ['2'], targetStandardId: '2', sourceContentVersion: '1',
        sourceContentFingerprint: 'abc', sourceStandardizationRevision: '5',
      }],
    },
    attributionInput: {
      captured_at: snapshot,
      rows: [{ product_id: '100', previous_standard_id: '2', content_version: '1',
        content_fingerprint: 'abc', standardization_revision: '5' }],
    },
  };
}

test('separates approved definitions from attribution and detects split/hidden occupied identities', () => {
  const input = fixture();
  input.closure.rows[0].targets[0].name = 'PlanPro';
  const before = structuredClone(input);
  const result = buildMigrationAudit(input);
  assert.deepEqual(input, before);
  assert.equal(result.summary.confirmedDefinitions, 3);
  assert.deepEqual(result.missingIndependentIds.map(row => row.definitionKey), ['D002']);
  assert.equal(result.splitSources[0].sourceId, '2');
  assert.equal(result.hiddenReferences[0].primaryExistingId, '3');
  assert.equal(result.historicalCoordination[0].historicalIdentity.hidden, true);
  assert.deepEqual(result.identityIssues[0].ids, ['1', '3']);
  assert.deepEqual(result.unresolvedAttribution.rows[0].candidateDefinitionKeys, ['D001', 'D002']);
  assert(result.unresolvedAttribution.rows[0].flags.includes('source_standard_split'));
  assert.equal(result.unresolvedAttribution.rows[0].apply, false);
  assert.equal(result.productionReady, false);
  assert.equal(result.publicDisplayWhitelist, false);
  assert(result.confirmedDefinitions.every(row => row.canonicalIdentityApprovedForCutover === null));
});

test('reports ID ownership collisions, missing references and evidence drift', () => {
  const input = fixture();
  input.closure.definitions[1].existingIds = ['1', '99'];
  input.closure.definitions[1].primaryExistingId = '1';
  input.inventory.rows[0].standard_key = 'duplicate';
  input.inventory.rows[1].standard_key = 'duplicate';
  input.attribution.rows[0].sourceContentFingerprint = 'changed';
  input.attribution.rows[0].targetStandardId = null;
  const result = buildMigrationAudit(input);
  assert(result.identityIssues.some(row => row.code === 'id_claimed_by_multiple_definitions'));
  assert(result.identityIssues.some(row => row.code === 'missing_existing_id' && row.id === '99'));
  assert(result.identityIssues.some(row => row.code === 'duplicate_standard_key'));
  assert(result.unresolvedAttribution.rows[0].flags.includes('snapshot_evidence_mismatch'));
  assert(result.unresolvedAttribution.rows[0].flags.includes('historical_primary_id_unresolved'));
});

test('fails closed on count mismatch, duplicate IDs and missing definition references', () => {
  const wrongCount = fixture();
  wrongCount.approval.canonicalDefinitions = 319;
  assert.throws(() => buildMigrationAudit(wrongCount), /count mismatch/);
  const duplicate = fixture();
  duplicate.inventory.rows.push(duplicate.inventory.rows[0]);
  assert.throws(() => buildMigrationAudit(duplicate), /duplicate id/);
  const wrongTarget = fixture();
  wrongTarget.closure.rows[0].targets[0].definitionKey = 'D999';
  assert.throws(() => buildMigrationAudit(wrongTarget), /Unknown definition reference/);
});

test('finds unknown evidence, unversioned decisions and human locks without treating zero as missing', () => {
  const records = collectManualRecords({ rows: [
    { id: '1', product_id: '10', evidence_known: false, content_version: null, content_fingerprint: null },
    { id: '2', product_id: '11', evidence_unknown: true, content_version: '0', content_fingerprint: 'abc' },
    { id: '3', product_id: '12', standardization_locked: true },
    { id: '4', product_id: '13', action: 'assign', source: 'application', content_version: 0, content_fingerprint: 'def' },
    { id: '14', standard_product_id: '3', assignment_source: 'human' },
    { description: 'evidence_unknown mentioned in prose is not a record marker' },
  ] }, 'manual.json');
  assert.equal(records.length, 5);
  assert.equal(records[0].missingEvidenceScope, true);
  assert.equal(records[1].missingEvidenceScope, false);
  assert.equal(records[2].locked, true);
  assert.equal(records[3].missingEvidenceScope, false);
  assert.equal(records[0].pointer, '/rows/0');
  assert.equal(records[4].productId, '14');
  assert.equal(records[4].recordKind, 'human_membership');
  assert.equal(records[4].evidenceKnown, null);
});

test('loads only local files, scans nested manual records, verifies approval hashes, and writes no input', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'standardization-offline-test-'));
  try {
    const normalization = path.join(directory, 'normalization');
    await mkdir(path.join(normalization, 'nested'), { recursive: true });
    const input = fixture();
    const closureBytes = JSON.stringify(input.closure);
    input.approval.artifacts = [{
      file: 'normalization/standard-closure-final.json',
      sha256: createHash('sha256').update(closureBytes).digest('hex'),
    }];
    const files = {
      'catalog-approval-20261119.json': input.approval,
      'standard-closure-final.json': input.closure,
      'complete-inventory-20261119-closure-check.json': input.inventory,
      'offer-attribution-results.json': input.attribution,
      'offer-attribution-input-20261118.json': input.attributionInput,
      'nested/manual.json': { rows: [{ id: '7', product_id: '100', evidence_known: false }] },
    };
    for (const [name, data] of Object.entries(files)) {
      await writeFile(path.join(normalization, name), JSON.stringify(data));
    }
    const report = await loadMigrationAudit(directory);
    assert.equal(report.manualRecords.occurrences, 1);
    assert.equal(report.manualRecords.evidenceUnknownOccurrences, 1);
    assert.equal(report.sources.length, 6);
    assert.deepEqual(await loadMigrationAudit(directory), report);
    for (const [name, data] of Object.entries(files)) {
      assert.equal(await readFile(path.join(normalization, name), 'utf8'), JSON.stringify(data));
    }
    await writeFile(path.join(normalization, 'standard-closure-final.json'), `${closureBytes}\n`);
    await assert.rejects(loadMigrationAudit(directory), /SHA-256 mismatch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
