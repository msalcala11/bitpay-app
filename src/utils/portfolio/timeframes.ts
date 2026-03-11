import type {FiatRateInterval} from '../../store/rate/rate.models';

const DAY_MS = 24 * 60 * 60 * 1000;

export const getSeriesIntervalForFiatTimeframe = (
  timeframe: FiatRateInterval,
): FiatRateInterval => {
  switch (timeframe) {
    case '3M':
    case '1Y':
    case '5Y':
      return 'ALL';
    default:
      return timeframe;
  }
};

export const getFiatTimeframeWindowMs = (
  timeframe: Exclude<FiatRateInterval, 'ALL'>,
): number => {
  switch (timeframe) {
    case '1D':
      return 1 * DAY_MS;
    case '1W':
      return 7 * DAY_MS;
    case '1M':
      return 30 * DAY_MS;
    case '3M':
      return 90 * DAY_MS;
    case '1Y':
      return 365 * DAY_MS;
    case '5Y':
      return 1825 * DAY_MS;
  }
};
