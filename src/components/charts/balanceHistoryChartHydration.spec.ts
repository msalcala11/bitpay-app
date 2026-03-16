import {
  BALANCE_CHART_CACHE_SCHEMA_VERSION,
  type CachedBalanceChartTimeframe,
} from '../../store/portfolio-charts';
import {
  buildHydratedBalanceChartTimeframes,
  getEffectiveCachedBalanceChartTimeframe,
} from './balanceHistoryChartHydration';

const createCachedTimeframe = (
  overrides: Partial<CachedBalanceChartTimeframe> = {},
): CachedBalanceChartTimeframe => ({
  timeframe: 'ALL',
  builtAt: 1_000,
  schemaVersion: BALANCE_CHART_CACHE_SCHEMA_VERSION,
  quoteCurrency: 'USD',
  balanceOffset: 0,
  walletIds: ['wallet-1'],
  snapshotVersionSig: 'snapshot-1',
  historicalRateDeps: [
    {
      cacheKey: 'USD:btc:ALL',
      fetchedOn: 100,
      lastTs: 5_000,
    },
  ],
  lastSpotRatesByRateKey: {
    btc: 100,
  },
  latestHoldingsByRateKey: {
    btc: {units: 2},
  },
  latestRemainingCostBasisFiatTotal: 150,
  ts: [1_000, 5_000],
  totalFiatBalance: [100, 200],
  totalUnrealizedPnlFiat: [10, 50],
  totalPnlPercent: [10, 33.33],
  ...overrides,
});

describe('balanceHistoryChartHydration', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('patches patchable cached timeframes before hydration', () => {
    jest.spyOn(Date, 'now').mockReturnValue(9_999);
    const cachedTimeframe = createCachedTimeframe();
    const deserializeTimeframe = jest.fn(
      (timeframe: CachedBalanceChartTimeframe) => ({
        id: `${timeframe.timeframe}:${timeframe.totalFiatBalance[1]}`,
      }),
    );
    const getTimeframeRevision = jest.fn(
      (
        timeframe: string,
        historicalRateDeps: CachedBalanceChartTimeframe['historicalRateDeps'],
      ) =>
        `revision:${timeframe}:${historicalRateDeps[0]?.cacheKey}:${historicalRateDeps[0]?.lastTs}`,
    );

    const patched = getEffectiveCachedBalanceChartTimeframe({
      cachedTimeframe,
      status: 'patchable',
      currentSpotRatesByRateKey: {btc: 120},
    });

    expect(patched.totalFiatBalance[1]).toBe(240);
    expect(patched.totalUnrealizedPnlFiat[1]).toBe(90);

    const result = buildHydratedBalanceChartTimeframes({
      timeframes: {
        ALL: cachedTimeframe,
      },
      timeframeOrder: ['ALL'],
      selectedTimeframe: 'ALL',
      cachedStatusByTimeframe: {
        ALL: 'patchable',
      },
      currentSpotRatesByRateKey: {btc: 120},
      deserializeTimeframe,
      getTimeframeRevision,
    });

    expect(result.patchedTimeframes).toEqual([patched]);
    expect(deserializeTimeframe).toHaveBeenCalledWith(patched);
    expect(result.hydratedTimeframes.ALL).toEqual({
      series: {id: 'ALL:240'},
      seriesRevision: 'revision:ALL:USD:btc:ALL:5000',
    });
    expect(result.selectedHydratedSeries).toEqual({id: 'ALL:240'});
  });

  it('marks stale historical entries with a stale revision without patching them', () => {
    const cachedTimeframe = createCachedTimeframe({
      timeframe: '1W',
      builtAt: 2_345,
    });
    const deserializeTimeframe = jest.fn(
      (timeframe: CachedBalanceChartTimeframe) => ({
        id: timeframe.timeframe,
        builtAt: timeframe.builtAt,
      }),
    );

    const result = buildHydratedBalanceChartTimeframes({
      timeframes: {
        '1W': cachedTimeframe,
      },
      timeframeOrder: ['1W'],
      selectedTimeframe: '1W',
      cachedStatusByTimeframe: {
        '1W': 'stale_historical',
      },
      currentSpotRatesByRateKey: {btc: 120},
      deserializeTimeframe,
      getTimeframeRevision: jest.fn(() => 'fresh-revision'),
    });

    expect(result.patchedTimeframes).toEqual([]);
    expect(result.hydratedTimeframes['1W']).toEqual({
      series: {id: '1W', builtAt: 2_345},
      seriesRevision: 'stale:2345:1W',
    });
    expect(result.selectedHydratedSeries).toEqual({
      id: '1W',
      builtAt: 2_345,
    });
  });
});
