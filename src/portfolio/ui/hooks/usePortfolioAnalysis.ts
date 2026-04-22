import {useEffect, useMemo, useState} from 'react';
import type {Wallet} from '../../../store/wallet/wallet.models';
import type {PnlAnalysisResult, PnlTimeframe} from '../../core/pnl/analysisStreaming';
import {useAppSelector} from '../../../utils/hooks';
import {runPortfolioAnalysisQuery} from '../common';
import {usePortfolioRuntimeQuery} from './usePortfolioRuntimeQuery';

export type UsePortfolioAnalysisResult = ReturnType<typeof usePortfolioAnalysis>;

const committedAnalysisCache = new Map<string, PnlAnalysisResult>();

function shouldLogPortfolioAssetDiagnostics(debugSource?: string): boolean {
  return /asset/i.test(String(debugSource || ''));
}

function summarizeAnalysisResultShape(
  value: PnlAnalysisResult | undefined,
): {
  walletCount: number;
  pointCount: number;
  assetSummaryCount: number;
} {
  return {
    walletCount: Array.isArray(value?.wallets) ? value.wallets.length : 0,
    pointCount: Array.isArray(value?.points) ? value.points.length : 0,
    assetSummaryCount: Array.isArray(value?.assetSummaries)
      ? value.assetSummaries.length
      : 0,
  };
}

function getCommittedAnalysisCacheKey(args: {
  requestKey: string;
  refreshToken?: string;
}): string {
  return args.refreshToken
    ? [args.requestKey, args.refreshToken].join('|')
    : args.requestKey;
}

function getCommittedAnalysisCacheValue(
  cacheKey: string,
): PnlAnalysisResult | undefined {
  return committedAnalysisCache.get(cacheKey);
}

export function clearPortfolioAnalysisCommittedCacheForTests(): void {
  committedAnalysisCache.clear();
}

