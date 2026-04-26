import type {Interval, Series} from '../model';

export function stableNumber(value: number): string {
  'worklet';

  if (!Number.isFinite(value)) {
    return 'nonfinite';
  }

  if (Object.is(value, -0)) {
    return '0';
  }

  return String(value);
}

export function stableHash(
  values: readonly (boolean | number | string)[],
): string {
  'worklet';

  const input = values
    .map(value =>
      typeof value === 'number' ? stableNumber(value) : String(value),
    )
    .join('|');
  let hash = 0x811c9dc5;

  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }

  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function aggregateAlignedSeries(args: {
  identityKey: string;
  interval: Interval;
  memberSeries: readonly Series[];
}): Series | null {
  'worklet';

  if (!args.memberSeries.length) {
    return null;
  }

  const firstSeries = args.memberSeries[0];
  if (firstSeries.interval !== args.interval) {
    return null;
  }

  const pointCount = firstSeries.points.length;
  const points = firstSeries.points.map((point, pointIndex) => {
    let fiatBalance = 0;
    let remainingUnrealizedPnlFiat = 0;
    let pnlChange = 0;

    for (const series of args.memberSeries) {
      const memberPoint = series.points[pointIndex];
      if (
        !memberPoint ||
        series.interval !== firstSeries.interval ||
        series.windowStartTs !== firstSeries.windowStartTs ||
        series.windowEndTs !== firstSeries.windowEndTs ||
        series.sampledFromStoredInterval !==
          firstSeries.sampledFromStoredInterval ||
        series.finalPointSource !== firstSeries.finalPointSource ||
        series.points.length !== pointCount ||
        memberPoint.ts !== point.ts
      ) {
        return null;
      }

      fiatBalance += memberPoint.fiatBalance;
      remainingUnrealizedPnlFiat += memberPoint.remainingUnrealizedPnlFiat;
      pnlChange += memberPoint.pnlChange;
    }

    const remainingCostBasisFiat = fiatBalance - remainingUnrealizedPnlFiat;
    return {
      ts: point.ts,
      fiatBalance,
      remainingUnrealizedPnlFiat,
      pnlChange,
      pnlPercent:
        remainingCostBasisFiat > 0
          ? (remainingUnrealizedPnlFiat / remainingCostBasisFiat) * 100
          : 0,
    };
  });

  if (points.some(point => point === null)) {
    return null;
  }

  const validPoints = points as Series['points'];
  return {
    fingerprint: stableHash([
      args.identityKey,
      args.interval,
      firstSeries.windowStartTs,
      firstSeries.windowEndTs,
      firstSeries.sampledFromStoredInterval,
      firstSeries.finalPointSource,
      ...args.memberSeries.map(series => series.fingerprint).sort(),
      ...validPoints.flatMap(point => [
        point.ts,
        point.fiatBalance,
        point.remainingUnrealizedPnlFiat,
        point.pnlChange,
        point.pnlPercent,
      ]),
    ]),
    interval: args.interval,
    windowStartTs: firstSeries.windowStartTs,
    windowEndTs: firstSeries.windowEndTs,
    sampledFromStoredInterval: firstSeries.sampledFromStoredInterval,
    finalPointSource: firstSeries.finalPointSource,
    points: validPoints,
  };
}
