import { buildCanonicalStandardKey } from './canonical-key.js';
import { compactSearchText, extractCharacterNgrams, extractTokenTerms } from './text-features.js';

export interface CandidateDocument {
  readonly id: string;
  readonly family: string;
  readonly product: string;
  readonly tier: string;
  readonly displayName?: string;
  readonly aliases: readonly string[];
}

export interface CandidateSearchQuery {
  readonly text: string;
  readonly primaryText?: string;
  readonly canonicalKey?: string;
  /** Omitted means an explicit catalog key, not a heuristic inferred from prose. */
  readonly canonicalKeyConfidence?: 'heuristic' | 'confirmed';
}

export interface CandidateIndexOptions {
  readonly maxPostingsPerFeature?: number;
  readonly maxScanned?: number;
  readonly maxCompared?: number;
  readonly topK?: number;
  readonly maxIndexBytes?: number;
}

export type CandidateRoute = 'canonical' | 'alias' | 'token' | 'ngram';

export interface CandidateMatch extends CandidateDocument {
  readonly score: number;
  readonly routes: readonly CandidateRoute[];
}

export interface CandidateSearchResult {
  readonly candidates: readonly CandidateMatch[];
  readonly stats: {
    readonly scanned: number;
    readonly compared: number;
    readonly truncated: boolean;
    readonly indexBytes: number;
    readonly indexedCanonicalKeys: number;
    readonly indexedAliases: number;
  };
}

export interface IndexedCandidateDocument {
  readonly document: CandidateDocument;
  readonly aliases: readonly string[];
  readonly tokenTerms: ReadonlyMap<string, number> | undefined;
  readonly ngrams: ReadonlySet<string> | undefined;
  readonly length: number;
}

/** Both immutable and incremental indexes share one retrieval/ranking contract. */
export interface CandidateRetrievalSource<Key> {
  readonly document: (key: Key) => IndexedCandidateDocument;
  readonly canonical: (key: string) => readonly Key[];
  readonly aliases: (text: string) => Iterable<Key>;
  readonly postings: (index: 'tokens' | 'ngrams', feature: string) => { ids: readonly Key[]; truncated: boolean };
  readonly documentFrequency: (feature: string) => number;
  readonly documentCount: number;
  readonly averageLength: number;
  readonly indexBytes: number;
  readonly indexedCanonicalKeys: number;
  readonly indexedAliases: number;
  readonly budgetTruncated?: boolean;
}

const GENERIC_TERMS = new Set(['a', 'an', 'the', 'of', 'for', 'and', 'with', 'account', 'accounts', 'service', 'services', 'subscription', 'standard', 'basic',
  'premium', 'plus', 'pro', 'free', 'team', 'api', 'software', 'common', 'product', 'monthly', 'annual',
  'month', 'months', 'year', 'years', 'one', 'shared', 'private', 'plan', '邮箱账号', '账号', '服务', '会员']);

function reliableTextMatch(text: string, indexed: IndexedCandidateDocument): boolean {
  const terms = [...extractTokenTerms(text).keys()].filter(term => !GENERIC_TERMS.has(term));
  for (const term of terms) if (indexed.tokenTerms?.has(term)) return true;
  // Ngrams retrieve spellings and Han phrases, but a shared two-letter fragment
  // (or generic plan word) is not enough to make a catalog identity relevant.
  const names = [indexed.document.family, indexed.document.product, indexed.document.displayName ?? '', ...indexed.document.aliases];
  for (const name of names) {
    const nameTerms = [...extractTokenTerms(name).keys()].filter(term => term.length >= 2 && !GENERIC_TERMS.has(term));
    for (const term of terms) for (const candidate of nameTerms) {
      const han = /\p{Script=Han}/u.test(term) && /\p{Script=Han}/u.test(candidate);
      if (Math.min(term.length, candidate.length) >= (han ? 2 : 4) && (term.includes(candidate) || candidate.includes(term))) return true;
      if (!han) continue;
      const left = extractCharacterNgrams(term);
      const right = extractCharacterNgrams(candidate);
      const sharedTrigrams = [...left].filter(gram => gram.length === 3 && right.has(gram)).length;
      if (sharedTrigrams >= 2) return true;
    }
  }
  return false;
}

