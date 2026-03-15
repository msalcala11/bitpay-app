import {getFiatRateSeriesCacheKey} from '../../store/rate/rate.models';
import {
  computeFiatRateSeriesCacheRevision,
  getRelevantFiatRateSeriesCacheKeys,
} from './balanceHistoryChartRateCacheRevision';

describe('balanceHistoryChartRateCacheRevision', () => {
  it('returns stable sorted relevant cache keys with deduped ALL-backed timeframes', () => {
    expect(
      getRelevantFiatRateSeriesCacheKeys({
        fiatCode: 'usd',
        coins: ['eth', 'btc', 'eth'],
        timeframes: ['3M', '1W', '1Y'],
      }),
    ).toEqual([
      getFiatRateSeriesCacheKey('USD', 'btc', '1W'),
      getFiatRateSeriesCacheKey('USD', 'btc', 'ALL'),
      getFiatRateSeriesCacheKey('USD', 'eth', '1W'),
      getFiatRateSeriesCacheKey('USD', 'eth', 'ALL'),
    ]);
  });

  it('changes revision when a relevant cache entry updates', () => {
    const relevantKeys = getRelevantFiatRateSeriesCacheKeys({
      fiatCode: 'USD',
      coins: ['btc'],
      timeframes: ['1W', '3M'],
    });
    const unrelatedKey = getFiatRateSeriesCacheKey('USD', 'eth', 'ALL');
    const initialCache = {
      [relevantKeys[0]]: {
        fetchedOn: 10,
        points: [],
      },
      [relevantKeys[1]]: {
        fetchedOn: 20,
        points: [],
      },
      [unrelatedKey]: {
        fetchedOn: 999,
        points: [],
      },
    };
    const updatedCache = {
      ...initialCache,
      [relevantKeys[1]]: {
        ...initialCache[relevantKeys[1]],
        fetchedOn: 21,
      },
    };

    expect(
      computeFiatRateSeriesCacheRevision({
        fiatRateSeriesCache: initialCache,
        relevantKeys,
      }),
    ).toBe('2:20');
    expect(
      computeFiatRateSeriesCacheRevision({
        fiatRateSeriesCache: updatedCache,
        relevantKeys,
      }),
    ).toBe('2:21');
  });

  it('does not change revision when only unrelated cache entries update', () => {
    const relevantKeys = getRelevantFiatRateSeriesCacheKeys({
      fiatCode: 'USD',
      coins: ['btc'],
      timeframes: ['1W', '3M'],
    });
    const unrelatedKey = getFiatRateSeriesCacheKey('USD', 'eth', 'ALL');
    const initialCache = {
      [relevantKeys[0]]: {
        fetchedOn: 10,
        points: [],
      },
      [relevantKeys[1]]: {
        fetchedOn: 20,
        points: [],
      },
      [unrelatedKey]: {
        fetchedOn: 100,
        points: [],
      },
    };
    const updatedCache = {
      ...initialCache,
      [unrelatedKey]: {
        ...initialCache[unrelatedKey],
        fetchedOn: 101,
      },
    };

    expect(
      computeFiatRateSeriesCacheRevision({
        fiatRateSeriesCache: initialCache,
        relevantKeys,
      }),
    ).toBe(
      computeFiatRateSeriesCacheRevision({
        fiatRateSeriesCache: updatedCache,
        relevantKeys,
      }),
    );
  });

  it('stays stable and does not throw when relevant keys are missing', () => {
    const relevantKeys = getRelevantFiatRateSeriesCacheKeys({
      fiatCode: 'USD',
      coins: ['btc', 'eth'],
      timeframes: ['1D', 'ALL'],
    });
    const cacheWithOnlyUnrelatedEntries = {
      [getFiatRateSeriesCacheKey('USD', 'doge', 'ALL')]: {
        fetchedOn: 500,
        points: [],
      },
      malformed: null,
    } as any;

    expect(() =>
      computeFiatRateSeriesCacheRevision({
        fiatRateSeriesCache: cacheWithOnlyUnrelatedEntries,
        relevantKeys,
      }),
    ).not.toThrow();
    expect(
      computeFiatRateSeriesCacheRevision({
        fiatRateSeriesCache: cacheWithOnlyUnrelatedEntries,
        relevantKeys,
      }),
    ).toBe('0:0');
    expect(
      computeFiatRateSeriesCacheRevision({
        fiatRateSeriesCache: undefined,
        relevantKeys,
      }),
    ).toBe('0:0');
  });
});
