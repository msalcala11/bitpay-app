import type {
  Interval,
  MarketRatePoint,
  StoredRateInterval,
  WeightedGroupRatePoint,
  WeightedGroupRateSeries,
} from '../model';

export type WeightedGroupRateConstituentInput = Readonly<{
  rateSourceKey: string;
  baselineUnits: number;
  points: readonly MarketRatePoint[];
}>;

export type BuildWeightedGroupRateSeriesArgs = Readonly<{
  quoteCurrency: string;
  assetGroupId: string;
  walletIdsKey: string;
  interval: Interval;
  windowStartTs: number;
  windowEndTs: number;
  sampledFromStoredInterval: StoredRateInterval;
  constituents: readonly WeightedGroupRateConstituentInput[];
}>;

type WeightedGroupRateAvailability =
  | Readonly<{
      availability: 'valid';
      points: readonly WeightedGroupRatePoint[];
    }>
  | Readonly<{
      availability: 'unavailable';
      unavailableReason: 'zeroBaseline' | 'missingConstituentRate';
      points: readonly [];
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

function isStrictIdentity(value: string): boolean {
  'worklet';

  return !!value.trim() && value === value.trim();
}

function isFinitePositive(value: number): boolean {
  'worklet';

  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isFiniteNonNegative(value: number): boolean {
  'worklet';

  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validateRatePoints(points: readonly MarketRatePoint[]): boolean {
  'worklet';

  let previousTs = -Infinity;
  for (const point of points) {
    if (
      typeof point.ts !== 'number' ||
      !Number.isFinite(point.ts) ||
      !isFinitePositive(point.rate) ||
      point.ts <= previousTs
    ) {
      return false;
    }
    previousTs = point.ts;
  }

  return true;
}

function buildBaselineUnitsByRateSourceKey(
  constituents: readonly WeightedGroupRateConstituentInput[],
): Readonly<Record<string, number>> | null {
  'worklet';

  const sorted = constituents
    .slice()
    .sort((a, b) => a.rateSourceKey.localeCompare(b.rateSourceKey));
  const out: Record<string, number> = {};

  for (const constituent of sorted) {
    if (
      !isStrictIdentity(constituent.rateSourceKey) ||
      !isFiniteNonNegative(constituent.baselineUnits) ||
      Object.prototype.hasOwnProperty.call(out, constituent.rateSourceKey)
    ) {
      return null;
    }
    out[constituent.rateSourceKey] = constituent.baselineUnits;
  }

  return out;
}

function buildWeightedGroupRateFingerprint(args: {
  quoteCurrency: string;
  assetGroupId: string;
  walletIdsKey: string;
  interval: Interval;
  windowStartTs: number;
  windowEndTs: number;
  baselineUnitsByRateSourceKey: Readonly<Record<string, number>>;
  availability: WeightedGroupRateSeries['availability'];
  unavailableReason?: 'zeroBaseline' | 'missingConstituentRate';
  points: readonly WeightedGroupRatePoint[];
}): string {
  'worklet';

  const sortedRateSourceKeys = Object.keys(
    args.baselineUnitsByRateSourceKey,
  ).sort((a, b) => a.localeCompare(b));

  return stableHash([
    args.quoteCurrency,
    args.assetGroupId,
    args.walletIdsKey,
    args.interval,
    args.windowStartTs,
    args.windowEndTs,
    args.availability,
    args.unavailableReason ?? '',
    ...sortedRateSourceKeys.flatMap(key => [
      key,
      stableNumber(args.baselineUnitsByRateSourceKey[key] ?? 0),
    ]),
    ...args.points.flatMap(point => [
      point.ts,
      stableNumber(point.weightedRate),
      stableNumber(point.weightedPercent),
    ]),
  ]);
}

function buildWeightedAvailability(args: {
  windowStartTs: number;
  windowEndTs: number;
  constituents: readonly WeightedGroupRateConstituentInput[];
  baselineUnitsByRateSourceKey: Readonly<Record<string, number>>;
}): WeightedGroupRateAvailability {
  'worklet';

  const baselineUnits = Object.values(args.baselineUnitsByRateSourceKey).reduce(
    (sum, units) => sum + units,
    0,
  );

  if (baselineUnits <= 0) {
    return {
      availability: 'unavailable',
      unavailableReason: 'zeroBaseline',
      points: [],
    };
  }

  const nonzeroConstituents = args.constituents.filter(
    constituent => constituent.baselineUnits > 0,
  );
  const sampleGrid = nonzeroConstituents[0]?.points.map(point => point.ts) ?? [];
  if (
    sampleGrid.length === 0 ||
    sampleGrid[0] !== args.windowStartTs ||
    sampleGrid[sampleGrid.length - 1] !== args.windowEndTs
  ) {
    return {
      availability: 'unavailable',
      unavailableReason: 'missingConstituentRate',
      points: [],
    };
  }

  for (const constituent of nonzeroConstituents) {
    if (
      !validateRatePoints(constituent.points) ||
      constituent.points.length !== sampleGrid.length
    ) {
      return {
        availability: 'unavailable',
        unavailableReason: 'missingConstituentRate',
        points: [],
      };
    }

    for (let i = 0; i < sampleGrid.length; i++) {
      if (constituent.points[i]?.ts !== sampleGrid[i]) {
        return {
          availability: 'unavailable',
          unavailableReason: 'missingConstituentRate',
          points: [],
        };
      }
    }
  }

  const groupIndex0 = nonzeroConstituents.reduce(
    (sum, constituent) =>
      sum + constituent.baselineUnits * constituent.points[0].rate,
    0,
  );
  if (!isFinitePositive(groupIndex0)) {
    return {
      availability: 'unavailable',
      unavailableReason: 'zeroBaseline',
      points: [],
    };
  }

  const points: WeightedGroupRatePoint[] = [];
  for (let i = 0; i < sampleGrid.length; i++) {
    const groupIndex = nonzeroConstituents.reduce(
      (sum, constituent) =>
        sum + constituent.baselineUnits * constituent.points[i].rate,
      0,
    );
    const weightedRate = groupIndex / baselineUnits;
    const weightedPercent = ((groupIndex - groupIndex0) / groupIndex0) * 100;

    if (!isFinitePositive(weightedRate) || !Number.isFinite(weightedPercent)) {
      return {
        availability: 'unavailable',
        unavailableReason: 'missingConstituentRate',
        points: [],
      };
    }

    points.push({
      ts: sampleGrid[i],
      weightedRate,
      weightedPercent,
    });
  }

  return {availability: 'valid', points};
}

export function buildWeightedGroupRateSeries(
  args: BuildWeightedGroupRateSeriesArgs,
): WeightedGroupRateSeries {
  'worklet';

  const validatedBaselineUnitsByRateSourceKey =
    buildBaselineUnitsByRateSourceKey(args.constituents);
  const baselineUnitsByRateSourceKey =
    validatedBaselineUnitsByRateSourceKey ?? {};
  const memberRateSourceKeys = Object.keys(baselineUnitsByRateSourceKey).sort(
    (a, b) => a.localeCompare(b),
  );
  const availability = validatedBaselineUnitsByRateSourceKey
    ? buildWeightedAvailability({
        windowStartTs: args.windowStartTs,
        windowEndTs: args.windowEndTs,
        constituents: args.constituents,
        baselineUnitsByRateSourceKey,
      })
    : ({
        availability: 'unavailable',
        unavailableReason: 'missingConstituentRate',
        points: [],
      } as const);
  const fingerprint = buildWeightedGroupRateFingerprint({
    quoteCurrency: args.quoteCurrency,
    assetGroupId: args.assetGroupId,
    walletIdsKey: args.walletIdsKey,
    interval: args.interval,
    windowStartTs: args.windowStartTs,
    windowEndTs: args.windowEndTs,
    baselineUnitsByRateSourceKey,
    availability: availability.availability,
    unavailableReason:
      availability.availability === 'unavailable'
        ? availability.unavailableReason
        : undefined,
    points: availability.points,
  });
  const base = {
    fingerprint,
    interval: args.interval,
    windowStartTs: args.windowStartTs,
    windowEndTs: args.windowEndTs,
    sampledFromStoredInterval: args.sampledFromStoredInterval,
    memberRateSourceKeys,
    baselineUnitsByRateSourceKey,
    weighting: 'baselineUnitWeightedCollapsedGroup' as const,
  };

  return availability.availability === 'valid'
    ? {
        ...base,
        availability: 'valid',
        points: availability.points,
      }
    : {
        ...base,
        availability: 'unavailable',
        unavailableReason: availability.unavailableReason,
        points: [],
      };
}