export function searchCandidateSource<Key>(
  query: CandidateSearchQuery,
  source: CandidateRetrievalSource<Key>,
  limits: { maxScanned: number; maxCompared: number; topK: number },
): CandidateSearchResult {
  const primaryText = query.primaryText ?? query.text;
  const primaryTokens = extractTokenTerms(primaryText);
  const primaryNgrams = extractCharacterNgrams(primaryText);
  const queryTokens = extractTokenTerms(query.text);
  const queryNgrams = extractCharacterNgrams(query.text);
  const routes = new Map<Key, Set<CandidateRoute>>();
  const primaryAliases = new Set(source.aliases(compactSearchText(primaryText)));
  let scanned = 0;
  let truncated = source.budgetTruncated ?? false;
  const add = (key: Key, route: CandidateRoute) => {
    const documentRoutes = routes.get(key) ?? new Set<CandidateRoute>();
    documentRoutes.add(route);
    routes.set(key, documentRoutes);
  };
  if (query.canonicalKey) for (const key of source.canonical(query.canonicalKey)) add(key, 'canonical');
  for (const key of source.aliases(compactSearchText(query.text))) add(key, 'alias');
  for (const key of primaryAliases) add(key, 'alias');

  const visited = { tokens: new Set<string>(), ngrams: new Set<string>() };
  const scan = (index: 'tokens' | 'ngrams', features: Iterable<string>, route: CandidateRoute) => {
    const ordered = [...features].filter(feature => !visited[index].has(feature)).sort((left, right) => {
      // Do not materialize postings merely to sort query features: incremental
      // postings are merged lazily, within the actual scan budget.
      const rarity = index === 'tokens' ? source.documentFrequency(left) - source.documentFrequency(right) : 0;
      return rarity || right.length - left.length || compareIds(left, right);
    });
    for (const feature of ordered) {
      if (scanned >= limits.maxScanned) { truncated = true; return; }
      visited[index].add(feature);
      const postings = source.postings(index, feature);
      if (postings.truncated) truncated = true;
      for (const key of postings.ids) {
        if (scanned >= limits.maxScanned) { truncated = true; return; }
        scanned++;
        add(key, route);
      }
    }
  };
  // Reserve the front of the same finite scan budget for what is being sold.
  scan('tokens', primaryTokens.keys(), 'token');
  scan('ngrams', primaryNgrams, 'ngram');
  scan('tokens', queryTokens.keys(), 'token');
  scan('ngrams', queryNgrams, 'ngram');

  const priority = new Map<Key, number>();
  const primaryCoverage = new Map<Key, number>();
  const relevant: Key[] = [];
  for (const [key, documentRoutes] of routes) {
    const indexed = source.document(key);
    const primaryMatch = reliableTextMatch(primaryText, indexed);
    if (!documentRoutes.has('canonical') && !documentRoutes.has('alias') && !primaryMatch && !reliableTextMatch(query.text, indexed)) continue;
    priority.set(key, documentRoutes.has('canonical') && query.canonicalKeyConfidence !== 'heuristic' ? 5
      : primaryAliases.has(key) ? 4 : primaryMatch ? 3 : documentRoutes.has('canonical') ? 2 : documentRoutes.has('alias') ? 1 : 0);
    primaryCoverage.set(key, [...primaryTokens.keys()].reduce((sum, term) =>
      sum + (indexed.tokenTerms?.has(term) ? 1 : 0), 0));
    relevant.push(key);
  }
  relevant.sort((left, right) => priority.get(right)! - priority.get(left)!
    || primaryCoverage.get(right)! - primaryCoverage.get(left)!
    || compareIds(source.document(left).document.id, source.document(right).document.id));
  if (relevant.length > limits.maxCompared) truncated = true;
  const compared = relevant.slice(0, limits.maxCompared);
  const matches = compared.map(key => {
    const indexed = source.document(key);
    const documentRoutes = routes.get(key)!;
    let score = priority.get(key)! * 100_000;
    for (const term of new Set([...queryTokens.keys(), ...primaryTokens.keys()])) {
      const frequency = indexed.tokenTerms?.get(term);
      const documentFrequency = source.documentFrequency(term);
      if (!frequency || !documentFrequency) continue;
      const inverseDocumentFrequency = Math.log(1 + (source.documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5));
      const denominator = frequency + 1.2 * (0.25 + 0.75 * indexed.length / source.averageLength);
      // Repeated help text must not drown a once-mentioned title or selected SKU.
      score += inverseDocumentFrequency * (frequency * 2.2 / denominator) * (primaryTokens.has(term) ? 5 : 1);
    }
    if (documentRoutes.has('ngram')) {
      for (const [grams, weight] of [[primaryNgrams, 5], [queryNgrams, 1]] as const) {
        let overlap = 0;
        for (const gram of grams) if (indexed.ngrams?.has(gram)) overlap++;
        score += grams.size ? weight * overlap / grams.size : 0;
      }
    }
    return { ...indexed.document, score, routes: [...documentRoutes].sort() };
  });
  matches.sort((left, right) => right.score - left.score || compareIds(left.id, right.id));
  if (matches.length > limits.topK) truncated = true;
  return { candidates: matches.slice(0, limits.topK), stats: { scanned, compared: compared.length, truncated,
    indexBytes: source.indexBytes, indexedCanonicalKeys: source.indexedCanonicalKeys, indexedAliases: source.indexedAliases } };
}

