import {Network} from '../constants';
import type {HomeCarouselConfig} from '../store/app/app.models';
import type {BalanceSnapshot} from '../store/portfolio/portfolio.models';
import type {
  PortfolioPopulateStatus,
  SnapshotBalanceMismatch,
  WalletPopulateState,
} from '../store/portfolio/portfolio.models';
import type {
  FiatRateInterval,
  FiatRateSeriesCache,
  Rates,
} from '../store/rate/rate.models';
import type {Key, Wallet} from '../store/wallet/wallet.models';
import type {SupportedCurrencyOption} from '../constants/SupportedCurrencyOptions';
import {
  BitpaySupportedCoins,
  BitpaySupportedTokens,
} from '../constants/currencies';
import {tokenManager} from '../managers/TokenManager';
import {
  getBaselineTimestampMsForFiatRateTimeframe,
  getFiatRateFromSeriesCacheAtTimestamp,
  getFiatRateSeriesIntervalForTimeframe,
  getWindowMsForFiatRateTimeframe,
} from './rate';
import {
  formatCurrencyAbbreviation,
  formatFiatAmount,
  atomicToUnitString,
  getCurrencyAbbreviation,
  calculatePercentageDifference,
  getChainFromTokenByAddressKey,
  getRateByCurrencyName,
  unitStringToAtomicBigInt,
  getLastDayTimestampStartOfHourMs,
} from './helper-methods';

// PnL engine (lifted from the web harness). Keep these imports path-stable so the
// engine code stays easily portable between RN + web.
import {buildPnlAnalysisSeries, type WalletForAnalysis} from '../core/pnl/analysis';
import type {BalanceSnapshotStored} from '../core/pnl/types';
import {formatBigIntDecimal, parseAtomicToBigint} from '../core/format';

export type GainLossMode = FiatRateInterval;

export type AssetRowItem = {
  key: string;
  currencyAbbreviation: string;
  chain: string;
  tokenAddress?: string;
  name: string;
  cryptoAmount: string;
  fiatAmount: string;
  deltaFiat: string;
  deltaPercent: string;
  isPositive: boolean;
  hasRate: boolean;
  pnlLog?: string;
};

export const sortAssetRowItemsByHasRate = (
  items: AssetRowItem[],
): AssetRowItem[] => {
  return (items || []).slice().sort((a, b) => {
    const ar = a?.hasRate ? 1 : 0;
    const br = b?.hasRate ? 1 : 0;
    return br - ar;
  });
};

export const isStableCoinAssetRowItem = (args: {
  item: AssetRowItem;
  options: SupportedCurrencyOption[];
}): boolean => {
  return getAssetRowItemSupportInfo(args).isStable;
};

export const canNavigateToExchangeRateForAssetRowItem = (args: {
  item: AssetRowItem;
  options: SupportedCurrencyOption[];
}): boolean => {
  const {option, isStable} = getAssetRowItemSupportInfo(args);
  return !isStable && !!option && !!args.item.hasRate;
};

export const getDisplayAssetRowItems = (args: {
  items: AssetRowItem[];
  gainLossMode: GainLossMode;
  options: SupportedCurrencyOption[];
}): AssetRowItem[] => {
  const visible =
    args.gainLossMode === 'ALL'
      ? (args.items || []).filter(item => {
          const {option, isStable} = getAssetRowItemSupportInfo({
            item,
            options: args.options,
          });
          const canNavigate = !!option && !!item.hasRate && !isStable;
          return isStable || canNavigate;
        })
      : args.items;

  return sortAssetRowItemsByHasRate(visible);
};

const getAssetRowItemSupportInfo = (args: {
  item: AssetRowItem;
  options: SupportedCurrencyOption[];
}): {option: SupportedCurrencyOption | undefined; isStable: boolean} => {
  const option = findSupportedCurrencyOptionForAsset({
    options: args.options,
    currencyAbbreviation: args.item.currencyAbbreviation,
    chain: args.item.chain,
    tokenAddress: args.item.tokenAddress,
  });

  if (!option) {
    return {option: undefined, isStable: false};
  }

  const currencyName = getCurrencyAbbreviation(
    option.tokenAddress ? option.tokenAddress : option.currencyAbbreviation,
    option.chain,
  );

  const isStable =
    BitpaySupportedCoins[currencyName]?.properties?.isStableCoin ||
    BitpaySupportedTokens[currencyName]?.properties?.isStableCoin;

  return {option, isStable: !!isStable};
};

const toNumber = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

const pickFirstPositiveRate = (...rates: Array<number | undefined>): number => {
  for (const rate of rates) {
    const num = toNumber(rate);
    if (num > 0) {
      return num;
    }
  }
  return 0;
};

export const getQuoteCurrency = (args: {
  portfolioQuoteCurrency?: string;
  defaultAltCurrencyIsoCode?: string;
}): string => {
  return args.portfolioQuoteCurrency || args.defaultAltCurrencyIsoCode || 'USD';
};

export const hasSnapshotsForWallets = (args: {
  snapshotsByWalletId: {[walletId: string]: BalanceSnapshot[] | undefined};
  wallets: Wallet[] | undefined;
}): boolean => {
  const map = args.snapshotsByWalletId || {};
  for (const w of args.wallets || []) {
    const arr = map[w.id];
    if (Array.isArray(arr) && arr.length) {
      return true;
    }
  }
  return false;
};

export const hasSnapshotsBeforeMsForWallets = (args: {
  snapshotsByWalletId: {[walletId: string]: BalanceSnapshot[] | undefined};
  wallets: Wallet[] | undefined;
  cutoffMs: number;
}): boolean => {
  const map = args.snapshotsByWalletId || {};
  const cutoff = args.cutoffMs;
  for (const w of args.wallets || []) {
    const arr = map[w.id];
    if (!Array.isArray(arr) || !arr.length) {
      continue;
    }
    for (const s of arr) {
      const createdAt = s?.createdAt;
      if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) {
        return true;
      }
      if (createdAt < cutoff) {
        return true;
      }
    }
  }
  return false;
};

export const isPopulateLoadingForWallets = (args: {
  populateStatus: PortfolioPopulateStatus | undefined;
  wallets: Wallet[] | undefined;
}): boolean => {
  const populateStatus = args.populateStatus;
  if (!populateStatus?.inProgress) {
    return false;
  }

  const statusById = populateStatus.walletStatusById || {};
  const currentWalletId = populateStatus.currentWalletId;
  const inScopeWalletIds = new Set<string>([
    ...Object.keys(statusById),
    ...(currentWalletId ? [currentWalletId] : []),
  ]);

  const walletIds = (args.wallets || []).map(w => w.id);
  const relevantWalletIds = walletIds.filter(wid => inScopeWalletIds.has(wid));
  if (!relevantWalletIds.length) {
    return false;
  }

  return relevantWalletIds.some(wid => {
    const s = statusById[wid];
    if (currentWalletId && wid === currentWalletId) {
      return true;
    }
    return s === 'in_progress';
  });
};

export const getPercentageDifferenceFromPercentRatio = (
  percentRatio: number,
): number | null => {
  const pct = percentRatio * 100;
  if (!Number.isFinite(pct)) {
    return null;
  }

  return Number(pct.toFixed(2));
};

export const getLegacyPercentageDifferenceFromTotals = (args: {
  totalBalance: number;
  totalBalanceLastDay: number | undefined;
}): number | null => {
  if (!args.totalBalanceLastDay) {
    return null;
  }

  return calculatePercentageDifference(
    args.totalBalance,
    args.totalBalanceLastDay,
  );
};

export const getKeyLastDayPercentageDifference = (args: {
  totalBalance: number;
  hasSnapshots: boolean;
  hasSnapshotsBeforePopulateStarted: boolean;
  isPopulateLoading: boolean;
  legacyPercentageDifference: number | null;
  portfolioPercentageDifference: number | null;
}): number | null => {
  if (!(args.totalBalance > 0)) {
    return 0;
  }
  if (!args.hasSnapshots) {
    return args.legacyPercentageDifference;
  }

  if (args.isPopulateLoading && !args.hasSnapshotsBeforePopulateStarted) {
    return args.legacyPercentageDifference;
  }

  if (args.portfolioPercentageDifference === null) {
    return args.legacyPercentageDifference;
  }

  return args.portfolioPercentageDifference;
};

const getHiddenKeyIdsFromHomeCarouselConfig = (args: {
  keys: Record<string, Key> | undefined;
  homeCarouselConfig: HomeCarouselConfig[] | undefined;
}): Set<string> => {
  const hidden = new Set<string>();
  const cfg = Array.isArray(args.homeCarouselConfig)
    ? args.homeCarouselConfig
    : [];
  for (const item of cfg) {
    const id = item?.id;
    if (!id || id === 'coinbaseBalanceCard') {
      continue;
    }
    if (item?.show === false && (!args.keys || !!args.keys[id])) {
      hidden.add(id);
    }
  }
  return hidden;
};

export const getVisibleKeysFromKeys = (
  keys: Record<string, Key> | undefined,
  homeCarouselConfig?: HomeCarouselConfig[] | undefined,
): Key[] => {
  const all = Object.values(keys || {}) as Key[];
  if (!homeCarouselConfig?.length) {
    return all;
  }
  const hiddenKeyIds = getHiddenKeyIdsFromHomeCarouselConfig({
    keys,
    homeCarouselConfig,
  });
  if (!hiddenKeyIds.size) {
    return all;
  }
  return all.filter(k => !hiddenKeyIds.has(k.id));
};

export const getVisibleWalletsFromKeys = (
  keys: Record<string, Key> | undefined,
  homeCarouselConfig?: HomeCarouselConfig[] | undefined,
): Wallet[] => {
  const visibleKeys = getVisibleKeysFromKeys(keys, homeCarouselConfig);
  return visibleKeys
    .flatMap(k => (Array.isArray(k.wallets) ? k.wallets : []))
    .filter(w => !w.hideWallet && !w.hideWalletByAccount);
};

const getAssetKeyFromWallet = (wallet: Wallet): string => {
  const chain = ((wallet as any)?.chain || '').toLowerCase();
  const coin = ((wallet as any)?.currencyAbbreviation || '').toLowerCase();
  if (!chain || !coin) {
    return '';
  }
  const tokenAddress = (wallet as any)?.tokenAddress as string | undefined;
  if (tokenAddress) {
    return `${chain}:${coin}:${tokenAddress.toLowerCase()}`;
  }
  return `${chain}:${coin}`;
};

