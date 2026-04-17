import type {TxHistoryPageFetcher} from '../../core/engine/portfolioEngine';
import {fetchPortfolioTxHistoryPageByRequest} from './txHistoryRequest';

export const fetchPortfolioTxHistoryPage: TxHistoryPageFetcher = async args => {
  return fetchPortfolioTxHistoryPageByRequest({
    credentials: args.credentials,
    cfg: args.cfg,
    skip: args.skip,
    limit: args.limit,
    reverse: args.reverse,
  });
};
