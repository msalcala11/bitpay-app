import {Network} from '../../constants';
import type {HomeCarouselConfig} from '../../store/app/app.models';
import type {
  PortfolioPopulateStatus,
  WalletPopulateState,
} from '../../store/portfolio/portfolio.models';
import type {FiatRateInterval, Rates} from '../../store/rate/rate.models';
import type {Key, Wallet} from '../../store/wallet/wallet.models';
import {IsSVMChain} from '../../store/wallet/utils/currency';
import type {SupportedCurrencyOption} from '../../constants/SupportedCurrencyOptions';
import {
  getWalletStableDeduplicationId,
  isWalletVisibleForKey,
} from '../../store/wallet/utils/wallet';
import {
  BitpaySupportedCoins,
  BitpaySupportedTokens,
  BitpaySupportedUtxoCoins,
} from '../../constants/currencies';
import {tokenManager} from '../../managers/TokenManager';
import {
  getCurrencyAbbreviation,
  calculatePercentageDifference,
  unitStringToAtomicBigInt,
} from '../helper-methods';
import {
  createSupportedCurrencyOptionLookup,
  type SupportedCurrencyOptionLookup,
} from './supportedCurrencyOptionsLookup';
import {atomicToUnitNumber} from './core/pnl/atomic';
import {toStringOrEmpty} from '../text';
import {
  getAssetCurrentDisplayQuoteRate,
  resolveActivePortfolioDisplayQuoteCurrency,
} from './displayCurrency';

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
  hasPnl: boolean;
  showPnlPlaceholder?: boolean;
  showScopedPnlLoading?: boolean;
  debugCopyPayload?: Record<string, unknown>;
};

export type PortfolioGainLossSummary = {
  quoteCurrency: string;
  total: {
    deltaFiat: number;
    percentRatio: number;
    available: boolean;
    error?: string;
  };
  today: {
    deltaFiat: number;
    percentRatio: number;
    available: boolean;
    error?: string;
  };
};

export const sortAssetRowItemsByHasRate = (
  items: AssetRowItem[],
): AssetRowItem[] => {
  const arr = items || [];
  if (arr.length < 2) {
    return arr.slice();
  }
  const withRate: AssetRowItem[] = [];
  const withoutRate: AssetRowItem[] = [];
  for (const item of arr) {
    if (item?.hasRate) {
      withRate.push(item);
      continue;
    }
    withoutRate.push(item);
  }
  return withRate.concat(withoutRate);
};

const buildAssetFiatPriorityEntries = (
  wallets: Wallet[] | undefined,
): Array<{
  wallet: Wallet;
  index: number;
  groupKey: string;
  fiatBalance: number;
}> => {
  return (wallets || []).map((wallet, index) => ({
    wallet,
    index,
    groupKey: getPortfolioWalletCurrencyAbbreviationLower(wallet),
    fiatBalance: Math.max(0, toNumber(wallet.balance?.fiat)),
  }));
};

export const buildAssetFiatPriorityByKey = (
  wallets: Wallet[] | undefined,
): Record<string, {fiatBalance: number; firstIndex: number}> => {
  const out: Record<string, {fiatBalance: number; firstIndex: number}> = {};

  for (const item of buildAssetFiatPriorityEntries(wallets)) {
    if (!item.groupKey) {
      continue;
    }

    const existing = out[item.groupKey];
    if (!existing) {
      out[item.groupKey] = {
        fiatBalance: item.fiatBalance,
        firstIndex: item.index,
      };
      continue;
    }

    existing.fiatBalance += item.fiatBalance;
    existing.firstIndex = Math.min(existing.firstIndex, item.index);
  }

  return out;
};

