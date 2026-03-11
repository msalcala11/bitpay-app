import {useEffect, useMemo, useState} from 'react';
import type {GraphPoint} from 'react-native-graph';
import type {FiatRateInterval} from '../../store/rate/rate.models';
import type {PnlAnalysisPoint} from '../../utils/portfolio/core/pnl/analysis';
import {formatFiatAmount} from '../../utils/helper-methods';

export type ChangeRowData = {
  percent: number;
  deltaFiatFormatted?: string;
  rangeLabel?: string;
};

type BalanceChartAnalysisSeries = {
  analysisPoints: PnlAnalysisPoint[];
  pointByTimestamp: Map<number, PnlAnalysisPoint>;
};

type UseBalanceChartChangeRowArgs = {
  activeSeries?: BalanceChartAnalysisSeries;
  quoteCurrency: string;
  rangeLabel: string;
  selectedPoint?: GraphPoint;
  selectedPointDisplay?: {
    deltaFiatFormatted?: string;
  };
  selectedTimeframe: FiatRateInterval;
};

export const useBalanceChartChangeRow = ({
  activeSeries,
  quoteCurrency,
  rangeLabel,
  selectedPoint,
  selectedPointDisplay,
  selectedTimeframe,
}: UseBalanceChartChangeRowArgs) => {
  const [lastResolvedChangeRowDataByTimeframe, setLastResolvedChangeRowDataByTimeframe] =
    useState<Partial<Record<FiatRateInterval, ChangeRowData>>>({});

  const selectedAnalysisPoint = useMemo(() => {
    if (!selectedPoint || !activeSeries) {
      return undefined;
    }

    return activeSeries.pointByTimestamp.get(selectedPoint.date.getTime());
  }, [activeSeries, selectedPoint]);

  const lastAnalysisPoint = useMemo(() => {
    const pts = activeSeries?.analysisPoints || [];
    return pts.length ? pts[pts.length - 1] : undefined;
  }, [activeSeries]);

  const displayedAnalysisPoint = selectedAnalysisPoint ?? lastAnalysisPoint;
  const hasResolvedChangeRowData = !!displayedAnalysisPoint;
  const pnlDeltaFiat = displayedAnalysisPoint?.totalUnrealizedPnlFiat ?? 0;
  const pnlPercent = displayedAnalysisPoint?.totalPnlPercent ?? 0;

  const formattedDeltaFiat = useMemo(() => {
    if (!hasResolvedChangeRowData) {
      return undefined;
    }

    if (selectedPointDisplay?.deltaFiatFormatted) {
      return selectedPointDisplay.deltaFiatFormatted;
    }

    return formatFiatAmount(pnlDeltaFiat, quoteCurrency, {
      customPrecision: 'minimal',
      currencyDisplay: 'symbol',
    });
  }, [
    hasResolvedChangeRowData,
    pnlDeltaFiat,
    quoteCurrency,
    selectedPointDisplay?.deltaFiatFormatted,
  ]);

  const resolvedChangeRowData = useMemo<ChangeRowData | undefined>(() => {
    if (!hasResolvedChangeRowData) {
      return undefined;
    }

    return {
      percent: pnlPercent,
      deltaFiatFormatted: formattedDeltaFiat,
      rangeLabel,
    };
  }, [formattedDeltaFiat, hasResolvedChangeRowData, pnlPercent, rangeLabel]);

  useEffect(() => {
    if (!resolvedChangeRowData) {
      return;
    }

    setLastResolvedChangeRowDataByTimeframe(prev => {
      const existing = prev[selectedTimeframe];
      if (
        existing?.percent === resolvedChangeRowData.percent &&
        existing?.deltaFiatFormatted === resolvedChangeRowData.deltaFiatFormatted &&
        existing?.rangeLabel === resolvedChangeRowData.rangeLabel
      ) {
        return prev;
      }

      return {
        ...prev,
        [selectedTimeframe]: resolvedChangeRowData,
      };
    });
  }, [resolvedChangeRowData, selectedTimeframe]);

  return {
    displayedChangeRowData:
      resolvedChangeRowData || lastResolvedChangeRowDataByTimeframe[selectedTimeframe],
  };
};

export default useBalanceChartChangeRow;
