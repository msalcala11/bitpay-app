import type {Store} from 'redux';

import type {RootState} from '../../store';

let portfolioReduxStore:
  | (Store<RootState> & {getState(): RootState})
  | undefined;

export function initPortfolioReduxAccess(
  store: Store<RootState> & {getState(): RootState},
): void {
  portfolioReduxStore = store;
}

export function resetPortfolioReduxAccessForTesting(): void {
  portfolioReduxStore = undefined;
}

export function isPortfolioReduxAccessInitialized(): boolean {
  return !!portfolioReduxStore;
}

export function getReduxStateForPortfolioV2(): RootState {
  if (!portfolioReduxStore) {
    throw new Error(
      'Portfolio v2 Redux access has not been initialized. Call initPortfolioReduxAccess(...) from the getStore().then(...) bootstrap path.',
    );
  }
  return portfolioReduxStore.getState();
}

/**
 * Phase 0 inventory: the existing live-rate slice carries all supported alt
 * currencies simultaneously rather than a single quote-scoped payload. Passive
 * live-rate recompute should select quote-specific entries using this current
 * display quote; no separate getLiveRatesQuoteCurrencyFromStore accessor is
 * needed unless that Redux invariant changes.
 */
export function getQuoteCurrencyFromStore(): string {
  const state = getReduxStateForPortfolioV2() as unknown as {
    APP?: {
      defaultAltCurrency?: {isoCode?: string};
      defaultAltCurrencyIsoCode?: string;
    };
  };
  return (
    state.APP?.defaultAltCurrency?.isoCode ||
    state.APP?.defaultAltCurrencyIsoCode ||
    'USD'
  );
}
