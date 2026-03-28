import type {
  FiatRateInterval,
  FiatRateSeriesCache,
} from './rate.models';
import {parseFiatRateSeriesCacheKey} from './rate.models';

export type RateCachePerfWriteSource =
  | 'fetchFiatRateSeriesInterval'
  | 'refreshFiatRateSeries';

export type RateCachePerfDebug = {
  allowedCoinCount?: number;
  batchGroup: string;
  coinForCacheCheck?: string;
  coalescedWriteCount?: number;
  fiatCode: string;
  force?: boolean;
  hasIdentity?: boolean;
  requestMode:
    | 'default'
    | 'coin_specific'
    | 'patch_latest_point'
    | 'coalesced';
  requestedCoin?: string;
  requestedInterval: FiatRateInterval;
  responseCoinCount?: number;
  source: RateCachePerfWriteSource;
};

export type RateCacheKeySummary = {
  cacheKeysSample: string[];
  distinctCoinCount: number;
  keyCount: number;
  keyCountByCoin: Record<string, number>;
  keyCountByInterval: Record<string, number>;
};

export type RateCacheMutationSummary = {
  addedKeyCount: number;
  appliedKeyCount: number;
  fetchedOnChangedKeyCount: number;
  lastTsChangedKeyCount: number;
  pointCountChangedKeyCount: number;
  unchangedKeyCount: number;
  updatedKeyCount: number;
};

const getCacheEntryPointCount = (
  entry?: FiatRateSeriesCache[string],
): number => {
  return Array.isArray(entry?.points) ? entry.points.length : 0;
};

const getCacheEntryLastTs = (
  entry?: FiatRateSeriesCache[string],
): number | undefined => {
  const pointCount = getCacheEntryPointCount(entry);
  const lastTs = pointCount ? Number(entry?.points?.[pointCount - 1]?.ts) : NaN;
  return Number.isFinite(lastTs) ? lastTs : undefined;
};

export const summarizeRateCacheKeys = (args: {
  cacheKeys: string[];
  maxSampleSize?: number;
}): RateCacheKeySummary => {
  const cacheKeys = Array.from(new Set(args.cacheKeys || [])).sort((a, b) =>
    a.localeCompare(b),
  );
  const maxSampleSize = Math.max(1, args.maxSampleSize || 6);
  const keyCountByCoin: Record<string, number> = {};
  const keyCountByInterval: Record<string, number> = {};

  for (const cacheKey of cacheKeys) {
    const parsed = parseFiatRateSeriesCacheKey(cacheKey);
    const coin = parsed?.coin || 'unknown';
    const interval = parsed?.interval || 'unknown';
    keyCountByCoin[coin] = (keyCountByCoin[coin] || 0) + 1;
    keyCountByInterval[interval] = (keyCountByInterval[interval] || 0) + 1;
  }

  return {
    cacheKeysSample: cacheKeys.slice(0, maxSampleSize),
    distinctCoinCount: Object.keys(keyCountByCoin).length,
    keyCount: cacheKeys.length,
    keyCountByCoin,
    keyCountByInterval,
  };
};

export const summarizeRateCacheMutation = (args: {
  previousCache?: FiatRateSeriesCache;
  nextCache?: FiatRateSeriesCache;
  updatedCacheKeys: string[];
}): RateCacheMutationSummary => {
  const updatedCacheKeys = Array.from(new Set(args.updatedCacheKeys || []));
  let addedKeyCount = 0;
  let appliedKeyCount = 0;
  let fetchedOnChangedKeyCount = 0;
  let lastTsChangedKeyCount = 0;
  let pointCountChangedKeyCount = 0;
  let unchangedKeyCount = 0;
  let updatedKeyCount = 0;

  for (const cacheKey of updatedCacheKeys) {
    const previousEntry = args.previousCache?.[cacheKey];
    const nextEntry = args.nextCache?.[cacheKey];
    const previousPointCount = getCacheEntryPointCount(previousEntry);
    const nextPointCount = getCacheEntryPointCount(nextEntry);
    const previousLastTs = getCacheEntryLastTs(previousEntry);
    const nextLastTs = getCacheEntryLastTs(nextEntry);
    const previousFetchedOn = previousEntry?.fetchedOn;
    const nextFetchedOn = nextEntry?.fetchedOn;
    const entryChanged =
      previousEntry !== nextEntry &&
      (previousFetchedOn !== nextFetchedOn ||
        previousLastTs !== nextLastTs ||
        previousPointCount !== nextPointCount);

    if (!previousEntry && nextEntry) {
      addedKeyCount += 1;
    }

    if (previousEntry && nextEntry && entryChanged) {
      updatedKeyCount += 1;
    }

    if (previousFetchedOn !== nextFetchedOn) {
      fetchedOnChangedKeyCount += 1;
    }

    if (previousLastTs !== nextLastTs) {
      lastTsChangedKeyCount += 1;
    }

    if (previousPointCount !== nextPointCount) {
      pointCountChangedKeyCount += 1;
    }

    if (entryChanged || (!previousEntry && !!nextEntry)) {
      appliedKeyCount += 1;
    } else {
      unchangedKeyCount += 1;
    }
  }

  return {
    addedKeyCount,
    appliedKeyCount,
    fetchedOnChangedKeyCount,
    lastTsChangedKeyCount,
    pointCountChangedKeyCount,
    unchangedKeyCount,
    updatedKeyCount,
  };
};
