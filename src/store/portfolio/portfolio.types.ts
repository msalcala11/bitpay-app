export enum PortfolioActionTypes {
  SET_GLOBAL_SYNC = 'PORTFOLIO/SET_GLOBAL_SYNC',
  UPDATE_WALLET_SYNC = 'PORTFOLIO/UPDATE_WALLET_SYNC',
  RESET = 'PORTFOLIO/RESET',
}

export type PortfolioSyncStatus = 'idle' | 'syncing' | 'done' | 'error';

export interface PortfolioGlobalSyncState {
  status: PortfolioSyncStatus;
  startedOn?: number;
  finishedOn?: number;
  walletsTotal: number;
  walletsDone: number;
  currentWalletId?: string;
  error?: string;
}

export interface PortfolioWalletSyncState {
  status: PortfolioSyncStatus;
  keyId: string;
  walletId: string;
  txCount: number;
  chunkCount: number;
  startedOn?: number;
  finishedOn?: number;
  error?: string;
}

export interface PortfolioState {
  global: PortfolioGlobalSyncState;
  wallets: {
    [walletId: string]: PortfolioWalletSyncState;
  };
}

export interface SetGlobalSyncAction {
  type: typeof PortfolioActionTypes.SET_GLOBAL_SYNC;
  payload: Partial<PortfolioGlobalSyncState>;
}

export interface UpdateWalletSyncAction {
  type: typeof PortfolioActionTypes.UPDATE_WALLET_SYNC;
  payload: Partial<PortfolioWalletSyncState> & {walletId: string; keyId: string};
}

export interface ResetPortfolioAction {
  type: typeof PortfolioActionTypes.RESET;
}

export type PortfolioActionType =
  | SetGlobalSyncAction
  | UpdateWalletSyncAction
  | ResetPortfolioAction;
