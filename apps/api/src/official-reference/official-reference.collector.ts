import { REFERENCE_REGIONS } from './official-reference.catalog.js';
import type { ReferenceRegionSnapshot, ReferenceSnapshotOffer } from './official-reference.types.js';

const MAX_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 12_000;
type Fetcher = (url: string | URL, init?: RequestInit) => Promise<Response>;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Apple object');
  return value as Record<string, unknown>;
}

function list(value: unknown, limit = 100): unknown[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error('Invalid Apple collection');
  return value;
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Invalid Apple text');
  return value;
}

/** Bound even transports/streams that do not themselves implement AbortSignal. */
async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([pending, stopped]); }
  finally { if (abort) signal.removeEventListener('abort', abort); }
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body || Number(response.headers.get('content-length')) > MAX_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new Error('Apple response unavailable or too large');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('Apple response too large');
      chunks.push(value);
    }
    signal.throwIfAborted();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally {
    // Do not await an uncooperative upstream cancel; cancellation must stay bounded.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class ReferenceUnavailableError extends Error {
  constructor(readonly appId: string, readonly country: string) {
    super('App unavailable in the requested storefront');
    this.name = 'ReferenceUnavailableError';
  }
}

function parseSnapshot(payload: unknown, appId: string, country: string, currency: string): ReferenceRegionSnapshot {
  const root = object(payload);
  if (root.errors || root.next) throw new Error('Incomplete Apple response');
  const apps = list(root.data, 1);
  if (apps.length !== 1) throw new Error('Missing Apple app');
  const app = object(apps[0]);
  const appPath = `/v1/catalog/${country}/apps/${appId}`;
  if (app.id !== appId || app.type !== 'apps' || app.href !== appPath) throw new Error('Apple app/storefront mismatch');
  const attributes = object(app.attributes);
  const name = text(attributes.name, 200);
  const source = new URL(text(attributes.url, 2048));
  if (source.origin !== 'https://apps.apple.com' || source.username || source.password
    || source.pathname.split('/')[1] !== country || !source.pathname.endsWith(`/id${appId}`)) {
    throw new Error('Apple app URL mismatch');
  }
  const top = object(object(app.relationships)['top-in-apps']);
  if (top.href !== appPath + '/top-in-apps' || top.next) throw new Error('Incomplete Apple in-app collection');
  const entries = list(top.data);
  const offers = new Map<string, ReferenceSnapshotOffer>();

  function add(raw: unknown, id: string, offerName: string, kind: ReferenceSnapshotOffer['kind']) {
    const value = object(raw);
    if (value.currencyCode !== currency) throw new Error('Apple currency/storefront mismatch');
    if (typeof value.price !== 'number' || !Number.isFinite(value.price) || value.price < 0 || value.price >= 1e12) {
      throw new Error('Invalid Apple price');
    }
    if (value.priceString !== undefined && (typeof value.priceString !== 'string'
      || !/^\d+(?:\.\d+)?$/u.test(value.priceString) || Number(value.priceString) !== value.price)) {
      throw new Error('Inconsistent Apple price');
    }
    const params = new URLSearchParams(text(value.buyParams, 4096));
    if (params.getAll('salableAdamId').length !== 1 || params.get('salableAdamId') !== id
      || params.getAll('appAdamId').length > 1
      || (params.has('appAdamId') && params.get('appAdamId') !== appId)) throw new Error('Apple offer identity mismatch');
    let period: string | null = null;
    if (value.recurringSubscriptionPeriod !== undefined) {
      period = text(value.recurringSubscriptionPeriod, 80);
      if (kind !== 'subscription' || !/^P[1-9]\d{0,3}[DWMY]$/u.test(period)) throw new Error('Invalid Apple subscription period');
    }
    const parsed: ReferenceSnapshotOffer = { id, name: offerName, amount: value.price,
      formatted: text(value.priceFormatted, 100), period, kind };
    const existing = offers.get(id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(parsed)) throw new Error('Conflicting Apple SKU offers');
    offers.set(id, parsed);
    if (offers.size > 100) throw new Error('Too many Apple offers');
  }

  function addOffers(raw: unknown, id: string, offerName: string, kind: ReferenceSnapshotOffer['kind']) {
    let count = 0;
    for (const value of list(raw)) {
      const offer = object(value);
      // Updates/redownloads are not the public purchase price.
      if (offer.type !== 'buy' && !(kind === 'app' && offer.type === 'get')) continue;
      add(offer, id, offerName, kind);
      count++;
    }
    if (!count) throw new Error('Missing Apple purchase offer');
  }

  if (attributes.offers !== undefined) addOffers(attributes.offers, appId, name, 'app');
  if (attributes.platformAttributes !== undefined) {
    for (const platform of Object.values(object(attributes.platformAttributes))) {
      const values = object(platform).offers;
      if (values !== undefined) addOffers(values, appId, name, 'app');
    }
  }
  for (const raw of entries) {
    const item = object(raw);
    const id = text(item.id, 20);
    if (!/^\d{5,14}$/u.test(id) || item.type !== 'in-apps'
      || item.href !== `/v1/catalog/${country}/in-apps/${id}`) throw new Error('Invalid Apple SKU identity');
    const data = object(item.attributes);
    if (typeof data.isSubscription !== 'boolean') throw new Error('Invalid Apple purchase type');
    addOffers(data.offers, id, text(data.name, 200), data.isSubscription ? 'subscription' : 'purchase');
  }
  if (!offers.size) throw new Error('Missing Apple price evidence');
  return { appId, country, currency, sourceUrl: `https://apps.apple.com/${country}/app/id${appId}`,
    capturedAt: new Date().toISOString(), offers: [...offers.values()] };
}