export const buildWalletIdsByAssetGroupKey = (
  wallets: Wallet[] | undefined,
): Record<string, string[]> => {
  const map: Record<string, string[]> = {};
  for (const w of wallets || []) {
    const id = (w as any)?.id as string | undefined;

    if ((w as any)?.network !== Network.mainnet) {
      continue;
    }

    const groupKey = ((w as any)?.currencyAbbreviation || '').toLowerCase();
    if (!id || !groupKey) {
      continue;
    }

    if (!map[groupKey]) {
      map[groupKey] = [];
    }
    map[groupKey].push(id);
  }
  return map;
};

export const isFiatLoadingForWallets = (args: {
  quoteCurrency: string;
  wallets: Wallet[];
  snapshotsByWalletId: {[walletId: string]: BalanceSnapshot[] | undefined};
}): boolean => {
  const target = (args.quoteCurrency || '').toUpperCase();
  if (!target) {
    return false;
  }

  const getLatestByTimestamp = (
    snapshots: BalanceSnapshot[] | undefined,
  ): BalanceSnapshot | undefined => {
    const arr = Array.isArray(snapshots) ? snapshots : [];
    let latest: BalanceSnapshot | undefined;
    for (const s of arr) {
      if (!s) {
        continue;
      }
      if (!latest || (s.timestamp || 0) > (latest.timestamp || 0)) {
        latest = s;
      }
    }
    return latest;
  };

  for (const w of args.wallets) {
    const arr = args.snapshotsByWalletId[w.id] || [];
    const latest = getLatestByTimestamp(arr);
    const snapQuote = (latest?.quoteCurrency || '').toUpperCase();
    if (snapQuote && snapQuote !== target) {
      return true;
    }
  }

  return false;
};

export const findSupportedCurrencyOptionForAsset = (args: {
  options: SupportedCurrencyOption[];
  currencyAbbreviation?: string;
  chain?: string;
  tokenAddress?: string;
}): SupportedCurrencyOption | undefined => {
  const abbr = (args.currencyAbbreviation || '').toLowerCase();
  const chain = (args.chain || '').toLowerCase();
  const tokenAddress = args.tokenAddress;
  const tokenLower = tokenAddress ? tokenAddress.toLowerCase() : undefined;
  const isWildcardChain = chain === abbr && !tokenLower;

  const options = args.options || [];

  const strict = options.find(o => {
    const optAbbr = (o.currencyAbbreviation || '').toLowerCase();
    const optChain = (o.chain || '').toLowerCase();
    const abbrMatches = optAbbr === abbr;
    const chainMatches = isWildcardChain || optChain === chain;
    if (!abbrMatches || !chainMatches) {
      return false;
    }

    if (tokenLower) {
      return (o.tokenAddress || '').toLowerCase() === tokenLower;
    }

    return true;
  });

  if (strict) {
    return strict;
  }

  if (tokenLower) {
    const byTokenAddress = options.find(o => {
      const optAbbr = (o.currencyAbbreviation || '').toLowerCase();
      if (optAbbr !== abbr) {
        return false;
      }
      const optToken = (o.tokenAddress || '').toLowerCase();
      return !!optToken && optToken === tokenLower;
    });
    if (byTokenAddress) {
      return byTokenAddress;
    }
  }

  return options.find(o => {
    const optAbbr = (o.currencyAbbreviation || '').toLowerCase();
    if (optAbbr !== abbr) {
      return false;
    }
    if (tokenLower) {
      return !!o.tokenAddress;
    }
    return true;
  });
};

export const getLatestSnapshot = <T>(
  snapshots: T[] | undefined,
): T | undefined => {
  const arr = Array.isArray(snapshots) ? snapshots : [];
  return arr.length ? arr[arr.length - 1] : undefined;
};

const getWalletUnitInfo = (
  wallet: Wallet,
): {
  unitDecimals: number;
  unitToSatoshi: number;
} => {
  const chain = ((wallet as any)?.chain || '').toLowerCase();
  const tokenAddress = (wallet as any)?.tokenAddress as string | undefined;

  const inferUnitToSatoshiFromLiveBalance = (): number | undefined => {
    const sat = toNumber((wallet as any)?.balance?.sat);
    const cryptoStr = (wallet as any)?.balance?.crypto;
    const crypto = toNumber(
      typeof cryptoStr === 'string' ? cryptoStr.replace(/,/g, '') : cryptoStr,
    );

    if (!(sat > 0) || !(crypto > 0)) {
      return undefined;
    }

    const inferred = sat / crypto;
    if (!Number.isFinite(inferred) || !(inferred > 0)) {
      return undefined;
    }

    const pow10 = Math.pow(10, Math.round(Math.log10(inferred)));
    const nearPow10 =
      Number.isFinite(pow10) && pow10 > 0
        ? Math.abs(inferred - pow10) / pow10 < 0.05
        : false;

    return nearPow10 ? pow10 : inferred;
  };

  if (tokenAddress) {
    const currencyName = getCurrencyAbbreviation(tokenAddress, chain);

    const supportedUnitDecimals =
      BitpaySupportedTokens[currencyName]?.unitInfo?.unitDecimals;
    const supportedUnitToSatoshi =
      BitpaySupportedTokens[currencyName]?.unitInfo?.unitToSatoshi;

    if (
      typeof supportedUnitDecimals === 'number' &&
      typeof supportedUnitToSatoshi === 'number' &&
      supportedUnitToSatoshi > 0
    ) {
      return {
        unitDecimals: supportedUnitDecimals,
        unitToSatoshi: supportedUnitToSatoshi,
      };
    }

    const tokenDataByAddress =
      tokenManager.getTokenOptions().tokenDataByAddress;
    const tokenDataUnitDecimals =
      tokenDataByAddress?.[currencyName]?.unitInfo?.unitDecimals;
    const tokenDataUnitToSatoshi =
      tokenDataByAddress?.[currencyName]?.unitInfo?.unitToSatoshi;

    return {
      unitDecimals:
        typeof tokenDataUnitDecimals === 'number'
          ? tokenDataUnitDecimals
          : typeof supportedUnitDecimals === 'number'
          ? supportedUnitDecimals
          : 0,
      unitToSatoshi:
        typeof tokenDataUnitToSatoshi === 'number' && tokenDataUnitToSatoshi > 0
          ? tokenDataUnitToSatoshi
          : typeof supportedUnitToSatoshi === 'number' &&
            supportedUnitToSatoshi > 0
          ? supportedUnitToSatoshi
          : inferUnitToSatoshiFromLiveBalance() || 1,
    };
  }

  const unitDecimals = BitpaySupportedCoins[chain]?.unitInfo?.unitDecimals;
  const unitToSatoshi = BitpaySupportedCoins[chain]?.unitInfo?.unitToSatoshi;
  return {
    unitDecimals: typeof unitDecimals === 'number' ? unitDecimals : 0,
    unitToSatoshi:
      typeof unitToSatoshi === 'number' && unitToSatoshi > 0
        ? unitToSatoshi
        : 1,
  };
};

const getLiveUnitsForWallet = (wallet: Wallet): number => {
  const unitToSatoshi = getWalletUnitInfo(wallet).unitToSatoshi;
  const liveSat = toNumber((wallet as any)?.balance?.sat);
  const liveUnitsRaw = unitToSatoshi > 0 ? liveSat / unitToSatoshi : 0;
  return liveUnitsRaw > 0 ? liveUnitsRaw : 0;
};

export const getWalletIdsToPopulateFromSnapshots = (args: {
  wallets: Wallet[];
  snapshotsByWalletId: {[walletId: string]: BalanceSnapshot[] | undefined};
  previousSnapshotBalanceMismatchesByWalletId?: {
    [walletId: string]: SnapshotBalanceMismatch | undefined;
  };
}): {
  walletIdsToPopulate: string[];
  snapshotBalanceMismatchUpdates: {
    [walletId: string]: SnapshotBalanceMismatch | undefined;
  };
} => {
  const snapshotsByWalletId = args.snapshotsByWalletId || {};
  const prevMismatchesByWalletId =
    args.previousSnapshotBalanceMismatchesByWalletId || {};

  const snapshotBalanceMismatchUpdates: {
    [walletId: string]: SnapshotBalanceMismatch | undefined;
  } = {};

  const mainnetWalletIdsWithSnapshotBalanceMismatchThatChanged: string[] = [];
  const mainnetWalletIdsMissingSnapshots: string[] = [];

  const mismatchEquals = (
    a: SnapshotBalanceMismatch | undefined,
    b: SnapshotBalanceMismatch | undefined,
  ): boolean => {
    if (!a && !b) {
      return true;
    }
    if (!a || !b) {
      return false;
    }
    return (
      a.walletId === b.walletId &&
      a.computedUnitsHeld === b.computedUnitsHeld &&
      a.currentWalletBalance === b.currentWalletBalance &&
      a.delta === b.delta
    );
  };

  for (const w of args.wallets || []) {
    if (!w?.id || w?.network !== Network.mainnet) {
      continue;
    }

    const snapshots = snapshotsByWalletId?.[w.id];
    const hasSnapshots = Array.isArray(snapshots) && snapshots.length > 0;

    if (!hasSnapshots) {
      const liveSat = ((w as any)?.balance?.sat as number | undefined) || 0;
      if (liveSat > 0) {
        mainnetWalletIdsMissingSnapshots.push(w.id);
      }
      continue;
    }

    const latest = getLatestSnapshot(snapshots);
    if (!latest) {
      continue;
    }

    const unitDecimals = getWalletUnitInfo(w).unitDecimals;
    const snapAtomic = unitStringToAtomicBigInt(
      typeof latest.cryptoBalance === 'string' ? latest.cryptoBalance : '0',
      unitDecimals,
    );

    const liveSat = (w as any)?.balance?.sat;
    const liveAtomic =
      typeof liveSat === 'number' && Number.isFinite(liveSat)
        ? BigInt(Math.trunc(liveSat))
        : unitStringToAtomicBigInt(
            typeof (w as any)?.balance?.crypto === 'string'
              ? (w as any).balance.crypto
              : '0',
            unitDecimals,
          );

    const prevMismatch = prevMismatchesByWalletId[w.id];
    if (liveAtomic !== snapAtomic) {
      const computedUnitsHeld = atomicToUnitString(snapAtomic, unitDecimals);
      const currentWalletBalance = atomicToUnitString(liveAtomic, unitDecimals);
      const deltaAtomic = snapAtomic - liveAtomic;
      const mismatch: SnapshotBalanceMismatch = {
        walletId: w.id,
        computedUnitsHeld,
        currentWalletBalance,
        delta: atomicToUnitString(deltaAtomic, unitDecimals),
      };

      if (!mismatchEquals(prevMismatch, mismatch)) {
        mainnetWalletIdsWithSnapshotBalanceMismatchThatChanged.push(w.id);
        snapshotBalanceMismatchUpdates[w.id] = mismatch;
      }
    } else if (prevMismatch) {
      snapshotBalanceMismatchUpdates[w.id] = undefined;
    }
  }

  return {
    walletIdsToPopulate: Array.from(
      new Set([
        ...mainnetWalletIdsMissingSnapshots,
        ...mainnetWalletIdsWithSnapshotBalanceMismatchThatChanged,
      ]),
    ),
    snapshotBalanceMismatchUpdates,
  };
};

