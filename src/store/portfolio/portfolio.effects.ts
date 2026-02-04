import {Effect, RootState} from '..';
import {Network} from '../../constants';
import {type FiatRateInterval, type Rates} from '../rate/rate.models';
import {fetchFiatRateSeriesInterval, startGetRates} from '../wallet/effects';
import {
  BWS_TX_HISTORY_LIMIT,
  GetTransactionHistory,
} from '../wallet/effects/transactions/transactions';
import {GetPrecision, IsERCToken} from '../wallet/utils/currency';
import type {Wallet} from '../wallet/wallet.models';
import {
  getRateByCurrencyName,
  getErrorString,
  atomicToUnitString,
  unitStringToAtomicBigInt,
} from '../../utils/helper-methods';

import {
  buildBalanceSnapshotsAsync,
  computeBalanceSnapshotComputed,
  extractTxIdFromSnapshotId,
} from '../../core/pnl/snapshots';
import type {BalanceSnapshotStored} from '../../core/pnl/types';
import {getLatestSnapshot} from '../../utils/assets';
import {
  getFiatRateFromSeriesCacheAtTimestamp,
  normalizeFiatRateSeriesCoin,
} from '../../utils/rate';
import {
  finishPopulatePortfolio,
  setSnapshotBalanceMismatchesByWalletIdUpdates,
  setWalletSnapshots,
  startPopulatePortfolio,
  updatePopulateProgress,
} from './portfolio.actions';
import type {
  BalanceSnapshot,
  SnapshotBalanceMismatch,
  WalletPopulateState,
} from './portfolio.models';
import {getWalletIdsToPopulateFromSnapshots} from '../../utils/assets';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NINETY_DAYS_MS = 90 * MS_PER_DAY;

const PORTFOLIO_COMPRESS_OLD_TXS_TO_DAILY_SNAPSHOTS = true;

const PORTFOLIO_ENABLE_INCREMENTAL_UPDATES = true;
const PORTFOLIO_INCREMENTAL_MAX_PAGES = 10;
const PORTFOLIO_INCREMENTAL_RESNAPSHOT_WINDOW_MS = MS_PER_DAY;

const resolveQuoteCurrency = (
  ...candidates: Array<string | undefined>
): string => {
  const candidate = candidates.find(v => typeof v === 'string' && v.length);
  return candidate || 'USD';
};

const isPortfolioEnabled = (state: RootState): boolean =>
  state.APP?.showPortfolioValue !== false;

const createPopulateAbortChecker = (getState: () => RootState) => {
  let cancelled = false;
  return () => {
    if (cancelled) {
      return true;
    }
    const currentState = getState();
    if (!isPortfolioEnabled(currentState)) {
      cancelled = true;
      return true;
    }
    if (!currentState.PORTFOLIO?.populateStatus?.inProgress) {
      cancelled = true;
      return true;
    }
    return false;
  };
};

const addPopulateError = (args: {
  dispatch: any;
  walletId: string;
  message: string;
}) => {
  args.dispatch(
    updatePopulateProgress({
      errorsToAdd: [{walletId: args.walletId, message: args.message}],
    }),
  );
};

const setWalletStatus = (args: {
  dispatch: any;
  walletId: string;
  status: WalletPopulateState;
}) => {
  args.dispatch(
    updatePopulateProgress({
      walletStatusByIdUpdates: {[args.walletId]: args.status},
    }),
  );
};

const updateWalletsCompleted = (args: {
  dispatch: any;
  walletsCompleted: number;
  txRequestsMade: number;
  txsProcessed: number;
}): number => {
  const walletsCompleted = args.walletsCompleted + 1;
  args.dispatch(
    updatePopulateProgress({
      walletsCompleted,
      txRequestsMade: args.txRequestsMade,
      txsProcessed: args.txsProcessed,
    }),
  );
  return walletsCompleted;
};

const getMainnetWalletsFromKeys = (keys: Record<string, any>): Wallet[] => {
  return Object.values(keys || {})
    .flatMap((k: any) => (k?.wallets ? k.wallets : []))
    .filter((w: Wallet) => w?.network === Network.mainnet);
};

const buildSnapshotMismatchUpdate = (args: {
  walletId: string;
  computedAtomic: bigint;
  actualAtomic: bigint;
  unitDecimals: number;
}): SnapshotBalanceMismatch | undefined => {
  if (args.computedAtomic === args.actualAtomic) {
    return undefined;
  }

  const computedUnitsHeld = atomicToUnitString(
    args.computedAtomic,
    args.unitDecimals,
  );
  const currentWalletBalance = atomicToUnitString(
    args.actualAtomic,
    args.unitDecimals,
  );
  const delta = atomicToUnitString(
    args.computedAtomic - args.actualAtomic,
    args.unitDecimals,
  );

  return {
    walletId: args.walletId,
    computedUnitsHeld,
    currentWalletBalance,
    delta,
  };
};

const yieldToEventLoop = async (): Promise<void> => {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
};

const positiveAtomic = (v: bigint): bigint => (v > 0n ? v : 0n);

const getPositiveIncreaseAtomic = (prev: bigint, next: bigint): bigint =>
  positiveAtomic(next) - positiveAtomic(prev);

const getPositiveDecreaseAtomic = (prev: bigint, next: bigint): bigint =>
  positiveAtomic(prev) - positiveAtomic(next);

