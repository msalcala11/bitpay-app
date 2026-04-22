import {useEffect, useMemo, useRef, useState} from 'react';
import type {AssetRowItem, GainLossMode} from '../../../utils/portfolio/assets';
import {
  buildAssetFiatPriorityByKey,
  buildWalletIdsByAssetGroupKey,
  getPortfolioWalletCurrencyAbbreviationLower,
  getPopulateLoadingByAssetKey,
  getVisibleWalletsFromKeys,
} from '../../../utils/portfolio/assets';
import type {Key} from '../../../store/wallet/wallet.models';
import {useAppSelector} from '../../../utils/hooks';
import {useDevRenderTrace} from '../../../utils/hooks/useDevRenderTrace';
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
import {
  isPortfolioRuntimeMainnetLikeNetwork,
  summarizePortfolioRuntimeWalletEligibility,
} from '../../adapters/rn/walletEligibility';

type Args = {
  gainLossMode: GainLossMode;
  keyId?: string;
  externalRefreshToken?: string | number;
  enabled?: boolean;
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
  displayScopeKey: string;
  requestKey: string;
  committedCacheKey: string;
  currentRatesByAssetId: Record<string, number>;
  currentRatesSignature: string;
  asOfMs?: number;
};

type AssetGroupAnalysisState = {
  displayScopeKey: string;
  requestKey: string;
  committedCacheKey: string;
  sessionId?: string;
  runId?: number;
  currentData?: PnlAnalysisResult;
  committedData?: PnlAnalysisResult;
  loading: boolean;
  error?: Error;
};

function summarizeAnalysisResultShape(
  value: PnlAnalysisResult | undefined,
): {
  walletCount: number;
  pointCount: number;
  assetSummaryCount: number;
  assetIdCount: number;
} {
  return {
    walletCount: Array.isArray(value?.wallets) ? value.wallets.length : 0,
    pointCount: Array.isArray(value?.points) ? value.points.length : 0,
    assetSummaryCount: Array.isArray(value?.assetSummaries)
      ? value.assetSummaries.length
      : 0,
    assetIdCount: Array.isArray(value?.assetIds) ? value.assetIds.length : 0,
  };
}

function summarizeAssetRowDisplayState(args: {
  item?: AssetRowItem;
  populateLoading?: boolean;
}): {
  present: boolean;
  hasRate: boolean;
  hasPnl: boolean;
  showPnlPlaceholder: boolean;
  showScopedPnlLoading: boolean;
  populateLoading: boolean;
  hasVisiblePnl: boolean;
  sourceAnalysisScope: string | null;
  groupAnalysisDisplaySource: string | null;
} {
  const hookDebugData = (args.item?.debugCopyPayload as any)?.extraDebugData
    ?.homeAnalysisHook;

  return {
    present: !!args.item,
    hasRate: !!args.item?.hasRate,
    hasPnl: !!args.item?.hasPnl,
    showPnlPlaceholder: !!args.item?.showPnlPlaceholder,
    showScopedPnlLoading: !!args.item?.showScopedPnlLoading,
    populateLoading: !!args.populateLoading,
    hasVisiblePnl: !!args.item && !args.item.showPnlPlaceholder,
    sourceAnalysisScope:
      typeof hookDebugData?.sourceAnalysisScope === 'string'
        ? hookDebugData.sourceAnalysisScope
        : null,
    groupAnalysisDisplaySource:
      typeof hookDebugData?.groupAnalysisDisplaySource === 'string'
        ? hookDebugData.groupAnalysisDisplaySource
        : null,
  };
}