const MAX_PREV1D_BASELINE_AGE_MS = 3 * 24 * 60 * 60 * 1000;

const getSnapshotAtOrBefore = (
  snapshots: BalanceSnapshot[] | undefined,
  cutoffMs: number,
): BalanceSnapshot | undefined => {
  const arr = Array.isArray(snapshots) ? snapshots : [];
  let best: BalanceSnapshot | undefined;
  for (const s of arr) {
    const ts = s?.timestamp || 0;
    if (!ts || ts > cutoffMs) {
      continue;
    }
    if (!best || ts > (best.timestamp || 0)) {
      best = s;
    }
  }
  return best;
};

const buildPortfolioSnapshotContext = (args: {
  wallets: Wallet[];
  snapshotsByWalletId: {[walletId: string]: BalanceSnapshot[] | undefined};
  preferredQuoteCurrency: string;
}): {
  walletById: Map<string, Wallet>;
  effectiveQuoteCurrency: string;
  earliestSnapshotTimestampMs?: number;
} => {
  const snapshotsByWalletId = args.snapshotsByWalletId || {};
  const walletById = buildWalletByIdMap(args.wallets);
  const effectiveQuoteCurrency = getEffectiveQuoteCurrencyFromSnapshots({
    preferredQuoteCurrency: args.preferredQuoteCurrency,
    snapshotsByWalletId,
    walletById,
  });
  const earliestSnapshotTimestampMs = getEarliestSnapshotTimestampMs({
    snapshotsByWalletId,
    walletById,
    effectiveQuoteCurrency,
  });

  return {walletById, effectiveQuoteCurrency, earliestSnapshotTimestampMs};
};

const getSnapshotUnits = (snapshot: BalanceSnapshot | undefined): number => {
  const units = toNumber(snapshot?.cryptoBalance);
  return units > 0 ? units : 0;
};

const getSnapshotFiatValue = (
  snapshot: BalanceSnapshot | undefined,
): number => {
  const costBasis = toNumber(snapshot?.remainingCostBasisFiat);
  const pnl = toNumber(snapshot?.unrealizedPnlFiat);
  const total = costBasis + pnl;
  return Number.isFinite(total) ? total : 0;
};

const getSnapshotRateFromSnapshot = (
  snapshot: BalanceSnapshot | undefined,
): number | undefined => {
  const units = getSnapshotUnits(snapshot);
  if (!(units > 0)) {
    return undefined;
  }
  const value = getSnapshotFiatValue(snapshot);
  if (!(value > 0)) {
    return undefined;
  }
  return value / units;
};

const getSnapshotRateAtTimestamp = (args: {
  snapshot: BalanceSnapshot | undefined;
  timestampMs: number;
  quoteCurrency: string;
  currencyAbbreviation: string;
  timeframe: FiatRateInterval;
  fiatRateSeriesCache?: FiatRateSeriesCache;
}): {
  rate: number;
  source: 'series' | 'snapshot' | 'none';
  seriesRate?: number;
  snapshotRate?: number;
} => {
  const interval = getFiatRateSeriesIntervalForTimeframe(args.timeframe);
  const rateFromSeries = getFiatRateFromSeriesCacheAtTimestamp({
    fiatRateSeriesCache: args.fiatRateSeriesCache,
    fiatCode: args.quoteCurrency,
    currencyAbbreviation: args.currencyAbbreviation,
    interval,
    timestampMs: args.timestampMs,
    method: 'linear',
  });
  const rateFromSnapshot = getSnapshotRateFromSnapshot(args.snapshot);
  return {
    rate: pickFirstPositiveRate(rateFromSeries, rateFromSnapshot),
    source:
      rateFromSeries && rateFromSeries > 0
        ? 'series'
        : rateFromSnapshot && rateFromSnapshot > 0
        ? 'snapshot'
        : 'none',
    seriesRate: rateFromSeries,
    snapshotRate: rateFromSnapshot,
  };
};

const getTimeWeightedReturnFromSnapshots = (args: {
  snapshots: BalanceSnapshot[] | undefined;
  baselineTimestampMs: number;
  nowMs: number;
  quoteCurrency: string;
  currencyAbbreviation: string;
  timeframe: FiatRateInterval;
  fiatRateSeriesCache?: FiatRateSeriesCache;
  currentRate?: number;
  baselineRate?: number;
  maxBaselineAgeMs?: number;
}):
  | {
      baselineFiatValue: number;
      endFiatValue: number;
      percentRatio: number;
      debug?: TimeWeightedReturnDebug;
    }
  | undefined => {
  const arr = Array.isArray(args.snapshots) ? args.snapshots.slice() : [];
  if (!arr.length) {
    return undefined;
  }

  const sorted = arr.sort((a, b) => (a?.timestamp || 0) - (b?.timestamp || 0));
  const getLatestAtOrBefore = (
    snapshots: BalanceSnapshot[],
    cutoffMs: number,
  ): BalanceSnapshot | undefined => {
    let latest: BalanceSnapshot | undefined;
    for (const snap of snapshots) {
      const ts = snap?.timestamp || 0;
      if (!ts || ts > cutoffMs) {
        break;
      }
      latest = snap;
    }
    return latest;
  };

  const getEarliestAfter = (
    snapshots: BalanceSnapshot[],
    cutoffMs: number,
  ): BalanceSnapshot | undefined => {
    for (const snap of snapshots) {
      const ts = snap?.timestamp || 0;
      if (ts > cutoffMs) {
        return snap;
      }
    }
    return undefined;
  };

  const startAtOrBefore = getLatestAtOrBefore(sorted, args.baselineTimestampMs);
  const startAfterBaseline = getEarliestAfter(sorted, args.baselineTimestampMs);
  let start = startAtOrBefore || startAfterBaseline;
  let usedStartAfterBaseline = !startAtOrBefore && !!startAfterBaseline;

  if (startAtOrBefore && startAfterBaseline) {
    const startUnits = getSnapshotUnits(startAtOrBefore);
    if (!(startUnits > 0)) {
      start = startAfterBaseline;
      usedStartAfterBaseline = true;
    }
  }

  const end = getLatestAtOrBefore(sorted, args.nowMs);
  if (!start || !end) {
    return undefined;
  }

  const effectiveBaselineTimestampMs =
    usedStartAfterBaseline && typeof start.timestamp === 'number'
      ? start.timestamp
      : args.baselineTimestampMs;
  const baselineRateCandidate = usedStartAfterBaseline
    ? undefined
    : args.baselineRate;

  const startUnits = getSnapshotUnits(start);
  const interval = getFiatRateSeriesIntervalForTimeframe(args.timeframe);
  const startRateFromSeries = getFiatRateFromSeriesCacheAtTimestamp({
    fiatRateSeriesCache: args.fiatRateSeriesCache,
    fiatCode: args.quoteCurrency,
    currencyAbbreviation: args.currencyAbbreviation,
    interval,
    timestampMs: effectiveBaselineTimestampMs,
    method: 'linear',
  });
  const startRateFallback = getSnapshotRateFromSnapshot(start);
  const startRate = pickFirstPositiveRate(
    startRateFromSeries,
    baselineRateCandidate,
    startRateFallback,
  );
  const startRateSource: 'series' | 'lastDayRates' | 'snapshot' | 'none' =
    startRateFromSeries && startRateFromSeries > 0
      ? 'series'
      : baselineRateCandidate && baselineRateCandidate > 0
      ? 'lastDayRates'
      : startRateFallback && startRateFallback > 0
      ? 'snapshot'
      : 'none';
  const startValueFromSnapshot = getSnapshotFiatValue(start);
  const startValue =
    startRate > 0
      ? startUnits * startRate
      : startValueFromSnapshot > 0
      ? startValueFromSnapshot
      : 0;

  if (!(startValue > 0)) {
    return {
      baselineFiatValue: 0,
      endFiatValue: 0,
      percentRatio: 0,
    };
  }

  let twr = 1;
  let currentUnits = startUnits;
  let valueAfterPrevFlow = startValue;
  const startTs = start.timestamp || 0;
  const flowRateSourceCounts = {series: 0, snapshot: 0, none: 0};

  for (const snap of sorted) {
    const ts = snap?.timestamp || 0;
    if (ts <= startTs || ts > args.nowMs) {
      continue;
    }
    const isFlowSnapshot =
      snap?.eventType === 'tx' || snap?.eventType === 'daily';
    if (!isFlowSnapshot) {
      continue;
    }

    const rateAtTx = getSnapshotRateAtTimestamp({
      snapshot: snap,
      timestampMs: ts,
      quoteCurrency: args.quoteCurrency,
      currencyAbbreviation: args.currencyAbbreviation,
      timeframe: args.timeframe,
      fiatRateSeriesCache: args.fiatRateSeriesCache,
    });

    const nextUnits = getSnapshotUnits(snap);
    flowRateSourceCounts[rateAtTx.source] += 1;
    if (!(rateAtTx.rate > 0)) {
      currentUnits = nextUnits;
      valueAfterPrevFlow = getSnapshotFiatValue(snap);
      continue;
    }

    const valueBeforeFlow = currentUnits * rateAtTx.rate;
    const valueAfterFlow = nextUnits * rateAtTx.rate;
    if (valueAfterPrevFlow > 0 && valueBeforeFlow > 0) {
      twr *= valueBeforeFlow / valueAfterPrevFlow;
    }

    currentUnits = nextUnits;
    valueAfterPrevFlow = valueAfterFlow;
  }

  const endUnits = getSnapshotUnits(end);
  const endRateFromSeries = getFiatRateFromSeriesCacheAtTimestamp({
    fiatRateSeriesCache: args.fiatRateSeriesCache,
    fiatCode: args.quoteCurrency,
    currencyAbbreviation: args.currencyAbbreviation,
    interval,
    timestampMs: args.nowMs,
    method: 'linear',
  });
  const endRateFallback = getSnapshotRateFromSnapshot(end);
  const endRate = pickFirstPositiveRate(
    args.currentRate,
    endRateFromSeries,
    endRateFallback,
  );
  const endRateSource: 'currentRates' | 'series' | 'snapshot' | 'none' =
    args.currentRate && args.currentRate > 0
      ? 'currentRates'
      : endRateFromSeries && endRateFromSeries > 0
      ? 'series'
      : endRateFallback && endRateFallback > 0
      ? 'snapshot'
      : 'none';
  const endValueFromSnapshot = getSnapshotFiatValue(end);
  const endValue =
    endRate > 0
      ? endUnits * endRate
      : endValueFromSnapshot > 0
      ? endValueFromSnapshot
      : 0;

  if (valueAfterPrevFlow > 0 && endValue > 0) {
    twr *= endValue / valueAfterPrevFlow;
  }

  const percentRatio = Number.isFinite(twr - 1) ? twr - 1 : 0;
  return {
    baselineFiatValue: startValue,
    endFiatValue: endValue,
    percentRatio,
    debug: {
      startRateUsed: startRate,
      startRateSource,
      startRateSeries: startRateFromSeries,
      startRateBaseline: baselineRateCandidate,
      startRateSnapshot: startRateFallback,
      endRateUsed: endRate,
      endRateSource,
      endRateCurrent: args.currentRate,
      endRateSeries: endRateFromSeries,
      endRateSnapshot: endRateFallback,
      flowRateSourceCounts,
    },
  };
};

