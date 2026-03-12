import {
  cancelPopulatePortfolio,
  finishPopulatePortfolio,
  setWalletSnapshots,
  startPopulatePortfolio,
} from './portfolio.actions';
import type {BalanceSnapshot} from './portfolio.models';
import {portfolioReducer} from './portfolio.reducer';

const makeSnapshot = (id: string): BalanceSnapshot => ({
  id,
  chain: 'matic',
  coin: 'usdc.e',
  network: 'livenet',
  assetId: 'matic:usdc.e',
  timestamp: 1,
  eventType: 'tx',
  cryptoBalance: '1',
  avgCostFiatPerUnit: 1,
  remainingCostBasisFiat: 1,
  unrealizedPnlFiat: 0,
  quoteCurrency: 'USD',
});

describe('portfolioReducer', () => {
  it('ignores a stale finish action from an older populate run', () => {
    let state = portfolioReducer(undefined, {type: '@@INIT'} as any);

    state = portfolioReducer(
      state,
      startPopulatePortfolio({quoteCurrency: 'USD', runId: 'run-1'}),
    );
    state = portfolioReducer(state, cancelPopulatePortfolio());
    state = portfolioReducer(
      state,
      startPopulatePortfolio({quoteCurrency: 'USD', runId: 'run-2'}),
    );
    state = portfolioReducer(
      state,
      finishPopulatePortfolio({finishedAt: 123, runId: 'run-1'}),
    );

    expect(state.populateStatus.inProgress).toBe(true);
    expect(state.populateStatus.runId).toBe('run-2');
    expect(state.lastPopulatedAt).toBeUndefined();
  });

  it('ignores stale snapshots from an older populate run', () => {
    let state = portfolioReducer(undefined, {type: '@@INIT'} as any);

    state = portfolioReducer(
      state,
      startPopulatePortfolio({quoteCurrency: 'USD', runId: 'run-2'}),
    );
    state = portfolioReducer(
      state,
      setWalletSnapshots({
        runId: 'run-1',
        walletId: 'wallet-1',
        snapshots: [makeSnapshot('stale')],
      }),
    );

    expect(state.snapshotsByWalletId['wallet-1']).toBeUndefined();

    state = portfolioReducer(
      state,
      setWalletSnapshots({
        runId: 'run-2',
        walletId: 'wallet-1',
        snapshots: [makeSnapshot('fresh')],
      }),
    );

    expect(state.snapshotsByWalletId['wallet-1']).toEqual([
      makeSnapshot('fresh'),
    ]);
  });
});
