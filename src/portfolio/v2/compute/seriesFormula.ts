import type {FiatRatePoint} from '../../core/fiatRatesShared';
import {isStoredFiatRateInterval} from '../../core/fiatRatesShared';
import {createPreparedRateReader} from '../../core/pnl/rateReader';
import {MAX_CHART_POINTS} from '../constants';
import type {Interval, Point, Series, StoredRateInterval} from '../model';
import {buildWalletPointFromMark} from './rowPayload';
import {
  atomicToDisplayUnitAmount,
  isValidDisplayUnitDecimals,
  type AtomicDisplayUnitAmountInvalidReason,
} from './amountBoundary';

export type BalanceChangeEvent = Readonly<{
  ts: number;
  unitsDelta: number;
  unitsDeltaAtomic?: string;
  order: number;
}>;

export type BuildCappedSampleGridArgs = Readonly<{
  windowStartTs: number;
  windowEndTs: number;
  /**
   * Deprecated Phase 0-2 fixture escape hatch. Production balance series now
   * emit the pinned MAX_CHART_POINTS grid for every valid non-empty window.
   */
  maxPoints?: number;
}>;

export type WalletSeriesFormulaInvalidReason =
  | 'invalidWindow'
  | 'invalidInterval'
  | 'invalidStoredInterval'
  | 'invalidFinalPointSource'
  | 'invalidSampleGrid'
  | 'missingSeriesIdentityKey'
  | 'invalidDisplayUnitDecimals'
  | 'nonFiniteBaselineUnits'
  | 'negativeBaselineUnits'
  | 'unsafeBaselineUnits'
  | 'invalidBaselineUnitsAtomic'
  | 'malformedBalanceEvent'
  | 'invalidBalanceEventAtomic'
  | 'unsafeBalanceEventUnits'
  | 'negativeUnits'
  | 'invalidWalletPoint';

