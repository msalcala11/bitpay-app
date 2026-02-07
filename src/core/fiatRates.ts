import type {BwsConfig} from './bitpay';
import {loadFiatRateSeriesCache, saveFiatRateSeriesCache} from './storage';

// Mirrors BitPay app types/shape closely so the cache JSON matches.
//
// BWS supports ?days=... for smaller windows; larger windows are typically daily cadence.
// In the original BitPay app, the commonly-fetched intervals are: 1D, 1W, 1M, ALL.
export type CachedFiatRateInterval =
  | '1D'
  | '1W'
  | '1M'
  | '3M'
  | '1Y'
  | '5Y'
  | 'ALL';
export type FiatRateInterval = CachedFiatRateInterval;

export type FiatRatePoint = {
  ts: number; // unix ms
  rate: number;
};

export type FiatRateSeries = {
  fetchedOn: number; // unix ms
  points: FiatRatePoint[];
};

export type FiatRateSeriesCache = {
  [key in string]?: FiatRateSeries;
};

// Matches BitPay's short TTL for historic series.
const HISTORIC_RATES_CACHE_DURATION_SECONDS = 5 * 60; // 5 minutes
// Match BitPay pruning behavior: keep the most recently-fetched fiat(s).
const FIAT_RATE_SERIES_MAX_FIATS_PERSISTED = 1;

const FIAT_RATE_SERIES_INTERVAL_DAYS: Record<
  FiatRateInterval,
  number | undefined
> = {
  '1D': 1,
  '1W': 7,
  '1M': 30,
  '3M': 90,
  '1Y': 365,
  '5Y': 1825,
  ALL: undefined,
};

export const getFiatRateSeriesCacheKey = (
  fiatCode: string,
  coin: string,
  interval: FiatRateInterval,
): string => {
  return `${(fiatCode || '').toUpperCase()}:${(
    coin || ''
  ).toLowerCase()}:${interval}`;
};

export const getFiatRateSeriesUrl = (
  cfg: BwsConfig,
  fiatCode: string,
  interval: FiatRateInterval,
): string => {
  const days = FIAT_RATE_SERIES_INTERVAL_DAYS[interval];
  const codeUpper = (fiatCode || 'USD').toUpperCase();
  if (!days) {
    return `${cfg.baseUrl}/v4/fiatrates/${codeUpper}`;
  }
  return `${cfg.baseUrl}/v4/fiatrates/${codeUpper}?days=${days}`;
};

const getFiatCodeFromSeriesCacheKey = (
  cacheKey: string,
): string | undefined => {
  if (!cacheKey || typeof cacheKey !== 'string') return undefined;
  const idx = cacheKey.indexOf(':');
  if (idx <= 0) return undefined;
  return cacheKey.slice(0, idx).toUpperCase();
};

const isCacheKeyStale = (
  timestamp: number | undefined,
  durationSeconds: number,
): boolean => {
  if (!timestamp) return true;
  const ttlMs = durationSeconds * 1000;
  return Date.now() - timestamp > ttlMs;
};

const dedupeFiatRatePointsByTs = (points: FiatRatePoint[]): FiatRatePoint[] => {
  const seen = new Set<number>();
  const out: FiatRatePoint[] = [];
  for (const p of points) {
    if (!p || typeof p.ts !== 'number') continue;
    if (seen.has(p.ts)) continue;
    seen.add(p.ts);
    out.push(p);
  }
  return out;
};

