import type {
  AssetGroupRowShell,
  MarketRatePoint,
  RowPayload,
  Series,
  WeightedGroupRateSeries,
} from '../model';
import {
  buildRowPayloadFromSeries,
  type RowPayloadInvalidReason,
} from './rowPayload';

export type AssetGroupRowShellMemberInput = Readonly<{
  walletId: string;
  assetIdentityKey: string;
  rateSourceKey: string;
  displayUnits: number;
  displayUnitDecimals: number;
  liveRate?: number;
  invalidHistoryBlocked?: boolean;
}>;

export type BuildAssetGroupRowShellArgs = Readonly<{
  assetGroupId: string;
  displaySymbol: string;
  orderIndex: number;
  members: readonly AssetGroupRowShellMemberInput[];
  rowToday?: RowPayload;
  rowAllTime?: RowPayload;
  symbolCollisionSuspected?: boolean;
}>;

export type AssetGroupRowShellInvalidReason =
  | 'missingAssetGroupId'
  | 'missingDisplaySymbol'
  | 'missingWalletId'
  | 'missingAssetIdentityKey'
  | 'missingRateSourceKey'
  | 'nonFiniteDisplayUnits'
  | 'negativeDisplayUnits'
  | 'invalidDisplayUnitDecimals'
  | 'nonFiniteOrderIndex';

export type BuildAssetGroupRowShellResult =
  | Readonly<{kind: 'visible'; rowShell: AssetGroupRowShell}>
  | Readonly<{kind: 'empty'}>
  | Readonly<{kind: 'invalid'; reason: AssetGroupRowShellInvalidReason}>;

export type AssetGroupRowRateSource =
  | Readonly<{kind: 'marketRateSeries'; points: readonly MarketRatePoint[]}>
  | Readonly<{kind: 'weightedGroupRateSeries'; series: WeightedGroupRateSeries}>;

export type BuildAssetGroupRowPayloadArgs = Readonly<{
  assetGroupId: string;
  series: Pick<Series, 'interval' | 'points'>;
  rateSource: AssetGroupRowRateSource;
}>;

export type BuildAssetGroupRowPayloadResult =
  | Readonly<{kind: 'valid'; row: RowPayload}>
  | Readonly<{
      kind: 'invalidHistory';
      reason: RowPayloadInvalidReason;
    }>
  | Readonly<{
      kind: 'missingRateSource';
      reason:
        | 'emptyMarketRateSeries'
        | 'malformedMarketRateSeries'
        | 'weightedRateUnavailable'
        | 'emptyWeightedRateSeries'
        | 'malformedWeightedRateSeries';
    }>;

function isStrictIdentity(value: string): boolean {
  'worklet';

  return !!value.trim() && value === value.trim();
}

function isFiniteNumber(value: number): boolean {
  'worklet';

  return typeof value === 'number' && Number.isFinite(value);
}

