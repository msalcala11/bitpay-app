import {useEffect, useMemo, useRef} from 'react';
import type {AssetRowItem, GainLossMode} from '../../../utils/portfolio/assets';
import {
  buildWalletIdsByAssetGroupKey,
  getDisplayAssetRowItems,
  getPopulateLoadingByAssetKey,
  getVisibleWalletsFromKeys,
  sortAssetRowItemsByAssetFiatPriority,
} from '../../../utils/portfolio/assets';
import type {Key} from '../../../store/wallet/wallet.models';
import {useAppSelector} from '../../../utils/hooks';
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
  const portfolio = useAppSelector(({PORTFOLIO}) => PORTFOLIO);
  const homeCarouselConfig = useAppSelector(({APP}) => APP.homeCarouselConfig);
  const keys = useAppSelector(({WALLET}) => WALLET.keys) as Record<string, Key>;

  const wallets = useMemo(() => {
    if (keyId && keys[keyId]) {
      return getVisibleWalletsFromKeys({[keyId]: keys[keyId]});
    }

    return getVisibleWalletsFromKeys(keys, homeCarouselConfig);
  }, [homeCarouselConfig, keyId, keys]);

  const populateCompletionStateToken = useMemo(() => {
    return [
      typeof portfolio.lastPopulatedAt === 'number'
        ? String(portfolio.lastPopulatedAt)
        : '',
      typeof portfolio.populateStatus?.finishedAt === 'number'
        ? String(portfolio.populateStatus.finishedAt)
        : '',
      portfolio.populateStatus?.stopReason || '',
      typeof portfolio.populateStatus?.errors?.length === 'number'
        ? String(portfolio.populateStatus.errors.length)
        : '0',
    ].join('|');
  }, [
    portfolio.lastPopulatedAt,
    portfolio.populateStatus?.errors?.length,
    portfolio.populateStatus?.finishedAt,
    portfolio.populateStatus?.stopReason,
  ]);
  const populateSessionStateToken = useMemo(() => {
    return [
      populateCompletionStateToken,
      portfolio.populateStatus?.inProgress ? '1' : '0',
      typeof portfolio.populateStatus?.startedAt === 'number'
        ? String(portfolio.populateStatus.startedAt)
        : '',
    ].join('|');
  }, [
    populateCompletionStateToken,
    portfolio.populateStatus?.inProgress,
    portfolio.populateStatus?.startedAt,
  ]);
  const analysisRefreshToken = useMemo(() => {
    if (!portfolio.populateStatus?.inProgress) {
      return populateCompletionStateToken;
    }

    return [
      populateSessionStateToken,
      typeof portfolio.populateStatus?.walletsCompleted === 'number'
        ? String(portfolio.populateStatus.walletsCompleted)
        : '0',
      typeof portfolio.populateStatus?.errors?.length === 'number'
        ? String(portfolio.populateStatus.errors.length)
        : '0',
    ].join('|');
  }, [
    populateCompletionStateToken,
    populateSessionStateToken,
    portfolio.populateStatus?.errors?.length,
    portfolio.populateStatus?.inProgress,
    portfolio.populateStatus?.walletsCompleted,
  ]);
  const analysisClearDataToken = portfolio.populateStatus?.inProgress
    ? populateSessionStateToken
    : populateCompletionStateToken;

  const analysis = usePortfolioAnalysis({
    wallets,
    timeframe: gainLossMode,
    maxPoints: 2,
    refreshToken: analysisRefreshToken,
    clearDataToken: analysisClearDataToken,
    freezeWhilePopulate: true,
    allowCurrentWhilePopulate: true,
  });
  const resolvedPopulateItemsSessionToken = useMemo(() => {
    return [
      populateSessionStateToken,
      gainLossMode,
      analysis.quoteCurrency,
    ].join('|');
  }, [analysis.quoteCurrency, gainLossMode, populateSessionStateToken]);
  const shouldForcePopulateLoading =
    !!portfolio.populateStatus?.inProgress &&
    !analysis.committedData &&
    !analysis.currentData;

  const items = useMemo(() => {
    const builtItems = buildAssetRowsFromAnalysis({
      storedWallets: analysis.storedWallets,
      analysis: analysis.data,
      quoteCurrency: analysis.quoteCurrency,
      gainLossMode,
      collapseAcrossChains: true,
    });

    const currentWalletIds = new Set(
      (analysis.currentData?.wallets || []).map(wallet => wallet.walletId),
    );
    const committedWalletIds = new Set(
      (analysis.committedData?.wallets || []).map(wallet => wallet.walletId),
    );
    const dataWalletIds = new Set(
      (analysis.data?.wallets || []).map(wallet => wallet.walletId),
    );
    const currentAssetIds = new Set(analysis.currentData?.assetIds || []);
    const committedAssetIds = new Set(analysis.committedData?.assetIds || []);
    const dataAssetIds = new Set(analysis.data?.assetIds || []);
    const analysisError = analysis.error
      ? {
          name: analysis.error.name,
          message: analysis.error.message,
        }
      : null;

    return builtItems.map(item => {
      const baseDebugPayload = item.debugCopyPayload || {};
      const rowWalletIds = Array.isArray(baseDebugPayload.rowWalletIds)
        ? baseDebugPayload.rowWalletIds
            .map(walletId => String(walletId || ''))
            .filter(Boolean)
        : [];
      const rowAssetIds = Array.isArray(baseDebugPayload.rowAssetIds)
        ? baseDebugPayload.rowAssetIds
            .map(assetId => String(assetId || ''))
            .filter(Boolean)
        : [];

      return {
        ...item,
        debugCopyPayload: {
          ...baseDebugPayload,
          homeAnalysisHook: {
            error: analysisError,
            dataIsCommittedData: analysis.data === analysis.committedData,
            hasData: !!analysis.data,
            hasCurrentData: !!analysis.currentData,
            hasCommittedData: !!analysis.committedData,
            dataWalletCount: analysis.data?.wallets?.length ?? 0,
            currentDataWalletCount: analysis.currentData?.wallets?.length ?? 0,
            committedDataWalletCount:
              analysis.committedData?.wallets?.length ?? 0,
            rowWalletIds,
            rowAssetIds,
            dataContainsRowWalletIds: rowWalletIds.filter(walletId =>
              dataWalletIds.has(walletId),
            ),
            dataMissingRowWalletIds: rowWalletIds.filter(
              walletId => !dataWalletIds.has(walletId),
            ),
            currentContainsRowWalletIds: rowWalletIds.filter(
              walletId => currentWalletIds.has(walletId),
            ),
            currentMissingRowWalletIds: rowWalletIds.filter(
              walletId => !currentWalletIds.has(walletId),
            ),
            committedContainsRowWalletIds: rowWalletIds.filter(
              walletId => committedWalletIds.has(walletId),
            ),
            committedMissingRowWalletIds: rowWalletIds.filter(
              walletId => !committedWalletIds.has(walletId),
            ),
            dataContainsRowAssetIds: rowAssetIds.filter(assetId =>
              dataAssetIds.has(assetId),
            ),
            currentContainsRowAssetIds: rowAssetIds.filter(assetId =>
              currentAssetIds.has(assetId),
            ),
            committedContainsRowAssetIds: rowAssetIds.filter(assetId =>
              committedAssetIds.has(assetId),
            ),
          },
        },
      };
    });
  }, [
    analysis.committedData,
    analysis.currentData,
    analysis.data,
    analysis.error,
    analysis.quoteCurrency,
    analysis.storedWallets,
    gainLossMode,
  ]);
  const visibleItemsRaw = useMemo(() => getDisplayAssetRowItems(items), [items]);
  const visibleItemsStableDuringPopulate = useMemo(() => {
    if (!portfolio.populateStatus?.inProgress || visibleItemsRaw.length < 2) {
      return visibleItemsRaw;
    }

    return sortAssetRowItemsByAssetFiatPriority({
      items: visibleItemsRaw,
      wallets,
    });
  }, [portfolio.populateStatus?.inProgress, visibleItemsRaw, wallets]);
  const lastNonEmptyVisibleItemsRef = useRef<AssetRowItem[]>([]);
  useEffect(() => {
    if (!visibleItemsStableDuringPopulate.length) {
      return;
    }

    lastNonEmptyVisibleItemsRef.current = visibleItemsStableDuringPopulate;
  }, [visibleItemsStableDuringPopulate]);

  const visibleItems = useMemo(() => {
    if (visibleItemsStableDuringPopulate.length) {
      return visibleItemsStableDuringPopulate;
    }

    if (portfolio.populateStatus?.inProgress && analysis.committedData) {
      return lastNonEmptyVisibleItemsRef.current;
    }

    return visibleItemsStableDuringPopulate;
  }, [
    analysis.committedData,
    portfolio.populateStatus?.inProgress,
    visibleItemsStableDuringPopulate,
  ]);

  const walletIdsByAssetKey = useMemo(() => {
    if (!portfolio.populateStatus?.inProgress) {
      return undefined;
    }

    return buildWalletIdsByAssetGroupKey(wallets);
  }, [portfolio.populateStatus?.inProgress, wallets]);

  const populateLoadingByKeyPrevRef = useRef<
    Record<string, boolean> | undefined
  >(undefined);
  const resolvedPopulateItemsRef = useRef<{
    sessionToken: string;
    itemsByKey: Record<string, AssetRowItem>;
  }>({
    sessionToken: '',
    itemsByKey: {},
  });
  useEffect(() => {
    if (!portfolio.populateStatus?.inProgress) {
      resolvedPopulateItemsRef.current = {
        sessionToken: '',
        itemsByKey: {},
      };
      return;
    }

    if (
      resolvedPopulateItemsRef.current.sessionToken !==
      resolvedPopulateItemsSessionToken
    ) {
      resolvedPopulateItemsRef.current = {
        sessionToken: resolvedPopulateItemsSessionToken,
        itemsByKey: {},
      };
    }
  }, [
    portfolio.populateStatus?.inProgress,
    resolvedPopulateItemsSessionToken,
  ]);
  const isPopulateLoadingByKeyRaw = useMemo(() => {
    if (!portfolio.populateStatus?.inProgress) {
      return undefined;
    }

    if (shouldForcePopulateLoading) {
      if (!visibleItems.length) {
        return undefined;
      }

      const next: Record<string, boolean> = {};
      for (const item of visibleItems) {
        next[item.key] = true;
      }
      return next;
    }

    if (!walletIdsByAssetKey) {
      return undefined;
    }

    return getPopulateLoadingByAssetKey({
      items: visibleItems,
      walletIdsByAssetKey,
      populateStatus: portfolio.populateStatus,
      prev: populateLoadingByKeyPrevRef.current,
    });
  }, [
    portfolio.populateStatus,
    shouldForcePopulateLoading,
    visibleItems,
    walletIdsByAssetKey,
  ]);
  const stablePopulatePresentation = useMemo(() => {
    if (!portfolio.populateStatus?.inProgress || !isPopulateLoadingByKeyRaw) {
      return {
        visibleItems,
        isPopulateLoadingByKey: isPopulateLoadingByKeyRaw,
      };
    }

    if (
      resolvedPopulateItemsRef.current.sessionToken !==
      resolvedPopulateItemsSessionToken
    ) {
      resolvedPopulateItemsRef.current = {
        sessionToken: resolvedPopulateItemsSessionToken,
        itemsByKey: {},
      };
    }

    const resolvedItemsByKey = resolvedPopulateItemsRef.current.itemsByKey;
    let itemsChanged = false;
    let loadingChanged = false;
    const nextLoadingByKey: Record<string, boolean> = {
      ...isPopulateLoadingByKeyRaw,
    };
    const nextItems = visibleItems.map(item => {
      const cachedItem = resolvedItemsByKey[item.key];
      if (isPopulateLoadingByKeyRaw[item.key] === false) {
        nextLoadingByKey[item.key] = false;
        if (!cachedItem) {
          resolvedItemsByKey[item.key] = item;
          return item;
        }

        if (cachedItem !== item) {
          itemsChanged = true;
        }
        return cachedItem;
      }

      if (cachedItem) {
        nextLoadingByKey[item.key] = false;
        itemsChanged = true;
        loadingChanged = true;
        return cachedItem;
      }

      return item;
    });

    return {
      visibleItems: itemsChanged ? nextItems : visibleItems,
      isPopulateLoadingByKey: loadingChanged
        ? nextLoadingByKey
        : isPopulateLoadingByKeyRaw,
    };
  }, [
    isPopulateLoadingByKeyRaw,
    portfolio.populateStatus?.inProgress,
    resolvedPopulateItemsSessionToken,
    visibleItems,
  ]);

  useEffect(() => {
    populateLoadingByKeyPrevRef.current =
      stablePopulatePresentation.isPopulateLoadingByKey;
  }, [stablePopulatePresentation.isPopulateLoadingByKey]);

  return {
    visibleItems: stablePopulatePresentation.visibleItems,
    isFiatLoading: analysis.loading && !analysis.data && !analysis.committedData,
    isPopulateLoadingByKey: stablePopulatePresentation.isPopulateLoadingByKey,
    hasAnyPortfolioData:
      !!analysis.data ||
      !!analysis.committedData ||
      !!portfolio.populateStatus?.inProgress,
  };
}

export default usePortfolioAssetRows;
