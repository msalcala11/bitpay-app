export type PortfolioInterval =
  | 'day'
  | 'week'
  | 'month'
  | '3months'
  | 'year'
  | '5years'
  | 'all';

export type PortfolioTxEventCategory = 'receive' | 'spend' | 'moved';

export interface PortfolioTxEvent {
  walletId: string;
  txid: string;
  time: number;
  assetId: string;
  category: PortfolioTxEventCategory;
  cryptoDelta: number;
  feeCrypto?: number;
  confirmed?: boolean;
  status?: string;
  usdPriceUsed?: number;
  basisUSDOverride?: number;
  counterpartyWalletId?: string;
}

export interface WalletIntervalCursorPoint {
  time: number;
  cryptoBalance: number;
  costBasisRemainingUSD: number;
  valueUSD: number | null;
}

export interface WalletIntervalCursor {
  walletId: string;
  interval: PortfolioInterval;
  points: WalletIntervalCursorPoint[];
  lastEndTime: number;
  lastTxIndex: number;
}

export interface PortfolioMeta {
  lastSyncTime?: number;
  syncStatus: 'idle' | 'syncing' | 'error';
  error?: string;
}

export interface PortfolioState {
  txEventsByWalletId: Record<string, PortfolioTxEvent[]>;
  walletIntervalCursorsByWalletId: Record<
    string,
    Partial<Record<PortfolioInterval, WalletIntervalCursor>>
  >;
  rateCacheUsd: Record<string, Record<number, number>>;
  fxCache: Record<string, unknown>;
  meta: PortfolioMeta;
}

export enum PortfolioActionTypes {
  RESET = 'PORTFOLIO/RESET',
  SET_TX_EVENTS_FOR_WALLET = 'PORTFOLIO/SET_TX_EVENTS_FOR_WALLET',
  UPSERT_TX_EVENTS_FOR_WALLET = 'PORTFOLIO/UPSERT_TX_EVENTS_FOR_WALLET',
  SET_WALLET_INTERVAL_CURSOR = 'PORTFOLIO/SET_WALLET_INTERVAL_CURSOR',
  SET_RATE_CACHE_USD = 'PORTFOLIO/SET_RATE_CACHE_USD',
  SET_FX_CACHE = 'PORTFOLIO/SET_FX_CACHE',
  SET_META = 'PORTFOLIO/SET_META',
}

export interface ResetPortfolioAction {
  type: PortfolioActionTypes.RESET;
}

export interface SetTxEventsForWalletAction {
  type: PortfolioActionTypes.SET_TX_EVENTS_FOR_WALLET;
  payload: {
    walletId: string;
    txEvents: PortfolioTxEvent[];
  };
}

export interface UpsertTxEventsForWalletAction {
  type: PortfolioActionTypes.UPSERT_TX_EVENTS_FOR_WALLET;
  payload: {
    walletId: string;
    txEvents: PortfolioTxEvent[];
  };
}

export interface SetWalletIntervalCursorAction {
  type: PortfolioActionTypes.SET_WALLET_INTERVAL_CURSOR;
  payload: {
    walletId: string;
    interval: PortfolioInterval;
    cursor: WalletIntervalCursor;
  };
}

export interface SetRateCacheUsdAction {
  type: PortfolioActionTypes.SET_RATE_CACHE_USD;
  payload: {
    rateCacheUsd: Record<string, Record<number, number>>;
  };
}

export interface SetFxCacheAction {
  type: PortfolioActionTypes.SET_FX_CACHE;
  payload: {
    fxCache: Record<string, unknown>;
  };
}

export interface SetPortfolioMetaAction {
  type: PortfolioActionTypes.SET_META;
  payload: Partial<PortfolioMeta>;
}

export type PortfolioActionType =
  | ResetPortfolioAction
  | SetTxEventsForWalletAction
  | UpsertTxEventsForWalletAction
  | SetWalletIntervalCursorAction
  | SetRateCacheUsdAction
  | SetFxCacheAction
  | SetPortfolioMetaAction;
