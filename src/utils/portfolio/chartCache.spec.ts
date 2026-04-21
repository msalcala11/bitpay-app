import {
  deserializeCachedTimeframeToComputedSeries,
  getCachedTimeframeStatus,
  patchCachedLatestPointWithSpotRates,
} from './chartCache';

const makeCachedTimeframe = () =>
  ({
    timeframe: '1D',
    builtAt: 1,
    schemaVersion: 7,
    quoteCurrency: 'USD',
    balanceOffset: 0,
    walletIds: ['w1'],
    dataRevisionSig: 'rev-1',
    historicalRateDeps: [],
    lastSpotRatesByRateKey: {
      eth: 100,
    },
    latestHoldingsByRateKey: {
      eth: {units: 1},
    },
    latestRemainingCostBasisFiatTotal: 100,
    ts: [1, 2],
    totalFiatBalance: [100, 100],
    totalPnlChange: [0, 0],
    totalUnrealizedPnlFiat: [0, 0],
    totalPnlPercent: [0, 0],
  }) as any;

describe('chartCache', () => {
  it('marks cached charts patchable when spot rates changed and patch metadata is usable', () => {
    expect(
      getCachedTimeframeStatus({
        cachedTimeframe: makeCachedTimeframe(),
        dataRevisionSig: 'rev-1',
        currentSpotRatesByRateKey: {
          eth: 120,
        },
        fiatRateSeriesCache: undefined,
      }),
    ).toBe('patchable');
  });

  it('marks cached charts patchable when asOfMs advances even if spot rates are unchanged', () => {
    expect(
      getCachedTimeframeStatus({
        cachedTimeframe: makeCachedTimeframe(),
        dataRevisionSig: 'rev-1',
        currentSpotRatesByRateKey: {
          eth: 100,
        },
        asOfMs: 10,
        fiatRateSeriesCache: undefined,
      }),
    ).toBe('patchable');
  });

  it('forces a refresh when live spot rates changed but cached charts cannot be patched', () => {
    expect(
      getCachedTimeframeStatus({
        cachedTimeframe: makeCachedTimeframe(),
        dataRevisionSig: 'rev-1',
        currentSpotRatesByRateKey: {},
        fiatRateSeriesCache: undefined,
      }),
    ).toBe('stale_historical');
  });

  it('marks cached charts stale when historical rate dependencies changed', () => {
    const cachedTimeframe = makeCachedTimeframe();
    cachedTimeframe.historicalRateDeps = [
      {
        cacheKey: 'USD:btc:ALL',
        fetchedOn: 10,
        lastTs: 20,
      },
    ];

    expect(
      getCachedTimeframeStatus({
        cachedTimeframe,
        dataRevisionSig: 'rev-1',
        currentSpotRatesByRateKey: {
          eth: 100,
        },
        fiatRateSeriesCache: {
          'USD:btc:ALL': {
            fetchedOn: 11,
            points: [{ts: 20, rate: 1}],
          },
        },
      }),
    ).toBe('stale_historical');
  });

  it('marks cached charts pending while historical rate dependencies are still loading', () => {
    const cachedTimeframe = makeCachedTimeframe();
    cachedTimeframe.historicalRateDeps = [
      {
        cacheKey: 'USD:btc:ALL',
        fetchedOn: 10,
        lastTs: 20,
      },
    ];

    expect(
      getCachedTimeframeStatus({
        cachedTimeframe,
        dataRevisionSig: 'rev-1',
        currentSpotRatesByRateKey: {
          eth: 100,
        },
        fiatRateSeriesCache: undefined,
      }),
    ).toBe('pending_historical');
  });

  it('patches final total pnl change when live spot rates change', () => {
    expect(
      patchCachedLatestPointWithSpotRates({
        cachedTimeframe: makeCachedTimeframe(),
        currentSpotRatesByRateKey: {
          eth: 120,
        },
        patchedAt: 10,
      }).totalPnlChange,
    ).toEqual([0, 20]);
  });

  it('patches the effective final timestamp when spot rates are overlaid', () => {
    expect(
      patchCachedLatestPointWithSpotRates({
        cachedTimeframe: makeCachedTimeframe(),
        currentSpotRatesByRateKey: {
          eth: 120,
        },
        patchedAt: 10,
      }).ts,
    ).toEqual([1, 10]);
  });

  it('patches the effective final timestamp when only asOfMs advances', () => {
    expect(
      patchCachedLatestPointWithSpotRates({
        cachedTimeframe: makeCachedTimeframe(),
        currentSpotRatesByRateKey: {
          eth: 100,
        },
        patchedAt: 10,
      }).ts,
    ).toEqual([1, 10]);
  });

  it('hydrates a live tail overlay without mutating the raw cached timeframe', () => {
    const cachedTimeframe = makeCachedTimeframe();

    const hydrated = deserializeCachedTimeframeToComputedSeries(cachedTimeframe, {
      currentSpotRatesByRateKey: {
        eth: 120,
      },
      patchedAt: 10,
    });

    expect(cachedTimeframe.ts).toEqual([1, 2]);
    expect(cachedTimeframe.totalFiatBalance).toEqual([100, 100]);
    expect(hydrated.analysisPoints[1]).toEqual(
      expect.objectContaining({
        timestamp: 10,
        totalFiatBalance: 120,
        totalPnlChange: 20,
        totalUnrealizedPnlFiat: 20,
        totalPnlPercent: 20,
      }),
    );
  });
});
