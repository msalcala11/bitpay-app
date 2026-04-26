import type {Point, RowPayload, Series} from '../model';

export type WalletPointInvalidReason =
  | 'nonFiniteTimestamp'
  | 'nonFiniteUnits'
  | 'negativeUnits'
  | 'nonFiniteRate'
  | 'nonPositiveRate'
  | 'nonFiniteRemainingCostBasis'
  | 'negativeRemainingCostBasis'
  | 'nonFiniteFiatBalance'
  | 'nonFiniteUnrealizedPnl';

export type RowPayloadInvalidReason =
  | 'missingAssetGroupId'
  | 'emptySeries'
  | 'invalidSeriesEndpoint'
  | 'malformedSeriesTimeline'
  | 'nonFiniteRate'
  | 'nonPositiveRate';

export type BuildWalletPointFromMarkArgs = Readonly<{
  ts: number;
  units: number;
  markRate: number;
  remainingCostBasisFiat: number;
  firstRemainingUnrealizedPnlFiat?: number;
}>;

export type BuildWalletPointFromMarkResult =
  | Readonly<{kind: 'valid'; point: Point}>
  | Readonly<{kind: 'invalidHistory'; reason: WalletPointInvalidReason}>;

export type BuildRowPayloadFromSeriesArgs = Readonly<{
  assetGroupId: string;
  series: Pick<Series, 'interval' | 'points'>;
  rateStart: number;
  rateEnd: number;
}>;

export type BuildRowPayloadFromSeriesResult =
  | Readonly<{kind: 'valid'; row: RowPayload}>
  | Readonly<{kind: 'invalidHistory'; reason: RowPayloadInvalidReason}>;

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

function stableHash(values: readonly (number | string)[]): string {
  'worklet';

  const input = values
    .map(value => (typeof value === 'number' ? stableNumber(value) : value))
    .join('|');
  let hash = 0x811c9dc5;

  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }

  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function isFiniteNumber(value: number): boolean {
  'worklet';

  return typeof value === 'number' && Number.isFinite(value);
}

function isValidPointEndpoint(point: Point | undefined): point is Point {
  'worklet';

  return (
    !!point &&
    isFiniteNumber(point.ts) &&
    isFiniteNumber(point.fiatBalance) &&
    isFiniteNumber(point.remainingUnrealizedPnlFiat) &&
    isFiniteNumber(point.pnlChange) &&
    isFiniteNumber(point.pnlPercent)
  );
}

export function buildWalletPointFromMark(
  args: BuildWalletPointFromMarkArgs,
): BuildWalletPointFromMarkResult {
  'worklet';

  if (!isFiniteNumber(args.ts)) {
    return {kind: 'invalidHistory', reason: 'nonFiniteTimestamp'};
  }
  if (!isFiniteNumber(args.units)) {
    return {kind: 'invalidHistory', reason: 'nonFiniteUnits'};
  }
  if (args.units < 0) {
    return {kind: 'invalidHistory', reason: 'negativeUnits'};
  }
  if (!isFiniteNumber(args.markRate)) {
    return {kind: 'invalidHistory', reason: 'nonFiniteRate'};
  }
  if (args.markRate <= 0) {
    return {kind: 'invalidHistory', reason: 'nonPositiveRate'};
  }
  if (!isFiniteNumber(args.remainingCostBasisFiat)) {
    return {kind: 'invalidHistory', reason: 'nonFiniteRemainingCostBasis'};
  }
  if (args.remainingCostBasisFiat < 0) {
    return {kind: 'invalidHistory', reason: 'negativeRemainingCostBasis'};
  }

  const fiatBalance = args.units * args.markRate;
  if (!isFiniteNumber(fiatBalance)) {
    return {kind: 'invalidHistory', reason: 'nonFiniteFiatBalance'};
  }

  const remainingUnrealizedPnlFiat =
    fiatBalance - args.remainingCostBasisFiat;
  if (!isFiniteNumber(remainingUnrealizedPnlFiat)) {
    return {kind: 'invalidHistory', reason: 'nonFiniteUnrealizedPnl'};
  }

  const firstRemainingUnrealizedPnlFiat =
    typeof args.firstRemainingUnrealizedPnlFiat === 'number'
      ? args.firstRemainingUnrealizedPnlFiat
      : remainingUnrealizedPnlFiat;
  if (!isFiniteNumber(firstRemainingUnrealizedPnlFiat)) {
    return {kind: 'invalidHistory', reason: 'nonFiniteUnrealizedPnl'};
  }

  return {
    kind: 'valid',
    point: {
      ts: args.ts,
      fiatBalance,
      remainingUnrealizedPnlFiat,
      pnlChange: remainingUnrealizedPnlFiat - firstRemainingUnrealizedPnlFiat,
      pnlPercent:
        args.remainingCostBasisFiat > 0
          ? (remainingUnrealizedPnlFiat / args.remainingCostBasisFiat) * 100
          : 0,
    },
  };
}

export function buildRowFingerprint(args: {
  assetGroupId: string;
  interval: string;
  fiatStart: number;
  fiatEnd: number;
  pnlChange: number;
  pnlPercent: number;
  rateStart: number;
  rateEnd: number;
  ratePercent: number;
}): string {
  'worklet';

  return stableHash([
    args.assetGroupId,
    args.interval,
    args.fiatStart,
    args.fiatEnd,
    args.pnlChange,
    args.pnlPercent,
    args.rateStart,
    args.rateEnd,
    args.ratePercent,
  ]);
}

export function buildRowPayloadFromSeries(
  args: BuildRowPayloadFromSeriesArgs,
): BuildRowPayloadFromSeriesResult {
  'worklet';

  if (!args.assetGroupId.trim()) {
    return {kind: 'invalidHistory', reason: 'missingAssetGroupId'};
  }

  const points = args.series.points;
  if (!points.length) {
    return {kind: 'invalidHistory', reason: 'emptySeries'};
  }

  let previousTs = -Infinity;
  for (const point of points) {
    if (!isValidPointEndpoint(point)) {
      return {kind: 'invalidHistory', reason: 'invalidSeriesEndpoint'};
    }
    if (point.ts <= previousTs) {
      return {kind: 'invalidHistory', reason: 'malformedSeriesTimeline'};
    }
    previousTs = point.ts;
  }

  if (!isFiniteNumber(args.rateStart) || !isFiniteNumber(args.rateEnd)) {
    return {kind: 'invalidHistory', reason: 'nonFiniteRate'};
  }
  if (args.rateStart <= 0 || args.rateEnd <= 0) {
    return {kind: 'invalidHistory', reason: 'nonPositiveRate'};
  }

  const first = points[0];
  const last = points[points.length - 1];
  const ratePercent = ((args.rateEnd - args.rateStart) / args.rateStart) * 100;

  const row: RowPayload = {
    assetGroupId: args.assetGroupId,
    rowFingerprint: buildRowFingerprint({
      assetGroupId: args.assetGroupId,
      interval: args.series.interval,
      fiatStart: first.fiatBalance,
      fiatEnd: last.fiatBalance,
      pnlChange: last.pnlChange,
      pnlPercent: last.pnlPercent,
      rateStart: args.rateStart,
      rateEnd: args.rateEnd,
      ratePercent,
    }),
    fiatStart: first.fiatBalance,
    fiatEnd: last.fiatBalance,
    pnlChange: last.pnlChange,
    pnlPercent: last.pnlPercent,
    rateStart: args.rateStart,
    rateEnd: args.rateEnd,
    ratePercent,
  };

  return {kind: 'valid', row};
}
