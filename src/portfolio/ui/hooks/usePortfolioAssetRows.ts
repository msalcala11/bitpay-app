import {useEffect, useMemo, useRef, useState} from 'react';
import {useIsFocused} from '@react-navigation/native';
import {maybePopulatePortfolioForWallets} from '../../../store/portfolio';
import type {Rates} from '../../../store/rate/rate.models';
import type {AssetRowItem, GainLossMode} from '../../../utils/portfolio/assets';
import {
  buildWalletIdsByAssetGroupKey,
  getDisplayAssetRowItems,
  getPopulateLoadingByAssetKey,
  getVisibleWalletsFromKeys,
} from '../../../utils/portfolio/assets';
import type {Key} from '../../../store/wallet/wallet.models';
import {getRateByCurrencyName} from '../../../utils/helper-methods';
import {useAppDispatch, useAppSelector} from '../../../utils/hooks';
import type {PortfolioAssetRowsResult} from '../../core/pnl/assetRows';
import {getAssetIdFromWallet} from '../../core/pnl/assetId';
import type {StoredWallet} from '../../core/types';
import {
  getStoredWalletRequestSignature,
  mapWalletsToStoredWallets,
  resolveCommittedPortfolioQuoteCurrency,
  runPortfolioAssetRowsQuery,
} from '../common';
import formatAssetRowsFromRpc from '../selectors/formatAssetRowsFromRpc';

type Args = {
  gainLossMode: GainLossMode;
  keyId?: string;
  maxVisibleItems?: number;
};

type Result = {
  visibleItems: AssetRowItem[];
  isFiatLoading: boolean;
  isPnlLoading: boolean;
  isPopulateLoadingByKey: Record<string, boolean> | undefined;
  hasAnyPortfolioData: boolean;
};

type AssetRowsQueryState = {
  baseKey: string;
  executionKey: string;
  data?: PortfolioAssetRowsResult;
  loading: boolean;
  error?: Error;
};

const MAX_COMMITTED_ASSET_ROWS_CACHE_ENTRIES = 24;
const MAX_LATEST_EXECUTION_KEY_ENTRIES = 48;
const MAX_LAST_VISIBLE_ITEMS_BY_BASE_KEY_ENTRIES = 12;
const MAX_LAST_VISIBLE_ITEMS_BY_SHELL_KEY_ENTRIES = 8;

const committedAssetRowsCache = new Map<string, PortfolioAssetRowsResult>();
const latestExecutionKeyByBaseKey = new Map<string, string>();
const inFlightAssetRowsByKey = new Map<
  string,
  Promise<PortfolioAssetRowsResult>
>();

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function getCurrentRatesByAssetId(args: {
  storedWallets: StoredWallet[];
  rates: Rates | undefined;
  quoteCurrency: string;
}): Record<string, number> {
  const currentRatesByAssetId: Record<string, number> = {};
  const quoteCurrency = String(args.quoteCurrency || '').toUpperCase();

  if (!args.rates || !quoteCurrency) {
    return currentRatesByAssetId;
  }

  for (const wallet of args.storedWallets || []) {
    const summary = wallet.summary;
    const assetId = getAssetIdFromWallet(summary);
    if (!assetId || currentRatesByAssetId[assetId] !== undefined) {
      continue;
    }

    const ratesForAsset = getRateByCurrencyName(
      args.rates,
      summary.currencyAbbreviation,
      summary.chain,
      summary.tokenAddress,
    );
    const quoteRate = ratesForAsset?.find(rate => {
      return String(rate?.code || '').toUpperCase() === quoteCurrency;
    })?.rate;

    if (isFinitePositiveNumber(quoteRate)) {
      currentRatesByAssetId[assetId] = quoteRate;
    }
  }

  return currentRatesByAssetId;
}

function getCurrentRatesSignature(
  currentRatesByAssetId: Record<string, number>,
): string {
  return Object.entries(currentRatesByAssetId || {})
    .filter(([, rate]) => isFinitePositiveNumber(rate))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([assetId, rate]) => `${assetId}:${rate}`)
    .join('|');
}

