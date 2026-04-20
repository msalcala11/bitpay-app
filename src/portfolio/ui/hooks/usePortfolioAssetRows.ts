import {useEffect, useMemo, useRef, useState} from 'react';
import type {AssetRowItem, GainLossMode} from '../../../utils/portfolio/assets';
import {
  buildWalletIdsByAssetGroupKey,
  getPortfolioWalletCurrencyAbbreviationLower,
  getDisplayAssetRowItems,
  getPopulateLoadingByAssetKey,
  getVisibleWalletsFromKeys,
  sortAssetRowItemsByAssetFiatPriority,
} from '../../../utils/portfolio/assets';
import type {Key} from '../../../store/wallet/wallet.models';
import {useAppSelector} from '../../../utils/hooks';
import buildAssetPnlDebugPayload from '../debug/buildAssetPnlDebugPayload';
import {getAssetIdFromWallet} from '../../core/pnl/assetId';
import type {PnlAnalysisResult} from '../../core/pnl/analysisStreaming';
import type {StoredWallet} from '../../core/types';
import {
  getCurrentRatesByAssetIdSignature,
  getStoredWalletRequestSignature,
  runPortfolioAnalysisQuery,
} from '../common';
import buildAssetRowsFromAnalysis from '../selectors/buildAssetRowsFromAnalysis';
import {usePortfolioAnalysis} from './usePortfolioAnalysis';

type Args = {
  gainLossMode: GainLossMode;
  keyId?: string;
  externalRefreshToken?: string | number;
};

type Result = {
  visibleItems: AssetRowItem[];
  isFiatLoading: boolean;
  isPopulateLoadingByKey: Record<string, boolean> | undefined;
  hasAnyPortfolioData: boolean;
};

type AssetGroupAnalysisSpec = {
  key: string;
  storedWallets: StoredWallet[];
  eligibleWalletIds: string[];
  requestKey: string;
  committedCacheKey: string;
  currentRatesByAssetId: Record<string, number>;
  currentRatesSignature: string;
};

type AssetGroupAnalysisState = {
  requestKey: string;
  committedCacheKey: string;
  currentData?: PnlAnalysisResult;
  committedData?: PnlAnalysisResult;
  loading: boolean;
  error?: Error;
};

const committedAssetGroupAnalysisCache = new Map<string, PnlAnalysisResult>();

function getCommittedAssetGroupAnalysisCacheKey(args: {
  requestKey: string;
  refreshToken?: string;
}): string {
  return args.refreshToken
    ? [args.requestKey, args.refreshToken].join('|')
    : args.requestKey;
}

