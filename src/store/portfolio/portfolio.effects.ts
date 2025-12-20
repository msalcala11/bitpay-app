import moment from 'moment';
import {Effect} from '..';
import {Wallet} from '../wallet/wallet.models';
import {
  BWS_TX_HISTORY_LIMIT,
  GetTransactionHistoryFromServer,
} from '../wallet/effects/transactions/transactions';
import {getHistoricFiatRate} from '../wallet/effects/rates/rates';
import {
  resetPortfolio,
  setPortfolioGlobalSync,
  updatePortfolioWalletSync,
} from './portfolio.actions';
import {
  appendWalletTxs,
  PortfolioTx,
  resetWalletTxs,
  readWalletTxs,
  upsertRateMap,
  upsertTxRateMap,
  upsertTsRateMap,
  readRateMap,
  readTxRateMap,
  readTsRateMap,
  readWalletTxMeta,
  resetAllPortfolioStorage,
} from './portfolio.storage';
import {BitpaySupportedTokenOptsByAddress} from '../../constants/tokens';
import {tokenManager} from '../../managers/TokenManager';
import {IsSVMChain} from '../wallet/utils/currency';

type PortfolioInterval = '1D' | '1W' | '1M' | '3M' | '1Y' | '5Y' | 'ALL';

const resolveIntervalWindow = (
  interval: PortfolioInterval,
  firstTxTimeMs?: number,
): {startTs: number; endTs: number; targetPoints: number; isIntraday: boolean} => {
  const now = moment();
  switch (interval) {
    case '1D':
      {
        const end = now.clone().startOf('hour');
        const endTs = end.valueOf();
        return {
          startTs: end.clone().subtract(1, 'day').valueOf(),
          endTs,
          targetPoints: 45,
          isIntraday: true,
        };
      }
    case '1W':
      {
        const end = now.clone().startOf('day');
        const endTs = end.valueOf();
        return {
          startTs: end.clone().subtract(7, 'days').valueOf(),
          endTs,
          targetPoints: 45,
          isIntraday: false,
        };
      }
    case '1M':
      {
        const end = now.clone().startOf('day');
        const endTs = end.valueOf();
        return {
          startTs: end.clone().subtract(30, 'days').valueOf(),
          endTs,
          targetPoints: 45,
          isIntraday: false,
        };
      }
    case '3M':
      {
        const end = now.clone().startOf('day');
        const endTs = end.valueOf();
        return {
          startTs: end.clone().subtract(90, 'days').valueOf(),
          endTs,
          targetPoints: 45,
          isIntraday: false,
        };
      }
    case '1Y':
      {
        const end = now.clone().startOf('day');
        const endTs = end.valueOf();
        return {
          startTs: end.clone().subtract(365, 'days').valueOf(),
          endTs,
          targetPoints: 45,
          isIntraday: false,
        };
      }
    case '5Y':
      {
        const end = now.clone().startOf('day');
        const endTs = end.valueOf();
        return {
          startTs: end.clone().subtract(365 * 5, 'days').valueOf(),
          endTs,
          targetPoints: 45,
          isIntraday: false,
        };
      }
    case 'ALL': {
      const start =
        typeof firstTxTimeMs === 'number'
          ? moment(firstTxTimeMs).startOf('day').valueOf()
          : now.clone().startOf('day').valueOf();

      const end = now.clone().startOf('day');
      const endTs = end.valueOf();
      return {
        startTs: start,
        endTs,
        targetPoints: 45,
        isIntraday: false,
      };
    }
  }
};

const computeSampleDayKeys = (
  interval: PortfolioInterval,
  firstTxTimeMs?: number,
): string[] => {
  const {startTs, endTs, targetPoints} = resolveIntervalWindow(
    interval,
    firstTxTimeMs,
  );

  // Align with chart selector sampling: derive the required dayKeys from the same
  // evenly spaced timestamp sampling (45 points), then dedupe by startOf('day').
  const step = (endTs - startTs) / Math.max(targetPoints - 1, 1);
  const dayKeys = new Set<string>();
  for (let i = 0; i < targetPoints; i++) {
    const ts = Math.round(startTs + step * i);
    dayKeys.add(String(moment(ts).startOf('day').valueOf()));
  }

  // For intraday, this usually collapses to 1-2 days; for longer ranges it yields
  // <= targetPoints distinct day keys.
  return Array.from(dayKeys).sort((a, b) => Number(a) - Number(b));
};

const computeSampleTsKeys = (
  interval: PortfolioInterval,
  firstTxTimeMs?: number,
): string[] => {
  const {startTs, endTs, targetPoints} = resolveIntervalWindow(
    interval,
    firstTxTimeMs,
  );
  const step = (endTs - startTs) / Math.max(targetPoints - 1, 1);
  const sampled: string[] = [];
  for (let i = 0; i < targetPoints; i++) {
    sampled.push(String(Math.round(startTs + step * i)));
  }
  return sampled;
};

