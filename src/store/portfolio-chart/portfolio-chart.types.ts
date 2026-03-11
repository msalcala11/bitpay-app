import type {CachedBalanceChartTimeframe} from './portfolio-chart.models';

export enum PortfolioChartActionTypes {
  CLEAR_PORTFOLIO_CHART = 'PORTFOLIO_CHART/CLEAR_PORTFOLIO_CHART',
  UPSERT_BALANCE_CHART_SCOPE_TIMEFRAMES = 'PORTFOLIO_CHART/UPSERT_BALANCE_CHART_SCOPE_TIMEFRAMES',
  PATCH_BALANCE_CHART_SCOPE_LATEST_POINTS = 'PORTFOLIO_CHART/PATCH_BALANCE_CHART_SCOPE_LATEST_POINTS',
  TOUCH_BALANCE_CHART_SCOPE = 'PORTFOLIO_CHART/TOUCH_BALANCE_CHART_SCOPE',
  PRUNE_BALANCE_CHART_CACHE = 'PORTFOLIO_CHART/PRUNE_BALANCE_CHART_CACHE',
  REMOVE_BALANCE_CHART_SCOPES_BY_WALLET_IDS = 'PORTFOLIO_CHART/REMOVE_BALANCE_CHART_SCOPES_BY_WALLET_IDS',
}

export interface ClearPortfolioChartAction {
  type: typeof PortfolioChartActionTypes.CLEAR_PORTFOLIO_CHART;
}

export interface UpsertBalanceChartScopeTimeframesAction {
  type: typeof PortfolioChartActionTypes.UPSERT_BALANCE_CHART_SCOPE_TIMEFRAMES;
  payload: {
    scopeId: string;
    walletIds: string[];
    quoteCurrency: string;
    balanceOffset: number;
    timeframes: CachedBalanceChartTimeframe[];
    lastAccessedAt?: number;
  };
}

export interface PatchBalanceChartScopeLatestPointsAction {
  type: typeof PortfolioChartActionTypes.PATCH_BALANCE_CHART_SCOPE_LATEST_POINTS;
  payload: {
    scopeId: string;
    timeframes: CachedBalanceChartTimeframe[];
    lastAccessedAt?: number;
  };
}

export interface TouchBalanceChartScopeAction {
  type: typeof PortfolioChartActionTypes.TOUCH_BALANCE_CHART_SCOPE;
  payload: {
    scopeId: string;
    lastAccessedAt?: number;
  };
}

export interface PruneBalanceChartCacheAction {
  type: typeof PortfolioChartActionTypes.PRUNE_BALANCE_CHART_CACHE;
  payload?: {
    maxScopes?: number;
  };
}

export interface RemoveBalanceChartScopesByWalletIdsAction {
  type: typeof PortfolioChartActionTypes.REMOVE_BALANCE_CHART_SCOPES_BY_WALLET_IDS;
  payload: {
    walletIds: string[];
  };
}

export type PortfolioChartActionType =
  | ClearPortfolioChartAction
  | UpsertBalanceChartScopeTimeframesAction
  | PatchBalanceChartScopeLatestPointsAction
  | TouchBalanceChartScopeAction
  | PruneBalanceChartCacheAction
  | RemoveBalanceChartScopesByWalletIdsAction;