const formatUnitsNoGrouping = (units: number): string => {
  if (!Number.isFinite(units)) {
    return '0';
  }
  return units.toLocaleString('en-US', {
    useGrouping: false,
    maximumFractionDigits: 8,
  });
};

const formatDeltaFiat = (delta: number, quoteCurrency: string): string => {
  const abs = Math.abs(delta);
  const prefix = delta >= 0 ? '+' : '-';
  return `${prefix}${formatFiatAmount(abs, quoteCurrency, {
    customPrecision: 'minimal',
  })}`;
};

const formatDeltaPercent = (ratio: number): string => {
  const pct = ratio * 100;
  const abs = Math.abs(pct);
  const prefix = pct >= 0 ? '+' : '-';
  return `${prefix}${abs.toFixed(1)}%`;
};

type AssetAgg = {
  assetId: string;
  chain: string;
  coin: string;
  tokenAddress?: string;
  hasSnapshotAtOrBeforeCutoff: boolean;
  hasBaselineSnapshot: boolean;
  units: number;
  untrackedUnits: number;
  prevUnits: number;
  costBasisFiat: number;
  prevCostBasisFiat: number;
  unrealizedPnlFiat: number;
  prevUnrealizedPnlFiat: number;
  snapshotFiatValue: number;
  hasTxSinceCutoff: boolean;
};

type AssetRateDebug = {
  nowRate: number;
  nowRateSource: 'rates' | 'snapshot';
  prevRateUsed: number;
  prevRateSeries?: number;
  prevRateLastDay?: number;
  prevRateSource: 'series' | 'lastDayRates' | 'none';
};

type TimeWeightedReturnDebug = {
  startRateUsed: number;
  startRateSource: 'series' | 'lastDayRates' | 'snapshot' | 'none';
  startRateSeries?: number;
  startRateBaseline?: number;
  startRateSnapshot?: number;
  endRateUsed: number;
  endRateSource: 'currentRates' | 'series' | 'snapshot' | 'none';
  endRateCurrent?: number;
  endRateSeries?: number;
  endRateSnapshot?: number;
  flowRateSourceCounts: {
    series: number;
    snapshot: number;
    none: number;
  };
};

type AssetTwrDebug = TimeWeightedReturnDebug & {
  walletId: string;
  baselineFiatValue: number;
  endFiatValue: number;
};

type AssetAggRow = AssetAgg & {
  deltaFiat: number;
  deltaTimeframe: number;
  percentRatio: number;
  timeWeightedPercentRatio?: number;
  hasRate: boolean;
  fiatValuePrev: number;
  timeWeightedBaselineFiat: number;
  rateDebugs?: AssetRateDebug[];
  twrDebugs?: AssetTwrDebug[];
};

const formatAssetRowPnlLog = (args: {
  row: AssetAggRow;
  gainLossMode: GainLossMode;
  baselineTimeframe: FiatRateInterval;
  baselineTimestampMs: number;
}): string => {
  const denom =
    args.gainLossMode === 'ALL'
      ? Math.abs(args.row.costBasisFiat)
      : Math.abs(args.row.fiatValuePrev);
  return JSON.stringify({
    assetId: args.row.assetId,
    chain: args.row.chain,
    coin: args.row.coin,
    gainLossMode: args.gainLossMode,
    baselineTimeframe: args.baselineTimeframe,
    baselineTimestampMs: args.baselineTimestampMs,
    units: args.row.units,
    prevUnits: args.row.prevUnits,
    costBasisFiat: args.row.costBasisFiat,
    prevCostBasisFiat: args.row.prevCostBasisFiat,
    unrealizedPnlFiat: args.row.unrealizedPnlFiat,
    prevUnrealizedPnlFiat: args.row.prevUnrealizedPnlFiat,
    fiatValueNow: args.row.snapshotFiatValue,
    baselineFiatValue: args.row.fiatValuePrev,
    deltaTimeframe: args.row.deltaTimeframe,
    deltaFiat: args.row.deltaFiat,
    denom,
    timeWeightedBaselineFiat: args.row.timeWeightedBaselineFiat,
    timeWeightedPercentRatio: args.row.timeWeightedPercentRatio,
    timeWeightedBaselineFiatTotal: args.row.timeWeightedBaselineFiat,
    percentRatio: args.row.percentRatio,
    rateDebugs: args.row.rateDebugs,
    twrDebugs: args.row.twrDebugs,
  });
};

const buildWalletByIdMap = (
  wallets: Wallet[] | undefined,
): Map<string, Wallet> => {
  const walletById = new Map<string, Wallet>();
  for (const w of wallets || []) {
    if (w?.id) {
      walletById.set(w.id, w);
    }
  }
  return walletById;
};

const getAssetMetaFromWalletAndSnapshot = (
  wallet: Wallet,
  latest: BalanceSnapshot,
):
  | {assetId: string; coin: string; chain: string; tokenAddress?: string}
  | undefined => {
  const coin = (wallet.currencyAbbreviation || latest.coin || '').toLowerCase();
  const chain = (wallet.chain || latest.chain || '').toLowerCase();
  const walletAssetId = getAssetKeyFromWallet(wallet);
  const latestAssetId = (latest.assetId || '').toLowerCase();
  const hasLatestToken = latestAssetId.split(':').length === 3;
  const assetId = (
    walletAssetId && (wallet.tokenAddress || !hasLatestToken)
      ? walletAssetId
      : latestAssetId || walletAssetId || ''
  ).toLowerCase();
  if (!assetId) {
    return undefined;
  }
  const tokenAddress =
    wallet.tokenAddress ||
    (assetId.split(':').length === 3 ? assetId.split(':')[2] : undefined);
  return {assetId, coin, chain, tokenAddress};
};

type WalletLatestSnapshotContext = {
  walletId: string;
  wallet: Wallet;
  snapshots: BalanceSnapshot[] | undefined;
  latest: BalanceSnapshot;
  meta: {assetId: string; coin: string; chain: string; tokenAddress?: string};
};

const forEachWalletLatestSnapshot = (args: {
  snapshotsByWalletId: {[walletId: string]: BalanceSnapshot[] | undefined};
  walletById: Map<string, Wallet>;
  effectiveQuoteCurrency: string;
  onSnapshot: (context: WalletLatestSnapshotContext) => void;
}): void => {
  for (const [walletId, snapshots] of Object.entries(
    args.snapshotsByWalletId || {},
  )) {
    const wallet = args.walletById.get(walletId);
    if (!wallet || wallet.network !== Network.mainnet) {
      continue;
    }

    const latest = getLatestSnapshot(snapshots);
    if (!latest) {
      continue;
    }

    const snapQuote = (latest.quoteCurrency || '').toUpperCase();
    if (snapQuote && snapQuote !== args.effectiveQuoteCurrency) {
      continue;
    }

    const meta = getAssetMetaFromWalletAndSnapshot(wallet, latest);
    if (!meta?.assetId) {
      continue;
    }

    args.onSnapshot({walletId, wallet, snapshots, latest, meta});
  }
};

const getQuoteRateNumForAsset = (args: {
  rates?: Rates;
  quoteCurrency: string;
  coin: string;
  chain: string;
  tokenAddress?: string;
}): number => {
  if (!args.rates) {
    return 0;
  }
  const arr = getRateByCurrencyName(
    args.rates,
    args.coin,
    args.chain,
    args.tokenAddress,
  );
  const rate = arr?.find(r => r.code === args.quoteCurrency)?.rate;
  return toNumber(rate);
};