function setBoundedMapValue<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  maxEntries: number,
  onEvict?: (evictedKey: K, evictedValue: V) => void,
): void {
  if (map.has(key)) {
    map.delete(key);
  }

  map.set(key, value);

  while (map.size > maxEntries) {
    const oldestEntry = map.entries().next().value as [K, V] | undefined;
    if (!oldestEntry) {
      return;
    }

    const [oldestKey, oldestValue] = oldestEntry;
    map.delete(oldestKey);
    onEvict?.(oldestKey, oldestValue);
  }
}

function getCommittedAssetRowsCacheValue(
  cacheKey: string,
): PortfolioAssetRowsResult | undefined {
  const cached = committedAssetRowsCache.get(cacheKey);
  if (cached) {
    committedAssetRowsCache.delete(cacheKey);
    committedAssetRowsCache.set(cacheKey, cached);
  }
  return cached;
}

function setCommittedAssetRowsCacheValue(
  cacheKey: string,
  result: PortfolioAssetRowsResult,
): void {
  setBoundedMapValue(
    committedAssetRowsCache,
    cacheKey,
    result,
    MAX_COMMITTED_ASSET_ROWS_CACHE_ENTRIES,
    evictedKey => {
      latestExecutionKeyByBaseKey.delete(evictedKey);
    },
  );
}

function getLatestExecutionKeyForBaseKey(baseKey: string): string | undefined {
  const latest = latestExecutionKeyByBaseKey.get(baseKey);
  if (latest) {
    latestExecutionKeyByBaseKey.delete(baseKey);
    latestExecutionKeyByBaseKey.set(baseKey, latest);
  }
  return latest;
}

function setLatestExecutionKeyForBaseKey(
  baseKey: string,
  executionKey: string,
): void {
  setBoundedMapValue(
    latestExecutionKeyByBaseKey,
    baseKey,
    executionKey,
    MAX_LATEST_EXECUTION_KEY_ENTRIES,
  );
}

function getOrStartAssetRowsRequest(args: {
  cacheKey: string;
  storedWallets: StoredWallet[];
  quoteCurrency: string;
  timeframe: GainLossMode;
  currentRatesByAssetId: Record<string, number>;
}): Promise<PortfolioAssetRowsResult> {
  const existing = inFlightAssetRowsByKey.get(args.cacheKey);
  if (existing) {
    return existing;
  }

  const promise = runPortfolioAssetRowsQuery({
    wallets: args.storedWallets,
    quoteCurrency: args.quoteCurrency,
    timeframe: args.timeframe,
    maxPoints: 2,
    currentRatesByAssetId: args.currentRatesByAssetId,
  });

  inFlightAssetRowsByKey.set(args.cacheKey, promise);
  const clearInFlight = () => {
    if (inFlightAssetRowsByKey.get(args.cacheKey) === promise) {
      inFlightAssetRowsByKey.delete(args.cacheKey);
    }
  };
  void promise.then(clearInFlight, clearInFlight);

  return promise;
}

export function clearPortfolioAssetRowsCommittedCacheForTests(): void {
  committedAssetRowsCache.clear();
  latestExecutionKeyByBaseKey.clear();
  inFlightAssetRowsByKey.clear();
}

