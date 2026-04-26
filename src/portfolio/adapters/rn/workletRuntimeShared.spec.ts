import {
  clearPortfolioTxHistorySigningDispatchContextOnRuntime,
  getPortfolioTxHistorySigningDispatchContextOnRuntime,
  setPortfolioTxHistorySigningDispatchContextOnRuntime,
} from './txHistorySigning';
import {
  initializePortfolioPopulateRuntimeGlobals as initializePopulateGlobals,
  initializePortfolioRateFetchRuntimeGlobals as initializeRateFetchGlobals,
} from './workletRuntimeShared';

describe('portfolio worklet runtime shared initializers', () => {
  afterEach(() => {
    clearPortfolioTxHistorySigningDispatchContextOnRuntime();
  });

  it('keeps populate signing context available but clears it for rate-fetch', () => {
    setPortfolioTxHistorySigningDispatchContextOnRuntime({
      requestPrivKey: 'populate-secret',
      requestPubKey: 'populate-public',
    });

    initializePopulateGlobals();
    expect(
      getPortfolioTxHistorySigningDispatchContextOnRuntime()?.requestPrivKey,
    ).toBe('populate-secret');

    initializeRateFetchGlobals();
    expect(getPortfolioTxHistorySigningDispatchContextOnRuntime()).toBe(
      undefined,
    );
  });
});
