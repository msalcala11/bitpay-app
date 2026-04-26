import {
  CANONICAL_RATE_QUOTE,
  MAX_SCOPED_CACHE_ENTRIES,
} from '../constants';
import type {
  AssetGroupRowShell,
  AssetGroupSlice,
  PerIntervalSeries,
  PerIntervalWeightedGroupRateSeries,
  PortfolioStaleReason,
  PortfolioState,
  PortfolioStatus,
  RowPayload,
  ScopeReadiness,
  ScopedPortfolioSlice,
  Series,
  WeightedGroupRateSeries,
} from '../model';
import {
  buildRecomputeStateSlices,
  type AssetGroupSliceAssemblyInput,
  type RecomputeStateSlicesInvalidReason,
  type WalletSliceAssemblyInput,
} from './recomputeState';

export type WalletComputedStateInput = Omit<
  WalletSliceAssemblyInput,
  'fingerprint'
>;

export type AssetGroupComputedStateInput = Omit<
  AssetGroupSliceAssemblyInput,
  'fingerprint'
>;

export type PortfolioScopeComputedStateInput = Readonly<{
  scopeKey: string;
  walletIds: readonly string[];
  refreshing?: boolean;
  hasPublishedValidSeriesThisPass?: boolean;
}>;

export type ScopedPortfolioComputedStateInput = Readonly<{
  walletIds: readonly string[];
  walletIdsKey: string;
  total?: PerIntervalSeries;
  /**
   * Caller must include every scoped entry that should be refreshed in this
   * recompute pass. Previous entries not present here are preserved by cache
   * policy unless pruned or evicted.
   */
  assetGroups: readonly AssetGroupComputedStateInput[];
  refreshing?: boolean;
  hasPublishedValidSeriesThisPass?: boolean;
  lastAccessedAt?: number;
}>;

export type BuildPortfolioComputedStateArgs = Readonly<{
  workEpoch: number;
  revision: number;
  quoteCurrency: string;
  computedAtMs: number;
  orderRevision?: number;
  wallets: readonly WalletComputedStateInput[];
  assetGroups: readonly AssetGroupComputedStateInput[];
  total?: PerIntervalSeries;
  populatedWalletIds?: readonly string[];
  invalidHistoryWalletIds?: readonly string[];
  missingRateSourceKeys?: readonly string[];
  retryScheduledWalletIds?: readonly string[];
  retryScheduledRateSourceKeys?: readonly string[];
  staleReasons?: readonly PortfolioStaleReason[];
  previousReadinessByScopeKey?: Readonly<Record<string, ScopeReadiness>>;
  scopes?: readonly PortfolioScopeComputedStateInput[];
  previousScopedByWalletSet?: Readonly<Record<string, ScopedPortfolioSlice>>;
  scopedSlices?: readonly ScopedPortfolioComputedStateInput[];
  protectedScopedWalletIdsKeys?: readonly string[];
  evictScopedWalletIds?: readonly string[];
}>;

export type PortfolioComputedStateInvalidReason =
  | RecomputeStateSlicesInvalidReason
  | 'invalidWorkEpoch'
  | 'invalidRevision'
  | 'invalidQuoteCurrency'
  | 'invalidComputedAtMs'
  | 'invalidOrderRevision'
  | 'invalidPopulatedWalletId'
  | 'invalidStatusIdentity'
  | 'invalidStaleReason'
  | 'invalidScopeKey'
  | 'duplicateScopeKey'
  | 'invalidScopeWalletId'
  | 'unknownScopeWalletId'
  | 'invalidScopedWalletIdsKey'
  | 'duplicateScopedWalletIdsKey'
  | 'invalidScopedWalletId'
  | 'unknownScopedWalletId'
  | 'invalidScopedLastAccessedAt';

export type BuildPortfolioComputedStateResult =
  | Readonly<{kind: 'valid'; state: PortfolioState}>
  | Readonly<{kind: 'invalid'; reason: PortfolioComputedStateInvalidReason}>;

