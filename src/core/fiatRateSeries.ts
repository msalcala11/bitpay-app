// Mirrors BitPay app types/shape closely so the cache JSON matches.
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

export const getFiatRateSeriesCacheKey = (
  fiatCode: string,
  coin: string,
  interval: FiatRateInterval,
): string => {
  return `${(fiatCode || '').toUpperCase()}:${(
    coin || ''
  ).toLowerCase()}:${interval}`;
};

const getFiatCodeFromSeriesCacheKey = (
  cacheKey: string,
): string | undefined => {
  if (!cacheKey || typeof cacheKey !== 'string') return undefined;
  const idx = cacheKey.indexOf(':');
  if (idx <= 0) return undefined;
  return cacheKey.slice(0, idx).toUpperCase();
};

export function upsertFiatRateSeriesCache(
  current: FiatRateSeriesCache,
  updates: FiatRateSeriesCache,
  opts?: {
    maxFiatsPersisted?: number;
  },
): FiatRateSeriesCache {
  const maxFiatsPersisted = Math.max(1, opts?.maxFiatsPersisted ?? 1);
  const merged: FiatRateSeriesCache = {...current, ...updates};

  // Keep only the most recently-fetched fiat(s).
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
    .slice(0, maxFiatsPersisted)
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
