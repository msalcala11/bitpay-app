import {Effect} from '..';
import {logManager} from '../../managers/LogManager';
import {
  BWS_TX_HISTORY_LIMIT,
  GetTransactionHistory,
} from '../wallet/effects/transactions/transactions';
import {GetPrecision} from '../wallet/utils/currency';
import {Wallet} from '../wallet/wallet.models';
import {
  PortfolioTxEvent,
  PortfolioTxEventCategory,
  PortfolioInterval,
} from './portfolio.types';
import {
  setRateCacheUsd,
  setTxEventsForWallet,
  setWalletIntervalCursor,
} from './portfolio.actions';
import {buildWalletIntervalCursor} from './portfolio.cursor';
import {getHistoricFiatRate} from '../wallet/effects/rates/rates';
import {getPortfolioIntervalGrid} from './portfolio.grid';

const getAssetIdFromWallet = (wallet: Wallet): string => {
  const coin = wallet.currencyAbbreviation?.toLowerCase() || '';
  const chain = wallet.chain?.toLowerCase() || '';
  const tokenAddress = wallet.tokenAddress?.toLowerCase();
  return tokenAddress ? `${chain}:${coin}:${tokenAddress}` : `${chain}:${coin}`;
};

const getCoinFromAssetId = (assetId: string): string | undefined => {
  const parts = assetId.split(':');
  if (parts.length >= 2) {
    return parts[1];
  }
  return undefined;
};

const isBasisCreatingEvent = (event: PortfolioTxEvent): boolean =>
  event.category === 'receive';

const mapActionToCategory = (action: string | undefined): {
  category: PortfolioTxEventCategory;
  cryptoDeltaSign: 1 | -1 | 0;
} | null => {
  switch (action) {
    case 'received':
      return {category: 'receive', cryptoDeltaSign: 1};
    case 'sent':
      return {category: 'spend', cryptoDeltaSign: -1};
    case 'moved':
      return {category: 'moved', cryptoDeltaSign: 0};
    default:
      return null;
  }
};

const getTxFeeBaseUnits = (tx: any): number | undefined => {
  const gasUsed = tx?.receipt?.gasUsed;
  const effectiveGasPrice = tx?.receipt?.effectiveGasPrice;
  if (gasUsed != null && effectiveGasPrice != null) {
    const fee = Number(gasUsed) * Number(effectiveGasPrice);
    if (Number.isFinite(fee)) {
      return fee;
    }
  }

  const fee = tx?.fees ?? tx?.fee;
  if (fee == null) {
    return undefined;
  }
  const n = Number(fee);
  return Number.isFinite(n) ? n : undefined;
};

export const fetchFullTransactionHistoryForWallet = (
  wallet: Wallet,
): Effect<Promise<{transactions: any[]; requestCount: number}>> => async dispatch => {
  let acc: any[] = [];
  let loadMore = true;
  let iters = 0;
  let requestCount = 0;

  while (loadMore) {
    requestCount++;
    const {transactions, loadMore: _loadMore} = await dispatch(
      GetTransactionHistory({
        wallet,
        transactionsHistory: acc,
        limit: BWS_TX_HISTORY_LIMIT,
        refresh: iters === 0,
        isExportHistoryView: false,
      }),
    );
    acc = transactions;
    loadMore = _loadMore;
    iters++;
  }

  return {transactions: acc, requestCount};
};

export const normalizeTxHistoryToPortfolioTxEvents = (
  wallet: Wallet,
  transactions: any[],
): Effect<PortfolioTxEvent[]> =>
  (dispatch: any) => {
    const precision = dispatch(
      GetPrecision(wallet.currencyAbbreviation, wallet.chain, wallet.tokenAddress),
    ) as any;

    const unitToSatoshi = Number(precision?.unitToSatoshi) || 1;
    const assetId = getAssetIdFromWallet(wallet);

    const events: PortfolioTxEvent[] = [];

    for (const tx of transactions) {
      const actionMapping = mapActionToCategory(tx?.action);
      if (!actionMapping) {
        continue;
      }

      const time = Number(tx?.time);
      if (!Number.isFinite(time)) {
        continue;
      }

      const txid = String(tx?.txid || '');
      if (!txid) {
        continue;
      }

      const amountBaseUnits = Number(tx?.amount) || 0;
      const amountCrypto = amountBaseUnits / unitToSatoshi;

      const feeBaseUnits = getTxFeeBaseUnits(tx);
      const feeCryptoRaw =
        feeBaseUnits != null ? feeBaseUnits / unitToSatoshi : undefined;
      const feeCrypto =
        actionMapping.category === 'receive' ? undefined : feeCryptoRaw;

      const cryptoDelta = actionMapping.cryptoDeltaSign * amountCrypto;

      events.push({
        walletId: wallet.id,
        txid,
        time,
        assetId,
        category: actionMapping.category,
        cryptoDelta,
        feeCrypto,
        confirmed: Number(tx?.confirmations || 0) > 0,
        status: tx?.status,
      });
    }

    return events.sort((a, b) => a.time - b.time);
  };

