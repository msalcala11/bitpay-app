import {
  buildPortfolioComputedState,
  type PortfolioScopeComputedStateInput,
  type ScopedPortfolioComputedStateInput,
} from './compute/portfolioState';
import {
  buildFormulaComputedInputs,
  type BuildFormulaComputedInputsArgs,
} from './compute/recomputeFormula';
import type {
  PerIntervalSeries,
  PortfolioStaleReason,
  PortfolioState,
} from './model';
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
export {
  buildCappedSampleGrid,
  buildWalletSeriesFromEvents,
  type BalanceChangeEvent,
  type BuildCappedSampleGridArgs,
  type BuildWalletSeriesFromEventsArgs,
  type BuildWalletSeriesFromEventsResult,
  type WalletSeriesFormulaInvalidReason,
} from './compute/seriesFormula';
export {
  buildFormulaComputedInputs,
  type BuildFormulaComputedInputsArgs,
  type BuildFormulaComputedInputsResult,
  type FormulaAssetGroupInput,
  type FormulaComputedInputsInvalidReason,
  type FormulaWalletInput,
  type FormulaWalletIntervalInput,
} from './compute/recomputeFormula';

export type RecomputeScope =
  | 'full'
  | {kind: 'wallet'; walletId: string}
  | {kind: 'wallets'; walletIds: readonly string[]}
  | {kind: 'touchWallet'; walletId: string}
  | {kind: 'touchWallets'; walletIds: readonly string[]}
  | {kind: 'liveRateTouch'; changedAssetIds?: readonly string[]};

export type NormalizedFormulaRecomputeInput = Readonly<{
  computedAtMs: number;
  formula: BuildFormulaComputedInputsArgs;
  total?: PerIntervalSeries;
  populatedWalletIds?: readonly string[];
  invalidHistoryWalletIds?: readonly string[];
  retryScheduledWalletIds?: readonly string[];
  retryScheduledRateSourceKeys?: readonly string[];
  staleReasons?: readonly PortfolioStaleReason[];
  orderRevision?: number;
  scopes?: readonly PortfolioScopeComputedStateInput[];
  scopedSlices?: readonly ScopedPortfolioComputedStateInput[];
  protectedScopedWalletIdsKeys?: readonly string[];
  evictScopedWalletIds?: readonly string[];
}>;

export type RecomputeRequest = Readonly<{
  scope: RecomputeScope;
  startEpoch: number;
  normalizedFormulaInput?: NormalizedFormulaRecomputeInput;
}>;

function idsFromRecord(
  record: Readonly<Record<string, true>>,
): readonly string[] {
  'worklet';

  return Object.keys(record).sort((a, b) => a.localeCompare(b));
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  'worklet';

  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

export function recomputePortfolioState(
  current: PortfolioState,
  request: RecomputeRequest,
): PortfolioState {
  const input = request.normalizedFormulaInput;
  if (
    !input ||
    request.scope !== 'full' ||
    request.startEpoch !== current.workEpoch
  ) {
    return current;
  }

  const formula = buildFormulaComputedInputs(input.formula);
  if (formula.kind !== 'valid') {
    return current;
  }

  const next = buildPortfolioComputedState({
    workEpoch: request.startEpoch,
    revision: current.revision + 1,
    quoteCurrency: input.formula.quoteCurrency,
    computedAtMs: input.computedAtMs,
    orderRevision: input.orderRevision ?? current.orderRevision,
    wallets: formula.wallets,
    assetGroups: formula.assetGroups,
    total: input.total,
    populatedWalletIds:
      input.populatedWalletIds ?? idsFromRecord(current.populatedWalletIdsById),
    invalidHistoryWalletIds: uniqueSorted([
      ...(input.invalidHistoryWalletIds ??
        idsFromRecord(current.invalidHistoryWalletIdsById)),
      ...formula.invalidHistoryWalletIds,
    ]),
    missingRateSourceKeys: formula.missingRateSourceKeys,
    retryScheduledWalletIds: input.retryScheduledWalletIds,
    retryScheduledRateSourceKeys: input.retryScheduledRateSourceKeys,
    staleReasons: input.staleReasons,
    previousReadinessByScopeKey: current.readinessByScopeKey,
    scopes: input.scopes,
    previousScopedByWalletSet: current.scopedByWalletSet,
    scopedSlices: input.scopedSlices,
    protectedScopedWalletIdsKeys: input.protectedScopedWalletIdsKeys,
    evictScopedWalletIds: input.evictScopedWalletIds,
  });

  return next.kind === 'valid' ? next.state : current;
}