export function usePortfolioAssetRows({
  gainLossMode,
  keyId,
  externalRefreshToken,
}: Args): Result {
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
    const baseToken = (() => {
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
    })();

    if (
      externalRefreshToken == null ||
      externalRefreshToken === ''
    ) {
      return baseToken;
    }

    return [baseToken, String(externalRefreshToken)].join('|');
  }, [
    externalRefreshToken,
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
  const hasCommittedPortfolioBaseline =
    typeof portfolio.lastPopulatedAt === 'number' &&
    Number.isFinite(portfolio.lastPopulatedAt);
  const assetGroupAnalysisSpecs = useMemo<AssetGroupAnalysisSpec[]>(() => {
    if (!analysis.storedWallets.length) {
      return [];
    }

    const storedWalletsByKey = new Map<string, StoredWallet[]>();
    for (const storedWallet of analysis.storedWallets) {
      if ((storedWallet.summary.network || '').toLowerCase() !== 'livenet') {
        continue;
      }

      const groupKey = String(
        storedWallet.summary.currencyAbbreviation || '',
      ).toLowerCase();
      if (!groupKey) {
        continue;
      }

      const groupWallets = storedWalletsByKey.get(groupKey) || [];
      groupWallets.push(storedWallet);
      storedWalletsByKey.set(groupKey, groupWallets);
    }

    const eligibleWalletIdsByKey = new Map<string, string[]>();
    for (const wallet of analysis.eligibleWallets || []) {
      const groupKey = getPortfolioWalletCurrencyAbbreviationLower(wallet);
      const walletId = String(wallet?.id || '');
      if (!groupKey || !walletId) {
        continue;
      }

      const groupWalletIds = eligibleWalletIdsByKey.get(groupKey) || [];
      groupWalletIds.push(walletId);
      eligibleWalletIdsByKey.set(groupKey, groupWalletIds);
    }

    const nextSpecs: AssetGroupAnalysisSpec[] = [];
    for (const [groupKey, groupStoredWallets] of storedWalletsByKey.entries()) {
      const assetIds = Array.from(
        new Set(groupStoredWallets.map(wallet => getAssetIdFromWallet(wallet.summary))),
      );
      const currentRatesByAssetId: Record<string, number> = {};
      for (const assetId of assetIds) {
        const rate = analysis.currentRatesByAssetId?.[assetId];
        if (typeof rate === 'number' && Number.isFinite(rate)) {
          currentRatesByAssetId[assetId] = rate;
        }
      }

      const currentRatesSignature = getCurrentRatesByAssetIdSignature(
        currentRatesByAssetId,
      );
      const requestKey = [
        analysis.quoteCurrency,
        gainLossMode,
        '2',
        getStoredWalletRequestSignature(groupStoredWallets),
        currentRatesSignature,
      ].join('|');

      nextSpecs.push({
        key: groupKey,
        storedWallets: groupStoredWallets,
        eligibleWalletIds: eligibleWalletIdsByKey.get(groupKey) || [],
        requestKey,
        committedCacheKey: getCommittedAssetGroupAnalysisCacheKey({
          requestKey,
          refreshToken: analysisClearDataToken ?? analysisRefreshToken,
        }),
        currentRatesByAssetId,
        currentRatesSignature,
      });
    }

    return nextSpecs.sort((left, right) => left.key.localeCompare(right.key));
  }, [
    analysis.currentRatesByAssetId,
    analysis.eligibleWallets,
    analysis.quoteCurrency,
    analysis.storedWallets,
    analysisClearDataToken,
    analysisRefreshToken,
    gainLossMode,
  ]);
  const assetGroupAnalysisSpecsRevision = useMemo(() => {
    return assetGroupAnalysisSpecs
      .map(
        spec =>
          `${spec.key}:${spec.requestKey}:${spec.committedCacheKey}:${spec.eligibleWalletIds.join(',')}`,
      )
      .join('|');
  }, [assetGroupAnalysisSpecs]);
  const [assetGroupAnalysisStateByKey, setAssetGroupAnalysisStateByKey] =
    useState<Record<string, AssetGroupAnalysisState>>({});
  useEffect(() => {
    setAssetGroupAnalysisStateByKey(prev => {
      const next: Record<string, AssetGroupAnalysisState> = {};
      let changed =
        Object.keys(prev).length !== assetGroupAnalysisSpecs.length;

      for (const spec of assetGroupAnalysisSpecs) {
        const prevState = prev[spec.key];
        const cachedCommittedData = hasCommittedPortfolioBaseline
          ? committedAssetGroupAnalysisCache.get(spec.committedCacheKey)
          : undefined;
        const nextState: AssetGroupAnalysisState = {
          requestKey: spec.requestKey,
          committedCacheKey: spec.committedCacheKey,
          currentData:
            prevState?.requestKey === spec.requestKey
              ? prevState.currentData
              : undefined,
          committedData: cachedCommittedData,
          loading:
            prevState?.requestKey === spec.requestKey ? prevState.loading : false,
          error:
            prevState?.requestKey === spec.requestKey ? prevState.error : undefined,
        };
        next[spec.key] = nextState;

        if (
          !prevState ||
          prevState.requestKey !== nextState.requestKey ||
          prevState.committedCacheKey !== nextState.committedCacheKey ||
          prevState.currentData !== nextState.currentData ||
          prevState.committedData !== nextState.committedData ||
          prevState.loading !== nextState.loading ||
          prevState.error !== nextState.error
        ) {
          changed = true;
        }
      }

      return changed ? next : prev;
    });
  }, [assetGroupAnalysisSpecs, hasCommittedPortfolioBaseline]);
  useEffect(() => {
    if (!assetGroupAnalysisSpecs.length) {
      return;
    }

    let cancelled = false;
    setAssetGroupAnalysisStateByKey(prev => {
      const next = {...prev};
      let changed = false;

      for (const spec of assetGroupAnalysisSpecs) {
        const prevState = next[spec.key];
        const cachedCommittedData = hasCommittedPortfolioBaseline
          ? committedAssetGroupAnalysisCache.get(spec.committedCacheKey)
          : undefined;
        const nextState: AssetGroupAnalysisState = {
          requestKey: spec.requestKey,
          committedCacheKey: spec.committedCacheKey,
          currentData:
            prevState?.requestKey === spec.requestKey
              ? prevState.currentData
              : undefined,
          committedData:
            prevState?.requestKey === spec.requestKey
              ? prevState.committedData ?? cachedCommittedData
              : cachedCommittedData,
          loading: true,
          error: undefined,
        };

        if (
          prevState &&
          prevState.requestKey === nextState.requestKey &&
          prevState.committedCacheKey === nextState.committedCacheKey &&
          prevState.currentData === nextState.currentData &&
          prevState.committedData === nextState.committedData &&
          prevState.loading === nextState.loading &&
          prevState.error === nextState.error
        ) {
          continue;
        }

        next[spec.key] = nextState;
        changed = true;
      }

      return changed ? next : prev;
    });

    Promise.allSettled(
      assetGroupAnalysisSpecs.map(async spec => {
        const result = await runPortfolioAnalysisQuery({
          wallets: spec.storedWallets,
          quoteCurrency: analysis.quoteCurrency,
          timeframe: gainLossMode,
          maxPoints: 2,
          currentRatesByAssetId: spec.currentRatesByAssetId,
        });

        return {
          key: spec.key,
          requestKey: spec.requestKey,
          committedCacheKey: spec.committedCacheKey,
          result,
        };
      }),
    ).then(results => {
      if (cancelled) {
        return;
      }

      setAssetGroupAnalysisStateByKey(prev => {
        const next = {...prev};
        let changed = false;

        results.forEach((settled, index) => {
          if (settled.status === 'fulfilled') {
            const {key, requestKey, committedCacheKey, result} = settled.value;
            const spec = assetGroupAnalysisSpecs.find(
              candidate =>
                candidate.key === key && candidate.requestKey === requestKey,
            );
            if (!spec) {
              return;
            }

            const prevState = next[key];
            const baseState: AssetGroupAnalysisState =
              prevState?.requestKey === requestKey
                ? prevState
                : {
                    requestKey,
                    committedCacheKey,
                    currentData: undefined,
                    committedData: hasCommittedPortfolioBaseline
                      ? committedAssetGroupAnalysisCache.get(committedCacheKey)
                      : undefined,
                    loading: true,
                    error: undefined,
                  };

            let committedData = baseState.committedData;
            if (!portfolio.populateStatus?.inProgress) {
              committedAssetGroupAnalysisCache.set(committedCacheKey, result);
              committedData = result;
            }

            next[key] = {
              ...baseState,
              currentData: result,
              committedData,
              loading: false,
              error: undefined,
            };
            changed = true;
            return;
          }

          const failedSpec = assetGroupAnalysisSpecs[index];
          if (!failedSpec) {
            return;
          }

          const prevState = next[failedSpec.key];
          const baseState: AssetGroupAnalysisState =
            prevState?.requestKey === failedSpec.requestKey
              ? prevState
              : {
                  requestKey: failedSpec.requestKey,
                  committedCacheKey: failedSpec.committedCacheKey,
                  currentData: undefined,
                  committedData: hasCommittedPortfolioBaseline
                    ? committedAssetGroupAnalysisCache.get(
                        failedSpec.committedCacheKey,
                      )
                    : undefined,
                  loading: true,
                  error: undefined,
                };

          next[failedSpec.key] = {
            ...baseState,
            loading: false,
            error:
              settled.reason instanceof Error
                ? settled.reason
                : new Error(String(settled.reason)),
          };
          changed = true;
        });

        return changed ? next : prev;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [
    analysisRefreshToken,
    analysis.quoteCurrency,
    assetGroupAnalysisSpecs,
    assetGroupAnalysisSpecsRevision,
    gainLossMode,
    hasCommittedPortfolioBaseline,
    portfolio.populateStatus?.inProgress,
  ]);
  const assetGroupAnalysisForDisplayByKey = useMemo(() => {
    const next: Record<string, PnlAnalysisResult | undefined> = {};

    for (const spec of assetGroupAnalysisSpecs) {
      const state = assetGroupAnalysisStateByKey[spec.key];
      next[spec.key] =
        state?.currentData ??
        (hasCommittedPortfolioBaseline ? state?.committedData : undefined);
    }

    return next;
  }, [
    assetGroupAnalysisSpecs,
    assetGroupAnalysisStateByKey,
    hasCommittedPortfolioBaseline,
  ]);
  const assetGroupAnalysisSpecByKey = useMemo(() => {
    const next = new Map<string, AssetGroupAnalysisSpec>();
    for (const spec of assetGroupAnalysisSpecs) {
      next.set(spec.key, spec);
    }
    return next;
  }, [assetGroupAnalysisSpecs]);
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
    const groupItemsByKey = new Map<string, AssetRowItem>();

    for (const spec of assetGroupAnalysisSpecs) {
      const groupAnalysis = assetGroupAnalysisForDisplayByKey[spec.key];
      if (!groupAnalysis) {
        continue;
      }

      const groupBuiltItems = buildAssetRowsFromAnalysis({
        storedWallets: spec.storedWallets,
        analysis: groupAnalysis,
        quoteCurrency: analysis.quoteCurrency,
        gainLossMode,
        collapseAcrossChains: true,
      });

      if (groupBuiltItems[0]) {
        groupItemsByKey.set(spec.key, groupBuiltItems[0]);
      }
    }

    return builtItems.map(baseItem => {
      const item = groupItemsByKey.get(baseItem.key) || baseItem;
      const groupState = assetGroupAnalysisStateByKey[item.key];
      const groupSpec = assetGroupAnalysisSpecByKey.get(item.key);
      const effectiveAnalysis =
        assetGroupAnalysisForDisplayByKey[item.key] ?? analysis.data;
      const effectiveCurrentData = groupState?.currentData ?? analysis.currentData;
      const effectiveCommittedData =
        groupState?.committedData ?? analysis.committedData;
      const effectiveError = groupState?.error ?? analysis.error;
      const effectiveRequestKey = groupState?.requestKey ?? analysis.requestKey;
      const effectiveCurrentRatesByAssetId =
        groupSpec?.currentRatesByAssetId ?? analysis.currentRatesByAssetId;
      const effectiveCurrentRatesSignature =
        groupSpec?.currentRatesSignature ?? analysis.currentRatesSignature;
      const effectiveStoredWallets = groupSpec?.storedWallets ?? analysis.storedWallets;
      const effectiveEligibleWallets = groupSpec
        ? (analysis.eligibleWallets || []).filter(wallet =>
            groupSpec.eligibleWalletIds.includes(String(wallet?.id || '')),
          )
        : analysis.eligibleWallets;
      const currentWalletIds = new Set(
        (effectiveCurrentData?.wallets || []).map(wallet => wallet.walletId),
      );
      const committedWalletIds = new Set(
        (effectiveCommittedData?.wallets || []).map(wallet => wallet.walletId),
      );
      const dataWalletIds = new Set(
        (effectiveAnalysis?.wallets || []).map(wallet => wallet.walletId),
      );
      const currentAssetIds = new Set(effectiveCurrentData?.assetIds || []);
      const committedAssetIds = new Set(effectiveCommittedData?.assetIds || []);
      const dataAssetIds = new Set(effectiveAnalysis?.assetIds || []);
      const analysisError = effectiveError
        ? {
            name: effectiveError.name,
            message: effectiveError.message,
          }
        : null;
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
        debugCopyPayload: buildAssetPnlDebugPayload({
          surface: 'asset_list',
          assetKey: item.key,
          gainLossMode,
          quoteCurrency: analysis.quoteCurrency,
          storedWallets: effectiveStoredWallets,
          eligibleWallets: effectiveEligibleWallets,
          analysis: effectiveAnalysis,
          currentData: effectiveCurrentData,
          committedData: effectiveCommittedData,
          error: effectiveError,
          requestKey: effectiveRequestKey,
          currentRatesByAssetId: effectiveCurrentRatesByAssetId,
          currentRatesSignature: effectiveCurrentRatesSignature,
          baseDebugPayload,
          displayedMetrics: {
            fiatBalance:
              typeof baseDebugPayload.aggregatedSummary === 'object' &&
              baseDebugPayload.aggregatedSummary
                ? Number(
                    (baseDebugPayload.aggregatedSummary as Record<string, unknown>)
                      .fiatValue,
                  )
                : undefined,
            pnlChange:
              typeof baseDebugPayload.aggregatedSummary === 'object' &&
              baseDebugPayload.aggregatedSummary
                ? Number(
                    (baseDebugPayload.aggregatedSummary as Record<string, unknown>)
                      .pnlChange,
                  )
                : undefined,
            pnlPercent:
              typeof baseDebugPayload.aggregatedSummary === 'object' &&
              baseDebugPayload.aggregatedSummary
                ? Number(
                    (baseDebugPayload.aggregatedSummary as Record<string, unknown>)
                      .pnlPercent,
                  )
                : undefined,
            hasRate: item.hasRate,
            hasPnl: item.hasPnl,
            showPnlPlaceholder: item.showPnlPlaceholder,
          },
          formattedDisplay: {
            fiatAmount: item.fiatAmount,
            deltaFiat: item.deltaFiat,
            deltaPercent: item.deltaPercent,
          },
          extraDebugData: {
            homeAnalysisHook: {
              error: analysisError,
              sourceAnalysisScope: groupItemsByKey.has(item.key)
                ? 'asset_group'
                : 'portfolio_fallback',
              dataWalletCount: effectiveAnalysis?.wallets?.length ?? 0,
              currentDataWalletCount: effectiveCurrentData?.wallets?.length ?? 0,
              committedDataWalletCount:
                effectiveCommittedData?.wallets?.length ?? 0,
              rowWalletIds,
              rowAssetIds,
              dataContainsRowWalletIds: rowWalletIds.filter(walletId =>
                dataWalletIds.has(walletId),
              ),
              dataMissingRowWalletIds: rowWalletIds.filter(
                walletId => !dataWalletIds.has(walletId),
              ),
              currentContainsRowWalletIds: rowWalletIds.filter(walletId =>
                currentWalletIds.has(walletId),
              ),
              currentMissingRowWalletIds: rowWalletIds.filter(
                walletId => !currentWalletIds.has(walletId),
              ),
              committedContainsRowWalletIds: rowWalletIds.filter(walletId =>
                committedWalletIds.has(walletId),
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
              requestKey: effectiveRequestKey,
              currentRatesSignature: effectiveCurrentRatesSignature,
            },
          },
        }),
      };
    });
  }, [
    assetGroupAnalysisForDisplayByKey,
    assetGroupAnalysisSpecByKey,
    assetGroupAnalysisSpecs,
    assetGroupAnalysisStateByKey,
    analysis.committedData,
    analysis.currentData,
    analysis.currentRatesByAssetId,
    analysis.currentRatesSignature,
    analysis.data,
    analysis.error,
    analysis.eligibleWallets,
    analysis.quoteCurrency,
    analysis.requestKey,
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
    isFiatLoading:
      (analysis.loading && !analysis.data && !analysis.committedData) ||
      (!!assetGroupAnalysisSpecs.length &&
        assetGroupAnalysisSpecs.every(spec => {
          const state = assetGroupAnalysisStateByKey[spec.key];
          return (
            !!state?.loading &&
            !state.currentData &&
            !state.committedData
          );
        })),
    isPopulateLoadingByKey: stablePopulatePresentation.isPopulateLoadingByKey,
    hasAnyPortfolioData:
      !!analysis.data ||
      !!analysis.committedData ||
      Object.values(assetGroupAnalysisStateByKey).some(
        state => !!state.currentData || !!state.committedData,
      ) ||
      !!portfolio.populateStatus?.inProgress,
  };
}

export default usePortfolioAssetRows;
