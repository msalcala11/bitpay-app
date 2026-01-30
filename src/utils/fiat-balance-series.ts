import type {BalanceSnapshot} from '../store/portfolio/portfolio.models';
import type {Wallet} from '../store/wallet/wallet.models';
import type {FiatRateInterval, FiatRateSeriesCache} from '../store/rate/rate.models';
import {getFiatRateSeriesCacheKey} from '../store/rate/rate.models';
import type {AlignedRatePoint, RatesByCoin, RatePoint} from './rate';
import {
  alignTimestamps,
  downsampleTimestamps,
  getFiatRateSeriesIntervalForTimeframe,
  getWindowMsForFiatRateTimeframe,
  normalizeFiatRateSeriesCoin,
  trimTimestamps,
} from './rate';

export type FiatBalancePoint = {
  ts: number;
  /** Aggregated fiat balance (quote currency) across the provided wallets at ts */
  balance: number;
};

const toFiniteNumber = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

const getSeriesPointsFromCache = (args: {
  fiatRateSeriesCache: FiatRateSeriesCache | undefined;
  fiatCode: string;
  coin: string;
  interval: FiatRateInterval;
}): RatePoint[] | undefined => {
  const cache = args.fiatRateSeriesCache;
  if (!cache) {
    return undefined;
  }

  const cacheKey = getFiatRateSeriesCacheKey(
    args.fiatCode,
    args.coin,
    args.interval,
  );
  const series = cache[cacheKey];
  const points = Array.isArray(series?.points) ? series.points : [];
  if (!points.length) {
    return undefined;
  }

  // FiatRatePoint already matches RatePoint shape.
  return points as unknown as RatePoint[];
};

const isSnapshotsSortedAscending = (snaps: BalanceSnapshot[]): boolean => {
  if (snaps.length < 2) {
    return true;
  }
  // Quick edge check first; most arrays are already sorted.
  if ((snaps[0]?.timestamp || 0) > (snaps[snaps.length - 1]?.timestamp || 0)) {
    return false;
  }
  for (let i = 1; i < snaps.length; i++) {
    if ((snaps[i - 1]?.timestamp || 0) > (snaps[i]?.timestamp || 0)) {
      return false;
    }
  }
  return true;
};

const upperBoundSnapshotTs = (snaps: BalanceSnapshot[], tsMs: number): number => {
  // First index where snapshot.timestamp > tsMs.
  let lo = 0;
  let hi = snaps.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((snaps[mid]?.timestamp || 0) <= tsMs) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
};

const getFirstNonZeroSnapshotTimestampMs = (
  snaps: BalanceSnapshot[] | undefined,
): number | undefined => {
  const arr = Array.isArray(snaps) ? snaps : [];
  if (!arr.length) {
    return undefined;
  }

  // Assumes sorted ascending (normal invariant). If not sorted, fall back to a safe scan.
  const safeArr = isSnapshotsSortedAscending(arr)
    ? arr
    : arr.slice().sort((a, b) => (a?.timestamp || 0) - (b?.timestamp || 0));

  for (const s of safeArr) {
    const units = toFiniteNumber(s?.cryptoBalance);
    if (units > 0) {
      const ts = s?.timestamp;
      return typeof ts === 'number' && Number.isFinite(ts) && ts > 0
        ? ts
        : undefined;
    }
  }
  return undefined;
};

const sliceAlignedByMinTimestamp = (args: {
  aligned: Record<string, AlignedRatePoint[]>;
  minTimestampMs: number;
}): Record<string, AlignedRatePoint[]> => {
  const coins = Object.keys(args.aligned);
  if (!coins.length) {
    return {};
  }

  const sortedCoins = coins.slice().sort((a, b) => a.localeCompare(b));
  const driverCoin = sortedCoins[0];
  const driver = args.aligned[driverCoin] || [];

  let startIdx = 0;
  while (startIdx < driver.length) {
    const p = driver[startIdx];
    const ts = p?.ts ?? 0;
    if (ts >= args.minTimestampMs) {
      break;
    }
    startIdx++;
  }

  if (startIdx <= 0) {
    return args.aligned;
  }

  const out: Record<string, AlignedRatePoint[]> = {};
  for (const coin of coins) {
    out[coin] = (args.aligned[coin] || []).slice(startIdx);
  }
  return out;
};

