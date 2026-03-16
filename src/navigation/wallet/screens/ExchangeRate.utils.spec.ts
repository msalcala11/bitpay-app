jest.mock('../../../utils/helper-methods', () => ({
  getLastDayTimestampStartOfHourMs: (nowMs: number = Date.now()) => {
    const msPerHour = 60 * 60 * 1000;
    const msPerDay = 24 * msPerHour;
    return Math.floor((nowMs - msPerDay) / msPerHour) * msPerHour;
  },
}));

import type {FiatRateSeriesCache} from '../../../store/rate/rate.models';
import {getFiatRateSeriesCacheKey} from '../../../store/rate/rate.models';
import {getExchangeRateTimeframeChange} from './ExchangeRate.utils';

const NOW_MS = Date.UTC(2026, 0, 2, 12, 0, 0, 0);
const BASELINE_TS = Date.UTC(2026, 0, 1, 12, 0, 0, 0);

const ETH_USDC_IDENTITY = {
  chain: 'eth',
  tokenAddress: '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
};

const BASE_USDC_IDENTITY = {
  chain: 'base',
  tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
};

describe('getExchangeRateTimeframeChange', () => {
  it('uses the same identity as the selected chart series', () => {
    const fiatRateSeriesCache: FiatRateSeriesCache = {
      [getFiatRateSeriesCacheKey('USD', 'usdc', '1D', ETH_USDC_IDENTITY)]: {
        fetchedOn: NOW_MS,
        points: [
          {ts: BASELINE_TS, rate: 1},
          {ts: NOW_MS, rate: 2},
        ],
      },
      [getFiatRateSeriesCacheKey('USD', 'usdc', '1D', BASE_USDC_IDENTITY)]: {
        fetchedOn: NOW_MS,
        points: [
          {ts: BASELINE_TS, rate: 10},
          {ts: NOW_MS, rate: 15},
        ],
      },
    };
    const selectedSeriesKey = getFiatRateSeriesCacheKey(
      'USD',
      'usdc',
      '1D',
      BASE_USDC_IDENTITY,
    );
    const selectedSeries = fiatRateSeriesCache[selectedSeriesKey]?.points;

    const result = getExchangeRateTimeframeChange({
      fiatRateSeriesCache,
      fiatCode: 'USD',
      normalizedCoin: 'usdc',
      timeframe: '1D',
      historicalRateIdentity: BASE_USDC_IDENTITY,
      nowMs: NOW_MS,
    });

    expect(selectedSeries).toEqual([
      {ts: BASELINE_TS, rate: 10},
      {ts: NOW_MS, rate: 15},
    ]);
    expect(result).toEqual({
      timeframe: '1D',
      baselineTimestampMs: selectedSeries![0].ts,
      baselineRate: selectedSeries![0].rate,
      currentRate: selectedSeries![1].rate,
      priceChange: 5,
      percentChange: 50,
      percentRatio: 0.5,
    });
  });
});