const STALE_REASON_ORDER: readonly PortfolioStaleReason[] = [
  'missingSnapshotIndex',
  'missingSnapshot',
  'balanceMismatch',
  'missingHistoricalRate',
  'staleHistoricalRate',
  'invalidHistory',
  'populateRetryPending',
  'rateFetchRetryPending',
];

function stableNumber(value: number): string {
  'worklet';

  if (!Number.isFinite(value)) {
    return 'nonfinite';
  }

  if (Object.is(value, -0)) {
    return '0';
  }

  return String(value);
}

function stableHash(values: readonly (boolean | number | string)[]): string {
  'worklet';

  const input = values
    .map(value => {
      if (typeof value === 'number') {
        return stableNumber(value);
      }
      return String(value);
    })
    .join('|');
  let hash = 0x811c9dc5;

  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }

  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  'worklet';

  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

export function stableWalletIdsKey(walletIds: readonly string[]): string {
  'worklet';

  return uniqueSorted(walletIds).join('|');
}

function isStrictIdentity(value: unknown): value is string {
  'worklet';

  return (
    typeof value === 'string' && !!value.trim() && value === value.trim()
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  'worklet';

  return (
    typeof value === 'number' && Number.isInteger(value) && value >= 0
  );
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  'worklet';

  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function toIdRecord(values: readonly string[]): Readonly<Record<string, true>> {
  'worklet';

  const out: Record<string, true> = {};
  for (const value of uniqueSorted(values)) {
    out[value] = true;
  }
  return out;
}

function intersects(
  first: readonly string[],
  secondById: Readonly<Record<string, true>>,
): boolean {
  'worklet';

  return first.some(value => secondById[value] === true);
}

function hasOnlyStrictIdentities(
  values: readonly string[] | undefined,
): boolean {
  'worklet';

  return !values || values.every(isStrictIdentity);
}

function isKnownStaleReason(value: unknown): value is PortfolioStaleReason {
  'worklet';

  return (
    typeof value === 'string' &&
    STALE_REASON_ORDER.includes(value as PortfolioStaleReason)
  );
}

function validatePortfolioComputedStateArgs(
  args: BuildPortfolioComputedStateArgs,
): PortfolioComputedStateInvalidReason | undefined {
  'worklet';

  if (!isNonNegativeInteger(args.workEpoch)) {
    return 'invalidWorkEpoch';
  }
  if (!isNonNegativeInteger(args.revision)) {
    return 'invalidRevision';
  }
  if (!isStrictIdentity(args.quoteCurrency)) {
    return 'invalidQuoteCurrency';
  }
  if (!isNonNegativeFiniteNumber(args.computedAtMs)) {
    return 'invalidComputedAtMs';
  }
  if (
    typeof args.orderRevision !== 'undefined' &&
    !isNonNegativeInteger(args.orderRevision)
  ) {
    return 'invalidOrderRevision';
  }
  if (!hasOnlyStrictIdentities(args.populatedWalletIds)) {
    return 'invalidPopulatedWalletId';
  }
  if (
    !hasOnlyStrictIdentities(args.invalidHistoryWalletIds) ||
    !hasOnlyStrictIdentities(args.missingRateSourceKeys) ||
    !hasOnlyStrictIdentities(args.retryScheduledWalletIds) ||
    !hasOnlyStrictIdentities(args.retryScheduledRateSourceKeys)
  ) {
    return 'invalidStatusIdentity';
  }
  if (args.staleReasons && !args.staleReasons.every(isKnownStaleReason)) {
    return 'invalidStaleReason';
  }

  const walletIdsById: Record<string, true> = {};
  for (const wallet of args.wallets) {
    if (isStrictIdentity(wallet.walletId)) {
      walletIdsById[wallet.walletId] = true;
    }
  }
  const seenScopeKeys = new Set<string>();
  for (const scope of args.scopes ?? []) {
    if (!isStrictIdentity(scope.scopeKey)) {
      return 'invalidScopeKey';
    }
    if (seenScopeKeys.has(scope.scopeKey)) {
      return 'duplicateScopeKey';
    }
    seenScopeKeys.add(scope.scopeKey);

    for (const walletId of scope.walletIds) {
      if (!isStrictIdentity(walletId)) {
        return 'invalidScopeWalletId';
      }
      if (walletIdsById[walletId] !== true) {
        return 'unknownScopeWalletId';
      }
    }
  }

  const seenScopedWalletIdsKeys = new Set<string>();
  for (const scoped of args.scopedSlices ?? []) {
    if (
      !isStrictIdentity(scoped.walletIdsKey) ||
      scoped.walletIdsKey !== stableWalletIdsKey(scoped.walletIds)
    ) {
      return 'invalidScopedWalletIdsKey';
    }
    if (seenScopedWalletIdsKeys.has(scoped.walletIdsKey)) {
      return 'duplicateScopedWalletIdsKey';
    }
    seenScopedWalletIdsKeys.add(scoped.walletIdsKey);
    if (
      typeof scoped.lastAccessedAt !== 'undefined' &&
      !isNonNegativeFiniteNumber(scoped.lastAccessedAt)
    ) {
      return 'invalidScopedLastAccessedAt';
    }

    for (const walletId of scoped.walletIds) {
      if (!isStrictIdentity(walletId)) {
        return 'invalidScopedWalletId';
      }
      if (walletIdsById[walletId] !== true) {
        return 'unknownScopedWalletId';
      }
    }
  }

  if (
    args.protectedScopedWalletIdsKeys &&
    !hasOnlyStrictIdentities(args.protectedScopedWalletIdsKeys)
  ) {
    return 'invalidScopedWalletIdsKey';
  }
  if (
    args.evictScopedWalletIds &&
    !hasOnlyStrictIdentities(args.evictScopedWalletIds)
  ) {
    return 'invalidScopedWalletId';
  }

  return undefined;
}

function seriesFingerprintValues(series: PerIntervalSeries): readonly string[] {
  'worklet';

  return Object.keys(series)
    .sort((a, b) => a.localeCompare(b))
    .flatMap(interval => {
      const entry = series[interval as keyof PerIntervalSeries] as
        | Series
        | undefined;
      return entry ? [interval, entry.fingerprint] : [];
    });
}

function rowFingerprintValues(
  row: RowPayload | undefined,
): readonly string[] {
  'worklet';

  return row ? [row.assetGroupId, row.rowFingerprint] : [];
}

function weightedSeriesFingerprintValues(
  weighted: PerIntervalWeightedGroupRateSeries | undefined,
): readonly string[] {
  'worklet';

  if (!weighted) {
    return [];
  }

  return Object.keys(weighted)
    .sort((a, b) => a.localeCompare(b))
    .flatMap(interval => {
      const entry = weighted[
        interval as keyof PerIntervalWeightedGroupRateSeries
      ] as WeightedGroupRateSeries | undefined;
      return entry
        ? [
            interval,
            entry.fingerprint,
            entry.availability,
            entry.availability === 'unavailable'
              ? entry.unavailableReason
              : '',
          ]
        : [];
    });
}

function buildWalletSliceFingerprint(
  wallet: WalletComputedStateInput,
): string {
  'worklet';

  return stableHash([
    wallet.walletId,
    wallet.assetGroupId,
    wallet.lastWrittenAt,
    ...seriesFingerprintValues(wallet.series),
    ...rowFingerprintValues(wallet.rowToday),
    ...rowFingerprintValues(wallet.rowAllTime),
  ]);
}

function shellFingerprintValues(
  shell: AssetGroupRowShell | undefined,
): readonly (boolean | number | string)[] {
  'worklet';

  if (!shell) {
    return [];
  }

  return [
    shell.assetGroupId,
    shell.displaySymbol,
    shell.currentCryptoAmount,
    typeof shell.currentFiatValue === 'number' ? shell.currentFiatValue : '',
    shell.memberWalletIdsKey,
    ...shell.memberWalletIds,
    ...shell.memberRateSourceKeys,
    typeof shell.canonicalUnitDecimals === 'number'
      ? shell.canonicalUnitDecimals
      : '',
    shell.groupHealth.collapsedAcrossDistinctAssets,
    shell.groupHealth.decimalConflict,
    shell.groupHealth.symbolCollisionSuspected === true,
    ...shell.groupHealth.missingLiveRateMemberWalletIds,
    ...shell.groupHealth.nonzeroMissingLiveRateMemberWalletIds,
    shell.orderIndex,
    shell.readyToday,
    shell.readyAllTime,
    shell.invalidHistoryBlocked,
  ];
}

function buildAssetGroupSliceFingerprint(args: {
  slice: AssetGroupSlice;
  shell?: AssetGroupRowShell;
}): string {
  'worklet';

  return stableHash([
    args.slice.assetGroupId,
    args.slice.memberWalletIdsKey,
    ...args.slice.memberWalletIds,
    ...seriesFingerprintValues(args.slice.series),
    ...weightedSeriesFingerprintValues(args.slice.weightedGroupRateSeries),
    ...rowFingerprintValues(args.slice.rowToday),
    ...rowFingerprintValues(args.slice.rowAllTime),
    ...shellFingerprintValues(args.shell),
  ]);
}

function buildTotalFingerprint(total: PerIntervalSeries): string {
  'worklet';

  return stableHash(['total', ...seriesFingerprintValues(total)]);
}

function buildScopedSliceFingerprint(args: {
  walletIdsKey: string;
  walletIds: readonly string[];
  totalFingerprint: string;
  byAssetGroup: Readonly<Record<string, AssetGroupSlice>>;
  rowShells: readonly AssetGroupRowShell[];
  readiness: ScopeReadiness;
}): string {
  'worklet';

  const assetGroupFingerprintValues = Object.keys(args.byAssetGroup)
    .sort((a, b) => a.localeCompare(b))
    .flatMap(assetGroupId => {
      const assetGroup = args.byAssetGroup[assetGroupId];
      return assetGroup ? [assetGroupId, assetGroup.fingerprint] : [];
    });

  return stableHash([
    args.walletIdsKey,
    ...args.walletIds,
    args.totalFingerprint,
    ...assetGroupFingerprintValues,
    ...args.rowShells.flatMap(shellFingerprintValues),
    args.readiness.empty,
    args.readiness.hasEverPublishedValidSeries,
    args.readiness.initialScopeReady,
    args.readiness.refreshing,
    args.readiness.invalidHistoryBlocked,
  ]);
}

function buildStatus(args: {
  invalidHistoryWalletIds: readonly string[];
  missingRateSourceKeys: readonly string[];
  retryScheduledWalletIds: readonly string[];
  retryScheduledRateSourceKeys: readonly string[];
  staleReasons: readonly PortfolioStaleReason[];
}): PortfolioStatus {
  'worklet';

  const staleReasonSet = new Set<PortfolioStaleReason>(args.staleReasons);
  if (args.invalidHistoryWalletIds.length) {
    staleReasonSet.add('invalidHistory');
  }
  if (args.missingRateSourceKeys.length) {
    staleReasonSet.add('missingHistoricalRate');
  }
  if (args.retryScheduledWalletIds.length) {
    staleReasonSet.add('populateRetryPending');
  }
  if (args.retryScheduledRateSourceKeys.length) {
    staleReasonSet.add('rateFetchRetryPending');
  }

  return {
    invalidHistoryWalletIds: uniqueSorted(args.invalidHistoryWalletIds),
    missingRateSourceKeys: uniqueSorted(args.missingRateSourceKeys),
    staleReasons: STALE_REASON_ORDER.filter(reason =>
      staleReasonSet.has(reason),
    ),
    retryScheduledWalletIds: uniqueSorted(args.retryScheduledWalletIds),
    retryScheduledRateSourceKeys: uniqueSorted(
      args.retryScheduledRateSourceKeys,
    ),
  };
}

function hasAnySeriesPoints(series: PerIntervalSeries): boolean {
  'worklet';

  return Object.keys(series).some(interval => {
    const entry = series[interval as keyof PerIntervalSeries] as
      | Series
      | undefined;
    return !!entry?.points.length;
  });
}

function hasAnyAssetGroupSeriesPoints(
  byAssetGroup: Readonly<Record<string, AssetGroupSlice>>,
): boolean {
  'worklet';

  return Object.keys(byAssetGroup).some(assetGroupId => {
    const assetGroup = byAssetGroup[assetGroupId];
    return assetGroup ? hasAnySeriesPoints(assetGroup.series) : false;
  });
}

function buildScopeReadiness(args: {
  walletIds: readonly string[];
  populatedWalletIds: readonly string[];
  invalidHistoryWalletIds: readonly string[];
  previous?: ScopeReadiness;
  refreshing?: boolean;
  hasPublishedValidSeriesThisPass?: boolean;
}): ScopeReadiness {
  'worklet';

  const walletIds = uniqueSorted(args.walletIds);
  if (!walletIds.length) {
    return {
      empty: true,
      hasEverPublishedValidSeries: false,
      initialScopeReady: false,
      refreshing: args.refreshing === true,
      invalidHistoryBlocked: false,
    };
  }

  const populatedById = toIdRecord(args.populatedWalletIds);
  const invalidById = toIdRecord(args.invalidHistoryWalletIds);
  const initialScopeReady = walletIds.every(
    walletId =>
      populatedById[walletId] === true || invalidById[walletId] === true,
  );
  const invalidHistoryBlocked = walletIds.every(
    walletId => invalidById[walletId] === true,
  );

  return {
    empty: false,
    hasEverPublishedValidSeries:
      args.previous?.hasEverPublishedValidSeries === true ||
      args.hasPublishedValidSeriesThisPass === true,
    initialScopeReady,
    refreshing: args.refreshing === true,
    invalidHistoryBlocked,
  };
}

function buildReadinessByScopeKey(args: {
  defaultWalletIds: readonly string[];
  total: PerIntervalSeries;
  populatedWalletIds: readonly string[];
  invalidHistoryWalletIds: readonly string[];
  previousReadinessByScopeKey?: Readonly<Record<string, ScopeReadiness>>;
  scopes?: readonly PortfolioScopeComputedStateInput[];
  hasPublishedValidSeriesThisPass?: boolean;
}): Readonly<Record<string, ScopeReadiness>> {
  'worklet';

  const scopes =
    args.scopes && args.scopes.length
      ? args.scopes
      : [
          {
            scopeKey: 'home',
            walletIds: args.defaultWalletIds,
            hasPublishedValidSeriesThisPass:
              args.hasPublishedValidSeriesThisPass ??
              hasAnySeriesPoints(args.total),
          },
        ];
  const out: Record<string, ScopeReadiness> = {};

  for (const scope of scopes) {
    out[scope.scopeKey] = buildScopeReadiness({
      walletIds: scope.walletIds,
      populatedWalletIds: args.populatedWalletIds,
      invalidHistoryWalletIds: args.invalidHistoryWalletIds,
      previous: args.previousReadinessByScopeKey?.[scope.scopeKey],
      refreshing: scope.refreshing,
      hasPublishedValidSeriesThisPass:
        scope.hasPublishedValidSeriesThisPass,
    });
  }

  return out;
}

function buildScopedPortfolioSlice(args: {
  input: ScopedPortfolioComputedStateInput;
  quoteCurrency: string;
  walletInputsById: Readonly<Record<string, WalletSliceAssemblyInput>>;
  invalidHistoryWalletIds: readonly string[];
  populatedWalletIds: readonly string[];
  previous?: ScopedPortfolioSlice;
  computedAtMs: number;
}):
  | Readonly<{kind: 'valid'; slice: ScopedPortfolioSlice}>
  | Readonly<{kind: 'invalid'; reason: RecomputeStateSlicesInvalidReason}> {
  'worklet';

  const walletIds = uniqueSorted(args.input.walletIds);
  const wallets = walletIds.flatMap(walletId => {
    const wallet = args.walletInputsById[walletId];
    return wallet ? [wallet] : [];
  });
  const scopedSlices = buildRecomputeStateSlices({
    quoteCurrency: args.quoteCurrency,
    wallets,
    assetGroups: args.input.assetGroups.map(assetGroup => ({
      ...assetGroup,
      fingerprint: '',
    })),
  });
  if (scopedSlices.kind !== 'valid') {
    return scopedSlices;
  }

  const byAssetGroup: Record<string, AssetGroupSlice> = {};
  const shellByAssetGroupId: Record<string, AssetGroupRowShell> = {};
  for (const shell of scopedSlices.rowShells) {
    shellByAssetGroupId[shell.assetGroupId] = shell;
  }

  for (const assetGroupId of Object.keys(scopedSlices.byAssetGroup)) {
    const slice = scopedSlices.byAssetGroup[assetGroupId];
    if (!slice) {
      continue;
    }
    byAssetGroup[assetGroupId] = {
      ...slice,
      fingerprint: buildAssetGroupSliceFingerprint({
        slice,
        shell: shellByAssetGroupId[assetGroupId],
      }),
    };
  }

  const total = args.input.total ?? {};
  const totalFingerprint = buildTotalFingerprint(total);
  const invalidHistoryWalletIdsById = toIdRecord(
    walletIds.filter(walletId =>
      args.invalidHistoryWalletIds.includes(walletId),
    ),
  );
  const invalidHistoryAssetGroupIdsById: Record<string, true> = {};
  for (const assetGroupId of Object.keys(byAssetGroup)) {
    const assetGroup = byAssetGroup[assetGroupId];
    if (
      assetGroup?.memberWalletIds.some(
        walletId => invalidHistoryWalletIdsById[walletId] === true,
      )
    ) {
      invalidHistoryAssetGroupIdsById[assetGroupId] = true;
    }
  }
  const readiness = buildScopeReadiness({
    walletIds,
    populatedWalletIds: args.populatedWalletIds,
    invalidHistoryWalletIds: args.invalidHistoryWalletIds,
    previous: args.previous?.readiness,
    refreshing: args.input.refreshing,
    hasPublishedValidSeriesThisPass:
      args.input.hasPublishedValidSeriesThisPass ??
      (hasAnySeriesPoints(total) || hasAnyAssetGroupSeriesPoints(byAssetGroup)),
  });
  const sliceWithoutFingerprint = {
    walletIdsKey: args.input.walletIdsKey,
    walletIds,
    computedAtMs: args.computedAtMs,
    readiness,
    total,
    totalFingerprint,
    byAssetGroup,
    rowShells: scopedSlices.rowShells,
    orderedAssetGroupIdsForAssetList: scopedSlices.rowShells.map(
      rowShell => rowShell.assetGroupId,
    ),
    invalidHistoryWalletIdsById,
    invalidHistoryAssetGroupIdsById,
    lastAccessedAt: args.input.lastAccessedAt ?? args.computedAtMs,
  };

  return {
    kind: 'valid',
    slice: {
      ...sliceWithoutFingerprint,
      fingerprint: buildScopedSliceFingerprint(sliceWithoutFingerprint),
    },
  };
}

function evictScopedCacheToCap(args: {
  cache: Record<string, ScopedPortfolioSlice>;
  protectedKeys: Readonly<Record<string, true>>;
}): Readonly<Record<string, ScopedPortfolioSlice>> {
  'worklet';

  const cache = {...args.cache};
  const keys = Object.keys(cache);
  if (keys.length <= MAX_SCOPED_CACHE_ENTRIES) {
    return cache;
  }

  const evictionCandidates = keys
    .filter(key => args.protectedKeys[key] !== true)
    .sort((a, b) => {
      const aSlice = cache[a];
      const bSlice = cache[b];
      const accessDelta =
        (aSlice?.lastAccessedAt ?? 0) - (bSlice?.lastAccessedAt ?? 0);
      return accessDelta !== 0 ? accessDelta : a.localeCompare(b);
    });

  for (const key of evictionCandidates) {
    if (Object.keys(cache).length <= MAX_SCOPED_CACHE_ENTRIES) {
      break;
    }
    delete cache[key];
  }

  return cache;
}

function buildScopedByWalletSet(args: {
  previous?: Readonly<Record<string, ScopedPortfolioSlice>>;
  scopedInputs?: readonly ScopedPortfolioComputedStateInput[];
  protectedScopedWalletIdsKeys?: readonly string[];
  evictScopedWalletIds?: readonly string[];
  quoteCurrency: string;
  walletInputsById: Readonly<Record<string, WalletSliceAssemblyInput>>;
  invalidHistoryWalletIds: readonly string[];
  populatedWalletIds: readonly string[];
  computedAtMs: number;
}):
  | Readonly<{
      kind: 'valid';
      scopedByWalletSet: Readonly<Record<string, ScopedPortfolioSlice>>;
    }>
  | Readonly<{kind: 'invalid'; reason: RecomputeStateSlicesInvalidReason}> {
  'worklet';

  const evictById = toIdRecord(args.evictScopedWalletIds ?? []);
  const cache: Record<string, ScopedPortfolioSlice> = {};
  for (const [key, entry] of Object.entries(args.previous ?? {})) {
    if (!intersects(entry.walletIds, evictById)) {
      cache[key] = entry;
    }
  }

  for (const scopedInput of args.scopedInputs ?? []) {
    const previous = cache[scopedInput.walletIdsKey];
    const scoped = buildScopedPortfolioSlice({
      input: scopedInput,
      quoteCurrency: args.quoteCurrency,
      walletInputsById: args.walletInputsById,
      invalidHistoryWalletIds: args.invalidHistoryWalletIds,
      populatedWalletIds: args.populatedWalletIds,
      previous,
      computedAtMs: args.computedAtMs,
    });
    if (scoped.kind !== 'valid') {
      return scoped;
    }
    cache[scopedInput.walletIdsKey] = scoped.slice;
  }

  const protectedKeys = toIdRecord([
    ...(args.protectedScopedWalletIdsKeys ?? []),
    ...(args.scopedInputs ?? []).map(scoped => scoped.walletIdsKey),
  ]);

  return {
    kind: 'valid',
    scopedByWalletSet: evictScopedCacheToCap({cache, protectedKeys}),
  };
}

export function buildPortfolioComputedState(
  args: BuildPortfolioComputedStateArgs,
): BuildPortfolioComputedStateResult {
  'worklet';

  const validationError = validatePortfolioComputedStateArgs(args);
  if (validationError) {
    return {kind: 'invalid', reason: validationError};
  }

  const walletInputs: WalletSliceAssemblyInput[] = args.wallets.map(
    wallet => ({
      ...wallet,
      fingerprint: buildWalletSliceFingerprint(wallet),
    }),
  );
  const assetGroupInputs: AssetGroupSliceAssemblyInput[] = args.assetGroups.map(
    assetGroup => ({
      ...assetGroup,
      fingerprint: '',
    }),
  );
  const slices = buildRecomputeStateSlices({
    quoteCurrency: args.quoteCurrency,
    wallets: walletInputs,
    assetGroups: assetGroupInputs,
  });
  if (slices.kind !== 'valid') {
    return slices;
  }

  const byAssetGroup: Record<string, AssetGroupSlice> = {};
  const shellByAssetGroupId: Record<string, AssetGroupRowShell> = {};
  for (const shell of slices.rowShells) {
    shellByAssetGroupId[shell.assetGroupId] = shell;
  }

  for (const assetGroupId of Object.keys(slices.byAssetGroup)) {
    const slice = slices.byAssetGroup[assetGroupId];
    if (!slice) {
      continue;
    }
    byAssetGroup[assetGroupId] = {
      ...slice,
      fingerprint: buildAssetGroupSliceFingerprint({
        slice,
        shell: shellByAssetGroupId[assetGroupId],
      }),
    };
  }

  const total = args.total ?? {};
  const hasPublishedValidSeriesThisPass =
    hasAnySeriesPoints(total) || hasAnyAssetGroupSeriesPoints(byAssetGroup);
  const populatedWalletIds = uniqueSorted(args.populatedWalletIds ?? []);
  const invalidHistoryWalletIds = uniqueSorted(
    args.invalidHistoryWalletIds ?? [],
  );
  const rowShells = slices.rowShells;
  const walletInputsById: Record<string, WalletSliceAssemblyInput> = {};
  for (const wallet of walletInputs) {
    walletInputsById[wallet.walletId] = wallet;
  }
  const scopedCache = buildScopedByWalletSet({
    previous: args.previousScopedByWalletSet,
    scopedInputs: args.scopedSlices,
    protectedScopedWalletIdsKeys: args.protectedScopedWalletIdsKeys,
    evictScopedWalletIds: args.evictScopedWalletIds,
    quoteCurrency: args.quoteCurrency,
    walletInputsById,
    invalidHistoryWalletIds,
    populatedWalletIds,
    computedAtMs: args.computedAtMs,
  });
  if (scopedCache.kind !== 'valid') {
    return scopedCache;
  }

  return {
    kind: 'valid',
    state: {
      schemaVersion: 1,
      workEpoch: args.workEpoch,
      revision: args.revision,
      quoteCurrency: args.quoteCurrency,
      canonicalRateQuoteCurrency: CANONICAL_RATE_QUOTE,
      computedAtMs: args.computedAtMs,
      status: buildStatus({
        invalidHistoryWalletIds,
        missingRateSourceKeys: args.missingRateSourceKeys ?? [],
        retryScheduledWalletIds: args.retryScheduledWalletIds ?? [],
        retryScheduledRateSourceKeys:
          args.retryScheduledRateSourceKeys ?? [],
        staleReasons: args.staleReasons ?? [],
      }),
      populatedWalletIdsKey: populatedWalletIds.join('|'),
      populatedWalletIdsById: toIdRecord(populatedWalletIds),
      invalidHistoryWalletIdsKey: invalidHistoryWalletIds.join('|'),
      invalidHistoryWalletIdsById: toIdRecord(invalidHistoryWalletIds),
      readinessByScopeKey: buildReadinessByScopeKey({
        defaultWalletIds: args.wallets.map(wallet => wallet.walletId),
        total,
        populatedWalletIds,
        invalidHistoryWalletIds,
        previousReadinessByScopeKey: args.previousReadinessByScopeKey,
        scopes: args.scopes,
        hasPublishedValidSeriesThisPass,
      }),
      orderedAssetGroupIdsForAssetList: rowShells.map(
        rowShell => rowShell.assetGroupId,
      ),
      orderRevision: args.orderRevision ?? 0,
      byWallet: slices.byWallet,
      byAssetGroup,
      rowShells,
      total,
      totalFingerprint: buildTotalFingerprint(total),
      scopedByWalletSet: scopedCache.scopedByWalletSet,
    },
  };
}
