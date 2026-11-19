import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const reviewDirectory = 'out/standardization-review-20261118';
const inputNames = {
  approval: 'catalog-approval-20261119.json',
  closure: 'standard-closure-final.json',
  inventory: 'complete-inventory-20261119-closure-check.json',
  attribution: 'offer-attribution-results.json',
  attributionInput: 'offer-attribution-input-20261118.json',
};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const unique = values => [...new Set(values)];
const hasText = value => typeof value === 'string' && value.trim().length > 0;
const normalizedName = value => value.normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
const identity = row => row && [row.family, row.product, row.tier].every(hasText)
  ? { family: row.family, product: row.product, tier: row.tier } : null;
const observed = row => row ? {
  id: row.id, identity: identity(row), standardKey: row.standard_key ?? null,
  hidden: row.hidden, public: row.public, mergedIntoId: row.merged_into_id,
  verificationState: row.verification_state,
} : null;

function indexRows(rows, field, label) {
  assert(Array.isArray(rows), `${label} must be an array`);
  const result = new Map();
  for (const row of rows) {
    assert(row && hasText(row[field]), `${label}: invalid ${field}`);
    assert(!result.has(row[field]), `${label}: duplicate ${field} ${row[field]}`);
    result.set(row[field], row);
  }
  return result;
}

function append(index, key, value) {
  if (!index.has(key)) index.set(key, []);
  index.get(key).push(value);
}

export function collectManualRecords(document, file) {
  const records = [];
  function visit(value, pointer) {
    if (!value || typeof value !== 'object') return;
    if (!Array.isArray(value)) {
      const marker = value.evidence_unknown === true || value.evidence_known === false
        || value.evidenceKnown === false || Object.values(value).includes('evidence_unknown');
      const decision = 'evidence_known' in value || 'evidenceKnown' in value
        || value.source === 'direct_sql' || value.source === 'application' && 'action' in value;
      const locked = value.standardization_locked === true || value.standardizationLocked === true;
      const human = value.assignment_source === 'human';
      if (marker || decision || locked || human) {
        const version = value.content_version ?? value.contentVersion ?? null;
        const fingerprint = value.content_fingerprint ?? value.contentFingerprint ?? null;
        records.push({
          file, pointer, recordKind: decision ? 'manual_decision' : human ? 'human_membership' : locked ? 'product_lock' : 'unknown_evidence_marker',
          recordId: decision ? value.id ?? null : null,
          productId: value.product_id ?? value.productId ?? (human || locked ? value.id ?? null : null),
          standardProductId: value.standard_product_id ?? value.standardProductId ?? value.previous_standard_id ?? null,
          source: value.source ?? value.assignment_source ?? null, action: value.action ?? null,
          locked, evidenceUnknown: marker,
          evidenceKnown: value.evidence_known ?? value.evidenceKnown ?? null,
          contentVersion: version, contentFingerprint: fingerprint,
          missingEvidenceScope: version === null || !hasText(fingerprint),
          requiredHandling: 'preserve_and_scope_against_current_product_evidence_before_cutover',
        });
      }
    }
    for (const [key, child] of Object.entries(value)) {
      visit(child, `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`);
    }
  }
  visit(document, '');
  return records;
}

