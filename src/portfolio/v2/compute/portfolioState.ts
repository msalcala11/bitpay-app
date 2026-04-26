import {CANONICAL_RATE_QUOTE} from '../constants';
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
}>;

export type BuildPortfolioComputedStateResult =
  | Readonly<{kind: 'valid'; state: PortfolioState}>
  | Readonly<{kind: 'invalid'; reason: RecomputeStateSlicesInvalidReason}>;

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

function toIdRecord(values: readonly string[]): Readonly<Record<string, true>> {
  'worklet';

  const out: Record<string, true> = {};
  for (const value of uniqueSorted(values)) {
    out[value] = true;
  }
  return out;
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

function buildReadinessByScopeKey(args: {
  defaultWalletIds: readonly string[];
  total: PerIntervalSeries;
  populatedWalletIds: readonly string[];
  invalidHistoryWalletIds: readonly string[];
  previousReadinessByScopeKey?: Readonly<Record<string, ScopeReadiness>>;
  scopes?: readonly PortfolioScopeComputedStateInput[];
}): Readonly<Record<string, ScopeReadiness>> {
  'worklet';

  const scopes =
    args.scopes && args.scopes.length
      ? args.scopes
      : [
          {
            scopeKey: 'home',
            walletIds: args.defaultWalletIds,
            hasPublishedValidSeriesThisPass: hasAnySeriesPoints(args.total),
          },
        ];
  const populatedById = toIdRecord(args.populatedWalletIds);
  const invalidById = toIdRecord(args.invalidHistoryWalletIds);
  const out: Record<string, ScopeReadiness> = {};

  for (const scope of scopes) {
    const walletIds = uniqueSorted(scope.walletIds);
    if (!walletIds.length) {
      out[scope.scopeKey] = {
        empty: true,
        hasEverPublishedValidSeries: false,
        initialScopeReady: false,
        refreshing: scope.refreshing === true,
        invalidHistoryBlocked: false,
      };
      continue;
    }

    const initialScopeReady = walletIds.every(
      walletId =>
        populatedById[walletId] === true || invalidById[walletId] === true,
    );
    const invalidHistoryBlocked = walletIds.every(
      walletId => invalidById[walletId] === true,
    );
    const previous = args.previousReadinessByScopeKey?.[scope.scopeKey];

    out[scope.scopeKey] = {
      empty: false,
      hasEverPublishedValidSeries:
        previous?.hasEverPublishedValidSeries === true ||
        scope.hasPublishedValidSeriesThisPass === true,
      initialScopeReady,
      refreshing: scope.refreshing === true,
      invalidHistoryBlocked,
    };
  }

  return out;
}

export function buildPortfolioComputedState(
  args: BuildPortfolioComputedStateArgs,
): BuildPortfolioComputedStateResult {
  'worklet';

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
  const populatedWalletIds = uniqueSorted(args.populatedWalletIds ?? []);
  const invalidHistoryWalletIds = uniqueSorted(
    args.invalidHistoryWalletIds ?? [],
  );
  const rowShells = slices.rowShells;

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
      scopedByWalletSet: {},
    },
  };
}
