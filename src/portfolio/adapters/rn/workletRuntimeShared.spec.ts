import {
  clearPortfolioTxHistorySigningDispatchContextOnRuntime,
  getPortfolioTxHistorySigningDispatchContextOnRuntime,
  requirePortfolioTxHistorySigningDispatchContextOnRuntime,
  setPortfolioTxHistorySigningDispatchContextOnRuntime,
  takeNextPortfolioTransferredSignHandleOnRuntime,
} from './txHistorySigning';
import {
  initializePortfolioPopulateRuntimeGlobals as initializePopulateGlobals,
  initializePortfolioRateFetchRuntimeGlobals as initializeRateFetchGlobals,
  teardownPortfolioRuntimeGlobals,
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
    expect(() =>
      requirePortfolioTxHistorySigningDispatchContextOnRuntime(),
    ).toThrow('No portfolio runtime request context is initialized');
    expect(() => takeNextPortfolioTransferredSignHandleOnRuntime()).toThrow(
      'No portfolio runtime request context is initialized',
    );
  });

  it('tears down populate and rate-fetch signing globals without touching compute', () => {
    setPortfolioTxHistorySigningDispatchContextOnRuntime({
      requestPrivKey: 'populate-secret',
      requestPubKey: 'populate-public',
    });

    teardownPortfolioRuntimeGlobals('compute');
    expect(getPortfolioTxHistorySigningDispatchContextOnRuntime()).toEqual(
      expect.objectContaining({requestPrivKey: 'populate-secret'}),
    );

    teardownPortfolioRuntimeGlobals('populate');
    expect(
      getPortfolioTxHistorySigningDispatchContextOnRuntime(),
    ).toBeUndefined();

    setPortfolioTxHistorySigningDispatchContextOnRuntime({
      requestPrivKey: 'rate-secret',
      requestPubKey: 'rate-public',
    });
    teardownPortfolioRuntimeGlobals('rateFetch');
    expect(
      getPortfolioTxHistorySigningDispatchContextOnRuntime(),
    ).toBeUndefined();
  });
});
