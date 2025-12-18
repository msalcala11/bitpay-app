import moment from 'moment';
import {Effect} from '..';
import {Wallet} from '../wallet/wallet.models';
import {
  BWS_TX_HISTORY_LIMIT,
  GetTransactionHistoryFromServer,
} from '../wallet/effects/transactions/transactions';
import {getHistoricFiatRate} from '../wallet/effects/rates/rates';
import {setPortfolioGlobalSync, updatePortfolioWalletSync} from './portfolio.actions';
import {
  appendWalletTxs,
  PortfolioTx,
  resetWalletTxs,
  readWalletTxs,
  upsertRateMap,
  readRateMap,
  readWalletTxMeta,
} from './portfolio.storage';
import {BitpaySupportedTokenOptsByAddress} from '../../constants/tokens';
import {tokenManager} from '../../managers/TokenManager';
import {IsSVMChain} from '../wallet/utils/currency';

type PortfolioInterval = '1D' | '1W' | '1M' | '3M' | '1Y' | '5Y' | 'ALL';

const resolveIntervalWindow = (
  interval: PortfolioInterval,
  firstTxTimeMs?: number,
): {startTs: number; endTs: number; targetPoints: number; isIntraday: boolean} => {
  const endTs = Date.now();
  const end = moment(endTs);
  switch (interval) {
    case '1D':
      return {
        startTs: end.clone().subtract(1, 'day').valueOf(),
        endTs,
        targetPoints: 45,
        isIntraday: true,
      };
    case '1W':
      return {
        startTs: end.clone().subtract(7, 'days').startOf('day').valueOf(),
        endTs,
        targetPoints: 45,
        isIntraday: false,
      };
    case '1M':
      return {
        startTs: end.clone().subtract(30, 'days').startOf('day').valueOf(),
        endTs,
        targetPoints: 60,
        isIntraday: false,
      };
    case '3M':
      return {
        startTs: end.clone().subtract(90, 'days').startOf('day').valueOf(),
        endTs,
        targetPoints: 90,
        isIntraday: false,
      };
    case '1Y':
      return {
        startTs: end.clone().subtract(365, 'days').startOf('day').valueOf(),
        endTs,
        targetPoints: 180,
        isIntraday: false,
      };
    case '5Y':
      return {
        startTs: end.clone().subtract(365 * 5, 'days').startOf('day').valueOf(),
        endTs,
        targetPoints: 365,
        isIntraday: false,
      };
    case 'ALL': {
      const start =
        typeof firstTxTimeMs === 'number'
          ? moment(firstTxTimeMs).startOf('day').valueOf()
          : end.clone().startOf('day').valueOf();
      return {
        startTs: start,
        endTs,
        targetPoints: 365,
        isIntraday: false,
      };
    }
  }
};

const computeSampleDayKeys = (
  interval: PortfolioInterval,
  firstTxTimeMs?: number,
): string[] => {
  const {startTs, endTs, targetPoints, isIntraday} = resolveIntervalWindow(
    interval,
    firstTxTimeMs,
  );

  if (isIntraday) {
    const a = String(moment(startTs).startOf('day').valueOf());
    const b = String(moment(endTs).startOf('day').valueOf());
    return a === b ? [a] : [a, b];
  }

  const days: number[] = [];
  let cur = moment(startTs).startOf('day');
  const endDay = moment(endTs).startOf('day');
  while (cur.valueOf() <= endDay.valueOf()) {
    days.push(cur.valueOf());
    cur = cur.clone().add(1, 'day');
  }

  const stride = Math.max(1, Math.ceil(days.length / targetPoints));
  const sampled: number[] = [];
  for (let i = 0; i < days.length; i += stride) {
    sampled.push(days[i]);
  }
  if (sampled.length && sampled[sampled.length - 1] !== endDay.valueOf()) {
    sampled.push(endDay.valueOf());
  }

  return sampled.map(d => String(d));
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

      txs.forEach(tx => {
        const dayTs = moment(tx.time).startOf('day').valueOf();
        const key = String(dayTs);
        if (known[key] == null) {
          neededDays.add(key);
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

      for (const dayKey of neededDays) {
        const walletSync = getState().PORTFOLIO?.wallets?.[wallet.id];
        const nextRateRequestCount = (walletSync?.rateRequestCount ?? 0) + 1;
        const nextRateDaysDone = (walletSync?.rateDaysDone ?? 0) + 1;

        dispatch(
          updatePortfolioWalletSync({
            keyId: wallet.keyId,
            walletId: wallet.id,
            rateDaysTotal: neededDays.size,
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
