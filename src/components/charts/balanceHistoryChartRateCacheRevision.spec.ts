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

  it('keeps same-coin assets on different chains/tokens as distinct relevant keys', () => {
    expect(
      getRelevantFiatRateSeriesCacheKeys({
        fiatCode: 'usd',
        assets: [
          {
            coin: 'usdc',
            chain: 'eth',
            tokenAddress: '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          },
          {
            coin: 'usdc',
            chain: 'base',
            tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          },
        ],
        timeframes: ['1D', '3M'],
      }),
    ).toEqual([
      getFiatRateSeriesCacheKey('USD', 'usdc', '1D', {
        chain: 'base',
        tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      }),
      getFiatRateSeriesCacheKey('USD', 'usdc', 'ALL', {
        chain: 'base',
        tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      }),
      getFiatRateSeriesCacheKey('USD', 'usdc', '1D', {
        chain: 'eth',
        tokenAddress: '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      }),
      getFiatRateSeriesCacheKey('USD', 'usdc', 'ALL', {
        chain: 'eth',
        tokenAddress: '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      }),
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
      [relevantKeys[0]]: {
        ...initialCache[relevantKeys[0]],
        fetchedOn: 15,
      },
    };

    expect(
      computeFiatRateSeriesCacheRevision({
        fiatRateSeriesCache: initialCache,
        relevantKeys,
      }),
    ).not.toBe(
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
    ).toContain('0:0');
    expect(
      computeFiatRateSeriesCacheRevision({
        fiatRateSeriesCache: undefined,
        relevantKeys,
      }),
    ).toContain('0:0');
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
});