const applyCostBasisTransition = (args: {
  prevAtomic: bigint;
  nextAtomic: bigint;
  unitDecimals: number;
  direction: 'incoming' | 'outgoing';
  costBasisFiat: number;
  costBasisRateFiat?: number;
}): number => {
  let costBasisFiat = Number.isFinite(args.costBasisFiat)
    ? args.costBasisFiat
    : 0;

  const positiveIncreaseAtomic = getPositiveIncreaseAtomic(
    args.prevAtomic,
    args.nextAtomic,
  );

  if (args.direction === 'incoming') {
    const rateAtTx = args.costBasisRateFiat;
    if (
      typeof rateAtTx === 'number' &&
      Number.isFinite(rateAtTx) &&
      positiveIncreaseAtomic > 0n
    ) {
      const unitsInUnit = parseFloat(
        atomicToUnitString(positiveIncreaseAtomic, args.unitDecimals),
      );
      costBasisFiat += unitsInUnit * rateAtTx;
    }
  } else {
    const positiveDecreaseAtomic = getPositiveDecreaseAtomic(
      args.prevAtomic,
      args.nextAtomic,
    );

    const disposalUnit = parseFloat(
      atomicToUnitString(positiveDecreaseAtomic, args.unitDecimals),
    );
    const unitsHeldUnitBefore = parseFloat(
      atomicToUnitString(args.prevAtomic, args.unitDecimals),
    );
    const avgCostPerUnitBefore =
      unitsHeldUnitBefore > 0 ? costBasisFiat / unitsHeldUnitBefore : 0;

    costBasisFiat -= disposalUnit * avgCostPerUnitBefore;
    if (!Number.isFinite(costBasisFiat) || costBasisFiat < 0) {
      costBasisFiat = 0;
    }
  }

  if (args.nextAtomic <= 0n) {
    costBasisFiat = 0;
  }

  return costBasisFiat;
};

const getAssetIdFromWallet = (wallet: Wallet): string => {
  const chain = (wallet.chain || '').toLowerCase();
  const coin = (wallet.currencyAbbreviation || '').toLowerCase();
  if (wallet.tokenAddress) {
    return `${chain}:${coin}:${wallet.tokenAddress.toLowerCase()}`;
  }
  return `${chain}:${coin}`;
};

