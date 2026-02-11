import {useEffect, useMemo, useState} from 'react';
import type {PortfolioState} from '../../../../store/portfolio/portfolio.models';
import type {Rates} from '../../../../store/rate/rate.models';
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
import {useAppSelector} from '../../../../utils/hooks';

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
  const portfolio = useAppSelector(({PORTFOLIO}) => PORTFOLIO);
  const defaultAltCurrency = useAppSelector(({APP}) => APP.defaultAltCurrency);
  const homeCarouselConfig = useAppSelector(({APP}) => APP.homeCarouselConfig);
  const rates = useAppSelector(({RATE}) => RATE.rates) as Rates;
  const lastDayRates = useAppSelector(({RATE}) => RATE.lastDayRates) as Rates;
  const fiatRateSeriesCache = useAppSelector(
    ({RATE}) => RATE.fiatRateSeriesCache,
  );
  const keys = useAppSelector(({WALLET}) => WALLET.keys) as Record<string, Key>;

  const snapshotsByWalletId =
    portfolio.snapshotsByWalletId ?? EMPTY_SNAPSHOTS_BY_WALLET_ID;

  const wallets = useMemo(() => {
    if (keyId && keys[keyId]) {
      return getVisibleWalletsFromKeys({[keyId]: keys[keyId]});
    }
    return getVisibleWalletsFromKeys(keys, homeCarouselConfig);
  }, [homeCarouselConfig, keyId, keys]);

  const walletIdsByAssetKey = useMemo(() => {
    return buildWalletIdsByAssetGroupKey(wallets);
  }, [wallets]);

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

  useEffect(() => {
    if (portfolio.populateStatus?.inProgress) {
      return;
    }
    setIsPopulateLoadingByKey(undefined);
  }, [portfolio.populateStatus?.inProgress]);

  useEffect(() => {
    if (!portfolio.populateStatus?.inProgress) {
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
  }, [portfolio.populateStatus, visibleItems, walletIdsByAssetKey]);

  return {
    visibleItems,
    isFiatLoading,
    isPopulateLoadingByKey,
  };
};

export default usePortfolioAssetRows;
