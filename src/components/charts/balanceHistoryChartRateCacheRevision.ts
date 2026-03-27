import type {
  FiatRateSeriesAssetIdentity,
  FiatRateInterval,
  FiatRateSeriesCache,
} from '../../store/rate/rate.models';
import {getFiatRateSeriesCacheKey} from '../../store/rate/rate.models';
import {getSeriesIntervalForFiatTimeframe} from './fiatTimeframes';

export type FiatRateSeriesCacheRevisionStateEntry = {
  cacheKey: string;
  fetchedOn?: number;
  lastTs?: number;
  pointCount: number;
  present: boolean;
};

export type FiatRateSeriesCacheRevisionInfo = {
  maxFetchedOn: number;
  missingKeyCount: number;
  presentKeyCount: number;
  revision: string;
  state: FiatRateSeriesCacheRevisionStateEntry[];
  totalKeyCount: number;
};

export type FiatRateSeriesCacheRevisionChangeSummary = {
  addedCount: number;
  changedKeyCount: number;
  changedKeyReasonSample: string[];
  changedKeySample: string[];
  fetchedOnChangedCount: number;
  lastTsChangedCount: number;
  missingKeyCount: number;
  pointCountChangedCount: number;
  presentKeyCount: number;
  removedCount: number;
  totalKeyCount: number;
};

const getRevisionStateEntry = (
  cache: FiatRateSeriesCache | undefined,
  cacheKey: string,
): FiatRateSeriesCacheRevisionStateEntry => {
  const isPresent = Object.prototype.hasOwnProperty.call(cache || {}, cacheKey);
  if (!isPresent) {
    return {
      cacheKey,
      pointCount: 0,
      present: false,
    };
  }

  const entry = cache?.[cacheKey];
  const fetchedOn = entry?.fetchedOn;
  const points = Array.isArray(entry?.points) ? entry.points : undefined;
  const pointCount = points?.length || 0;
  const lastPointTs = pointCount ? Number(points?.[pointCount - 1]?.ts) : NaN;

  return {
    cacheKey,
    fetchedOn:
      typeof fetchedOn === 'number' && Number.isFinite(fetchedOn)
        ? fetchedOn
        : undefined,
    lastTs: Number.isFinite(lastPointTs) ? lastPointTs : undefined,
    pointCount,
    present: true,
  };
};

export const getRelevantFiatRateSeriesCacheKeys = (args: {
  fiatCode: string;
  coins?: string[];
  assets?: FiatRateSeriesAssetIdentity[];
  timeframes: FiatRateInterval[];
}): string[] => {
  const keys = new Set<string>();

  const assets =
    args.assets ||
    (args.coins || []).map(coin => ({
      coin,
    }));

  for (const asset of assets) {
    const coin = typeof asset?.coin === 'string' ? asset.coin : '';
    if (!coin.trim()) {
      continue;
    }

    for (const timeframe of args.timeframes || []) {
      keys.add(
        getFiatRateSeriesCacheKey(
          args.fiatCode,
          coin,
          getSeriesIntervalForFiatTimeframe(timeframe),
          {
            chain: asset?.chain,
            tokenAddress: asset?.tokenAddress,
          },
        ),
      );
    }
  }

  return Array.from(keys).sort((a, b) => a.localeCompare(b));
};