export const sortAssetRowItemsByAssetFiatPriority = (args: {
  items: AssetRowItem[];
  wallets: Wallet[] | undefined;
}): AssetRowItem[] => {
  const priorityByKey = buildAssetFiatPriorityByKey(args.wallets);
  const indexedItems = (args.items || []).map((item, index) => ({
    item,
    index,
    priority: priorityByKey[item.key],
  }));

  return indexedItems
    .slice()
    .sort((a, b) => {
      const fiatDiff =
        (b.priority?.fiatBalance || 0) - (a.priority?.fiatBalance || 0);
      if (fiatDiff !== 0) {
        return fiatDiff;
      }

      const priorityIndexDiff =
        (a.priority?.firstIndex ?? Number.MAX_SAFE_INTEGER) -
        (b.priority?.firstIndex ?? Number.MAX_SAFE_INTEGER);
      if (priorityIndexDiff !== 0) {
        return priorityIndexDiff;
      }

      return a.index - b.index;
    })
    .map(entry => entry.item);
};

type AssetRowItemSupportInfo = {
  option: SupportedCurrencyOption | undefined;
  isExactMatch: boolean;
  isStable: boolean;
};

const isExactSupportedOptionMatchForAssetRowItem = (args: {
  item: AssetRowItem;
  option: SupportedCurrencyOption;
}): boolean => {
  return (
    (args.option.currencyAbbreviation || '').toLowerCase() ===
      (args.item.currencyAbbreviation || '').toLowerCase() &&
    (args.option.chain || '').toLowerCase() ===
      (args.item.chain || '').toLowerCase() &&
    (args.option.tokenAddress || '').toLowerCase() ===
      (args.item.tokenAddress || '').toLowerCase()
  );
};

const canNavigateToExchangeRateForAssetRowItemWithSupportInfo = (args: {
  item: AssetRowItem;
  supportInfo: AssetRowItemSupportInfo;
}): boolean => {
  return (
    !!args.supportInfo.option &&
    args.supportInfo.isExactMatch // &&
    // !args.supportInfo.isStable
  );
};

export const canNavigateToExchangeRateForAssetRowItem = (args: {
  item: AssetRowItem;
  options: SupportedCurrencyOption[];
}): boolean => {
  return canNavigateToExchangeRateForAssetRowItemWithSupportInfo({
    item: args.item,
    supportInfo: getAssetRowItemSupportInfo(args),
  });
};

export const getDisplayAssetRowItems = (
  items: AssetRowItem[],
): AssetRowItem[] => {
  return sortAssetRowItemsByHasRate(items || []);
};

const getAssetRowItemSupportInfo = (args: {
  item: AssetRowItem;
  options: SupportedCurrencyOption[];
}): AssetRowItemSupportInfo => {
  const option = findSupportedCurrencyOptionForAsset({
    options: args.options,
    currencyAbbreviation: args.item.currencyAbbreviation,
    chain: args.item.chain,
    tokenAddress: args.item.tokenAddress,
  });

  if (!option) {
    return {option: undefined, isExactMatch: false, isStable: false};
  }

  const isExactMatch = isExactSupportedOptionMatchForAssetRowItem({
    item: args.item,
    option,
  });
  if (!isExactMatch) {
    return {option, isExactMatch: false, isStable: false};
  }

  const currencyName = getCurrencyAbbreviation(
    option.tokenAddress ? option.tokenAddress : option.currencyAbbreviation,
    option.chain,
  );

  const isStable =
    BitpaySupportedCoins[currencyName]?.properties?.isStableCoin ||
    BitpaySupportedTokens[currencyName]?.properties?.isStableCoin;

  return {option, isExactMatch: true, isStable: !!isStable};
};

const toNumber = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

const toOptionalString = (value: unknown): string | undefined => {
  const normalized = toStringOrEmpty(value);
  return normalized === '' ? undefined : normalized;
};

type WalletWithTokenCredentials = Wallet & {
  credentials?: {
    token?: {
      decimals?: unknown;
    };
  };
};

export const getPortfolioWalletId = (wallet: Wallet | undefined): string => {
  return toStringOrEmpty(wallet?.id);
};

export const getPortfolioWalletCurrencyAbbreviation = (
  wallet: Wallet | undefined,
): string => {
  return toStringOrEmpty(wallet?.currencyAbbreviation);
};