const normalizeTxs = (wallet: Wallet, txs: any[]): PortfolioTx[] => {
  return txs
    .filter(t => t && (t.txid || t.id))
    .map(t => {
      const timeMs =
        typeof t.time === 'number'
          ? t.time * 1000
          : typeof t.createdOn === 'number'
          ? t.createdOn * 1000
          : Date.now();
      return {
        txid: t.txid || t.id,
        time: timeMs,
        action: t.action,
        amount: typeof t.amount === 'number' ? t.amount : undefined,
        fees: typeof t.fees === 'number' ? t.fees : undefined,
        fee: typeof t.fee === 'number' ? t.fee : undefined,
        coin: t.coin || wallet.currencyAbbreviation,
        chain: t.chain || wallet.chain,
        tokenAddress: t.tokenAddress || wallet.tokenAddress,
        effects: t.effects,
      };
    });
};

const getRateSymbolForWalletTxs = (
  wallet: Wallet,
  txs: PortfolioTx[],
  customTokenOptionsByAddress: Record<string, any>,
): string => {
  const {tokenOptionsByAddress} = tokenManager.getTokenOptions();
  const tokensOptsByAddress = {
    ...BitpaySupportedTokenOptsByAddress,
    ...tokenOptionsByAddress,
    ...customTokenOptionsByAddress,
  };

  const firstTxWithContract = txs.find(t =>
    IsSVMChain(wallet.chain)
      ? t.tokenAddress
      : typeof t.tokenAddress === 'string' && t.tokenAddress.length > 0,
  );

  const contractAddress = firstTxWithContract?.tokenAddress;

  if (contractAddress) {
    const matchedToken = Object.values(tokensOptsByAddress).find(({address}) => {
      if (IsSVMChain(wallet.chain)) {
        return contractAddress === address;
      }
      return contractAddress.toLowerCase() === address?.toLowerCase();
    });
    if (matchedToken?.symbol) {
      return matchedToken.symbol.toLowerCase();
    }
  }

  switch (wallet.currencyAbbreviation?.toLowerCase()) {
    case 'wbtc':
      return 'btc';
    case 'weth':
      return 'eth';
    default:
      return wallet.currencyAbbreviation?.toLowerCase();
  }
};

export const portfolioClearAllBackfillData =
  (): Effect<Promise<void>> =>
  async dispatch => {
    resetAllPortfolioStorage();
    dispatch(resetPortfolio());
  };