export function usePortfolioAssetRows({
  gainLossMode,
  keyId,
  maxVisibleItems,
}: Args): Result {
  const isFocused = useIsFocused();
  const dispatch = useAppDispatch();
  const portfolio = useAppSelector(({PORTFOLIO}) => PORTFOLIO);
  const homeCarouselConfig = useAppSelector(({APP}) => APP.homeCarouselConfig);
  const defaultAltCurrency = useAppSelector(({APP}) => APP.defaultAltCurrency);
  const rates = useAppSelector(state => state.RATE?.rates || {});
  const keys = useAppSelector(({WALLET}) => WALLET.keys) as Record<string, Key>;

  const quoteCurrency = useMemo(() => {
    return resolveCommittedPortfolioQuoteCurrency({
      portfolioQuoteCurrency: portfolio.quoteCurrency,
      defaultAltCurrencyIsoCode: defaultAltCurrency?.isoCode,
    });
  }, [defaultAltCurrency?.isoCode, portfolio.quoteCurrency]);

  const wallets = useMemo(() => {
    if (keyId && keys[keyId]) {
      return getVisibleWalletsFromKeys({[keyId]: keys[keyId]});
    }

    return getVisibleWalletsFromKeys(keys, homeCarouselConfig);
  }, [homeCarouselConfig, keyId, keys]);

  const {storedWallets} = useMemo(() => {
    return mapWalletsToStoredWallets({
      dispatch,
      wallets,
    });
  }, [dispatch, wallets]);

  const walletIdsSig = useMemo(() => {
    return wallets
      .map(wallet => wallet?.id)
      .filter((id): id is string => typeof id === 'string' && !!id)
      .join(',');
  }, [wallets]);
  const hasKnownSnapshotMismatch = useMemo(() => {
    return wallets.some(wallet => {
      const walletId = String(wallet?.id || '').trim();
      return !!walletId && !!portfolio.snapshotBalanceMismatchesByWalletId?.[walletId];
    });
  }, [portfolio.snapshotBalanceMismatchesByWalletId, wallets]);

  const populateCompletionStateToken = useMemo(() => {
    const status = portfolio.populateStatus;

    return [
      typeof portfolio.lastPopulatedAt === 'number'
        ? String(portfolio.lastPopulatedAt)
        : '',
      typeof status?.finishedAt === 'number' ? String(status.finishedAt) : '',
      status?.stopReason || '',
      typeof status?.errors?.length === 'number'
        ? String(status.errors.length)
        : '0',
    ].join('|');
  }, [
    portfolio.lastPopulatedAt,
    portfolio.populateStatus?.errors?.length,
    portfolio.populateStatus?.finishedAt,
    portfolio.populateStatus?.stopReason,
  ]);
  const [assetRowsRefreshToken, setAssetRowsRefreshToken] = useState(
    populateCompletionStateToken,
  );

  useEffect(() => {
    if (portfolio.populateStatus?.inProgress) {
      return;
    }

    setAssetRowsRefreshToken(populateCompletionStateToken);
  }, [populateCompletionStateToken, portfolio.populateStatus?.inProgress]);

  const storedWalletRequestSignature = useMemo(() => {
    return getStoredWalletRequestSignature(storedWallets);
  }, [storedWallets]);
  const currentRatesByAssetId = useMemo(() => {
    return getCurrentRatesByAssetId({
      storedWallets,
      rates,
      quoteCurrency,
    });
  }, [quoteCurrency, rates, storedWallets]);
  const currentRatesSignature = useMemo(() => {
    return getCurrentRatesSignature(currentRatesByAssetId);
  }, [currentRatesByAssetId]);
  const assetRowsBaseKey = useMemo(() => {
    return [
      quoteCurrency,
      gainLossMode,
      '2',
      storedWalletRequestSignature,
      assetRowsRefreshToken,
    ].join('|');
  }, [
    assetRowsRefreshToken,
    gainLossMode,
    quoteCurrency,
    storedWalletRequestSignature,
  ]);
  const assetRowsExecutionKey = useMemo(() => {
    return [assetRowsBaseKey, currentRatesSignature].join('|');
  }, [assetRowsBaseKey, currentRatesSignature]);

  const hasPopulateRevision = typeof portfolio.lastPopulatedAt === 'number';
  const queryEnabled =
    isFocused &&
    !portfolio.populateStatus?.inProgress &&
    storedWallets.length > 0 &&
    hasPopulateRevision &&
    !hasKnownSnapshotMismatch;
  const currentBaseKeyRef = useRef(assetRowsBaseKey);
  const currentExecutionKeyRef = useRef(assetRowsExecutionKey);
  const [assetRowsQuery, setAssetRowsQuery] = useState<AssetRowsQueryState>(() => ({
    baseKey: assetRowsBaseKey,
    executionKey: assetRowsExecutionKey,
    data: getCommittedAssetRowsCacheValue(assetRowsBaseKey),
    loading: false,
  }));

  useEffect(() => {
    currentBaseKeyRef.current = assetRowsBaseKey;
    currentExecutionKeyRef.current = assetRowsExecutionKey;

    const committed = getCommittedAssetRowsCacheValue(assetRowsBaseKey);
    const inFlightForExecution = inFlightAssetRowsByKey.get(assetRowsExecutionKey);
    const latestExecutionKey = getLatestExecutionKeyForBaseKey(assetRowsBaseKey);

    const setQueryStateForCurrentIdentity = (
      next: Omit<AssetRowsQueryState, 'baseKey' | 'executionKey'>,
    ) => {
      setAssetRowsQuery(prev => {
        if (
          prev.baseKey === assetRowsBaseKey &&
          prev.executionKey === assetRowsExecutionKey &&
          prev.data === next.data &&
          prev.loading === next.loading &&
          prev.error === next.error
        ) {
          return prev;
        }

        return {
          baseKey: assetRowsBaseKey,
          executionKey: assetRowsExecutionKey,
          data: next.data,
          loading: next.loading,
          error: next.error,
        };
      });
    };

    if (!queryEnabled) {
      setQueryStateForCurrentIdentity({
        data: committed,
        loading: false,
        error: undefined,
      });
      return;
    }

    if (committed && latestExecutionKey === assetRowsExecutionKey && !inFlightForExecution) {
      setQueryStateForCurrentIdentity({
        data: committed,
        loading: false,
        error: undefined,
      });
      return;
    }

    let cancelled = false;
    setLatestExecutionKeyForBaseKey(assetRowsBaseKey, assetRowsExecutionKey);
    setQueryStateForCurrentIdentity({
      data: committed,
      loading: !committed,
      error: undefined,
    });

    const isStale = () => {
      return (
        cancelled ||
        currentBaseKeyRef.current !== assetRowsBaseKey ||
        currentExecutionKeyRef.current !== assetRowsExecutionKey ||
        getLatestExecutionKeyForBaseKey(assetRowsBaseKey) !== assetRowsExecutionKey
      );
    };

    void (async () => {
      try {
        const result = await getOrStartAssetRowsRequest({
          cacheKey: assetRowsExecutionKey,
          storedWallets,
          quoteCurrency,
          timeframe: gainLossMode,
          currentRatesByAssetId,
        });
        if (isStale() || result.timeframe !== gainLossMode) {
          return;
        }

        setCommittedAssetRowsCacheValue(assetRowsBaseKey, result);
        setQueryStateForCurrentIdentity({
          data: result,
          loading: false,
          error: undefined,
        });
      } catch (err) {
        if (isStale()) {
          return;
        }

        setQueryStateForCurrentIdentity({
          data: committed,
          loading: false,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      } finally {
        if (isStale()) {
          return;
        }

        setAssetRowsQuery(prev => {
          if (
            prev.baseKey !== assetRowsBaseKey ||
            prev.executionKey !== assetRowsExecutionKey ||
            prev.loading === false
          ) {
            return prev;
          }

          return {
            ...prev,
            loading: false,
          };
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    assetRowsBaseKey,
    assetRowsExecutionKey,
    currentRatesByAssetId,
    gainLossMode,
    queryEnabled,
    quoteCurrency,
    storedWallets,
  ]);

  const committedAssetRowsData = getCommittedAssetRowsCacheValue(
    assetRowsBaseKey,
  );
  const assetRowsData =
    assetRowsQuery.baseKey === assetRowsBaseKey
      ? assetRowsQuery.data ?? committedAssetRowsData
      : committedAssetRowsData;
  const isAssetRowsLoading =
    assetRowsQuery.baseKey === assetRowsBaseKey
      ? assetRowsQuery.loading
      : queryEnabled && !committedAssetRowsData;

  const items = useMemo(() => {
    return formatAssetRowsFromRpc({
      result: assetRowsData,
      quoteCurrency,
    });
  }, [assetRowsData, quoteCurrency]);
  const visibleItemsRaw = useMemo(() => getDisplayAssetRowItems(items), [items]);
  const assetRowsShellKey = useMemo(() => {
    return [
      keyId || '',
      quoteCurrency,
      storedWalletRequestSignature,
      assetRowsRefreshToken,
    ].join('|');
  }, [
    assetRowsRefreshToken,
    keyId,
    quoteCurrency,
    storedWalletRequestSignature,
  ]);
  const lastNonEmptyVisibleItemsByBaseKeyRef = useRef<
    Map<string, AssetRowItem[]>
  >(new Map());
  const lastNonEmptyVisibleItemsByShellKeyRef = useRef<Map<string, AssetRowItem[]>>(
    new Map(),
  );
  useEffect(() => {
    if (!visibleItemsRaw.length) {
      return;
    }

    setBoundedMapValue(
      lastNonEmptyVisibleItemsByBaseKeyRef.current,
      assetRowsBaseKey,
      visibleItemsRaw,
      MAX_LAST_VISIBLE_ITEMS_BY_BASE_KEY_ENTRIES,
    );
    setBoundedMapValue(
      lastNonEmptyVisibleItemsByShellKeyRef.current,
      assetRowsShellKey,
      visibleItemsRaw,
      MAX_LAST_VISIBLE_ITEMS_BY_SHELL_KEY_ENTRIES,
    );
  }, [assetRowsBaseKey, assetRowsShellKey, visibleItemsRaw]);

  const allVisibleItems = useMemo(() => {
    if (visibleItemsRaw.length) {
      return visibleItemsRaw;
    }

    if (portfolio.populateStatus?.inProgress) {
      return (
        lastNonEmptyVisibleItemsByBaseKeyRef.current.get(
          assetRowsBaseKey,
        ) ||
        lastNonEmptyVisibleItemsByShellKeyRef.current.get(assetRowsShellKey) ||
        []
      );
    }

    if (isAssetRowsLoading) {
      return lastNonEmptyVisibleItemsByShellKeyRef.current.get(assetRowsShellKey) || [];
    }

    return visibleItemsRaw;
  }, [
    assetRowsBaseKey,
    assetRowsShellKey,
    isAssetRowsLoading,
    portfolio.populateStatus?.inProgress,
    visibleItemsRaw,
  ]);
  const visibleItems = useMemo(() => {
    if (
      typeof maxVisibleItems !== 'number' ||
      !Number.isFinite(maxVisibleItems) ||
      maxVisibleItems <= 0
    ) {
      return allVisibleItems;
    }

    return allVisibleItems.slice(0, maxVisibleItems);
  }, [allVisibleItems, maxVisibleItems]);

  const walletIdsByAssetKey = useMemo(() => {
    if (!portfolio.populateStatus?.inProgress) {
      return undefined;
    }

    return buildWalletIdsByAssetGroupKey(wallets);
  }, [portfolio.populateStatus?.inProgress, wallets]);

  const populateLoadingByKeyPrevRef = useRef<
    Record<string, boolean> | undefined
  >(undefined);
  const isPopulateLoadingByKey = useMemo(() => {
    if (!portfolio.populateStatus?.inProgress || !walletIdsByAssetKey) {
      return undefined;
    }

    return getPopulateLoadingByAssetKey({
      items: visibleItems,
      walletIdsByAssetKey,
      populateStatus: portfolio.populateStatus,
      prev: populateLoadingByKeyPrevRef.current,
    });
  }, [portfolio.populateStatus, visibleItems, walletIdsByAssetKey]);

  useEffect(() => {
    populateLoadingByKeyPrevRef.current = isPopulateLoadingByKey;
  }, [isPopulateLoadingByKey]);

  useEffect(() => {
    if (!isFocused || !walletIdsSig || portfolio.populateStatus?.inProgress) {
      return;
    }

    const hasCommittedPortfolioData = !!assetRowsData || !!portfolio.lastPopulatedAt;
    if (hasCommittedPortfolioData && !hasKnownSnapshotMismatch) {
      return;
    }

    dispatch(
      maybePopulatePortfolioForWallets({
        wallets,
        quoteCurrency,
      }) as any,
    );
  }, [
    assetRowsData,
    dispatch,
    hasKnownSnapshotMismatch,
    isFocused,
    portfolio.lastPopulatedAt,
    portfolio.populateStatus?.inProgress,
    quoteCurrency,
    walletIdsSig,
    wallets,
  ]);

  return {
    visibleItems,
    isFiatLoading: isAssetRowsLoading && !assetRowsData,
    isPnlLoading: isAssetRowsLoading,
    isPopulateLoadingByKey,
    hasAnyPortfolioData:
      !!assetRowsData ||
      isAssetRowsLoading ||
      !!portfolio.lastPopulatedAt ||
      !!portfolio.populateStatus?.inProgress,
  };
}

export default usePortfolioAssetRows;