export const getPortfolioWalletCurrencyAbbreviationLower = (
  wallet: Wallet | undefined,
): string => {
  return getPortfolioWalletCurrencyAbbreviation(wallet).toLowerCase();
};

export const getPortfolioWalletChain = (
  wallet: Wallet | undefined,
  fallback = '',
): string => {
  return toStringOrEmpty(wallet?.chain || fallback);
};

export const getPortfolioWalletChainLower = (
  wallet: Wallet | undefined,
  fallback = '',
): string => {
  return getPortfolioWalletChain(wallet, fallback).toLowerCase();
};

export const getPortfolioWalletTokenAddress = (
  wallet: Wallet | undefined,
): string | undefined => {
  return toOptionalString(wallet?.tokenAddress);
};

export const getPortfolioWalletTokenAddressNormalized = (
  wallet: Wallet | undefined,
): string | undefined => {
  const tokenAddress = getPortfolioWalletTokenAddress(wallet);
  if (!tokenAddress) {
    return undefined;
  }

  return IsSVMChain(getPortfolioWalletChain(wallet))
    ? tokenAddress
    : tokenAddress.toLowerCase();
};

export const isPortfolioWalletOnMainnet = (
  wallet: Wallet | undefined,
): boolean => {
  return wallet?.network === Network.mainnet;
};

const getPortfolioWalletTokenDecimals = (
  wallet: Wallet | undefined,
): number | undefined => {
  const decimals = (wallet as WalletWithTokenCredentials | undefined)
    ?.credentials?.token?.decimals;
  return typeof decimals === 'number' && Number.isFinite(decimals)
    ? decimals
    : undefined;
};

