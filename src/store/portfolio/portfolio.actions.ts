import {
  PortfolioActionTypes,
  PortfolioGlobalSyncState,
  PortfolioWalletSyncState,
  SetGlobalSyncAction,
  UpdateWalletSyncAction,
  ResetPortfolioAction,
} from './portfolio.types';

export const setPortfolioGlobalSync = (
  payload: Partial<PortfolioGlobalSyncState>,
): SetGlobalSyncAction => ({
  type: PortfolioActionTypes.SET_GLOBAL_SYNC,
  payload,
});

export const updatePortfolioWalletSync = (
  payload: Partial<PortfolioWalletSyncState> & {walletId: string; keyId: string},
): UpdateWalletSyncAction => ({
  type: PortfolioActionTypes.UPDATE_WALLET_SYNC,
  payload,
});

export const resetPortfolio = (): ResetPortfolioAction => ({
  type: PortfolioActionTypes.RESET,
});
