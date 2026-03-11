import {setWalletSnapshots, removeWalletSnapshots} from '../portfolio/portfolio.actions';
import {
  pruneBalanceChartCache,
  touchBalanceChartScope,
  upsertBalanceChartScopeTimeframes,
} from './portfolio-chart.actions';
import {
  BALANCE_CHART_CACHE_SCHEMA_VERSION,
  BALANCE_CHART_CACHE_MAX_SCOPES,
  type CachedBalanceChartTimeframe,
} from './portfolio-chart.models';
import {portfolioChartReducer} from './portfolio-chart.reducer';

const makeTimeframe = (
  timeframe: CachedBalanceChartTimeframe['timeframe'] = 'ALL',
): CachedBalanceChartTimeframe => ({
  timeframe,
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
});

describe('portfolioChartReducer', () => {
  it('bumps the wallet snapshot version when snapshots are set', () => {
    let state = portfolioChartReducer(undefined, {type: '@@INIT'} as any);

    state = portfolioChartReducer(
      state,
      setWalletSnapshots({
        walletId: 'wallet-1',
        snapshots: [],
      }),
    );
    state = portfolioChartReducer(
      state,
      setWalletSnapshots({
        walletId: 'wallet-1',
        snapshots: [],
      }),
    );

    expect(state.walletSnapshotVersionById['wallet-1']).toBe(2);
  });

  it('removes snapshot versions and cached scopes for removed wallets', () => {
    let state = portfolioChartReducer(undefined, {type: '@@INIT'} as any);

    state = portfolioChartReducer(
      state,
      upsertBalanceChartScopeTimeframes({
        scopeId: 'scope:wallet-1',
        walletIds: ['wallet-1'],
        quoteCurrency: 'USD',
        balanceOffset: 0,
        timeframes: [makeTimeframe()],
      }),
    );
    state = portfolioChartReducer(
      state,
      setWalletSnapshots({
        walletId: 'wallet-1',
        snapshots: [],
      }),
    );

    state = portfolioChartReducer(
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
    let state = portfolioChartReducer(undefined, {type: '@@INIT'} as any);

    state = portfolioChartReducer(
      state,
      upsertBalanceChartScopeTimeframes({
        scopeId: 'scope-1',
        walletIds: ['wallet-1'],
        quoteCurrency: 'USD',
        balanceOffset: 0,
        timeframes: [makeTimeframe()],
      }),
    );
    state = portfolioChartReducer(
      state,
      upsertBalanceChartScopeTimeframes({
        scopeId: 'scope-2',
        walletIds: ['wallet-2'],
        quoteCurrency: 'USD',
        balanceOffset: 0,
        timeframes: [makeTimeframe()],
      }),
    );
    state = portfolioChartReducer(
      state,
      upsertBalanceChartScopeTimeframes({
        scopeId: 'scope-3',
        walletIds: ['wallet-3'],
        quoteCurrency: 'USD',
        balanceOffset: 0,
        timeframes: [makeTimeframe()],
      }),
    );
    state = portfolioChartReducer(
      state,
      touchBalanceChartScope({
        scopeId: 'scope-1',
      }),
    );

    state = portfolioChartReducer(
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
});
