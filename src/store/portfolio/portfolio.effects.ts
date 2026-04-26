import type {Effect} from '..';
import {
  maybePopulatePortfolioForWalletsWithRuntime,
  populatePortfolioWithRuntime,
} from './portfolio.runtime.effects';

export const maybePopulatePortfolioForWallets =
  maybePopulatePortfolioForWalletsWithRuntime;
export const populatePortfolio = populatePortfolioWithRuntime;

// Legacy compatibility export for old specs/imports. The active runtime path is
// owned by portfolio.runtime.effects and v2 rate freshness is owned by the
// portfolio rate-fetch runtime, not Redux historical-rate caches.
export const preparePortfolioFiatRateCachesForQuoteCurrencySwitch =
  (_args?: {quoteCurrency?: string}): Effect<Promise<void>> =>
  async () => undefined;