export const syncPortfolioTxEventsForWallet = (
  wallet: Wallet,
): Effect<
  Promise<{
    events: PortfolioTxEvent[];
    requestCount: number;
    rateRequestCount: number;
    rateFetchedCount: number;
  }>
> => async dispatch => {
  try {
    logManager.info(`[portfolio] txhistory start wallet ${wallet.id}`);
    const {transactions, requestCount} = await dispatch(
      fetchFullTransactionHistoryForWallet(wallet),
    );
    logManager.info(
      `[portfolio] txhistory done wallet ${wallet.id}: requests=${requestCount}`,
    );
    const events = dispatch(normalizeTxHistoryToPortfolioTxEvents(wallet, transactions));
    dispatch(
      setTxEventsForWallet({
        walletId: wallet.id,
        txEvents: events,
      }),
    );
    const {rateRequestCount, fetchedCount} = await dispatch(
      backfillUsdPriceUsedForWallet(wallet.id),
    );
    return {
      events,
      requestCount,
      rateRequestCount,
      rateFetchedCount: fetchedCount,
    };
  } catch (e) {
    const err = e instanceof Error ? e.message : JSON.stringify(e);
    logManager.error('[portfolio] syncPortfolioTxEventsForWallet error:', err);
    return {events: [], requestCount: 0, rateRequestCount: 0, rateFetchedCount: 0};
  }
};

export const backfillUsdPriceUsedForWallet = (
  walletId: string,
): Effect<
  Promise<{
    rateRequestCount: number;
    fetchedCount: number;
    missingBucketCount: number;
  }>
> => async (dispatch, getState) => {
  const state = getState();
  const events = state.PORTFOLIO.txEventsByWalletId[walletId] || [];
  if (!events.length) {
    return {rateRequestCount: 0, fetchedCount: 0, missingBucketCount: 0};
  }

  const rateCache = state.PORTFOLIO.rateCacheUsd || {};

  // First, apply any existing cached rates to events.
  const eventsWithCachedRates = events.map((event: PortfolioTxEvent) => {
    if (!isBasisCreatingEvent(event) || event.usdPriceUsed != null) {
      return event;
    }
    const cached = rateCache?.[event.assetId]?.[event.time];
    if (cached != null) {
      return {...event, usdPriceUsed: cached};
    }
    return event;
  });

  // Gather missing buckets per asset.
  const missingRequests: Array<{
    assetId: string;
    ts: number;
    coin: string;
  }> = [];
  const seen = new Set<string>();
  eventsWithCachedRates.forEach((event: PortfolioTxEvent) => {
    if (!isBasisCreatingEvent(event) || event.usdPriceUsed != null) {
      return;
    }
    const ts = event.time;
    const coin = getCoinFromAssetId(event.assetId);
    if (!coin) {
      return;
    }
    const key = `${event.assetId}-${ts}`;
    if (!seen.has(key)) {
      seen.add(key);
      missingRequests.push({assetId: event.assetId, ts, coin});
    }
  });

  const rateRequestCount = missingRequests.length;
  logManager.info(
    `[portfolio] rate backfill start wallet ${walletId}: missingBuckets=${rateRequestCount}`,
  );

  const fetchedRates: Record<string, Record<number, number>> = {};
  let fetchedCount = 0;
  for (const req of missingRequests) {
    try {
      const historic = await getHistoricFiatRate('USD', req.coin, String(req.ts * 1000));
      if (historic?.rate != null) {
        fetchedCount++;
        fetchedRates[req.assetId] = {
          ...(fetchedRates[req.assetId] || {}),
          [req.ts]: historic.rate,
        };
      }
    } catch (e) {
      const err = e instanceof Error ? e.message : JSON.stringify(e);
      logManager.error(
        `[portfolio] getHistoricFiatRate failed for ${req.assetId} ts ${req.ts}: ${err}`,
      );
    }
  }

  // Apply fetched rates to events.
  const updatedEvents = eventsWithCachedRates.map((event: PortfolioTxEvent) => {
    if (!isBasisCreatingEvent(event) || event.usdPriceUsed != null) {
      return event;
    }
    const fetched = fetchedRates?.[event.assetId]?.[event.time];
    if (fetched != null) {
      return {...event, usdPriceUsed: fetched};
    }
    return event;
  });

  if (Object.keys(fetchedRates).length) {
    dispatch(setRateCacheUsd({rateCacheUsd: fetchedRates}));
  }

  await dispatch(
    setTxEventsForWallet({
      walletId,
      txEvents: updatedEvents,
    }),
  );

  logManager.info(
    `[portfolio] rate backfill done wallet ${walletId}: requested=${rateRequestCount}, fetched=${fetchedCount}`,
  );

  return {
    rateRequestCount,
    fetchedCount,
    missingBucketCount: rateRequestCount,
  };
};

const attemptedRatesByRun: Record<string, Set<string>> = {};

