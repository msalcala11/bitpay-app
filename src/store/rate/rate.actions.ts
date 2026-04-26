import {CacheKeys, DateRanges, FiatRateSeries, Rates} from './rate.models';
import {RateActionType, RateActionTypes} from './rate.types';

export const successGetRates = (payload: {
  rates: Rates;
  lastDayRates: Rates;
}): RateActionType => ({
  type: RateActionTypes.SUCCESS_GET_RATES,
  payload,
});

export const failedGetRates = (): RateActionType => ({
  type: RateActionTypes.FAILED_GET_RATES,
});

export const updateCacheKey = (payload: {
  cacheKey: CacheKeys;
  dateRange?: DateRanges;
}): RateActionType => ({
  type: RateActionTypes.UPDATE_CACHE_KEY,
  payload,
});

export const clearRateState = (): RateActionType => ({
  type: RateActionTypes.CLEAR_RATE_STATE,
});

export const upsertFiatRateSeriesCache = (payload: {
  cacheKey: string;
  series: FiatRateSeries;
}): RateActionType => ({
  type: RateActionTypes.UPSERT_FIAT_RATE_SERIES_CACHE,
  payload,
});

export const pruneFiatRateSeriesCache = (payload: {
  fiatCode: string;
}): RateActionType => ({
  type: RateActionTypes.PRUNE_FIAT_RATE_SERIES_CACHE,
  payload,
});
