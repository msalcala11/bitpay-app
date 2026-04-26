/**
 * Tests for portfolio.effects.ts compatibility exports.
 *
 * The active implementation lives in portfolio.runtime.effects. This wrapper is
 * intentionally tiny so old imports do not recreate a legacy populate/rate
 * orchestrator alongside the v2 runtime path.
 */

jest.mock('./portfolio.runtime.effects', () => ({
  maybePopulatePortfolioForWalletsWithRuntime: jest.fn(
    () => async () => 'maybe-runtime-result',
  ),
  populatePortfolioWithRuntime: jest.fn(
    () => async () => 'populate-runtime-result',
  ),
}));

import {
  maybePopulatePortfolioForWallets,
  populatePortfolio,
  preparePortfolioFiatRateCachesForQuoteCurrencySwitch,
} from './portfolio.effects';
import {
  maybePopulatePortfolioForWalletsWithRuntime,
  populatePortfolioWithRuntime,
} from './portfolio.runtime.effects';

const dispatchThunk = (thunk: any): Promise<unknown> =>
  thunk(jest.fn(), jest.fn(() => ({})), undefined);

describe('portfolio.effects compatibility wrapper', () => {
  beforeEach(() => jest.clearAllMocks());

  it('aliases maybePopulatePortfolioForWallets to the runtime implementation', async () => {
    expect(maybePopulatePortfolioForWallets).toBe(
      maybePopulatePortfolioForWalletsWithRuntime,
    );

    const thunk = maybePopulatePortfolioForWallets({
      wallets: [{id: 'wallet-1'} as any],
      quoteCurrency: 'USD',
    });

    await expect(dispatchThunk(thunk)).resolves.toBe('maybe-runtime-result');
    expect(maybePopulatePortfolioForWalletsWithRuntime).toHaveBeenCalledWith({
      wallets: [{id: 'wallet-1'}],
      quoteCurrency: 'USD',
    });
  });

  it('aliases populatePortfolio to the runtime implementation', async () => {
    expect(populatePortfolio).toBe(populatePortfolioWithRuntime);

    const thunk = populatePortfolio({
      walletIds: ['wallet-1'],
      quoteCurrency: 'USD',
    });

    await expect(dispatchThunk(thunk)).resolves.toBe('populate-runtime-result');
    expect(populatePortfolioWithRuntime).toHaveBeenCalledWith({
      walletIds: ['wallet-1'],
      quoteCurrency: 'USD',
    });
  });

  it('keeps quote-switch rate-cache preparation as an inert compatibility export', async () => {
    const dispatch = jest.fn();
    const getState = jest.fn(() => ({
      RATE: {rates: {}, lastDayRates: {}, ratesCacheKey: {}},
    }));

    await expect(
      preparePortfolioFiatRateCachesForQuoteCurrencySwitch({
        quoteCurrency: 'EUR',
      })(dispatch, getState, undefined),
    ).resolves.toBeUndefined();

    expect(dispatch).not.toHaveBeenCalled();
    expect(getState).not.toHaveBeenCalled();
  });
});
