import {Effect} from '../../index';
import {Wallet} from '../../wallet/wallet.models';
import {CryptoCheckpoint, BalancePoint, SeriesRefreshState, Timeframe, WalletContribution} from '../portfolio.types';
import {
  BWS_TX_HISTORY_LIMIT,
  GetTransactionHistory,
} from '../../wallet/effects/transactions/transactions';
import {GetPrecision} from '../../wallet/utils/currency';
import {getHistoricQuoteRate} from '../rate-cache';

// TX history request counter for debugging/monitoring
let txHistoryRequestCount = 0;
let lastTxHistoryWallet = '';

export const resetTxHistoryRequestCount = () => {
  txHistoryRequestCount = 0;
  lastTxHistoryWallet = '';
};

export const getTxHistoryRequestCount = () => txHistoryRequestCount;

export const getLastTxHistoryWallet = () => lastTxHistoryWallet;

export interface FetchFullHistoryOptions {
  wallet: Wallet;
  batchSize?: number;
  maxBatches?: number;
}

const DEFAULT_MAX_BATCHES = 200; // Safety guard to avoid runaway loops

const sortTransactionsAscending = (txs: any[]) =>
  txs.slice().sort((a, b) => {
    const at = a?.time ?? a?.createdOn ?? 0;
    const bt = b?.time ?? b?.createdOn ?? 0;
    return at - bt;
  });

/**
 * Fetch the full transaction history for a wallet, paging through BWS until no more
 * results are returned (or maxBatches is reached). Returned list is sorted ascending
 * by timestamp for easier timeline construction.
 */
export const fetchFullHistory =
  ({
    wallet,
    batchSize = BWS_TX_HISTORY_LIMIT,
    maxBatches = DEFAULT_MAX_BATCHES,
  }: FetchFullHistoryOptions): Effect<Promise<any[]>> =>
  async dispatch => {
    const effectiveBatchSize = Math.min(batchSize, BWS_TX_HISTORY_LIMIT);
    let aggregate = wallet.transactionHistory?.transactions ?? [];
    let loadMore = true;
    let iteration = 0;

    while (loadMore && iteration < maxBatches) {
      txHistoryRequestCount++;
      lastTxHistoryWallet = `${wallet.currencyAbbreviation.toUpperCase()} (${wallet.walletName || wallet.id.slice(0, 8)})`;
      const historyResponse = await dispatch(
        GetTransactionHistory({
          wallet,
          transactionsHistory: aggregate,
          limit: effectiveBatchSize,
          refresh: iteration === 0,
          isExportHistoryView: true,
        }),
      );

      if (!historyResponse) {
        break;
      }

      aggregate = historyResponse.transactions || aggregate;
      loadMore = !!historyResponse.loadMore;
      iteration += 1;
    }

    return sortTransactionsAscending(aggregate);
  };

const getTransactionTimestampMs = (tx: any) => {
  const seconds = tx?.time ?? tx?.createdOn ?? 0;
  return seconds * 1000;
};

const toNumber = (value: any): number => {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
};

const getTransactionDelta = (tx: any): number => {
  const amountSat = toNumber(tx?.amount);
  const feeSat = toNumber(tx?.fees ?? tx?.fee);
  switch (tx?.action) {
    case 'received':
      return amountSat;
    case 'sent':
      return -(amountSat + feeSat);
    case 'moved':
      // Moved = sent to self, so only the fee is lost (amount comes back)
      return -feeSat;
    default:
      return 0;
  }
};

/**
 * Builds a crypto-only timeline from transactions.
 * Pure function, no fiat conversion - just tracks balance changes at transaction times.
 * @returns CryptoCheckpoint[] sorted ascending by timestamp
 */
export const buildCryptoTimeline = (transactions: any[]): CryptoCheckpoint[] => {
  if (!transactions?.length) {
    return [];
  }

  const checkpoints: CryptoCheckpoint[] = [];
  let runningSat = 0;

  transactions.forEach(tx => {
    runningSat += getTransactionDelta(tx);
    checkpoints.push({
      timestamp: getTransactionTimestampMs(tx),
      amount: runningSat,
      memo: tx?.message?.body || tx?.note || undefined,
      action: tx?.action as 'sent' | 'received' | 'moved' | undefined,
    });
  });

  return checkpoints;
};

const DAY_MS = 24 * 60 * 60 * 1000;

const TIMEFRAME_TO_MS: Record<Exclude<Timeframe, 'ALL'>, number> = {
  '1D': DAY_MS,
  '1W': 7 * DAY_MS,
  '1M': 30 * DAY_MS,
  '3M': 90 * DAY_MS,
  '1Y': 365 * DAY_MS,
  '5Y': 1825 * DAY_MS,
};