const getFiatValueMetricsForAgg = (args: {
  agg: AssetAgg;
  quoteCurrency: string;
  rates?: Rates;
  lastDayRates?: Rates;
  fiatRateSeriesCache?: FiatRateSeriesCache;
  baselineTimestampMs: number;
  baselineTimeframe: FiatRateInterval;
}): {
  fiatValueNow: number;
  fiatValuePrev: number;
  fiatValuePrevMarket: number;
  costBasisFiatWithUntracked: number;
  prevCostBasisFiatEffective: number;
  hasNowRate: boolean;
  hasPrevRate: boolean;
  useRatesForTimeframe: boolean;
  rateDebug: AssetRateDebug;
} => {
  const nowRateNum = getQuoteRateNumForAsset({
    rates: args.rates,
    quoteCurrency: args.quoteCurrency,
    coin: args.agg.coin,
    chain: args.agg.chain,
    tokenAddress: args.agg.tokenAddress,
  });
  const prevSeriesInterval = getFiatRateSeriesIntervalForTimeframe(
    args.baselineTimeframe,
  );
  const prevRateNumFromSeries = getFiatRateFromSeriesCacheAtTimestamp({
    fiatRateSeriesCache: args.fiatRateSeriesCache,
    fiatCode: args.quoteCurrency,
    currencyAbbreviation: args.agg.coin,
    interval: prevSeriesInterval,
    timestampMs: args.baselineTimestampMs,
    method: 'linear',
  });
  const prevRateNumFromLastDayRates =
    args.baselineTimeframe === '1D'
      ? getQuoteRateNumForAsset({
          rates: args.lastDayRates,
          quoteCurrency: args.quoteCurrency,
          coin: args.agg.coin,
          chain: args.agg.chain,
          tokenAddress: args.agg.tokenAddress,
        })
      : 0;
  const prevRateNum = prevRateNumFromSeries ?? prevRateNumFromLastDayRates;
  const prevRateSource: 'series' | 'lastDayRates' | 'none' =
    prevRateNumFromSeries && prevRateNumFromSeries > 0
      ? 'series'
      : prevRateNumFromLastDayRates && prevRateNumFromLastDayRates > 0
      ? 'lastDayRates'
      : 'none';

  const hasNowRate = nowRateNum > 0;
  const hasPrevRate = prevRateNum > 0;
  const useRatesForTimeframe = hasNowRate && hasPrevRate;

  const prevUnitsEffective =
    args.agg.prevUnits +
    (args.agg.untrackedUnits > 0 && hasPrevRate ? args.agg.untrackedUnits : 0);
  const prevCostBasisFiatEffective =
    args.agg.prevCostBasisFiat +
    (args.agg.untrackedUnits > 0 && hasPrevRate
      ? args.agg.untrackedUnits * prevRateNum
      : 0);

  const fiatValuePrevSnapshot =
    args.agg.prevCostBasisFiat +
    args.agg.prevUnrealizedPnlFiat +
    (args.agg.untrackedUnits > 0 && hasPrevRate
      ? args.agg.untrackedUnits * prevRateNum
      : 0);

  const costBasisFiatWithUntracked =
    args.agg.costBasisFiat +
    (args.agg.untrackedUnits > 0 && hasNowRate
      ? args.agg.untrackedUnits * nowRateNum
      : 0);

  const fiatValueNow = hasNowRate
    ? args.agg.units * nowRateNum
    : args.agg.snapshotFiatValue;
  const fiatValuePrevMarket = hasPrevRate ? args.agg.units * prevRateNum : 0;
  const fiatValuePrev = useRatesForTimeframe
    ? prevUnitsEffective * prevRateNum
    : fiatValuePrevSnapshot;

  return {
    fiatValueNow,
    fiatValuePrev,
    fiatValuePrevMarket,
    costBasisFiatWithUntracked,
    prevCostBasisFiatEffective,
    hasNowRate,
    hasPrevRate,
    useRatesForTimeframe,
    rateDebug: {
      nowRate: nowRateNum,
      nowRateSource: hasNowRate ? 'rates' : 'snapshot',
      prevRateUsed: prevRateNum,
      prevRateSeries: prevRateNumFromSeries,
      prevRateLastDay: prevRateNumFromLastDayRates,
      prevRateSource,
    },
  };
};

const getEffectiveQuoteCurrencyFromSnapshots = (args: {
  preferredQuoteCurrency: string;
  snapshotsByWalletId: {[walletId: string]: BalanceSnapshot[] | undefined};
  walletById: Map<string, Wallet>;
}): string => {
  const quoteCounts = new Map<string, number>();
  for (const [walletId, snapshots] of Object.entries(
    args.snapshotsByWalletId || {},
  )) {
    const wallet = args.walletById.get(walletId);
    if (!wallet || wallet.network !== Network.mainnet) {
      continue;
    }
    const latest = getLatestSnapshot(snapshots);
    const snapQuote = (latest?.quoteCurrency || '').toUpperCase();
    if (!snapQuote) {
      continue;
    }
    quoteCounts.set(snapQuote, (quoteCounts.get(snapQuote) || 0) + 1);
  }

  if (
    args.preferredQuoteCurrency &&
    quoteCounts.has(args.preferredQuoteCurrency)
  ) {
    return args.preferredQuoteCurrency;
  }

  let best: string | undefined;
  let bestCount = -1;
  for (const [code, count] of quoteCounts.entries()) {
    if (count > bestCount) {
      best = code;
      bestCount = count;
    }
  }

  return best || args.preferredQuoteCurrency || 'USD';
};

const getBaselineTimestampMs = (nowMs?: number): number =>
  getLastDayTimestampStartOfHourMs(nowMs ?? Date.now());

const isEligibleForMarketTimeframeDelta = (args: {
  agg: AssetAgg;
  useRatesForTimeframe: boolean;
}): boolean =>
  args.useRatesForTimeframe &&
  !args.agg.hasTxSinceCutoff &&
  !(args.agg.untrackedUnits > 0);

const getMaxPrevBaselineAgeMsForTimeframe = (
  timeframe: FiatRateInterval,
): number => {
  if (timeframe === 'ALL') {
    return Number.POSITIVE_INFINITY;
  }
  if (timeframe === '1D') {
    return MAX_PREV1D_BASELINE_AGE_MS;
  }
  const windowMs = getWindowMsForFiatRateTimeframe(timeframe);
  if (!windowMs) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(MAX_PREV1D_BASELINE_AGE_MS, Math.ceil(windowMs * 1.5));
};

const getEarliestSnapshotTimestampMs = (args: {
  snapshotsByWalletId: {[walletId: string]: BalanceSnapshot[] | undefined};
  walletById: Map<string, Wallet>;
  effectiveQuoteCurrency: string;
}): number | undefined => {
  let best: number | undefined;
  for (const [walletId, snapshots] of Object.entries(
    args.snapshotsByWalletId || {},
  )) {
    const wallet = args.walletById.get(walletId);
    if (!wallet || wallet.network !== Network.mainnet) {
      continue;
    }
    const arr = Array.isArray(snapshots) ? snapshots : [];
    for (const s of arr) {
      const ts = s?.timestamp;
      if (!(typeof ts === 'number' && Number.isFinite(ts) && ts > 0)) {
        continue;
      }
      const q = (s?.quoteCurrency || '').toUpperCase();
      if (q && q !== args.effectiveQuoteCurrency) {
        continue;
      }
      best = typeof best === 'number' ? Math.min(best, ts) : ts;
    }
  }
  return best;
};

const buildAssetAggMapFromPortfolioSnapshots = (args: {
  snapshotsByWalletId: {[walletId: string]: BalanceSnapshot[] | undefined};
  wallets: Wallet[];
  walletById: Map<string, Wallet>;
  effectiveQuoteCurrency: string;
  cutoffMs: number;
  maxPrevBaselineAgeMs: number;
}): Map<string, AssetAgg> => {
  const byAssetId = new Map<string, AssetAgg>();
  const cutoffMs = args.cutoffMs;
  const maxPrevBaselineAgeMs = args.maxPrevBaselineAgeMs;

  forEachWalletLatestSnapshot({
    snapshotsByWalletId: args.snapshotsByWalletId || {},
    walletById: args.walletById,
    effectiveQuoteCurrency: args.effectiveQuoteCurrency,
    onSnapshot: ({wallet, snapshots, latest, meta}) => {
      const prevRaw = getSnapshotAtOrBefore(snapshots, cutoffMs);
      const hasSnapshotAtOrBeforeCutoff = !!prevRaw;
      const prevSnapshot =
        hasSnapshotAtOrBeforeCutoff &&
        typeof prevRaw.timestamp === 'number' &&
        cutoffMs - prevRaw.timestamp <= maxPrevBaselineAgeMs
          ? prevRaw
          : undefined;
      const hasBaselineSnapshot = !!prevSnapshot;

      const hasTxSinceCutoff = (Array.isArray(snapshots) ? snapshots : []).some(
        s => s?.eventType === 'tx' && (s?.timestamp || 0) > cutoffMs,
      );

      const unitsRaw = toNumber(latest.cryptoBalance);
      const units = unitsRaw > 0 ? unitsRaw : 0;

      const liveUnits = getLiveUnitsForWallet(wallet);
      const untrackedUnits = liveUnits > units ? liveUnits - units : 0;
      const unitsEffective = untrackedUnits ? liveUnits : units;

      const costBasisFiat = toNumber(latest.remainingCostBasisFiat);
      const unrealizedPnlFiat = toNumber(latest.unrealizedPnlFiat);
      const snapshotFiatValue = costBasisFiat + unrealizedPnlFiat;

      const prevUnitsRaw = prevSnapshot
        ? toNumber(prevSnapshot.cryptoBalance)
        : 0;
      const prevUnits = prevUnitsRaw > 0 ? prevUnitsRaw : 0;
      const prevCostBasisFiatRaw = prevSnapshot
        ? toNumber(prevSnapshot.remainingCostBasisFiat)
        : 0;
      const prevCostBasisFiat = prevUnits > 0 ? prevCostBasisFiatRaw : 0;
      const prevUnrealizedPnlFiat = prevSnapshot
        ? toNumber(prevSnapshot.unrealizedPnlFiat)
        : 0;

      const existing = byAssetId.get(meta.assetId);
      if (!existing) {
        byAssetId.set(meta.assetId, {
          assetId: meta.assetId,
          chain: meta.chain,
          coin: meta.coin,
          tokenAddress: meta.tokenAddress,
          hasSnapshotAtOrBeforeCutoff,
          hasBaselineSnapshot,
          units: unitsEffective,
          untrackedUnits,
          prevUnits,
          costBasisFiat,
          prevCostBasisFiat,
          unrealizedPnlFiat,
          prevUnrealizedPnlFiat,
          snapshotFiatValue,
          hasTxSinceCutoff,
        });
      } else {
        existing.units += unitsEffective;
        existing.untrackedUnits += untrackedUnits;
        existing.prevUnits += prevUnits;
        existing.costBasisFiat += costBasisFiat;
        existing.prevCostBasisFiat += prevCostBasisFiat;
        existing.unrealizedPnlFiat += unrealizedPnlFiat;
        existing.prevUnrealizedPnlFiat += prevUnrealizedPnlFiat;
        existing.snapshotFiatValue += snapshotFiatValue;
        existing.hasTxSinceCutoff =
          existing.hasTxSinceCutoff || hasTxSinceCutoff;
        existing.hasSnapshotAtOrBeforeCutoff =
          existing.hasSnapshotAtOrBeforeCutoff || hasSnapshotAtOrBeforeCutoff;
        existing.hasBaselineSnapshot =
          existing.hasBaselineSnapshot || hasBaselineSnapshot;
      }
    },
  });

  for (const wallet of args.wallets || []) {
    if (!wallet?.id || wallet.network !== Network.mainnet) {
      continue;
    }

    const snapshots = args.snapshotsByWalletId?.[wallet.id] || [];
    const hasSnapshots = Array.isArray(snapshots) && snapshots.length > 0;
    if (hasSnapshots) {
      continue;
    }

    const liveUnits = getLiveUnitsForWallet(wallet);
    if (!(liveUnits > 0)) {
      continue;
    }

    const coin = (wallet.currencyAbbreviation || '').toLowerCase();
    const chain = (wallet.chain || '').toLowerCase();
    const assetId = getAssetKeyFromWallet(wallet);
    if (!assetId) {
      continue;
    }

    const prev = byAssetId.get(assetId);
    if (!prev) {
      byAssetId.set(assetId, {
        assetId,
        chain,
        coin,
        tokenAddress: wallet.tokenAddress,
        hasSnapshotAtOrBeforeCutoff: false,
        hasBaselineSnapshot: false,
        units: liveUnits,
        untrackedUnits: liveUnits,
        prevUnits: 0,
        costBasisFiat: 0,
        prevCostBasisFiat: 0,
        unrealizedPnlFiat: 0,
        prevUnrealizedPnlFiat: 0,
        snapshotFiatValue: 0,
        hasTxSinceCutoff: false,
      });
    } else {
      prev.units += liveUnits;
      prev.untrackedUnits += liveUnits;
      prev.hasSnapshotAtOrBeforeCutoff =
        prev.hasSnapshotAtOrBeforeCutoff || false;
      prev.hasBaselineSnapshot = prev.hasBaselineSnapshot || false;
    }
  }

  return byAssetId;
};

