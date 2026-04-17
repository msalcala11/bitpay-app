import type {PortfolioEngineOptions} from '../../core/engine/portfolioEngine';
import {RnBwsFiatRateProvider} from './bwsFiatRateProvider';
import {fetchPortfolioTxHistoryPage} from './txHistoryPageFetcher';

export function createPortfolioEngineOptionsForRnRuntime(): PortfolioEngineOptions {
  return {
    rateProvider: new RnBwsFiatRateProvider(),
    txHistoryPageFetcher: fetchPortfolioTxHistoryPage,
  };
}
