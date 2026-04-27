import type {
  AssetGroupMemberDescriptor,
  AssetGroupRowShell,
  MarketRatePoint,
  RowPayload,
  Series,
  WeightedGroupRateSeries,
} from '../model';
import {stableWalletIdsKey} from '../ordering';
import {
  buildRowPayloadFromSeries,
  type RowPayloadInvalidReason,
} from './rowPayload';
import {
  atomicToDisplayUnitAmount,
  formatDisplayUnitAmountString,
  isValidDisplayUnitDecimals,
  parseAtomicUnits,
  pow10,
  type AtomicDisplayUnitAmount,
} from './amountBoundary';

export {
  atomicToDisplayUnitAmount,
  type AtomicDisplayUnitAmount as DisplayUnitAmount,
};

export type AssetGroupRowShellMemberInput = Readonly<{
  walletId: string;
  assetIdentityKey: string;
  rateSourceKey: string;
  displayUnitsAtomic: string;
  displayUnitDecimals: number;
  liveRate?: number;
  invalidHistoryBlocked?: boolean;
  descriptor?: Partial<Omit<AssetGroupMemberDescriptor, 'walletCount'>>;
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
  | 'duplicateWalletId'
  | 'invalidDisplayUnitsAtomic'
  | 'negativeDisplayUnitsAtomic'
  | 'invalidDisplayUnitDecimals'
  | 'nonFiniteDisplayUnits'
  | 'unsafeDisplayUnits'
  | 'nonFiniteOrderIndex';

export type BuildAssetGroupRowShellResult =
  | Readonly<{kind: 'visible'; rowShell: AssetGroupRowShell}>
  | Readonly<{kind: 'empty'}>
  | Readonly<{kind: 'invalid'; reason: AssetGroupRowShellInvalidReason}>;

export type AssetGroupRowRateSource =
  | Readonly<{kind: 'marketRateSeries'; points: readonly MarketRatePoint[]}>
  | Readonly<{
      kind: 'weightedGroupRateSeries';
      series: WeightedGroupRateSeries;
    }>;

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
        | 'malformedWeightedRateSeries'
        | 'rateEndpointMismatch';
    }>;

function isStrictIdentity(value: unknown): value is string {
  'worklet';

  return typeof value === 'string' && !!value.trim() && value === value.trim();
}