function hasUsableLiveRate(value: number | undefined): value is number {
  'worklet';

  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isValidDisplayUnitDecimals(value: number): boolean {
  'worklet';

  return Number.isInteger(value) && value >= 0 && value <= 30;
}

function formatDisplayUnits(value: number): string {
  'worklet';

  if (!Number.isFinite(value) || Object.is(value, -0)) {
    return '0';
  }

  const fixed = value.toFixed(12);
  const trimmed = fixed.replace(/\.?0+$/, '');
  return trimmed === '-0' || trimmed === '' ? '0' : trimmed;
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  'worklet';

  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

function getMarketRateEndpoints(
  points: readonly MarketRatePoint[],
): {rateStart: number; rateEnd: number} | null {
  'worklet';

  if (!points.length) {
    return null;
  }

  const first = points[0];
  const last = points[points.length - 1];
  if (
    !first ||
    !last ||
    !isFiniteNumber(first.rate) ||
    !isFiniteNumber(last.rate) ||
    first.rate <= 0 ||
    last.rate <= 0
  ) {
    return null;
  }

  return {rateStart: first.rate, rateEnd: last.rate};
}

function getWeightedRateEndpoints(
  series: WeightedGroupRateSeries,
): {rateStart: number; rateEnd: number} | null {
  'worklet';

  if (series.availability !== 'valid' || !series.points.length) {
    return null;
  }

  const first = series.points[0];
  const last = series.points[series.points.length - 1];
  if (
    !first ||
    !last ||
    !isFiniteNumber(first.weightedRate) ||
    !isFiniteNumber(last.weightedRate) ||
    first.weightedRate <= 0 ||
    last.weightedRate <= 0
  ) {
    return null;
  }

  return {rateStart: first.weightedRate, rateEnd: last.weightedRate};
}

export function buildAssetGroupRowPayload(
  args: BuildAssetGroupRowPayloadArgs,
): BuildAssetGroupRowPayloadResult {
  'worklet';

  let endpoints: {rateStart: number; rateEnd: number} | null;

  if (args.rateSource.kind === 'marketRateSeries') {
    endpoints = getMarketRateEndpoints(args.rateSource.points);
    if (!endpoints) {
      return {
        kind: 'missingRateSource',
        reason: args.rateSource.points.length
          ? 'malformedMarketRateSeries'
          : 'emptyMarketRateSeries',
      };
    }
  } else {
    if (args.rateSource.series.availability !== 'valid') {
      return {kind: 'missingRateSource', reason: 'weightedRateUnavailable'};
    }
    endpoints = getWeightedRateEndpoints(args.rateSource.series);
    if (!endpoints) {
      return {
        kind: 'missingRateSource',
        reason: args.rateSource.series.points.length
          ? 'malformedWeightedRateSeries'
          : 'emptyWeightedRateSeries',
      };
    }
  }

  const row = buildRowPayloadFromSeries({
    assetGroupId: args.assetGroupId,
    series: args.series,
    rateStart: endpoints.rateStart,
    rateEnd: endpoints.rateEnd,
  });

  return row.kind === 'valid'
    ? {kind: 'valid', row: row.row}
    : {kind: 'invalidHistory', reason: row.reason};
}

export function buildAssetGroupRowShell(
  args: BuildAssetGroupRowShellArgs,
): BuildAssetGroupRowShellResult {
  'worklet';

  if (!isStrictIdentity(args.assetGroupId)) {
    return {kind: 'invalid', reason: 'missingAssetGroupId'};
  }
  if (!isStrictIdentity(args.displaySymbol)) {
    return {kind: 'invalid', reason: 'missingDisplaySymbol'};
  }
  if (!isFiniteNumber(args.orderIndex)) {
    return {kind: 'invalid', reason: 'nonFiniteOrderIndex'};
  }
  if (!args.members.length) {
    return {kind: 'empty'};
  }

  for (const member of args.members) {
    if (!isStrictIdentity(member.walletId)) {
      return {kind: 'invalid', reason: 'missingWalletId'};
    }
    if (!isStrictIdentity(member.assetIdentityKey)) {
      return {kind: 'invalid', reason: 'missingAssetIdentityKey'};
    }
    if (!isStrictIdentity(member.rateSourceKey)) {
      return {kind: 'invalid', reason: 'missingRateSourceKey'};
    }
    if (!isFiniteNumber(member.displayUnits)) {
      return {kind: 'invalid', reason: 'nonFiniteDisplayUnits'};
    }
    if (member.displayUnits < 0) {
      return {kind: 'invalid', reason: 'negativeDisplayUnits'};
    }
    if (!isValidDisplayUnitDecimals(member.displayUnitDecimals)) {
      return {kind: 'invalid', reason: 'invalidDisplayUnitDecimals'};
    }
  }

  const memberWalletIds = args.members.map(member => member.walletId);
  const memberWalletIdsKey = uniqueSorted(memberWalletIds).join('|');
  const memberRateSourceKeys = uniqueSorted(
    args.members.map(member => member.rateSourceKey),
  );
  const assetIdentityKeys = uniqueSorted(
    args.members.map(member => member.assetIdentityKey),
  );
  const unitDecimals = uniqueSorted(
    args.members.map(member => String(member.displayUnitDecimals)),
  );

  let currentCryptoUnits = 0;
  let currentFiatValue = 0;
  let hasNonzeroMember = false;
  let hasNonzeroMissingLiveRate = false;
  const missingLiveRateMemberWalletIds: string[] = [];
  const nonzeroMissingLiveRateMemberWalletIds: string[] = [];

  for (const member of args.members) {
    currentCryptoUnits += member.displayUnits;
    if (member.displayUnits !== 0) {
      hasNonzeroMember = true;
    }

    if (!hasUsableLiveRate(member.liveRate)) {
      missingLiveRateMemberWalletIds.push(member.walletId);
      if (member.displayUnits !== 0) {
        hasNonzeroMissingLiveRate = true;
        nonzeroMissingLiveRateMemberWalletIds.push(member.walletId);
      }
      continue;
    }

    if (member.displayUnits !== 0) {
      currentFiatValue += member.displayUnits * member.liveRate;
    }
  }

  const canonicalUnitDecimals =
    unitDecimals.length === 1 ? Number(unitDecimals[0]) : undefined;
  const resolvedCurrentFiatValue = hasNonzeroMember
    ? hasNonzeroMissingLiveRate
      ? undefined
      : currentFiatValue
    : 0;
  const rowShell: AssetGroupRowShell = {
    assetGroupId: args.assetGroupId,
    displaySymbol: args.displaySymbol,
    currentCryptoAmount: formatDisplayUnits(currentCryptoUnits),
    memberWalletIds,
    memberWalletIdsKey,
    memberRateSourceKeys,
    groupHealth: {
      collapsedAcrossDistinctAssets: assetIdentityKeys.length > 1,
      decimalConflict: unitDecimals.length > 1,
      missingLiveRateMemberWalletIds,
      nonzeroMissingLiveRateMemberWalletIds,
      ...(typeof args.symbolCollisionSuspected === 'boolean'
        ? {symbolCollisionSuspected: args.symbolCollisionSuspected}
        : {}),
    },
    orderIndex: args.orderIndex,
    readyToday: !!args.rowToday,
    readyAllTime: !!args.rowAllTime,
    invalidHistoryBlocked: args.members.some(
      member => !!member.invalidHistoryBlocked,
    ),
    ...(typeof resolvedCurrentFiatValue === 'number'
      ? {currentFiatValue: resolvedCurrentFiatValue}
      : {}),
    ...(typeof canonicalUnitDecimals === 'number'
      ? {canonicalUnitDecimals}
      : {}),
    ...(args.rowToday ? {rowToday: args.rowToday} : {}),
    ...(args.rowAllTime ? {rowAllTime: args.rowAllTime} : {}),
  };

  return {kind: 'visible', rowShell};
}
