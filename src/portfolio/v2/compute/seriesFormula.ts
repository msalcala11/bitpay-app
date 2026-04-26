import type {FiatRatePoint} from '../../core/fiatRatesShared';
import {isStoredFiatRateInterval} from '../../core/fiatRatesShared';
import {createPreparedRateReader} from '../../core/pnl/rateReader';
import {MAX_CHART_POINTS} from '../constants';
import type {Interval, Point, Series, StoredRateInterval} from '../model';
import {buildWalletPointFromMark} from './rowPayload';

export type BalanceChangeEvent = Readonly<{
  ts: number;
  unitsDelta: number;
}>;

export type BuildCappedSampleGridArgs = Readonly<{
  windowStartTs: number;
  windowEndTs: number;
  maxPoints?: number;
}>;

export type WalletSeriesFormulaInvalidReason =
  | 'invalidWindow'
  | 'invalidInterval'
  | 'invalidSampleGrid'
  | 'nonFiniteBaselineUnits'
  | 'negativeBaselineUnits'
  | 'malformedBalanceEvent'
  | 'negativeUnits'
  | 'invalidWalletPoint';

export type BuildWalletSeriesFromEventsArgs = Readonly<{
  interval: Interval;
  windowStartTs: number;
  windowEndTs: number;
  sampledFromStoredInterval: StoredRateInterval;
  finalPointSource: Series['finalPointSource'];
  baselineUnits: number;
  balanceEvents?: readonly BalanceChangeEvent[];
  ratePoints: readonly FiatRatePoint[];
  maxPoints?: number;
}>;

export type BuildWalletSeriesFromEventsResult =
  | Readonly<{kind: 'valid'; series: Series}>
  | Readonly<{
      kind: 'invalidHistory';
      reason: WalletSeriesFormulaInvalidReason;
    }>
  | Readonly<{
      kind: 'missingRate';
      reason: 'missingHistoricalRate';
    }>;

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

function isFiniteNumber(value: unknown): value is number {
  'worklet';

  return typeof value === 'number' && Number.isFinite(value);
}

function hasValidWindow(windowStartTs: number, windowEndTs: number): boolean {
  'worklet';

  return (
    isFiniteNumber(windowStartTs) &&
    isFiniteNumber(windowEndTs) &&
    windowEndTs > windowStartTs
  );
}

export function buildCappedSampleGrid(
  args: BuildCappedSampleGridArgs,
): readonly number[] {
  'worklet';

  if (!hasValidWindow(args.windowStartTs, args.windowEndTs)) {
    return [];
  }

  const maxPoints = Math.floor(args.maxPoints ?? MAX_CHART_POINTS);
  if (!Number.isFinite(maxPoints) || maxPoints < 2) {
    return [];
  }

  const pointCount = Math.max(2, Math.min(MAX_CHART_POINTS, maxPoints));
  const start = Math.round(args.windowStartTs);
  const end = Math.round(args.windowEndTs);
  const span = end - start;
  const out = new Array<number>(pointCount);

  for (let i = 0; i < pointCount; i++) {
    out[i] = Math.round(start + (span * i) / (pointCount - 1));
  }

  out[0] = start;
  out[pointCount - 1] = end;

  return out;
}

function normalizeBalanceEvents(
  eventsRaw: readonly BalanceChangeEvent[] | undefined,
  windowStartTs: number,
  windowEndTs: number,
): readonly BalanceChangeEvent[] | null {
  'worklet';

  const events = eventsRaw ?? [];
  const out: BalanceChangeEvent[] = [];

  for (const event of events) {
    if (
      !event ||
      !isFiniteNumber(event.ts) ||
      !isFiniteNumber(event.unitsDelta) ||
      event.ts <= windowStartTs ||
      event.ts > windowEndTs
    ) {
      return null;
    }

    if (event.unitsDelta !== 0) {
      out.push({ts: event.ts, unitsDelta: event.unitsDelta});
    }
  }

  return out.sort((left, right) => left.ts - right.ts);
}

function buildSeriesFingerprint(args: {
  interval: Interval;
  windowStartTs: number;
  windowEndTs: number;
  sampledFromStoredInterval: StoredRateInterval;
  finalPointSource: Series['finalPointSource'];
  points: readonly Point[];
}): string {
  'worklet';

  return stableHash([
    args.interval,
    args.windowStartTs,
    args.windowEndTs,
    args.sampledFromStoredInterval,
    args.finalPointSource,
    ...args.points.flatMap(point => [
      point.ts,
      point.fiatBalance,
      point.remainingUnrealizedPnlFiat,
      point.pnlChange,
      point.pnlPercent,
    ]),
  ]);
}