export function upsertFiatRateSeriesCache(
  current: FiatRateSeriesCache,
  updates: FiatRateSeriesCache,
): FiatRateSeriesCache {
  const merged: FiatRateSeriesCache = {...current, ...updates};

  // Match BitPay pruning behavior: keep only the most recently-fetched fiat(s).
  const lastFetchedByFiat: Record<string, number> = {};

  for (const [cacheKey, series] of Object.entries(merged)) {
    const fiatCode = getFiatCodeFromSeriesCacheKey(cacheKey);
    if (!fiatCode) continue;
    const fetchedOn = (series as any)?.fetchedOn;
    if (typeof fetchedOn !== 'number') continue;
    const prev = lastFetchedByFiat[fiatCode];
    if (!prev || fetchedOn > prev) lastFetchedByFiat[fiatCode] = fetchedOn;
  }

  const fiatsByRecent = Object.entries(lastFetchedByFiat)
    .sort((a, b) => b[1] - a[1])
    .slice(0, FIAT_RATE_SERIES_MAX_FIATS_PERSISTED)
    .map(([fiat]) => fiat);
  const keepFiats = new Set(fiatsByRecent);

  const pruned: FiatRateSeriesCache = {};
  for (const [cacheKey, series] of Object.entries(merged)) {
    const fiatCode = getFiatCodeFromSeriesCacheKey(cacheKey);
    if (!fiatCode || keepFiats.has(fiatCode)) {
      pruned[cacheKey] = series as FiatRateSeries;
    }
  }

  return pruned;
}

export async function fetchAndCacheFiatRateSeriesAllCoins(args: {
  fiatCode: string;
  cfg: BwsConfig;
  interval: FiatRateInterval;
  force?: boolean;
  // Used only to decide whether to reuse the cache without fetching.
  coinForCacheCheck?: string;
}): Promise<FiatRateSeriesCache> {
  const {
    fiatCode,
    cfg,
    interval,
    force = false,
    coinForCacheCheck = 'btc',
  } = args;

  const current = loadFiatRateSeriesCache() as FiatRateSeriesCache;
  const cacheKey = getFiatRateSeriesCacheKey(
    fiatCode,
    coinForCacheCheck,
    interval,
  );
  const cached = current[cacheKey];

  if (
    !force &&
    cached?.points?.length &&
    !isCacheKeyStale(cached.fetchedOn, HISTORIC_RATES_CACHE_DURATION_SECONDS)
  ) {
    return current;
  }

  const url = getFiatRateSeriesUrl(cfg, fiatCode, interval);
  const res = await fetch(url, {
    method: 'GET',
    headers: {Accept: 'application/json'},
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch rates: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  const fetchedOn = Date.now();

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return current;
  }

  const updates: FiatRateSeriesCache = {};
  for (const coin of Object.keys(data as Record<string, unknown>)) {
    const rawPoints = (data as any)[coin] as Array<any>;
    if (!Array.isArray(rawPoints) || rawPoints.length === 0) continue;

    const filtered = rawPoints.filter(
      (p: any) => Number.isFinite(p?.ts) && Number.isFinite(p?.rate),
    );
    if (filtered.length === 0) continue;

    const points = filtered
      .map((p: any) => ({ts: p.ts, rate: p.rate}))
      .sort((a: FiatRatePoint, b: FiatRatePoint) => a.ts - b.ts);
    const deduped = dedupeFiatRatePointsByTs(points);

    updates[getFiatRateSeriesCacheKey(fiatCode, coin, interval)] = {
      fetchedOn,
      points: deduped,
    };
  }

  if (Object.keys(updates).length === 0) {
    return current;
  }

  const next = upsertFiatRateSeriesCache(current, updates);
  saveFiatRateSeriesCache(next as any);
  return next;
}

export async function fetchAndCacheFiatRateSeriesAllIntervals(args: {
  fiatCode: string;
  cfg: BwsConfig;
  force?: boolean;
  coinForCacheCheck?: string;
  intervals?: FiatRateInterval[];
}): Promise<FiatRateSeriesCache> {
  const {
    fiatCode,
    cfg,
    force = false,
    coinForCacheCheck = 'btc',
    intervals = ['1D', '1W', '1M', 'ALL'],
  } = args;

  let current = loadFiatRateSeriesCache() as FiatRateSeriesCache;
  for (const interval of intervals) {
    try {
      current = await fetchAndCacheFiatRateSeriesAllCoins({
        fiatCode,
        cfg,
        interval,
        force,
        coinForCacheCheck,
      });
    } catch (e) {
      // Don't fail the whole fetch on a single interval.
      // The caller can still use whatever cache exists.
      // eslint-disable-next-line no-console
      console.warn(`Failed to fetch interval ${interval}:`, e);
    }
  }
  return current;
}