function normalizeDisplaySymbol(value: unknown): string | null {
  'worklet';

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function isFiniteNumber(value: number): boolean {
  'worklet';

  return typeof value === 'number' && Number.isFinite(value);
}

function hasUsableLiveRate(value: number | undefined): value is number {
  'worklet';

  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function formatScaledAtomicUnits(atomic: bigint, decimals: number): string {
  'worklet';

  return formatDisplayUnitAmountString(atomic, decimals);
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  'worklet';

  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

function sanitizeDescriptorText(value: unknown): string | undefined {
  'worklet';

  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  // Descriptors are UI labels only. Do not let raw-looking token addresses or
  // provider/rate keys leak into the published row shell.
  if (
    /0x[a-fA-F0-9]{12,}/.test(trimmed) ||
    /rate:v\d|portfolio:v\d|snap:/.test(trimmed)
  ) {
    return undefined;
  }
  return trimmed;
}

function buildMemberDescriptors(args: {
  displaySymbol: string;
  members: readonly AssetGroupRowShellMemberInput[];
}): readonly AssetGroupMemberDescriptor[] {
  'worklet';

  const byDescriptor = new Map<string, AssetGroupMemberDescriptor>();
  for (const member of args.members) {
    const displaySymbol =
      sanitizeDescriptorText(member.descriptor?.displaySymbol) ??
      args.displaySymbol;
    const currencyName = sanitizeDescriptorText(
      member.descriptor?.currencyName,
    );
    const chainLabel = sanitizeDescriptorText(member.descriptor?.chainLabel);
    const networkLabel = sanitizeDescriptorText(
      member.descriptor?.networkLabel,
    );
    const sourceLabel = sanitizeDescriptorText(member.descriptor?.sourceLabel);
    const tokenAddressLabel = sanitizeDescriptorText(
      member.descriptor?.tokenAddressLabel,
    );
    const descriptor: AssetGroupMemberDescriptor = {
      displaySymbol,
      ...(currencyName ? {currencyName} : {}),
      ...(chainLabel ? {chainLabel} : {}),
      ...(networkLabel ? {networkLabel} : {}),
      ...(sourceLabel ? {sourceLabel} : {}),
      ...(tokenAddressLabel ? {tokenAddressLabel} : {}),
      walletCount: 1,
    };
    const key = JSON.stringify({
      displaySymbol: descriptor.displaySymbol,
      currencyName: descriptor.currencyName ?? '',
      chainLabel: descriptor.chainLabel ?? '',
      networkLabel: descriptor.networkLabel ?? '',
      sourceLabel: descriptor.sourceLabel ?? '',
      tokenAddressLabel: descriptor.tokenAddressLabel ?? '',
    });
    const existing = byDescriptor.get(key);
    byDescriptor.set(
      key,
      existing
        ? {...existing, walletCount: existing.walletCount + 1}
        : descriptor,
    );
  }

  return Array.from(byDescriptor.values()).sort((left, right) => {
    const symbolDelta = left.displaySymbol.localeCompare(right.displaySymbol);
    if (symbolDelta !== 0) {
      return symbolDelta;
    }
    return JSON.stringify(left).localeCompare(JSON.stringify(right));
  });
}

function getPortfolioSeriesEndpointTimestamps(
  series: Pick<Series, 'points'>,
): {startTs: number; endTs: number} | null {
  'worklet';

  if (!series.points.length) {
    return null;
  }

  const first = series.points[0];
  const last = series.points[series.points.length - 1];
  if (
    !first ||
    !last ||
    !isFiniteNumber(first.ts) ||
    !isFiniteNumber(last.ts)
  ) {
    return null;
  }

  return {startTs: first.ts, endTs: last.ts};
}

function getMarketRateEndpoints(
  points: readonly MarketRatePoint[],
  required: {startTs: number; endTs: number},
):
  | Readonly<{
      kind: 'valid';
      rateStart: number;
      rateEnd: number;
      ratePercent: number;
    }>
  | Readonly<{kind: 'empty' | 'malformed' | 'mismatch'}> {
  'worklet';

  if (!points.length) {
    return {kind: 'empty'};
  }

  let previousTs = -Infinity;
  for (const point of points) {
    if (
      !isFiniteNumber(point.ts) ||
      !isFiniteNumber(point.rate) ||
      !isFiniteNumber(point.percentChange) ||
      point.rate <= 0 ||
      point.ts <= previousTs
    ) {
      return {kind: 'malformed'};
    }
    previousTs = point.ts;
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
    return {kind: 'malformed'};
  }
  if (first.ts !== required.startTs || last.ts !== required.endTs) {
    return {kind: 'mismatch'};
  }

  return {
    kind: 'valid',
    rateStart: first.rate,
    rateEnd: last.rate,
    ratePercent: last.percentChange,
  };
}

function getWeightedRateEndpoints(
  series: WeightedGroupRateSeries,
  required: {startTs: number; endTs: number},
):
  | Readonly<{
      kind: 'valid';
      rateStart: number;
      rateEnd: number;
      ratePercent: number;
    }>
  | Readonly<{kind: 'empty' | 'malformed' | 'mismatch'}> {
  'worklet';

  if (series.availability !== 'valid' || !series.points.length) {
    return {kind: 'empty'};
  }

  let previousTs = -Infinity;
  for (const point of series.points) {
    if (
      !isFiniteNumber(point.ts) ||
      !isFiniteNumber(point.weightedRate) ||
      !isFiniteNumber(point.weightedPercent) ||
      point.weightedRate <= 0 ||
      point.ts <= previousTs
    ) {
      return {kind: 'malformed'};
    }
    previousTs = point.ts;
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
    return {kind: 'malformed'};
  }
  if (first.ts !== required.startTs || last.ts !== required.endTs) {
    return {kind: 'mismatch'};
  }

  return {
    kind: 'valid',
    rateStart: first.weightedRate,
    rateEnd: last.weightedRate,
    ratePercent: last.weightedPercent,
  };
}

export function buildAssetGroupRowPayload(
  args: BuildAssetGroupRowPayloadArgs,
): BuildAssetGroupRowPayloadResult {
  'worklet';

  const requiredEndpointTimestamps = getPortfolioSeriesEndpointTimestamps(
    args.series,
  );
  if (!requiredEndpointTimestamps) {
    const row = buildRowPayloadFromSeries({
      assetGroupId: args.assetGroupId,
      series: args.series,
      rateStart: 1,
      rateEnd: 1,
    });
    return row.kind === 'valid'
      ? {kind: 'missingRateSource', reason: 'rateEndpointMismatch'}
      : {kind: 'invalidHistory', reason: row.reason};
  }

  let endpoints: {
    rateStart: number;
    rateEnd: number;
    ratePercent: number;
  };

  if (args.rateSource.kind === 'marketRateSeries') {
    const marketEndpoints = getMarketRateEndpoints(
      args.rateSource.points,
      requiredEndpointTimestamps,
    );
    if (marketEndpoints.kind !== 'valid') {
      return {
        kind: 'missingRateSource',
        reason:
          marketEndpoints.kind === 'empty'
            ? 'emptyMarketRateSeries'
            : marketEndpoints.kind === 'mismatch'
            ? 'rateEndpointMismatch'
            : 'malformedMarketRateSeries',
      };
    }
    endpoints = marketEndpoints;
  } else {
    if (args.rateSource.series.availability !== 'valid') {
      return {kind: 'missingRateSource', reason: 'weightedRateUnavailable'};
    }
    const weightedEndpoints = getWeightedRateEndpoints(
      args.rateSource.series,
      requiredEndpointTimestamps,
    );
    if (weightedEndpoints.kind !== 'valid') {
      return {
        kind: 'missingRateSource',
        reason:
          weightedEndpoints.kind === 'empty'
            ? 'emptyWeightedRateSeries'
            : weightedEndpoints.kind === 'mismatch'
            ? 'rateEndpointMismatch'
            : 'malformedWeightedRateSeries',
      };
    }
    endpoints = weightedEndpoints;
  }

  const row = buildRowPayloadFromSeries({
    assetGroupId: args.assetGroupId,
    series: args.series,
    rateStart: endpoints.rateStart,
    rateEnd: endpoints.rateEnd,
    ratePercent: endpoints.ratePercent,
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
  const displaySymbol = normalizeDisplaySymbol(args.displaySymbol);
  if (!displaySymbol) {
    return {kind: 'invalid', reason: 'missingDisplaySymbol'};
  }
  if (!isFiniteNumber(args.orderIndex)) {
    return {kind: 'invalid', reason: 'nonFiniteOrderIndex'};
  }
  if (!args.members.length) {
    return {kind: 'empty'};
  }

  const seenWalletIds = new Set<string>();
  for (const member of args.members) {
    if (!isStrictIdentity(member.walletId)) {
      return {kind: 'invalid', reason: 'missingWalletId'};
    }
    if (seenWalletIds.has(member.walletId)) {
      return {kind: 'invalid', reason: 'duplicateWalletId'};
    }
    seenWalletIds.add(member.walletId);
    if (!isStrictIdentity(member.assetIdentityKey)) {
      return {kind: 'invalid', reason: 'missingAssetIdentityKey'};
    }
    if (!isStrictIdentity(member.rateSourceKey)) {
      return {kind: 'invalid', reason: 'missingRateSourceKey'};
    }
    const atomicUnits = parseAtomicUnits(member.displayUnitsAtomic);
    if (atomicUnits === null) {
      return {kind: 'invalid', reason: 'invalidDisplayUnitsAtomic'};
    }
    if (atomicUnits < 0n) {
      return {kind: 'invalid', reason: 'negativeDisplayUnitsAtomic'};
    }
    if (!isValidDisplayUnitDecimals(member.displayUnitDecimals)) {
      return {kind: 'invalid', reason: 'invalidDisplayUnitDecimals'};
    }
  }

  const memberWalletIds = args.members.map(member => member.walletId);
  const memberWalletIdsKey = stableWalletIdsKey(memberWalletIds);
  const memberRateSourceKeys = uniqueSorted(
    args.members.map(member => member.rateSourceKey),
  );
  const assetIdentityKeys = uniqueSorted(
    args.members.map(member => member.assetIdentityKey),
  );
  const unitDecimals = uniqueSorted(
    args.members.map(member => String(member.displayUnitDecimals)),
  );
  const maxDisplayUnitDecimals = Math.max(
    ...args.members.map(member => member.displayUnitDecimals),
  );

  let currentCryptoAtomicScaled = 0n;
  let currentFiatValue = 0;
  let hasNonzeroMember = false;
  let hasNonzeroMissingLiveRate = false;
  const missingLiveRateMemberWalletIds: string[] = [];
  const nonzeroMissingLiveRateMemberWalletIds: string[] = [];

  for (const member of args.members) {
    const memberAtomic = parseAtomicUnits(member.displayUnitsAtomic);
    if (memberAtomic === null) {
      return {kind: 'invalid', reason: 'invalidDisplayUnitsAtomic'};
    }
    const displayAmount = atomicToDisplayUnitAmount({
      atomic: member.displayUnitsAtomic,
      decimals: member.displayUnitDecimals,
    });
    if ('kind' in displayAmount) {
      return {kind: 'invalid', reason: displayAmount.reason};
    }
    const scale = pow10(maxDisplayUnitDecimals - member.displayUnitDecimals);
    currentCryptoAtomicScaled += memberAtomic * scale;

    if (memberAtomic !== 0n) {
      hasNonzeroMember = true;
    }

    if (!hasUsableLiveRate(member.liveRate)) {
      missingLiveRateMemberWalletIds.push(member.walletId);
      if (memberAtomic !== 0n) {
        hasNonzeroMissingLiveRate = true;
        nonzeroMissingLiveRateMemberWalletIds.push(member.walletId);
      }
      continue;
    }

    if (memberAtomic !== 0n) {
      currentFiatValue += displayAmount.approximateNumber * member.liveRate;
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
    displaySymbol,
    currentCryptoAmount: formatScaledAtomicUnits(
      currentCryptoAtomicScaled,
      maxDisplayUnitDecimals,
    ),
    memberWalletIds,
    memberWalletIdsKey,
    memberRateSourceKeys,
    memberDescriptors: buildMemberDescriptors({
      displaySymbol,
      members: args.members,
    }),
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