/**
 * Builds 91 (or fewer, if insufficient cached data exists) aggregated fiat balance points over time.
 *
 * - Uses FiatRateSeriesCache to generate a shared set of timestamps across all wallet assets.
 * - Uses wallet BalanceSnapshot history to compute units held at each timestamp (latest snapshot <= ts).
 * - Multiplies units by the asset's fiat rate at each timestamp, and sums across wallets.
 *
 * Notes:
 * - This is the from-scratch computation only. No memoization/caching is performed here.
 * - For timeframe === 'ALL', the returned series is trimmed to start at the earliest first-nonzero
 *   snapshot across wallets in the aggregation ("oldest" wallet behavior).
 */
export const buildAggregatedFiatBalanceSeries = (args: {
  wallets: Wallet[] | undefined;
  snapshotsByWalletId: {[walletId: string]: BalanceSnapshot[] | undefined};
  fiatRateSeriesCache: FiatRateSeriesCache | undefined;
  fiatCode: string;
  timeframe: FiatRateInterval;
  nowMs?: number;
  targetLen?: number;
}): FiatBalancePoint[] => {
  const wallets = Array.isArray(args.wallets) ? args.wallets : [];
  if (!wallets.length) {
    return [];
  }

  const nowMs = typeof args.nowMs === 'number' ? args.nowMs : Date.now();
  const targetLen =
    typeof args.targetLen === 'number' && Number.isFinite(args.targetLen)
      ? Math.max(1, Math.trunc(args.targetLen))
      : 91;

  const seriesInterval = getFiatRateSeriesIntervalForTimeframe(args.timeframe);
  const windowMs = getWindowMsForFiatRateTimeframe(args.timeframe);
  const cutoffMs = windowMs > 0 ? nowMs - windowMs : undefined;

  // Group wallets by their normalized rate-series coin.
  const walletsByCoin = new Map<string, Wallet[]>();
  for (const w of wallets) {
    const abbr = (w?.currencyAbbreviation || '').toLowerCase();
    if (!abbr) {
      continue;
    }
    const coin = normalizeFiatRateSeriesCoin(abbr);
    if (!coin) {
      continue;
    }
    const list = walletsByCoin.get(coin);
    if (list) {
      list.push(w);
    } else {
      walletsByCoin.set(coin, [w]);
    }
  }

  const coins = Array.from(walletsByCoin.keys()).sort((a, b) => a.localeCompare(b));
  if (!coins.length) {
    return [];
  }

  // Gather rate series per coin for this timeframe.
  const ratesByCoin: RatesByCoin = {};
  for (const coin of coins) {
    const series = getSeriesPointsFromCache({
      fiatRateSeriesCache: args.fiatRateSeriesCache,
      fiatCode: (args.fiatCode || '').toUpperCase(),
      coin,
      interval: seriesInterval,
    });
    if (!series?.length) {
      continue;
    }

    const points =
      seriesInterval === 'ALL' && args.timeframe !== 'ALL' && cutoffMs
        ? series.filter(p => (p?.ts || 0) >= cutoffMs)
        : series;

    if (points.length) {
      ratesByCoin[coin] = points;
    }
  }

  const activeCoins = Object.keys(ratesByCoin).sort((a, b) => a.localeCompare(b));
  if (!activeCoins.length) {
    return [];
  }

  // Align timestamps across coins, trim edge-missing, then (optionally) adjust ALL start.
  const aligned = alignTimestamps(ratesByCoin);
  const trimmed = trimTimestamps(aligned);

  const trimmedForAll = (() => {
    if (args.timeframe !== 'ALL') {
      return trimmed;
    }

    // Find earliest first-nonzero snapshot timestamp across wallets in the aggregation.
    let earliestNonZero: number | undefined;
    const snapshotsByWalletId = args.snapshotsByWalletId || {};
    for (const w of wallets) {
      const wid = w?.id;
      if (!wid) {
        continue;
      }
      const ts = getFirstNonZeroSnapshotTimestampMs(snapshotsByWalletId[wid]);
      if (typeof ts !== 'number') {
        continue;
      }
      if (earliestNonZero === undefined || ts < earliestNonZero) {
        earliestNonZero = ts;
      }
    }

    if (!(typeof earliestNonZero === 'number' && earliestNonZero > 0)) {
      return trimmed;
    }

    return sliceAlignedByMinTimestamp({
      aligned: trimmed,
      minTimestampMs: earliestNonZero,
    });
  })();

  const driverCoin = Object.keys(trimmedForAll).sort((a, b) =>
    a.localeCompare(b),
  )[0];
  if (!driverCoin) {
    return [];
  }

  const len = trimmedForAll[driverCoin]?.length ?? 0;
  if (len < 2) {
    return [];
  }

  const effectiveTargetLen = Math.min(targetLen, len);

  const downsampled =
    len > effectiveTargetLen
      ? downsampleTimestamps(trimmedForAll, effectiveTargetLen, {
          strategy: 'even',
          mode: 'shared',
          driverCoin,
        })
      : trimmedForAll;

  const downCoins = Object.keys(downsampled).sort((a, b) => a.localeCompare(b));
  if (!downCoins.length) {
    return [];
  }

  const driver = downsampled[driverCoin] || [];
  const N = driver.length;
  if (N < 2) {
    return [];
  }

  // Build shared timestamps from the driver coin.
  const timestamps = new Array<number>(N);
  for (let i = 0; i < N; i++) {
    const ts = driver[i]?.ts ?? 0;
    timestamps[i] = typeof ts === 'number' && Number.isFinite(ts) ? ts : 0;
  }

  // Build rate arrays per coin at those indices.
  const ratesByCoinArr: Record<string, Float64Array> = {};
  for (const coin of downCoins) {
    const arr = downsampled[coin] || [];
    const out = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const r = arr[i]?.rate;
      out[i] = typeof r === 'number' && Number.isFinite(r) ? r : 0;
    }
    ratesByCoinArr[coin] = out;
  }

  const aggregateFiat = new Float64Array(N);
  const startTs = timestamps[0] || 0;
  const endTs = timestamps[N - 1] || 0;

  const snapshotsByWalletId = args.snapshotsByWalletId || {};

  // Aggregate per-coin units to reduce multiplications (wallets can be large).
  for (const coin of downCoins) {
    const walletsForCoin = walletsByCoin.get(coin);
    const rateArr = ratesByCoinArr[coin];
    if (!walletsForCoin?.length || !rateArr) {
      continue;
    }

    const unitsAgg = new Float64Array(N);

    for (const w of walletsForCoin) {
      const wid = w?.id;
      if (!wid) {
        continue;
      }
      const rawSnaps = snapshotsByWalletId[wid];
      if (!Array.isArray(rawSnaps) || rawSnaps.length === 0) {
        continue;
      }

      const snaps = isSnapshotsSortedAscending(rawSnaps)
        ? rawSnaps
        : rawSnaps.slice().sort((a, b) => (a?.timestamp || 0) - (b?.timestamp || 0));

      // Restrict scanning to relevant range for this timeframe.
      // We need latest snapshot <= startTs as the initial state.
      const ub = startTs > 0 ? upperBoundSnapshotTs(snaps, startTs) : 0;
      let j = ub;
      let currentUnits = 0;
      if (ub > 0) {
        const init = snaps[ub - 1];
        currentUnits = toFiniteNumber(init?.cryptoBalance);
      }

      // If the wallet has no nonzero balance at all and no snapshot updates in range, skip quickly.
      // (Common when aggregating many wallets that do not hold this asset.)
      if (!(currentUnits > 0) && (j >= snaps.length || (snaps[j]?.timestamp || 0) > endTs)) {
        continue;
      }

      for (let i = 0; i < N; i++) {
        const ts = timestamps[i];
        if (!ts) {
          continue;
        }
        while (j < snaps.length && (snaps[j]?.timestamp || 0) <= ts) {
          currentUnits = toFiniteNumber(snaps[j]?.cryptoBalance);
          j++;
        }
        if (currentUnits !== 0) {
          unitsAgg[i] += currentUnits;
        }
      }
    }

    // Convert aggregated units to fiat for this coin.
    for (let i = 0; i < N; i++) {
      const u = unitsAgg[i];
      if (u !== 0) {
        aggregateFiat[i] += u * rateArr[i];
      }
    }
  }

  const out: FiatBalancePoint[] = new Array(N);
  for (let i = 0; i < N; i++) {
    out[i] = {ts: timestamps[i], balance: aggregateFiat[i]};
  }
  return out;
};
