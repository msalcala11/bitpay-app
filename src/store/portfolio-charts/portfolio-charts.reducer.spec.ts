import {
  clearPortfolio,
  removeWalletSnapshots,
  setWalletSnapshots,
} from '../portfolio/portfolio.actions';
import {
  clearPortfolioCharts,
  pruneBalanceChartCache,
  setHomeChartCollapsed,
  touchBalanceChartScope,
  upsertBalanceChartScopeTimeframes,
} from './portfolio-charts.actions';
import {
  BALANCE_CHART_CACHE_SCHEMA_VERSION,
  BALANCE_CHART_CACHE_MAX_SCOPES,
  type CachedBalanceChartTimeframe,
} from './portfolio-charts.models';
import {portfolioChartsReducer} from './portfolio-charts.reducer';

const makeTimeframe = (
  overrides: Partial<CachedBalanceChartTimeframe> = {},
): CachedBalanceChartTimeframe => ({
  timeframe: 'ALL',
  builtAt: 123,
  schemaVersion: BALANCE_CHART_CACHE_SCHEMA_VERSION,
  quoteCurrency: 'USD',
  balanceOffset: 0,
  walletIds: ['wallet-1'],
  snapshotVersionSig: 'wallet-1:1',
  historicalRateDeps: [],
  lastSpotRatesByCoin: {},
  latestHoldingsByCoin: {},
  latestRemainingCostBasisFiatTotal: 0,
  ts: [100],
  totalFiatBalance: [100],
  totalUnrealizedPnlFiat: [0],
  totalPnlPercent: [0],
  ...overrides,
});