export type BuildWalletSeriesFromEventsArgs = Readonly<{
  interval: Interval;
  /**
   * Caller-owned series identity for the exact input set: quote/scope,
   * wallet/asset/rate identifiers, snapshot revisions, rate fetchedOn/as-of
   * values, bridge metadata, and any other upstream dependency that must
   * invalidate a published Series even if emitted point values are equal.
   */
  seriesIdentityKey: string;
  windowStartTs: number;
  windowEndTs: number;
  windowAnchorTs: number;
  sampledFromStoredInterval: StoredRateInterval;
  finalPointSource: Series['finalPointSource'];
  displayUnitDecimals?: number;
  /**
   * Post-state after every event with `ts <= windowStartTs`. Runtime callers
   * must pass only strictly in-window balance changes
   * (`windowStartTs < ts <= windowEndTs`) here, sorted or sortable by `order`.
   * This avoids double-counting exact-start transactions.
   */
  baselineUnits: number;
  baselineUnitsAtomic?: string;
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

function isSafeDisplayUnitsNumber(value: number): boolean {
  'worklet';

  return Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}

function hasValidWindow(windowStartTs: number, windowEndTs: number): boolean {
  'worklet';

  return (
    isFiniteNumber(windowStartTs) &&
    isFiniteNumber(windowEndTs) &&
    Number.isInteger(windowStartTs) &&
    Number.isInteger(windowEndTs) &&
    windowEndTs > windowStartTs
  );
}

function isInterval(value: unknown): value is Interval {
  'worklet';

  return (
    value === '1D' ||
    value === '1W' ||
    value === '1M' ||
    value === '3M' ||
    value === '1Y' ||
    value === '5Y' ||
    value === 'ALL'
  );
}

function isFinalPointSource(
  value: unknown,
): value is Series['finalPointSource'] {
  'worklet';

  return value === 'historicalRate' || value === 'liveRate';
}

function isStrictIdentity(value: unknown): value is string {
  'worklet';

  return typeof value === 'string' && !!value.trim() && value === value.trim();
}

export function buildCappedSampleGrid(
  args: BuildCappedSampleGridArgs,
): readonly number[] {
  'worklet';

  if (!hasValidWindow(args.windowStartTs, args.windowEndTs)) {
    return [];
  }

  const pointCount = MAX_CHART_POINTS;
  const start = args.windowStartTs;
  const end = args.windowEndTs;
  const span = end - start;
  const out = new Array<number>(pointCount);

  for (let i = 0; i < pointCount; i++) {
    out[i] = start + (span * i) / (pointCount - 1);
  }

  out[0] = start;
  out[pointCount - 1] = end;

  return out;
}

function mapBaselineAmountError(
  reason: AtomicDisplayUnitAmountInvalidReason,
): WalletSeriesFormulaInvalidReason {
  'worklet';

  switch (reason) {
    case 'invalidDisplayUnitDecimals':
      return 'invalidDisplayUnitDecimals';
    case 'negativeDisplayUnitsAtomic':
      return 'negativeBaselineUnits';
    case 'invalidDisplayUnitsAtomic':
      return 'invalidBaselineUnitsAtomic';
    case 'nonFiniteDisplayUnits':
    case 'unsafeDisplayUnits':
    default:
      return 'unsafeBaselineUnits';
  }
}

function mapBalanceEventAmountError(
  reason: AtomicDisplayUnitAmountInvalidReason,
): WalletSeriesFormulaInvalidReason {
  'worklet';

  switch (reason) {
    case 'invalidDisplayUnitDecimals':
      return 'invalidDisplayUnitDecimals';
    case 'invalidDisplayUnitsAtomic':
    case 'negativeDisplayUnitsAtomic':
      return 'invalidBalanceEventAtomic';
    case 'nonFiniteDisplayUnits':
    case 'unsafeDisplayUnits':
    default:
      return 'unsafeBalanceEventUnits';
  }
}

function resolveBaselineUnits(args: {
  baselineUnits: number;
  baselineUnitsAtomic?: string;
  displayUnitDecimals?: number;
}):
  | Readonly<{kind: 'valid'; units: number}>
  | Readonly<{kind: 'invalid'; reason: WalletSeriesFormulaInvalidReason}> {
  'worklet';

  if (typeof args.baselineUnitsAtomic === 'string') {
    if (!isValidDisplayUnitDecimals(args.displayUnitDecimals)) {
      return {kind: 'invalid', reason: 'invalidDisplayUnitDecimals'};
    }
    const amount = atomicToDisplayUnitAmount({
      atomic: args.baselineUnitsAtomic,
      decimals: args.displayUnitDecimals,
    });
    return 'kind' in amount
      ? {kind: 'invalid', reason: mapBaselineAmountError(amount.reason)}
      : {kind: 'valid', units: amount.approximateNumber};
  }

  if (!isFiniteNumber(args.baselineUnits)) {
    return {kind: 'invalid', reason: 'nonFiniteBaselineUnits'};
  }

  if (args.baselineUnits < 0) {
    return {kind: 'invalid', reason: 'negativeBaselineUnits'};
  }

  if (!isSafeDisplayUnitsNumber(args.baselineUnits)) {
    return {kind: 'invalid', reason: 'unsafeBaselineUnits'};
  }

  return {kind: 'valid', units: args.baselineUnits};
}

function resolveBalanceEventUnitsDelta(args: {
  event: BalanceChangeEvent;
  displayUnitDecimals?: number;
}):
  | Readonly<{kind: 'valid'; unitsDelta: number}>
  | Readonly<{kind: 'invalid'; reason: WalletSeriesFormulaInvalidReason}> {
  'worklet';

  if (typeof args.event.unitsDeltaAtomic === 'string') {
    if (!isValidDisplayUnitDecimals(args.displayUnitDecimals)) {
      return {kind: 'invalid', reason: 'invalidDisplayUnitDecimals'};
    }
    const amount = atomicToDisplayUnitAmount({
      atomic: args.event.unitsDeltaAtomic,
      decimals: args.displayUnitDecimals,
      allowNegative: true,
    });
    return 'kind' in amount
      ? {kind: 'invalid', reason: mapBalanceEventAmountError(amount.reason)}
      : {kind: 'valid', unitsDelta: amount.approximateNumber};
  }

  if (!isFiniteNumber(args.event.unitsDelta)) {
    return {kind: 'invalid', reason: 'malformedBalanceEvent'};
  }

  if (!isSafeDisplayUnitsNumber(args.event.unitsDelta)) {
    return {kind: 'invalid', reason: 'unsafeBalanceEventUnits'};
  }

  return {kind: 'valid', unitsDelta: args.event.unitsDelta};
}

function normalizeBalanceEvents(
  eventsRaw: readonly BalanceChangeEvent[] | undefined,
  windowStartTs: number,
  windowEndTs: number,
  displayUnitDecimals?: number,
):
  | Readonly<{kind: 'valid'; events: readonly BalanceChangeEvent[]}>
  | Readonly<{kind: 'invalid'; reason: WalletSeriesFormulaInvalidReason}> {
  'worklet';

  const events = eventsRaw ?? [];
  const out: BalanceChangeEvent[] = [];
  const seenEventOrderKeys = new Set<string>();

  for (const event of events) {
    if (
      !event ||
      !isFiniteNumber(event.ts) ||
      !Number.isInteger(event.order) ||
      event.order < 0 ||
      event.ts <= windowStartTs ||
      event.ts > windowEndTs
    ) {
      return {kind: 'invalid', reason: 'malformedBalanceEvent'};
    }

    const orderKey = `${event.ts}:${event.order}`;
    if (seenEventOrderKeys.has(orderKey)) {
      return {kind: 'invalid', reason: 'malformedBalanceEvent'};
    }
    seenEventOrderKeys.add(orderKey);

    const unitsDelta = resolveBalanceEventUnitsDelta({
      event,
      displayUnitDecimals,
    });
    if (unitsDelta.kind !== 'valid') {
      return unitsDelta;
    }

    if (unitsDelta.unitsDelta !== 0) {
      out.push({
        ts: event.ts,
        unitsDelta: unitsDelta.unitsDelta,
        ...(typeof event.unitsDeltaAtomic === 'string'
          ? {unitsDeltaAtomic: event.unitsDeltaAtomic}
          : {}),
        order: event.order,
      });
    }
  }

  return {
    kind: 'valid',
    events: out.sort((left, right) => {
      const tsDelta = left.ts - right.ts;
      return tsDelta !== 0 ? tsDelta : left.order - right.order;
    }),
  };
}

function buildSeriesFingerprint(args: {
  interval: Interval;
  seriesIdentityKey: string;
  windowStartTs: number;
  windowEndTs: number;
  windowAnchorTs: number;
  sampledFromStoredInterval: StoredRateInterval;
  finalPointSource: Series['finalPointSource'];
  points: readonly Point[];
}): string {
  'worklet';

  return stableHash([
    args.seriesIdentityKey,
    args.interval,
    args.windowStartTs,
    args.windowEndTs,
    args.windowAnchorTs,
    args.sampledFromStoredInterval,
    args.finalPointSource,
    args.points.length,
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

  if (!isInterval(args.interval)) {
    return {kind: 'invalidHistory', reason: 'invalidInterval'};
  }

  if (!isStrictIdentity(args.seriesIdentityKey)) {
    return {kind: 'invalidHistory', reason: 'missingSeriesIdentityKey'};
  }

  if (!hasValidWindow(args.windowStartTs, args.windowEndTs)) {
    return {kind: 'invalidHistory', reason: 'invalidWindow'};
  }

  if (
    !isFiniteNumber(args.windowAnchorTs) ||
    !Number.isInteger(args.windowAnchorTs)
  ) {
    return {kind: 'invalidHistory', reason: 'invalidWindow'};
  }

  if (!isStoredFiatRateInterval(args.sampledFromStoredInterval)) {
    return {kind: 'invalidHistory', reason: 'invalidStoredInterval'};
  }

  if (!isFinalPointSource(args.finalPointSource)) {
    return {kind: 'invalidHistory', reason: 'invalidFinalPointSource'};
  }

  const baselineUnits = resolveBaselineUnits({
    baselineUnits: args.baselineUnits,
    baselineUnitsAtomic: args.baselineUnitsAtomic,
    displayUnitDecimals: args.displayUnitDecimals,
  });
  if (baselineUnits.kind !== 'valid') {
    return {kind: 'invalidHistory', reason: baselineUnits.reason};
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
    args.displayUnitDecimals,
  );
  if (balanceEvents.kind !== 'valid') {
    return {kind: 'invalidHistory', reason: balanceEvents.reason};
  }

  const rateReader = createPreparedRateReader({
    series: args.ratePoints,
    policy: 'linearRender',
  });
  const baselineRate = rateReader.read(args.windowStartTs);
  if (baselineRate.kind !== 'rate') {
    return {kind: 'missingRate', reason: 'missingHistoricalRate'};
  }

  let units = baselineUnits.units;
  let remainingCostBasisFiat = units * baselineRate.rate;
  let eventIndex = 0;
  let firstRemainingUnrealizedPnlFiat: number | undefined;
  const points: Point[] = [];

  for (const sampleTs of sampleGrid) {
    while (
      eventIndex < balanceEvents.events.length &&
      balanceEvents.events[eventIndex].ts <= sampleTs
    ) {
      const event = balanceEvents.events[eventIndex];
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
      firstRemainingUnrealizedPnlFiat = point.point.remainingUnrealizedPnlFiat;
    }
    points.push(point.point);
  }

  return {
    kind: 'valid',
    series: {
      fingerprint: buildSeriesFingerprint({
        interval: args.interval,
        seriesIdentityKey: args.seriesIdentityKey,
        windowStartTs: args.windowStartTs,
        windowEndTs: args.windowEndTs,
        windowAnchorTs: args.windowAnchorTs,
        sampledFromStoredInterval: args.sampledFromStoredInterval,
        finalPointSource: args.finalPointSource,
        points,
      }),
      interval: args.interval,
      windowStartTs: args.windowStartTs,
      windowEndTs: args.windowEndTs,
      windowAnchorTs: args.windowAnchorTs,
      sampledFromStoredInterval: args.sampledFromStoredInterval,
      finalPointSource: args.finalPointSource,
      points,
    },
  };
}