interface PostingIndex {
  readonly postings: Map<string, number[]>;
  readonly truncatedFeatures: Set<string>;
}

interface AliasTrieNode {
  readonly children: Map<string, AliasTrieNode>;
  documentIndex?: number;
}

const DEFAULTS = {
  maxPostingsPerFeature: 256,
  maxScanned: 2_000,
  maxCompared: 400,
  topK: 20,
  maxIndexBytes: 64 * 1024 * 1024,
} as const;

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new RangeError(`${name} must be a positive integer`);
  return resolved;
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function candidateDocumentText(document: CandidateDocument): string {
  return [document.family, document.product, document.tier, document.displayName ?? '', ...document.aliases].join(' ');
}

function approximateEntryBytes(feature: string, isNew: boolean): number {
  return (isNew ? Buffer.byteLength(feature, 'utf8') + 32 : 0) + 8;
}

function approximateFeatureBytes(feature: string): number {
  return Buffer.byteLength(feature, 'utf8') + 40;
}

export class BoundedCandidateIndex {
  readonly #documents: readonly IndexedCandidateDocument[];
  readonly #canonical = new Map<string, number>();
  readonly #aliasRoot: AliasTrieNode = { children: new Map() };
  readonly #tokens: PostingIndex = { postings: new Map(), truncatedFeatures: new Set() };
  readonly #ngrams: PostingIndex = { postings: new Map(), truncatedFeatures: new Set() };
  readonly #maxPostingsPerFeature: number;
  readonly #maxScanned: number;
  readonly #maxCompared: number;
  readonly #topK: number;
  readonly #maxIndexBytes: number;
  #indexBytes = 0;
  #indexBudgetTruncated = false;
  #maxAliasLength = 0;
  #indexedAliases = 0;

