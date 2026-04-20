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
  disposePortfolioAnalysisSessionQuery,
  getCurrentRatesByAssetIdSignature,
  getStoredWalletRequestSignature,
  preparePortfolioAnalysisSessionQuery,
  runPortfolioAnalysisQuery,
  runPortfolioAnalysisSessionScopeQuery,
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
  storedWalletIds: string[];
  eligibleWalletIds: string[];
  requestKey: string;
  committedCacheKey: string;
  currentRatesByAssetId: Record<string, number>;
  currentRatesSignature: string;
  asOfMs?: number;
};

type AssetGroupAnalysisState = {
  requestKey: string;
  committedCacheKey: string;
  sessionId?: string;
  currentData?: PnlAnalysisResult;
  committedData?: PnlAnalysisResult;
  loading: boolean;
  error?: Error;
};

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
        typeof analysis.asOfMs === 'number' ? String(analysis.asOfMs) : '',
      ].join('|');

      nextSpecs.push({
        key: groupKey,
        storedWallets: groupStoredWallets,
        storedWalletIds: groupStoredWallets.map(wallet => wallet.summary.walletId),
        eligibleWalletIds: eligibleWalletIdsByKey.get(groupKey) || [],
        requestKey,
        committedCacheKey: getCommittedAssetGroupAnalysisCacheKey({
          requestKey,
          refreshToken: analysisClearDataToken ?? analysisRefreshToken,
        }),
        currentRatesByAssetId,
        currentRatesSignature,
        asOfMs: analysis.asOfMs,
      });
    }

    return nextSpecs.sort((left, right) => left.key.localeCompare(right.key));
  }, [
    analysis.currentRatesByAssetId,
    analysis.asOfMs,
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
  const assetGroupSessionStoredWallets = useMemo(() => {
    const seenWalletIds = new Set<string>();
    const next: StoredWallet[] = [];

    for (const spec of assetGroupAnalysisSpecs) {
      for (const wallet of spec.storedWallets) {
        const walletId = String(wallet.summary.walletId || '');
        if (!walletId || seenWalletIds.has(walletId)) {
          continue;
        }
        seenWalletIds.add(walletId);
        next.push(wallet);
      }
    }

    return next;
  }, [assetGroupAnalysisSpecs]);
  const assetGroupSessionCurrentRatesByAssetId = useMemo(() => {
    const next: Record<string, number> = {};

    for (const spec of assetGroupAnalysisSpecs) {
      for (const [assetId, rate] of Object.entries(spec.currentRatesByAssetId)) {
        if (typeof rate === 'number' && Number.isFinite(rate)) {
          next[assetId] = rate;
        }
      }
    }

    return next;
  }, [assetGroupAnalysisSpecs]);
  const assetGroupCommittedAnalysisCacheRef = useRef(
    new Map<string, PnlAnalysisResult>(),
  );
  const assetGroupSessionRequestKey = useMemo(() => {
    if (!assetGroupSessionStoredWallets.length) {
      return '';
    }

    return [
      analysis.quoteCurrency,
      gainLossMode,
      '2',
      getStoredWalletRequestSignature(assetGroupSessionStoredWallets),
      getCurrentRatesByAssetIdSignature(assetGroupSessionCurrentRatesByAssetId),
      typeof analysis.asOfMs === 'number' ? String(analysis.asOfMs) : '',
    ].join('|');
  }, [
    analysis.asOfMs,
    analysis.quoteCurrency,
    assetGroupSessionCurrentRatesByAssetId,
    assetGroupSessionStoredWallets,
    gainLossMode,
  ]);
  const [assetGroupAnalysisStateByKey, setAssetGroupAnalysisStateByKey] =
    useState<Record<string, AssetGroupAnalysisState>>({});
  useEffect(() => {
    const allowedCacheKeys = new Set(
      assetGroupAnalysisSpecs.map(spec => spec.committedCacheKey),
    );

    for (const cacheKey of Array.from(
      assetGroupCommittedAnalysisCacheRef.current.keys(),
    )) {
      if (!allowedCacheKeys.has(cacheKey)) {
        assetGroupCommittedAnalysisCacheRef.current.delete(cacheKey);
      }
    }
  }, [assetGroupAnalysisSpecs]);
  useEffect(() => {
    setAssetGroupAnalysisStateByKey(prev => {
      const next: Record<string, AssetGroupAnalysisState> = {};
      let changed =
        Object.keys(prev).length !== assetGroupAnalysisSpecs.length;

      for (const spec of assetGroupAnalysisSpecs) {
        const prevState = prev[spec.key];
        const cachedCommittedData = hasCommittedPortfolioBaseline
          ? assetGroupCommittedAnalysisCacheRef.current.get(
              spec.committedCacheKey,
            )
          : undefined;
        const nextState: AssetGroupAnalysisState = {
          requestKey: spec.requestKey,
          committedCacheKey: spec.committedCacheKey,
          sessionId:
            prevState?.requestKey === spec.requestKey
              ? prevState.sessionId
              : undefined,
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
          prevState.sessionId !== nextState.sessionId ||
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
    let preparedSessionId: string | undefined;
    setAssetGroupAnalysisStateByKey(prev => {
      const next = {...prev};
      let changed = false;

      for (const spec of assetGroupAnalysisSpecs) {
        const prevState = next[spec.key];
        const cachedCommittedData = hasCommittedPortfolioBaseline
          ? assetGroupCommittedAnalysisCacheRef.current.get(
              spec.committedCacheKey,
            )
          : undefined;
        const nextState: AssetGroupAnalysisState = {
          requestKey: spec.requestKey,
          committedCacheKey: spec.committedCacheKey,
          sessionId:
            prevState?.requestKey === spec.requestKey
              ? prevState.sessionId
              : undefined,
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
          prevState.sessionId === nextState.sessionId &&
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

    (async () => {
      const buildBaseState = (
        prevState: AssetGroupAnalysisState | undefined,
        spec: AssetGroupAnalysisSpec,
        sessionId?: string,
      ): AssetGroupAnalysisState => {
        const cachedCommittedData = hasCommittedPortfolioBaseline
          ? assetGroupCommittedAnalysisCacheRef.current.get(
              spec.committedCacheKey,
            )
          : undefined;

        return prevState || {
          requestKey: spec.requestKey,
          committedCacheKey: spec.committedCacheKey,
          sessionId,
          currentData: undefined,
          committedData: cachedCommittedData,
          loading: true,
          error: undefined,
        };
      };

      const commitScopedResult = (
        spec: AssetGroupAnalysisSpec,
        sessionId: string,
        result: PnlAnalysisResult,
      ) => {
        setAssetGroupAnalysisStateByKey(prev => {
          const prevState = prev[spec.key];
          if (
            prevState &&
            (prevState.requestKey !== spec.requestKey ||
              prevState.sessionId !== sessionId)
          ) {
            return prev;
          }

          const baseState = buildBaseState(prevState, spec, sessionId);

          let committedData = baseState.committedData;
          if (!portfolio.populateStatus?.inProgress) {
            assetGroupCommittedAnalysisCacheRef.current.set(
              spec.committedCacheKey,
              result,
            );
            committedData = result;
          }

          const nextState: AssetGroupAnalysisState = {
            ...baseState,
            sessionId,
            currentData: result,
            committedData,
            loading: false,
            error: undefined,
          };

          if (
            baseState.sessionId === nextState.sessionId &&
            baseState.currentData === nextState.currentData &&
            baseState.committedData === nextState.committedData &&
            baseState.loading === nextState.loading &&
            baseState.error === nextState.error
          ) {
            return prev;
          }

          return {
            ...prev,
            [spec.key]: nextState,
          };
        });
      };

      const commitScopedError = (
        spec: AssetGroupAnalysisSpec,
        sessionId: string | undefined,
        error: Error,
      ) => {
        setAssetGroupAnalysisStateByKey(prev => {
          const prevState = prev[spec.key];
          if (
            prevState &&
            (prevState.requestKey !== spec.requestKey ||
              (sessionId && prevState.sessionId !== sessionId))
          ) {
            return prev;
          }

          const baseState = buildBaseState(prevState, spec, sessionId);
          const nextState: AssetGroupAnalysisState = {
            ...baseState,
            sessionId,
            loading: false,
            error,
          };

          if (
            baseState.sessionId === nextState.sessionId &&
            baseState.loading === nextState.loading &&
            baseState.error === nextState.error
          ) {
            return prev;
          }

          return {
            ...prev,
            [spec.key]: nextState,
          };
        });
      };

      const runScopedAnalysisForSpec = async (
        sessionId: string,
        spec: AssetGroupAnalysisSpec,
      ) => {
        try {
          const result = await runPortfolioAnalysisSessionScopeQuery({
            sessionId,
            walletIds: spec.storedWalletIds,
          });
          if (cancelled) {
            return;
          }

          commitScopedResult(spec, sessionId, result);
        } catch (reason) {
          if (cancelled) {
            return;
          }

          const error =
            reason instanceof Error ? reason : new Error(String(reason));
          const isMissingPreparedSession = error.message.includes(
            'Prepared portfolio analysis session not found',
          );

          if (isMissingPreparedSession) {
            try {
              const fallbackResult = await runPortfolioAnalysisQuery({
                wallets: spec.storedWallets,
                quoteCurrency: analysis.quoteCurrency,
                timeframe: gainLossMode,
                maxPoints: 2,
                currentRatesByAssetId: spec.currentRatesByAssetId,
                asOfMs: analysis.asOfMs,
              });
              if (cancelled) {
                return;
              }

              commitScopedResult(spec, sessionId, fallbackResult);
              return;
            } catch (fallbackReason) {
              if (cancelled) {
                return;
              }

              commitScopedError(
                spec,
                sessionId,
                fallbackReason instanceof Error
                  ? fallbackReason
                  : new Error(String(fallbackReason)),
              );
              return;
            }
          }

          commitScopedError(spec, sessionId, error);
        }
      };

      try {
        const session = await preparePortfolioAnalysisSessionQuery({
          wallets: assetGroupSessionStoredWallets,
          quoteCurrency: analysis.quoteCurrency,
          timeframe: gainLossMode,
          maxPoints: 2,
          currentRatesByAssetId: assetGroupSessionCurrentRatesByAssetId,
          asOfMs: analysis.asOfMs,
        });

        preparedSessionId = session.sessionId;
        if (cancelled) {
          return;
        }

        setAssetGroupAnalysisStateByKey(prev => {
          const next = {...prev};
          let changed = false;

          for (const spec of assetGroupAnalysisSpecs) {
            const prevState = next[spec.key];
            if (prevState && prevState.requestKey !== spec.requestKey) {
              continue;
            }

            const baseState = buildBaseState(
              prevState,
              spec,
              session.sessionId,
            );
            const nextState: AssetGroupAnalysisState = {
              ...baseState,
              sessionId: session.sessionId,
              loading: true,
              error: undefined,
            };

            if (
              prevState &&
              prevState.requestKey === nextState.requestKey &&
              prevState.committedCacheKey === nextState.committedCacheKey &&
              prevState.sessionId === nextState.sessionId &&
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

        await Promise.allSettled(
          assetGroupAnalysisSpecs.map(spec =>
            runScopedAnalysisForSpec(session.sessionId, spec),
          ),
        );
      } catch (reason) {
        if (cancelled) {
          return;
        }

        const error =
          reason instanceof Error ? reason : new Error(String(reason));
        setAssetGroupAnalysisStateByKey(prev => {
          const next = {...prev};
          let changed = false;

          for (const spec of assetGroupAnalysisSpecs) {
            const prevState = next[spec.key];
            const baseState: AssetGroupAnalysisState = prevState || {
              requestKey: spec.requestKey,
              committedCacheKey: spec.committedCacheKey,
              currentData: undefined,
              committedData: hasCommittedPortfolioBaseline
              ? assetGroupCommittedAnalysisCacheRef.current.get(
                  spec.committedCacheKey,
                )
              : undefined,
              sessionId: preparedSessionId,
              loading: true,
              error: undefined,
            };
            const nextState: AssetGroupAnalysisState = {
              ...baseState,
              sessionId: preparedSessionId,
              loading: false,
              error,
            };

            if (
              prevState?.sessionId !== nextState.sessionId ||
              !prevState ||
              prevState.loading !== nextState.loading ||
              prevState.error !== nextState.error
            ) {
              next[spec.key] = nextState;
              changed = true;
            }
          }

          return changed ? next : prev;
        });
      } finally {
        if (preparedSessionId) {
          await disposePortfolioAnalysisSessionQuery({
            sessionId: preparedSessionId,
          }).catch(() => {});
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    analysis.asOfMs,
    analysis.quoteCurrency,
    assetGroupSessionRequestKey,
    assetGroupSessionCurrentRatesByAssetId,
    assetGroupSessionStoredWallets,
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
      const matchingState =
        state?.requestKey === spec.requestKey ? state : undefined;
      next[spec.key] =
        matchingState?.currentData ??
        (hasCommittedPortfolioBaseline ? matchingState?.committedData : undefined);
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
      const matchingGroupState =
        groupSpec && groupState?.requestKey === groupSpec.requestKey
          ? groupState
          : undefined;
      const groupAnalysisForDisplay = assetGroupAnalysisForDisplayByKey[item.key];
      const hasScopedGroupItem = groupItemsByKey.has(item.key);
      const effectiveAnalysis =
        groupAnalysisForDisplay ?? analysis.data;
      const effectiveCurrentData =
        matchingGroupState?.currentData ?? analysis.currentData;
      const effectiveCommittedData =
        matchingGroupState?.committedData ?? analysis.committedData;
      const effectiveError = matchingGroupState?.error ?? analysis.error;
      const effectiveRequestKey =
        matchingGroupState?.requestKey ?? analysis.requestKey;
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
      const groupAnalysisError = groupState?.error
        ? {
            name: groupState.error.name,
            message: groupState.error.message,
          }
        : null;
      const hasStaleScopedGroupState =
        !!groupSpec &&
        !!groupState &&
        groupState.requestKey !== groupSpec.requestKey;
      const groupAnalysisDisplaySource = groupAnalysisForDisplay
        ? matchingGroupState?.currentData === groupAnalysisForDisplay
          ? 'asset_group_current'
          : matchingGroupState?.committedData === groupAnalysisForDisplay
            ? 'asset_group_committed'
            : 'asset_group_unknown'
        : 'portfolio_fallback';
      const showScopedPnlLoading =
        (gainLossMode === 'ALL' ||
          hasStaleScopedGroupState ||
          !!matchingGroupState?.loading) &&
        !!groupSpec &&
        !groupAnalysisForDisplay &&
        !matchingGroupState?.error;
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
        showScopedPnlLoading,
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
              sourceAnalysisScope: hasScopedGroupItem
                ? 'asset_group'
                : 'portfolio_fallback',
              groupAnalysisDisplaySource,
              hasScopedGroupSpec: !!groupSpec,
              hasScopedGroupState: !!matchingGroupState,
              groupAnalysisLoading: matchingGroupState?.loading ?? false,
              groupAnalysisHasCurrentData: !!matchingGroupState?.currentData,
              groupAnalysisHasCommittedData: !!matchingGroupState?.committedData,
              groupAnalysisCurrentWalletCount:
                matchingGroupState?.currentData?.wallets?.length ?? 0,
              groupAnalysisCommittedWalletCount:
                matchingGroupState?.committedData?.wallets?.length ?? 0,
              groupAnalysisDisplayWalletCount:
                groupAnalysisForDisplay?.wallets?.length ?? 0,
              groupAnalysisError,
              groupAnalysisRequestKey: matchingGroupState?.requestKey ?? null,
              groupSpecStoredWalletCount: groupSpec?.storedWalletIds?.length ?? 0,
              groupSpecStoredWalletIds: groupSpec?.storedWalletIds ?? [],
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
      const canFreezeResolvedItem = !item.showPnlPlaceholder;
      if (isPopulateLoadingByKeyRaw[item.key] === false) {
        if (canFreezeResolvedItem && cachedItem !== item) {
          resolvedItemsByKey[item.key] = item;
        }

        nextLoadingByKey[item.key] = false;
        return item;
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
