import { extractTextFeatures, textFeatureSimilarity, type TextFeatures } from './text-features.js';

export interface SimilarityGroupInput {
  readonly id: string;
  readonly text: string;
}

export interface SimilarityGroupingOptions {
  readonly maxFeaturesPerInput?: number;
  readonly maxPostingsPerFeature?: number;
  readonly maxScannedPerInput?: number;
  readonly maxComparedPerInput?: number;
  readonly maxGroupSize?: number;
  readonly similarityThreshold?: number;
}

export interface SimilarityGroup {
  readonly anchorId: string;
  readonly memberIds: readonly string[];
}

export interface GroupingPlan {
  readonly groups: readonly SimilarityGroup[];
  readonly representativeByMember: Readonly<Record<string, string>>;
  readonly stats: {
    readonly scanned: number;
    readonly compared: number;
    readonly plannedPairCount: number;
    readonly retainedNeighborCount: number;
    readonly selectionVisits: number;
    readonly peakScratchCandidates: number;
    readonly retainedFeatureCount: number;
    readonly truncated: boolean;
  };
}

interface PreparedInput extends SimilarityGroupInput {
  readonly features: TextFeatures;
  readonly indexFeatures: readonly string[];
}

const DEFAULTS = {
  maxFeaturesPerInput: 256,
  maxPostingsPerFeature: 256,
  maxScannedPerInput: 2_000,
  maxComparedPerInput: 400,
  maxGroupSize: 32,
  similarityThreshold: 0.35,
} as const;

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new RangeError(`${name} must be a positive integer`);
  return resolved;
}