export const portfolioBackfillAllWalletTxs =
  ({
    fiatCode,
    force,
    walletIds,
  }: {
    fiatCode: string;
    force?: boolean;
    walletIds?: string[];
  }): Effect<Promise<void>> =>
  async (dispatch, getState) => {
    const {
      WALLET: {keys},
    } = getState();

    const allWallets: Wallet[] = Object.values(keys as any)
      .flatMap((k: any) => k.wallets)
      .filter(w => typeof w?.id === 'string' && w.isComplete());

    const walletIdSet = walletIds?.length ? new Set(walletIds) : undefined;
    const wallets = walletIdSet
      ? allWallets.filter(w => walletIdSet.has(w.id))
      : allWallets;

    dispatch(
      setPortfolioGlobalSync({
        status: 'syncing',
        startedOn: Date.now(),
        finishedOn: undefined,
        walletsTotal: wallets.length,
        walletsDone: 0,
        currentWalletId: undefined,
        error: undefined,
      }),
    );

    let walletsDone = 0;

    for (const wallet of wallets) {
      try {
        dispatch(
          setPortfolioGlobalSync({
            currentWalletId: wallet.id,
          }),
        );

        dispatch(
          updatePortfolioWalletSync({
            keyId: wallet.keyId,
            walletId: wallet.id,
            status: 'syncing',
            startedOn: Date.now(),
            finishedOn: undefined,
            error: undefined,
            txCount: 0,
            chunkCount: 0,
            txRequestCount: 0,
            rateRequestCount: 0,
            rateDaysTotal: 0,
            rateDaysDone: 0,
          }),
        );

        const existing = force ? [] : readWalletTxs(wallet.id);
        const existingMeta = force
          ? {txCount: 0, chunkCount: 0}
          : readWalletTxMeta(wallet.id);
        const existingSync = getState().PORTFOLIO?.wallets?.[wallet.id];

        if (force) {
          resetWalletTxs(wallet.id);
        } else if (existing.length > 0 && existingSync?.status === 'done') {
          dispatch(
            updatePortfolioWalletSync({
              keyId: wallet.keyId,
              walletId: wallet.id,
              status: 'done',
              finishedOn: Date.now(),
              txCount: existingMeta.txCount,
              chunkCount: existingMeta.chunkCount,
            }),
          );
          walletsDone++;
          dispatch(setPortfolioGlobalSync({walletsDone}));
          continue;
        }

        // Resume if we have partial data; otherwise start fresh.
        if (!force && existing.length === 0) {
          resetWalletTxs(wallet.id);
        }

        dispatch(
          updatePortfolioWalletSync({
            keyId: wallet.keyId,
            walletId: wallet.id,
            txCount: existingMeta.txCount,
            chunkCount: existingMeta.chunkCount,
            txRequestCount: 0,
            rateRequestCount: 0,
            rateDaysTotal: 0,
            rateDaysDone: 0,
          }),
        );

        let skip = existingMeta.txCount;
        let totalSaved = 0;
        let txRequestCount = 0;
        while (true) {
          txRequestCount++;
          dispatch(
            updatePortfolioWalletSync({
              keyId: wallet.keyId,
              walletId: wallet.id,
              txRequestCount,
            }),
          );

          const {transactions, loadMore} = await GetTransactionHistoryFromServer(
            wallet,
            skip,
            null,
            BWS_TX_HISTORY_LIMIT,
          );

          if (!transactions?.length) {
            break;
          }

          const normalized = normalizeTxs(wallet, transactions);
          const meta = appendWalletTxs(wallet.id, normalized);
          totalSaved = meta.txCount;

          dispatch(
            updatePortfolioWalletSync({
              keyId: wallet.keyId,
              walletId: wallet.id,
              txCount: totalSaved,
              chunkCount: meta.chunkCount,
              txRequestCount,
            }),
          );

          skip += transactions.length;
          if (!loadMore) {
            break;
          }
        }

        dispatch(
          updatePortfolioWalletSync({
            keyId: wallet.keyId,
            walletId: wallet.id,
            status: 'done',
            finishedOn: Date.now(),
          }),
        );

        walletsDone++;
        dispatch(setPortfolioGlobalSync({walletsDone}));
      } catch (e: any) {
        const err = e instanceof Error ? e.message : JSON.stringify(e);
        dispatch(
          updatePortfolioWalletSync({
            keyId: wallet.keyId,
            walletId: wallet.id,
            status: 'error',
            finishedOn: Date.now(),
            error: err,
          }),
        );
      }
    }

    dispatch(
      setPortfolioGlobalSync({
        status: 'done',
        finishedOn: Date.now(),
        currentWalletId: undefined,
      }),
    );

    await dispatch(portfolioBackfillHistoricRates({fiatCode, walletIds}));
  };