const buildWalletIdsByAssetIdFromSnapshots = (args: {
  snapshotsByWalletId: {[walletId: string]: BalanceSnapshot[] | undefined};
  walletById: Map<string, Wallet>;
  effectiveQuoteCurrency: string;
}): Record<string, string[]> => {
  const map: Record<string, string[]> = {};
  forEachWalletLatestSnapshot({
    snapshotsByWalletId: args.snapshotsByWalletId || {},
    walletById: args.walletById,
    effectiveQuoteCurrency: args.effectiveQuoteCurrency,
    onSnapshot: ({walletId, meta}) => {
      if (!map[meta.assetId]) {
        map[meta.assetId] = [];
      }
      map[meta.assetId].push(walletId);
    },
  });
  return map;
};

const collapseAcrossChainsRows = (
  inputRows: AssetAggRow[],
  gainLossMode: GainLossMode,
): AssetAggRow[] => {
  const byGroupKey = new Map<string, {row: AssetAggRow; repFiat: number}>();

  for (const r of inputRows) {
    const groupKey = (r.coin || '').toLowerCase();
    if (!groupKey) {
      continue;
    }

    const prev = byGroupKey.get(groupKey);
    if (!prev) {
      byGroupKey.set(groupKey, {
        row: {
          ...r,
          assetId: groupKey,
          coin: groupKey,
        },
        repFiat: r.snapshotFiatValue,
      });
      continue;
    }

    const prevRow = prev.row;
    const prevChain = (prevRow.chain || '').toLowerCase();
    const nextChain = (r.chain || '').toLowerCase();
    const preferNewRep =
      nextChain === groupKey ||
      (r.snapshotFiatValue > prev.repFiat && prevChain !== groupKey);

    const prevWeight = prevRow.timeWeightedBaselineFiat;
    const nextWeight = r.timeWeightedBaselineFiat;
    const combinedWeight = prevWeight + nextWeight;
    const combinedReturnSum =
      prevRow.percentRatio * prevWeight + r.percentRatio * nextWeight;

    prevRow.units += r.units;
    prevRow.untrackedUnits += r.untrackedUnits;
    prevRow.prevUnits += r.prevUnits;
    prevRow.costBasisFiat += r.costBasisFiat;
    prevRow.prevCostBasisFiat += r.prevCostBasisFiat;
    prevRow.unrealizedPnlFiat += r.unrealizedPnlFiat;
    prevRow.prevUnrealizedPnlFiat += r.prevUnrealizedPnlFiat;
    prevRow.snapshotFiatValue += r.snapshotFiatValue;
    prevRow.deltaFiat += r.deltaFiat;
    prevRow.deltaTimeframe += r.deltaTimeframe;
    prevRow.fiatValuePrev += r.fiatValuePrev;
    prevRow.timeWeightedBaselineFiat = combinedWeight;
    if (r.rateDebugs?.length) {
      prevRow.rateDebugs = [...(prevRow.rateDebugs || []), ...r.rateDebugs];
    }
    if (r.twrDebugs?.length) {
      prevRow.twrDebugs = [...(prevRow.twrDebugs || []), ...r.twrDebugs];
    }
    prevRow.hasRate = prevRow.hasRate || r.hasRate;
    prevRow.hasTxSinceCutoff = prevRow.hasTxSinceCutoff || r.hasTxSinceCutoff;
    prevRow.hasSnapshotAtOrBeforeCutoff =
      prevRow.hasSnapshotAtOrBeforeCutoff || r.hasSnapshotAtOrBeforeCutoff;
    prevRow.hasBaselineSnapshot =
      prevRow.hasBaselineSnapshot || r.hasBaselineSnapshot;

    if (preferNewRep) {
      prevRow.chain = r.chain;
      prevRow.tokenAddress = r.tokenAddress;
      prev.repFiat = r.snapshotFiatValue;
    }

    if (gainLossMode === 'ALL') {
      const denom = Math.abs(prevRow.costBasisFiat);
      prevRow.percentRatio = denom > 0 ? prevRow.deltaFiat / denom : 0;
      prevRow.timeWeightedPercentRatio = undefined;
      continue;
    }

    const baseline = combinedWeight || Math.abs(prevRow.fiatValuePrev);
    const nextPercentRatio =
      baseline > 0 ? combinedReturnSum / baseline : prevRow.percentRatio;
    prevRow.percentRatio = nextPercentRatio;
    prevRow.timeWeightedPercentRatio =
      combinedWeight > 0 ? combinedReturnSum / combinedWeight : undefined;
  }

  return Array.from(byGroupKey.values()).map(v => v.row);
};

const getTimeframePnlMetricsForAgg = (args: {
  agg: AssetAgg;
  quoteCurrency: string;
  rates?: Rates;
  lastDayRates?: Rates;
  fiatRateSeriesCache?: FiatRateSeriesCache;
  baselineTimestampMs: number;
  timeframe: FiatRateInterval;
}):
  | {
      fiatValueNow: number;
      baselineFiatValue: number;
      deltaFiat: number;
      unrealizedPnlNow: number;
      hasNowRate: boolean;
      useRatesForTimeframe: boolean;
      rateDebug: AssetRateDebug;
    }
  | undefined => {
  const {
    fiatValueNow,
    fiatValuePrev,
    fiatValuePrevMarket,
    costBasisFiatWithUntracked,
    prevCostBasisFiatEffective,
    hasNowRate,
    useRatesForTimeframe,
    rateDebug,
  } = getFiatValueMetricsForAgg({
    agg: args.agg,
    quoteCurrency: args.quoteCurrency,
    rates: args.rates,
    lastDayRates: args.lastDayRates,
    fiatRateSeriesCache: args.fiatRateSeriesCache,
    baselineTimestampMs: args.baselineTimestampMs,
    baselineTimeframe: args.timeframe,
  });

  const eligibleForMarketTimeframe = isEligibleForMarketTimeframeDelta({
    agg: args.agg,
    useRatesForTimeframe,
  });
  const unrealizedPnlNow = fiatValueNow - costBasisFiatWithUntracked;

  if (!args.agg.hasSnapshotAtOrBeforeCutoff) {
    return {
      fiatValueNow,
      baselineFiatValue: args.agg.costBasisFiat,
      deltaFiat: unrealizedPnlNow,
      unrealizedPnlNow,
      hasNowRate,
      useRatesForTimeframe,
      rateDebug,
    };
  }

  const baselineFiatValue = eligibleForMarketTimeframe
    ? fiatValuePrevMarket
    : fiatValuePrev;
  const unrealizedPnlPrev = fiatValuePrev - prevCostBasisFiatEffective;
  const deltaFiat = eligibleForMarketTimeframe
    ? fiatValueNow - baselineFiatValue
    : unrealizedPnlNow - unrealizedPnlPrev;

  return {
    fiatValueNow,
    baselineFiatValue,
    deltaFiat,
    unrealizedPnlNow,
    hasNowRate,
    useRatesForTimeframe,
    rateDebug,
  };
};

const computePortfolioPnlChangeForTimeframeFromAggs = (args: {
  byAssetId: Map<string, AssetAgg>;
  quoteCurrency: string;
  rates?: Rates;
  lastDayRates?: Rates;
  fiatRateSeriesCache?: FiatRateSeriesCache;
  baselineTimestampMs: number;
  timeframe: FiatRateInterval;
}): {deltaFiat: number; percentRatio: number; baselineFiatTotal: number} => {
  let baselineFiatTotal = 0;
  let deltaFiatTotal = 0;

  for (const agg of args.byAssetId.values()) {
    if (!(agg.units > 0)) {
      continue;
    }

    const m = getTimeframePnlMetricsForAgg({
      agg,
      quoteCurrency: args.quoteCurrency,
      rates: args.rates,
      lastDayRates: args.lastDayRates,
      fiatRateSeriesCache: args.fiatRateSeriesCache,
      baselineTimestampMs: args.baselineTimestampMs,
      timeframe: args.timeframe,
    });
    if (!m) {
      continue;
    }

    baselineFiatTotal += m.baselineFiatValue;
    deltaFiatTotal += m.deltaFiat;
  }

  return {
    deltaFiat: deltaFiatTotal,
    baselineFiatTotal,
    percentRatio:
      Math.abs(baselineFiatTotal) > 0
        ? deltaFiatTotal / Math.abs(baselineFiatTotal)
        : 0,
  };
};