export function usePortfolioAnalysis(args: {
  wallets: Wallet[];
  timeframe: PnlTimeframe;
  maxPoints?: number;
  enabled?: boolean;
  refreshToken?: string;
  clearDataToken?: string;
  freezeWhilePopulate?: boolean;
  allowCurrentWhilePopulate?: boolean;
  debugSource?: string;
}) {
  const populateInProgress = useAppSelector(
    ({PORTFOLIO}) => !!PORTFOLIO.populateStatus?.inProgress,
  );
  const lastPopulatedAt = useAppSelector(({PORTFOLIO}) => PORTFOLIO.lastPopulatedAt);
  const hasCommittedPortfolioBaseline =
    typeof lastPopulatedAt === 'number' && Number.isFinite(lastPopulatedAt);
  const query = usePortfolioRuntimeQuery<PnlAnalysisResult>({
    wallets: args.wallets,
    timeframe: args.timeframe,
    maxPoints: args.maxPoints,
    enabled: args.enabled,
    refreshToken: args.refreshToken,
    clearDataToken: args.clearDataToken,
    clearDataOnRefreshToken: !!args.refreshToken,
    execute: runPortfolioAnalysisQuery,
    debugSource: args.debugSource,
  });
  const committedDataCacheKey = useMemo(() => {
    return getCommittedAnalysisCacheKey({
      requestKey: query.requestKey,
      refreshToken: args.clearDataToken ?? args.refreshToken,
    });
  }, [args.clearDataToken, args.refreshToken, query.requestKey]);
  const shouldLogDiagnostics = shouldLogPortfolioAssetDiagnostics(
    args.debugSource,
  );
  const [committedDataState, setCommittedDataState] = useState<{
    cacheKey: string;
    value?: PnlAnalysisResult;
  }>(() => ({
    cacheKey: committedDataCacheKey,
    value: hasCommittedPortfolioBaseline
      ? getCommittedAnalysisCacheValue(committedDataCacheKey)
      : undefined,
  }));

  useEffect(() => {
    if (!hasCommittedPortfolioBaseline) {
      setCommittedDataState(prev =>
        prev.cacheKey === '' && prev.value === undefined
          ? prev
          : {
              cacheKey: '',
              value: undefined,
            },
      );
      return;
    }

    const cachedValue = getCommittedAnalysisCacheValue(committedDataCacheKey);
    setCommittedDataState(prev =>
      prev.cacheKey === committedDataCacheKey && prev.value === cachedValue
        ? prev
        : {
            cacheKey: committedDataCacheKey,
            value: cachedValue,
          },
    );
  }, [committedDataCacheKey, hasCommittedPortfolioBaseline]);

  const committedData = useMemo(() => {
    if (!hasCommittedPortfolioBaseline) {
      return undefined;
    }

    return committedDataState.cacheKey === committedDataCacheKey
      ? committedDataState.value
      : getCommittedAnalysisCacheValue(committedDataCacheKey);
  }, [
    committedDataCacheKey,
    committedDataState.cacheKey,
    committedDataState.value,
    hasCommittedPortfolioBaseline,
  ]);

  useEffect(() => {
    if (!query.data) {
      return;
    }

    if (args.freezeWhilePopulate && populateInProgress) {
      return;
    }

    committedAnalysisCache.set(committedDataCacheKey, query.data);
    setCommittedDataState(prev =>
      prev.cacheKey === committedDataCacheKey && prev.value === query.data
        ? prev
        : {
            cacheKey: committedDataCacheKey,
            value: query.data,
          },
    );
  }, [
    args.freezeWhilePopulate,
    committedDataCacheKey,
    populateInProgress,
    query.data,
  ]);

  const data = useMemo(() => {
    if (!(args.freezeWhilePopulate && populateInProgress)) {
      return query.data ?? (hasCommittedPortfolioBaseline ? committedData : undefined);
    }

    if (args.allowCurrentWhilePopulate && query.data) {
      return query.data;
    }

    if (hasCommittedPortfolioBaseline && committedData) {
      return committedData;
    }

    return args.allowCurrentWhilePopulate ? query.data : undefined;
  }, [
    args.allowCurrentWhilePopulate,
    args.freezeWhilePopulate,
    committedData,
    hasCommittedPortfolioBaseline,
    populateInProgress,
    query.data,
  ]);

  useEffect(() => {
    if (!shouldLogDiagnostics) {
      return;
    }

    const selectedSource = (() => {
      if (!(args.freezeWhilePopulate && populateInProgress)) {
        if (query.data) {
          return 'query';
        }

        return committedData ? 'committed_fallback' : 'none';
      }

      if (args.allowCurrentWhilePopulate && query.data) {
        return 'query_during_populate';
      }

      if (hasCommittedPortfolioBaseline && committedData) {
        return 'committed_during_populate';
      }

      return args.allowCurrentWhilePopulate ? 'query_empty_during_populate' : 'none';
    })();

    console.log('[portfolio-analysis-hook] selection', {
      source: args.debugSource || 'unknown',
      populateInProgress,
      hasCommittedPortfolioBaseline,
      freezeWhilePopulate: !!args.freezeWhilePopulate,
      allowCurrentWhilePopulate: !!args.allowCurrentWhilePopulate,
      queryLoading: query.loading,
      hasQueryError: !!query.error,
      refreshToken: args.refreshToken || null,
      clearDataToken: args.clearDataToken || null,
      selectedSource,
      query: summarizeAnalysisResultShape(query.data),
      committed: summarizeAnalysisResultShape(committedData),
      selected: summarizeAnalysisResultShape(data),
    });
  }, [
    args.allowCurrentWhilePopulate,
    args.clearDataToken,
    args.debugSource,
    args.freezeWhilePopulate,
    args.refreshToken,
    committedData,
    data,
    hasCommittedPortfolioBaseline,
    populateInProgress,
    query.data,
    query.error,
    query.loading,
    shouldLogDiagnostics,
  ]);

  return {
    ...query,
    data,
    currentData: query.data,
    committedData: hasCommittedPortfolioBaseline ? committedData : undefined,
  };
}

export default usePortfolioAnalysis;