export const portfolioBackfillHistoricRates =
  ({
    fiatCode,
    walletIds,
  }: {
    fiatCode: string;
    walletIds?: string[];
  }): Effect<Promise<void>> =>
  async (dispatch, getState) => {
    const {
      WALLET: {keys, customTokenOptionsByAddress},
    } = getState();

    const allWallets: Wallet[] = Object.values(keys as any)
      .flatMap((k: any) => k.wallets)
      .filter(w => typeof w?.id === 'string' && w.isComplete());

    const walletIdSet = walletIds?.length ? new Set(walletIds) : undefined;
    const wallets = walletIdSet
      ? allWallets.filter(w => walletIdSet.has(w.id))
      : allWallets;

    for (const wallet of wallets) {
      const walletSync = getState().PORTFOLIO?.wallets?.[wallet.id];
      if (walletSync?.status !== 'done') {
        continue;
      }

      const txs = readWalletTxs(wallet.id);
      if (!txs.length) {
        continue;
      }

      const symbol = getRateSymbolForWalletTxs(
        wallet,
        txs,
        customTokenOptionsByAddress,
      );

      const rateMap = readRateMap(fiatCode, symbol);
      const known: Record<string, number> = {...rateMap};
      const neededDays = new Set<string>();

      const txRateMap = readTxRateMap(fiatCode, symbol);
      const knownTxRates: Record<string, number> = {...txRateMap};
      const neededTxIds = new Set<string>();

      const tsRateMap = readTsRateMap(fiatCode, symbol);
      const knownTsRates: Record<string, number> = {...tsRateMap};
      const neededTsKeys = new Set<string>();

      txs.forEach(tx => {
        const dayTs = moment(tx.time).startOf('day').valueOf();
        const key = String(dayTs);
        if (known[key] == null) {
          neededDays.add(key);
        }

        // Cache exact tx-time rates (txid -> rate) so portfolio computations can use
        // the best-available rate at the time of each transaction.
        const txRateKey = `${tx.chain || wallet.chain}:${tx.txid}`;
        if (knownTxRates[txRateKey] == null) {
          neededTxIds.add(txRateKey);
        }
      });

      const firstTxTimeMs = txs.length
        ? Math.min(...txs.map(t => t.time).filter(t => typeof t === 'number'))
        : undefined;

      const intervals: PortfolioInterval[] = [
        '1D',
        '1W',
        '1M',
        '3M',
        '1Y',
        '5Y',
        'ALL',
      ];

      for (const interval of intervals) {
        const sampleKeys = computeSampleDayKeys(interval, firstTxTimeMs);
        for (const dayKey of sampleKeys) {
          if (known[dayKey] == null) {
            neededDays.add(dayKey);
          }
        }
      }

      // Only backfill timestamp-sampled rates for the 1D interval.
      // Longer intervals use day-level rates for a manageable request volume.
      const tsIntervals: PortfolioInterval[] = ['1D', '1W'];
      for (const tsInterval of tsIntervals) {
        const sampleTsKeys = computeSampleTsKeys(tsInterval, firstTxTimeMs);
        for (const tsKey of sampleTsKeys) {
          if (knownTsRates[tsKey] == null) {
            neededTsKeys.add(tsKey);
          }
        }
      }

      // Fetch exact timestamp rates per txid for accurate cost basis.
      // The /v1/fiatrates endpoint accepts an exact millisecond timestamp.
      const totalRequests = neededDays.size + neededTxIds.size + neededTsKeys.size;

      // Initialize totals so UI can show accurate progress.
      dispatch(
        updatePortfolioWalletSync({
          keyId: wallet.keyId,
          walletId: wallet.id,
          rateDaysTotal: totalRequests,
        }),
      );

      if (neededTxIds.size) {
        const txById: Record<string, PortfolioTx> = {};
        for (const tx of txs) {
          const txRateKey = `${tx.chain || wallet.chain}:${tx.txid}`;
          txById[txRateKey] = tx;
        }

        for (const txid of neededTxIds) {
          const tx = txById[txid];
          if (!tx) {
            continue;
          }

          const walletSync = getState().PORTFOLIO?.wallets?.[wallet.id];
          const nextRateRequestCount = (walletSync?.rateRequestCount ?? 0) + 1;
          const nextRateDaysDone = (walletSync?.rateDaysDone ?? 0) + 1;

          dispatch(
            updatePortfolioWalletSync({
              keyId: wallet.keyId,
              walletId: wallet.id,
              rateDaysTotal: totalRequests,
              rateRequestCount: nextRateRequestCount,
              rateDaysDone: nextRateDaysDone,
            }),
          );

          try {
            const historic = await getHistoricFiatRate(
              fiatCode,
              symbol,
              String(tx.time),
            );
            if (historic?.rate != null) {
              knownTxRates[txid] = historic.rate;
              upsertTxRateMap(fiatCode, symbol, {[txid]: historic.rate});
            }
          } catch (_) {}
        }
      }

      for (const tsKey of neededTsKeys) {
        const walletSync = getState().PORTFOLIO?.wallets?.[wallet.id];
        const nextRateRequestCount = (walletSync?.rateRequestCount ?? 0) + 1;
        const nextRateDaysDone = (walletSync?.rateDaysDone ?? 0) + 1;

        dispatch(
          updatePortfolioWalletSync({
            keyId: wallet.keyId,
            walletId: wallet.id,
            rateDaysTotal: totalRequests,
            rateRequestCount: nextRateRequestCount,
            rateDaysDone: nextRateDaysDone,
          }),
        );

        try {
          const historic = await getHistoricFiatRate(fiatCode, symbol, tsKey);
          if (historic?.rate != null) {
            knownTsRates[tsKey] = historic.rate;
            upsertTsRateMap(fiatCode, symbol, {[tsKey]: historic.rate});
          }
        } catch (_) {}
      }

      for (const dayKey of neededDays) {
        const walletSync = getState().PORTFOLIO?.wallets?.[wallet.id];
        const nextRateRequestCount = (walletSync?.rateRequestCount ?? 0) + 1;
        const nextRateDaysDone = (walletSync?.rateDaysDone ?? 0) + 1;

        dispatch(
          updatePortfolioWalletSync({
            keyId: wallet.keyId,
            walletId: wallet.id,
            rateDaysTotal: totalRequests,
            rateRequestCount: nextRateRequestCount,
            rateDaysDone: nextRateDaysDone,
          }),
        );

        try {
          const historic = await getHistoricFiatRate(
            fiatCode,
            symbol,
            dayKey,
          );
          if (historic?.rate != null) {
            known[dayKey] = historic.rate;
            upsertRateMap(fiatCode, symbol, {[dayKey]: historic.rate});
          }
        } catch (_) {}
      }

    }
  };
