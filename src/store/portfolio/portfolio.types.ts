import {RootState} from '../index';

export type Timeframe = '1D' | '1W' | '1M' | '3M' | '1Y' | '5Y' | 'ALL';

export type EntityType = 'wallet' | 'key' | 'account' | 'portfolio';

export interface EntityRef {
  type: EntityType;
  id?: string;
  /** For account scope: the shared receive address */
  accountAddress?: string;
  /** For account scope: the key ID containing the account wallets */
  accountKeyId?: string;
}

/**
 * A crypto balance at a specific point in time (transaction-driven).
 * Used for single-asset wallets; contains only crypto amount, no fiat.
 */
export interface CryptoCheckpoint {
  timestamp: number;
  amount: number; // in smallest unit (satoshis)
  memo?: string; // transaction memo/message if available
  action?: 'sent' | 'received' | 'moved'; // transaction type
}

/**
 * Contribution from a single wallet to an aggregated balance point.
 * Used for debugging and detailed breakdown in key/portfolio scope.
 */
export interface WalletContribution {
  walletId: string;
  walletName?: string;
  currencyAbbreviation: string;
  chain: string;
  quoteValue: number;
  cryptoAmount: number;
}

/**
 * A fiat-denominated balance point at a specific timestamp.
 * Includes the quote value, rate used, and original crypto amount.
 */
export interface BalancePoint {
  timestamp: number;
  quoteValue: number;
  quoteCurrency: string;
  /** Historic quote rate used at this timestamp (e.g. USD per BTC) */
  quoteRate?: number;
  /** Original crypto amount in smallest unit (satoshis) */
  cryptoAmount: number;
  /** Breakdown by wallet (only for key/portfolio scope) */
  breakdown?: WalletContribution[];
}

export interface GainLossResult {
  timeframe: Timeframe;
  absolute: number;
  percentage: number | null;
  inflows: number;
  outflows: number;
  quoteCurrency: string;
  lastUpdated?: number;
}

export interface AllocationResult {
  assetId: string;
  quoteValue: number;
  percentage: number;
  quoteCurrency: string;
}

export interface PortfolioMetaState {
  lastUpdated: number | null;
  warmingScopes: Record<string, boolean>;
}

export interface PortfolioLoadState {
  state: 'idle' | 'loading' | 'succeeded' | 'failed';
  lastUpdated?: number;
  error?: string | null;
}

/**
 * State for incremental refresh (left-shift strategy).
 * Stored per scope key to enable efficient partial updates.
 */
export interface SeriesRefreshState {
  /** Timestamp when series was last refreshed */
  lastUpdated: number;
  /** Final crypto balance for timeline continuity (satoshis) */
  lastCryptoAmount: number;
  /** Transaction count for delta fetching */
  lastTxCount: number;
  /** Window start timestamp for the current series */
  windowStart: number;
}

export interface PortfolioAnalyticsState {
  series: Record<string, BalancePoint[]>;
  seriesRefreshState: Record<string, SeriesRefreshState>;
  cryptoTimelines: Record<string, CryptoCheckpoint[]>;
  gainLoss: Record<string, GainLossResult>;
  allocations: Record<string, AllocationResult[]>;
  meta: PortfolioMetaState;
  status: Record<string, PortfolioLoadState>;
}

export enum PortfolioActionTypes {
  RESET = 'PORTFOLIO/RESET',
  CLEAR_SCOPE = 'PORTFOLIO/CLEAR_SCOPE',
  UPSERT_STATUS = 'PORTFOLIO/UPSERT_STATUS',
  UPSERT_SERIES = 'PORTFOLIO/UPSERT_SERIES',
  UPSERT_SERIES_REFRESH_STATE = 'PORTFOLIO/UPSERT_SERIES_REFRESH_STATE',
  UPSERT_CRYPTO_TIMELINE = 'PORTFOLIO/UPSERT_CRYPTO_TIMELINE',
}

export type PortfolioActionType =
  | {type: PortfolioActionTypes.RESET}
  | {type: PortfolioActionTypes.CLEAR_SCOPE; payload: {scope: string}}
  | {
      type: PortfolioActionTypes.UPSERT_STATUS;
      payload: {scope: string; status: PortfolioLoadState};
    }
  | {
      type: PortfolioActionTypes.UPSERT_SERIES;
      payload: {scope: string; points: BalancePoint[]};
    }
  | {
      type: PortfolioActionTypes.UPSERT_SERIES_REFRESH_STATE;
      payload: {scope: string; refreshState: SeriesRefreshState};
    }
  | {
      type: PortfolioActionTypes.UPSERT_CRYPTO_TIMELINE;
      payload: {scope: string; checkpoints: CryptoCheckpoint[]};
    };

export type PortfolioSelector<T> = (state: RootState) => T;
