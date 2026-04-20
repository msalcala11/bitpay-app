import {
  getFiatRateSeriesCacheKey,
  type FiatRateSeriesCache,
} from '../../store/rate/rate.models';
import {
  calculatePercentageDifferenceRaw,
  getFiatRateChangeForTimeframe,
} from './rate';

describe('calculatePercentageDifferenceRaw', () => {
  it('preserves raw precision', () => {
    expect(calculatePercentageDifferenceRaw(110.123456, 100)).toBeCloseTo(
      10.123456,
      6,
    );
  });
});

describe('getFiatRateChangeForTimeframe', () => {
  it('returns an unrounded percent change for exchange rate timeframes', () => {
    const fiatRateSeriesCache: FiatRateSeriesCache = {
      [getFiatRateSeriesCacheKey('USD', 'eth', 'ALL')]: {
        fetchedOn: 1,
        points: [
          {ts: 1, rate: 100},
          {ts: 2, rate: 105},
        ],
      },
    };

    const result = getFiatRateChangeForTimeframe({
      fiatRateSeriesCache,
      fiatCode: 'USD',
      currencyAbbreviation: 'eth',
      timeframe: 'ALL',
      currentRate: 110.123456,
      nowMs: 2,
    });

    expect(result?.percentChange).toBeCloseTo(10.123456, 6);
    expect(result?.percentRatio).toBeCloseTo(0.10123456, 8);
  });
});
