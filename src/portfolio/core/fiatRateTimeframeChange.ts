import type {
  FiatRateAssetRef,
  FiatRateInterval,
  FiatRatePoint,
  FiatRateSeriesCache,
} from './fiatRatesShared';
import {
  getFiatRateSeriesCacheKey,
  normalizeFiatRateSeriesChain,
  normalizeFiatRateSeriesTokenAddress,
  resolveStoredFiatRateInterval,
} from './fiatRatesShared';
import {normalizeFiatRateSeriesCoin} from './pnl/rates';

// Portable, worklet-safe fiat-rate timeframe helpers shared by the JS
// Exchange Rate UI and the portfolio runtime/worklets. Keep this module free of
// React, Redux, native UI, and host-storage dependencies.

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

export type FiatRateLookupMethod = 'nearest' | 'linear';

export type FiatRateSeriesReaderIdentity = Pick<
  FiatRateAssetRef,
  'chain' | 'tokenAddress'
>;

export type FiatRateTimeframeConfig = {
  windowMs?: number;
  baselineTimestampMs?: number;
  seriesInterval: FiatRateInterval;
};

export type FiatRateChangeForTimeframe = {
  timeframe: FiatRateInterval;
  baselineTimestampMs: number;
  baselineRate: number;
  currentRate: number;
  priceChange: number;
  percentChange: number;
  percentRatio: number;
};

type BoundingRatePoints = {
  left?: FiatRatePoint;
  right?: FiatRatePoint;
};

const uniqueStrings = (values: string[]): string[] => {
  'worklet';

  const out: string[] = [];
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (!normalized) continue;
    if (out.indexOf(normalized) === -1) out.push(normalized);
  }
  return out;
};

export const roundDownToHourMs = (tsMs: number): number => {
  'worklet';

  return Math.floor(tsMs / MS_PER_HOUR) * MS_PER_HOUR;
};

export const getLastDayTimestampStartOfHourMsForFiatRates = (
  nowMs: number = Date.now(),
): number => {
  'worklet';

  return roundDownToHourMs(nowMs - MS_PER_DAY);
};

export const getWindowMsForFiatRateTimeframe = (
  timeframe: FiatRateInterval,
): number | undefined => {
  'worklet';

  switch (timeframe) {
    case '1D':
      return 1 * MS_PER_DAY;
    case '1W':
      return 7 * MS_PER_DAY;
    case '1M':
      return 30 * MS_PER_DAY;
    case '3M':
      return 90 * MS_PER_DAY;
    case '1Y':
      return 365 * MS_PER_DAY;
    case '5Y':
      return 1825 * MS_PER_DAY;
    case 'ALL':
    default:
      return undefined;
  }
};

export const getFiatRateBaselineTsForTimeframe = (args: {
  timeframe: FiatRateInterval;
  nowMs?: number;
}): number | undefined => {
  'worklet';

  const nowMs = typeof args.nowMs === 'number' ? args.nowMs : Date.now();

  if (args.timeframe === 'ALL') {
    return undefined;
  }

  if (args.timeframe === '1D') {
    return getLastDayTimestampStartOfHourMsForFiatRates(nowMs);
  }

  const windowMs = getWindowMsForFiatRateTimeframe(args.timeframe);
  if (typeof windowMs !== 'number') {
    return undefined;
  }

  return roundDownToHourMs(nowMs - windowMs);
};

export const getFiatRateSeriesIntervalForTimeframe = (
  timeframe: FiatRateInterval,
): FiatRateInterval => {
  'worklet';

  return resolveStoredFiatRateInterval(timeframe);
};

export const getFiatRateTimeframeConfig = (args: {
  timeframe: FiatRateInterval;
  nowMs?: number;
}): FiatRateTimeframeConfig => {
  'worklet';

  const nowMs = typeof args.nowMs === 'number' ? args.nowMs : Date.now();
  const windowMs = getWindowMsForFiatRateTimeframe(args.timeframe);
  const baselineTimestampMs = getFiatRateBaselineTsForTimeframe({
    timeframe: args.timeframe,
    nowMs,
  });
  const seriesInterval = getFiatRateSeriesIntervalForTimeframe(args.timeframe);

  return {windowMs, baselineTimestampMs, seriesInterval};
};

