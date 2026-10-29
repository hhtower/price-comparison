import { buildCanonicalStandardKey } from './canonical-key.js';
import { DUPLICATE_LINKAGE_POLICY } from './duplicate-linkage-policy.js';
import {
  classifyDuplicatePair,
  duplicateBlockingTerms,
  extractDuplicateFeatures,
  type DuplicatePairDecision,
  type StandardProductIdentity,
} from './duplicate-linkage.js';

export interface ConfirmedAliasEdge { readonly fromId: string; readonly toId: string; readonly confirmed: boolean }
export const DUPLICATE_BLOCKING_ROUTES = ['familyProduct', 'productTier', 'characterNgram', 'combinedToken'] as const;
export type DuplicateBlockingRoute = typeof DUPLICATE_BLOCKING_ROUTES[number];
export interface DuplicateAuditOptions {
  readonly snapshotVersion: string;
  readonly aliasVersion: string;
  readonly cursor?: string;
  readonly changedIds?: readonly string[];
  readonly maxPostingsPerFeature?: number;
  readonly maxScannedPerRoutePerIdentity?: number;
  readonly maxComparedPerIdentity?: number;
  readonly topSuspectsPerIdentity?: number;
  readonly maxReportedSuspectPairs?: number;
  readonly disabledRoutes?: readonly DuplicateBlockingRoute[];
}
export interface VersionedDuplicateAuditSnapshot {
  readonly snapshotVersion: string;
  readonly aliasVersion: string;
  readonly products: readonly StandardProductIdentity[];
  readonly aliases: readonly ConfirmedAliasEdge[];
}
export interface DuplicateAuditIndexChange {
  readonly productId: string;
  readonly operation: 'upsert' | 'delete';
  readonly product?: StandardProductIdentity;
}
export interface DuplicateAuditIndexApplyResult {
  readonly snapshotVersion: string;
  readonly processedChangeCount: number;
  readonly updatedPostingCount: number;
}
export interface DuplicateAuditRunOptions {
  readonly cursor?: string;
  readonly changedIds?: readonly string[];
}
export interface AuditPair extends DuplicatePairDecision {
  readonly pairKey: string;
  readonly ids: readonly [string, string];
  readonly routes: readonly string[];
}
interface RouteStats { scannedPostings: number; scanLimit: number; truncatedFeatures: number; contributedPairs: number }
export interface DuplicateAuditResult {
  readonly policyVersion: string;
  readonly deterministicGroups: ReadonlyArray<{
    representativeId: string;
    members: readonly string[];
    edges: ReadonlyArray<{ fromId: string; toId: string }>;
  }>;
  readonly suspectedPairs: readonly AuditPair[];
  readonly allCandidatePairs: readonly AuditPair[];
  readonly nextCursor: string | null;
  readonly limits: {
    maxPostingsPerFeature: number;
    maxComparedPerIdentity: number;
    topSuspectsPerIdentity: number;
    maxReportedSuspectPairs: number;
  };
  readonly stats: {
    comparedPairs: number;
    processedIdentityCount: number;
    identitiesAtCompareLimit: number;
    routes: Readonly<Record<string, RouteStats>>;
  };
}

interface ResolvedDuplicateAuditOptions {
  readonly maxPostingsPerFeature: number;
  readonly maxScannedPerRoutePerIdentity: number;
  readonly maxComparedPerIdentity: number;
  readonly topSuspectsPerIdentity: number;
  readonly maxReportedSuspectPairs: number;
  readonly disabledRoutes: ReadonlySet<DuplicateBlockingRoute>;
}

type BlockingTerms = Readonly<Record<DuplicateBlockingRoute, readonly string[]>>;
type DeterministicGroup = DuplicateAuditResult['deterministicGroups'][number];
interface PreparedProduct {
  readonly product: StandardProductIdentity;
  readonly terms: BlockingTerms;
  readonly canonicalKey: string;
}

function pairKey(left: string, right: string): string {
  return [left, right].sort().join('\u0000');
}

