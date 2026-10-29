import { buildCanonicalStandardKey } from './canonical-key.js';
import {
  BoundedCandidateIndex,
  type CandidateDocument,
  type CandidateIndexOptions,
  type CandidateSearchQuery,
  candidateDocumentText,
  searchCandidateSource,
  type CandidateSearchResult,
} from './candidate-index.js';
import { compactSearchText, extractCharacterNgrams, extractTokenTerms } from './text-features.js';

export interface CatalogIndexSnapshot {
  readonly version: bigint | number;
  readonly aliasPolicyVersion: string;
  readonly documents: readonly CandidateDocument[];
}

export interface CatalogIndexChange {
  readonly version: bigint | number;
  readonly standardProductId: string;
  readonly operation: 'upsert' | 'delete' | 'isolate';
  readonly document?: CandidateDocument;
}

export type CandidateIndexCompactionReason =
  | 'version_gap'
  | 'version_out_of_order'
  | 'alias_policy_version_changed'
  | 'truncated_feature_touched'
  | 'index_budget_truncated'
  | 'delta_document_threshold'
  | 'delta_bytes_threshold';

export interface CandidateIndexCompactionState {
  readonly required: boolean;
  readonly blocksReady: boolean;
  readonly reasons: readonly CandidateIndexCompactionReason[];
}

export interface CandidateIndexApplyResult {
  readonly version: bigint;
  readonly requestedVersion: bigint;
  readonly targetVersionReady: boolean;
  readonly processedChangeCount: number;
  readonly rebuiltDocumentCount: number;
  readonly baseDocumentCount: number;
  readonly deltaDocumentCount: number;
  readonly tombstoneCount: number;
  readonly deltaBytes: number;
  readonly compaction: CandidateIndexCompactionState;
}

interface ResolvedCandidateIndexOptions {
  readonly maxPostingsPerFeature: number;
  readonly maxScanned: number;
  readonly maxCompared: number;
  readonly topK: number;
  readonly maxIndexBytes: number;
}

interface PreparedDocument {
  readonly document: CandidateDocument;
  readonly canonicalKey: string;
  readonly aliases: readonly string[];
  readonly tokenTerms: ReadonlyMap<string, number>;
  readonly ngrams: ReadonlySet<string>;
  readonly length: number;
}

interface PostingIndex {
  readonly postings: ReadonlyMap<string, readonly string[]>;
  readonly truncatedFeatures: ReadonlySet<string>;
}

interface AliasTrieNode {
  readonly children: Map<string, AliasTrieNode>;
  documentId?: string;
}

interface IndexSegment {
  readonly documents: ReadonlyMap<string, PreparedDocument>;
  readonly canonical: ReadonlyMap<string, string>;
  readonly aliasRoot: AliasTrieNode;
  readonly maxAliasLength: number;
  readonly tokens: PostingIndex;
  readonly ngrams: PostingIndex;
  readonly indexBytes: number;
  readonly indexedCanonicalKeys: number;
  readonly indexedAliases: number;
  readonly budgetTruncated: boolean;
}

const DEFAULTS: ResolvedCandidateIndexOptions = {
  maxPostingsPerFeature: 256,
  maxScanned: 2_000,
  maxCompared: 400,
  topK: 20,
  maxIndexBytes: 64 * 1024 * 1024,
};

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new RangeError(`${name} must be a positive integer`);
  return resolved;
}