/**
 * Get the duration in milliseconds for a timeframe.
 * Returns undefined for 'ALL' timeframe.
 */
export const getTimeframeDurationMs = (timeframe: Timeframe): number | undefined => {
  if (timeframe === 'ALL') {
    return undefined;
  }
  return TIMEFRAME_TO_MS[timeframe];
};

/** Target number of data points for chart rendering performance */
const TARGET_DATA_POINTS = 45;

const getUnitAmount = (satAmount: number, unitToSatoshi?: number) => {
  if (!unitToSatoshi) {
    return 0;
  }
  return satAmount * (1 / unitToSatoshi);
};

export interface BuildQuoteSeriesOptions {
  wallet: Wallet;
  cryptoTimeline: CryptoCheckpoint[];
  quoteCurrency: string;
  timeframe: Timeframe;
  endTimestamp?: number;
  /** Optional live rate to use for the final data point (current time) */
  liveRate?: number;
}

/**
 * Converts a crypto timeline to a fiat-denominated balance series.
 * - Filters checkpoints by timeframe
 * - Samples at exactly TARGET_DATA_POINTS intervals for chart performance
 * - Fetches historic rates and converts to quote currency
 */
export const buildQuoteSeries = ({
  wallet,
  cryptoTimeline,
  quoteCurrency,
  timeframe,
  endTimestamp = Date.now(),
  liveRate,
}: BuildQuoteSeriesOptions): Effect<Promise<BalancePoint[]>> =>
  async dispatch => {
    if (!cryptoTimeline?.length) {
      return [];
    }

    // 1. Determine time range
    const firstTs = cryptoTimeline[0].timestamp;
    let startTs: number;

    if (timeframe === 'ALL') {
      startTs = firstTs;
    } else {
      const duration = TIMEFRAME_TO_MS[timeframe];
      startTs = Math.max(firstTs, endTimestamp - duration);
    }

    // 2. Calculate interval to produce exactly TARGET_DATA_POINTS
    const totalDuration = endTimestamp - startTs;
    const intervalMs = Math.max(
      Math.floor(totalDuration / TARGET_DATA_POINTS),
      60 * 1000, // minimum 1 minute interval
    );

    // 3. Sample at calculated intervals
    const sampledPoints: {timestamp: number; amount: number}[] = [];
    let checkpointIndex = 0;
    let currentAmount = 0;

    // Find the starting crypto amount (last checkpoint before startTs)
    while (
      checkpointIndex < cryptoTimeline.length &&
      cryptoTimeline[checkpointIndex].timestamp <= startTs
    ) {
      currentAmount = cryptoTimeline[checkpointIndex].amount;
      checkpointIndex++;
    }

    for (let ts = startTs; ts <= endTimestamp; ts += intervalMs) {
      // Advance through checkpoints that fall before or at this interval
      while (
        checkpointIndex < cryptoTimeline.length &&
        cryptoTimeline[checkpointIndex].timestamp <= ts
      ) {
        currentAmount = cryptoTimeline[checkpointIndex].amount;
        checkpointIndex++;
      }

      sampledPoints.push({timestamp: ts, amount: currentAmount});
    }

    // 4. Get precision for this wallet's asset
    const precision = dispatch(
      GetPrecision(
        wallet.currencyAbbreviation,
        wallet.chain,
        wallet.tokenAddress,
      ),
    );
    const unitToSatoshi = precision?.unitToSatoshi;

    if (!unitToSatoshi) {
      return [];
    }

    // 5. Convert each sampled point to fiat
    const points: BalancePoint[] = [];
    const lastIndex = sampledPoints.length - 1;

    for (let i = 0; i < sampledPoints.length; i++) {
      const sample = sampledPoints[i];
      const assetUnits = getUnitAmount(sample.amount, unitToSatoshi);

      // Use live rate for the final data point if provided, otherwise fetch historic rate
      const isLastPoint = i === lastIndex;
      const rate =
        isLastPoint && liveRate !== undefined
          ? liveRate
          : await getHistoricQuoteRate({
              quoteCurrency,
              currencyAbbreviation: wallet.currencyAbbreviation,
              chain: wallet.chain,
              tokenAddress: wallet.tokenAddress,
              timestampMs: sample.timestamp,
            });

      // Skip if no rate available (but still include zero-balance points)
      if (!rate && assetUnits !== 0) {
        continue;
      }

      points.push({
        timestamp: sample.timestamp,
        quoteValue: assetUnits * (rate || 0),
        quoteCurrency,
        quoteRate: rate,
        cryptoAmount: sample.amount,
      });
    }

    return points;
  };

