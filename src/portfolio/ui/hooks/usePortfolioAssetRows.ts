import {useEffect, useMemo, useRef} from 'react';
import {useIsFocused} from '@react-navigation/native';
import {maybePopulatePortfolioForWallets} from '../../../store/portfolio';
import type {AssetRowItem, GainLossMode} from '../../../utils/portfolio/assets';
import {
  buildWalletIdsByAssetGroupKey,
  getDisplayAssetRowItems,
  getPopulateLoadingByAssetKey,
  getVisibleWalletsFromKeys,
} from '../../../utils/portfolio/assets';
import type {Key} from '../../../store/wallet/wallet.models';
import {useAppDispatch, useAppSelector} from '../../../utils/hooks';
import buildAssetRowsFromAnalysis from '../selectors/buildAssetRowsFromAnalysis';
import {usePortfolioAnalysis} from './usePortfolioAnalysis';

type Args = {
  gainLossMode: GainLossMode;
  keyId?: string;
};

type Result = {
  visibleItems: AssetRowItem[];
  isFiatLoading: boolean;
  isPopulateLoadingByKey: Record<string, boolean> | undefined;
  hasAnyPortfolioData: boolean;
};

export function usePortfolioAssetRows({gainLossMode, keyId}: Args): Result {
  const isFocused = useIsFocused();
  const dispatch = useAppDispatch();
  const portfolio = useAppSelector(({PORTFOLIO}) => PORTFOLIO);
  const homeCarouselConfig = useAppSelector(({APP}) => APP.homeCarouselConfig);
  const keys = useAppSelector(({WALLET}) => WALLET.keys) as Record<string, Key>;

  const wallets = useMemo(() => {
    if (keyId && keys[keyId]) {
      return getVisibleWalletsFromKeys({[keyId]: keys[keyId]});
    }

    return getVisibleWalletsFromKeys(keys, homeCarouselConfig);
  }, [homeCarouselConfig, keyId, keys]);

  const walletIdsSig = useMemo(() => {
    return wallets
      .map(wallet => wallet?.id)
      .filter((id): id is string => typeof id === 'string' && !!id)
      .join(',');
  }, [wallets]);

  const analysis = usePortfolioAnalysis({
    wallets,
    timeframe: gainLossMode,
    maxPoints: 2,
    freezeWhilePopulate: true,
    allowCurrentWhilePopulate: true,
  });

  const items = useMemo(() => {
    return buildAssetRowsFromAnalysis({
      storedWallets: analysis.storedWallets,
      analysis: analysis.data,
      quoteCurrency: analysis.quoteCurrency,
      gainLossMode,
      collapseAcrossChains: true,
    });
  }, [
    analysis.data,
    analysis.quoteCurrency,
    analysis.storedWallets,
    gainLossMode,
  ]);

  const visibleItems = useMemo(() => getDisplayAssetRowItems(items), [items]);

  const walletIdsByAssetKey = useMemo(() => {
    if (!portfolio.populateStatus?.inProgress) {
      return undefined;
    }

    return buildWalletIdsByAssetGroupKey(wallets);
  }, [portfolio.populateStatus?.inProgress, wallets]);

  const populateLoadingByKeyPrevRef = useRef<Record<string, boolean>>();
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
    if (!isFocused || !walletIdsSig) {
      return;
    }

    dispatch(
      maybePopulatePortfolioForWallets({
        wallets,
        quoteCurrency: analysis.quoteCurrency,
      }) as any,
    );
  }, [analysis.quoteCurrency, dispatch, isFocused, walletIdsSig, wallets]);

  return {
    visibleItems,
    isFiatLoading: analysis.loading && !analysis.data && !analysis.committedData,
    isPopulateLoadingByKey,
    hasAnyPortfolioData:
      !!analysis.data ||
      !!analysis.committedData ||
      !!portfolio.populateStatus?.inProgress,
  };
}

export default usePortfolioAssetRows;
