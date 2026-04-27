import {
  resolveStoredFiatRateInterval,
  type FiatRateInterval,
} from '../core/fiatRatesShared';
import type {Interval, StoredRateInterval} from './model';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_WEEK_MS = 7 * ONE_DAY_MS;
const ONE_MONTH_MS = 30 * ONE_DAY_MS;
const THREE_MONTHS_MS = 90 * ONE_DAY_MS;
const ONE_YEAR_MS = 365 * ONE_DAY_MS;
const FIVE_YEARS_MS = 5 * ONE_YEAR_MS;

export type PortfolioIntervalWindow = Readonly<{
  interval: Interval;
  windowStartTs: number;
  windowEndTs: number;
  windowAnchorTs: number;
  sampledFromStoredInterval: StoredRateInterval;
}>;

function isExternalWindowTimestamp(value: unknown): value is number {
  'worklet';

  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value)
  );
}

function durationForInterval(interval: Interval): number | undefined {
  'worklet';

  switch (interval) {
    case '1D':
      return ONE_DAY_MS;
    case '1W':
      return ONE_WEEK_MS;
    case '1M':
      return ONE_MONTH_MS;
    case '3M':
      return THREE_MONTHS_MS;
    case '1Y':
      return ONE_YEAR_MS;
    case '5Y':
      return FIVE_YEARS_MS;
    case 'ALL':
      return undefined;
  }
}

export function resolveStoredRateInterval(
  interval: Interval,
): StoredRateInterval {
  'worklet';

  return resolveStoredFiatRateInterval(interval as FiatRateInterval);
}

export function resolveStoredRateIntervalForChartWindow(args: {
  interval: Interval;
  windowStartTs: number;
  windowEndTs: number;
}): StoredRateInterval | undefined {
  'worklet';

  if (
    !isExternalWindowTimestamp(args.windowStartTs) ||
    !isExternalWindowTimestamp(args.windowEndTs) ||
    args.windowEndTs <= args.windowStartTs
  ) {
    return undefined;
  }

  if (args.interval !== 'ALL') {
    return resolveStoredRateInterval(args.interval);
  }

  const durationMs = args.windowEndTs - args.windowStartTs;
  if (durationMs <= ONE_DAY_MS) {
    return '1D';
  }
  if (durationMs <= ONE_WEEK_MS) {
    return '1W';
  }
  if (durationMs <= ONE_MONTH_MS) {
    return '1M';
  }
  return 'ALL';
}

export function resolvePortfolioIntervalWindow(args: {
  interval: Interval;
  windowAnchorTs: number;
  firstPortfolioEventTs?: number;
}): PortfolioIntervalWindow | undefined {
  'worklet';

  if (!isExternalWindowTimestamp(args.windowAnchorTs)) {
    return undefined;
  }

  const windowEndTs = args.windowAnchorTs;
  const durationMs = durationForInterval(args.interval);
  const windowStartTs =
    typeof durationMs === 'number'
      ? windowEndTs - durationMs
      : args.firstPortfolioEventTs;

  if (
    !isExternalWindowTimestamp(windowStartTs) ||
    windowEndTs <= windowStartTs
  ) {
    return undefined;
  }

  const sampledFromStoredInterval = resolveStoredRateIntervalForChartWindow({
    interval: args.interval,
    windowStartTs,
    windowEndTs,
  });
  if (!sampledFromStoredInterval) {
    return undefined;
  }

  return {
    interval: args.interval,
    windowStartTs,
    windowEndTs,
    windowAnchorTs: args.windowAnchorTs,
    sampledFromStoredInterval,
  };
}
