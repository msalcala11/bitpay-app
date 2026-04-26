import type {
  AssetGroupSlice,
  AssetGroupRowShell,
  Interval,
  MarketRatePoint,
  PerIntervalSeries,
  PerIntervalWeightedGroupRateSeries,
  RowPayload,
  StoredRateInterval,
  WalletSlice,
  WeightedGroupRateSeries,
} from '../model';
import {
  buildAssetGroupRowPayload,
  buildAssetGroupRowShell,
  type AssetGroupRowShellMemberInput,
} from './assetGroupRows';
import {
  buildWeightedGroupRateSeries,
  type WeightedGroupRateConstituentInput,
} from './weightedGroupRates';

export type WalletSliceAssemblyInput = Readonly<{
  walletId: string;
  assetGroupId: string;
  fingerprint: string;
  series: PerIntervalSeries;
  rowToday?: RowPayload;
  rowAllTime?: RowPayload;
  lastWrittenAt: number;
  lastAccessedAt: number;
}>;

export type AssetGroupSliceAssemblyInput = Readonly<{
  assetGroupId: string;
  fingerprint: string;
  displaySymbol: string;
  orderIndex: number;
  series: PerIntervalSeries;
  members: readonly AssetGroupRowShellMemberInput[];
  marketRatePointsByInterval?: Readonly<
    Partial<Record<Interval, readonly MarketRatePoint[]>>
  >;
  weightedConstituentsByInterval?: Readonly<
    Partial<Record<Interval, readonly WeightedGroupRateConstituentInput[]>>
  >;
  sampledFromStoredIntervalByInterval?: Readonly<
    Partial<Record<Interval, StoredRateInterval>>
  >;
  symbolCollisionSuspected?: boolean;
}>;

export type BuildRecomputeStateSlicesArgs = Readonly<{
  quoteCurrency: string;
  wallets: readonly WalletSliceAssemblyInput[];
  assetGroups: readonly AssetGroupSliceAssemblyInput[];
}>;

export type RecomputeStateSlicesInvalidReason =
  | 'duplicateWalletId'
  | 'duplicateAssetGroupId'
  | 'missingAssetGroupMember'
  | 'invalidRowShell';

export type BuildRecomputeStateSlicesResult =
  | Readonly<{
      kind: 'valid';
      byWallet: Readonly<Record<string, WalletSlice>>;
      byAssetGroup: Readonly<Record<string, AssetGroupSlice>>;
      rowShells: readonly AssetGroupRowShell[];
    }>
  | Readonly<{
      kind: 'invalid';
      reason: RecomputeStateSlicesInvalidReason;
    }>;

const ROW_INTERVALS: ReadonlyArray<
  Readonly<{interval: Interval; key: 'rowToday' | 'rowAllTime'}>
> = [
  {interval: '1D', key: 'rowToday'},
  {interval: 'ALL', key: 'rowAllTime'},
];

