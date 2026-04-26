import type {FiatRatePoint, FiatRateSeries} from '../fiatRatesShared';

export type RateSamplingPolicy = 'linearRender' | 'nearestSnapshotIngest';

export type RateLookupResult =
  | Readonly<{
      kind: 'rate';
      rate: number;
      ts: number;
      source: 'exact' | 'interpolated' | 'nearest';
    }>
  | Readonly<{
      kind: 'missing';
      reason: 'invalidTimestamp' | 'noSeries' | 'outOfRange' | 'nonFiniteRate';
    }>;

export type RateReader = Readonly<{
  readRateAt(args: {
    series: FiatRateSeries | readonly FiatRatePoint[] | null | undefined;
    ts: number;
    policy: RateSamplingPolicy;
  }): RateLookupResult;
}>;

export function normalizeRatePoints(
  pointsRaw: readonly FiatRatePoint[] | undefined,
): FiatRatePoint[] {
  'worklet';

  if (!Array.isArray(pointsRaw) || !pointsRaw.length) return [];
  return pointsRaw
    .map(point => ({ts: Number(point.ts), rate: Number(point.rate)}))
    .filter(point => Number.isFinite(point.ts) && Number.isFinite(point.rate))
    .sort((left, right) => left.ts - right.ts);
}

function pointsFromSeries(
  series: FiatRateSeries | readonly FiatRatePoint[] | null | undefined,
): FiatRatePoint[] {
  'worklet';

  if (Array.isArray(series)) {
    return normalizeRatePoints(series as readonly FiatRatePoint[]);
  }
  return normalizeRatePoints((series as FiatRateSeries | null | undefined)?.points);
}

function findInsertionIndex(points: readonly FiatRatePoint[], ts: number): number {
  'worklet';

  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (points[mid].ts < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function readLinearRate(
  points: readonly FiatRatePoint[],
  ts: number,
): RateLookupResult {
  'worklet';

  if (ts < points[0].ts || ts > points[points.length - 1].ts) {
    return {kind: 'missing', reason: 'outOfRange'};
  }

  const insertion = findInsertionIndex(points, ts);
  const exact = points[insertion];
  if (exact?.ts === ts) {
    return {kind: 'rate', rate: exact.rate, ts, source: 'exact'};
  }

  const left = points[insertion - 1];
  const right = points[insertion];
  if (!left || !right || right.ts === left.ts) {
    return {kind: 'missing', reason: 'outOfRange'};
  }

  const progress = (ts - left.ts) / (right.ts - left.ts);
  const rate = left.rate + (right.rate - left.rate) * progress;
  return Number.isFinite(rate)
    ? {kind: 'rate', rate, ts, source: 'interpolated'}
    : {kind: 'missing', reason: 'nonFiniteRate'};
}

function readNearestRate(
  points: readonly FiatRatePoint[],
  ts: number,
): RateLookupResult {
  'worklet';

  const insertion = findInsertionIndex(points, ts);
  const left = points[Math.max(0, insertion - 1)];
  const right = points[Math.min(points.length - 1, insertion)];
  const chosen =
    !left || (right && Math.abs(right.ts - ts) < Math.abs(left.ts - ts))
      ? right
      : left;

  return chosen && Number.isFinite(chosen.rate)
    ? {kind: 'rate', rate: chosen.rate, ts, source: 'nearest'}
    : {kind: 'missing', reason: 'nonFiniteRate'};
}

export function readRateAt(args: {
  series: FiatRateSeries | readonly FiatRatePoint[] | null | undefined;
  ts: number;
  policy: RateSamplingPolicy;
}): RateLookupResult {
  'worklet';

  const ts = Number(args.ts);
  if (!Number.isFinite(ts)) {
    return {kind: 'missing', reason: 'invalidTimestamp'};
  }

  const points = pointsFromSeries(args.series);
  if (!points.length) {
    return {kind: 'missing', reason: 'noSeries'};
  }

  return args.policy === 'nearestSnapshotIngest'
    ? readNearestRate(points, ts)
    : readLinearRate(points, ts);
}

export function createRateReader(): RateReader {
  'worklet';

  return {
    readRateAt,
  };
}
