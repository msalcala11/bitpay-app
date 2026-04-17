import {useEffect, useMemo, useRef, useState} from 'react';
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
  const [analysisRefreshToken, setAnalysisRefreshToken] = useState(
    populateCompletionStateToken,
  );

  useEffect(() => {
    if (portfolio.populateStatus?.inProgress) {
      return;
    }

    setAnalysisRefreshToken(populateCompletionStateToken);
  }, [populateCompletionStateToken, portfolio.populateStatus?.inProgress]);

  const analysis = usePortfolioAnalysis({
    wallets,
    timeframe: gainLossMode,
    maxPoints: 2,
    enabled: isFocused,
    refreshToken: analysisRefreshToken,
    freezeWhilePopulate: true,
    allowCurrentWhilePopulate: false,
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
  const visibleItemsRaw = useMemo(() => getDisplayAssetRowItems(items), [items]);
  const lastNonEmptyVisibleItemsRef = useRef<AssetRowItem[]>([]);
  useEffect(() => {
    if (!visibleItemsRaw.length) {
      return;
    }

    lastNonEmptyVisibleItemsRef.current = visibleItemsRaw;
  }, [visibleItemsRaw]);

  const visibleItems = useMemo(() => {
    if (visibleItemsRaw.length) {
      return visibleItemsRaw;
    }

    if (portfolio.populateStatus?.inProgress) {
      return lastNonEmptyVisibleItemsRef.current;
    }

    return visibleItemsRaw;
  }, [portfolio.populateStatus?.inProgress, visibleItemsRaw]);

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

    const hasCommittedPortfolioData =
      !!analysis.committedData || !!analysis.data || !!portfolio.lastPopulatedAt;
    if (hasCommittedPortfolioData && !hasKnownSnapshotMismatch) {
      return;
    }

    dispatch(
      maybePopulatePortfolioForWallets({
        wallets,
        quoteCurrency: analysis.quoteCurrency,
      }) as any,
    );
  }, [
    analysis.committedData,
    analysis.data,
    analysis.quoteCurrency,
    dispatch,
    hasKnownSnapshotMismatch,
    isFocused,
    portfolio.lastPopulatedAt,
    portfolio.populateStatus?.inProgress,
    walletIdsSig,
    wallets,
  ]);

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
