import {
  buildPortfolioComputedState,
  type PortfolioScopeComputedStateInput,
  type ScopedPortfolioComputedStateInput,
  type WalletComputedStateInput,
} from './compute/portfolioState';
import {
  buildFormulaComputedInputs,
  type BuildFormulaComputedInputsArgs,
  type FormulaAssetGroupInput,
  type FormulaWalletInput,
} from './compute/recomputeFormula';
import {aggregateAlignedSeries} from './compute/seriesAggregation';
import type {
  PerIntervalSeries,
  PortfolioStaleReason,
  PortfolioState,
  Series,
  WalletSlice,
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
  buildQuoteBridgedFormulaComputedInputs,
  type BuildFormulaComputedInputsArgs,
  type BuildFormulaComputedInputsResult,
  type BuildQuoteBridgedFormulaComputedInputsArgs,
  type FormulaAssetGroupInput,
  type FormulaComputedInputsInvalidReason,
  type FormulaQuoteBridgeRatePoints,
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
  computedAtMs?: number;
  accessTouchWalletIds?: readonly string[];
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

function isStrictIdentity(value: unknown): value is string {
  'worklet';

  return typeof value === 'string' && !!value.trim() && value === value.trim();
}

function isValidTimestamp(value: number): boolean {
  'worklet';

  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function getTouchWalletIds(scope: RecomputeScope): readonly string[] | undefined {
  'worklet';

  if (typeof scope === 'string') {
    return undefined;
  }

  if (scope.kind === 'touchWallet') {
    return [scope.walletId];
  }

  if (scope.kind === 'touchWallets') {
    return scope.walletIds;
  }

  return undefined;
}

function isWalletRecomputeScope(scope: RecomputeScope): boolean {
  'worklet';

  return (
    typeof scope !== 'string' &&
    (scope.kind === 'wallet' || scope.kind === 'wallets')
  );
}

function getAccessTouchWalletIds(
  request: RecomputeRequest,
): readonly string[] | undefined {
  'worklet';

  const directTouchWalletIds = getTouchWalletIds(request.scope);
  if (directTouchWalletIds) {
    return directTouchWalletIds;
  }

  return isWalletRecomputeScope(request.scope)
    ? request.accessTouchWalletIds
    : undefined;
}

function buildFormulaWalletById(
  wallets: readonly FormulaWalletInput[],
): ReadonlyMap<string, FormulaWalletInput> | null {
  'worklet';

  const byId = new Map<string, FormulaWalletInput>();
  for (const wallet of wallets) {
    if (!isStrictIdentity(wallet.walletId) || byId.has(wallet.walletId)) {
      return null;
    }
    byId.set(wallet.walletId, wallet);
  }

  return byId;
}

function hasLiveRateSeries(series: PerIntervalSeries): boolean {
  'worklet';

  return Object.keys(series).some(interval => {
    const entry = series[interval as keyof PerIntervalSeries] as
      | Series
      | undefined;
    return entry?.finalPointSource === 'liveRate';
  });
}

function aggregateTotalSeriesForInterval(args: {
  interval: keyof PerIntervalSeries;
  wallets: readonly WalletComputedStateInput[];
}): Series | null {
  'worklet';

  return aggregateAlignedSeries({
    identityKey: 'liveRateTouchTotal',
    interval: args.interval as Series['interval'],
    memberSeries: args.wallets
      .map(wallet => wallet.series[args.interval])
      .filter((candidate): candidate is Series => !!candidate),
  });
}

function buildLiveRateTouchTotal(args: {
  currentTotal: PerIntervalSeries;
  inputTotal?: PerIntervalSeries;
  wallets: readonly WalletComputedStateInput[];
}): PerIntervalSeries | null {
  'worklet';

  if (args.inputTotal) {
    return args.inputTotal;
  }

  if (!hasLiveRateSeries(args.currentTotal)) {
    return args.currentTotal;
  }

  const total: Partial<Record<keyof PerIntervalSeries, Series>> = {
    ...args.currentTotal,
  };
  for (const key of Object.keys(args.currentTotal)) {
    const interval = key as keyof PerIntervalSeries;
    const currentSeries = args.currentTotal[interval];
    if (currentSeries?.finalPointSource !== 'liveRate') {
      continue;
    }

    const rebuilt = aggregateTotalSeriesForInterval({
      interval,
      wallets: args.wallets,
    });
    if (!rebuilt) {
      return null;
    }
    total[interval] = rebuilt;
  }

  return total;
}

function hasChangedAssetIntersection(args: {
  walletById: ReadonlyMap<string, FormulaWalletInput>;
  changedAssetIds?: ReadonlySet<string>;
}): boolean {
  'worklet';

  if (!args.changedAssetIds) {
    return true;
  }

  if (!args.changedAssetIds.size) {
    return false;
  }

  return Array.from(args.walletById.values()).some(
    wallet =>
      args.changedAssetIds?.has(wallet.walletId) ||
      args.changedAssetIds?.has(wallet.assetGroupId) ||
      args.changedAssetIds?.has(wallet.assetIdentityKey) ||
      args.changedAssetIds?.has(wallet.rateSourceKey),
  );
}

function buildChangedAssetIdSet(
  changedAssetIds: readonly string[] | undefined,
): ReadonlySet<string> | undefined | null {
  'worklet';

  if (!changedAssetIds || !changedAssetIds.length) {
    return undefined;
  }

  const out = new Set<string>();
  for (const value of changedAssetIds) {
    if (!isStrictIdentity(value)) {
      return null;
    }
    out.add(value);
  }

  return out;
}

function buildScopedInputsForLiveRateTouch(args: {
  current: PortfolioState;
  input: NormalizedFormulaRecomputeInput;
}): readonly ScopedPortfolioComputedStateInput[] | null {
  'worklet';

  if (args.input.scopedSlices) {
    return args.input.scopedSlices;
  }

  const scopedInputs: ScopedPortfolioComputedStateInput[] = [];
  const walletById = buildFormulaWalletById(args.input.formula.wallets);
  if (!walletById) {
    return null;
  }

  const assetGroupById = new Map(
    args.input.formula.assetGroups.map(group => [group.assetGroupId, group]),
  );

  for (const scopedSlice of Object.values(args.current.scopedByWalletSet)) {
    const scopedWallets: FormulaWalletInput[] = [];
    const assetGroupIds = new Set<string>();
    for (const walletId of scopedSlice.walletIds) {
      const wallet = walletById.get(walletId);
      if (!wallet) {
        return null;
      }
      scopedWallets.push(wallet);
      assetGroupIds.add(wallet.assetGroupId);
    }

    const scopedAssetGroups: FormulaAssetGroupInput[] = [];
    for (const assetGroupId of Array.from(assetGroupIds).sort((a, b) =>
      a.localeCompare(b),
    )) {
      const group = assetGroupById.get(assetGroupId);
      if (!group) {
        return null;
      }
      scopedAssetGroups.push(group);
    }

    const formula = buildFormulaComputedInputs({
      quoteCurrency: args.input.formula.quoteCurrency,
      wallets: scopedWallets,
      assetGroups: scopedAssetGroups,
    });
    if (formula.kind !== 'valid') {
      return null;
    }
    const total = buildLiveRateTouchTotal({
      currentTotal: scopedSlice.total,
      wallets: formula.wallets,
    });
    if (!total) {
      return null;
    }

    scopedInputs.push({
      walletIds: scopedSlice.walletIds,
      walletIdsKey: scopedSlice.walletIdsKey,
      total,
      assetGroups: formula.assetGroups,
      refreshing: scopedSlice.readiness.refreshing,
      lastAccessedAt: scopedSlice.lastAccessedAt,
    });
  }

  return scopedInputs;
}

function preserveWalletAccessTimes(args: {
  wallets: readonly WalletComputedStateInput[];
  current: PortfolioState;
}): readonly WalletComputedStateInput[] {
  'worklet';

  return args.wallets.map(wallet => ({
    ...wallet,
    lastAccessedAt:
      args.current.byWallet[wallet.walletId]?.lastAccessedAt ??
      wallet.lastAccessedAt,
  }));
}

function recomputeLiveRateTouch(
  current: PortfolioState,
  request: RecomputeRequest,
  input: NormalizedFormulaRecomputeInput,
): PortfolioState {
  'worklet';

  if (
    typeof request.scope === 'string' ||
    request.scope.kind !== 'liveRateTouch' ||
    request.startEpoch !== current.workEpoch ||
    input.formula.quoteCurrency !== current.quoteCurrency ||
    !isValidTimestamp(input.computedAtMs)
  ) {
    return current;
  }

  const changedAssetIds = buildChangedAssetIdSet(request.scope.changedAssetIds);
  if (changedAssetIds === null) {
    return current;
  }

  const walletById = buildFormulaWalletById(input.formula.wallets);
  if (!walletById) {
    return current;
  }

  if (!hasChangedAssetIntersection({walletById, changedAssetIds})) {
    return current;
  }

  const formula = buildFormulaComputedInputs(input.formula);
  if (formula.kind !== 'valid') {
    return current;
  }

  const wallets = preserveWalletAccessTimes({
    wallets: formula.wallets,
    current,
  });
  const total = buildLiveRateTouchTotal({
    currentTotal: current.total,
    inputTotal: input.total,
    wallets,
  });
  if (!total) {
    return current;
  }

  const scopedSlices = buildScopedInputsForLiveRateTouch({
    current,
    input,
  });
  if (!scopedSlices) {
    return current;
  }

  const next = buildPortfolioComputedState({
    workEpoch: request.startEpoch,
    revision: current.revision + 1,
    quoteCurrency: input.formula.quoteCurrency,
    computedAtMs: input.computedAtMs,
    orderRevision: input.orderRevision ?? current.orderRevision,
    wallets,
    assetGroups: formula.assetGroups,
    total,
    populatedWalletIds:
      input.populatedWalletIds ?? idsFromRecord(current.populatedWalletIdsById),
    invalidHistoryWalletIds: uniqueSorted([
      ...(input.invalidHistoryWalletIds ??
        idsFromRecord(current.invalidHistoryWalletIdsById)),
      ...formula.invalidHistoryWalletIds,
    ]),
    missingRateSourceKeys: uniqueSorted([
      ...current.status.missingRateSourceKeys,
      ...formula.missingRateSourceKeys,
    ]),
    retryScheduledWalletIds:
      input.retryScheduledWalletIds ?? current.status.retryScheduledWalletIds,
    retryScheduledRateSourceKeys:
      input.retryScheduledRateSourceKeys ??
      current.status.retryScheduledRateSourceKeys,
    staleReasons: input.staleReasons ?? current.status.staleReasons,
    previousReadinessByScopeKey: current.readinessByScopeKey,
    scopes: input.scopes,
    previousScopedByWalletSet: current.scopedByWalletSet,
    scopedSlices,
    protectedScopedWalletIdsKeys: input.protectedScopedWalletIdsKeys,
    evictScopedWalletIds: input.evictScopedWalletIds,
  });

  if (next.kind !== 'valid') {
    return current;
  }

  return next.state;
}

function recomputeTouchAccess(
  current: PortfolioState,
  request: RecomputeRequest,
  computedAtMs: number | undefined,
): PortfolioState {
  'worklet';

  if (
    request.startEpoch !== current.workEpoch ||
    !isValidTimestamp(computedAtMs)
  ) {
    return current;
  }

  const touchWalletIds = getAccessTouchWalletIds(request);
  if (!touchWalletIds || !touchWalletIds.length) {
    return current;
  }

  for (const walletId of touchWalletIds) {
    if (!isStrictIdentity(walletId) || !current.byWallet[walletId]) {
      return current;
    }
  }

  const touchedWalletIds = new Set(touchWalletIds);
  let changed = false;
  const byWallet: Record<string, WalletSlice> = {...current.byWallet};
  for (const walletId of touchedWalletIds) {
    const wallet = current.byWallet[walletId];
    if (wallet.lastAccessedAt !== computedAtMs) {
      changed = true;
      byWallet[walletId] = {
        ...wallet,
        lastAccessedAt: computedAtMs,
      };
    }
  }

  const scopedKey = uniqueSorted(Array.from(touchedWalletIds)).join('|');
  let scopedByWalletSet = current.scopedByWalletSet;
  const scopedSlice = current.scopedByWalletSet[scopedKey];
  if (scopedSlice && scopedSlice.lastAccessedAt !== computedAtMs) {
    changed = true;
    scopedByWalletSet = {
      ...current.scopedByWalletSet,
      [scopedKey]: {
        ...scopedSlice,
        lastAccessedAt: computedAtMs,
      },
    };
  }

  if (!changed) {
    return current;
  }

  return {
    ...current,
    revision: current.revision + 1,
    byWallet,
    scopedByWalletSet,
  };
}

export function recomputePortfolioState(
  current: PortfolioState,
  request: RecomputeRequest,
): PortfolioState {
  const input = request.normalizedFormulaInput;

  if (request.scope !== 'full') {
    if (
      typeof request.scope !== 'string' &&
      request.scope.kind === 'liveRateTouch'
    ) {
      if (!input) {
        return current;
      }
      return recomputeLiveRateTouch(current, request, input);
    }

    // Historical wallet/wallets recompute needs scheduler-owned normalized
    // inputs that include affected global totals, asset groups, and scoped
    // cache refreshes. Until that Phase 6 scheduler path is wired, only
    // access-only touch scopes are safe to handle here.
    return recomputeTouchAccess(
      current,
      request,
      isWalletRecomputeScope(request.scope)
        ? request.computedAtMs
        : request.computedAtMs ?? input?.computedAtMs,
    );
  }

  if (!input) {
    return current;
  }

  if (request.startEpoch !== current.workEpoch) {
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
