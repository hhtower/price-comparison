import assert from 'node:assert/strict';
import { visibleEvidenceText } from '../standardization/evidence-text.js';

export const TEXT_REVIEW_VERSION = 'shop-title-body-20261114-v2';
export const DISCLOSURE_KEYS = ['L1','L2','L3','R1','R2','R3','A1','A2'] as const;
export const CONSISTENCY_KEYS = ['C1','C2','C3','C4','C5','C6'] as const;
export type TextEvidence = { unitId: string; name: string; description: string; hash: string };
export type TextReview = { answers: Record<typeof DISCLOSURE_KEYS[number], boolean>; consistency: Record<typeof CONSISTENCY_KEYS[number], boolean> };
type Source = { url: string; protocol: string | null; platform: string };
const closed = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function readTextEvidence(payload: unknown): TextEvidence | null {
  const value = (payload as { shopText?: unknown } | null)?.shopText;
  return closed(value, ['unitId','name','description','hash']) && typeof value.unitId === 'string' && value.unitId.trim()
    && typeof value.name === 'string' && typeof value.description === 'string' && hash(value.hash) ? value as TextEvidence : null;
}

/** This projection is separate from the lossy tag normalization; never truncate a reviewed body. */
export function projectShopText(sourceData: unknown): TextEvidence | null {
  const text = readTextEvidence({ shopText: (sourceData as { ratingText?: unknown } | null)?.ratingText });
  return text ? { ...text, name: visibleEvidenceText(text.name), description: visibleEvidenceText(text.description) } : null;
}

export function validateTextReview(value: unknown, text: TextEvidence | null): TextReview {
  assert(text, 'text review requires a complete captured title/body');
  assert(closed(value, ['answers','consistency']), 'invalid text review');
  for (const [group, keys] of [['answers', DISCLOSURE_KEYS], ['consistency', CONSISTENCY_KEYS]] as const) {
    const judgments: unknown = value[group];
    assert(closed(judgments, keys), 'text review must answer every question');
    for (const key of keys) {
      assert(typeof judgments[key] === 'boolean', 'text judgment must be a boolean');
    }
  }
  return value as unknown as TextReview;
}

export type ProductReviewRow = { external_id: string; content_version: bigint | string; content_fingerprint: string | null; source_data: unknown; text_review: unknown };
type Listing = { unitId: string; answers: Record<string, boolean | null> | null; consistency: Record<string, boolean | null> | null };
export type PreparedTextReview = Listing & { hash: string; source: Source };

export function prepareTextReview(row: ProductReviewRow): PreparedTextReview | null {
  const captured = readTextEvidence({ shopText: (row.source_data as { ratingText?: unknown } | null)?.ratingText });
  const stored = row.text_review;
  if (!captured || !closed(stored, ['version','contentVersion','fingerprint','source','textHash','review'])
    || stored.version !== TEXT_REVIEW_VERSION || stored.contentVersion !== String(row.content_version)
    || stored.fingerprint !== row.content_fingerprint || stored.textHash !== captured.hash
    || !closed(stored.source, ['url','protocol','platform'])
    || typeof stored.source.url !== 'string' || typeof stored.source.platform !== 'string'
    || stored.source.protocol !== null && typeof stored.source.protocol !== 'string') return null;
  try {
    const review = validateTextReview(stored.review, captured);
    return { unitId: captured.unitId, hash: captured.hash, source: stored.source as Source,
      answers: review.answers, consistency: review.consistency };
  } catch { return null; }
}

export function createTextReviewAccumulator(manifest: unknown, source: Source, now: number) {
  if (!closed(manifest, ['sourceUrl','sourceProtocol','sourcePlatform','observedAt','units'])
    || manifest.sourceUrl !== source.url || manifest.sourceProtocol !== source.protocol || manifest.sourcePlatform !== source.platform
    || typeof manifest.observedAt !== 'number' || !Number.isSafeInteger(manifest.observedAt) || manifest.observedAt < 0
    || manifest.observedAt > now || !Array.isArray(manifest.units)) return null;
  const units = new Map<string, string | null>();
  for (const unit of manifest.units) {
    if (!closed(unit, ['unitId','hash']) || typeof unit.unitId !== 'string' || !unit.unitId.trim()
      || unit.hash !== null && !hash(unit.hash) || units.has(unit.unitId)) return null;
    units.set(unit.unitId, unit.hash);
  }
  const reviews = new Map<string, Listing>();
  const conflicts = new Set<string>();
  const add = (review: PreparedTextReview) => {
    if (!units.has(review.unitId) || units.get(review.unitId) !== review.hash
      || review.source.url !== source.url || review.source.protocol !== source.protocol || review.source.platform !== source.platform) return;
    const old = reviews.get(review.unitId);
    const listing: Listing = { unitId: review.unitId, answers: review.answers, consistency: review.consistency };
    if (old && JSON.stringify(old) !== JSON.stringify(listing)) conflicts.add(review.unitId);
    else reviews.set(review.unitId, listing);
  };
  return { add, finish() {
    let reviewed = 0;
    const listings = [...units.keys()].sort().map(unitId => {
      const review = conflicts.has(unitId) ? undefined : reviews.get(unitId);
      if (review) reviewed++;
      return review ?? { unitId, answers: null, consistency: null };
    });
    return { listings, reviewed };
  } };
}