function uniqueSorted(values: readonly string[]): readonly string[] {
  'worklet';

  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

function getSeriesIntervals(series: PerIntervalSeries): readonly Interval[] {
  'worklet';

  return (Object.keys(series) as Interval[]).filter(
    interval => !!series[interval],
  );
}

function hasMultipleRateSources(
  members: readonly AssetGroupRowShellMemberInput[],
): boolean {
  'worklet';

  return uniqueSorted(members.map(member => member.rateSourceKey)).length > 1;
}

function assembleWeightedGroupRateSeries(args: {
  quoteCurrency: string;
  assetGroup: AssetGroupSliceAssemblyInput;
  memberWalletIdsKey: string;
}): PerIntervalWeightedGroupRateSeries | undefined {
  'worklet';

  if (!hasMultipleRateSources(args.assetGroup.members)) {
    return undefined;
  }

  const out: Partial<Record<Interval, WeightedGroupRateSeries>> = {};

  for (const interval of getSeriesIntervals(args.assetGroup.series)) {
    const series = args.assetGroup.series[interval];
    const constituents =
      args.assetGroup.weightedConstituentsByInterval?.[interval];
    if (!series || !constituents) {
      continue;
    }

    out[interval] = buildWeightedGroupRateSeries({
      quoteCurrency: args.quoteCurrency,
      assetGroupId: args.assetGroup.assetGroupId,
      walletIdsKey: args.memberWalletIdsKey,
      interval,
      windowStartTs: series.windowStartTs,
      windowEndTs: series.windowEndTs,
      sampledFromStoredInterval:
        args.assetGroup.sampledFromStoredIntervalByInterval?.[interval] ??
        series.sampledFromStoredInterval,
      constituents,
    });
  }

  return Object.keys(out).length ? out : undefined;
}

function buildRowsForAssetGroup(args: {
  assetGroup: AssetGroupSliceAssemblyInput;
  weightedGroupRateSeries?: PerIntervalWeightedGroupRateSeries;
}): Pick<AssetGroupSlice, 'rowToday' | 'rowAllTime'> {
  'worklet';

  const rows: Partial<Record<'rowToday' | 'rowAllTime', RowPayload>> = {};
  const isCollapsed = hasMultipleRateSources(args.assetGroup.members);

  for (const rowInterval of ROW_INTERVALS) {
    const series = args.assetGroup.series[rowInterval.interval];
    if (!series) {
      continue;
    }

    let rateSource:
      | Parameters<typeof buildAssetGroupRowPayload>[0]['rateSource']
      | undefined;

    if (isCollapsed) {
      const weightedSeries =
        args.weightedGroupRateSeries?.[rowInterval.interval];
      if (weightedSeries) {
        rateSource = {
          kind: 'weightedGroupRateSeries',
          series: weightedSeries,
        };
      }
    } else {
      const marketPoints =
        args.assetGroup.marketRatePointsByInterval?.[rowInterval.interval];
      if (marketPoints) {
        rateSource = {
          kind: 'marketRateSeries',
          points: marketPoints,
        };
      }
    }

    if (!rateSource) {
      continue;
    }

    const row = buildAssetGroupRowPayload({
      assetGroupId: args.assetGroup.assetGroupId,
      series,
      rateSource,
    });
    if (row.kind === 'valid') {
      rows[rowInterval.key] = row.row;
    }
  }

  return rows;
}

export function buildRecomputeStateSlices(
  args: BuildRecomputeStateSlicesArgs,
): BuildRecomputeStateSlicesResult {
  'worklet';

  const byWallet: Record<string, WalletSlice> = {};
  for (const wallet of args.wallets) {
    if (byWallet[wallet.walletId]) {
      return {kind: 'invalid', reason: 'duplicateWalletId'};
    }
    byWallet[wallet.walletId] = {
      walletId: wallet.walletId,
      assetGroupId: wallet.assetGroupId,
      fingerprint: wallet.fingerprint,
      series: wallet.series,
      lastWrittenAt: wallet.lastWrittenAt,
      lastAccessedAt: wallet.lastAccessedAt,
      ...(wallet.rowToday ? {rowToday: wallet.rowToday} : {}),
      ...(wallet.rowAllTime ? {rowAllTime: wallet.rowAllTime} : {}),
    };
  }

  const byAssetGroup: Record<string, AssetGroupSlice> = {};
  const rowShells: AssetGroupRowShell[] = [];

  for (const assetGroup of args.assetGroups) {
    if (byAssetGroup[assetGroup.assetGroupId]) {
      return {kind: 'invalid', reason: 'duplicateAssetGroupId'};
    }

    for (const member of assetGroup.members) {
      if (!byWallet[member.walletId]) {
        return {kind: 'invalid', reason: 'missingAssetGroupMember'};
      }
    }

    const memberWalletIdsKey = uniqueSorted(
      assetGroup.members.map(member => member.walletId),
    ).join('|');
    const weightedGroupRateSeries = assembleWeightedGroupRateSeries({
      quoteCurrency: args.quoteCurrency,
      assetGroup,
      memberWalletIdsKey,
    });
    const rows = buildRowsForAssetGroup({
      assetGroup,
      weightedGroupRateSeries,
    });
    const shell = buildAssetGroupRowShell({
      assetGroupId: assetGroup.assetGroupId,
      displaySymbol: assetGroup.displaySymbol,
      orderIndex: assetGroup.orderIndex,
      members: assetGroup.members,
      rowToday: rows.rowToday,
      rowAllTime: rows.rowAllTime,
      symbolCollisionSuspected: assetGroup.symbolCollisionSuspected,
    });

    if (shell.kind === 'invalid') {
      return {kind: 'invalid', reason: 'invalidRowShell'};
    }

    if (shell.kind === 'visible') {
      rowShells.push(shell.rowShell);
    }

    byAssetGroup[assetGroup.assetGroupId] = {
      assetGroupId: assetGroup.assetGroupId,
      fingerprint: assetGroup.fingerprint,
      memberWalletIds:
        shell.kind === 'visible' ? shell.rowShell.memberWalletIds : [],
      memberWalletIdsKey:
        shell.kind === 'visible' ? shell.rowShell.memberWalletIdsKey : '',
      series: assetGroup.series,
      ...(weightedGroupRateSeries ? {weightedGroupRateSeries} : {}),
      ...rows,
    };
  }

  rowShells.sort((a, b) => a.orderIndex - b.orderIndex);

  return {kind: 'valid', byWallet, byAssetGroup, rowShells};
}