export const buildFiatRateSeriesCacheRevisionInfo = (args: {
  fiatRateSeriesCache?: FiatRateSeriesCache;
  relevantKeys: string[];
}): FiatRateSeriesCacheRevisionInfo => {
  let presentKeyCount = 0;
  let maxFetchedOn = 0;
  const cache = args.fiatRateSeriesCache;
  const relevantKeys = Array.from(new Set(args.relevantKeys || [])).sort(
    (a, b) => a.localeCompare(b),
  );
  const fetchedOnSignatureParts: string[] = [];
  const state = relevantKeys.map(cacheKey => getRevisionStateEntry(cache, cacheKey));

  for (const entry of state) {
    if (!entry.present) {
      fetchedOnSignatureParts.push(`${entry.cacheKey}:missing`);
      continue;
    }

    presentKeyCount += 1;

    fetchedOnSignatureParts.push(
      `${entry.cacheKey}:${entry.fetchedOn ?? 'na'}:${entry.lastTs ?? 'na'}`,
    );

    if (typeof entry.fetchedOn === 'number' && Number.isFinite(entry.fetchedOn)) {
      maxFetchedOn = Math.max(maxFetchedOn, entry.fetchedOn);
    }
  }

  return {
    maxFetchedOn,
    missingKeyCount: Math.max(0, relevantKeys.length - presentKeyCount),
    presentKeyCount,
    revision: [
      `${presentKeyCount}:${maxFetchedOn}`,
      fetchedOnSignatureParts.join('|'),
    ].join(':'),
    state,
    totalKeyCount: relevantKeys.length,
  };
};

export const computeFiatRateSeriesCacheRevision = (args: {
  fiatRateSeriesCache?: FiatRateSeriesCache;
  relevantKeys: string[];
}): string => buildFiatRateSeriesCacheRevisionInfo(args).revision;

export const summarizeFiatRateSeriesCacheRevisionChange = (args: {
  previousState?: FiatRateSeriesCacheRevisionStateEntry[];
  nextState?: FiatRateSeriesCacheRevisionStateEntry[];
  maxSampleSize?: number;
}): FiatRateSeriesCacheRevisionChangeSummary => {
  const previousStateByKey = new Map(
    (args.previousState || []).map(entry => [entry.cacheKey, entry]),
  );
  const nextState = args.nextState || [];
  const nextStateByKey = new Map(nextState.map(entry => [entry.cacheKey, entry]));
  const cacheKeys = Array.from(
    new Set([
      ...Array.from(previousStateByKey.keys()),
      ...Array.from(nextStateByKey.keys()),
    ]),
  ).sort((a, b) => a.localeCompare(b));
  const maxSampleSize = Math.max(1, args.maxSampleSize || 6);
  const changedKeySample: string[] = [];
  const changedKeyReasonSample: string[] = [];
  let changedKeyCount = 0;
  let addedCount = 0;
  let removedCount = 0;
  let fetchedOnChangedCount = 0;
  let lastTsChangedCount = 0;
  let pointCountChangedCount = 0;

  for (const cacheKey of cacheKeys) {
    const previousEntry = previousStateByKey.get(cacheKey) || {
      cacheKey,
      pointCount: 0,
      present: false,
    };
    const nextEntry = nextStateByKey.get(cacheKey) || {
      cacheKey,
      pointCount: 0,
      present: false,
    };
    const reasons: string[] = [];

    if (!previousEntry.present && nextEntry.present) {
      addedCount += 1;
      reasons.push('added');
    } else if (previousEntry.present && !nextEntry.present) {
      removedCount += 1;
      reasons.push('removed');
    } else if (previousEntry.present && nextEntry.present) {
      if (previousEntry.fetchedOn !== nextEntry.fetchedOn) {
        fetchedOnChangedCount += 1;
        reasons.push('fetchedOn');
      }

      if (previousEntry.lastTs !== nextEntry.lastTs) {
        lastTsChangedCount += 1;
        reasons.push('lastTs');
      }

      if (previousEntry.pointCount !== nextEntry.pointCount) {
        pointCountChangedCount += 1;
        reasons.push('pointCount');
      }
    }

    if (!reasons.length) {
      continue;
    }

    changedKeyCount += 1;

    if (changedKeySample.length < maxSampleSize) {
      changedKeySample.push(cacheKey);
      changedKeyReasonSample.push(`${cacheKey}:${reasons.join(',')}`);
    }
  }

  return {
    addedCount,
    changedKeyCount,
    changedKeyReasonSample,
    changedKeySample,
    fetchedOnChangedCount,
    lastTsChangedCount,
    missingKeyCount: nextState.filter(entry => !entry.present).length,
    pointCountChangedCount,
    presentKeyCount: nextState.filter(entry => entry.present).length,
    removedCount,
    totalKeyCount: nextState.length,
  };
};
