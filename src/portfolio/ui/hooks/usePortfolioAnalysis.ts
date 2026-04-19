import {useEffect, useMemo, useState} from 'react';
import type {Wallet} from '../../../store/wallet/wallet.models';
import type {PnlAnalysisResult, PnlTimeframe} from '../../core/pnl/analysisStreaming';
import {useAppSelector} from '../../../utils/hooks';
import {runPortfolioAnalysisQuery} from '../common';
import {usePortfolioRuntimeQuery} from './usePortfolioRuntimeQuery';

export type UsePortfolioAnalysisResult = ReturnType<typeof usePortfolioAnalysis>;

const committedAnalysisCache = new Map<string, PnlAnalysisResult>();

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
  freezeWhilePopulate?: boolean;
  allowCurrentWhilePopulate?: boolean;
}) {
  const populateInProgress = useAppSelector(
    ({PORTFOLIO}) => !!PORTFOLIO.populateStatus?.inProgress,
  );
  const query = usePortfolioRuntimeQuery<PnlAnalysisResult>({
    wallets: args.wallets,
    timeframe: args.timeframe,
    maxPoints: args.maxPoints,
    enabled: args.enabled,
    refreshToken: args.refreshToken,
    clearDataOnRefreshToken: !!args.refreshToken,
    execute: runPortfolioAnalysisQuery,
  });
  const committedDataCacheKey = useMemo(() => {
    return getCommittedAnalysisCacheKey({
      requestKey: query.requestKey,
      refreshToken: args.refreshToken,
    });
  }, [args.refreshToken, query.requestKey]);

  const [committedData, setCommittedData] = useState<
    PnlAnalysisResult | undefined
  >(() => getCommittedAnalysisCacheValue(committedDataCacheKey));

  useEffect(() => {
    setCommittedData(getCommittedAnalysisCacheValue(committedDataCacheKey));
  }, [committedDataCacheKey]);

  useEffect(() => {
    if (!query.data) {
      return;
    }

    if (args.freezeWhilePopulate && populateInProgress) {
      return;
    }

    committedAnalysisCache.set(committedDataCacheKey, query.data);
    setCommittedData(query.data);
  }, [
    args.freezeWhilePopulate,
    committedDataCacheKey,
    populateInProgress,
    query.data,
  ]);

  const data = useMemo(() => {
    if (!(args.freezeWhilePopulate && populateInProgress)) {
      return query.data ?? committedData;
    }

    if (committedData) {
      return committedData;
    }

    return args.allowCurrentWhilePopulate ? query.data : undefined;
  }, [
    args.allowCurrentWhilePopulate,
    args.freezeWhilePopulate,
    committedData,
    populateInProgress,
    query.data,
  ]);

  return {
    ...query,
    data,
    currentData: query.data,
    committedData,
  };
}

export default usePortfolioAnalysis;