const isValidRatePoint = (point: FiatRatePoint | undefined): point is FiatRatePoint => {
  'worklet';

  return !!point && Number.isFinite(point.ts) && Number.isFinite(point.rate);
};

const isSortedByTsAsc = (points: FiatRatePoint[]): boolean => {
  'worklet';

  for (let i = 1; i < points.length; i++) {
    if (points[i].ts < points[i - 1].ts) return false;
  }
  return true;
};

export const normalizeFiatRateTimeframePoints = (
  pointsRaw: FiatRatePoint[] | undefined,
): FiatRatePoint[] | undefined => {
  'worklet';

  const points = Array.isArray(pointsRaw)
    ? pointsRaw.filter(isValidRatePoint)
    : [];
  if (!points.length) {
    return undefined;
  }
  return isSortedByTsAsc(points) ? points : points.slice().sort((a, b) => a.ts - b.ts);
};

const findBoundingFiatRatePointsInSorted = (
  points: FiatRatePoint[],
  tsMs: number,
): BoundingRatePoints => {
  'worklet';

  if (!points.length) {
    return {left: undefined, right: undefined};
  }

  let lo = 0;
  let hi = points.length - 1;

  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (points[mid].ts < tsMs) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  const right = points[lo];
  const left = lo > 0 ? points[lo - 1] : undefined;
  return {left, right};
};

export const findBoundingFiatRatePoints = (
  pointsRaw: FiatRatePoint[],
  tsMs: number,
): BoundingRatePoints => {
  'worklet';

  const points = normalizeFiatRateTimeframePoints(pointsRaw) ?? [];
  return findBoundingFiatRatePointsInSorted(points, tsMs);
};

const getNearestFiatRatePointInSorted = (
  points: FiatRatePoint[],
  tsMs: number,
): FiatRatePoint | undefined => {
  'worklet';

  const {left, right} = findBoundingFiatRatePointsInSorted(points, tsMs);
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return Math.abs(right.ts - tsMs) < Math.abs(tsMs - left.ts) ? right : left;
};

export const getNearestFiatRatePoint = (
  pointsRaw: FiatRatePoint[],
  tsMs: number,
): FiatRatePoint | undefined => {
  'worklet';

  const points = normalizeFiatRateTimeframePoints(pointsRaw) ?? [];
  return getNearestFiatRatePointInSorted(points, tsMs);
};

const getInterpolatedFiatRateAtTsInSorted = (
  points: FiatRatePoint[],
  tsMs: number,
): number | undefined => {
  'worklet';

  const {left, right} = findBoundingFiatRatePointsInSorted(points, tsMs);

  if (!left && right) {
    return right.rate;
  }
  if (!right && left) {
    return left.rate;
  }
  if (!left || !right) {
    return undefined;
  }
  if (right.ts === left.ts) {
    return right.rate;
  }
  if (tsMs <= left.ts) {
    return left.rate;
  }
  if (tsMs >= right.ts) {
    return right.rate;
  }

  const ratio = (tsMs - left.ts) / (right.ts - left.ts);
  const rate = left.rate + (right.rate - left.rate) * ratio;
  return Number.isFinite(rate) ? rate : undefined;
};

export const getInterpolatedFiatRateAtTs = (
  pointsRaw: FiatRatePoint[],
  tsMs: number,
): number | undefined => {
  'worklet';

  const points = normalizeFiatRateTimeframePoints(pointsRaw) ?? [];
  return getInterpolatedFiatRateAtTsInSorted(points, tsMs);
};

export const getFiatRateFromPointsAtTimestamp = (args: {
  points: FiatRatePoint[] | undefined;
  timestampMs: number;
  method?: FiatRateLookupMethod;
}): number | undefined => {
  'worklet';

  const points = normalizeFiatRateTimeframePoints(args.points);
  if (!points) {
    return undefined;
  }

  if (args.method === 'linear') {
    return getInterpolatedFiatRateAtTsInSorted(points, args.timestampMs);
  }

  return getNearestFiatRatePointInSorted(points, args.timestampMs)?.rate;
};

