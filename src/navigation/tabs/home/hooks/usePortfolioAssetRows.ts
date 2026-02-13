import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {HISTORIC_RATES_CACHE_DURATION} from '../../../../constants/wallet';
import type {PortfolioState} from '../../../../store/portfolio/portfolio.models';
import type {
  CachedFiatRateInterval,
  FiatRatePoint,
  Rates,
} from '../../../../store/rate/rate.models';
import {
  FIAT_RATE_SERIES_CACHED_INTERVALS,
  getFiatRateSeriesCacheKey,
} from '../../../../store/rate/rate.models';
import {fetchFiatRateSeriesAllIntervals} from '../../../../store/wallet/effects';
import type {Key} from '../../../../store/wallet/wallet.models';
import {
  type AssetRowItem,
  buildAssetRowItemsFromPortfolioSnapshots,
  buildWalletIdsByAssetGroupKey,
  type GainLossMode,
  getDisplayAssetRowItems,
  getPopulateLoadingByAssetKey,
  getQuoteCurrency,
  getVisibleWalletsFromKeys,
  isFiatLoadingForWallets,
} from '../../../../utils/portfolio/assets';
import {normalizeFiatRateSeriesCoin} from '../../../../utils/portfolio/core/pnl/rates';
import {useAppDispatch, useAppSelector} from '../../../../utils/hooks';

type Args = {
  gainLossMode: GainLossMode;
  keyId?: string;
};

type Result = {
  visibleItems: AssetRowItem[];
  isFiatLoading: boolean;
  isPopulateLoadingByKey: Record<string, boolean> | undefined;
};

const EMPTY_SNAPSHOTS_BY_WALLET_ID: PortfolioState['snapshotsByWalletId'] = {};

