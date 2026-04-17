import type {Effect, RootState} from '..';
import type {Wallet} from '../wallet/wallet.models';
import {
  cancelPopulatePortfolioWithRuntime,
  clearPortfolioWithRuntime,
  clearWalletPortfolioDataWithRuntime,
  maybePopulatePortfolioForWalletsWithRuntime,
  populatePortfolioWithRuntime,
} from './portfolio.runtime.effects';

export {
  cancelPopulatePortfolioWithRuntime as cancelPopulatePortfolio,
  clearPortfolioWithRuntime,
  clearWalletPortfolioDataWithRuntime,
  maybePopulatePortfolioForWalletsWithRuntime as maybePopulatePortfolioForWallets,
  populatePortfolioWithRuntime as populatePortfolio,
};

function getAllWalletsFromState(state: RootState): Wallet[] {
  return Object.values(state.WALLET?.keys || {}).flatMap((key: any) => {
    return Array.isArray(key?.wallets) ? key.wallets : [];
  }) as Wallet[];
}

/**
 * Legacy compatibility shim kept during the runtime migration.
 * Historical callers expected this to warm portfolio fiat-rate caches when the
 * display currency changed. With the runtime-backed portfolio engine, the
 * closest equivalent is a full runtime repopulate in the requested quote.
 */
export const preparePortfolioFiatRateCachesForQuoteCurrencySwitch = (args: {
  quoteCurrency?: string;
}): Effect<Promise<void>> => async (dispatch, getState) => {
  const quoteCurrency = String(args.quoteCurrency || '').trim().toUpperCase();
  if (!quoteCurrency) {
    return;
  }

  const wallets = getAllWalletsFromState(getState());
  await dispatch(
    maybePopulatePortfolioForWalletsWithRuntime({
      wallets,
      quoteCurrency,
    }) as any,
  );
};