  constructor(documents: readonly CandidateDocument[], options: CandidateIndexOptions = {}) {
    this.#maxPostingsPerFeature = positiveInteger(options.maxPostingsPerFeature, DEFAULTS.maxPostingsPerFeature, 'maxPostingsPerFeature');
    this.#maxScanned = positiveInteger(options.maxScanned, DEFAULTS.maxScanned, 'maxScanned');
    this.#maxCompared = positiveInteger(options.maxCompared, DEFAULTS.maxCompared, 'maxCompared');
    this.#topK = positiveInteger(options.topK, DEFAULTS.topK, 'topK');
    this.#maxIndexBytes = positiveInteger(options.maxIndexBytes, DEFAULTS.maxIndexBytes, 'maxIndexBytes');

    const ids = new Set<string>();
    const aliases = new Map<string, string>();
    const canonicalKeys: string[] = [];
    const knownCanonicalKeys = new Set<string>();
    const ordered = [...documents].sort((left, right) => compareIds(left.id, right.id));
    const prepared = ordered.map((document) => {
      if (!document.id || ids.has(document.id)) throw new Error(`duplicate candidate document id: ${document.id}`);
      ids.add(document.id);
      const canonicalKey = buildCanonicalStandardKey(document);
      if (knownCanonicalKeys.has(canonicalKey)) throw new Error(`duplicate canonical catalog identity: ${canonicalKey}`);
      knownCanonicalKeys.add(canonicalKey);
      canonicalKeys.push(canonicalKey);

      const normalizedAliases = [...new Set(document.aliases.map(compactSearchText).filter(Boolean))];
      for (const alias of normalizedAliases) {
        const existing = aliases.get(alias);
        if (existing && existing !== canonicalKey) throw new Error(`ambiguous confirmed alias: ${alias}`);
        aliases.set(alias, canonicalKey);
      }
      return { document, aliases: normalizedAliases };
    });

    for (let index = 0; index < prepared.length; index++) {
      const canonicalKey = canonicalKeys[index]!;
      if (this.#reserve(Buffer.byteLength(canonicalKey, 'utf8') + 48)) this.#canonical.set(canonicalKey, index);
    }
    for (let index = 0; index < prepared.length; index++) {
      for (const alias of prepared[index]!.aliases) this.#addAlias(alias, index);
    }

    this.#documents = prepared.map(({ document, aliases: normalizedAliases }) => {
      const terms = this.#retainTokenTerms(extractTokenTerms(candidateDocumentText(document)));
      const ngrams = this.#retainNgrams(extractCharacterNgrams(candidateDocumentText(document)));
      return {
        document,
        aliases: normalizedAliases,
        tokenTerms: terms,
        ngrams,
        length: Math.max(1, terms ? [...terms.values()].reduce((sum, value) => sum + value, 0) : 1),
      };
    });
    for (let index = 0; index < this.#documents.length; index++) {
      for (const feature of this.#documents[index]!.tokenTerms?.keys() ?? []) this.#addPosting(this.#tokens, feature, index);
    }
    for (let index = 0; index < this.#documents.length; index++) {
      for (const feature of this.#documents[index]!.ngrams ?? []) this.#addPosting(this.#ngrams, feature, index);
    }
  }

  search(query: CandidateSearchQuery): CandidateSearchResult {
    return searchCandidateSource<number>(query, {
      document: index => this.#documents[index]!,
      canonical: key => { const id = this.#canonical.get(key); return id === undefined ? [] : [id]; },
      aliases: text => this.#findAliases(text),
      postings: (index, feature) => {
        const postings = index === 'tokens' ? this.#tokens : this.#ngrams;
        return { ids: postings.postings.get(feature) ?? [], truncated: postings.truncatedFeatures.has(feature) };
      },
      documentFrequency: feature => this.#tokens.postings.get(feature)?.length ?? 0,
      documentCount: this.#documents.length,
      averageLength: this.#documents.length ? this.#documents.reduce((sum, document) => sum + document.length, 0) / this.#documents.length : 1,
      indexBytes: this.#indexBytes,
      indexedCanonicalKeys: this.#canonical.size,
      indexedAliases: this.#indexedAliases,
      budgetTruncated: this.#indexBudgetTruncated,
    }, { maxScanned: this.#maxScanned, maxCompared: this.#maxCompared, topK: this.#topK });
  }

  #reserve(bytes: number): boolean {
    if (this.#indexBytes + bytes > this.#maxIndexBytes) {
      this.#indexBudgetTruncated = true;
      return false;
    }
    this.#indexBytes += bytes;
    return true;
  }

  #retainTokenTerms(terms: ReadonlyMap<string, number>): ReadonlyMap<string, number> | undefined {
    const bytes = 24 + [...terms.keys()].reduce((total, feature) => total + approximateFeatureBytes(feature) + 8, 0);
    return this.#reserve(bytes) ? terms : undefined;
  }

  #retainNgrams(ngrams: ReadonlySet<string>): ReadonlySet<string> | undefined {
    const bytes = 24 + [...ngrams].reduce((total, feature) => total + approximateFeatureBytes(feature), 0);
    return this.#reserve(bytes) ? ngrams : undefined;
  }

  #addPosting(index: PostingIndex, feature: string, documentIndex: number): void {
    const postings = index.postings.get(feature);
    if (postings && postings.length >= this.#maxPostingsPerFeature) {
      index.truncatedFeatures.add(feature);
      return;
    }
    const bytes = approximateEntryBytes(feature, !postings);
    if (!this.#reserve(bytes)) return;
    if (postings) postings.push(documentIndex);
    else index.postings.set(feature, [documentIndex]);
  }

  #addAlias(alias: string, documentIndex: number): void {
    const characters = [...alias];
    if (characters.length < 4) return;
    let existingNode = this.#aliasRoot;
    let firstMissing = characters.length;
    for (let index = 0; index < characters.length; index++) {
      const child = existingNode.children.get(characters[index]!);
      if (!child) {
        firstMissing = index;
        break;
      }
      existingNode = child;
    }
    const missingBytes = 8 + characters.slice(firstMissing)
      .reduce((total, character) => total + Buffer.byteLength(character, 'utf8') + 48, 0);
    if (!this.#reserve(missingBytes)) return;
    this.#maxAliasLength = Math.max(this.#maxAliasLength, characters.length);
    let node = this.#aliasRoot;
    for (const character of characters) {
      let child = node.children.get(character);
      if (!child) {
        child = { children: new Map() };
        node.children.set(character, child);
      }
      node = child;
    }
    node.documentIndex = documentIndex;
    this.#indexedAliases++;
  }

  #findAliases(query: string): Set<number> {
    const matches = new Set<number>();
    const characters = [...query];
    for (let start = 0; start < characters.length; start++) {
      let node = this.#aliasRoot;
      const end = Math.min(characters.length, start + this.#maxAliasLength);
      for (let index = start; index < end; index++) {
        const child = node.children.get(characters[index]!);
        if (!child) break;
        node = child;
        if (node.documentIndex !== undefined) matches.add(node.documentIndex);
      }
    }
    return matches;
  }
}