const getUtcDayStartMs = (tsMs: number): number => {
  const d = new Date(tsMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

const toFiniteNumber = (value: number | undefined): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

const buildSnapshotBase = (args: {
  wallet: Wallet;
  id: string;
  timestamp: number;
  eventType: BalanceSnapshot['eventType'];
  cryptoBalance: string;
  avgCostFiatPerUnit: number;
  remainingCostBasisFiat: number;
  unrealizedPnlFiat: number;
  quoteCurrency: string;
  dayStartMs?: number;
  txid?: string;
  direction?: BalanceSnapshot['direction'];
  costBasisRateFiat?: number;
  createdAt?: number;
}): BalanceSnapshot => {
  return {
    id: args.id,
    walletId: args.wallet.id,
    chain: args.wallet.chain,
    coin: args.wallet.currencyAbbreviation,
    network: args.wallet.network,
    assetId: getAssetIdFromWallet(args.wallet),
    timestamp: args.timestamp,
    dayStartMs: args.dayStartMs,
    eventType: args.eventType,
    txid: args.txid,
    direction: args.direction,
    cryptoBalance: args.cryptoBalance,
    avgCostFiatPerUnit: toFiniteNumber(args.avgCostFiatPerUnit),
    remainingCostBasisFiat: toFiniteNumber(args.remainingCostBasisFiat),
    unrealizedPnlFiat: toFiniteNumber(args.unrealizedPnlFiat),
    costBasisRateFiat: args.costBasisRateFiat,
    quoteCurrency: args.quoteCurrency.toUpperCase(),
    createdAt: args.createdAt ?? Date.now(),
  };
};

export const maybePopulatePortfolioForWallets =
  (args: {wallets: Wallet[]; quoteCurrency?: string}): Effect<Promise<void>> =>
  async (dispatch, getState) => {
    const state = getState();
    if (!isPortfolioEnabled(state)) {
      return;
    }
    const quoteCurrency = resolveQuoteCurrency(
      args.quoteCurrency,
      state.PORTFOLIO?.quoteCurrency,
      state.APP?.defaultAltCurrency?.isoCode,
    ).toUpperCase();

    const snapshotsByWalletId = state.PORTFOLIO?.snapshotsByWalletId || {};
    const prevMismatchesByWalletId =
      state.PORTFOLIO?.snapshotBalanceMismatchesByWalletId || {};

    const walletsScope = Array.isArray(args.wallets) ? args.wallets : [];
    if (!walletsScope.length) {
      return;
    }

    const {walletIdsToPopulate, snapshotBalanceMismatchUpdates} =
      getWalletIdsToPopulateFromSnapshots({
        wallets: walletsScope,
        snapshotsByWalletId,
        previousSnapshotBalanceMismatchesByWalletId: prevMismatchesByWalletId,
      });

    if (Object.keys(snapshotBalanceMismatchUpdates).length) {
      dispatch(
        setSnapshotBalanceMismatchesByWalletIdUpdates(
          snapshotBalanceMismatchUpdates,
        ),
      );
    }

    if (state.PORTFOLIO?.populateStatus?.inProgress) {
      return;
    }

    if (walletIdsToPopulate.length) {
      dispatch(
        populatePortfolio({
          quoteCurrency,
          walletIds: walletIdsToPopulate,
        }) as any,
      );
    }
  };

const getBestRateIntervalForTimestamp = (args: {
  timestampMs: number;
  nowMs: number;
}): FiatRateInterval => {
  const ageMs = args.nowMs - args.timestampMs;
  if (ageMs >= NINETY_DAYS_MS) {
    return 'ALL';
  }
  if (ageMs <= MS_PER_DAY) {
    return '1D';
  }
  if (ageMs <= 7 * MS_PER_DAY) {
    return '1W';
  }
  if (ageMs <= 30 * MS_PER_DAY) {
    return '1M';
  }
  return '3M';
};

const toSafeIntString = (v: unknown): string => {
  if (typeof v === 'bigint') {
    return v.toString();
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) {
      return '0';
    }
    return v.toLocaleString('fullwide', {
      useGrouping: false,
      maximumFractionDigits: 0,
    });
  }
  if (typeof v === 'string') {
    return v;
  }
  return '0';
};

const toBigInt = (v: unknown): bigint => {
  try {
    const s = toSafeIntString(v);
    if (!s) {
      return 0n;
    }
    if (s.includes('.')) {
      return BigInt(s.split('.')[0]);
    }
    return BigInt(s);
  } catch {
    return 0n;
  }
};

const getWalletBalanceAtomic = (
  wallet: Wallet,
  unitDecimals: number,
): {atomic: bigint; unitString: string} => {
  const sat = wallet.balance?.sat;
  if (typeof sat === 'number' && Number.isFinite(sat) && sat >= 0) {
    const truncated = Math.trunc(sat);
    if (truncated === sat) {
      const atomic = BigInt(truncated);
      return {
        atomic,
        unitString: atomicToUnitString(atomic, unitDecimals),
      };
    }
  }

  const crypto = wallet.balance?.crypto;
  const unitString = typeof crypto === 'string' ? crypto : '0';
  return {
    atomic: unitStringToAtomicBigInt(unitString, unitDecimals),
    unitString,
  };
};

const getTxTimestampMs = (tx: any): number | undefined => {
  const raw =
    (tx as any)?.__portfolioTimestampMs ??
    tx?.time ??
    tx?.createdOn ??
    tx?.ts ??
    tx?.timestamp ??
    tx?.createdTime ??
    tx?.blockTime ??
    tx?.block_time ??
    tx?.blockTimeNormalized ??
    tx?.block_time_normalized;

  const n = (() => {
    if (typeof raw === 'number') {
      return raw;
    }
    if (typeof raw === 'string') {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
      const dateParsed = Date.parse(raw);
      return Number.isFinite(dateParsed) ? dateParsed : undefined;
    }
    return undefined;
  })();

  if (typeof n !== 'number' || !Number.isFinite(n)) {
    return undefined;
  }

  // If Date.parse returned ms, n will already be in ms.
  // Otherwise heuristic: treat large values as ms, otherwise seconds.
  return n > 1e12 ? n : n * 1000;
};

const sortByTimestampThenId = <T>(args: {
  items: T[];
  getTimestamp: (item: T) => number;
  getId: (item: T) => string;
}): T[] => {
  return [...args.items].sort((a, b) => {
    const aTs = args.getTimestamp(a) || 0;
    const bTs = args.getTimestamp(b) || 0;
    if (aTs !== bTs) {
      return aTs - bTs;
    }
    return args.getId(a).localeCompare(args.getId(b));
  });
};

const getTxTokenAmountAtomic = (wallet: Wallet, tx: any): bigint => {
  const effects = Array.isArray(tx?.effects) ? tx.effects : [];
  if (!effects.length || !wallet.tokenAddress) {
    return 0n;
  }
  const contract = wallet.tokenAddress.toLowerCase();
  const isReceived = tx?.action === 'received';
  const walletAddr = (wallet.receiveAddress || '').toLowerCase();

  return effects
    .filter((e: any) => {
      const effectContract = (e?.contractAddress || '').toLowerCase();
      if (effectContract !== contract) {
        return false;
      }
      if (!walletAddr) {
        return true;
      }
      if (isReceived) {
        return (e?.to || '').toLowerCase() === walletAddr;
      }
      return (e?.from || '').toLowerCase() === walletAddr;
    })
    .reduce((acc: bigint, e: any) => {
      return acc + toBigInt(e?.amount);
    }, 0n);
};

const getTxAmountAtomic = (wallet: Wallet, tx: any): bigint => {
  const isTokenWallet = IsERCToken(wallet.currencyAbbreviation, wallet.chain);

  if (isTokenWallet) {
    const amtFromEffects = getTxTokenAmountAtomic(wallet, tx);
    if (amtFromEffects > 0n) {
      return amtFromEffects;
    }
  }

  const outputs = Array.isArray(tx?.outputs) ? tx.outputs : undefined;
  if (outputs?.length && tx?.action !== 'received') {
    return outputs
      .filter((o: any) => o?.address !== 'false')
      .reduce((acc: bigint, o: any) => acc + toBigInt(o?.amount), 0n);
  }

  return toBigInt(tx?.amount);
};

const getTxFeeAtomic = (wallet: Wallet, tx: any): bigint => {
  const isTokenWallet = IsERCToken(wallet.currencyAbbreviation, wallet.chain);
  if (isTokenWallet) {
    return 0n;
  }

  const gasUsed = tx?.receipt?.gasUsed;
  const effectiveGasPrice = tx?.receipt?.effectiveGasPrice;
  if (gasUsed != null && effectiveGasPrice != null) {
    return toBigInt(gasUsed) * toBigInt(effectiveGasPrice);
  }

  if (tx?.fee != null) {
    return toBigInt(tx.fee);
  }
  if (tx?.fees != null) {
    return toBigInt(tx.fees);
  }

  return 0n;
};

const getCurrentFiatRateNow = (
  allRates: Rates,
  wallet: Wallet,
  quoteCurrency: string,
): number => {
  const ratesPerCurrency = getRateByCurrencyName(
    allRates,
    wallet.currencyAbbreviation,
    wallet.chain,
    wallet.tokenAddress,
  );

  const rateObj = ratesPerCurrency?.find(
    r => r.code === (quoteCurrency || '').toUpperCase(),
  );

  const rate = rateObj && !rateObj.rate ? 0 : rateObj?.rate;
  return typeof rate === 'number' && Number.isFinite(rate) ? rate : 0;
};

const ensureFiatRateSeriesInterval = async (args: {
  dispatch: any;
  fiatCode: string;
  currencyAbbreviation: string;
  interval: FiatRateInterval;
}) => {
  const {dispatch, fiatCode, currencyAbbreviation, interval} = args;
  const coinForCacheCheck = normalizeFiatRateSeriesCoin(currencyAbbreviation);
  await dispatch(
    fetchFiatRateSeriesInterval({
      fiatCode,
      interval,
      coinForCacheCheck,
    }),
  );
};

const ensureFiatRateSeriesIntervalOnce = async (args: {
  dispatch: any;
  loadedIntervals: Set<string>;
  fiatCode: string;
  currencyAbbreviation: string;
  interval: FiatRateInterval;
}) => {
  const {dispatch, loadedIntervals, fiatCode, currencyAbbreviation, interval} =
    args;
  if (loadedIntervals.has(interval)) {
    return;
  }
  loadedIntervals.add(interval);
  await ensureFiatRateSeriesInterval({
    dispatch,
    fiatCode,
    currencyAbbreviation,
    interval,
  });
};

const ensureRateSeriesForTimestamp = async (args: {
  dispatch: any;
  loadedIntervals: Set<string>;
  fiatCode: string;
  currencyAbbreviation: string;
  timestampMs: number;
  nowMs: number;
}): Promise<FiatRateInterval> => {
  const interval = getBestRateIntervalForTimestamp({
    timestampMs: args.timestampMs,
    nowMs: args.nowMs,
  });
  await ensureFiatRateSeriesIntervalOnce({
    dispatch: args.dispatch,
    loadedIntervals: args.loadedIntervals,
    fiatCode: args.fiatCode,
    currencyAbbreviation: args.currencyAbbreviation,
    interval,
  });
  return interval;
};

const getHistoricFiatRateFromCache = (args: {
  getState: () => RootState;
  fiatCode: string;
  currencyAbbreviation: string;
  interval: FiatRateInterval;
  timestampMs: number;
}): number | undefined => {
  const {getState, fiatCode, currencyAbbreviation, interval, timestampMs} =
    args;
  const cache = getState().RATE.fiatRateSeriesCache;
  return getFiatRateFromSeriesCacheAtTimestamp({
    fiatRateSeriesCache: cache,
    fiatCode,
    currencyAbbreviation,
    interval,
    timestampMs,
    method: 'nearest',
  });
};

const getHistoricRateOrReportError = (args: {
  getState: () => RootState;
  dispatch: any;
  walletId: string;
  fiatCode: string;
  currencyAbbreviation: string;
  interval: FiatRateInterval;
  timestampMs: number;
}): number | undefined => {
  const rateAtTx = getHistoricFiatRateFromCache({
    getState: args.getState,
    fiatCode: args.fiatCode,
    currencyAbbreviation: args.currencyAbbreviation,
    interval: args.interval,
    timestampMs: args.timestampMs,
  });
  if (typeof rateAtTx === 'number' && Number.isFinite(rateAtTx)) {
    return rateAtTx;
  }

  addPopulateError({
    dispatch: args.dispatch,
    walletId: args.walletId,
    message: `Missing historic rate for ${args.currencyAbbreviation} @ ${args.timestampMs}`,
  });
  return undefined;
};

export const populatePortfolio =
  (args?: {
    quoteCurrency?: string;
    walletIds?: string[];
  }): Effect<Promise<void>> =>
  async (dispatch, getState) => {
    const state = getState();
    if (!isPortfolioEnabled(state)) {
      return;
    }
    if (state.PORTFOLIO?.populateStatus?.inProgress) {
      return;
    }
    const quoteCurrency = resolveQuoteCurrency(
      args?.quoteCurrency,
      state.APP?.defaultAltCurrency?.isoCode,
    );

    const keys = state.WALLET?.keys || {};
    const wallets = getMainnetWalletsFromKeys(keys);

    const walletIdsFilter = Array.isArray(args?.walletIds)
      ? new Set(args?.walletIds)
      : undefined;
    const walletsToPopulate = walletIdsFilter
      ? wallets.filter(w => walletIdsFilter.has(w.id))
      : wallets;

    if (!walletsToPopulate.length) {
      return;
    }

    dispatch(startPopulatePortfolio({quoteCurrency}));
    const shouldAbort = createPopulateAbortChecker(getState);

    dispatch(updatePopulateProgress({walletsTotal: walletsToPopulate.length}));

    const allRates = await dispatch(startGetRates({}));

    if (shouldAbort()) {
      return;
    }

    let walletsCompleted = 0;
    let txRequestsMade = 0;
    let txsProcessed = 0;

    const bumpTxRequestsMade = () => {
      txRequestsMade++;
      dispatch(updatePopulateProgress({txRequestsMade}));
    };

    const bumpTxsProcessed = () => {
      txsProcessed++;
      if (txsProcessed % 100 === 0) {
        dispatch(updatePopulateProgress({txsProcessed}));
      }
    };

    const processWallet = async (wallet: Wallet) => {
      if (shouldAbort()) {
        return;
      }
      dispatch(updatePopulateProgress({currentWalletId: wallet.id}));
      setWalletStatus({dispatch, walletId: wallet.id, status: 'in_progress'});

      try {
        const precision =
          dispatch(
            GetPrecision(
              wallet.currencyAbbreviation,
              wallet.chain,
              wallet.tokenAddress,
            ),
          ) || undefined;
        const unitDecimals = precision?.unitDecimals || 0;

        const portfolioState = getState().PORTFOLIO;
        const existingSnapshotsRaw =
          portfolioState.snapshotsByWalletId?.[wallet.id] || [];
        const existingSnapshots = Array.isArray(existingSnapshotsRaw)
          ? existingSnapshotsRaw
          : [];
        const existingQuoteCurrency = (
          (existingSnapshots?.[0]?.quoteCurrency as string | undefined) || ''
        ).toUpperCase();
        const targetQuoteCurrency = (quoteCurrency || '').toUpperCase();

        const snapshotsLookLikeHarness =
          Array.isArray(existingSnapshots) &&
          existingSnapshots.length > 0 &&
          typeof existingSnapshots[0]?.id === 'string' &&
          (existingSnapshots[0].id.startsWith('tx:') ||
            existingSnapshots[0].id.startsWith('daily:'));

        const incrementalEligible =
          PORTFOLIO_ENABLE_INCREMENTAL_UPDATES &&
          snapshotsLookLikeHarness &&
          existingQuoteCurrency === targetQuoteCurrency;
        const seedSnapshot = incrementalEligible
          ? getLatestSnapshot(existingSnapshots)
          : undefined;

        const currentFiatRateNow = getCurrentFiatRateNow(
          allRates,
          wallet,
          quoteCurrency,
        );

        if (!currentFiatRateNow) {
          addPopulateError({
            dispatch,
            walletId: wallet.id,
            message: `Missing current rate for ${wallet.currencyAbbreviation}`,
          });
        }

        let loadMore = true;
        let iters = 0;
        let acc: any[] = [];

        const incrementalResnapshotCutoffMs = incrementalEligible
          ? Date.now() - PORTFOLIO_INCREMENTAL_RESNAPSHOT_WINDOW_MS
          : undefined;

        while (loadMore) {
          if (shouldAbort()) {
            return;
          }
          const result = await dispatch(
            GetTransactionHistory({
              wallet,
              transactionsHistory: acc,
              limit: BWS_TX_HISTORY_LIMIT,
              refresh: iters === 0,
              contactList: [],
              isAccountDetailsView: true,
              skipWalletProcessing: true,
              skipUiFriendlyList: true,
            }),
          );
          bumpTxRequestsMade();
          acc = result?.transactions || acc;
          loadMore = !!result?.loadMore;
          iters++;

          if (iters % 2 === 0) {
            await yieldToEventLoop();
          }

          if (typeof incrementalResnapshotCutoffMs === 'number') {
            let oldestTs = Number.POSITIVE_INFINITY;
            for (const t of acc) {
              const ts = getTxTimestampMs(t);
              if (typeof ts === 'number' && Number.isFinite(ts)) {
                if (ts < oldestTs) {
                  oldestTs = ts;
                }
              }
            }
            if (oldestTs <= incrementalResnapshotCutoffMs) {
              break;
            }
            if (iters >= PORTFOLIO_INCREMENTAL_MAX_PAGES) {
              break;
            }
          }
        }

        const uniqByTxid: Record<string, any> = {};
        for (const tx of acc) {
          const txid = tx?.txid;
          if (!txid || typeof txid !== 'string') {
            continue;
          }
          if (!uniqByTxid[txid]) {
            uniqByTxid[txid] = tx;
          }
        }

        const nowMsForMissingTs = Date.now();
        for (const tx of Object.values(uniqByTxid)) {
          if (!tx) {
            continue;
          }
          const ts = getTxTimestampMs(tx);
          if (!ts) {
            const confRaw = (tx as any)?.confirmations;
            const confNum =
              typeof confRaw === 'number' ? confRaw : Number(confRaw);
            if (!Number.isFinite(confNum) || confNum <= 0) {
              (tx as any).__portfolioTimestampMs = nowMsForMissingTs;
            }
          }
        }

        const txs = sortByTimestampThenId({
          items: Object.values(uniqByTxid).filter(tx => tx),
          getTimestamp: tx => getTxTimestampMs(tx) || 0,
          getId: tx => (typeof tx?.txid === 'string' ? tx.txid : ''),
        });

        await yieldToEventLoop();

        if (!txs.length) {
          if (existingSnapshots.length) {
            const latestExisting = getLatestSnapshot(existingSnapshots);
            const walletBalance = getWalletBalanceAtomic(wallet, unitDecimals);
            const snapAtomic = unitStringToAtomicBigInt(
              typeof (latestExisting as any)?.cryptoBalance === 'string'
                ? (latestExisting as any).cryptoBalance
                : '0',
              unitDecimals,
            );
            const mismatchUpdate = buildSnapshotMismatchUpdate({
              walletId: wallet.id,
              computedAtomic: snapAtomic,
              actualAtomic: walletBalance.atomic,
              unitDecimals,
            });
            dispatch(
              setSnapshotBalanceMismatchesByWalletIdUpdates({
                [wallet.id]: mismatchUpdate,
              }),
            );
          }
          setWalletStatus({dispatch, walletId: wallet.id, status: 'done'});
          walletsCompleted = updateWalletsCompleted({
            dispatch,
            walletsCompleted,
            txRequestsMade,
            txsProcessed,
          });
          return;
        }

        // Build snapshots using the shared PnL harness snapshot engine.
        let unitsHeldAtomic = 0n;
        let snapshots: BalanceSnapshot[] = [];

        // If we already have harness-based snapshots for this wallet, we can do an
        // incremental rebuild of just the most recent window.
        let latestSnapshotForEngine: BalanceSnapshotStored | undefined;
        let preservedSnapshots: BalanceSnapshot[] = [];
        let txsToProcess: any[] = txs;

        if (incrementalEligible && seedSnapshot) {
          const cutoffMs =
            Date.now() - PORTFOLIO_INCREMENTAL_RESNAPSHOT_WINDOW_MS;

          // Preserve everything strictly before the cutoff and use the last
          // snapshot before cutoff as the engine seed.
          const seedForWindow = (existingSnapshots || []).reduce(
            (best: BalanceSnapshot | undefined, s: BalanceSnapshot) => {
              const ts = s?.timestamp || 0;
              if (!ts || ts >= cutoffMs) {
                return best;
              }

              const bestTs = best?.timestamp || 0;
              if (!best || ts > bestTs) {
                return s;
              }

              if (ts === bestTs) {
                const bestCreatedAt = best?.createdAt || 0;
                const createdAt = s?.createdAt || 0;
                if (createdAt > bestCreatedAt) {
                  return s;
                }
                if (createdAt === bestCreatedAt) {
                  const bestId = best?.id || '';
                  const id = s?.id || '';
                  if (id > bestId) {
                    return s;
                  }
                }
              }

              return best;
            },
            undefined,
          );

          if (seedForWindow) {
            preservedSnapshots = (existingSnapshots || []).filter(s => {
              const ts = (s?.timestamp || 0) as number;
              return ts > 0 && ts < cutoffMs;
            });

            latestSnapshotForEngine = {
              id: seedForWindow.id,
              walletId: seedForWindow.walletId,
              chain: seedForWindow.chain,
              coin: seedForWindow.coin,
              network: seedForWindow.network,
              assetId: seedForWindow.assetId,
              timestamp: seedForWindow.timestamp,
              eventType: seedForWindow.eventType,
              txIds: (seedForWindow as any).txIds,
              cryptoBalance: unitStringToAtomicBigInt(
                seedForWindow.cryptoBalance || '0',
                unitDecimals,
              ).toString(),
              remainingCostBasisFiat: Number.isFinite(
                seedForWindow.remainingCostBasisFiat,
              )
                ? seedForWindow.remainingCostBasisFiat
                : 0,
              quoteCurrency: seedForWindow.quoteCurrency,
              markRate:
                typeof seedForWindow.costBasisRateFiat === 'number' &&
                Number.isFinite(seedForWindow.costBasisRateFiat)
                  ? seedForWindow.costBasisRateFiat
                  : 0,
              createdAt: seedForWindow.createdAt,
            };

            // Only process txs from the seed timestamp forward.
            txsToProcess = txs.filter(
              (t: any) => (getTxTimestampMs(t) || 0) >= seedForWindow.timestamp,
            );
          }
        }

        // Fetch any fiat rate series intervals we’ll need for tx timestamps.
        const loadedIntervals = new Set<string>();
        const nowMs = nowMsForMissingTs;
        const neededIntervals = new Set<FiatRateInterval>();
        for (const tx of txsToProcess) {
          const timestampMs = getTxTimestampMs(tx);
          if (!timestampMs) {
            continue;
          }
          neededIntervals.add(
            getBestRateIntervalForTimestamp({timestampMs, nowMs}),
          );
        }
        for (const interval of neededIntervals) {
          await ensureFiatRateSeriesIntervalOnce({
            dispatch,
            loadedIntervals,
            fiatCode: quoteCurrency,
            currencyAbbreviation: wallet.currencyAbbreviation,
            interval,
          });
        }

        if (shouldAbort()) {
          return;
        }

        const walletSummary = {
          id: wallet.id,
          name: wallet.name,
          chain: wallet.chain,
          currencyAbbreviation: wallet.currencyAbbreviation,
          network: wallet.network,
          tokenAddress: wallet.tokenAddress,
        };

        const credentials: any = {
          chain: String(wallet.chain || '').toLowerCase(),
          coin: String(wallet.currencyAbbreviation || '').toLowerCase(),
          network: wallet.network,
        };
        if (wallet.tokenAddress) {
          credentials.token = {
            address: wallet.tokenAddress,
            decimals: unitDecimals,
          };
        }

        const fiatRateSeriesCache = getState().RATE?.fiatRateSeriesCache || {};

        let lastProgress = 0;
        const storedSnaps = await buildBalanceSnapshotsAsync({
          wallet: walletSummary as any,
          credentials,
          txs: txsToProcess,
          quoteCurrency,
          fiatRateSeriesCache: fiatRateSeriesCache as any,
          latestSnapshot: latestSnapshotForEngine,
          compression: {enabled: PORTFOLIO_COMPRESS_OLD_TXS_TO_DAILY_SNAPSHOTS},
          nowMs,
          onProgress: p => {
            const next = typeof p?.txsProcessed === 'number' ? p.txsProcessed : 0;
            const delta = next - lastProgress;
            if (delta > 0) {
              bumpTxsProcessed(delta);
              lastProgress = next;
            }
          },
        });

        // Ensure our global tx processed counter catches up if onProgress didn't
        // fire at the end.
        if (lastProgress < txsToProcess.length) {
          bumpTxsProcessed(txsToProcess.length - lastProgress);
        }

        const mappedNew: BalanceSnapshot[] = storedSnaps.map(s => {
          const computed = computeBalanceSnapshotComputed(s, credentials);
          const txid =
            s.eventType === 'tx'
              ? extractTxIdFromSnapshotId(s.id) ?? undefined
              : undefined;
          const balanceDeltaAtomic =
            s.eventType === 'tx' ? BigInt(computed.balanceDeltaAtomic) : 0n;
          const direction =
            s.eventType === 'tx'
              ? balanceDeltaAtomic > 0n
                ? 'incoming'
                : balanceDeltaAtomic < 0n
                ? 'outgoing'
                : undefined
              : undefined;

          return {
            id: s.id,
            walletId: s.walletId,
            chain: s.chain,
            coin: s.coin,
            network: s.network,
            assetId: s.assetId,
            timestamp: s.timestamp,
            dayStartMs:
              s.eventType === 'daily' ? getUtcDayStartMs(s.timestamp) : undefined,
            eventType: s.eventType,
            txid,
            txIds: s.txIds,
            direction,
            cryptoBalance: computed.formattedCryptoBalance,
            avgCostFiatPerUnit: computed.avgCostFiatPerUnit,
            remainingCostBasisFiat: s.remainingCostBasisFiat,
            unrealizedPnlFiat: computed.unrealizedPnlFiat,
            costBasisRateFiat: s.markRate,
            quoteCurrency: s.quoteCurrency,
            createdAt: s.createdAt,
          };
        });

        snapshots = preservedSnapshots.length
          ? preservedSnapshots.concat(mappedNew)
          : mappedNew;

        // Compute the final atomic balance for mismatch detection.
        if (storedSnaps.length) {
          unitsHeldAtomic = BigInt(storedSnaps[storedSnaps.length - 1].cryptoBalance);
        } else if (latestSnapshotForEngine) {
          unitsHeldAtomic = BigInt(latestSnapshotForEngine.cryptoBalance);
        } else if (preservedSnapshots.length) {
          const lastPreserved = preservedSnapshots[preservedSnapshots.length - 1];
          unitsHeldAtomic = unitStringToAtomicBigInt(
            lastPreserved.cryptoBalance || '0',
            unitDecimals,
          );
        } else {
          unitsHeldAtomic = 0n;
        }


        if (shouldAbort()) {
          return;
        }

        if (snapshots.length) {
          dispatch(setWalletSnapshots({walletId: wallet.id, snapshots}));
        }

        if (shouldAbort()) {
          return;
        }

        const walletBalance = getWalletBalanceAtomic(wallet, unitDecimals);
        const mismatchUpdate = buildSnapshotMismatchUpdate({
          walletId: wallet.id,
          computedAtomic: unitsHeldAtomic,
          actualAtomic: walletBalance.atomic,
          unitDecimals,
        });
        dispatch(
          setSnapshotBalanceMismatchesByWalletIdUpdates({
            [wallet.id]: mismatchUpdate,
          }),
        );
        setWalletStatus({dispatch, walletId: wallet.id, status: 'done'});
        walletsCompleted = updateWalletsCompleted({
          dispatch,
          walletsCompleted,
          txRequestsMade,
          txsProcessed,
        });
      } catch (e) {
        const msg = getErrorString(e);
        addPopulateError({dispatch, walletId: wallet.id, message: msg});
        setWalletStatus({dispatch, walletId: wallet.id, status: 'error'});
        walletsCompleted = updateWalletsCompleted({
          dispatch,
          walletsCompleted,
          txRequestsMade,
          txsProcessed,
        });
      }
    };

    const concurrency = Math.min(3, walletsToPopulate.length);
    let nextIndex = 0;
    const workers = new Array(concurrency).fill(null).map(async () => {
      while (nextIndex < walletsToPopulate.length) {
        if (shouldAbort()) {
          return;
        }
        const wallet = walletsToPopulate[nextIndex];
        nextIndex++;
        await processWallet(wallet);
      }
    });

    await Promise.all(workers);

    if (shouldAbort()) {
      return;
    }
    dispatch(updatePopulateProgress({txRequestsMade, txsProcessed}));
    dispatch(finishPopulatePortfolio({finishedAt: Date.now()}));
  };

export const recalculatePortfolioFiatFields =
  (args?: {quoteCurrency?: string}): Effect<Promise<void>> =>
  async (dispatch, getState) => {
    const state = getState();
    if (!isPortfolioEnabled(state)) {
      return;
    }
    if (state.PORTFOLIO?.populateStatus?.inProgress) {
      return;
    }
    const quoteCurrency = resolveQuoteCurrency(
      args?.quoteCurrency,
      state.APP?.defaultAltCurrency?.isoCode,
    );
    const targetQuoteCurrency = (quoteCurrency || '').toUpperCase();

    dispatch(startPopulatePortfolio({quoteCurrency: targetQuoteCurrency}));
    const shouldAbort = createPopulateAbortChecker(getState);

    const keys = state.WALLET?.keys || {};
    const wallets = getMainnetWalletsFromKeys(keys);

    dispatch(updatePopulateProgress({walletsTotal: wallets.length}));

    const allRates = await dispatch(startGetRates({}));

    if (shouldAbort()) {
      return;
    }

    let walletsCompleted = 0;
    let txRequestsMade = 0;
    let txsProcessed = 0;

    const bumpTxsProcessed = (n: number) => {
      txsProcessed += n;
      if (txsProcessed % 200 === 0) {
        dispatch(updatePopulateProgress({txsProcessed}));
      }
    };

    const processWallet = async (wallet: Wallet) => {
      if (shouldAbort()) {
        return;
      }
      dispatch(updatePopulateProgress({currentWalletId: wallet.id}));
      setWalletStatus({dispatch, walletId: wallet.id, status: 'in_progress'});

      try {
        const portfolioState = getState().PORTFOLIO;
        const existingSnapshots =
          portfolioState.snapshotsByWalletId?.[wallet.id] || [];

        if (!Array.isArray(existingSnapshots) || !existingSnapshots.length) {
          setWalletStatus({dispatch, walletId: wallet.id, status: 'done'});
          walletsCompleted = updateWalletsCompleted({
            dispatch,
            walletsCompleted,
            txRequestsMade,
            txsProcessed,
          });
          return;
        }

        const existingQuoteCurrency = (
          (existingSnapshots?.[0]?.quoteCurrency as string | undefined) || ''
        ).toUpperCase();

        if (existingQuoteCurrency === targetQuoteCurrency) {
          setWalletStatus({dispatch, walletId: wallet.id, status: 'done'});
          walletsCompleted = updateWalletsCompleted({
            dispatch,
            walletsCompleted,
            txRequestsMade,
            txsProcessed,
          });
          return;
        }

        const precision =
          dispatch(
            GetPrecision(
              wallet.currencyAbbreviation,
              wallet.chain,
              wallet.tokenAddress,
            ),
          ) || undefined;
        const unitDecimals = precision?.unitDecimals || 0;

        const currentFiatRateNow = getCurrentFiatRateNow(
          allRates,
          wallet,
          targetQuoteCurrency,
        );

        if (!currentFiatRateNow) {
          addPopulateError({
            dispatch,
            walletId: wallet.id,
            message: `Missing current fiat rate for ${wallet.currencyAbbreviation} @ ${targetQuoteCurrency}`,
          });
        }

        const txSnapshots = (existingSnapshots || []).filter(
          s => s?.eventType === 'tx',
        );

        const orderedTxSnapshots = sortByTimestampThenId({
          items: txSnapshots,
          getTimestamp: s => s?.timestamp || 0,
          getId: s => (typeof s?.txid === 'string' ? s.txid : ''),
        });

        let prevAtomic = 0n;
        let costBasisFiat = 0;
        let finalAtomic = 0n;
        let finalCostBasisFiat = 0;
        const updatedById = new Map<string, Partial<BalanceSnapshot>>();
        const loadedIntervals = new Set<string>();

        for (let i = 0; i < orderedTxSnapshots.length; i++) {
          if (shouldAbort()) {
            return;
          }
          const s = orderedTxSnapshots[i];
          const timestampMs =
            typeof s?.timestamp === 'number' ? s.timestamp : 0;
          const currentAtomic = unitStringToAtomicBigInt(
            s.cryptoBalance || '0',
            unitDecimals,
          );
          const isIncoming = s.direction === 'incoming';

          let costBasisRateFiat: number | undefined;
          const nowMsForTx = Date.now();
          const interval = await ensureRateSeriesForTimestamp({
            dispatch,
            loadedIntervals,
            fiatCode: targetQuoteCurrency,
            currencyAbbreviation: wallet.currencyAbbreviation,
            timestampMs,
            nowMs: nowMsForTx,
          });

          const positiveIncreaseAtomic = getPositiveIncreaseAtomic(
            prevAtomic,
            currentAtomic,
          );

          if (isIncoming && positiveIncreaseAtomic > 0n) {
            const rateAtTx = getHistoricRateOrReportError({
              getState,
              dispatch,
              walletId: wallet.id,
              fiatCode: targetQuoteCurrency,
              currencyAbbreviation: wallet.currencyAbbreviation,
              interval,
              timestampMs,
            });

            if (typeof rateAtTx === 'number') {
              costBasisRateFiat = rateAtTx;
              costBasisFiat = applyCostBasisTransition({
                prevAtomic,
                nextAtomic: currentAtomic,
                unitDecimals,
                direction: 'incoming',
                costBasisFiat,
                costBasisRateFiat: rateAtTx,
              });
            }
          } else {
            costBasisFiat = applyCostBasisTransition({
              prevAtomic,
              nextAtomic: currentAtomic,
              unitDecimals,
              direction: 'outgoing',
              costBasisFiat,
            });
          }

          prevAtomic = currentAtomic;
          finalAtomic = currentAtomic;
          finalCostBasisFiat = costBasisFiat;

          const unitsHeldUnit = parseFloat(
            atomicToUnitString(currentAtomic, unitDecimals),
          );
          const avgCostFiatPerUnit =
            unitsHeldUnit > 0 ? costBasisFiat / unitsHeldUnit : 0;

          const markRateFiat = getHistoricFiatRateFromCache({
            getState,
            fiatCode: targetQuoteCurrency,
            currencyAbbreviation: wallet.currencyAbbreviation,
            interval,
            timestampMs,
          });
          const markRateFiatEffective =
            typeof markRateFiat === 'number' && Number.isFinite(markRateFiat)
              ? markRateFiat
              : currentFiatRateNow || 0;

          const unrealizedPnlFiat =
            unitsHeldUnit * markRateFiatEffective - costBasisFiat;

          updatedById.set(s.id, {
            avgCostFiatPerUnit: Number.isFinite(avgCostFiatPerUnit)
              ? avgCostFiatPerUnit
              : 0,
            remainingCostBasisFiat: Number.isFinite(costBasisFiat)
              ? costBasisFiat
              : 0,
            unrealizedPnlFiat: Number.isFinite(unrealizedPnlFiat)
              ? unrealizedPnlFiat
              : 0,
            costBasisRateFiat,
            quoteCurrency: targetQuoteCurrency,
          });

          if (i > 0 && i % 10 === 0) {
            await yieldToEventLoop();
          }
        }

        bumpTxsProcessed(orderedTxSnapshots.length);

        const finalUnitsHeldUnit = parseFloat(
          atomicToUnitString(finalAtomic, unitDecimals),
        );

        const updatedSnapshots: BalanceSnapshot[] = [];
        const allExisting = Array.isArray(existingSnapshots)
          ? existingSnapshots
          : [];

        for (let i = 0; i < allExisting.length; i++) {
          if (shouldAbort()) {
            return;
          }
          const s = allExisting[i];
          if (s?.eventType === 'tx') {
            const upd = updatedById.get(s.id);
            updatedSnapshots.push(
              upd ? ({...s, ...upd} as BalanceSnapshot) : s,
            );
          } else {
            const snapAtomic = unitStringToAtomicBigInt(
              s.cryptoBalance || '0',
              unitDecimals,
            );
            const snapUnits = parseFloat(
              atomicToUnitString(snapAtomic, unitDecimals),
            );
            const scaledCostBasis =
              finalUnitsHeldUnit > 0 && snapUnits > 0
                ? finalCostBasisFiat * (snapUnits / finalUnitsHeldUnit)
                : 0;
            const avgCostFiatPerUnit =
              snapUnits > 0 ? scaledCostBasis / snapUnits : 0;

            const timestampMs =
              typeof s?.timestamp === 'number' ? s.timestamp : 0;
            const interval = await ensureRateSeriesForTimestamp({
              dispatch,
              loadedIntervals,
              fiatCode: targetQuoteCurrency,
              currencyAbbreviation: wallet.currencyAbbreviation,
              timestampMs,
              nowMs: Date.now(),
            });
            const markRateFiat = getHistoricFiatRateFromCache({
              getState,
              fiatCode: targetQuoteCurrency,
              currencyAbbreviation: wallet.currencyAbbreviation,
              interval,
              timestampMs,
            });
            const markRateFiatEffective =
              typeof markRateFiat === 'number' && Number.isFinite(markRateFiat)
                ? markRateFiat
                : currentFiatRateNow || 0;

            const unrealizedPnlFiat =
              snapUnits * markRateFiatEffective - scaledCostBasis;

            updatedSnapshots.push({
              ...s,
              avgCostFiatPerUnit: Number.isFinite(avgCostFiatPerUnit)
                ? avgCostFiatPerUnit
                : 0,
              remainingCostBasisFiat: Number.isFinite(scaledCostBasis)
                ? scaledCostBasis
                : 0,
              unrealizedPnlFiat: Number.isFinite(unrealizedPnlFiat)
                ? unrealizedPnlFiat
                : 0,
              costBasisRateFiat: undefined,
              quoteCurrency: targetQuoteCurrency,
            });
          }

          if (i > 0 && i % 50 === 0) {
            await yieldToEventLoop();
          }
        }

        if (shouldAbort()) {
          return;
        }

        dispatch(
          setWalletSnapshots({
            walletId: wallet.id,
            snapshots: updatedSnapshots,
          }),
        );
        setWalletStatus({dispatch, walletId: wallet.id, status: 'done'});
        walletsCompleted = updateWalletsCompleted({
          dispatch,
          walletsCompleted,
          txRequestsMade,
          txsProcessed,
        });
      } catch (e) {
        const msg = getErrorString(e);
        addPopulateError({dispatch, walletId: wallet.id, message: msg});
        setWalletStatus({dispatch, walletId: wallet.id, status: 'error'});
        walletsCompleted = updateWalletsCompleted({
          dispatch,
          walletsCompleted,
          txRequestsMade,
          txsProcessed,
        });
      }
    };

    const concurrency = Math.min(3, wallets.length);
    let nextIndex = 0;
    const workers = new Array(concurrency).fill(null).map(async () => {
      while (nextIndex < wallets.length) {
        if (shouldAbort()) {
          return;
        }
        const wallet = wallets[nextIndex];
        nextIndex++;
        await processWallet(wallet);
      }
    });

    await Promise.all(workers);

    if (shouldAbort()) {
      return;
    }
    dispatch(updatePopulateProgress({txRequestsMade, txsProcessed}));
    dispatch(finishPopulatePortfolio({finishedAt: Date.now()}));
  };
