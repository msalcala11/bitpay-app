import type {FiatRateInterval} from '../rate/rate.models';

export const BALANCE_CHART_CACHE_SCHEMA_VERSION = 2;
export const BALANCE_CHART_CACHE_MAX_SCOPES = 40;

export type HistoricalRateDependencyMeta = {
  cacheKey: string;
  fetchedOn?: number;
  lastTs?: number;
};

export type LatestHoldingsByCoin = Record<
  string,
  {
    units: number;
  }
>;

export type CachedBalanceChartTimeframe = {
  timeframe: FiatRateInterval;
  builtAt: number;
  schemaVersion: number;

  quoteCurrency: string;
  balanceOffset: number;
  walletIds: string[];

  snapshotVersionSig: string;
  historicalRateDeps: HistoricalRateDependencyMeta[];

  lastSpotRatesByCoin: Record<string, number>;
  latestHoldingsByCoin: LatestHoldingsByCoin;
  latestRemainingCostBasisFiatTotal: number;

  ts: number[];
  totalFiatBalance: number[];
  totalUnrealizedPnlFiat: number[];
  totalPnlPercent: number[];
};

export type CachedBalanceChartScope = {
  scopeId: string;
  walletIds: string[];
  quoteCurrency: string;
  balanceOffset: number;
  lastAccessedAt: number;
  timeframes: Partial<Record<FiatRateInterval, CachedBalanceChartTimeframe>>;
};

export interface PortfolioChartsState {
  walletSnapshotVersionById: Record<string, number | undefined>;
  cacheByScopeId: Record<string, CachedBalanceChartScope | undefined>;
  lruScopeIds: string[];
}
