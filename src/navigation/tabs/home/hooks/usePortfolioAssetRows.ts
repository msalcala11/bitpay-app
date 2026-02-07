import {useEffect, useMemo, useState} from 'react';
import {SupportedCurrencyOptions} from '../../../../constants/SupportedCurrencyOptions';
import type {Rates} from '../../../../store/rate/rate.models';
import type {Key, Wallet} from '../../../../store/wallet/wallet.models';
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
} from '../../../../utils/assets';
import {useAppSelector} from '../../../../utils/hooks';

type Args = {
  gainLossMode: GainLossMode;
  keyId?: string;
};

type Result = {
  wallets: Wallet[];
  walletIdsByAssetKey: Record<string, string[]>;
  quoteCurrency: string;
  isFiatLoading: boolean;
  items: AssetRowItem[];
  visibleItems: AssetRowItem[];
  isPopulateLoadingByKey: Record<string, boolean> | undefined;
};

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

  const snapshotsByWalletId = useMemo(() => {
    return portfolio.snapshotsByWalletId || {};
  }, [portfolio.snapshotsByWalletId]);

  const wallets = useMemo(() => {
    if (keyId && keys[keyId]) {
      return getVisibleWalletsFromKeys({[keyId]: keys[keyId]});
    }
    return getVisibleWalletsFromKeys(keys, homeCarouselConfig);
  }, [homeCarouselConfig, keyId, keys]);

  const walletIdsByAssetKey = useMemo(() => {
    return buildWalletIdsByAssetGroupKey(wallets);
  }, [wallets]);

  const quoteCurrency = useMemo(() => {
    return getQuoteCurrency({
      portfolioQuoteCurrency: portfolio.quoteCurrency,
      defaultAltCurrencyIsoCode: defaultAltCurrency?.isoCode,
    });
  }, [defaultAltCurrency?.isoCode, portfolio.quoteCurrency]);

  const isFiatLoading = useMemo(() => {
    return isFiatLoadingForWallets({
      quoteCurrency,
      wallets,
      snapshotsByWalletId,
    });
  }, [quoteCurrency, snapshotsByWalletId, wallets]);

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
    return getDisplayAssetRowItems({
      items,
      gainLossMode,
      options: SupportedCurrencyOptions,
    });
  }, [gainLossMode, items]);

  const [isPopulateLoadingByKey, setIsPopulateLoadingByKey] = useState<
    Record<string, boolean> | undefined
  >(undefined);

  useEffect(() => {
    if (portfolio.populateStatus?.inProgress) {
      return;
    }
    setIsPopulateLoadingByKey(prev => (prev ? undefined : prev));
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
    wallets,
    walletIdsByAssetKey,
    quoteCurrency,
    isFiatLoading,
    items,
    visibleItems,
    isPopulateLoadingByKey,
  };
};

export default usePortfolioAssetRows;
