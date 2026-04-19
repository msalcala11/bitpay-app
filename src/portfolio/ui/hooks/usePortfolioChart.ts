import {useEffect, useMemo, useState} from 'react';
import type {Wallet} from '../../../store/wallet/wallet.models';
import type {PnlAnalysisChartResult, PnlTimeframe} from '../../core/pnl/analysisStreaming';
import {runPortfolioChartQuery} from '../common';
import {useAppSelector} from '../../../utils/hooks';
import {usePortfolioRuntimeQuery} from './usePortfolioRuntimeQuery';

export type UsePortfolioChartResult = ReturnType<typeof usePortfolioChart>;

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

  const [committedData, setCommittedData] = useState<
    PnlAnalysisChartResult | undefined
  >(undefined);

  useEffect(() => {
    setCommittedData(undefined);
  }, [query.requestKey]);

  useEffect(() => {
    if (!query.data) {
      return;
    }

    if (args.freezeWhilePopulate && populateInProgress) {
      return;
    }

    setCommittedData(query.data);
  }, [args.freezeWhilePopulate, populateInProgress, query.data]);

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