function encodeCursor(value: object): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(value: string): {
  snapshotVersion: string;
  aliasVersion: string;
  policyVersion: string;
  lastPairKey: string;
  routePositions: Record<string, number>;
} {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new Error('invalid duplicate audit cursor');
  }
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new RangeError(`${name} must be a positive integer`);
  return resolved;
}

function resolveOptions(options: Omit<DuplicateAuditOptions, 'snapshotVersion' | 'aliasVersion' | 'cursor' | 'changedIds'>): ResolvedDuplicateAuditOptions {
  return {
    maxPostingsPerFeature: positiveInteger(options.maxPostingsPerFeature, 256, 'maxPostingsPerFeature'),
    maxScannedPerRoutePerIdentity: positiveInteger(options.maxScannedPerRoutePerIdentity, 40, 'maxScannedPerRoutePerIdentity'),
    maxComparedPerIdentity: positiveInteger(options.maxComparedPerIdentity, 100, 'maxComparedPerIdentity'),
    topSuspectsPerIdentity: positiveInteger(options.topSuspectsPerIdentity, 10, 'topSuspectsPerIdentity'),
    maxReportedSuspectPairs: positiveInteger(options.maxReportedSuspectPairs, 10_000, 'maxReportedSuspectPairs'),
    disabledRoutes: new Set(options.disabledRoutes ?? []),
  };
}

function validateAliases(aliases: readonly ConfirmedAliasEdge[], ids: ReadonlySet<string>): void {
  const outgoing = new Map<string, string>();
  for (const alias of aliases.filter(item => item.confirmed)) {
    if (!ids.has(alias.fromId) || !ids.has(alias.toId)) throw new Error('alias references unknown product');
    const previous = outgoing.get(alias.fromId);
    if (previous && previous !== alias.toId) throw new Error('ambiguous alias target');
    outgoing.set(alias.fromId, alias.toId);
  }
  for (const start of outgoing.keys()) {
    const visited = new Set<string>();
    let current: string | undefined = start;
    while (current && outgoing.has(current)) {
      if (visited.has(current)) throw new Error('alias cycle detected');
      visited.add(current);
      current = outgoing.get(current);
    }
  }
}

function insertSorted(values: string[], value: string): void {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]!.localeCompare(value) < 0) low = middle + 1;
    else high = middle;
  }
  if (values[low] === value) throw new Error(`duplicate posting for product ${value}`);
  values.splice(low, 0, value);
}