export const getQuoteCurrency = (args: {
  quoteCurrency?: string;
  portfolioQuoteCurrency?: string;
  defaultAltCurrencyIsoCode?: string;
}): string => {
  return resolveActivePortfolioDisplayQuoteCurrency({
    quoteCurrency: args.quoteCurrency,
    defaultAltCurrencyIsoCode: args.defaultAltCurrencyIsoCode,
  });
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
    return null;
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

export const getVisibleWalletsForKey = (key: Key | undefined): Wallet[] => {
  const seenWalletIds = new Set<string>();
  const uniqueWallets: Wallet[] = [];

  for (const wallet of key?.wallets || []) {
    const stableWalletId = getWalletStableDeduplicationId(wallet);
    if (stableWalletId && seenWalletIds.has(stableWalletId)) {
      continue;
    }

    if (stableWalletId) {
      seenWalletIds.add(stableWalletId);
    }
    uniqueWallets.push(wallet);
  }

  return uniqueWallets.filter(wallet => isWalletVisibleForKey(key, wallet));
};

export const getVisibleWalletsFromKeys = (
  keys: Record<string, Key> | undefined,
  homeCarouselConfig?: HomeCarouselConfig[] | undefined,
): Wallet[] => {
  const visibleKeys = getVisibleKeysFromKeys(keys, homeCarouselConfig);
  return visibleKeys.flatMap(getVisibleWalletsForKey);
};

export const buildWalletIdsByAssetGroupKey = (
  wallets: Wallet[] | undefined,
): Record<string, string[]> => {
  const map: Record<string, string[]> = {};
  for (const w of wallets || []) {
    const id = getPortfolioWalletId(w);
    if (!isPortfolioWalletOnMainnet(w)) {
      continue;
    }

    const groupKey = getPortfolioWalletCurrencyAbbreviationLower(w);
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

export const sortWalletsByAssetFiatPriority = (
  wallets: Wallet[] | undefined,
): Wallet[] => {
  const indexedWallets = buildAssetFiatPriorityEntries(wallets);
  const priorityByKey = buildAssetFiatPriorityByKey(wallets);

  return indexedWallets
    .slice()
    .sort((a, b) => {
      const groupFiatDiff =
        (priorityByKey[b.groupKey]?.fiatBalance || 0) -
        (priorityByKey[a.groupKey]?.fiatBalance || 0);
      if (groupFiatDiff !== 0) {
        return groupFiatDiff;
      }

      const walletFiatDiff = b.fiatBalance - a.fiatBalance;
      if (walletFiatDiff !== 0) {
        return walletFiatDiff;
      }

      return a.index - b.index;
    })
    .map(item => item.wallet);
};

const EMPTY_SUPPORTED_CURRENCY_OPTIONS: SupportedCurrencyOption[] = [];
const supportedCurrencyOptionLookupCache = new WeakMap<
  SupportedCurrencyOption[],
  SupportedCurrencyOptionLookup
>();

const getSupportedCurrencyOptionLookup = (
  options: SupportedCurrencyOption[] | undefined,
): SupportedCurrencyOptionLookup => {
  const optionsRef = options || EMPTY_SUPPORTED_CURRENCY_OPTIONS;
  const cached = supportedCurrencyOptionLookupCache.get(optionsRef);
  if (cached) {
    return cached;
  }

  const lookup = createSupportedCurrencyOptionLookup(optionsRef);
  supportedCurrencyOptionLookupCache.set(optionsRef, lookup);
  return lookup;
};

export const findSupportedCurrencyOptionForAsset = (args: {
  options: SupportedCurrencyOption[];
  currencyAbbreviation?: string;
  chain?: string;
  tokenAddress?: string;
}): SupportedCurrencyOption | undefined => {
  return getSupportedCurrencyOptionLookup(args.options).getOption({
    currencyAbbreviation: args.currencyAbbreviation,
    chain: args.chain,
    tokenAddress: args.tokenAddress,
  });
};

const getWalletUnitInfo = (
  wallet: Wallet,
): {
  unitDecimals: number;
  unitToSatoshi: number;
} => {
  const chain = getPortfolioWalletChainLower(wallet);
  const tokenAddress = getPortfolioWalletTokenAddress(wallet);

  const inferUnitToSatoshiFromLiveBalance = (): number | undefined => {
    const sat = toNumber(wallet.balance?.sat);
    const cryptoStr = wallet.balance?.crypto;
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
    const credentialsTokenDecimals = getPortfolioWalletTokenDecimals(wallet);

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
        typeof credentialsTokenDecimals === 'number'
          ? credentialsTokenDecimals
          : typeof tokenDataUnitDecimals === 'number'
          ? tokenDataUnitDecimals
          : typeof supportedUnitDecimals === 'number'
          ? supportedUnitDecimals
          : 0,
      unitToSatoshi:
        typeof credentialsTokenDecimals === 'number' &&
        credentialsTokenDecimals >= 0
          ? Math.pow(10, credentialsTokenDecimals)
          : typeof tokenDataUnitToSatoshi === 'number' &&
            tokenDataUnitToSatoshi > 0
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

const getWalletAtomicBalanceFromCryptoBalance = (args: {
  wallet: Wallet;
  unitDecimals: number;
}): bigint => {
  const crypto = args.wallet.balance?.crypto;
  const unitString =
    typeof crypto === 'string' ? crypto.replace(/,/g, '') : '0';
  return unitStringToAtomicBigInt(unitString, args.unitDecimals);
};

export const getWalletLiveAtomicBalance = (args: {
  wallet: Wallet;
  unitDecimals: number;
}): bigint => {
  const chain = getPortfolioWalletChainLower(args.wallet);
  const sat = args.wallet.balance?.sat;
  const satConfirmedLocked = args.wallet.balance?.satConfirmedLocked;
  const satConfirmed = args.wallet.balance?.satConfirmed;
  const satPending = args.wallet.balance?.satPending;

  if (
    typeof sat === 'number' &&
    Number.isFinite(sat) &&
    sat >= 0 &&
    Math.trunc(sat) === sat
  ) {
    // Use canonical JS numeric string form (round-trippable), not locale formatting.
    const includeConfirmedLocked =
      (chain === 'xrp' || chain === 'sol') &&
      typeof satConfirmedLocked === 'number' &&
      Number.isFinite(satConfirmedLocked) &&
      satConfirmedLocked >= 0 &&
      Math.trunc(satConfirmedLocked) === satConfirmedLocked;
    try {
      const satAtomicBase = BigInt(sat.toString());
      const satAtomic = includeConfirmedLocked
        ? satAtomicBase + BigInt(satConfirmedLocked.toString())
        : satAtomicBase;
      const shouldTreatPendingAsAvailable =
        !!BitpaySupportedUtxoCoins[chain] &&
        typeof satPending === 'number' &&
        Number.isFinite(satPending) &&
        satPending > 0 &&
        Math.trunc(satPending) === satPending &&
        typeof satConfirmed === 'number' &&
        Number.isFinite(satConfirmed) &&
        satConfirmed >= 0 &&
        Math.trunc(satConfirmed) === satConfirmed &&
        satAtomicBase === BigInt(satConfirmed.toString());

      const satWithPendingAtomic = shouldTreatPendingAsAvailable
        ? satAtomic + BigInt(satPending.toString())
        : satAtomic;

      if (satWithPendingAtomic > 0n) {
        return satWithPendingAtomic;
      }

      const cryptoAtomic = getWalletAtomicBalanceFromCryptoBalance(args);
      return cryptoAtomic > 0n ? cryptoAtomic : satWithPendingAtomic;
    } catch {}
  }

  return getWalletAtomicBalanceFromCryptoBalance(args);
};

export const getWalletLiveFiatBalance = (args: {
  wallet: Wallet;
  rates?: Rates;
  quoteCurrency?: string;
}): number => {
  const quoteCurrency = resolveActivePortfolioDisplayQuoteCurrency({
    quoteCurrency: args.quoteCurrency,
  });
  const wallet = args.wallet;
  const currentRate = getAssetCurrentDisplayQuoteRate({
    rates: args.rates,
    currencyAbbreviation: wallet.currencyAbbreviation,
    chain: wallet.chain,
    tokenAddress: wallet.tokenAddress,
    quoteCurrency,
  });

  if (
    typeof currentRate !== 'number' ||
    !Number.isFinite(currentRate) ||
    currentRate <= 0
  ) {
    return 0;
  }

  const {unitDecimals} = getWalletUnitInfo(wallet);
  const liveAtomicBalance = getWalletLiveAtomicBalance({
    wallet,
    unitDecimals,
  });

  return atomicToUnitNumber(liveAtomicBalance, unitDecimals) * currentRate;
};

export const walletHasNonZeroLiveBalance = (wallet: Wallet): boolean => {
  const {unitDecimals} = getWalletUnitInfo(wallet);
  const liveAtomicBalance = getWalletLiveAtomicBalance({
    wallet,
    unitDecimals,
  });
  return liveAtomicBalance > 0n;
};

export const getWalletsMatchingExchangeRateAsset = (args: {
  wallets: Wallet[] | undefined;
  currencyAbbreviation?: string;
  tokenAddress?: string;
  includeZeroBalance?: boolean;
}): Wallet[] => {
  const targetCurrencyAbbreviation = (
    args.currencyAbbreviation || ''
  ).toLowerCase();
  if (!targetCurrencyAbbreviation) {
    return [];
  }

  const isTokenSelection = !!toOptionalString(args.tokenAddress);

  return (args.wallets || [])
    .filter(w => w.network !== Network.testnet)
    .filter(wallet =>
      args.includeZeroBalance ? true : walletHasNonZeroLiveBalance(wallet),
    )
    .filter(wallet => {
      const matchesCurrency =
        getPortfolioWalletCurrencyAbbreviationLower(wallet) ===
        targetCurrencyAbbreviation;
      if (!matchesCurrency) {
        return false;
      }

      // Asset rows are collapsed across chains. For token assets (like USDC),
      // aggregate all token wallets with the same ticker across supported
      // chains instead of narrowing to a single token contract.
      if (isTokenSelection) {
        return !!getPortfolioWalletTokenAddress(wallet);
      }

      return true;
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
