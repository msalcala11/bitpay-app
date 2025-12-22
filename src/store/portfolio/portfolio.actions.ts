import {
  PortfolioActionTypes,
  PortfolioMeta,
  PortfolioTxEvent,
  PortfolioInterval,
  WalletIntervalCursor,
  PortfolioActionType,
} from './portfolio.types';

export const resetPortfolio = (): PortfolioActionType => ({
  type: PortfolioActionTypes.RESET,
});

export const setTxEventsForWallet = (payload: {
  walletId: string;
  txEvents: PortfolioTxEvent[];
}): PortfolioActionType => ({
  type: PortfolioActionTypes.SET_TX_EVENTS_FOR_WALLET,
  payload,
});

export const upsertTxEventsForWallet = (payload: {
  walletId: string;
  txEvents: PortfolioTxEvent[];
}): PortfolioActionType => ({
  type: PortfolioActionTypes.UPSERT_TX_EVENTS_FOR_WALLET,
  payload,
});

export const setWalletIntervalCursor = (payload: {
  walletId: string;
  interval: PortfolioInterval;
  cursor: WalletIntervalCursor;
}): PortfolioActionType => ({
  type: PortfolioActionTypes.SET_WALLET_INTERVAL_CURSOR,
  payload,
});

export const setRateCacheUsd = (payload: {
  rateCacheUsd: Record<string, Record<number, number>>;
}): PortfolioActionType => ({
  type: PortfolioActionTypes.SET_RATE_CACHE_USD,
  payload,
});

export const setFxCache = (payload: {
  fxCache: Record<string, unknown>;
}): PortfolioActionType => ({
  type: PortfolioActionTypes.SET_FX_CACHE,
  payload,
});

export const setPortfolioMeta = (payload: Partial<PortfolioMeta>): PortfolioActionType => ({
  type: PortfolioActionTypes.SET_META,
  payload,
});
