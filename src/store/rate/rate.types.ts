import {CacheKeys, DateRanges, Rates} from './rate.models';

export enum RateActionTypes {
  SUCCESS_GET_RATES = 'RATE/SUCCESS_GET_RATES',
  FAILED_GET_RATES = 'RATE/FAILED_GET_RATES',
  UPDATE_CACHE_KEY = 'RATE/UPDATE_CACHE_KEY',
  CLEAR_RATE_STATE = 'RATE/CLEAR_RATE_STATE',
  UPSERT_FIAT_RATE_SERIES_CACHE = 'RATE/UPSERT_FIAT_RATE_SERIES_CACHE',
  PRUNE_FIAT_RATE_SERIES_CACHE = 'RATE/PRUNE_FIAT_RATE_SERIES_CACHE',
}

interface successGetRates {
  type: typeof RateActionTypes.SUCCESS_GET_RATES;
  payload: {
    rates?: Rates;
    lastDayRates?: Rates;
  };
}

interface failedGetRates {
  type: typeof RateActionTypes.FAILED_GET_RATES;
}

interface updateCacheKey {
  type: typeof RateActionTypes.UPDATE_CACHE_KEY;
  payload: {
    cacheKey: CacheKeys;
    dateRange?: DateRanges;
  };
}

interface clearRateState {
  type: typeof RateActionTypes.CLEAR_RATE_STATE;
}

interface upsertFiatRateSeriesCache {
  type: typeof RateActionTypes.UPSERT_FIAT_RATE_SERIES_CACHE;
  payload: {
    cacheKey: string;
    series: {
      fetchedOn: number;
      points: Array<{ts: number; rate: number}>;
    };
  };
}

interface pruneFiatRateSeriesCache {
  type: typeof RateActionTypes.PRUNE_FIAT_RATE_SERIES_CACHE;
  payload: {
    fiatCode: string;
  };
}

export type RateActionType =
  | successGetRates
  | failedGetRates
  | updateCacheKey
  | clearRateState
  | upsertFiatRateSeriesCache
  | pruneFiatRateSeriesCache;