export function buildWalletSeriesFromEvents(
  args: BuildWalletSeriesFromEventsArgs,
): BuildWalletSeriesFromEventsResult {
  'worklet';

  if (!hasValidWindow(args.windowStartTs, args.windowEndTs)) {
    return {kind: 'invalidHistory', reason: 'invalidWindow'};
  }

  if (!isStoredFiatRateInterval(args.sampledFromStoredInterval)) {
    return {kind: 'invalidHistory', reason: 'invalidInterval'};
  }

  if (!isFiniteNumber(args.baselineUnits)) {
    return {kind: 'invalidHistory', reason: 'nonFiniteBaselineUnits'};
  }

  if (args.baselineUnits < 0) {
    return {kind: 'invalidHistory', reason: 'negativeBaselineUnits'};
  }

  const sampleGrid = buildCappedSampleGrid({
    windowStartTs: args.windowStartTs,
    windowEndTs: args.windowEndTs,
    maxPoints: args.maxPoints,
  });
  if (!sampleGrid.length) {
    return {kind: 'invalidHistory', reason: 'invalidSampleGrid'};
  }

  const balanceEvents = normalizeBalanceEvents(
    args.balanceEvents,
    args.windowStartTs,
    args.windowEndTs,
  );
  if (!balanceEvents) {
    return {kind: 'invalidHistory', reason: 'malformedBalanceEvent'};
  }

  const rateReader = createPreparedRateReader({
    series: args.ratePoints,
    policy: 'linearRender',
  });
  const baselineRate = rateReader.read(args.windowStartTs);
  if (baselineRate.kind !== 'rate') {
    return {kind: 'missingRate', reason: 'missingHistoricalRate'};
  }

  let units = args.baselineUnits;
  let remainingCostBasisFiat = units * baselineRate.rate;
  let eventIndex = 0;
  let firstRemainingUnrealizedPnlFiat: number | undefined;
  const points: Point[] = [];

  for (const sampleTs of sampleGrid) {
    while (
      eventIndex < balanceEvents.length &&
      balanceEvents[eventIndex].ts <= sampleTs
    ) {
      const event = balanceEvents[eventIndex];
      if (event.unitsDelta > 0) {
        const eventRate = rateReader.read(event.ts);
        if (eventRate.kind !== 'rate') {
          return {kind: 'missingRate', reason: 'missingHistoricalRate'};
        }
        remainingCostBasisFiat += event.unitsDelta * eventRate.rate;
      } else {
        const nextUnits = units + event.unitsDelta;
        if (nextUnits < 0) {
          return {kind: 'invalidHistory', reason: 'negativeUnits'};
        }
        remainingCostBasisFiat =
          units > 0 ? remainingCostBasisFiat * (nextUnits / units) : 0;
      }

      units += event.unitsDelta;
      if (units < 0) {
        return {kind: 'invalidHistory', reason: 'negativeUnits'};
      }
      if (units === 0) {
        remainingCostBasisFiat = 0;
      }
      eventIndex += 1;
    }

    const sampleRate = rateReader.read(sampleTs);
    if (sampleRate.kind !== 'rate') {
      return {kind: 'missingRate', reason: 'missingHistoricalRate'};
    }

    const point = buildWalletPointFromMark({
      ts: sampleTs,
      units,
      markRate: sampleRate.rate,
      remainingCostBasisFiat,
      firstRemainingUnrealizedPnlFiat,
    });
    if (point.kind !== 'valid') {
      return {kind: 'invalidHistory', reason: 'invalidWalletPoint'};
    }

    if (typeof firstRemainingUnrealizedPnlFiat !== 'number') {
      firstRemainingUnrealizedPnlFiat =
        point.point.remainingUnrealizedPnlFiat;
    }
    points.push(point.point);
  }

  return {
    kind: 'valid',
    series: {
      fingerprint: buildSeriesFingerprint({
        interval: args.interval,
        windowStartTs: args.windowStartTs,
        windowEndTs: args.windowEndTs,
        sampledFromStoredInterval: args.sampledFromStoredInterval,
        finalPointSource: args.finalPointSource,
        points,
      }),
      interval: args.interval,
      windowStartTs: args.windowStartTs,
      windowEndTs: args.windowEndTs,
      sampledFromStoredInterval: args.sampledFromStoredInterval,
      finalPointSource: args.finalPointSource,
      points,
    },
  };
}
