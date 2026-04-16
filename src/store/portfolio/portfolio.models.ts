export type BalanceSnapshotEventType = 'tx' | 'daily';
export type BalanceSnapshotDirection = 'incoming' | 'outgoing';

// Legacy snapshot type kept only for compatibility with older utility code and
// debug-only helpers that still refer to the historical shape. Runtime-backed
// portfolio rendering no longer persists or reads snapshot arrays from Redux.
export interface BalanceSnapshot {
  id: string;
  chain: string;
  coin: string;
  network: string;
  assetId: string;
  timestamp: number;
  dayStartMs?: number;
  eventType: BalanceSnapshotEventType;
  txIds?: string[];
  direction?: BalanceSnapshotDirection;
  // Signed atomic delta vs the previous snapshot (computed, not persisted).
  balanceDeltaAtomic?: string;
  cryptoBalance: string;
  avgCostFiatPerUnit: number;
  remainingCostBasisFiat: number;
  unrealizedPnlFiat: number;
  costBasisRateFiat?: number;
  quoteCurrency: string;
  createdAt?: number;
}

export interface PortfolioPopulateError {
  walletId: string;
  message: string;
}

export type WalletPopulateState = 'in_progress' | 'done' | 'error';

export interface SnapshotBalanceMismatch {
  walletId: string;
  computedUnitsHeld: string;
  currentWalletBalance: string;
  delta: string;
}

export interface PortfolioPopulateStatus {
  inProgress: boolean;
  startedAt?: number;
  finishedAt?: number;
  elapsedMs?: number;
  stopReason?: string;
  currentWalletId?: string;
  walletsTotal: number;
  walletsCompleted: number;
  txRequestsMade: number;
  txsProcessed: number;
  errors: PortfolioPopulateError[];
  walletStatusById?: {[walletId: string]: WalletPopulateState | undefined};
}

export interface PortfolioState {
  lastPopulatedAt?: number;
  quoteCurrency?: string;
  populateDisabled: boolean;
  populateStatus: PortfolioPopulateStatus;
  snapshotBalanceMismatchesByWalletId?: {
    [walletId: string]: SnapshotBalanceMismatch | undefined;
  };
}