/**
 * Find the balance point at or before a given timestamp.
 * Returns undefined if no point exists before the timestamp.
 */
const findPointAtOrBefore = (
  series: BalancePoint[],
  timestamp: number,
): BalancePoint | undefined => {
  let result: BalancePoint | undefined;
  for (const point of series) {
    if (point.timestamp <= timestamp) {
      result = point;
    } else {
      break;
    }
  }
  return result;
};

/**
 * Wallet metadata for breakdown tracking during merge.
 */
export interface WalletSeriesWithMeta {
  series: BalancePoint[];
  walletId: string;
  walletName?: string;
  currencyAbbreviation: string;
  chain: string;
}

/**
 * Merge multiple wallet balance series into a single aggregated series.
 * Used for key-level and portfolio-level aggregation.
 * - Collects all unique timestamps across all series
 * - For each timestamp, sums the fiat values from all wallets
 * - Resamples to TARGET_DATA_POINTS for chart performance
 * - Optionally includes per-wallet breakdown for debugging
 */
export const mergeBalanceSeries = (
  seriesArray: BalancePoint[][] | WalletSeriesWithMeta[],
  quoteCurrency: string,
): BalancePoint[] => {
  if (seriesArray.length === 0) {
    return [];
  }

  // Normalize input: support both simple arrays and arrays with metadata
  // Check if first element is an object with 'series' property (WalletSeriesWithMeta)
  // vs an array (BalancePoint[])
  const firstItem = seriesArray[0];
  const hasMetadata = !Array.isArray(firstItem) && typeof firstItem === 'object' && 'series' in firstItem;
  const walletMetas: WalletSeriesWithMeta[] = hasMetadata
    ? (seriesArray as WalletSeriesWithMeta[])
    : (seriesArray as BalancePoint[][]).map((series, idx) => ({
        series,
        walletId: `wallet-${idx}`,
        walletName: undefined,
        currencyAbbreviation: 'UNKNOWN',
        chain: 'unknown',
      }));

  // Filter out empty series
  const nonEmptyMetas = walletMetas.filter(m => m.series.length > 0);
  if (nonEmptyMetas.length === 0) {
    return [];
  }

  // Collect all unique timestamps
  const allTimestamps = new Set<number>();
  nonEmptyMetas.forEach(meta =>
    meta.series.forEach(p => allTimestamps.add(p.timestamp)),
  );

  // Sort timestamps ascending
  const sortedTs = Array.from(allTimestamps).sort((a, b) => a - b);

  if (sortedTs.length === 0) {
    return [];
  }

  // Resample to TARGET_DATA_POINTS if we have more timestamps
  let sampledTs = sortedTs;
  if (sortedTs.length > TARGET_DATA_POINTS) {
    const startTs = sortedTs[0];
    const endTs = sortedTs[sortedTs.length - 1];
    const intervalMs = Math.floor((endTs - startTs) / TARGET_DATA_POINTS);
    sampledTs = [];
    for (let ts = startTs; ts <= endTs; ts += intervalMs) {
      sampledTs.push(ts);
    }
    // Ensure we include the final timestamp
    if (sampledTs[sampledTs.length - 1] < endTs) {
      sampledTs.push(endTs);
    }
  }

  // For each timestamp, sum fiat values across all series and build breakdown
  return sampledTs.map(ts => {
    let totalFiat = 0;
    let totalCrypto = 0;
    const breakdown: WalletContribution[] = [];

    nonEmptyMetas.forEach(meta => {
      const point = findPointAtOrBefore(meta.series, ts);
      if (point) {
        totalFiat += point.quoteValue;
        totalCrypto += point.cryptoAmount;
        breakdown.push({
          walletId: meta.walletId,
          walletName: meta.walletName,
          currencyAbbreviation: meta.currencyAbbreviation,
          chain: meta.chain,
          quoteValue: point.quoteValue,
          cryptoAmount: point.cryptoAmount,
        });
      }
    });

    return {
      timestamp: ts,
      quoteValue: totalFiat,
      quoteCurrency,
      cryptoAmount: totalCrypto,
      breakdown: hasMetadata ? breakdown : undefined,
    };
  });
};

export interface IncrementalRefreshOptions {
  wallet: Wallet;
  existingSeries: BalancePoint[];
  existingRefreshState: SeriesRefreshState;
  cryptoTimeline: CryptoCheckpoint[];
  quoteCurrency: string;
  timeframe: Timeframe;
  liveRate?: number;
}