export function buildMigrationAudit({ approval, closure, inventory, attribution, attributionInput }) {
  assert(Number.isSafeInteger(approval.canonicalDefinitions) && approval.canonicalDefinitions > 0,
    'Approval must specify the confirmed definition count');
  assert.equal(approval.productionApplied, false, 'Unexpected approval scope');
  const definitions = indexRows(closure.definitions, 'definitionKey', 'definitions');
  assert.equal(definitions.size, approval.canonicalDefinitions, 'Approved definition count mismatch');
  assert.equal(closure.summary.canonicalDefinitions, definitions.size, 'Closure count mismatch');
  assert.equal(closure.summary.snapshotAt, inventory.captured_at, 'Inventory snapshot mismatch');
  assert.equal(inventory.read_only, 'on', 'Expected an offline read-only inventory capture');
  const existing = indexRows(inventory.rows, 'id', 'inventory');
  const dispositions = indexRows(closure.rows, 'currentId', 'dispositions');
  const offers = indexRows(attribution.rows, 'productId', 'attribution');
  const sourceOffers = indexRows(attributionInput.rows, 'product_id', 'attribution input');
  assert.equal(attribution.summary.snapshotAt, attributionInput.captured_at, 'Attribution snapshot mismatch');
  assert(Array.isArray(closure.historicalCoordination), 'Missing historical coordination');
  const issues = [];
  const idOwners = new Map();
  const sourceTargets = new Map();
  const keyOwners = new Map();
  const standardKeyOwners = new Map();
  for (const row of existing.values()) {
    assert(typeof row.hidden === 'boolean' && typeof row.public === 'boolean', `Missing visibility: ${row.id}`);
    assert(row.merged_into_id === null || hasText(row.merged_into_id), `Invalid merge reference: ${row.id}`);
    const tuple = identity(row);
    if (tuple) append(keyOwners, JSON.stringify(tuple), row.id);
    if (hasText(row.standard_key)) append(standardKeyOwners, row.standard_key, row.id);
  }
  const catalog = [...definitions.values()].map(definition => {
    assert(hasText(definition.name) && hasText(definition.definition), 'Missing approved definition text');
    assert(Array.isArray(definition.existingIds) && Array.isArray(definition.sourceIds), 'Missing ID provenance');
    assert(definition.primaryExistingId === null || hasText(definition.primaryExistingId), 'Invalid primary ID');
    if (definition.primaryExistingId !== null) {
      assert(definition.existingIds.includes(definition.primaryExistingId), 'Primary ID not in existingIds');
    }
    for (const id of definition.existingIds) {
      assert(hasText(id), 'Invalid existing ID');
      append(idOwners, id, definition.definitionKey);
      if (!existing.has(id)) issues.push({ code: 'missing_existing_id', id, definitionKey: definition.definitionKey });
    }
    for (const id of definition.sourceIds) {
      assert(hasText(id), 'Invalid source ID');
      append(sourceTargets, id, definition.definitionKey);
    }
    const primary = existing.get(definition.primaryExistingId);
    return {
      definitionKey: definition.definitionKey, name: definition.name,
      definition: definition.definition, kind: definition.kind, companyProduct: definition.companyProduct,
      currentSaleSupported: definition.currentSaleSupported ?? null,
      primaryExistingId: definition.primaryExistingId, existingIds: definition.existingIds,
      sourceIds: definition.sourceIds, evidence: definition.evidence,
      observedExistingIdentities: definition.existingIds.map(id => observed(existing.get(id))),
      identityResolution: !primary ? 'independent_id_required' : primary.hidden || primary.merged_into_id
        ? 'hidden_or_merged_identity_review_required' : 'existing_id_definition_alignment_required',
      canonicalIdentityApprovedForCutover: null,
      definitionConfirmed: true, quoteAttributionApproved: false, publicationChangeAuthorized: false,
    };
  });
  for (const [id, owners] of idOwners) {
    if (unique(owners).length > 1) issues.push({ code: 'id_claimed_by_multiple_definitions', id, definitionKeys: unique(owners) });
  }
  for (const [tuple, ids] of keyOwners) {
    if (ids.length > 1) issues.push({ code: 'occupied_identity_collision', identity: JSON.parse(tuple), ids,
      records: ids.map(id => observed(existing.get(id))) });
  }
  for (const [key, ids] of standardKeyOwners) {
    if (ids.length > 1) issues.push({ code: 'duplicate_standard_key', standardKey: key, ids });
  }
  const splits = [];
  for (const row of dispositions.values()) {
    assert(Array.isArray(row.targets), `Missing targets: ${row.currentId}`);
    assert(existing.has(row.currentId), `Disposition source missing: ${row.currentId}`);
    const keys = row.targets.map(target => {
      const definition = definitions.get(target.definitionKey);
      assert(definition, `Unknown definition reference: ${target.definitionKey}`);
      assert.equal(normalizedName(target.name), normalizedName(definition.name), `Definition name mismatch: ${target.definitionKey}`);
      assert(definition.sourceIds.includes(row.currentId), `Missing reverse source reference: ${row.currentId}`);
      assert(target.existingId === null || definition.existingIds.includes(target.existingId), 'Target ID mismatch');
      return target.definitionKey;
    });
    assert.equal(unique(keys).length, keys.length, `Repeated target: ${row.currentId}`);
    if (keys.length > 1 || row.resolution === 'split') {
      assert(keys.length > 1 && row.resolution === 'split', `Invalid split: ${row.currentId}`);
      splits.push({ sourceId: row.currentId, targetDefinitionKeys: keys, requiresPerOfferEvidence: true });
    }
  }
  for (const [id, keys] of sourceTargets) {
    assert(dispositions.has(id), `Missing source disposition: ${id}`);
    for (const key of keys) assert(dispositions.get(id).targets.some(target => target.definitionKey === key),
      `Missing forward target reference: ${id}/${key}`);
  }
  for (const row of existing.values()) {
    if (row.public && !dispositions.has(row.id)) issues.push({ code: 'public_standard_without_disposition', id: row.id });
  }
  const historicalCoordination = closure.historicalCoordination.map(row => {
    const historical = existing.get(row.historicalId);
    const primary = existing.get(row.primaryId);
    if (!historical || !primary) issues.push({ code: 'missing_historical_reference', ...row });
    return { ...row, historicalIdentity: observed(historical), primaryIdentity: observed(primary),
      requiresIdentityAndReferenceReconciliation: true, restoreVisibility: false };
  });
  const hiddenReferences = catalog.filter(row => row.observedExistingIdentities.some(item => item?.hidden
    || item?.mergedIntoId || item?.public === false)).map(row => ({
    definitionKey: row.definitionKey, name: row.name, primaryExistingId: row.primaryExistingId,
    references: row.observedExistingIdentities,
  }));
  const attributionRows = [...offers.values()].map((row, index) => {
    assert(['assign', 'no_existing_target', 'needs_evidence', 'exclude'].includes(row.decision), 'Unknown attribution decision');
    assert(Array.isArray(row.existingTargetStandardIds), 'Missing attribution target IDs');
    const input = sourceOffers.get(row.productId);
    const flags = [];
    if (!input) flags.push('source_offer_missing');
    if (input && (row.sourceContentVersion !== input.content_version
      || row.sourceContentFingerprint !== input.content_fingerprint
      || row.sourceStandardizationRevision !== input.standardization_revision
      || row.previousStandardId !== input.previous_standard_id)) flags.push('snapshot_evidence_mismatch');
    if (!hasText(row.sourceContentVersion) || !hasText(row.sourceContentFingerprint)
      || !hasText(row.sourceStandardizationRevision)) flags.push('evidence_version_missing');
    const targetIds = unique([row.targetStandardId, ...row.existingTargetStandardIds].filter(Boolean));
    const candidateKeys = unique(targetIds.flatMap(id => [...(idOwners.get(id) ?? []), ...(sourceTargets.get(id) ?? [])]));
    if (row.decision === 'assign' && !row.targetStandardId) flags.push('historical_primary_id_unresolved');
    if (row.decision === 'assign' && candidateKeys.length !== 1) flags.push('final_definition_ambiguous_or_absent');
    if (targetIds.some(id => !existing.has(id))) flags.push('target_id_missing_from_inventory');
    if (targetIds.some(id => existing.get(id)?.hidden || existing.get(id)?.merged_into_id)) flags.push('hidden_or_merged_target');
    if ((sourceTargets.get(row.previousStandardId) ?? []).length > 1) flags.push('source_standard_split');
    return {
      productId: row.productId, previousStandardId: row.previousStandardId, priorDecision: row.decision,
      priorTargetCatalogId: row.targetCatalogId, priorTargetName: row.targetStandardName,
      priorTargetStandardId: row.targetStandardId, candidateDefinitionKeys: candidateKeys,
      sourceContentVersion: row.sourceContentVersion, sourceContentFingerprint: row.sourceContentFingerprint,
      sourceStandardizationRevision: row.sourceStandardizationRevision,
      evidenceReference: `${inputNames.attribution}#/rows/${index}`,
      flags, status: 'requires_current_evidence_review', apply: false,
    };
  });
  const missingAttributionProductIds = [...sourceOffers.keys()].filter(id => !offers.has(id));
  const decisionCounts = {};
  for (const row of attributionRows) decisionCounts[row.priorDecision] = (decisionCounts[row.priorDecision] ?? 0) + 1;
  return {
    schemaVersion: 1, mode: 'offline_planning_only', productionAuthorized: false, productionReady: false,
    runtimeDependency: false, publicDisplayWhitelist: false, writes: { database: 0, networkCalls: 0 },
    authority: { approvalFile: inputNames.approval, definitionFile: inputNames.closure,
      approvedDefinitions: definitions.size, definitionApprovalIsNotAttributionApproval: true },
    snapshotAt: inventory.captured_at,
    summary: {
      confirmedDefinitions: catalog.length, missingIndependentIds: catalog.filter(row => !row.primaryExistingId).length,
      nonPublicOrMergedDefinitions: hiddenReferences.length, historicalCoordinationGroups: historicalCoordination.length,
      splitSources: splits.length, inventoryRecords: existing.size, issues: issues.length,
      inventoryRecordsWithStandardKey: inventory.rows.filter(row => hasText(row.standard_key)).length,
      attributionOffers: attributionRows.length, priorAttributionDecisions: decisionCounts,
      missingAttributionProducts: missingAttributionProductIds.length,
      boundedUnknownDispositions: closure.rows.filter(row => row.factStatus === 'bounded_unknown').length,
    },
    confirmedDefinitions: catalog, missingIndependentIds: catalog.filter(row => !row.primaryExistingId),
    identityIssues: issues, splitSources: splits, hiddenReferences, historicalCoordination,
    unresolvedAttribution: {
      scope: 'Historical partial offer review; not approval, not current evidence, not the full production population.',
      rows: attributionRows, missingAttributionProductIds,
      definitionDispositions: closure.rows.map(row => ({
        sourceId: row.currentId, resolution: row.resolution, targetDefinitionKeys: row.targets.map(target => target.definitionKey),
        factStatus: row.factStatus, remainingUnknowns: row.remainingUnknowns,
        publishedMemberAssociations: row.publishedMemberAssociations, offerHandling: row.offerHandling,
        keepOriginalOffersAndPrices: true,
      })),
    },
    requiredCutoverChecks: [
      'Obtain separate production migration authorization and a restorable, verified backup.',
      'Capture a fresh consistent read-only inventory including standard_key, all hidden/merged identities and all foreign-key references; compare snapshot drift.',
      'Approve an exact family/product/tier, standard_key and independent ID allocation for each definition; resolve occupied identities and historical references without runtime aliases.',
      'Recheck every affected offer against current raw evidence, content version, fingerprint, revision and manual locks; resolve split membership individually.',
      'Scope manual decisions against current evidence, especially evidence_known=false, missing versions and persistent locks; never treat missing evidence as a wildcard.',
      'Stop old producers/workers, fence in-flight writes, inventory and close old queued/running/retrying jobs, inputs, checkpoints and leases; retain their audit history.',
      'Recreate only eligible jobs with the new protocol/version and current evidence; verify old jobs/checkpoints cannot resume and retries are idempotent.',
      'Verify counts, IDs, prices, raw offers, features, references and publication rules before/after an independently reviewed atomic migration; do not use the 319 definitions as a display whitelist.',
    ],
    oldTaskCloseout: { localTaskInventoryAvailable: false, status: 'requires_separate_snapshot_and_authorized_closeout' },
    limitations: [
      'Observed identity tuples are historical database values, not approved replacement keys.',
      'No complete standard_key/reference, task/lease or manual-decision export is guaranteed by these research snapshots.',
      'Absence of findings in local files does not prove absence in production.',
      'No SQL, bulk merge, price deletion, feature recomputation or runtime compatibility adapter is generated.',
    ],
  };
}

