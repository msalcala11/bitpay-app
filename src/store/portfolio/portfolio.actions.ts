import {
  PortfolioActionType,
  PortfolioActionTypes,
  PortfolioLoadState,
  BalancePoint,
  SeriesRefreshState,
  CryptoCheckpoint,
} from './portfolio.types';

export const resetPortfolioAnalytics = (): PortfolioActionType => ({
  type: PortfolioActionTypes.RESET,
});

export const clearPortfolioScope = (scope: string): PortfolioActionType => ({
  type: PortfolioActionTypes.CLEAR_SCOPE,
  payload: {scope},
});

export const upsertPortfolioStatus = (
  scope: string,
  status: PortfolioLoadState,
): PortfolioActionType => ({
  type: PortfolioActionTypes.UPSERT_STATUS,
  payload: {scope, status},
});

export const upsertPortfolioSeries = (
  scope: string,
  points: BalancePoint[],
): PortfolioActionType => ({
  type: PortfolioActionTypes.UPSERT_SERIES,
  payload: {scope, points},
});

export const upsertSeriesRefreshState = (
  scope: string,
  refreshState: SeriesRefreshState,
): PortfolioActionType => ({
  type: PortfolioActionTypes.UPSERT_SERIES_REFRESH_STATE,
  payload: {scope, refreshState},
});

export const upsertCryptoTimeline = (
  scope: string,
  checkpoints: CryptoCheckpoint[],
): PortfolioActionType => ({
  type: PortfolioActionTypes.UPSERT_CRYPTO_TIMELINE,
  payload: {scope, checkpoints},
});