function stabilizeVisibleItemOrder(args: {
  items: AssetRowItem[];
  previousKeys: string[];
}): AssetRowItem[] {
  const {items, previousKeys} = args;
  if (items.length < 2 || previousKeys.length < 2) {
    return items;
  }

  const itemsByKey = new Map(items.map(item => [item.key, item]));
  const previousKeysSet = new Set(previousKeys);
  const stabilizedItems: AssetRowItem[] = [];

  for (const key of previousKeys) {
    const item = itemsByKey.get(key);
    if (item) {
      stabilizedItems.push(item);
    }
  }

  for (const item of items) {
    if (!previousKeysSet.has(item.key)) {
      stabilizedItems.push(item);
    }
  }

  if (
    stabilizedItems.length !== items.length ||
    stabilizedItems.every((item, index) => item === items[index])
  ) {
    return items;
  }

  return stabilizedItems;
}

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
  enabled,
}: Args): Result {
  const analysisEnabled = enabled !== false;
  const assetScopeSurface = keyId ? 'scoped_assets' : 'home_assets';
  const portfolio = useAppSelector(({PORTFOLIO}) => PORTFOLIO);
  const homeCarouselConfig = useAppSelector(({APP}) => APP.homeCarouselConfig);
  const keys = useAppSelector(({WALLET}) => WALLET.keys) as Record<string, Key>;

  const wallets = useMemo(() => {
    if (keyId && keys[keyId]) {
      return getVisibleWalletsFromKeys({[keyId]: keys[keyId]});
    }

    return getVisibleWalletsFromKeys(keys, homeCarouselConfig);
  }, [homeCarouselConfig, keyId, keys]);
  const walletEligibilitySummary = useMemo(() => {
    return summarizePortfolioRuntimeWalletEligibility(wallets);
  }, [wallets]);
  const previousPopulateInProgressRef = useRef<boolean>(
    !!portfolio.populateStatus?.inProgress,
  );
  const isMountedRef = useRef(true);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

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
      typeof portfolio.lastPopulatedAt === 'number'
        ? String(portfolio.lastPopulatedAt)
        : '',
      '',
      '',
      '0',
      portfolio.populateStatus?.inProgress ? '1' : '0',
      typeof portfolio.populateStatus?.startedAt === 'number'
        ? String(portfolio.populateStatus.startedAt)
        : '',
    ].join('|');
  }, [
    portfolio.lastPopulatedAt,
    portfolio.populateStatus?.inProgress,
    portfolio.populateStatus?.startedAt,
  ]);
  const analysisRefreshToken = useMemo(() => {
    const populateInProgress = !!portfolio.populateStatus?.inProgress;
    const baseToken = (() => {
      if (!populateInProgress) {
        return populateCompletionStateToken;
      }

      return [
        populateSessionStateToken,
        typeof portfolio.populateStatus?.walletsCompleted === 'number'
          ? String(portfolio.populateStatus.walletsCompleted)
          : '0',
        typeof portfolio.populateStatus?.txRequestsMade === 'number'
          ? String(portfolio.populateStatus.txRequestsMade)
          : '0',
        typeof portfolio.populateStatus?.txsProcessed === 'number'
          ? String(portfolio.populateStatus.txsProcessed)
          : '0',
        typeof portfolio.populateStatus?.errors?.length === 'number'
          ? String(portfolio.populateStatus.errors.length)
          : '0',
      ].join('|');
    })();

    // Populate progress already drives live reruns. Ignore focus-driven refresh
    // churn until the active populate session settles so we do not restart the
    // scoped asset session with identical in-flight data.
    if (
      populateInProgress ||
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
    portfolio.populateStatus?.txRequestsMade,
    portfolio.populateStatus?.txsProcessed,
    portfolio.populateStatus?.walletsCompleted,
  ]);
  const analysisClearDataToken = portfolio.populateStatus?.inProgress
    ? populateSessionStateToken
    : populateCompletionStateToken;

  const analysis = usePortfolioAnalysis({
    wallets,
    timeframe: gainLossMode,
    maxPoints: 2,
    enabled: analysisEnabled,
    refreshToken: analysisRefreshToken,
    clearDataToken: analysisClearDataToken,
    freezeWhilePopulate: true,
    allowCurrentWhilePopulate: true,
    debugSource: keyId
      ? 'scoped_assets_analysis'
      : 'home_assets_analysis',
  });
  const hasCommittedPortfolioBaseline =
    typeof portfolio.lastPopulatedAt === 'number' &&
    Number.isFinite(portfolio.lastPopulatedAt);
  const assetGroupAnalysisSpecs = useMemo<AssetGroupAnalysisSpec[]>(() => {
    if (!analysisEnabled || !analysis.storedWallets.length) {
      return [];
    }

    const storedWalletsByKey = new Map<string, StoredWallet[]>();
    for (const storedWallet of analysis.storedWallets) {
      if (
        !isPortfolioRuntimeMainnetLikeNetwork(storedWallet.summary.network)
      ) {
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
      const displayScopeKey = [
        groupKey,
        analysis.quoteCurrency,
        gainLossMode,
        '2',
        getStoredWalletRequestSignature(groupStoredWallets),
      ].join('|');
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
        displayScopeKey,
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

    const priorityByKey = buildAssetFiatPriorityByKey(
      analysis.eligibleWallets?.length ? analysis.eligibleWallets : wallets,
    );

    return nextSpecs.sort((left, right) => {
      const leftPriority = priorityByKey[left.key];
      const rightPriority = priorityByKey[right.key];
      const fiatDiff =
        (rightPriority?.fiatBalance || 0) - (leftPriority?.fiatBalance || 0);
      if (fiatDiff !== 0) {
        return fiatDiff;
      }

      const firstIndexDiff =
        (leftPriority?.firstIndex ?? Number.MAX_SAFE_INTEGER) -
        (rightPriority?.firstIndex ?? Number.MAX_SAFE_INTEGER);
      if (firstIndexDiff !== 0) {
        return firstIndexDiff;
      }

      return left.key.localeCompare(right.key);
    });
  }, [
    analysisEnabled,
    analysis.currentRatesByAssetId,
    analysis.asOfMs,
    analysis.eligibleWallets,
    analysis.quoteCurrency,
    analysis.storedWallets,
    analysisClearDataToken,
    analysisRefreshToken,
    gainLossMode,
    wallets,
  ]);
  const assetGroupAnalysisSpecsRevision = useMemo(() => {
    return assetGroupAnalysisSpecs
      .map(
        spec =>
          `${spec.key}:${spec.displayScopeKey}:${spec.requestKey}:${spec.committedCacheKey}:${spec.eligibleWalletIds.join(',')}`,
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
  const assetGroupAnalysisStateByKeyRef = useRef<
    Record<string, AssetGroupAnalysisState>
  >(assetGroupAnalysisStateByKey);
  assetGroupAnalysisStateByKeyRef.current = assetGroupAnalysisStateByKey;
  const latestAssetGroupSessionRequestKeyRef = useRef(
    assetGroupSessionRequestKey,
  );
  latestAssetGroupSessionRequestKeyRef.current = assetGroupSessionRequestKey;
  const assetGroupScopeRunIdRef = useRef(0);
  const previousVisibleRowStateByKeyRef = useRef<
    Record<
      string,
      ReturnType<typeof summarizeAssetRowDisplayState>
    >
  >({});
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
        const preserveDisplayScopeData =
          prevState?.displayScopeKey === spec.displayScopeKey;
        const cachedCommittedData = hasCommittedPortfolioBaseline
          ? assetGroupCommittedAnalysisCacheRef.current.get(
              spec.committedCacheKey,
            )
          : undefined;
        const nextState: AssetGroupAnalysisState = {
          displayScopeKey: spec.displayScopeKey,
          requestKey: spec.requestKey,
          committedCacheKey: spec.committedCacheKey,
          sessionId:
            prevState?.requestKey === spec.requestKey
              ? prevState.sessionId
              : undefined,
          runId:
            prevState?.requestKey === spec.requestKey
              ? prevState.runId
              : undefined,
          currentData:
            preserveDisplayScopeData
              ? prevState.currentData
              : undefined,
          committedData: preserveDisplayScopeData
            ? prevState?.committedData ?? cachedCommittedData
            : cachedCommittedData,
          loading:
            prevState?.requestKey === spec.requestKey ? prevState.loading : false,
          error:
            prevState?.requestKey === spec.requestKey ? prevState.error : undefined,
        };
        next[spec.key] = nextState;

        if (
          !prevState ||
          prevState.displayScopeKey !== nextState.displayScopeKey ||
          prevState.requestKey !== nextState.requestKey ||
          prevState.committedCacheKey !== nextState.committedCacheKey ||
          prevState.sessionId !== nextState.sessionId ||
          prevState.runId !== nextState.runId ||
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
    const scopeRunId = assetGroupScopeRunIdRef.current + 1;
    assetGroupScopeRunIdRef.current = scopeRunId;
    const scopeRunStartedAt = Date.now();
    console.log('[portfolio-assets-scope] run start', {
      surface: assetScopeSurface,
      runId: scopeRunId,
      gainLossMode,
      specCount: assetGroupAnalysisSpecs.length,
      sessionWalletCount: assetGroupSessionStoredWallets.length,
      sessionRateAssetCount: Object.keys(
        assetGroupSessionCurrentRatesByAssetId,
      ).length,
      populateInProgress: !!portfolio.populateStatus?.inProgress,
      walletsCompleted: portfolio.populateStatus?.walletsCompleted ?? 0,
      txRequestsMade: portfolio.populateStatus?.txRequestsMade ?? 0,
      txsProcessed: portfolio.populateStatus?.txsProcessed ?? 0,
      sampleKeys: assetGroupAnalysisSpecs.slice(0, 6).map(spec => spec.key),
    });
    setAssetGroupAnalysisStateByKey(prev => {
      const next = {...prev};
      let changed = false;

      for (const spec of assetGroupAnalysisSpecs) {
        const prevState = next[spec.key];
        const preserveDisplayScopeData =
          prevState?.displayScopeKey === spec.displayScopeKey;
        const cachedCommittedData = hasCommittedPortfolioBaseline
          ? assetGroupCommittedAnalysisCacheRef.current.get(
              spec.committedCacheKey,
            )
          : undefined;
        const nextState: AssetGroupAnalysisState = {
          displayScopeKey: spec.displayScopeKey,
          requestKey: spec.requestKey,
          committedCacheKey: spec.committedCacheKey,
          sessionId:
            prevState?.requestKey === spec.requestKey
              ? prevState.sessionId
              : undefined,
          runId: scopeRunId,
          currentData:
            preserveDisplayScopeData
              ? prevState.currentData
              : undefined,
          committedData:
            preserveDisplayScopeData
              ? prevState.committedData ?? cachedCommittedData
              : cachedCommittedData,
          loading: true,
          error: undefined,
        };

        if (
          prevState &&
          prevState.displayScopeKey === nextState.displayScopeKey &&
          prevState.requestKey === nextState.requestKey &&
          prevState.committedCacheKey === nextState.committedCacheKey &&
          prevState.sessionId === nextState.sessionId &&
          prevState.runId === nextState.runId &&
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
      const shouldStopRun = (): boolean => cancelled || !isMountedRef.current;
      const shouldDiscardCancelledResult = (): boolean =>
        !isMountedRef.current ||
        latestAssetGroupSessionRequestKeyRef.current !==
          assetGroupSessionRequestKey;

      const buildBaseState = (
        prevState: AssetGroupAnalysisState | undefined,
        spec: AssetGroupAnalysisSpec,
        sessionId?: string,
        runId?: number,
      ): AssetGroupAnalysisState => {
        const cachedCommittedData = hasCommittedPortfolioBaseline
          ? assetGroupCommittedAnalysisCacheRef.current.get(
              spec.committedCacheKey,
            )
          : undefined;

        return prevState || {
          displayScopeKey: spec.displayScopeKey,
          requestKey: spec.requestKey,
          committedCacheKey: spec.committedCacheKey,
          sessionId,
          runId,
          currentData: undefined,
          committedData: cachedCommittedData,
          loading: true,
          error: undefined,
        };
      };

      const commitScopedResult = (
        args: {
          spec: AssetGroupAnalysisSpec;
          sessionId: string;
          runId: number;
          result: PnlAnalysisResult;
          via: 'session_scope' | 'fallback';
          elapsedMs: number;
        },
      ) => {
        let commitDisposition: 'applied' | 'stale' | 'noop' = 'applied';
        setAssetGroupAnalysisStateByKey(prev => {
          const prevState = prev[args.spec.key];
          if (prevState && prevState.requestKey !== args.spec.requestKey) {
            commitDisposition = 'stale';
            return prev;
          }

          const hasNewerCompatibleRun =
            !!prevState &&
            typeof prevState.runId === 'number' &&
            prevState.runId > args.runId;
          const shouldBackfillCompatibleRun =
            hasNewerCompatibleRun &&
            prevState.displayScopeKey === args.spec.displayScopeKey &&
            !prevState.currentData;

          if (hasNewerCompatibleRun && !shouldBackfillCompatibleRun) {
            commitDisposition = 'stale';
            return prev;
          }

          const effectiveSessionId = shouldBackfillCompatibleRun
            ? prevState?.sessionId
            : args.sessionId;
          const effectiveRunId = shouldBackfillCompatibleRun
            ? prevState?.runId
            : args.runId;

          const baseState = buildBaseState(
            prevState,
            args.spec,
            effectiveSessionId,
            effectiveRunId,
          );

          let committedData = baseState.committedData;
          if (!portfolio.populateStatus?.inProgress) {
            assetGroupCommittedAnalysisCacheRef.current.set(
              args.spec.committedCacheKey,
              args.result,
            );
            committedData = args.result;
          }

          const nextState: AssetGroupAnalysisState = {
            ...baseState,
            displayScopeKey: args.spec.displayScopeKey,
            sessionId: effectiveSessionId,
            runId: effectiveRunId,
            currentData: args.result,
            committedData,
            loading: shouldBackfillCompatibleRun
              ? baseState.loading
              : false,
            error: undefined,
          };

          if (
            baseState.displayScopeKey === nextState.displayScopeKey &&
            baseState.sessionId === nextState.sessionId &&
            baseState.runId === nextState.runId &&
            baseState.currentData === nextState.currentData &&
            baseState.committedData === nextState.committedData &&
            baseState.loading === nextState.loading &&
            baseState.error === nextState.error
          ) {
            commitDisposition = 'noop';
            return prev;
          }

          commitDisposition = 'applied';
          return {
            ...prev,
            [args.spec.key]: nextState,
          };
        });
        console.log('[portfolio-assets-scope] spec result', {
          surface: assetScopeSurface,
          runId: scopeRunId,
          assetKey: args.spec.key,
          via: args.via,
          elapsedMs: args.elapsedMs,
          commitDisposition,
          populateInProgress: !!portfolio.populateStatus?.inProgress,
          ...summarizeAnalysisResultShape(args.result),
        });
      };

      const commitScopedError = (
        args: {
          spec: AssetGroupAnalysisSpec;
          sessionId: string | undefined;
          runId: number;
          error: Error;
          via: 'session_scope' | 'fallback' | 'session_prepare';
          elapsedMs: number;
        },
      ) => {
        let commitDisposition: 'applied' | 'stale' | 'noop' = 'applied';
        setAssetGroupAnalysisStateByKey(prev => {
          const prevState = prev[args.spec.key];
          if (prevState && prevState.requestKey !== args.spec.requestKey) {
            commitDisposition = 'stale';
            return prev;
          }

          if (
            prevState &&
            typeof prevState.runId === 'number' &&
            prevState.runId > args.runId
          ) {
            commitDisposition = 'stale';
            return prev;
          }

          const baseState = buildBaseState(
            prevState,
            args.spec,
            args.sessionId,
            args.runId,
          );
          const nextState: AssetGroupAnalysisState = {
            ...baseState,
            displayScopeKey: args.spec.displayScopeKey,
            sessionId: args.sessionId,
            runId: args.runId,
            loading: false,
            error: args.error,
          };

          if (
            baseState.displayScopeKey === nextState.displayScopeKey &&
            baseState.sessionId === nextState.sessionId &&
            baseState.runId === nextState.runId &&
            baseState.loading === nextState.loading &&
            baseState.error === nextState.error
          ) {
            commitDisposition = 'noop';
            return prev;
          }

          commitDisposition = 'applied';
          return {
            ...prev,
            [args.spec.key]: nextState,
          };
        });
        console.log('[portfolio-assets-scope] spec error', {
          surface: assetScopeSurface,
          runId: scopeRunId,
          assetKey: args.spec.key,
          via: args.via,
          elapsedMs: args.elapsedMs,
          commitDisposition,
          populateInProgress: !!portfolio.populateStatus?.inProgress,
          message: args.error.message,
        });
      };

      const tryUseExistingScopedResultForSpec = (
        sessionId: string,
        spec: AssetGroupAnalysisSpec,
      ): boolean => {
        const currentState = assetGroupAnalysisStateByKeyRef.current[spec.key];
        if (
          currentState?.requestKey !== spec.requestKey ||
          currentState?.displayScopeKey !== spec.displayScopeKey ||
          !currentState.currentData
        ) {
          return false;
        }

        let commitDisposition: 'applied' | 'stale' | 'noop' = 'applied';
        setAssetGroupAnalysisStateByKey(prev => {
          const prevState = prev[spec.key];
          if (
            !prevState ||
            prevState.requestKey !== spec.requestKey ||
            prevState.displayScopeKey !== spec.displayScopeKey ||
            !prevState.currentData
          ) {
            commitDisposition = 'stale';
            return prev;
          }

          const nextState: AssetGroupAnalysisState = {
            ...prevState,
            sessionId,
            runId: scopeRunId,
            loading: false,
            error: undefined,
          };

          if (
            prevState.sessionId === nextState.sessionId &&
            prevState.runId === nextState.runId &&
            prevState.loading === nextState.loading &&
            prevState.error === nextState.error
          ) {
            commitDisposition = 'noop';
            return prev;
          }

          commitDisposition = 'applied';
          return {
            ...prev,
            [spec.key]: nextState,
          };
        });
        console.log('[portfolio-assets-scope] spec skipped', {
          surface: assetScopeSurface,
          runId: scopeRunId,
          assetKey: spec.key,
          reason: 'already_resolved_for_request',
          scopedWalletCount: spec.storedWalletIds.length,
          commitDisposition,
          populateInProgress: !!portfolio.populateStatus?.inProgress,
        });
        return true;
      };

      const runScopedAnalysisForSpec = async (
        sessionId: string,
        spec: AssetGroupAnalysisSpec,
      ) => {
        const scopeRequestStartedAt = Date.now();
        console.log('[portfolio-assets-scope] spec request', {
          surface: assetScopeSurface,
          runId: scopeRunId,
          assetKey: spec.key,
          via: 'session_scope',
          scopedWalletCount: spec.storedWalletIds.length,
          populateInProgress: !!portfolio.populateStatus?.inProgress,
        });
        try {
          const result = await runPortfolioAnalysisSessionScopeQuery({
            sessionId,
            walletIds: spec.storedWalletIds,
            debugSource: keyId
              ? 'scoped_assets_session_scope'
              : 'home_assets_session_scope',
          });
          if (!isMountedRef.current) {
            return;
          }

          if (cancelled && shouldDiscardCancelledResult()) {
            console.log('[portfolio-assets-scope] spec result discarded', {
              surface: assetScopeSurface,
              runId: scopeRunId,
              assetKey: spec.key,
              via: 'session_scope',
              elapsedMs: Date.now() - scopeRequestStartedAt,
              reason: 'cancelled_after_result',
              ...summarizeAnalysisResultShape(result),
            });
            return;
          }

          commitScopedResult({
            spec,
            sessionId,
            runId: scopeRunId,
            result,
            via: 'session_scope',
            elapsedMs: Date.now() - scopeRequestStartedAt,
          });
        } catch (reason) {
          if (shouldStopRun()) {
            console.log('[portfolio-assets-scope] spec error discarded', {
              surface: assetScopeSurface,
              runId: scopeRunId,
              assetKey: spec.key,
              via: 'session_scope',
              elapsedMs: Date.now() - scopeRequestStartedAt,
              reason: 'cancelled_after_error',
              message:
                reason instanceof Error ? reason.message : String(reason),
            });
            return;
          }

          const error =
            reason instanceof Error ? reason : new Error(String(reason));
          const isMissingPreparedSession = error.message.includes(
            'Prepared portfolio analysis session not found',
          );

          if (isMissingPreparedSession) {
            const fallbackStartedAt = Date.now();
            console.log('[portfolio-assets-scope] spec fallback start', {
              surface: assetScopeSurface,
              runId: scopeRunId,
              assetKey: spec.key,
              reason: 'missing_prepared_session',
              scopedWalletCount: spec.storedWalletIds.length,
              populateInProgress: !!portfolio.populateStatus?.inProgress,
            });
            try {
              const fallbackResult = await runPortfolioAnalysisQuery({
                wallets: spec.storedWallets,
                quoteCurrency: analysis.quoteCurrency,
                timeframe: gainLossMode,
                maxPoints: 2,
                currentRatesByAssetId: spec.currentRatesByAssetId,
                asOfMs: analysis.asOfMs,
                debugSource: keyId
                  ? 'scoped_assets_session_fallback'
                  : 'home_assets_session_fallback',
              });
              if (!isMountedRef.current) {
                return;
              }

              if (cancelled && shouldDiscardCancelledResult()) {
                console.log('[portfolio-assets-scope] spec result discarded', {
                  surface: assetScopeSurface,
                  runId: scopeRunId,
                  assetKey: spec.key,
                  via: 'fallback',
                  elapsedMs: Date.now() - fallbackStartedAt,
                  reason: 'cancelled_after_result',
                  ...summarizeAnalysisResultShape(fallbackResult),
                });
                return;
              }

              commitScopedResult({
                spec,
                sessionId,
                runId: scopeRunId,
                result: fallbackResult,
                via: 'fallback',
                elapsedMs: Date.now() - fallbackStartedAt,
              });
              return;
            } catch (fallbackReason) {
              if (shouldStopRun()) {
                console.log('[portfolio-assets-scope] spec error discarded', {
                  surface: assetScopeSurface,
                  runId: scopeRunId,
                  assetKey: spec.key,
                  via: 'fallback',
                  elapsedMs: Date.now() - fallbackStartedAt,
                  reason: 'cancelled_after_error',
                  message:
                    fallbackReason instanceof Error
                      ? fallbackReason.message
                      : String(fallbackReason),
                });
                return;
              }

              commitScopedError({
                spec,
                sessionId,
                runId: scopeRunId,
                error:
                  fallbackReason instanceof Error
                    ? fallbackReason
                    : new Error(String(fallbackReason)),
                via: 'fallback',
                elapsedMs: Date.now() - fallbackStartedAt,
              });
              return;
            }
          }

          commitScopedError({
            spec,
            sessionId,
            runId: scopeRunId,
            error,
            via: 'session_scope',
            elapsedMs: Date.now() - scopeRequestStartedAt,
          });
        }
      };

      try {
        console.log('[portfolio-assets-scope] run prepare request', {
          surface: assetScopeSurface,
          runId: scopeRunId,
          gainLossMode,
          specCount: assetGroupAnalysisSpecs.length,
          sessionWalletCount: assetGroupSessionStoredWallets.length,
          sessionRateAssetCount: Object.keys(
            assetGroupSessionCurrentRatesByAssetId,
          ).length,
          populateInProgress: !!portfolio.populateStatus?.inProgress,
        });
        const session = await preparePortfolioAnalysisSessionQuery({
          wallets: assetGroupSessionStoredWallets,
          quoteCurrency: analysis.quoteCurrency,
          timeframe: gainLossMode,
          maxPoints: 2,
          currentRatesByAssetId: assetGroupSessionCurrentRatesByAssetId,
          asOfMs: analysis.asOfMs,
          debugSource: keyId
            ? 'scoped_assets_session_prepare'
            : 'home_assets_session_prepare',
        });

        preparedSessionId = session.sessionId;
        if (shouldStopRun()) {
          console.log('[portfolio-assets-scope] run prepare discarded', {
            surface: assetScopeSurface,
            runId: scopeRunId,
            elapsedMs: Date.now() - scopeRunStartedAt,
            reason: 'cancelled_after_prepare',
          });
          return;
        }
        console.log('[portfolio-assets-scope] run prepared', {
          surface: assetScopeSurface,
          runId: scopeRunId,
          elapsedMs: Date.now() - scopeRunStartedAt,
          specCount: assetGroupAnalysisSpecs.length,
          populateInProgress: !!portfolio.populateStatus?.inProgress,
          disposition: 'current',
        });

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
              displayScopeKey: spec.displayScopeKey,
              sessionId: session.sessionId,
              runId: scopeRunId,
              loading: true,
              error: undefined,
            };

            if (
              prevState &&
              prevState.displayScopeKey === nextState.displayScopeKey &&
              prevState.requestKey === nextState.requestKey &&
              prevState.committedCacheKey === nextState.committedCacheKey &&
              prevState.sessionId === nextState.sessionId &&
              prevState.runId === nextState.runId &&
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

        if (portfolio.populateStatus?.inProgress) {
          // During populate, serialize scoped asset requests in the same
          // priority order as the asset groups so rows can reveal
          // progressively instead of bunching behind a parallel fanout.
          for (const spec of assetGroupAnalysisSpecs) {
            if (shouldStopRun()) {
              break;
            }

            if (tryUseExistingScopedResultForSpec(session.sessionId, spec)) {
              continue;
            }

            await runScopedAnalysisForSpec(session.sessionId, spec);
          }
        } else {
          await Promise.allSettled(
            assetGroupAnalysisSpecs.map(spec =>
              runScopedAnalysisForSpec(session.sessionId, spec),
            ),
          );
        }
        console.log('[portfolio-assets-scope] run settled', {
          surface: assetScopeSurface,
          runId: scopeRunId,
          elapsedMs: Date.now() - scopeRunStartedAt,
          specCount: assetGroupAnalysisSpecs.length,
          populateInProgress: !!portfolio.populateStatus?.inProgress,
        });
      } catch (reason) {
        if (shouldStopRun()) {
          console.log('[portfolio-assets-scope] run error discarded', {
            surface: assetScopeSurface,
            runId: scopeRunId,
            elapsedMs: Date.now() - scopeRunStartedAt,
            reason: 'cancelled_after_prepare_error',
            message:
              reason instanceof Error ? reason.message : String(reason),
          });
          return;
        }

        const error =
          reason instanceof Error ? reason : new Error(String(reason));
        console.log('[portfolio-assets-scope] run error', {
          surface: assetScopeSurface,
          runId: scopeRunId,
          elapsedMs: Date.now() - scopeRunStartedAt,
          specCount: assetGroupAnalysisSpecs.length,
          populateInProgress: !!portfolio.populateStatus?.inProgress,
          message: error.message,
        });
        setAssetGroupAnalysisStateByKey(prev => {
          const next = {...prev};
          let changed = false;

          for (const spec of assetGroupAnalysisSpecs) {
            const prevState = next[spec.key];
            const baseState: AssetGroupAnalysisState = prevState || {
              displayScopeKey: spec.displayScopeKey,
              requestKey: spec.requestKey,
              committedCacheKey: spec.committedCacheKey,
              currentData: undefined,
              committedData: hasCommittedPortfolioBaseline
              ? assetGroupCommittedAnalysisCacheRef.current.get(
                  spec.committedCacheKey,
                )
              : undefined,
              sessionId: preparedSessionId,
              runId: scopeRunId,
              loading: true,
              error: undefined,
            };
            const nextState: AssetGroupAnalysisState = {
              ...baseState,
              displayScopeKey: spec.displayScopeKey,
              sessionId: preparedSessionId,
              runId: scopeRunId,
              loading: false,
              error,
            };

            if (
              prevState?.sessionId !== nextState.sessionId ||
              prevState?.runId !== nextState.runId ||
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
          console.log('[portfolio-assets-scope] run disposed', {
            surface: assetScopeSurface,
            runId: scopeRunId,
            elapsedMs: Date.now() - scopeRunStartedAt,
            hadPreparedSession: true,
          });
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
    assetScopeSurface,
    gainLossMode,
    hasCommittedPortfolioBaseline,
    analysisRefreshToken,
    portfolio.populateStatus?.inProgress,
    portfolio.populateStatus?.txRequestsMade,
    portfolio.populateStatus?.txsProcessed,
    portfolio.populateStatus?.walletsCompleted,
  ]);
  const assetGroupAnalysisForDisplayByKey = useMemo(() => {
    const next: Record<string, PnlAnalysisResult | undefined> = {};

    for (const spec of assetGroupAnalysisSpecs) {
      const state = assetGroupAnalysisStateByKey[spec.key];
      const displayScopeState =
        state?.displayScopeKey === spec.displayScopeKey ? state : undefined;
      next[spec.key] =
        displayScopeState?.currentData ??
        (hasCommittedPortfolioBaseline
          ? displayScopeState?.committedData
          : undefined);
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
    if (!analysisEnabled) {
      return [];
    }

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
      const displayScopeGroupState =
        groupSpec && groupState?.displayScopeKey === groupSpec.displayScopeKey
          ? groupState
          : undefined;
      const matchingGroupState =
        groupSpec && groupState?.requestKey === groupSpec.requestKey
          ? groupState
          : undefined;
      const groupAnalysisForDisplay = assetGroupAnalysisForDisplayByKey[item.key];
      const hasScopedGroupItem = groupItemsByKey.has(item.key);
      const effectiveAnalysis =
        groupAnalysisForDisplay ?? analysis.data;
      const effectiveCurrentData =
        displayScopeGroupState?.currentData ??
        matchingGroupState?.currentData ??
        analysis.currentData;
      const effectiveCommittedData =
        displayScopeGroupState?.committedData ??
        matchingGroupState?.committedData ??
        analysis.committedData;
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
      const isAwaitingScopedGroupBootstrap =
        !!groupSpec &&
        !groupAnalysisForDisplay &&
        !matchingGroupState?.error &&
        (!matchingGroupState ||
          (!matchingGroupState.currentData &&
            !matchingGroupState.committedData));
      const groupAnalysisDisplaySource = groupAnalysisForDisplay
        ? displayScopeGroupState?.currentData === groupAnalysisForDisplay
          ? 'asset_group_current'
          : displayScopeGroupState?.committedData === groupAnalysisForDisplay
            ? 'asset_group_committed'
            : 'asset_group_unknown'
        : 'portfolio_fallback';
      const showScopedPnlLoading =
        (gainLossMode === 'ALL' ||
          hasStaleScopedGroupState ||
          isAwaitingScopedGroupBootstrap ||
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
              groupAnalysisDisplayScopeKey:
                displayScopeGroupState?.displayScopeKey ?? null,
              hasScopedGroupSpec: !!groupSpec,
              hasScopedGroupState: !!matchingGroupState,
              hasDisplayScopedGroupState: !!displayScopeGroupState,
              groupAnalysisLoading: matchingGroupState?.loading ?? false,
              groupAnalysisHasCurrentData:
                !!displayScopeGroupState?.currentData,
              groupAnalysisHasCommittedData:
                !!displayScopeGroupState?.committedData,
              groupAnalysisCurrentWalletCount:
                displayScopeGroupState?.currentData?.wallets?.length ?? 0,
              groupAnalysisCommittedWalletCount:
                displayScopeGroupState?.committedData?.wallets?.length ?? 0,
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
    analysisEnabled,
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
  const visibleItemsStableDuringPopulate = useMemo(() => {
    return items;
  }, [items]);
  const lastNonEmptyVisibleItemsRef = useRef<AssetRowItem[]>([]);
  useEffect(() => {
    if (!visibleItemsStableDuringPopulate.length) {
      return;
    }

    lastNonEmptyVisibleItemsRef.current = visibleItemsStableDuringPopulate;
  }, [visibleItemsStableDuringPopulate]);
  const hasLoadingVisibleItemsGap = useMemo(() => {
    if (
      visibleItemsStableDuringPopulate.length ||
      !lastNonEmptyVisibleItemsRef.current.length
    ) {
      return false;
    }

    const hasLoadingScopedAnalysis = assetGroupAnalysisSpecs.some(spec => {
      const state = assetGroupAnalysisStateByKey[spec.key];
      return !!state?.loading;
    });

    return analysis.loading || hasLoadingScopedAnalysis;
  }, [
    analysis.loading,
    assetGroupAnalysisSpecs,
    assetGroupAnalysisStateByKey,
    visibleItemsStableDuringPopulate,
  ]);

  const visibleItems = useMemo(() => {
    if (visibleItemsStableDuringPopulate.length) {
      return visibleItemsStableDuringPopulate;
    }

    if (
      (portfolio.populateStatus?.inProgress && analysis.committedData) ||
      hasLoadingVisibleItemsGap
    ) {
      return lastNonEmptyVisibleItemsRef.current;
    }

    return visibleItemsStableDuringPopulate;
  }, [
    analysis.committedData,
    hasLoadingVisibleItemsGap,
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
      const hasResolvedDisplayData = !item.showPnlPlaceholder;

      // Once a row has concrete PnL output, keep it visible for the rest of
      // the populate session even if later refreshes briefly fall back.
      if (hasResolvedDisplayData) {
        if (cachedItem !== item) {
          resolvedItemsByKey[item.key] = item;
        }

        if (nextLoadingByKey[item.key] !== false) {
          loadingChanged = true;
        }
        nextLoadingByKey[item.key] = false;
        return item;
      }

      if (isPopulateLoadingByKeyRaw[item.key] === false) {
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
  const hasPendingVisibleOrderStabilization = useMemo(() => {
    return (
      !!portfolio.populateStatus?.inProgress ||
      analysis.loading ||
      hasLoadingVisibleItemsGap ||
      assetGroupAnalysisSpecs.some(spec => {
        const state = assetGroupAnalysisStateByKey[spec.key];
        return !!state?.loading;
      })
    );
  }, [
    analysis.loading,
    assetGroupAnalysisSpecs,
    assetGroupAnalysisStateByKey,
    hasLoadingVisibleItemsGap,
    portfolio.populateStatus?.inProgress,
  ]);
  const lastStableVisibleItemOrderRef = useRef<string[]>([]);
  const visibleItemsForDisplay = useMemo(() => {
    const nextItems = stablePopulatePresentation.visibleItems;
    const previousKeys = lastStableVisibleItemOrderRef.current;

    if (!hasPendingVisibleOrderStabilization || !previousKeys.length) {
      return nextItems;
    }

    return stabilizeVisibleItemOrder({
      items: nextItems,
      previousKeys,
    });
  }, [
    hasPendingVisibleOrderStabilization,
    stablePopulatePresentation.visibleItems,
  ]);
  useEffect(() => {
    if (!visibleItemsForDisplay.length) {
      return;
    }

    if (
      !lastStableVisibleItemOrderRef.current.length ||
      !hasPendingVisibleOrderStabilization
    ) {
      lastStableVisibleItemOrderRef.current = visibleItemsForDisplay.map(
        item => item.key,
      );
    }
  }, [hasPendingVisibleOrderStabilization, visibleItemsForDisplay]);
  const assetGroupLoadingCount = useMemo(() => {
    return Object.values(assetGroupAnalysisStateByKey).filter(
      state => !!state?.loading,
    ).length;
  }, [assetGroupAnalysisStateByKey]);
  const assetGroupCurrentDataCount = useMemo(() => {
    return Object.values(assetGroupAnalysisStateByKey).filter(
      state => !!state?.currentData,
    ).length;
  }, [assetGroupAnalysisStateByKey]);
  const assetGroupCommittedDataCount = useMemo(() => {
    return Object.values(assetGroupAnalysisStateByKey).filter(
      state => !!state?.committedData,
    ).length;
  }, [assetGroupAnalysisStateByKey]);
  const assetGroupErrorCount = useMemo(() => {
    return Object.values(assetGroupAnalysisStateByKey).filter(
      state => !!state?.error,
    ).length;
  }, [assetGroupAnalysisStateByKey]);
  const populateLoadingItemCount = useMemo(() => {
    return Object.values(
      stablePopulatePresentation.isPopulateLoadingByKey || {},
    ).filter(Boolean).length;
  }, [stablePopulatePresentation.isPopulateLoadingByKey]);
  useEffect(() => {
    const nextVisibleRowStateByKey = visibleItemsForDisplay.reduce<
      Record<string, ReturnType<typeof summarizeAssetRowDisplayState>>
    >((accumulator, item) => {
      accumulator[item.key] = summarizeAssetRowDisplayState({
        item,
        populateLoading:
          stablePopulatePresentation.isPopulateLoadingByKey?.[item.key] ??
          false,
      });
      return accumulator;
    }, {});
    const previousVisibleRowStateByKey =
      previousVisibleRowStateByKeyRef.current;
    previousVisibleRowStateByKeyRef.current = nextVisibleRowStateByKey;

    const changedRows = Array.from(
      new Set([
        ...Object.keys(previousVisibleRowStateByKey),
        ...Object.keys(nextVisibleRowStateByKey),
      ]),
    )
      .filter(key => {
        return (
          JSON.stringify(previousVisibleRowStateByKey[key] || null) !==
          JSON.stringify(nextVisibleRowStateByKey[key] || null)
        );
      })
      .slice(0, 6)
      .map(key => ({
        key,
        prev: previousVisibleRowStateByKey[key] || null,
        next: nextVisibleRowStateByKey[key] || null,
      }));

    if (!changedRows.length) {
      return;
    }

    console.log('[portfolio-row-display] transition', {
      surface: assetScopeSurface,
      gainLossMode,
      populateInProgress: !!portfolio.populateStatus?.inProgress,
      walletsCompleted: portfolio.populateStatus?.walletsCompleted ?? 0,
      txRequestsMade: portfolio.populateStatus?.txRequestsMade ?? 0,
      txsProcessed: portfolio.populateStatus?.txsProcessed ?? 0,
      visibleItemCount: visibleItemsForDisplay.length,
      changedRows,
    });
  }, [
    assetScopeSurface,
    gainLossMode,
    portfolio.populateStatus?.inProgress,
    portfolio.populateStatus?.txRequestsMade,
    portfolio.populateStatus?.txsProcessed,
    portfolio.populateStatus?.walletsCompleted,
    stablePopulatePresentation.isPopulateLoadingByKey,
    visibleItemsForDisplay,
  ]);
  const lastIncrementalDiagnosticsSignatureRef = useRef('');

  useEffect(() => {
    if (
      !analysisEnabled ||
      (!portfolio.populateStatus?.inProgress &&
        !analysis.loading &&
        assetGroupLoadingCount === 0)
    ) {
      return;
    }

    const rowDiagnostics = visibleItemsForDisplay.slice(0, 6).map(item => ({
      key: item.key,
      hasRate: !!item.hasRate,
      hasPnl: !!item.hasPnl,
      showPnlPlaceholder: !!item.showPnlPlaceholder,
      showScopedPnlLoading: !!item.showScopedPnlLoading,
      populateLoading:
        stablePopulatePresentation.isPopulateLoadingByKey?.[item.key] ?? false,
      deltaFiat: item.deltaFiat,
      deltaPercent: item.deltaPercent,
    }));
    const assetGroupDiagnostics = assetGroupAnalysisSpecs
      .slice(0, 6)
      .map(spec => {
        const state = assetGroupAnalysisStateByKey[spec.key];
        const displayScopeState =
          state?.displayScopeKey === spec.displayScopeKey ? state : undefined;
        return {
          key: spec.key,
          loading: !!state?.loading,
          hasDisplayData: !!assetGroupAnalysisForDisplayByKey[spec.key],
          hasCurrentData: !!displayScopeState?.currentData,
          hasCommittedData: !!displayScopeState?.committedData,
          hasError: !!state?.error,
          current: summarizeAnalysisResultShape(displayScopeState?.currentData),
          committed: summarizeAnalysisResultShape(
            displayScopeState?.committedData,
          ),
        };
      });

    const summary = {
      surface: assetScopeSurface,
      gainLossMode,
      populate: {
        inProgress: !!portfolio.populateStatus?.inProgress,
        walletsCompleted: portfolio.populateStatus?.walletsCompleted ?? 0,
        txRequestsMade: portfolio.populateStatus?.txRequestsMade ?? 0,
        txsProcessed: portfolio.populateStatus?.txsProcessed ?? 0,
        errorCount: portfolio.populateStatus?.errors?.length ?? 0,
      },
      analysisTokens: {
        refreshToken: analysisRefreshToken,
        clearDataToken: analysisClearDataToken,
      },
      analysis: {
        loading: analysis.loading,
        hasError: !!analysis.error,
        currentRatesAssetCount: Object.keys(
          analysis.currentRatesByAssetId || {},
        ).length,
        selected: summarizeAnalysisResultShape(analysis.data),
        current: summarizeAnalysisResultShape(analysis.currentData),
        committed: summarizeAnalysisResultShape(analysis.committedData),
      },
      rows: {
        visibleCount: visibleItemsForDisplay.length,
        resolvedCount: visibleItemsForDisplay.filter(
          item => !item.showPnlPlaceholder,
        ).length,
        placeholderCount: visibleItemsForDisplay.filter(item =>
          !!item.showPnlPlaceholder,
        ).length,
        scopedLoadingCount: visibleItemsForDisplay.filter(item =>
          !!item.showScopedPnlLoading,
        ).length,
        populateLoadingCount: populateLoadingItemCount,
        sample: rowDiagnostics,
      },
      assetGroups: {
        specCount: assetGroupAnalysisSpecs.length,
        loadingCount: assetGroupLoadingCount,
        currentDataCount: assetGroupCurrentDataCount,
        committedDataCount: assetGroupCommittedDataCount,
        errorCount: assetGroupErrorCount,
        sample: assetGroupDiagnostics,
      },
    };
    const signature = JSON.stringify(summary);
    if (lastIncrementalDiagnosticsSignatureRef.current === signature) {
      return;
    }

    lastIncrementalDiagnosticsSignatureRef.current = signature;
    console.log('[portfolio-incremental-diagnostics] usePortfolioAssetRows', summary);
  }, [
    analysis.data,
    analysis.loading,
    analysis.currentData,
    analysis.committedData,
    analysis.currentRatesByAssetId,
    analysis.error,
    analysisClearDataToken,
    analysisEnabled,
    analysisRefreshToken,
    assetGroupAnalysisForDisplayByKey,
    assetGroupAnalysisSpecs,
    assetGroupAnalysisStateByKey,
    assetGroupCommittedDataCount,
    assetGroupCurrentDataCount,
    assetGroupErrorCount,
    assetGroupLoadingCount,
    assetScopeSurface,
    gainLossMode,
    populateLoadingItemCount,
    portfolio.populateStatus?.errors?.length,
    portfolio.populateStatus?.inProgress,
    portfolio.populateStatus?.txRequestsMade,
    portfolio.populateStatus?.txsProcessed,
    portfolio.populateStatus?.walletsCompleted,
    stablePopulatePresentation.isPopulateLoadingByKey,
    visibleItemsForDisplay,
  ]);

  useDevRenderTrace('usePortfolioAssetRows', {
    analysisEnabled,
    gainLossMode,
    hasKeyScope: !!keyId,
    walletCount: wallets.length,
    eligibleWalletCount: analysis.eligibleWallets?.length ?? 0,
    storedWalletCount: analysis.storedWallets?.length ?? 0,
    excludedWalletCount: walletEligibilitySummary.excludedWalletCount,
    missingWalletIdCount: walletEligibilitySummary.missingWalletIdCount,
    missingCopayerIdCount: walletEligibilitySummary.missingCopayerIdCount,
    missingRequestPrivKeyCount:
      walletEligibilitySummary.missingRequestPrivKeyCount,
    nonMainnetNetworkCount: walletEligibilitySummary.nonMainnetNetworkCount,
    pendingTssSessionCount: walletEligibilitySummary.pendingTssSessionCount,
    incompleteCredentialsCount:
      walletEligibilitySummary.incompleteCredentialsCount,
    analysisHasRequestKey: !!analysis.requestKey,
    analysisQuoteCurrency: analysis.quoteCurrency || '',
    analysisLoading: analysis.loading,
    analysisHasError: !!analysis.error,
    analysisHasData: !!analysis.data,
    analysisHasCommittedData: !!analysis.committedData,
    analysisCurrentWalletCount: analysis.currentData?.wallets?.length ?? 0,
    analysisCommittedWalletCount:
      analysis.committedData?.wallets?.length ?? 0,
    analysisHasRefreshToken: !!analysisRefreshToken,
    analysisHasClearDataToken: !!analysisClearDataToken,
    assetGroupSpecCount: assetGroupAnalysisSpecs.length,
    assetGroupHasSessionRequestKey: !!assetGroupSessionRequestKey,
    assetGroupLoadingCount,
    assetGroupCurrentDataCount,
    assetGroupCommittedDataCount,
    assetGroupErrorCount,
    populateInProgress: !!portfolio.populateStatus?.inProgress,
    populateWalletsCompleted: portfolio.populateStatus?.walletsCompleted ?? null,
    lastPopulatedAt: portfolio.lastPopulatedAt ?? null,
    visibleItemCount: visibleItemsForDisplay.length,
    hasLoadingVisibleItemsGap,
    hasPendingVisibleOrderStabilization,
    populateLoadingItemCount,
  });
  useEffect(() => {
    const previousPopulateInProgress = previousPopulateInProgressRef.current;
    const nextPopulateInProgress = !!portfolio.populateStatus?.inProgress;

    if (previousPopulateInProgress && !nextPopulateInProgress) {
      console.log('[portfolio-post-populate] usePortfolioAssetRows', {
        gainLossMode,
        hasKeyScope: !!keyId,
        walletCount: wallets.length,
        eligibleWalletCount: analysis.eligibleWallets?.length ?? 0,
        storedWalletCount: analysis.storedWallets?.length ?? 0,
        excludedWalletCount: walletEligibilitySummary.excludedWalletCount,
        missingWalletIdCount: walletEligibilitySummary.missingWalletIdCount,
        missingCopayerIdCount:
          walletEligibilitySummary.missingCopayerIdCount,
        missingRequestPrivKeyCount:
          walletEligibilitySummary.missingRequestPrivKeyCount,
        nonMainnetNetworkCount:
          walletEligibilitySummary.nonMainnetNetworkCount,
        pendingTssSessionCount:
          walletEligibilitySummary.pendingTssSessionCount,
        incompleteCredentialsCount:
          walletEligibilitySummary.incompleteCredentialsCount,
        lastPopulatedAt: portfolio.lastPopulatedAt ?? null,
        analysisHasRequestKey: !!analysis.requestKey,
        analysisLoading: analysis.loading,
        analysisHasError: !!analysis.error,
        analysisHasData: !!analysis.data,
        analysisHasCommittedData: !!analysis.committedData,
        analysisCurrentWalletCount: analysis.currentData?.wallets?.length ?? 0,
        analysisCommittedWalletCount:
          analysis.committedData?.wallets?.length ?? 0,
        assetGroupSpecCount: assetGroupAnalysisSpecs.length,
        assetGroupLoadingCount,
        assetGroupCurrentDataCount,
        assetGroupCommittedDataCount,
        assetGroupErrorCount,
        visibleItemCount: visibleItemsForDisplay.length,
        hasAnyPortfolioData:
          visibleItemsForDisplay.length > 0 ||
          !!analysis.data ||
          !!analysis.committedData ||
          Object.values(assetGroupAnalysisStateByKey).some(
            state => !!state.currentData || !!state.committedData,
          ),
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
        hasLoadingVisibleItemsGap,
        hasPendingVisibleOrderStabilization,
        populateLoadingItemCount,
      });
    }

    previousPopulateInProgressRef.current = nextPopulateInProgress;
  }, [
    analysis.currentData,
    analysis.data,
    analysis.error,
    analysis.eligibleWallets,
    analysis.loading,
    analysis.committedData,
    analysis.storedWallets,
    assetGroupAnalysisSpecs,
    assetGroupAnalysisStateByKey,
    assetGroupCommittedDataCount,
    assetGroupCurrentDataCount,
    assetGroupErrorCount,
    assetGroupLoadingCount,
    gainLossMode,
    hasLoadingVisibleItemsGap,
    hasPendingVisibleOrderStabilization,
    keyId,
    populateLoadingItemCount,
    portfolio.lastPopulatedAt,
    portfolio.populateStatus?.inProgress,
    visibleItemsForDisplay,
    walletEligibilitySummary.excludedWalletCount,
    walletEligibilitySummary.incompleteCredentialsCount,
    walletEligibilitySummary.missingCopayerIdCount,
    walletEligibilitySummary.missingRequestPrivKeyCount,
    walletEligibilitySummary.missingWalletIdCount,
    walletEligibilitySummary.nonMainnetNetworkCount,
    walletEligibilitySummary.pendingTssSessionCount,
    wallets.length,
  ]);

  return {
    visibleItems: visibleItemsForDisplay,
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
      visibleItemsForDisplay.length > 0 ||
      !!analysis.data ||
      !!analysis.committedData ||
      Object.values(assetGroupAnalysisStateByKey).some(
        state => !!state.currentData || !!state.committedData,
      ) ||
      !!portfolio.populateStatus?.inProgress,
  };
}

export default usePortfolioAssetRows;