function removeSorted(values: string[], value: string): void {
  const index = values.indexOf(value);
  if (index < 0) throw new Error(`missing posting for product ${value}`);
  values.splice(index, 1);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export class VersionedDuplicateAuditIndex {
  readonly #options: ResolvedDuplicateAuditOptions;
  readonly #aliases: readonly ConfirmedAliasEdge[];
  readonly #products = new Map<string, StandardProductIdentity>();
  readonly #blockingTerms = new Map<string, BlockingTerms>();
  readonly #postings = new Map<DuplicateBlockingRoute, Map<string, string[]>>();
  readonly #canonicalKeyById = new Map<string, string>();
  readonly #canonicalMembers = new Map<string, Set<string>>();
  readonly #aliasAdjacency = new Map<string, Set<string>>();
  readonly #groupRepresentativeById = new Map<string, string>();
  readonly #groupsByRepresentative = new Map<string, DeterministicGroup>();
  #snapshotVersion: string;
  readonly #aliasVersion: string;

  static build(
    snapshot: VersionedDuplicateAuditSnapshot,
    options: Omit<DuplicateAuditOptions, 'snapshotVersion' | 'aliasVersion' | 'cursor' | 'changedIds'> = {},
  ): VersionedDuplicateAuditIndex {
    return new VersionedDuplicateAuditIndex(snapshot, resolveOptions(options));
  }

  private constructor(snapshot: VersionedDuplicateAuditSnapshot, options: ResolvedDuplicateAuditOptions) {
    if (!snapshot.snapshotVersion) throw new Error('duplicate audit snapshot version is required');
    if (!snapshot.aliasVersion) throw new Error('duplicate audit alias version is required');
    this.#snapshotVersion = snapshot.snapshotVersion;
    this.#aliasVersion = snapshot.aliasVersion;
    this.#options = options;
    this.#aliases = [...snapshot.aliases];
    for (const route of DUPLICATE_BLOCKING_ROUTES) this.#postings.set(route, new Map());

    const ordered = [...snapshot.products].sort((left, right) => left.id.localeCompare(right.id));
    if (new Set(ordered.map(item => item.id)).size !== ordered.length) throw new Error('duplicate product id');
    validateAliases(this.#aliases, new Set(ordered.map(item => item.id)));
    for (const alias of this.#aliases.filter(item => item.confirmed)) {
      this.#addAliasNeighbor(alias.fromId, alias.toId);
      this.#addAliasNeighbor(alias.toId, alias.fromId);
    }
    for (const product of ordered) this.#addProduct(product);
    this.#rebuildAllGroups();
  }

  get snapshotVersion(): string { return this.#snapshotVersion; }
  get aliasVersion(): string { return this.#aliasVersion; }
  get size(): number { return this.#products.size; }

  applyChanges(
    changes: readonly DuplicateAuditIndexChange[],
    targetSnapshotVersion: string,
    options: { readonly aliasVersion?: string } = {},
  ): DuplicateAuditIndexApplyResult {
    if (!targetSnapshotVersion) throw new Error('duplicate audit target snapshot version is required');
    if (targetSnapshotVersion === this.#snapshotVersion) throw new Error('duplicate audit target snapshot version must advance');
    if (options.aliasVersion !== undefined && options.aliasVersion !== this.#aliasVersion) {
      throw new Error('duplicate audit alias version changed; rebuild the index');
    }
    const finalById = new Map<string, StandardProductIdentity | undefined>();
    for (const change of changes) {
      if (!change.productId) throw new Error('duplicate audit change productId is required');
      if (finalById.has(change.productId)) throw new Error(`duplicate audit change id ${change.productId}`);
      if (change.operation === 'upsert') {
        if (!change.product) throw new Error(`upsert change ${change.productId} is missing its product`);
        if (change.product.id !== change.productId) throw new Error(`duplicate audit change id mismatch: ${change.productId}`);
        finalById.set(change.productId, change.product);
      } else {
        if (change.product !== undefined) throw new Error(`delete change ${change.productId} must not include a product`);
        if ((this.#aliasAdjacency.get(change.productId)?.size ?? 0) > 0) {
          throw new Error(`cannot delete aliased product ${change.productId} without rebuilding aliases`);
        }
        finalById.set(change.productId, undefined);
      }
    }
    const preparedById = new Map<string, PreparedProduct>();
    for (const [id, product] of finalById) {
      if (product) preparedById.set(id, this.#prepareProduct(product));
    }

    const affectedBefore = new Set<string>();
    for (const id of finalById.keys()) {
      const representative = this.#groupRepresentativeById.get(id);
      if (representative) for (const member of this.#groupsByRepresentative.get(representative)!.members) affectedBefore.add(member);
    }

    let updatedPostingCount = 0;
    for (const [id, product] of finalById) {
      if (this.#products.has(id)) updatedPostingCount += this.#removeProduct(id);
      if (product) updatedPostingCount += this.#addPreparedProduct(preparedById.get(id)!);
    }
    this.#refreshAffectedGroups(new Set([...affectedBefore, ...finalById.keys()]));
    this.#snapshotVersion = targetSnapshotVersion;
    return { snapshotVersion: targetSnapshotVersion, processedChangeCount: changes.length, updatedPostingCount };
  }

  audit(options: DuplicateAuditRunOptions = {}): DuplicateAuditResult {
    const requestedIds = options.changedIds === undefined
      ? [...this.#products.keys()].sort((left, right) => left.localeCompare(right))
      : uniqueSorted(options.changedIds);
    for (const id of requestedIds) if (!this.#products.has(id)) throw new Error(`changed product ${id} is not in the duplicate audit snapshot`);

    const routes = Object.fromEntries(DUPLICATE_BLOCKING_ROUTES.map(route => [route, {
      scannedPostings: 0,
      scanLimit: 0,
      truncatedFeatures: 0,
      contributedPairs: 0,
    }])) as Record<DuplicateBlockingRoute, RouteStats>;
    const selectionCache = new Map<string, Map<string, Set<DuplicateBlockingRoute>>>();
    const getSelection = (id: string): Map<string, Set<DuplicateBlockingRoute>> => {
      const cached = selectionCache.get(id);
      if (cached) return cached;
      const direct = this.#candidateRoutesForSource(id, routes);
      const selected = new Map(
        [...direct.entries()]
          .sort(([left], [right]) => pairKey(id, left).localeCompare(pairKey(id, right)))
          .slice(0, this.#options.maxComparedPerIdentity),
      );
      selectionCache.set(id, selected);
      return selected;
    };

    const primarySelections = new Map<string, Map<string, Set<DuplicateBlockingRoute>>>();
    for (const id of requestedIds) primarySelections.set(id, getSelection(id));
    let identitiesAtCompareLimit = 0;
    const candidateRoutes = new Map<string, Set<DuplicateBlockingRoute>>();
    for (const [sourceId, selected] of primarySelections) {
      if (selected.size >= this.#options.maxComparedPerIdentity) identitiesAtCompareLimit += 1;
      for (const [candidateId, sourceRoutes] of selected) {
        const reciprocal = getSelection(candidateId).get(sourceId);
        if (!reciprocal) continue;
        const key = pairKey(sourceId, candidateId);
        const pairRoutes = candidateRoutes.get(key) ?? new Set<DuplicateBlockingRoute>();
        for (const route of sourceRoutes) pairRoutes.add(route);
        for (const route of reciprocal) pairRoutes.add(route);
        candidateRoutes.set(key, pairRoutes);
      }
    }

    const confirmedKeys = new Set(this.#aliases.filter(item => item.confirmed).map(item => pairKey(item.fromId, item.toId)));
    const allCandidatePairs: AuditPair[] = [];
    for (const key of [...candidateRoutes.keys()].sort()) {
      const [leftId, rightId] = key.split('\u0000') as [string, string];
      const features = extractDuplicateFeatures(this.#products.get(leftId)!, this.#products.get(rightId)!, DUPLICATE_LINKAGE_POLICY);
      features.confirmedAlias = confirmedKeys.has(key);
      const decision = classifyDuplicatePair(features, DUPLICATE_LINKAGE_POLICY);
      const pairRoutes = [...candidateRoutes.get(key)!].sort();
      allCandidatePairs.push({ ...decision, pairKey: key, ids: [leftId, rightId], routes: pairRoutes });
      const firstRoute = pairRoutes[0] as DuplicateBlockingRoute | undefined;
      if (firstRoute) routes[firstRoute].contributedPairs += 1;
    }

    const perIdentitySuspects = new Map<string, number>();
    const suspects = allCandidatePairs.filter(pair => pair.conclusion === 'suspected_duplicate')
      .sort((left, right) => right.score - left.score || left.pairKey.localeCompare(right.pairKey))
      .filter(pair => {
        if (pair.ids.some(id => (perIdentitySuspects.get(id) ?? 0) >= this.#options.topSuspectsPerIdentity)) return false;
        for (const id of pair.ids) perIdentitySuspects.set(id, (perIdentitySuspects.get(id) ?? 0) + 1);
        return true;
      })
      .sort((left, right) => left.pairKey.localeCompare(right.pairKey));

    let after = '';
    if (options.cursor) {
      const cursor = decodeCursor(options.cursor);
      if (cursor.snapshotVersion !== this.#snapshotVersion
        || cursor.aliasVersion !== this.#aliasVersion
        || cursor.policyVersion !== DUPLICATE_LINKAGE_POLICY.version) {
        throw new Error('duplicate audit cursor version mismatch');
      }
      after = cursor.lastPairKey;
    }
    const remaining = suspects.filter(pair => pair.pairKey > after);
    const suspectedPairs = remaining.slice(0, this.#options.maxReportedSuspectPairs);
    const nextCursor = remaining.length > suspectedPairs.length && suspectedPairs.length > 0
      ? encodeCursor({
        snapshotVersion: this.#snapshotVersion,
        aliasVersion: this.#aliasVersion,
        policyVersion: DUPLICATE_LINKAGE_POLICY.version,
        lastPairKey: suspectedPairs.at(-1)!.pairKey,
        routePositions: Object.fromEntries(DUPLICATE_BLOCKING_ROUTES.map(route => [route, routes[route].scannedPostings])),
      })
      : null;
    return {
      policyVersion: DUPLICATE_LINKAGE_POLICY.version,
      deterministicGroups: [...this.#groupsByRepresentative.values()]
        .sort((left, right) => left.representativeId.localeCompare(right.representativeId)),
      suspectedPairs,
      allCandidatePairs,
      nextCursor,
      limits: {
        maxPostingsPerFeature: this.#options.maxPostingsPerFeature,
        maxComparedPerIdentity: this.#options.maxComparedPerIdentity,
        topSuspectsPerIdentity: this.#options.topSuspectsPerIdentity,
        maxReportedSuspectPairs: this.#options.maxReportedSuspectPairs,
      },
      stats: {
        comparedPairs: allCandidatePairs.length,
        processedIdentityCount: requestedIds.length,
        identitiesAtCompareLimit,
        routes,
      },
    };
  }

  #candidateRoutesForSource(
    sourceId: string,
    stats: Record<DuplicateBlockingRoute, RouteStats> | undefined,
  ): Map<string, Set<DuplicateBlockingRoute>> {
    const result = new Map<string, Set<DuplicateBlockingRoute>>();
    const terms = this.#blockingTerms.get(sourceId)!;
    for (const route of DUPLICATE_BLOCKING_ROUTES) {
      if (this.#options.disabledRoutes.has(route)) continue;
      if (stats) stats[route].scanLimit += this.#options.maxScannedPerRoutePerIdentity;
      let scanned = 0;
      for (const feature of terms[route]) {
        const full = this.#postings.get(route)!.get(feature) ?? [];
        if (stats && full.length > this.#options.maxPostingsPerFeature) stats[route].truncatedFeatures += 1;
        const bucket = full.slice(0, this.#options.maxPostingsPerFeature);
        if (!bucket.includes(sourceId)) continue;
        for (const candidateId of bucket) {
          if (candidateId === sourceId) continue;
          if (scanned >= this.#options.maxScannedPerRoutePerIdentity) break;
          scanned += 1;
          if (stats) stats[route].scannedPostings += 1;
          if (this.#groupRepresentativeById.get(sourceId) === this.#groupRepresentativeById.get(candidateId)) continue;
          const candidateRoutes = result.get(candidateId) ?? new Set<DuplicateBlockingRoute>();
          candidateRoutes.add(route);
          result.set(candidateId, candidateRoutes);
        }
        if (scanned >= this.#options.maxScannedPerRoutePerIdentity) break;
      }
    }
    return result;
  }

  #addProduct(product: StandardProductIdentity): number {
    return this.#addPreparedProduct(this.#prepareProduct(product));
  }

  #prepareProduct(product: StandardProductIdentity): PreparedProduct {
    return {
      product,
      terms: duplicateBlockingTerms(product, DUPLICATE_LINKAGE_POLICY) as BlockingTerms,
      canonicalKey: product.canonicalKey ?? buildCanonicalStandardKey(product),
    };
  }

  #addPreparedProduct(prepared: PreparedProduct): number {
    const { product, terms, canonicalKey } = prepared;
    if (this.#products.has(product.id)) throw new Error(`duplicate product id ${product.id}`);
    this.#products.set(product.id, product);
    this.#blockingTerms.set(product.id, terms);
    this.#canonicalKeyById.set(product.id, canonicalKey);
    const canonicalMembers = this.#canonicalMembers.get(canonicalKey) ?? new Set<string>();
    canonicalMembers.add(product.id);
    this.#canonicalMembers.set(canonicalKey, canonicalMembers);
    let updated = 0;
    for (const route of DUPLICATE_BLOCKING_ROUTES) for (const feature of terms[route]) {
      const routePostings = this.#postings.get(route)!;
      const posting = routePostings.get(feature) ?? [];
      insertSorted(posting, product.id);
      routePostings.set(feature, posting);
      updated += 1;
    }
    return updated;
  }

  #removeProduct(id: string): number {
    const terms = this.#blockingTerms.get(id)!;
    let updated = 0;
    for (const route of DUPLICATE_BLOCKING_ROUTES) for (const feature of terms[route]) {
      const routePostings = this.#postings.get(route)!;
      const posting = routePostings.get(feature)!;
      removeSorted(posting, id);
      if (posting.length === 0) routePostings.delete(feature);
      updated += 1;
    }
    const canonicalKey = this.#canonicalKeyById.get(id)!;
    const canonicalMembers = this.#canonicalMembers.get(canonicalKey)!;
    canonicalMembers.delete(id);
    if (canonicalMembers.size === 0) this.#canonicalMembers.delete(canonicalKey);
    this.#canonicalKeyById.delete(id);
    this.#blockingTerms.delete(id);
    this.#products.delete(id);
    return updated;
  }

  #addAliasNeighbor(fromId: string, toId: string): void {
    const neighbors = this.#aliasAdjacency.get(fromId) ?? new Set<string>();
    neighbors.add(toId);
    this.#aliasAdjacency.set(fromId, neighbors);
  }

  #neighbors(id: string): Set<string> {
    const result = new Set(this.#aliasAdjacency.get(id) ?? []);
    const canonicalKey = this.#canonicalKeyById.get(id);
    if (canonicalKey) for (const member of this.#canonicalMembers.get(canonicalKey) ?? []) result.add(member);
    result.delete(id);
    return result;
  }

  #component(seed: string, allowed?: ReadonlySet<string>): string[] {
    const pending = [seed];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (visited.has(id) || !this.#products.has(id) || allowed && !allowed.has(id)) continue;
      visited.add(id);
      for (const neighbor of this.#neighbors(id)) if (!visited.has(neighbor)) pending.push(neighbor);
    }
    return [...visited].sort((left, right) => left.localeCompare(right));
  }

  #storeGroup(members: readonly string[]): void {
    if (members.length === 0) return;
    const representativeId = members[0]!;
    const group = {
      representativeId,
      members: [...members],
      edges: members.slice(1).map(toId => ({ fromId: representativeId, toId })),
    };
    this.#groupsByRepresentative.set(representativeId, group);
    for (const id of members) this.#groupRepresentativeById.set(id, representativeId);
  }

  #rebuildAllGroups(): void {
    this.#groupRepresentativeById.clear();
    this.#groupsByRepresentative.clear();
    for (const id of [...this.#products.keys()].sort((left, right) => left.localeCompare(right))) {
      if (!this.#groupRepresentativeById.has(id)) this.#storeGroup(this.#component(id));
    }
  }

  #refreshAffectedGroups(seeds: Set<string>): void {
    const affected = new Set<string>();
    const pending = [...seeds];
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (affected.has(id)) continue;
      affected.add(id);
      const representative = this.#groupRepresentativeById.get(id);
      if (representative) for (const member of this.#groupsByRepresentative.get(representative)!.members) {
        if (!affected.has(member)) pending.push(member);
      }
      if (this.#products.has(id)) for (const neighbor of this.#neighbors(id)) {
        if (!affected.has(neighbor)) pending.push(neighbor);
      }
    }
    const staleRepresentatives = new Set(
      [...affected]
        .map(id => this.#groupRepresentativeById.get(id))
        .filter((id): id is string => id !== undefined),
    );
    for (const representative of staleRepresentatives) this.#groupsByRepresentative.delete(representative);
    for (const id of affected) this.#groupRepresentativeById.delete(id);
    for (const id of [...affected].sort((left, right) => left.localeCompare(right))) {
      if (this.#products.has(id) && !this.#groupRepresentativeById.has(id)) this.#storeGroup(this.#component(id, affected));
    }
  }
}

export function auditStandardProductDuplicates(
  products: readonly StandardProductIdentity[],
  aliases: readonly ConfirmedAliasEdge[],
  options: DuplicateAuditOptions,
): DuplicateAuditResult {
  const index = VersionedDuplicateAuditIndex.build({
    snapshotVersion: options.snapshotVersion,
    aliasVersion: options.aliasVersion,
    products,
    aliases,
  }, options);
  return index.audit({ cursor: options.cursor, changedIds: options.changedIds });
}