const usePortfolioAssetRows = ({gainLossMode, keyId}: Args): Result => {
  const dispatch = useAppDispatch();
  const portfolio = useAppSelector(({PORTFOLIO}) => PORTFOLIO);
  const defaultAltCurrency = useAppSelector(({APP}) => APP.defaultAltCurrency);
  const homeCarouselConfig = useAppSelector(({APP}) => APP.homeCarouselConfig);
  const rates = useAppSelector(({RATE}) => RATE.rates) as Rates;
  const lastDayRates = useAppSelector(({RATE}) => RATE.lastDayRates) as Rates;
  const fiatRateSeriesCache = useAppSelector(
    ({RATE}) => RATE.fiatRateSeriesCache,
  );
  const keys = useAppSelector(({WALLET}) => WALLET.keys) as Record<string, Key>;
  const isPopulateInProgress = !!portfolio.populateStatus?.inProgress;

  const snapshotsByWalletId =
    portfolio.snapshotsByWalletId ?? EMPTY_SNAPSHOTS_BY_WALLET_ID;

  const wallets = useMemo(() => {
    if (keyId && keys[keyId]) {
      return getVisibleWalletsFromKeys({[keyId]: keys[keyId]});
    }
    return getVisibleWalletsFromKeys(keys, homeCarouselConfig);
  }, [homeCarouselConfig, keyId, keys]);

  const walletIdsByAssetKey = useMemo(() => {
    if (!isPopulateInProgress) {
      return undefined;
    }
    return buildWalletIdsByAssetGroupKey(wallets);
  }, [isPopulateInProgress, wallets]);

  const quoteCurrency = getQuoteCurrency({
    portfolioQuoteCurrency: portfolio.quoteCurrency,
    defaultAltCurrencyIsoCode: defaultAltCurrency?.isoCode,
  });

  const isFiatLoading = useMemo(() => {
    return isFiatLoadingForWallets({
      quoteCurrency,
      wallets,
      snapshotsByWalletId,
      fiatRateSeriesCache,
    });
  }, [fiatRateSeriesCache, quoteCurrency, snapshotsByWalletId, wallets]);

  const items = useMemo(() => {
    return buildAssetRowItemsFromPortfolioSnapshots({
      snapshotsByWalletId,
      wallets,
      quoteCurrency,
      gainLossMode,
      rates,
      lastDayRates,
      fiatRateSeriesCache,
      collapseAcrossChains: true,
    });
  }, [
    fiatRateSeriesCache,
    gainLossMode,
    lastDayRates,
    quoteCurrency,
    rates,
    snapshotsByWalletId,
    wallets,
  ]);

  const visibleItems = useMemo(() => {
    return getDisplayAssetRowItems(items);
  }, [items]);

  const [isPopulateLoadingByKey, setIsPopulateLoadingByKey] = useState<
    Record<string, boolean> | undefined
  >(undefined);
  const lastFetchAttemptByQuoteCoinRef = useRef<Record<string, number>>({});
  const inFlightFetchByQuoteCoinRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (isPopulateInProgress) {
      return;
    }
    setIsPopulateLoadingByKey(undefined);
  }, [isPopulateInProgress]);

  useEffect(() => {
    if (!isPopulateInProgress || !walletIdsByAssetKey) {
      return;
    }

    setIsPopulateLoadingByKey(prev => {
      return getPopulateLoadingByAssetKey({
        items: visibleItems,
        walletIdsByAssetKey,
        populateStatus: portfolio.populateStatus,
        prev: prev || undefined,
      });
    });
  }, [
    isPopulateInProgress,
    portfolio.populateStatus,
    visibleItems,
    walletIdsByAssetKey,
  ]);

  const shouldFetchAllIntervalsForCoin = useCallback(
    (
      coin: string,
      intervals: ReadonlyArray<CachedFiatRateInterval>,
    ): boolean => {
      const fiatCode = (quoteCurrency || 'USD').toUpperCase();
      for (const interval of intervals) {
        const cacheKey = getFiatRateSeriesCacheKey(fiatCode, coin, interval);
        const cached = fiatRateSeriesCache?.[cacheKey];
        const points = (cached?.points || []) as FiatRatePoint[];
        if (!points.length) {
          return true;
        }
        if (
          !points.every(
            p => Number.isFinite(p?.ts) && Number.isFinite(p?.rate),
          )
        ) {
          return true;
        }
      }
      return false;
    },
    [fiatRateSeriesCache, quoteCurrency],
  );

  const missingHistoricalCoins = useMemo(() => {
    const coins = new Set<string>();
    const cachedIntervals =
      FIAT_RATE_SERIES_CACHED_INTERVALS as ReadonlyArray<CachedFiatRateInterval>;
    for (const item of visibleItems) {
      const coin = normalizeFiatRateSeriesCoin(item.currencyAbbreviation);
      if (!coin) {
        continue;
      }
      if (shouldFetchAllIntervalsForCoin(coin, cachedIntervals)) {
        coins.add(coin);
      }
    }
    return Array.from(coins).sort((a, b) => a.localeCompare(b));
  }, [shouldFetchAllIntervalsForCoin, visibleItems]);

  useEffect(() => {
    if (!missingHistoricalCoins.length) {
      return;
    }

    let cancelled = false;
    let sweepInFlight = false;
    const minRetryMs = HISTORIC_RATES_CACHE_DURATION * 1000;
    const fiatCode = (quoteCurrency || 'USD').toUpperCase();

    const runSweep = async () => {
      if (cancelled || sweepInFlight) {
        return;
      }

      sweepInFlight = true;
      try {
        for (const coin of missingHistoricalCoins) {
          if (cancelled) {
            return;
          }

          const quoteCoinKey = `${fiatCode}:${coin}`;
          if (inFlightFetchByQuoteCoinRef.current.has(quoteCoinKey)) {
            continue;
          }

          const lastAttempt =
            lastFetchAttemptByQuoteCoinRef.current[quoteCoinKey] || 0;
          if (Date.now() - lastAttempt < minRetryMs) {
            continue;
          }

          inFlightFetchByQuoteCoinRef.current.add(quoteCoinKey);
          lastFetchAttemptByQuoteCoinRef.current[quoteCoinKey] = Date.now();
          try {
            await dispatch(
              fetchFiatRateSeriesAllIntervals({
                fiatCode,
                currencyAbbreviation: coin,
              }) as any,
            );
          } finally {
            inFlightFetchByQuoteCoinRef.current.delete(quoteCoinKey);
          }
        }
      } finally {
        sweepInFlight = false;
      }
    };

    runSweep().catch(() => {
      // Keep the sweep best-effort; failures are retried on next cycle.
    });
    const pollInterval = setInterval(() => {
      runSweep().catch(() => {
        // Keep the sweep best-effort; failures are retried on next cycle.
      });
    }, minRetryMs);

    return () => {
      cancelled = true;
      clearInterval(pollInterval);
    };
  }, [dispatch, missingHistoricalCoins, quoteCurrency]);

  return {
    visibleItems,
    isFiatLoading,
    isPopulateLoadingByKey,
  };
};

export default usePortfolioAssetRows;
