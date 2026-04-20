import {getCachedTimeframeStatus} from './chartCache';

const makeCachedTimeframe = () =>
  ({
    timeframe: '1D',
    builtAt: 1,
    schemaVersion: 6,
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
});