export async function fetchReferenceRegion(appId: string, country: string,
  fetcher: Fetcher,
  signal: AbortSignal): Promise<ReferenceRegionSnapshot> {
  const region = REFERENCE_REGIONS.find(value => value[0] === country);
  if (!/^\d{5,14}$/u.test(appId) || !region) throw new Error('Invalid reference app/storefront');
  signal.throwIfAborted();
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const timeout = setTimeout(() => controller.abort(new DOMException('Apple request timed out', 'TimeoutError')), REQUEST_TIMEOUT_MS);
  // Apple's current web frontend routes its public catalog API through this same-origin proxy.
  // This supplies stable SKU IDs and billing periods without a copied, expiring bearer token.
  const url = new URL(`https://apps.apple.com/api/apps/v1/catalog/${country}/apps/${appId}`);
  url.search = new URLSearchParams({ platform: 'web', include: 'top-in-apps', additionalPlatforms: 'iphone,mac' }).toString();
  try {
    const pending = fetcher(url, { signal: combined, redirect: 'error',
      headers: { Accept: 'application/json', 'Accept-Language': 'en-US,en;q=0.9', 'User-Agent': 'OfficialPriceReference/1.0' } });
    // Dispose of late responses after timeout/cancellation, even for a noncompliant injected transport.
    void pending.then(response => { if (combined.aborted) void response.body?.cancel().catch(() => {}); }, () => {});
    const response = await abortable(pending, combined);
    if (response.redirected || (response.url && (new URL(response.url).origin !== url.origin
      || new URL(response.url).pathname !== url.pathname))) {
      void response.body?.cancel().catch(() => {});
      throw new Error('Apple response redirected');
    }
    if (!response.ok && response.status !== 404) {
      void response.body?.cancel().catch(() => {});
      throw new Error(`Apple upstream HTTP ${response.status}`);
    }
    const payload = await readJson(response, combined);
    if (response.status === 404) {
      const errors = object(payload).errors;
      if (Array.isArray(errors) && errors.length > 0 && errors.every(value => {
        const error = object(value); return error.status === '404' && error.code === '40400' && error.title === 'Resource Not Found';
      })) throw new ReferenceUnavailableError(appId, country);
      throw new Error('Unrecognized Apple unavailable response');
    }
    combined.throwIfAborted();
    return parseSnapshot(payload, appId, country, region[2]);
  } finally { clearTimeout(timeout); }
}