const getTimeWeightedReturnForWalletIds = (args: {
  walletIds: string[];
  snapshotsByWalletId: {[walletId: string]: BalanceSnapshot[] | undefined};
  walletById: Map<string, Wallet>;
  quoteCurrency: string;
  timeframe: FiatRateInterval;
  baselineTimestampMs: number;
  nowMs: number;
  fiatRateSeriesCache?: FiatRateSeriesCache;
  rates?: Rates;
  lastDayRates?: Rates;
}):
  | {
      percentRatio: number;
      baselineFiatTotal: number;
      twrDebugs?: AssetTwrDebug[];
    }
  | undefined => {
  let baselineFiatTotal = 0;
  let weightedReturnSum = 0;
  const twrDebugs: AssetTwrDebug[] = [];
  const maxBaselineAgeMs = getMaxPrevBaselineAgeMsForTimeframe(args.timeframe);

  for (const walletId of args.walletIds) {
    const wallet = args.walletById.get(walletId);
    if (!wallet || wallet.network !== Network.mainnet) {
      continue;
    }

    const snapshots = args.snapshotsByWalletId?.[walletId];
    const latest = getLatestSnapshot(snapshots);
    const snapQuote = (latest?.quoteCurrency || '').toUpperCase();
    if (snapQuote && snapQuote !== args.quoteCurrency) {
      continue;
    }

    const currencyAbbreviation = (
      wallet.currencyAbbreviation || ''
    ).toLowerCase();
    if (!currencyAbbreviation) {
      continue;
    }

    const currentRate = getQuoteRateNumForAsset({
      rates: args.rates,
      quoteCurrency: args.quoteCurrency,
      coin: wallet.currencyAbbreviation,
      chain: wallet.chain,
      tokenAddress: wallet.tokenAddress,
    });
    const baselineRate =
      args.timeframe === '1D'
        ? getQuoteRateNumForAsset({
            rates: args.lastDayRates,
            quoteCurrency: args.quoteCurrency,
            coin: wallet.currencyAbbreviation,
            chain: wallet.chain,
            tokenAddress: wallet.tokenAddress,
          })
        : 0;
    const result = getTimeWeightedReturnFromSnapshots({
      snapshots,
      baselineTimestampMs: args.baselineTimestampMs,
      nowMs: args.nowMs,
      quoteCurrency: args.quoteCurrency,
      currencyAbbreviation,
      timeframe: args.timeframe,
      fiatRateSeriesCache: args.fiatRateSeriesCache,
      currentRate,
      baselineRate,
      maxBaselineAgeMs,
    });
    if (!result) {
      continue;
    }

    if (result.debug) {
      twrDebugs.push({
        walletId,
        baselineFiatValue: result.baselineFiatValue,
        endFiatValue: result.endFiatValue,
        ...result.debug,
      });
    }

    if (result.baselineFiatValue > 0 && Number.isFinite(result.percentRatio)) {
      baselineFiatTotal += result.baselineFiatValue;
      weightedReturnSum += result.baselineFiatValue * result.percentRatio;
    }
  }

  if (!(baselineFiatTotal > 0)) {
    return undefined;
  }

  return {
    baselineFiatTotal,
    percentRatio: weightedReturnSum / baselineFiatTotal,
    twrDebugs: twrDebugs.length ? twrDebugs : undefined,
  };
};

const getPortfolioTimeWeightedReturnFromSnapshots = (args: {
  snapshotsByWalletId: {[walletId: string]: BalanceSnapshot[] | undefined};
  wallets: Wallet[];
  walletById: Map<string, Wallet>;
  quoteCurrency: string;
  timeframe: FiatRateInterval;
  baselineTimestampMs: number;
  nowMs: number;
  fiatRateSeriesCache?: FiatRateSeriesCache;
  rates?: Rates;
  lastDayRates?: Rates;
}): {percentRatio: number; baselineFiatTotal: number} | undefined => {
  return getTimeWeightedReturnForWalletIds({
    walletIds: Object.keys(args.snapshotsByWalletId || {}),
    snapshotsByWalletId: args.snapshotsByWalletId || {},
    walletById: args.walletById,
    quoteCurrency: args.quoteCurrency,
    timeframe: args.timeframe,
    baselineTimestampMs: args.baselineTimestampMs,
    nowMs: args.nowMs,
    fiatRateSeriesCache: args.fiatRateSeriesCache,
    rates: args.rates,
    lastDayRates: args.lastDayRates,
  });
};

export const getPortfolioPnlChangeForTimeframeFromPortfolioSnapshots = (args: {
  snapshotsByWalletId: {[walletId: string]: BalanceSnapshot[] | undefined};
  wallets: Wallet[];
  quoteCurrency: string;
  timeframe: FiatRateInterval;
  rates?: Rates;
  lastDayRates?: Rates;
  fiatRateSeriesCache?: FiatRateSeriesCache;
  nowMs?: number;
}): {
  quoteCurrency: string;
  timeframe: FiatRateInterval;
  baselineTimestampMs: number;
  deltaFiat: number;
  percentRatio: number;
} => {
  const preferredQuoteCurrency = (args.quoteCurrency || '').toUpperCase();
  const {walletById, effectiveQuoteCurrency, earliestSnapshotTimestampMs} =
    buildPortfolioSnapshotContext({
      wallets: args.wallets,
      snapshotsByWalletId: args.snapshotsByWalletId || {},
      preferredQuoteCurrency,
    });

  const nowMs = typeof args.nowMs === 'number' ? args.nowMs : Date.now();
  const baselineTimestampMs = (() => {
    const ts = getBaselineTimestampMsForFiatRateTimeframe({
      timeframe: args.timeframe,
      nowMs,
    });
    if (typeof ts === 'number') {
      return ts;
    }
    return typeof earliestSnapshotTimestampMs === 'number'
      ? earliestSnapshotTimestampMs
      : nowMs;
  })();

  const byAssetId = buildAssetAggMapFromPortfolioSnapshots({
    snapshotsByWalletId: args.snapshotsByWalletId || {},
    wallets: args.wallets,
    walletById,
    effectiveQuoteCurrency,
    cutoffMs: baselineTimestampMs,
    maxPrevBaselineAgeMs: getMaxPrevBaselineAgeMsForTimeframe(args.timeframe),
  });

  const legacyTotals = computePortfolioPnlChangeForTimeframeFromAggs({
    byAssetId,
    quoteCurrency: effectiveQuoteCurrency,
    rates: args.rates,
    lastDayRates: args.lastDayRates,
    fiatRateSeriesCache: args.fiatRateSeriesCache,
    baselineTimestampMs,
    timeframe: args.timeframe,
  });

  const timeWeighted = getPortfolioTimeWeightedReturnFromSnapshots({
    snapshotsByWalletId: args.snapshotsByWalletId || {},
    wallets: args.wallets,
    walletById,
    quoteCurrency: effectiveQuoteCurrency,
    timeframe: args.timeframe,
    baselineTimestampMs,
    nowMs,
    fiatRateSeriesCache: args.fiatRateSeriesCache,
    rates: args.rates,
    lastDayRates: args.lastDayRates,
  });

  const percentRatio = timeWeighted?.percentRatio ?? legacyTotals.percentRatio;
  const deltaFiat = legacyTotals.deltaFiat;

  return {
    quoteCurrency: effectiveQuoteCurrency,
    timeframe: args.timeframe,
    baselineTimestampMs,
    deltaFiat,
    percentRatio,
  };
};

export const buildPortfolioGainLossSummaryFromPortfolioSnapshots = (args: {
  snapshotsByWalletId: {[walletId: string]: BalanceSnapshot[] | undefined};
  wallets: Wallet[];
  quoteCurrency: string;
  rates?: Rates;
  lastDayRates?: Rates;
  fiatRateSeriesCache?: FiatRateSeriesCache;
  nowMs?: number;
}): {
  quoteCurrency: string;
  total: {deltaFiat: number; percentRatio: number};
  today: {deltaFiat: number; percentRatio: number};
} => {
  const preferredQuoteCurrency = (args.quoteCurrency || '').toUpperCase();
  const {walletById, effectiveQuoteCurrency} = buildPortfolioSnapshotContext({
    wallets: args.wallets,
    snapshotsByWalletId: args.snapshotsByWalletId || {},
    preferredQuoteCurrency,
  });
  const baselineTimestampMs = getBaselineTimestampMs(args.nowMs);

  const byAssetId = buildAssetAggMapFromPortfolioSnapshots({
    snapshotsByWalletId: args.snapshotsByWalletId || {},
    wallets: args.wallets,
    walletById,
    effectiveQuoteCurrency,
    cutoffMs: baselineTimestampMs,
    maxPrevBaselineAgeMs: getMaxPrevBaselineAgeMsForTimeframe('1D'),
  });

  let fiatValueNowTotal = 0;
  let costBasisNowTotal = 0;

  for (const agg of byAssetId.values()) {
    if (!(agg.units > 0)) {
      continue;
    }

    const {fiatValueNow, costBasisFiatWithUntracked} =
      getFiatValueMetricsForAgg({
        agg,
        quoteCurrency: effectiveQuoteCurrency,
        rates: args.rates,
        lastDayRates: args.lastDayRates,
        fiatRateSeriesCache: args.fiatRateSeriesCache,
        baselineTimestampMs,
        baselineTimeframe: '1D',
      });

    fiatValueNowTotal += fiatValueNow;
    costBasisNowTotal += costBasisFiatWithUntracked;
  }

  const today = computePortfolioPnlChangeForTimeframeFromAggs({
    byAssetId,
    quoteCurrency: effectiveQuoteCurrency,
    rates: args.rates,
    lastDayRates: args.lastDayRates,
    fiatRateSeriesCache: args.fiatRateSeriesCache,
    baselineTimestampMs,
    timeframe: '1D',
  });

  const unrealizedPnlNowTotal = fiatValueNowTotal - costBasisNowTotal;

  return {
    quoteCurrency: effectiveQuoteCurrency,
    total: {
      deltaFiat: unrealizedPnlNowTotal,
      percentRatio:
        Math.abs(costBasisNowTotal) > 0
          ? unrealizedPnlNowTotal / Math.abs(costBasisNowTotal)
          : 0,
    },
    today: {
      deltaFiat: today.deltaFiat,
      percentRatio: today.percentRatio,
    },
  };
};

