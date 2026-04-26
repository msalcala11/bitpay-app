import type {PortfolioState} from './model';
export {
  buildPortfolioComputedState,
  stableWalletIdsKey,
  type AssetGroupComputedStateInput,
  type BuildPortfolioComputedStateArgs,
  type BuildPortfolioComputedStateResult,
  type PortfolioComputedStateInvalidReason,
  type PortfolioScopeComputedStateInput,
  type ScopedPortfolioComputedStateInput,
  type WalletComputedStateInput,
} from './compute/portfolioState';

export type RecomputeScope =
  | 'full'
  | {kind: 'wallet'; walletId: string}
  | {kind: 'wallets'; walletIds: readonly string[]}
  | {kind: 'touchWallet'; walletId: string}
  | {kind: 'touchWallets'; walletIds: readonly string[]}
  | {kind: 'liveRateTouch'; changedAssetIds?: readonly string[]};

export type RecomputeRequest = Readonly<{
  scope: RecomputeScope;
  startEpoch: number;
}>;

export function recomputePortfolioState(
  current: PortfolioState,
  _request: RecomputeRequest,
): PortfolioState {
  return current;
}
