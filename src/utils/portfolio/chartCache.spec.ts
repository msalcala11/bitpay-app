import {getFiatRateSeriesCacheKey} from '../../store/rate/rate.models';
import {
  BALANCE_CHART_CACHE_SCHEMA_VERSION,
  type CachedBalanceChartTimeframe,
} from '../../store/portfolio-charts';
import {
  buildBalanceChartScopeId,
  deserializeCachedTimeframeToComputedSeries,
  getCachedTimeframeStatus,
  patchCachedLatestPointWithSpotRates,
} from './chartCache';

const DEP_CACHE_KEY = getFiatRateSeriesCacheKey('USD', 'btc', 'ALL');

const makeRateCache = (args?: {fetchedOn?: number; lastTs?: number}) => {
  const fetchedOn = args?.fetchedOn ?? 100;
  const lastTs = args?.lastTs ?? 300;

  return {
    [DEP_CACHE_KEY]: {
      fetchedOn,
      points: [
        {ts: lastTs - 100, rate: 95},
        {ts: lastTs, rate: 100},
      ],
    },
  };
};

const makeCachedTimeframe = (
  overrides: Partial<CachedBalanceChartTimeframe> = {},
): CachedBalanceChartTimeframe => ({
  timeframe: 'ALL',
  builtAt: 123,
  schemaVersion: BALANCE_CHART_CACHE_SCHEMA_VERSION,
  quoteCurrency: 'USD',
  balanceOffset: 0,
  walletIds: ['wallet-1'],
  snapshotVersionSig: 'wallet-1:1',
  historicalRateDeps: [
    {
      cacheKey: DEP_CACHE_KEY,
      fetchedOn: 100,
      lastTs: 300,
    },
  ],
  lastSpotRatesByCoin: {
    btc: 100,
  },
  latestHoldingsByCoin: {
    btc: {
      units: 2,
    },
  },
  latestRemainingCostBasisFiatTotal: 150,
  ts: [100, 200, 300],
  totalFiatBalance: [100, 150, 200],
  totalUnrealizedPnlFiat: [0, 25, 50],
  totalPnlPercent: [0, 20, 33.333333],
  ...overrides,
});

describe('chartCache', () => {
  it('builds scope ids that are order-insensitive for the same wallet set', () => {
    const a = buildBalanceChartScopeId({
      walletIds: ['wallet-b', 'wallet-a', 'wallet-a'],
      quoteCurrency: 'usd',
      balanceOffset: 0,
    });
    const b = buildBalanceChartScopeId({
      walletIds: ['wallet-a', 'wallet-b'],
      quoteCurrency: 'USD',
      balanceOffset: 0,
    });

    expect(a).toBe(b);
  });

  it('deserializes cached arrays back into computed chart series', () => {
    const hydrated = deserializeCachedTimeframeToComputedSeries(
      makeCachedTimeframe({
        balanceOffset: 5,
      }),
    );

    expect(hydrated.graphPoints).toHaveLength(3);
    expect(hydrated.graphPoints[0].date).toBeInstanceOf(Date);
    expect(hydrated.graphPoints[0].value).toBe(105);
    expect(hydrated.analysisPoints[2].totalRemainingCostBasisFiat).toBe(150);
    expect(hydrated.pointByTimestamp.get(300)?.totalFiatBalance).toBe(200);
  });

  it('patches only the latest point when only spot rates change', () => {
    const cached = makeCachedTimeframe();
    const patched = patchCachedLatestPointWithSpotRates({
      cachedTimeframe: cached,
      currentSpotRatesByCoin: {
        btc: 125,
      },
    });

    expect(patched.totalFiatBalance).toEqual([100, 150, 250]);
    expect(patched.totalUnrealizedPnlFiat).toEqual([0, 25, 100]);
    expect(patched.totalPnlPercent[0]).toBe(0);
    expect(patched.totalPnlPercent[1]).toBe(20);
    expect(patched.totalPnlPercent[2]).toBeCloseTo(66.666666, 4);
    expect(patched.lastSpotRatesByCoin.btc).toBe(125);
  });

  it('marks cached timeframes fresh when snapshots, historical deps, and spot rates match', () => {
    expect(
      getCachedTimeframeStatus({
        cachedTimeframe: makeCachedTimeframe(),
        snapshotVersionSig: 'wallet-1:1',
        currentSpotRatesByCoin: {
          btc: 100,
        },
        fiatRateSeriesCache: makeRateCache(),
      }),
    ).toBe('fresh');
  });

  it('marks cached timeframes patchable when only spot rates changed', () => {
    expect(
      getCachedTimeframeStatus({
        cachedTimeframe: makeCachedTimeframe(),
        snapshotVersionSig: 'wallet-1:1',
        currentSpotRatesByCoin: {
          btc: 110,
        },
        fiatRateSeriesCache: makeRateCache(),
      }),
    ).toBe('patchable');
  });

  it('marks cached timeframes stale when historical fiat dependencies changed', () => {
    expect(
      getCachedTimeframeStatus({
        cachedTimeframe: makeCachedTimeframe(),
        snapshotVersionSig: 'wallet-1:1',
        currentSpotRatesByCoin: {
          btc: 100,
        },
        fiatRateSeriesCache: makeRateCache({
          fetchedOn: 101,
        }),
      }),
    ).toBe('stale_historical');
  });
});