describe('portfolioChartsReducer', () => {
  it('persists the home chart collapsed preference', () => {
    let state = portfolioChartsReducer(undefined, {type: '@@INIT'} as any);

    state = portfolioChartsReducer(state, setHomeChartCollapsed(true));
    expect(state.homeChartCollapsed).toBe(true);

    state = portfolioChartsReducer(state, setHomeChartCollapsed(false));
    expect(state.homeChartCollapsed).toBe(false);
  });

  it('bumps the home chart remount nonce when charts are cleared', () => {
    let state = portfolioChartsReducer(undefined, {type: '@@INIT'} as any);

    expect(state.homeChartRemountNonce).toBe(0);

    state = portfolioChartsReducer(state, clearPortfolioCharts());
    expect(state.homeChartRemountNonce).toBe(1);

    state = portfolioChartsReducer(state, clearPortfolioCharts());
    expect(state.homeChartRemountNonce).toBe(2);
  });

  it('clears cached chart state and bumps the remount nonce once on clearPortfolio', () => {
    let state = portfolioChartsReducer(undefined, {type: '@@INIT'} as any);

    state = portfolioChartsReducer(state, setHomeChartCollapsed(true));
    state = portfolioChartsReducer(
      state,
      setWalletSnapshots({
        walletId: 'wallet-1',
        snapshots: [],
      }),
    );
    state = portfolioChartsReducer(
      state,
      upsertBalanceChartScopeTimeframes({
        scopeId: 'scope-1',
        walletIds: ['wallet-1'],
        quoteCurrency: 'USD',
        balanceOffset: 0,
        timeframes: [makeTimeframe()],
      }),
    );

    expect(state.homeChartCollapsed).toBe(true);
    expect(state.homeChartRemountNonce).toBe(0);
    expect(state.walletSnapshotVersionById['wallet-1']).toBe(1);
    expect(state.cacheByScopeId['scope-1']).toBeDefined();
    expect(state.lruScopeIds).toEqual(['scope-1']);

    state = portfolioChartsReducer(state, clearPortfolio());

    expect(state.homeChartCollapsed).toBe(false);
    expect(state.homeChartRemountNonce).toBe(1);
    expect(state.walletSnapshotVersionById).toEqual({});
    expect(state.cacheByScopeId).toEqual({});
    expect(state.lruScopeIds).toEqual([]);
  });

  it('bumps the wallet snapshot version when snapshots are set', () => {
    let state = portfolioChartsReducer(undefined, {type: '@@INIT'} as any);

    state = portfolioChartsReducer(
      state,
      setWalletSnapshots({
        walletId: 'wallet-1',
        snapshots: [],
      }),
    );
    state = portfolioChartsReducer(
      state,
      setWalletSnapshots({
        walletId: 'wallet-1',
        snapshots: [],
      }),
    );

    expect(state.walletSnapshotVersionById['wallet-1']).toBe(2);
  });

  it('removes snapshot versions and cached scopes for removed wallets', () => {
    let state = portfolioChartsReducer(undefined, {type: '@@INIT'} as any);

    state = portfolioChartsReducer(
      state,
      upsertBalanceChartScopeTimeframes({
        scopeId: 'scope:wallet-1',
        walletIds: ['wallet-1'],
        quoteCurrency: 'USD',
        balanceOffset: 0,
        timeframes: [makeTimeframe()],
      }),
    );
    state = portfolioChartsReducer(
      state,
      setWalletSnapshots({
        walletId: 'wallet-1',
        snapshots: [],
      }),
    );

    state = portfolioChartsReducer(
      state,
      removeWalletSnapshots({
        walletIds: ['wallet-1'],
      }),
    );

    expect(state.walletSnapshotVersionById['wallet-1']).toBeUndefined();
    expect(state.cacheByScopeId['scope:wallet-1']).toBeUndefined();
    expect(state.lruScopeIds).toEqual([]);
  });

  it('keeps the most recently touched scopes when pruning', () => {
    let state = portfolioChartsReducer(undefined, {type: '@@INIT'} as any);

    state = portfolioChartsReducer(
      state,
      upsertBalanceChartScopeTimeframes({
        scopeId: 'scope-1',
        walletIds: ['wallet-1'],
        quoteCurrency: 'USD',
        balanceOffset: 0,
        timeframes: [makeTimeframe()],
      }),
    );
    state = portfolioChartsReducer(
      state,
      upsertBalanceChartScopeTimeframes({
        scopeId: 'scope-2',
        walletIds: ['wallet-2'],
        quoteCurrency: 'USD',
        balanceOffset: 0,
        timeframes: [makeTimeframe()],
      }),
    );
    state = portfolioChartsReducer(
      state,
      upsertBalanceChartScopeTimeframes({
        scopeId: 'scope-3',
        walletIds: ['wallet-3'],
        quoteCurrency: 'USD',
        balanceOffset: 0,
        timeframes: [makeTimeframe()],
      }),
    );
    state = portfolioChartsReducer(
      state,
      touchBalanceChartScope({
        scopeId: 'scope-1',
      }),
    );

    state = portfolioChartsReducer(
      state,
      pruneBalanceChartCache({
        maxScopes: 2,
      }),
    );

    expect(BALANCE_CHART_CACHE_MAX_SCOPES).toBeGreaterThanOrEqual(2);
    expect(state.lruScopeIds).toEqual(['scope-1', 'scope-3']);
    expect(state.cacheByScopeId['scope-1']).toBeDefined();
    expect(state.cacheByScopeId['scope-3']).toBeDefined();
    expect(state.cacheByScopeId['scope-2']).toBeUndefined();
  });

  it('deep-copies nested historical deps and holdings when upserting timeframes', () => {
    const timeframe = makeTimeframe({
      historicalRateDeps: [
        {
          cacheKey: 'USD:btc:1D',
          fetchedOn: 123,
          lastTs: 456,
        },
      ],
      latestHoldingsByCoin: {
        btc: {
          units: 2,
        },
      },
    });

    const state = portfolioChartsReducer(
      undefined,
      upsertBalanceChartScopeTimeframes({
        scopeId: 'scope-1',
        walletIds: ['wallet-1'],
        quoteCurrency: 'USD',
        balanceOffset: 0,
        timeframes: [timeframe],
      }),
    );

    timeframe.historicalRateDeps[0].fetchedOn = 999;
    timeframe.latestHoldingsByCoin.btc.units = 42;

    const stored = state.cacheByScopeId['scope-1']?.timeframes
      ?.ALL as CachedBalanceChartTimeframe;

    expect(stored.historicalRateDeps[0].fetchedOn).toBe(123);
    expect(stored.latestHoldingsByCoin.btc.units).toBe(2);
    expect(stored.historicalRateDeps[0]).not.toBe(
      timeframe.historicalRateDeps[0],
    );
    expect(stored.latestHoldingsByCoin.btc).not.toBe(
      timeframe.latestHoldingsByCoin.btc,
    );
  });

  it('does not share nested reducer state references across upserts', () => {
    const initialState = portfolioChartsReducer(
      undefined,
      upsertBalanceChartScopeTimeframes({
        scopeId: 'scope-1',
        walletIds: ['wallet-1'],
        quoteCurrency: 'USD',
        balanceOffset: 0,
        timeframes: [
          makeTimeframe({
            historicalRateDeps: [
              {
                cacheKey: 'USD:btc:1D',
                fetchedOn: 100,
                lastTs: 300,
              },
            ],
            latestHoldingsByCoin: {
              btc: {
                units: 1,
              },
            },
          }),
        ],
      }),
    );

    const updatedState = portfolioChartsReducer(
      initialState,
      upsertBalanceChartScopeTimeframes({
        scopeId: 'scope-1',
        walletIds: ['wallet-1'],
        quoteCurrency: 'USD',
        balanceOffset: 0,
        timeframes: [
          makeTimeframe({
            timeframe: '1D',
            historicalRateDeps: [
              {
                cacheKey: 'USD:btc:1D',
                fetchedOn: 101,
                lastTs: 301,
              },
            ],
            latestHoldingsByCoin: {
              btc: {
                units: 3,
              },
            },
          }),
        ],
      }),
    );

    const prevStored = initialState.cacheByScopeId['scope-1']?.timeframes
      ?.ALL as CachedBalanceChartTimeframe;
    const nextStored = updatedState.cacheByScopeId['scope-1']?.timeframes?.[
      '1D'
    ] as CachedBalanceChartTimeframe;

    expect(nextStored.historicalRateDeps[0]).not.toBe(
      prevStored.historicalRateDeps[0],
    );
    expect(nextStored.latestHoldingsByCoin.btc).not.toBe(
      prevStored.latestHoldingsByCoin.btc,
    );
  });
});