export const buildAssetRowItemsFromPortfolioSnapshots = (args: {
  snapshotsByWalletId: {[walletId: string]: BalanceSnapshot[] | undefined};
  wallets: Wallet[];
  quoteCurrency: string;
  gainLossMode: GainLossMode;
  rates?: Rates;
  lastDayRates?: Rates;
  collapseAcrossChains?: boolean;
  fiatRateSeriesCache?: FiatRateSeriesCache;
  nowMs?: number;
}): AssetRowItem[] => {
  const nowMs = typeof args.nowMs === 'number' ? args.nowMs : Date.now();
  const quoteCurrency = (args.quoteCurrency || 'USD').toUpperCase();
  const timeframe = args.gainLossMode;
  const fiatRateSeriesCache = args.fiatRateSeriesCache;

  const getAssetKey = (w: Wallet): {key: string; coin: string} | null => {
    const coin = String((w as any)?.currencyAbbreviation || '').toLowerCase();
    if (!coin) return null;

    if (args.collapseAcrossChains) {
      return {key: coin, coin};
    }

    const chain = String((w as any)?.chain || '').toLowerCase();
    const tokenAddress = (w as any)?.tokenAddress as string | undefined;
    const assetId = tokenAddress
      ? `${chain}:${coin}:${tokenAddress.toLowerCase()}`
      : `${chain}:${coin}`;
    return {key: assetId, coin};
  };

  const ensureSortedSnapshots = (
    snaps: BalanceSnapshot[] | undefined,
  ): BalanceSnapshot[] => {
    const arr = Array.isArray(snaps) ? snaps : [];
    if (arr.length < 2) return arr;
    for (let i = 1; i < arr.length; i++) {
      if ((arr[i]?.timestamp || 0) < (arr[i - 1]?.timestamp || 0)) {
        return arr.slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      }
    }
    return arr;
  };

  const toPnlWallet = (w: Wallet): WalletForAnalysis | null => {
    const walletId = String((w as any)?.id || '');
    const currencyAbbreviation = String((w as any)?.currencyAbbreviation || '').toLowerCase();
    if (!walletId || !currencyAbbreviation) return null;

    const appSnaps = ensureSortedSnapshots(args.snapshotsByWalletId?.[walletId]);
    if (!appSnaps.length) return null;

    const unitInfo = getWalletUnitInfo(w);

    const credentials: any = {
      chain: String((w as any)?.chain || currencyAbbreviation).toLowerCase(),
      coin: currencyAbbreviation,
      network: (w as any)?.network === Network.mainnet ? 'livenet' : String((w as any)?.network || 'livenet'),
    };
    const tokenAddress = (w as any)?.tokenAddress as string | undefined;
    if (tokenAddress) {
      credentials.token = {
        ...(credentials.token || {}),
        decimals: unitInfo.unitDecimals,
        address: tokenAddress,
      };
    }

    const snaps: BalanceSnapshotStored[] = appSnaps.map(s => {
      const chain = String((s as any)?.chain || (w as any)?.chain || '').toLowerCase();
      const coin = String((s as any)?.coin || (w as any)?.currencyAbbreviation || '').toLowerCase();
      const tokenAddr = (w as any)?.tokenAddress as string | undefined;
      const assetId = tokenAddr ? `${chain}:${coin}:${tokenAddr.toLowerCase()}` : `${chain}:${coin}`;
      const markRate = typeof (s as any)?.costBasisRateFiat === 'number' ? (s as any).costBasisRateFiat : 0;
      return {
        id: String((s as any)?.id || ''),
        walletId,
        chain: chain || credentials.chain,
        coin: coin || currencyAbbreviation,
        network: String((s as any)?.network || 'livenet'),
        assetId,
        timestamp: Number((s as any)?.timestamp || 0),
        eventType: ((s as any)?.eventType || 'tx') as any,
        cryptoBalance: unitStringToAtomicBigInt(String((s as any)?.cryptoBalance || '0'), unitInfo.unitDecimals).toString(),
        remainingCostBasisFiat: Number((s as any)?.remainingCostBasisFiat || 0),
        quoteCurrency: String((s as any)?.quoteCurrency || quoteCurrency),
        markRate,
        createdAt: typeof (s as any)?.createdAt === 'number' ? (s as any).createdAt : undefined,
        // Only present for daily snapshots in the harness schema.
        txIds: Array.isArray((s as any)?.txIds) ? (s as any).txIds : undefined,
      };
    });

    return {
      walletId,
      walletName: String((w as any)?.walletName || (w as any)?.name || walletId),
      currencyAbbreviation,
      credentials,
      snapshots: snaps,
    };
  };

  // Group wallets by asset key.
  const walletsByAssetKey = new Map<string, Wallet[]>();
  for (const w of args.wallets || []) {
    if ((w as any)?.network !== Network.mainnet) continue;
    const info = getAssetKey(w);
    if (!info) continue;
    const list = walletsByAssetKey.get(info.key) || [];
    list.push(w);
    walletsByAssetKey.set(info.key, list);
  }

  const rows: Array<{
    key: string;
    repWallet: Wallet;
    coin: string;
    chain: string;
    tokenAddress?: string;
    cryptoAmount: string;
    fiatValue: number;
    pnlFiat: number;
    pnlRatio: number;
    hasRate: boolean;
    pnlLog?: string;
  }> = [];

  for (const [assetKey, groupWallets] of walletsByAssetKey.entries()) {
    const first = groupWallets[0];
    const coin = String((first as any)?.currencyAbbreviation || '').toLowerCase();
    if (!coin) continue;

    // For collapsed views (e.g. ETH across multiple EVM networks), prefer the L1/base-chain
    // wallet as the representative so icons + metadata resolve consistently.
    const repWallet =
      args.collapseAcrossChains
        ?
            groupWallets.find(w =>
              String((w as any)?.chain || '').toLowerCase() === coin &&
              !(w as any)?.tokenAddress,
            ) || first
        : first;

    // Build analysis wallets (skip wallets without snapshots).
    const pnlWallets: WalletForAnalysis[] = [];
    for (const w of groupWallets) {
      const pw = toPnlWallet(w);
      if (pw) pnlWallets.push(pw);
    }
    if (!pnlWallets.length) continue;

    // Compute end-of-interval metrics via the same series builder the harness uses.
    // (We only need the endpoints here, so we request 2 points for speed.)
    let fiatValue = 0;
    let pnlFiat = 0;
    let pnlRatio = 0;
    let hasRate = false;
    let pnlLog: string | undefined;
    let endCryptoAtomic: string | undefined;

    try {
      if (!fiatRateSeriesCache) {
        throw new Error('Missing fiatRateSeriesCache');
      }

      const res = buildPnlAnalysisSeries({
        wallets: pnlWallets,
        timeframe: timeframe as any,
        quoteCurrency,
        fiatRateSeriesCache: fiatRateSeriesCache as any,
        nowMs,
        maxPoints: 2,
      });

      const pts = res.points;
      const last = pts.length ? pts[pts.length - 1] : undefined;
      if (last) {
        fiatValue = last.totalFiatBalance;
        pnlFiat = last.totalUnrealizedPnlFiat;
        pnlRatio = (last.totalPnlPercent || 0) / 100;
        endCryptoAtomic = last.totalCryptoBalanceAtomic;
        hasRate = true;
      }
    } catch (e: any) {
      hasRate = false;
      pnlLog = String(e?.message || e);
    }

    // Determine end crypto amount (use analysis total if available; fall back to latest snapshots).
    let totalAtomic = 0n;
    const repUnitDecimals = getWalletUnitInfo(repWallet).unitDecimals;

    if (endCryptoAtomic) {
      try {
        totalAtomic = parseAtomicToBigint(endCryptoAtomic);
      } catch {
        totalAtomic = 0n;
      }
    }

    if (!endCryptoAtomic || totalAtomic === 0n) {
      // Prefer the latest snapshot from each wallet to avoid depending on rate cache for basic holdings.
      for (const w of groupWallets) {
        const wid = String((w as any)?.id || '');
        const snaps = ensureSortedSnapshots(args.snapshotsByWalletId?.[wid]);
        const latest = getLatestSnapshot(snaps);
        if (!latest) continue;
        try {
          totalAtomic += parseAtomicToBigint((latest as any).cryptoBalance);
        } catch {
          // ignore
        }
      }
    }

    if (totalAtomic <= 0n) continue;

    const cryptoAmount = formatBigIntDecimal(
      totalAtomic,
      repUnitDecimals,
      Math.min(repUnitDecimals, 8),
    );

    rows.push({
      key: assetKey,
      repWallet,
      coin,
      chain: String((repWallet as any)?.chain || ''),
      tokenAddress: (repWallet as any)?.tokenAddress,
      cryptoAmount,
      fiatValue,
      pnlFiat,
      pnlRatio,
      hasRate,
      pnlLog,
    });
  }

  rows.sort((a, b) => (b.fiatValue || 0) - (a.fiatValue || 0));

  return rows.map(r => {
    return {
      key: r.key,
      currencyAbbreviation: r.coin,
      chain: r.chain,
      tokenAddress: r.tokenAddress,
      name: formatCurrencyAbbreviation(r.coin),
      cryptoAmount: r.cryptoAmount,
      fiatAmount: formatFiatAmount(r.fiatValue, quoteCurrency, {
        customPrecision: 'minimal',
      }),
      deltaFiat: formatDeltaFiat(r.pnlFiat, quoteCurrency),
      deltaPercent: formatDeltaPercent(r.pnlRatio),
      isPositive: r.pnlFiat >= 0,
      hasRate: r.hasRate,
      pnlLog: r.pnlLog,
    };
  });
};

export const getPopulateLoadingByAssetKey = (args: {
  items: Array<{key: string}>;
  walletIdsByAssetKey: Record<string, string[]>;
  populateStatus: PortfolioPopulateStatus;
  prev?: Record<string, boolean>;
}): Record<string, boolean> | undefined => {
  if (!args.populateStatus?.inProgress) {
    return undefined;
  }

  const prevMap = args.prev || {};
  const statusById = args.populateStatus.walletStatusById || {};
  const currentWalletId = args.populateStatus.currentWalletId;
  const mainnetWalletsTotal = Object.values(args.walletIdsByAssetKey).reduce(
    (sum, ids) => sum + (Array.isArray(ids) ? ids.length : 0),
    0,
  );
  const isFullPopulate =
    mainnetWalletsTotal > 0 &&
    args.populateStatus.walletsTotal === mainnetWalletsTotal;
  const inScopeWalletIds = new Set<string>([
    ...Object.keys(statusById || {}),
    ...(currentWalletId ? [currentWalletId] : []),
  ]);

  const next: Record<string, boolean> = {};

  for (const item of args.items) {
    const assetWalletIdsAll = args.walletIdsByAssetKey[item.key] || [];
    const assetWalletIds = isFullPopulate
      ? assetWalletIdsAll
      : assetWalletIdsAll.filter(wid => inScopeWalletIds.has(wid));

    if (!assetWalletIds.length) {
      next[item.key] = !!prevMap[item.key];
      continue;
    }

    const allFinished = assetWalletIds.every(wid => {
      const s = statusById[wid] as WalletPopulateState | undefined;
      return s === 'done' || s === 'error';
    });

    next[item.key] = !allFinished;
  }

  for (const k of Object.keys(prevMap)) {
    if (!(k in next)) {
      next[k] = prevMap[k];
    }
  }

  const prevKeys = Object.keys(prevMap);
  const nextKeys = Object.keys(next);
  if (prevKeys.length === nextKeys.length) {
    let same = true;
    for (const k of nextKeys) {
      if (prevMap[k] !== next[k]) {
        same = false;
        break;
      }
    }
    if (same) {
      return args.prev;
    }
  }

  return next;
};