function threshold(value: number | undefined): number {
  const resolved = value ?? DEFAULTS.similarityThreshold;
  if (!Number.isFinite(resolved) || resolved < 0 || resolved > 1) throw new RangeError('similarityThreshold must be between zero and one');
  return resolved;
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function indexFeatures(features: TextFeatures, maxFeatures: number): string[] {
  const tokens = [...features.tokenTerms.keys()].sort().map(value => `t:${value}`);
  const ngrams = [...features.ngrams].sort().map(value => `g:${value}`);
  return [...tokens, ...ngrams].slice(0, maxFeatures);
}

export function planSimilarityGroups(inputs: readonly SimilarityGroupInput[], options: SimilarityGroupingOptions = {}): GroupingPlan {
  const maxFeaturesPerInput = positiveInteger(options.maxFeaturesPerInput, DEFAULTS.maxFeaturesPerInput, 'maxFeaturesPerInput');
  const maxPostingsPerFeature = positiveInteger(options.maxPostingsPerFeature, DEFAULTS.maxPostingsPerFeature, 'maxPostingsPerFeature');
  const maxScannedPerInput = positiveInteger(options.maxScannedPerInput, DEFAULTS.maxScannedPerInput, 'maxScannedPerInput');
  const maxComparedPerInput = positiveInteger(options.maxComparedPerInput, DEFAULTS.maxComparedPerInput, 'maxComparedPerInput');
  const maxGroupSize = positiveInteger(options.maxGroupSize, DEFAULTS.maxGroupSize, 'maxGroupSize');
  const similarityThreshold = threshold(options.similarityThreshold);

  const ids = new Set<string>();
  let truncated = false;
  let retainedFeatureCount = 0;
  const prepared: PreparedInput[] = [...inputs].sort((left, right) => compareIds(left.id, right.id)).map(input => {
    if (!input.id || ids.has(input.id)) throw new Error(`duplicate grouping input id: ${input.id}`);
    ids.add(input.id);
    const features = extractTextFeatures(input.text, { maxFeatures: maxFeaturesPerInput });
    const allFeatureCount = features.tokenTerms.size + features.ngrams.size;
    retainedFeatureCount += allFeatureCount;
    if (features.truncated) truncated = true;
    return { ...input, features, indexFeatures: indexFeatures(features, maxFeaturesPerInput) };
  });

  const postings = new Map<string, number[]>();
  for (let inputIndex = 0; inputIndex < prepared.length; inputIndex++) {
    for (const feature of prepared[inputIndex]!.indexFeatures) {
      const values = postings.get(feature);
      if (values && values.length >= maxPostingsPerFeature) {
        truncated = true;
        continue;
      }
      if (values) values.push(inputIndex);
      else postings.set(feature, [inputIndex]);
    }
  }

  const retainedPerInput = Math.min(maxGroupSize - 1, Math.max(0, prepared.length - 1));
  const retainedSlotCount = prepared.length * retainedPerInput;
  if (!Number.isSafeInteger(retainedSlotCount) || retainedSlotCount > 0xffff_ffff) {
    throw new RangeError('grouping neighbor storage exceeds the typed-array length limit');
  }
  const retainedIndexes = new Int32Array(retainedSlotCount);
  retainedIndexes.fill(-1);
  const retainedScores = new Float64Array(retainedSlotCount);
  const retainedCounts = new Uint32Array(prepared.length);
  const hitCounts = new Uint32Array(prepared.length);
  const candidateScores = new Float64Array(prepared.length);
  const rankedCandidates: number[] = [];
  const scoredCandidates: number[] = [];
  let scanned = 0;
  let compared = 0;
  let retainedNeighborCount = 0;
  let peakScratchCandidates = 0;
  for (let inputIndex = 0; inputIndex < prepared.length; inputIndex++) {
    const input = prepared[inputIndex]!;
    rankedCandidates.length = 0;
    scoredCandidates.length = 0;
    let inputScanned = 0;
    const orderedFeatures = [...input.indexFeatures].sort((left, right) =>
      (postings.get(left)?.length ?? 0) - (postings.get(right)?.length ?? 0) || compareIds(left, right));
    scan: for (const feature of orderedFeatures) {
      for (const candidateIndex of postings.get(feature) ?? []) {
        if (inputScanned >= maxScannedPerInput) {
          truncated = true;
          break scan;
        }
        inputScanned++;
        scanned++;
        if (candidateIndex === inputIndex) continue;
        if (hitCounts[candidateIndex] === 0) rankedCandidates.push(candidateIndex);
        hitCounts[candidateIndex] += 1;
      }
    }
    rankedCandidates.sort((left, right) => hitCounts[right]! - hitCounts[left]!
      || compareIds(prepared[left]!.id, prepared[right]!.id));
    peakScratchCandidates = Math.max(peakScratchCandidates, rankedCandidates.length);
    if (rankedCandidates.length > maxComparedPerInput) truncated = true;
    const comparedCount = Math.min(rankedCandidates.length, maxComparedPerInput);
    for (let rank = 0; rank < comparedCount; rank++) {
      const candidateIndex = rankedCandidates[rank]!;
      compared++;
      const candidate = prepared[candidateIndex]!;
      const score = textFeatureSimilarity(input.features, candidate.features);
      if (score >= similarityThreshold) {
        candidateScores[candidateIndex] = score;
        scoredCandidates.push(candidateIndex);
      }
    }
    peakScratchCandidates = Math.max(peakScratchCandidates, scoredCandidates.length);
    const forwardDistance = (candidateIndex: number) => candidateIndex > inputIndex
      ? candidateIndex - inputIndex
      : prepared.length - inputIndex + candidateIndex;
    scoredCandidates.sort((left, right) => candidateScores[right]! - candidateScores[left]!
      || forwardDistance(left) - forwardDistance(right)
      || compareIds(prepared[left]!.id, prepared[right]!.id));
    const retainedCount = Math.min(scoredCandidates.length, retainedPerInput);
    retainedCounts[inputIndex] = retainedCount;
    retainedNeighborCount += retainedCount;
    const retainedOffset = inputIndex * retainedPerInput;
    for (let neighborIndex = 0; neighborIndex < retainedCount; neighborIndex++) {
      const candidateIndex = scoredCandidates[neighborIndex]!;
      retainedIndexes[retainedOffset + neighborIndex] = candidateIndex;
      retainedScores[retainedOffset + neighborIndex] = candidateScores[candidateIndex]!;
    }
    for (const candidateIndex of rankedCandidates) hitCounts[candidateIndex] = 0;
  }

  const active = new Uint8Array(prepared.length);
  active.fill(1);
  let activeCount = prepared.length;
  const degrees = new Uint32Array(prepared.length);
  const totalScores = new Float64Array(prepared.length);
  const versions = new Uint32Array(prepared.length);
  versions.fill(1);
  const reverseHeads = new Int32Array(prepared.length);
  reverseHeads.fill(-1);
  const reverseSources = new Int32Array(retainedNeighborCount);
  const reverseNext = new Int32Array(retainedNeighborCount);
  const reverseScores = new Float64Array(retainedNeighborCount);
  let reverseSlot = 0;
  let selectionVisits = 0;
  for (let inputIndex = 0; inputIndex < prepared.length; inputIndex++) {
    const offset = inputIndex * retainedPerInput;
    degrees[inputIndex] = retainedCounts[inputIndex]!;
    for (let neighborIndex = 0; neighborIndex < retainedCounts[inputIndex]!; neighborIndex++) {
      const retainedSlot = offset + neighborIndex;
      const candidateIndex = retainedIndexes[retainedSlot]!;
      const score = retainedScores[retainedSlot]!;
      totalScores[inputIndex] += score;
      reverseSources[reverseSlot] = inputIndex;
      reverseScores[reverseSlot] = score;
      reverseNext[reverseSlot] = reverseHeads[candidateIndex]!;
      reverseHeads[candidateIndex] = reverseSlot;
      reverseSlot++;
      selectionVisits++;
    }
  }

  const heapCapacity = prepared.length + retainedNeighborCount;
  const heapIndexes = new Int32Array(heapCapacity);
  const heapVersions = new Uint32Array(heapCapacity);
  const heapDegrees = new Uint32Array(heapCapacity);
  const heapScores = new Float64Array(heapCapacity);
  let heapSize = 0;
  const heapEntryIsBetter = (leftSlot: number, rightSlot: number): boolean => {
    if (heapDegrees[leftSlot] !== heapDegrees[rightSlot]) return heapDegrees[leftSlot]! > heapDegrees[rightSlot]!;
    if (heapScores[leftSlot] !== heapScores[rightSlot]) return heapScores[leftSlot]! > heapScores[rightSlot]!;
    return compareIds(prepared[heapIndexes[leftSlot]!]!.id, prepared[heapIndexes[rightSlot]!]!.id) < 0;
  };
  const copyHeapEntry = (target: number, source: number): void => {
    heapIndexes[target] = heapIndexes[source]!;
    heapVersions[target] = heapVersions[source]!;
    heapDegrees[target] = heapDegrees[source]!;
    heapScores[target] = heapScores[source]!;
  };
  const swapHeapEntries = (left: number, right: number): void => {
    const index = heapIndexes[left]!;
    const version = heapVersions[left]!;
    const degree = heapDegrees[left]!;
    const score = heapScores[left]!;
    copyHeapEntry(left, right);
    heapIndexes[right] = index;
    heapVersions[right] = version;
    heapDegrees[right] = degree;
    heapScores[right] = score;
  };
  const pushHeapEntry = (inputIndex: number): void => {
    if (heapSize >= heapCapacity) throw new Error('grouping selection heap exceeded its bounded capacity');
    let slot = heapSize++;
    heapIndexes[slot] = inputIndex;
    heapVersions[slot] = versions[inputIndex]!;
    heapDegrees[slot] = degrees[inputIndex]!;
    heapScores[slot] = totalScores[inputIndex]!;
    peakScratchCandidates = Math.max(peakScratchCandidates, heapSize);
    while (slot > 0) {
      const parent = Math.floor((slot - 1) / 2);
      if (!heapEntryIsBetter(slot, parent)) break;
      swapHeapEntries(slot, parent);
      slot = parent;
    }
  };
  const popHeapEntry = (): { index: number; version: number } | undefined => {
    if (heapSize === 0) return undefined;
    const result = { index: heapIndexes[0]!, version: heapVersions[0]! };
    heapSize--;
    if (heapSize > 0) {
      copyHeapEntry(0, heapSize);
      let slot = 0;
      while (true) {
        const left = slot * 2 + 1;
        if (left >= heapSize) break;
        const right = left + 1;
        const best = right < heapSize && heapEntryIsBetter(right, left) ? right : left;
        if (!heapEntryIsBetter(best, slot)) break;
        swapHeapEntries(slot, best);
        slot = best;
      }
    }
    return result;
  };
  for (let inputIndex = 0; inputIndex < prepared.length; inputIndex++) pushHeapEntry(inputIndex);

  const groups: SimilarityGroup[] = [];
  const representativeByMember: Record<string, string> = {};
  while (activeCount > 0) {
    let anchorIndex = -1;
    while (anchorIndex < 0) {
      const entry = popHeapEntry();
      if (!entry) throw new Error('grouping selection heap exhausted before all inputs were assigned');
      selectionVisits++;
      if (active[entry.index] === 1 && versions[entry.index] === entry.version) anchorIndex = entry.index;
    }
    const selectedNeighbors: Array<{ index: number; score: number }> = [];
    const anchorOffset = anchorIndex * retainedPerInput;
    for (let neighborIndex = 0; neighborIndex < retainedCounts[anchorIndex]!; neighborIndex++) {
      selectionVisits++;
      const candidateIndex = retainedIndexes[anchorOffset + neighborIndex]!;
      if (active[candidateIndex] === 1) {
        selectedNeighbors.push({ index: candidateIndex, score: retainedScores[anchorOffset + neighborIndex]! });
      }
    }
    selectedNeighbors.sort((left, right) => right.score - left.score
      || compareIds(prepared[left.index]!.id, prepared[right.index]!.id));
    const memberIndexes = [anchorIndex, ...selectedNeighbors.slice(0, retainedPerInput).map(neighbor => neighbor.index)];
    const anchorId = prepared[anchorIndex]!.id;
    const memberIds = memberIndexes.map(index => prepared[index]!.id);
    groups.push({ anchorId, memberIds });
    for (const memberIndex of memberIndexes) {
      const memberId = prepared[memberIndex]!.id;
      representativeByMember[memberId] = anchorId;
      if (active[memberIndex] === 1) {
        active[memberIndex] = 0;
        activeCount--;
        versions[memberIndex]++;
      }
    }
    for (const memberIndex of memberIndexes) {
      for (let reverseIndex = reverseHeads[memberIndex]!; reverseIndex >= 0; reverseIndex = reverseNext[reverseIndex]!) {
        selectionVisits++;
        const sourceIndex = reverseSources[reverseIndex]!;
        if (active[sourceIndex] === 0) continue;
        if (degrees[sourceIndex] === 0) throw new Error('grouping selection degree underflow');
        degrees[sourceIndex]--;
        totalScores[sourceIndex] = degrees[sourceIndex] === 0
          ? 0
          : totalScores[sourceIndex]! - reverseScores[reverseIndex]!;
        versions[sourceIndex]++;
        pushHeapEntry(sourceIndex);
      }
    }
  }

  return {
    groups,
    representativeByMember,
    stats: {
      scanned,
      compared,
      plannedPairCount: compared,
      retainedNeighborCount,
      selectionVisits,
      peakScratchCandidates,
      retainedFeatureCount,
      truncated,
    },
  };
}