export async function loadMigrationAudit(directory) {
  const normalization = path.join(directory, 'normalization');
  const inputs = {};
  const sources = [];
  const manualRecords = [];
  const allJson = new Map();
  async function scan(folder) {
    const entries = (await readdir(folder, { withFileTypes: true })).sort((left, right) => left.name < right.name ? -1 : 1);
    for (const entry of entries) {
      const file = path.join(folder, entry.name);
      assert(!entry.isSymbolicLink(), `Symlink input is not supported: ${file}`);
      if (entry.isDirectory()) await scan(file);
      else if (entry.isFile() && entry.name.endsWith('.json')) {
        const bytes = await readFile(file);
        const document = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
        const relative = path.relative(directory, file).split(path.sep).join('/');
        const digest = sha256(bytes);
        sources.push({ file: relative, sha256: digest });
        manualRecords.push(...collectManualRecords(document, relative));
        if (path.dirname(file) === normalization && Object.values(inputNames).includes(entry.name)) {
          allJson.set(entry.name, { document, digest });
        }
      }
    }
  }
  await scan(normalization);
  for (const [name, file] of Object.entries(inputNames)) {
    assert(allJson.has(file), `Missing input: ${file}`);
    inputs[name] = allJson.get(file).document;
  }
  const approvedArtifact = inputs.approval.artifacts.find(artifact => artifact.file === 'normalization/standard-closure-final.json');
  assert(approvedArtifact, 'Approval does not identify the final closure artifact');
  assert.equal(approvedArtifact.sha256, allJson.get(inputNames.closure).digest, 'Approved closure SHA-256 mismatch');
  for (const artifact of inputs.approval.artifacts) {
    const file = path.resolve(directory, artifact.file);
    assert(!path.relative(directory, file).startsWith('..') && !path.isAbsolute(path.relative(directory, file)),
      'Approval artifact escapes input directory');
    const bytes = await readFile(file);
    assert.equal(sha256(bytes), artifact.sha256, `Approval artifact SHA-256 mismatch: ${artifact.file}`);
    if (!sources.some(source => source.file === artifact.file)) sources.push({ file: artifact.file, sha256: sha256(bytes) });
  }
  const report = buildMigrationAudit(inputs);
  return {
    ...report, sources,
    manualRecords: {
      scope: 'Recursive structural scan of every local normalization JSON file; occurrences are not unique production decisions.',
      scannedJsonFiles: sources.filter(source => source.file.endsWith('.json')).length,
      occurrences: manualRecords.length, evidenceUnknownOccurrences: manualRecords.filter(row => row.evidenceUnknown).length,
      uniqueProductIds: unique(manualRecords.map(row => row.productId).filter(Boolean)).length,
      decisionOccurrences: manualRecords.filter(row => row.recordKind === 'manual_decision').length,
      missingEvidenceScopeOccurrences: manualRecords.filter(row => row.missingEvidenceScope).length,
      productionCoverage: 'unknown_requires_complete_decision_and_lock_export', rows: manualRecords,
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  assert(args.length === 0 || args.length === 2 && args[0] === '--input',
    'Usage: node apps/api/scripts/plan-standardization-migration.mjs [--input REVIEW_DIRECTORY]');
  const directory = await realpath(path.resolve(args[1] ?? path.join(repository, reviewDirectory)));
  const report = await loadMigrationAudit(directory);
  const destination = await realpath(path.join(repository, reviewDirectory));
  const output = path.join(destination, 'offline-migration-audit.json');
  const temporary = `${output}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await rename(temporary, output);
  console.log(JSON.stringify({ output: path.relative(repository, output), ...report.summary,
    manualRecordOccurrences: report.manualRecords.occurrences, productionReady: false }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