const prefillRatesForIntervals = (
  assetId: string,
  coin: string,
  intervals: PortfolioInterval[],
  firstReceiveTimeSec?: number,
  runToken?: string,
  onProgress?: (p: {coin: string; requested: number; fetched: number}) => void,
): Effect<Promise<{requested: number; fetched: number}>> => async (
  dispatch,
  getState,
) => {
  const state = getState();
  const cache = state.PORTFOLIO.rateCacheUsd?.[assetId] || {};

  const allTimes = new Set<number>();
  intervals.forEach(interval => {
    const grid = getPortfolioIntervalGrid(interval, Date.now(), firstReceiveTimeSec);
    grid.times.forEach(ts => allTimes.add(ts));
  });

  const attemptedSet =
    runToken != null
      ? (attemptedRatesByRun[runToken] =
          attemptedRatesByRun[runToken] || new Set<string>())
      : undefined;

  const missingTimes = Array.from(allTimes).filter(ts => {
    if (cache[ts] != null) {
      return false;
    }
    if (attemptedSet?.has(`${assetId}:${ts}`)) {
      return false;
    }
    return true;
  });

  const payload: Record<string, Record<number, number>> = {};
  let fetched = 0;
  let requested = 0;
  let stoppedOnFailure = false;
  if (onProgress && missingTimes.length) {
    onProgress({coin, requested: 0, fetched: 0});
  }
  for (const ts of missingTimes) {
    requested++;
    try {
      const historic = await getHistoricFiatRate('USD', coin, String(ts * 1000));
      if (historic?.rate != null) {
        fetched++;
        payload[assetId] = {...(payload[assetId] || {}), [ts]: historic.rate};
      }
    } catch (e) {
      const err = e instanceof Error ? e.message : JSON.stringify(e);
      logManager.error(
        `[portfolio] getHistoricFiatRate grid fetch failed for ${assetId} ts ${ts}: ${err}`,
      );
      stoppedOnFailure = true;
    }
    if (attemptedSet) {
      attemptedSet.add(`${assetId}:${ts}`);
    }
    if (onProgress) {
      onProgress({coin, requested, fetched});
    }
    if (stoppedOnFailure) {
      break;
    }
  }

  if (Object.keys(payload).length) {
    dispatch(setRateCacheUsd({rateCacheUsd: payload}));
  }

  return {requested: missingTimes.length, fetched};
};

export const buildCursorForWalletInterval = (
  walletId: string,
  interval: PortfolioInterval,
  options?: {
    skipPrefill?: boolean;
    prefillOnly?: boolean;
    runToken?: string;
    onPrefillProgress?: (p: {coin: string; requested: number; fetched: number}) => void;
  },
): Effect<
  Promise<{rateRequested: number; rateFetched: number; coin?: string}>
> => async (dispatch, getState) => {
  try {
    const state = getState();
    const events =
      (state.PORTFOLIO.txEventsByWalletId[walletId] as PortfolioTxEvent[] | undefined) ||
      [];
    const assetId = events[0]?.assetId;
    let rateRequested = 0;
    let rateFetched = 0;
    let coin: string | undefined;
    const firstReceiveTimeSec: number | undefined = events.reduce(
      (min: number | undefined, e: PortfolioTxEvent) =>
        e.category === 'receive'
          ? min == null || e.time < min
            ? e.time
            : min
          : min,
      undefined,
    );
    const firstEventTimeSec: number | undefined = events.reduce(
      (min: number | undefined, e: PortfolioTxEvent) =>
        min == null || e.time < min ? e.time : min,
      undefined,
    );
    const startTsForAll = firstReceiveTimeSec ?? firstEventTimeSec;
    if (assetId && !options?.skipPrefill) {
      coin = getCoinFromAssetId(assetId);
      if (coin) {
        const result = await dispatch(
          prefillRatesForIntervals(
            assetId,
            coin,
            ['day', 'week', 'month', '3months', 'year', '5years', 'all'],
            startTsForAll,
            options?.runToken || walletId, // run token per call (default wallet-bound)
          ),
        );
        rateRequested = result?.requested || 0;
        rateFetched = result?.fetched || 0;
      }
    }

    if (options?.prefillOnly) {
      return {rateRequested, rateFetched, coin};
    }

    // Re-read state after potential cache updates from prefill.
    const postPrefillState = getState();
    const assetRateCache = assetId
      ? postPrefillState.PORTFOLIO.rateCacheUsd[assetId] || {}
      : undefined;
    const cursor = buildWalletIntervalCursor(
      walletId,
      interval,
      events,
      assetRateCache,
      startTsForAll,
    );
    dispatch(
      setWalletIntervalCursor({
        walletId,
        interval,
        cursor,
      }),
    );
    return {rateRequested, rateFetched, coin};
  } catch (e) {
    const err = e instanceof Error ? e.message : JSON.stringify(e);
    logManager.error(
      `[portfolio] buildCursorForWalletInterval error for wallet ${walletId} interval ${interval}:`,
      err,
    );
    return {rateRequested: 0, rateFetched: 0};
  }
};