const getLegacyFiatRateSeriesAssetKey = (args: {
  coin: string;
  chain?: string;
  tokenAddress?: string;
}): string => {
  'worklet';

  const coin = String(args.coin || '').trim().toLowerCase();
  if (!coin) {
    return '';
  }

  const chain = normalizeFiatRateSeriesChain(args.chain);
  const tokenAddress = normalizeFiatRateSeriesTokenAddress(
    chain,
    args.tokenAddress,
  );

  if (!chain && !tokenAddress) {
    return coin;
  }

  return tokenAddress ? `${coin}|${chain || ''}|${tokenAddress}` : `${coin}|${chain || ''}`;
};

const getLegacyFiatRateSeriesCacheKey = (args: {
  fiatCode: string;
  coin: string;
  interval: FiatRateInterval;
  identity?: FiatRateSeriesReaderIdentity;
}): string => {
  'worklet';

  return `${(args.fiatCode || '').toUpperCase()}:${getLegacyFiatRateSeriesAssetKey({
    coin: args.coin,
    chain: args.identity?.chain,
    tokenAddress: args.identity?.tokenAddress,
  })}:${args.interval}`;
};

const getFiatRateSeriesCacheKeyCandidates = (args: {
  fiatCode: string;
  coin: string;
  interval: FiatRateInterval;
  identity?: FiatRateSeriesReaderIdentity;
}): string[] => {
  'worklet';

  const rawCoin = String(args.coin || '').trim().toLowerCase();
  const canonicalCoin = normalizeFiatRateSeriesCoin(rawCoin);
  const coins = uniqueStrings([canonicalCoin, rawCoin]);
  const keys: string[] = [];

  for (const coin of coins) {
    keys.push(
      getFiatRateSeriesCacheKey(args.fiatCode, coin, args.interval, {
        chain: args.identity?.chain,
        tokenAddress: args.identity?.tokenAddress,
      }),
    );
    keys.push(
      getLegacyFiatRateSeriesCacheKey({
        fiatCode: args.fiatCode,
        coin,
        interval: args.interval,
        identity: args.identity,
      }),
    );
  }

  return uniqueStrings(keys);
};

export const getFiatRateSeriesPointsForTimeframe = (args: {
  fiatRateSeriesCache: FiatRateSeriesCache | undefined;
  fiatCode: string;
  currencyAbbreviation: string;
  interval: FiatRateInterval;
  identity?: FiatRateSeriesReaderIdentity;
}): FiatRatePoint[] | undefined => {
  'worklet';

  const cache = args.fiatRateSeriesCache;
  if (!cache) {
    return undefined;
  }

  const candidates = getFiatRateSeriesCacheKeyCandidates({
    fiatCode: args.fiatCode,
    coin: args.currencyAbbreviation,
    interval: args.interval,
    identity: args.identity,
  });

  for (const cacheKey of candidates) {
    const series = cache[cacheKey];
    const points = normalizeFiatRateTimeframePoints(series?.points);
    if (points?.length) {
      return points;
    }
  }

  return undefined;
};

export const getFiatRateFromSeriesCacheAtTimestamp = (args: {
  fiatRateSeriesCache: FiatRateSeriesCache | undefined;
  fiatCode: string;
  currencyAbbreviation: string;
  interval: FiatRateInterval;
  timestampMs: number;
  method?: FiatRateLookupMethod;
  identity?: FiatRateSeriesReaderIdentity;
}): number | undefined => {
  'worklet';

  const points = getFiatRateSeriesPointsForTimeframe({
    fiatRateSeriesCache: args.fiatRateSeriesCache,
    fiatCode: args.fiatCode,
    currencyAbbreviation: args.currencyAbbreviation,
    interval: args.interval,
    identity: args.identity,
  });

  return getFiatRateFromPointsAtTimestamp({
    points,
    timestampMs: args.timestampMs,
    method: args.method,
  });
};

