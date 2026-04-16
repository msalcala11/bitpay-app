import {useMemo} from 'react';
import type {Wallet} from '../../../store/wallet/wallet.models';
import type {PortfolioGainLossSummary} from '../../../utils/portfolio/assets';
import {getLastFiniteNumber} from '../common';
import {usePortfolioChart} from './usePortfolioChart';

function buildSummaryPart(args: {
  totalFiatBalance: number | undefined;
  totalPnlChange: number | undefined;
  totalPnlPercent: number | undefined;
  liveFiatTotal: number;
}): PortfolioGainLossSummary['today'] {
  const hasRuntimeData =
    (typeof args.totalFiatBalance === 'number' && args.totalFiatBalance > 0) ||
    !(args.liveFiatTotal > 0);

  if (!hasRuntimeData) {
    return {
      deltaFiat: 0,
      percentRatio: 0,
      available: false,
    };
  }

  return {
    deltaFiat:
      typeof args.totalPnlChange === 'number' && Number.isFinite(args.totalPnlChange)
        ? args.totalPnlChange
        : 0,
    percentRatio:
      typeof args.totalPnlPercent === 'number' && Number.isFinite(args.totalPnlPercent)
        ? args.totalPnlPercent / 100
        : 0,
    available: true,
  };
}

export function usePortfolioGainLossSummary(args: {
  wallets: Wallet[];
  liveFiatTotal: number;
}) {
  const todayChart = usePortfolioChart({
    wallets: args.wallets,
    timeframe: '1D',
    maxPoints: 2,
    freezeWhilePopulate: true,
    allowCurrentWhilePopulate: false,
  });
  const totalChart = usePortfolioChart({
    wallets: args.wallets,
    timeframe: 'ALL',
    maxPoints: 2,
    freezeWhilePopulate: true,
    allowCurrentWhilePopulate: false,
  });

  const summary: PortfolioGainLossSummary = useMemo(() => {
    const quoteCurrency = todayChart.quoteCurrency || totalChart.quoteCurrency || 'USD';

    return {
      quoteCurrency,
      today: buildSummaryPart({
        totalFiatBalance: getLastFiniteNumber(todayChart.data?.totalFiatBalance),
        totalPnlChange: getLastFiniteNumber(todayChart.data?.totalPnlChange),
        totalPnlPercent: getLastFiniteNumber(todayChart.data?.totalPnlPercent),
        liveFiatTotal: args.liveFiatTotal,
      }),
      total: buildSummaryPart({
        totalFiatBalance: getLastFiniteNumber(totalChart.data?.totalFiatBalance),
        totalPnlChange: getLastFiniteNumber(totalChart.data?.totalPnlChange),
        totalPnlPercent: getLastFiniteNumber(totalChart.data?.totalPnlPercent),
        liveFiatTotal: args.liveFiatTotal,
      }),
    };
  }, [
    args.liveFiatTotal,
    todayChart.data?.totalFiatBalance,
    todayChart.data?.totalPnlChange,
    todayChart.data?.totalPnlPercent,
    todayChart.quoteCurrency,
    totalChart.data?.totalFiatBalance,
    totalChart.data?.totalPnlChange,
    totalChart.data?.totalPnlPercent,
    totalChart.quoteCurrency,
  ]);

  return {
    summary,
    todayChart,
    totalChart,
    loading: todayChart.loading || totalChart.loading,
    error: todayChart.error || totalChart.error,
  };
}

export default usePortfolioGainLossSummary;