function resolveOptions(options: CandidateIndexOptions): ResolvedCandidateIndexOptions {
  return {
    maxPostingsPerFeature: positiveInteger(options.maxPostingsPerFeature, DEFAULTS.maxPostingsPerFeature, 'maxPostingsPerFeature'),
    maxScanned: positiveInteger(options.maxScanned, DEFAULTS.maxScanned, 'maxScanned'),
    maxCompared: positiveInteger(options.maxCompared, DEFAULTS.maxCompared, 'maxCompared'),
    topK: positiveInteger(options.topK, DEFAULTS.topK, 'topK'),
    maxIndexBytes: positiveInteger(options.maxIndexBytes, DEFAULTS.maxIndexBytes, 'maxIndexBytes'),
  };
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function asVersion(value: bigint | number): bigint {
  if (typeof value === 'bigint') return value;
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('catalog index version must be a non-negative safe integer');
  return BigInt(value);
}

function approximateEntryBytes(feature: string, isNew: boolean): number {
  return (isNew ? Buffer.byteLength(feature, 'utf8') + 32 : 0) + 8;
}

function approximateFeatureBytes(feature: string): number {
  return Buffer.byteLength(feature, 'utf8') + 40;
}

function prepareDocument(document: CandidateDocument): PreparedDocument {
  if (!document.id) throw new Error('candidate document id is required');
  const aliases = [...new Set(document.aliases.map(compactSearchText).filter(Boolean))];
  const tokenTerms = extractTokenTerms(candidateDocumentText(document));
  const ngrams = extractCharacterNgrams(candidateDocumentText(document));
  return {
    document,
    canonicalKey: buildCanonicalStandardKey(document),
    aliases,
    tokenTerms,
    ngrams,
    length: Math.max(1, [...tokenTerms.values()].reduce((sum, value) => sum + value, 0)),
  };
}

function samePreparedDocument(left: PreparedDocument, right: PreparedDocument): boolean {
  return left.canonicalKey === right.canonicalKey
    && left.document.family === right.document.family
    && left.document.product === right.document.product
    && left.document.tier === right.document.tier
    && left.document.displayName === right.document.displayName
    && left.aliases.length === right.aliases.length
    && left.aliases.every((alias, index) => alias === right.aliases[index]);
}

function buildSegment(
  preparedDocuments: readonly PreparedDocument[],
  options: ResolvedCandidateIndexOptions,
  maxIndexBytes = options.maxIndexBytes,
): IndexSegment {
  const ordered = [...preparedDocuments].sort((left, right) => compareIds(left.document.id, right.document.id));
  const documents = new Map(ordered.map(document => [document.document.id, document]));
  const canonical = new Map<string, string>();
  const aliasRoot: AliasTrieNode = { children: new Map() };
  const tokenPostings = new Map<string, string[]>();
  const ngramPostings = new Map<string, string[]>();
  const truncatedTokens = new Set<string>();
  const truncatedNgrams = new Set<string>();
  let indexBytes = 0;
  let budgetTruncated = false;
  let maxAliasLength = 0;
  let indexedAliases = 0;
  const reserve = (bytes: number): boolean => {
    if (indexBytes + bytes > maxIndexBytes) {
      budgetTruncated = true;
      return false;
    }
    indexBytes += bytes;
    return true;
  };

  for (const prepared of ordered) {
    if (reserve(Buffer.byteLength(prepared.canonicalKey, 'utf8') + 48)) canonical.set(prepared.canonicalKey, prepared.document.id);
  }
  for (const prepared of ordered) {
    for (const alias of prepared.aliases) {
      const characters = [...alias];
      if (characters.length < 4) continue;
      let node = aliasRoot;
      let firstMissing = characters.length;
      for (let index = 0; index < characters.length; index++) {
        const child = node.children.get(characters[index]!);
        if (!child) {
          firstMissing = index;
          break;
        }
        node = child;
      }
      const bytes = 8 + characters.slice(firstMissing)
        .reduce((total, character) => total + Buffer.byteLength(character, 'utf8') + 48, 0);
      if (!reserve(bytes)) continue;
      node = aliasRoot;
      for (const character of characters) {
        let child = node.children.get(character);
        if (!child) {
          child = { children: new Map() };
          node.children.set(character, child);
        }
        node = child;
      }
      node.documentId = prepared.document.id;
      maxAliasLength = Math.max(maxAliasLength, characters.length);
      indexedAliases++;
    }
  }

  const retainedTokens = new Set<string>();
  const retainedNgrams = new Set<string>();
  for (const prepared of ordered) {
    const bytes = 24 + [...prepared.tokenTerms.keys()].reduce((total, feature) => total + approximateFeatureBytes(feature) + 8, 0);
    if (reserve(bytes)) retainedTokens.add(prepared.document.id);
  }
  for (const prepared of ordered) {
    const bytes = 24 + [...prepared.ngrams].reduce((total, feature) => total + approximateFeatureBytes(feature), 0);
    if (reserve(bytes)) retainedNgrams.add(prepared.document.id);
  }
  const addPosting = (postings: Map<string, string[]>, truncated: Set<string>, feature: string, documentId: string) => {
    const values = postings.get(feature);
    if (values && values.length >= options.maxPostingsPerFeature) {
      truncated.add(feature);
      return;
    }
    if (!reserve(approximateEntryBytes(feature, !values))) return;
    if (values) values.push(documentId);
    else postings.set(feature, [documentId]);
  };
  for (const prepared of ordered) {
    if (!retainedTokens.has(prepared.document.id)) continue;
    for (const feature of prepared.tokenTerms.keys()) addPosting(tokenPostings, truncatedTokens, feature, prepared.document.id);
  }
  for (const prepared of ordered) {
    if (!retainedNgrams.has(prepared.document.id)) continue;
    for (const feature of prepared.ngrams) addPosting(ngramPostings, truncatedNgrams, feature, prepared.document.id);
  }

  if (retainedTokens.size !== ordered.length || retainedNgrams.size !== ordered.length) budgetTruncated = true;
  return {
    documents,
    canonical,
    aliasRoot,
    maxAliasLength,
    tokens: { postings: tokenPostings, truncatedFeatures: truncatedTokens },
    ngrams: { postings: ngramPostings, truncatedFeatures: truncatedNgrams },
    indexBytes,
    indexedCanonicalKeys: canonical.size,
    indexedAliases,
    budgetTruncated,
  };
}

function findAliases(segment: IndexSegment, query: string): Set<string> {
  const matches = new Set<string>();
  const characters = [...query];
  for (let start = 0; start < characters.length; start++) {
    let node = segment.aliasRoot;
    const end = Math.min(characters.length, start + segment.maxAliasLength);
    for (let index = start; index < end; index++) {
      const child = node.children.get(characters[index]!);
      if (!child) break;
      node = child;
      if (node.documentId !== undefined) matches.add(node.documentId);
    }
  }
  return matches;
}

class IndexAccounting {
  readonly #maxPostingsPerFeature: number;
  readonly #tokenCounts = new Map<string, number>();
  readonly #ngramCounts = new Map<string, number>();
  readonly #aliasPrefixCounts = new Map<string, number>();
  #bytes = 0;
  #documentCount = 0;
  #aliasCount = 0;
  #totalLength = 0;

  constructor(documents: Iterable<PreparedDocument>, maxPostingsPerFeature: number) {
    this.#maxPostingsPerFeature = maxPostingsPerFeature;
    for (const document of documents) this.add(document);
  }

  get bytes(): number { return this.#bytes; }
  get documentCount(): number { return this.#documentCount; }
  get aliasCount(): number { return this.#aliasCount; }
  get averageLength(): number { return this.#documentCount ? this.#totalLength / this.#documentCount : 1; }

  documentFrequency(feature: string): number {
    return Math.min(this.#tokenCounts.get(feature) ?? 0, this.#maxPostingsPerFeature);
  }

  add(document: PreparedDocument): void {
    this.#documentCount++;
    this.#totalLength += document.length;
    this.#bytes += Buffer.byteLength(document.canonicalKey, 'utf8') + 48;
    this.#bytes += 24 + [...document.tokenTerms.keys()].reduce((total, feature) => total + approximateFeatureBytes(feature) + 8, 0);
    this.#bytes += 24 + [...document.ngrams].reduce((total, feature) => total + approximateFeatureBytes(feature), 0);
    for (const alias of document.aliases) this.#addAlias(alias);
    for (const feature of document.tokenTerms.keys()) this.#addPosting(this.#tokenCounts, feature);
    for (const feature of document.ngrams) this.#addPosting(this.#ngramCounts, feature);
  }

  remove(document: PreparedDocument): void {
    this.#documentCount--;
    this.#totalLength -= document.length;
    this.#bytes -= Buffer.byteLength(document.canonicalKey, 'utf8') + 48;
    this.#bytes -= 24 + [...document.tokenTerms.keys()].reduce((total, feature) => total + approximateFeatureBytes(feature) + 8, 0);
    this.#bytes -= 24 + [...document.ngrams].reduce((total, feature) => total + approximateFeatureBytes(feature), 0);
    for (const alias of document.aliases) this.#removeAlias(alias);
    for (const feature of document.tokenTerms.keys()) this.#removePosting(this.#tokenCounts, feature);
    for (const feature of document.ngrams) this.#removePosting(this.#ngramCounts, feature);
  }

  #addAlias(alias: string): void {
    const characters = [...alias];
    if (characters.length < 4) return;
    this.#aliasCount++;
    this.#bytes += 8;
    let prefix = '';
    for (const character of characters) {
      prefix += character;
      const count = this.#aliasPrefixCounts.get(prefix) ?? 0;
      if (count === 0) this.#bytes += Buffer.byteLength(character, 'utf8') + 48;
      this.#aliasPrefixCounts.set(prefix, count + 1);
    }
  }

  #removeAlias(alias: string): void {
    const characters = [...alias];
    if (characters.length < 4) return;
    this.#aliasCount--;
    this.#bytes -= 8;
    let prefix = '';
    for (const character of characters) {
      prefix += character;
      const count = this.#aliasPrefixCounts.get(prefix);
      if (!count) throw new Error(`missing alias prefix accounting: ${prefix}`);
      if (count === 1) {
        this.#aliasPrefixCounts.delete(prefix);
        this.#bytes -= Buffer.byteLength(character, 'utf8') + 48;
      } else this.#aliasPrefixCounts.set(prefix, count - 1);
    }
  }

  #addPosting(counts: Map<string, number>, feature: string): void {
    const count = counts.get(feature) ?? 0;
    if (count === 0) this.#bytes += approximateEntryBytes(feature, true);
    else if (count < this.#maxPostingsPerFeature) this.#bytes += 8;
    counts.set(feature, count + 1);
  }

  #removePosting(counts: Map<string, number>, feature: string): void {
    const count = counts.get(feature);
    if (!count) throw new Error(`missing posting accounting: ${feature}`);
    if (count === 1) {
      counts.delete(feature);
      this.#bytes -= approximateEntryBytes(feature, true);
    } else {
      counts.set(feature, count - 1);
      if (count <= this.#maxPostingsPerFeature) this.#bytes -= 8;
    }
  }
}

export class VersionedCandidateIndex {
  readonly #options: ResolvedCandidateIndexOptions;
  readonly #baseVersion: bigint;
  readonly #aliasPolicyVersion: string;
  readonly #baseDocuments: ReadonlyMap<string, PreparedDocument>;
  readonly #baseSegment: IndexSegment;
  readonly #baseIndex: BoundedCandidateIndex;
  readonly #activeDocuments: Map<string, PreparedDocument>;
  readonly #canonicalOwners = new Map<string, string>();
  readonly #aliasOwners = new Map<string, string>();
  readonly #overrides = new Map<string, PreparedDocument>();
  readonly #hiddenBaseIds = new Set<string>();
  readonly #tombstones = new Set<string>();
  readonly #accounting: IndexAccounting;
  #deltaSegment: IndexSegment;
  #version: bigint;
  #compaction: CandidateIndexCompactionState = { required: false, blocksReady: false, reasons: [] };

  static build(snapshot: CatalogIndexSnapshot, options: CandidateIndexOptions = {}): VersionedCandidateIndex {
    return new VersionedCandidateIndex(snapshot, resolveOptions(options));
  }

  private constructor(snapshot: CatalogIndexSnapshot, options: ResolvedCandidateIndexOptions) {
    this.#options = options;
    this.#version = asVersion(snapshot.version);
    this.#baseVersion = this.#version;
    this.#aliasPolicyVersion = snapshot.aliasPolicyVersion;
    const prepared = snapshot.documents.map(prepareDocument).sort((left, right) => compareIds(left.document.id, right.document.id));
    this.#validatePreparedCatalog(prepared);
    this.#baseDocuments = new Map(prepared.map(document => [document.document.id, document]));
    this.#activeDocuments = new Map(this.#baseDocuments);
    for (const document of prepared) this.#addOwners(document);
    this.#baseSegment = buildSegment(prepared, options);
    this.#baseIndex = new BoundedCandidateIndex(snapshot.documents, options);
    this.#deltaSegment = buildSegment([], options, Number.MAX_SAFE_INTEGER);
    this.#accounting = new IndexAccounting(prepared, options.maxPostingsPerFeature);
  }

  get version(): bigint { return this.#version; }

  getDocument(id: string): CandidateDocument | undefined {
    return this.#activeDocuments.get(id)?.document;
  }

  needsCompaction(): CandidateIndexCompactionState {
    return this.#compaction;
  }

  applyChanges(
    changes: readonly CatalogIndexChange[],
    targetVersion: bigint | number,
    options: { readonly aliasPolicyVersion?: string } = {},
  ): CandidateIndexApplyResult {
    const requestedVersion = asVersion(targetVersion);
    const blockingReason = this.#validateChangeSequence(changes, requestedVersion, options.aliasPolicyVersion);
    if (blockingReason) return this.#blockedApplyResult(requestedVersion, changes.length, blockingReason);

    const finalById = new Map<string, PreparedDocument | undefined>();
    for (const change of changes) {
      if (!change.standardProductId) throw new Error('catalog index change standardProductId is required');
      if (change.operation === 'upsert') {
        if (!change.document) throw new Error(`upsert change ${change.standardProductId} is missing its document`);
        if (change.document.id !== change.standardProductId) throw new Error(`catalog index change id mismatch: ${change.standardProductId}`);
        finalById.set(change.standardProductId, prepareDocument(change.document));
      } else {
        if (change.document !== undefined) throw new Error(`${change.operation} change ${change.standardProductId} must not include a document`);
        finalById.set(change.standardProductId, undefined);
      }
    }

    const touchedIds = new Set(finalById.keys());
    const finalDocuments = [...finalById.values()].filter((document): document is PreparedDocument => document !== undefined);
    this.#validateReplacementOwners(touchedIds, finalDocuments);
    if (this.#baseSegment.budgetTruncated) {
      return this.#blockedApplyResult(requestedVersion, changes.length, 'index_budget_truncated');
    }
    if (this.#touchesTruncatedBaseFeature(touchedIds, finalDocuments)) {
      return this.#blockedApplyResult(requestedVersion, changes.length, 'truncated_feature_touched');
    }

    const removedDocuments = [...touchedIds].flatMap(id => {
      const document = this.#activeDocuments.get(id);
      return document ? [document] : [];
    });
    for (const document of removedDocuments) this.#accounting.remove(document);
    for (const document of finalDocuments) this.#accounting.add(document);
    if (this.#accounting.bytes > this.#options.maxIndexBytes) {
      for (const document of finalDocuments) this.#accounting.remove(document);
      for (const document of removedDocuments) this.#accounting.add(document);
      return this.#blockedApplyResult(requestedVersion, changes.length, 'index_budget_truncated');
    }

    for (const document of removedDocuments) this.#removeOwners(document);
    for (const id of touchedIds) this.#activeDocuments.delete(id);
    for (const document of finalDocuments) {
      this.#activeDocuments.set(document.document.id, document);
      this.#addOwners(document);
    }
    for (const id of touchedIds) {
      const base = this.#baseDocuments.get(id);
      const current = this.#activeDocuments.get(id);
      if (!current) {
        this.#overrides.delete(id);
        if (base) {
          this.#hiddenBaseIds.add(id);
          this.#tombstones.add(id);
        } else this.#tombstones.delete(id);
      } else if (base && samePreparedDocument(base, current)) {
        this.#overrides.delete(id);
        this.#hiddenBaseIds.delete(id);
        this.#tombstones.delete(id);
      } else {
        this.#overrides.set(id, current);
        if (base) this.#hiddenBaseIds.add(id);
        this.#tombstones.delete(id);
      }
    }
    this.#deltaSegment = buildSegment([...this.#overrides.values()], this.#options, Number.MAX_SAFE_INTEGER);
    this.#version = requestedVersion;
    this.#compaction = this.#thresholdCompaction();
    return this.#applyResult(requestedVersion, changes.length, true);
  }

  search(query: CandidateSearchQuery): CandidateSearchResult {
    if (this.#version === this.#baseVersion && this.#overrides.size === 0 && this.#tombstones.size === 0) {
      return this.#baseIndex.search(query);
    }
    return searchCandidateSource<string>(query, {
      document: id => this.#activeDocuments.get(id)!,
      canonical: key => {
        const baseId = this.#baseSegment.canonical.get(key);
        const deltaId = this.#deltaSegment.canonical.get(key);
        return [...new Set([deltaId, baseId && !this.#hiddenBaseIds.has(baseId) ? baseId : undefined]
          .filter((id): id is string => id !== undefined))];
      },
      aliases: text => new Set([
        ...findAliases(this.#deltaSegment, text),
        ...[...findAliases(this.#baseSegment, text)].filter(id => !this.#hiddenBaseIds.has(id)),
      ]),
      postings: (index, feature) => this.#mergedPostings(index, feature),
      documentFrequency: feature => this.#accounting.documentFrequency(feature),
      documentCount: this.#accounting.documentCount,
      averageLength: this.#accounting.averageLength,
      indexBytes: this.#accounting.bytes,
      indexedCanonicalKeys: this.#accounting.documentCount,
      indexedAliases: this.#accounting.aliasCount,
    }, this.#options);
  }

  #mergedPostings(index: 'tokens' | 'ngrams', feature: string): { readonly ids: readonly string[]; readonly truncated: boolean } {
    const base = this.#baseSegment[index];
    const delta = this.#deltaSegment[index];
    const values = [
      ...(base.postings.get(feature) ?? []).filter(id => !this.#hiddenBaseIds.has(id)),
      ...(delta.postings.get(feature) ?? []),
    ].sort(compareIds);
    const deduplicated = values.filter((id, position) => position === 0 || id !== values[position - 1]);
    return {
      ids: deduplicated.slice(0, this.#options.maxPostingsPerFeature),
      truncated: base.truncatedFeatures.has(feature)
        || delta.truncatedFeatures.has(feature)
        || deduplicated.length > this.#options.maxPostingsPerFeature,
    };
  }

  #validatePreparedCatalog(documents: readonly PreparedDocument[]): void {
    const ids = new Set<string>();
    const canonical = new Map<string, string>();
    const aliases = new Map<string, string>();
    for (const document of documents) {
      if (ids.has(document.document.id)) throw new Error(`duplicate candidate document id: ${document.document.id}`);
      ids.add(document.document.id);
      const canonicalOwner = canonical.get(document.canonicalKey);
      if (canonicalOwner) throw new Error(`duplicate canonical catalog identity: ${document.canonicalKey}`);
      canonical.set(document.canonicalKey, document.document.id);
      for (const alias of document.aliases) {
        const aliasOwner = aliases.get(alias);
        if (aliasOwner && aliasOwner !== document.document.id) throw new Error(`ambiguous confirmed alias: ${alias}`);
        aliases.set(alias, document.document.id);
      }
    }
  }

  #validateReplacementOwners(touchedIds: ReadonlySet<string>, documents: readonly PreparedDocument[]): void {
    const canonical = new Map<string, string>();
    const aliases = new Map<string, string>();
    for (const document of documents) {
      const existingCanonical = canonical.get(document.canonicalKey) ?? this.#canonicalOwners.get(document.canonicalKey);
      if (existingCanonical && existingCanonical !== document.document.id && !touchedIds.has(existingCanonical)) {
        throw new Error(`duplicate canonical catalog identity: ${document.canonicalKey}`);
      }
      const replacementCanonical = canonical.get(document.canonicalKey);
      if (replacementCanonical && replacementCanonical !== document.document.id) {
        throw new Error(`duplicate canonical catalog identity: ${document.canonicalKey}`);
      }
      canonical.set(document.canonicalKey, document.document.id);
      for (const alias of document.aliases) {
        const existingAlias = aliases.get(alias) ?? this.#aliasOwners.get(alias);
        if (existingAlias && existingAlias !== document.document.id && !touchedIds.has(existingAlias)) {
          throw new Error(`ambiguous confirmed alias: ${alias}`);
        }
        const replacementAlias = aliases.get(alias);
        if (replacementAlias && replacementAlias !== document.document.id) throw new Error(`ambiguous confirmed alias: ${alias}`);
        aliases.set(alias, document.document.id);
      }
    }
  }

  #addOwners(document: PreparedDocument): void {
    this.#canonicalOwners.set(document.canonicalKey, document.document.id);
    for (const alias of document.aliases) this.#aliasOwners.set(alias, document.document.id);
  }

  #removeOwners(document: PreparedDocument): void {
    if (this.#canonicalOwners.get(document.canonicalKey) === document.document.id) this.#canonicalOwners.delete(document.canonicalKey);
    for (const alias of document.aliases) if (this.#aliasOwners.get(alias) === document.document.id) this.#aliasOwners.delete(alias);
  }

  #validateChangeSequence(
    changes: readonly CatalogIndexChange[],
    targetVersion: bigint,
    aliasPolicyVersion: string | undefined,
  ): CandidateIndexCompactionReason | undefined {
    if (aliasPolicyVersion !== undefined && aliasPolicyVersion !== this.#aliasPolicyVersion) return 'alias_policy_version_changed';
    const versions = changes.map(change => asVersion(change.version));
    for (let index = 1; index < versions.length; index++) {
      if (versions[index]! < versions[index - 1]!) return 'version_out_of_order';
    }
    const uniqueVersions = versions.filter((version, index) => index === 0 || version !== versions[index - 1]);
    if (targetVersion === this.#version && uniqueVersions.length === 0) return undefined;
    if (uniqueVersions.length === 0 || uniqueVersions[0] !== this.#version + 1n || uniqueVersions.at(-1) !== targetVersion) return 'version_gap';
    for (let index = 1; index < uniqueVersions.length; index++) {
      if (uniqueVersions[index] !== uniqueVersions[index - 1]! + 1n) return 'version_gap';
    }
    return undefined;
  }

  #touchesTruncatedBaseFeature(touchedIds: ReadonlySet<string>, finalDocuments: readonly PreparedDocument[]): boolean {
    const finalById = new Map(finalDocuments.map(document => [document.document.id, document]));
    for (const id of touchedIds) {
      const current = this.#activeDocuments.get(id);
      const final = finalById.get(id);
      for (const feature of current?.tokenTerms.keys() ?? []) {
        if (!final?.tokenTerms.has(feature) && this.#baseSegment.tokens.truncatedFeatures.has(feature)) return true;
      }
      for (const feature of final?.tokenTerms.keys() ?? []) {
        if (!current?.tokenTerms.has(feature) && this.#baseSegment.tokens.truncatedFeatures.has(feature)) return true;
      }
      for (const feature of current?.ngrams ?? []) {
        if (!final?.ngrams.has(feature) && this.#baseSegment.ngrams.truncatedFeatures.has(feature)) return true;
      }
      for (const feature of final?.ngrams ?? []) {
        if (!current?.ngrams.has(feature) && this.#baseSegment.ngrams.truncatedFeatures.has(feature)) return true;
      }
    }
    return false;
  }

  #thresholdCompaction(): CandidateIndexCompactionState {
    const reasons: CandidateIndexCompactionReason[] = [];
    const threshold = Math.min(1_000, Math.ceil(this.#accounting.documentCount * 0.05));
    if (this.#overrides.size > threshold) reasons.push('delta_document_threshold');
    if (this.#deltaSegment.indexBytes > this.#options.maxIndexBytes * 0.2) reasons.push('delta_bytes_threshold');
    return { required: reasons.length > 0, blocksReady: false, reasons };
  }

  #blockedApplyResult(
    requestedVersion: bigint,
    processedChangeCount: number,
    reason: CandidateIndexCompactionReason,
  ): CandidateIndexApplyResult {
    this.#compaction = { required: true, blocksReady: true, reasons: [reason] };
    return this.#applyResult(requestedVersion, processedChangeCount, false);
  }

  #applyResult(requestedVersion: bigint, processedChangeCount: number, targetVersionReady: boolean): CandidateIndexApplyResult {
    return {
      version: this.#version,
      requestedVersion,
      targetVersionReady,
      processedChangeCount,
      rebuiltDocumentCount: this.#overrides.size,
      baseDocumentCount: this.#baseDocuments.size,
      deltaDocumentCount: this.#overrides.size,
      tombstoneCount: this.#tombstones.size,
      deltaBytes: this.#deltaSegment.indexBytes,
      compaction: this.#compaction,
    };
  }
}
