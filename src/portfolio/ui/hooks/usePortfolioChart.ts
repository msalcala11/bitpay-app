import {useEffect, useMemo, useState} from 'react';
import type {Wallet} from '../../../store/wallet/wallet.models';
import type {PnlAnalysisChartResult, PnlTimeframe} from '../../core/pnl/analysisStreaming';
import {runPortfolioChartQuery} from '../common';
import {useAppSelector} from '../../../utils/hooks';
import {usePortfolioRuntimeQuery} from './usePortfolioRuntimeQuery';

export type UsePortfolioChartResult = ReturnType<typeof usePortfolioChart>;

const committedChartCache = new Map<string, PnlAnalysisChartResult>();

export function clearPortfolioChartCommittedCacheForTests(): void {
  committedChartCache.clear();
}

export function usePortfolioChart(args: {
  wallets: Wallet[];
  timeframe: PnlTimeframe;
  maxPoints?: number;
  enabled?: boolean;
  freezeWhilePopulate?: boolean;
  allowCurrentWhilePopulate?: boolean;
}) {
  const populateInProgress = useAppSelector(
    ({PORTFOLIO}) => !!PORTFOLIO.populateStatus?.inProgress,
  );
  const query = usePortfolioRuntimeQuery<PnlAnalysisChartResult>({
    wallets: args.wallets,
    timeframe: args.timeframe,
    maxPoints: args.maxPoints,
    enabled: args.enabled,
    execute: runPortfolioChartQuery,
  });
  const [committedDataState, setCommittedDataState] = useState<{
    requestKey: string;
    value?: PnlAnalysisChartResult;
  }>(() => ({
    requestKey: query.requestKey,
    value: committedChartCache.get(query.requestKey),
  }));

  const committedData = useMemo(
    () =>
      committedDataState.requestKey === query.requestKey
        ? committedDataState.value
        : committedChartCache.get(query.requestKey),
    [committedDataState.requestKey, committedDataState.value, query.requestKey],
  );

  useEffect(() => {
    const cachedValue = committedChartCache.get(query.requestKey);
    setCommittedDataState(prev =>
      prev.requestKey === query.requestKey && prev.value === cachedValue
        ? prev
        : {
            requestKey: query.requestKey,
            value: cachedValue,
          },
    );
  }, [query.requestKey]);

  useEffect(() => {
    if (!query.data) {
      return;
    }

    if (args.freezeWhilePopulate && populateInProgress) {
      return;
    }

    committedChartCache.set(query.requestKey, query.data);
    setCommittedDataState(prev =>
      prev.requestKey === query.requestKey && prev.value === query.data
        ? prev
        : {
            requestKey: query.requestKey,
            value: query.data,
          },
    );
  }, [args.freezeWhilePopulate, populateInProgress, query.data, query.requestKey]);

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

export default usePortfolioChart;