export const getFiatRateChangeFromPointsForTimeframe = (args: {
  points: FiatRatePoint[] | undefined;
  timeframe: FiatRateInterval;
  nowMs?: number;
  assetId?: string;
  currentRatesByAssetId?: Record<string, number | undefined>;
  currentRate?: number;
  method?: FiatRateLookupMethod;
}): FiatRateChangeForTimeframe | undefined => {
  'worklet';

  const points = normalizeFiatRateTimeframePoints(args.points);
  if (!points) {
    return undefined;
  }

  const nowMs = typeof args.nowMs === 'number' ? args.nowMs : Date.now();
  const method = args.method ?? 'linear';
  const baselineTimestampMs = getFiatRateBaselineTsForTimeframe({
    timeframe: args.timeframe,
    nowMs,
  });

  const currentRateFromMap = args.assetId
    ? args.currentRatesByAssetId?.[args.assetId]
    : undefined;
  const currentRate =
    typeof currentRateFromMap === 'number' && Number.isFinite(currentRateFromMap)
      ? currentRateFromMap
      : typeof args.currentRate === 'number' && Number.isFinite(args.currentRate)
      ? args.currentRate
      : getFiatRateFromPointsAtTimestamp({
          points,
          timestampMs: nowMs,
          method: 'nearest',
        });
  if (!(typeof currentRate === 'number' && Number.isFinite(currentRate))) {
    return undefined;
  }

  const baseline = (() => {
    'worklet';

    if (args.timeframe === 'ALL') {
      const first = points[0];
      if (!first || !(first.rate > 0)) {
        return undefined;
      }
      return {tsMs: first.ts, rate: first.rate};
    }

    if (typeof baselineTimestampMs !== 'number') {
      return undefined;
    }

    const baselineRate = getFiatRateFromPointsAtTimestamp({
      points,
      timestampMs: baselineTimestampMs,
      method,
    });
    if (!(typeof baselineRate === 'number' && Number.isFinite(baselineRate))) {
      return undefined;
    }
    return {tsMs: baselineTimestampMs, rate: baselineRate};
  })();

  if (!baseline || !(baseline.rate > 0)) {
    return undefined;
  }

  const priceChange = currentRate - baseline.rate;
  const percentRatio = priceChange / baseline.rate;
  if (!Number.isFinite(priceChange) || !Number.isFinite(percentRatio)) {
    return undefined;
  }

  const percentChange = Number((percentRatio * 100).toFixed(2));
  if (!Number.isFinite(percentChange)) {
    return undefined;
  }

  return {
    timeframe: args.timeframe,
    baselineTimestampMs: baseline.tsMs,
    baselineRate: baseline.rate,
    currentRate,
    priceChange,
    percentChange,
    percentRatio,
  };
};

export const getFiatRateChangeForTimeframe = (args: {
  fiatRateSeriesCache: FiatRateSeriesCache | undefined;
  fiatCode: string;
  currencyAbbreviation: string;
  timeframe: FiatRateInterval;
  nowMs?: number;
  assetId?: string;
  currentRatesByAssetId?: Record<string, number | undefined>;
  currentRate?: number;
  method?: FiatRateLookupMethod;
  identity?: FiatRateSeriesReaderIdentity;
}): FiatRateChangeForTimeframe | undefined => {
  'worklet';

  const {seriesInterval} = getFiatRateTimeframeConfig({
    timeframe: args.timeframe,
    nowMs: args.nowMs,
  });

  const points = getFiatRateSeriesPointsForTimeframe({
    fiatRateSeriesCache: args.fiatRateSeriesCache,
    fiatCode: args.fiatCode,
    currencyAbbreviation: args.currencyAbbreviation,
    interval: seriesInterval,
    identity: args.identity,
  });

  return getFiatRateChangeFromPointsForTimeframe({
    points,
    timeframe: args.timeframe,
    nowMs: args.nowMs,
    assetId: args.assetId,
    currentRatesByAssetId: args.currentRatesByAssetId,
    currentRate: args.currentRate,
    method: args.method,
  });
};
