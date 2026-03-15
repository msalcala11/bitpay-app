import type {
  FiatRateInterval,
  FiatRateSeriesCache,
} from '../../store/rate/rate.models';
import {getFiatRateSeriesCacheKey} from '../../store/rate/rate.models';
import {getSeriesIntervalForFiatTimeframe} from './fiatTimeframes';

export const getRelevantFiatRateSeriesCacheKeys = (args: {
  fiatCode: string;
  coins: string[];
  timeframes: FiatRateInterval[];
}): string[] => {
  const keys = new Set<string>();

  for (const coin of args.coins || []) {
    if (typeof coin !== 'string' || !coin.trim()) {
      continue;
    }

    for (const timeframe of args.timeframes || []) {
      keys.add(
        getFiatRateSeriesCacheKey(
          args.fiatCode,
          coin,
          getSeriesIntervalForFiatTimeframe(timeframe),
        ),
      );
    }
  }

  return Array.from(keys).sort((a, b) => a.localeCompare(b));
};

export const computeFiatRateSeriesCacheRevision = (args: {
  fiatRateSeriesCache?: FiatRateSeriesCache;
  relevantKeys: string[];
}): string => {
  let keysPresentCount = 0;
  let maxFetchedOn = 0;
  const cache = args.fiatRateSeriesCache;
  const relevantKeys = new Set(args.relevantKeys || []);

  for (const key of relevantKeys) {
    if (!Object.prototype.hasOwnProperty.call(cache || {}, key)) {
      continue;
    }

    keysPresentCount += 1;

    const fetchedOn = cache?.[key]?.fetchedOn;
    if (typeof fetchedOn === 'number' && Number.isFinite(fetchedOn)) {
      maxFetchedOn = Math.max(maxFetchedOn, fetchedOn);
    }
  }

  return `${keysPresentCount}:${maxFetchedOn}`;
};
