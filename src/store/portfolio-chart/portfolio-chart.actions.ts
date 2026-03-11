import type {CachedBalanceChartTimeframe} from './portfolio-chart.models';
import {
  PortfolioChartActionType,
  PortfolioChartActionTypes,
} from './portfolio-chart.types';

export const clearPortfolioChart = (): PortfolioChartActionType => ({
  type: PortfolioChartActionTypes.CLEAR_PORTFOLIO_CHART,
});

export const upsertBalanceChartScopeTimeframes = (payload: {
  scopeId: string;
  walletIds: string[];
  quoteCurrency: string;
  balanceOffset: number;
  timeframes: CachedBalanceChartTimeframe[];
  lastAccessedAt?: number;
}): PortfolioChartActionType => ({
  type: PortfolioChartActionTypes.UPSERT_BALANCE_CHART_SCOPE_TIMEFRAMES,
  payload,
});

export const patchBalanceChartScopeLatestPoints = (payload: {
  scopeId: string;
  timeframes: CachedBalanceChartTimeframe[];
  lastAccessedAt?: number;
}): PortfolioChartActionType => ({
  type: PortfolioChartActionTypes.PATCH_BALANCE_CHART_SCOPE_LATEST_POINTS,
  payload,
});

export const touchBalanceChartScope = (payload: {
  scopeId: string;
  lastAccessedAt?: number;
}): PortfolioChartActionType => ({
  type: PortfolioChartActionTypes.TOUCH_BALANCE_CHART_SCOPE,
  payload,
});

export const pruneBalanceChartCache = (payload?: {
  maxScopes?: number;
}): PortfolioChartActionType => ({
  type: PortfolioChartActionTypes.PRUNE_BALANCE_CHART_CACHE,
  payload,
});

export const removeBalanceChartScopesByWalletIds = (payload: {
  walletIds: string[];
}): PortfolioChartActionType => ({
  type: PortfolioChartActionTypes.REMOVE_BALANCE_CHART_SCOPES_BY_WALLET_IDS,
  payload,
});