/**
 * Performs an incremental (left-shift) refresh of a balance series.
 * - Filters out stale points that fall outside the new time window
 * - Builds new points only for the period since last update
 * - Merges old valid points with new points
 * 
 * Returns the updated series and new metadata.
 */
export const buildIncrementalQuoteSeries = ({
  wallet,
  existingSeries,
  existingRefreshState,
  cryptoTimeline,
  quoteCurrency,
  timeframe,
  liveRate,
}: IncrementalRefreshOptions): Effect<Promise<{points: BalancePoint[]; refreshState: SeriesRefreshState}>> =>
  async dispatch => {
    const now = Date.now();
    const timeframeDuration = getTimeframeDurationMs(timeframe);
    
    // For ALL timeframe, we don't left-shift, just append new data
    const windowStart = timeframeDuration 
      ? now - timeframeDuration 
      : existingRefreshState.windowStart;
    
    // 1. Left-shift: filter out points that are now outside the window
    const validPoints = existingSeries.filter(p => p.timestamp >= windowStart);
    
    // 2. Determine where to start building new points
    const lastValidTimestamp = validPoints.length > 0 
      ? validPoints[validPoints.length - 1].timestamp 
      : windowStart;
    
    // 3. Calculate interval based on remaining gap to fill
    const remainingDuration = now - lastValidTimestamp;
    const totalDuration = now - windowStart;
    const intervalMs = Math.max(
      Math.floor(totalDuration / TARGET_DATA_POINTS),
      60 * 1000, // minimum 1 minute interval
    );
    
    // 4. Find starting crypto amount at lastValidTimestamp
    let currentAmount = existingRefreshState.lastCryptoAmount;
    let checkpointIndex = 0;
    
    // Advance to find the correct starting amount
    while (
      checkpointIndex < cryptoTimeline.length &&
      cryptoTimeline[checkpointIndex].timestamp <= lastValidTimestamp
    ) {
      currentAmount = cryptoTimeline[checkpointIndex].amount;
      checkpointIndex++;
    }
    
    // 5. Sample new points from lastValidTimestamp to now
    const newSampledPoints: {timestamp: number; amount: number}[] = [];
    
    // Start from the next interval after the last valid point
    const startTs = lastValidTimestamp + intervalMs;
    
    for (let ts = startTs; ts <= now; ts += intervalMs) {
      // Advance through checkpoints that fall before or at this interval
      while (
        checkpointIndex < cryptoTimeline.length &&
        cryptoTimeline[checkpointIndex].timestamp <= ts
      ) {
        currentAmount = cryptoTimeline[checkpointIndex].amount;
        checkpointIndex++;
      }
      newSampledPoints.push({timestamp: ts, amount: currentAmount});
    }
    
    // 6. Get precision for this wallet's asset
    const precision = dispatch(
      GetPrecision(
        wallet.currencyAbbreviation,
        wallet.chain,
        wallet.tokenAddress,
      ),
    );
    const unitToSatoshi = precision?.unitToSatoshi;
    
    if (!unitToSatoshi) {
      return {
        points: existingSeries,
        refreshState: existingRefreshState,
      };
    }
    
    // 7. Convert new sampled points to fiat
    const newPoints: BalancePoint[] = [];
    const lastIndex = newSampledPoints.length - 1;
    
    for (let i = 0; i < newSampledPoints.length; i++) {
      const sample = newSampledPoints[i];
      const assetUnits = getUnitAmount(sample.amount, unitToSatoshi);
      
      // Use live rate for the final data point if provided
      const isLastPoint = i === lastIndex;
      const rate =
        isLastPoint && liveRate !== undefined
          ? liveRate
          : await getHistoricQuoteRate({
              quoteCurrency,
              currencyAbbreviation: wallet.currencyAbbreviation,
              chain: wallet.chain,
              tokenAddress: wallet.tokenAddress,
              timestampMs: sample.timestamp,
            });
      
      if (!rate && assetUnits !== 0) {
        continue;
      }
      
      newPoints.push({
        timestamp: sample.timestamp,
        quoteValue: assetUnits * (rate || 0),
        quoteCurrency,
        quoteRate: rate,
        cryptoAmount: sample.amount,
      });
    }
    
    // 8. Merge valid old points with new points
    const mergedPoints = [...validPoints, ...newPoints];
    
    // 9. Build new refresh state
    const newRefreshState: SeriesRefreshState = {
      lastUpdated: now,
      lastCryptoAmount: currentAmount,
      lastTxCount: cryptoTimeline.length,
      windowStart,
    };
    
    return {points: mergedPoints, refreshState: newRefreshState};
  };
