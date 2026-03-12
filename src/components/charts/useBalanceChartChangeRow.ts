import {useEffect, useMemo, useState} from 'react';
import type {GraphPoint} from 'react-native-graph';
import type {FiatRateInterval} from '../../store/rate/rate.models';
import type {PnlAnalysisPoint} from '../../utils/portfolio/core/pnl/analysis';
import {formatFiatAmount} from '../../utils/helper-methods';
import {
  formatRangeOrSelectedPointLabel,
  getRangeLabelForFiatTimeframe,
} from './fiatTimeframes';
import type {ChangeRowData, ComputedSeries} from './balanceHistoryChart.types';

type UseBalanceChartChangeRowArgs = {
  activeSeries?: ComputedSeries;
  fallbackAnalysisPoint?: PnlAnalysisPoint;
  selectedPoint?: GraphPoint;
  selectedTimeframe: FiatRateInterval;
  displayedTimeframe: FiatRateInterval;
  quoteCurrency: string;
  t: (key: string) => string;
  resetCacheKey: string;
};

type ChangeRowPointMetadata = {
  label: string;
  deltaFiatFormatted: string;
};

export const useBalanceChartChangeRow = ({
  activeSeries,
  fallbackAnalysisPoint,
  selectedPoint,
  selectedTimeframe,
  displayedTimeframe,
  quoteCurrency,
  t,
  resetCacheKey,
}: UseBalanceChartChangeRowArgs): {
  displayedChangeRowData?: ChangeRowData;
} => {
  const [
    lastResolvedChangeRowDataByTimeframe,
    setLastResolvedChangeRowDataByTimeframe,
  ] = useState<Partial<Record<FiatRateInterval, ChangeRowData>>>({});

  useEffect(() => {
    setLastResolvedChangeRowDataByTimeframe({});
  }, [resetCacheKey]);

  const rangeLabel = useMemo(
    () => getRangeLabelForFiatTimeframe(t, displayedTimeframe),
    [displayedTimeframe, t],
  );

  const pointMetadataByTimestampMs = useMemo(() => {
    const next = new Map<number, ChangeRowPointMetadata>();

    for (const point of activeSeries?.analysisPoints || []) {
      next.set(point.timestamp, {
        label: formatRangeOrSelectedPointLabel({
          rangeLabel,
          selectedTimeframe: displayedTimeframe,
          selectedDate: new Date(point.timestamp),
        }),
        deltaFiatFormatted: formatFiatAmount(
          point.totalUnrealizedPnlFiat ?? 0,
          quoteCurrency,
          {
            customPrecision: 'minimal',
            currencyDisplay: 'symbol',
          },
        ),
      });
    }

    return next;
  }, [
    activeSeries?.analysisPoints,
    displayedTimeframe,
    quoteCurrency,
    rangeLabel,
  ]);

  const selectedAnalysisPoint = useMemo(() => {
    if (!selectedPoint || !activeSeries) {
      return undefined;
    }

    return activeSeries.pointByTimestamp.get(selectedPoint.date.getTime());
  }, [activeSeries, selectedPoint]);

  const lastAnalysisPoint = useMemo(() => {
    const points = activeSeries?.analysisPoints || [];
    return points.length ? points[points.length - 1] : undefined;
  }, [activeSeries?.analysisPoints]);

  const displayedAnalysisPoint =
    selectedAnalysisPoint ?? lastAnalysisPoint ?? fallbackAnalysisPoint;

  const selectedPointMetadata =
    selectedPoint != null
      ? pointMetadataByTimestampMs.get(selectedPoint.date.getTime())
      : undefined;

  const resolvedChangeRowData = useMemo<ChangeRowData | undefined>(() => {
    if (!displayedAnalysisPoint) {
      return undefined;
    }

    const pointMetadata = pointMetadataByTimestampMs.get(
      displayedAnalysisPoint.timestamp,
    );

    return {
      percent: displayedAnalysisPoint.totalPnlPercent ?? 0,
      deltaFiatFormatted:
        pointMetadata?.deltaFiatFormatted ||
        formatFiatAmount(
          displayedAnalysisPoint.totalUnrealizedPnlFiat ?? 0,
          quoteCurrency,
          {
            customPrecision: 'minimal',
            currencyDisplay: 'symbol',
          },
        ),
      rangeLabel:
        selectedPointMetadata?.label || pointMetadata?.label || rangeLabel,
    };
  }, [
    displayedAnalysisPoint,
    pointMetadataByTimestampMs,
    quoteCurrency,
    rangeLabel,
    selectedPointMetadata,
  ]);

  useEffect(() => {
    if (!resolvedChangeRowData) {
      return;
    }

    setLastResolvedChangeRowDataByTimeframe(prev => {
      const existing = prev[selectedTimeframe];
      if (
        existing?.percent === resolvedChangeRowData.percent &&
        existing?.deltaFiatFormatted ===
          resolvedChangeRowData.deltaFiatFormatted &&
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
      resolvedChangeRowData ||
      lastResolvedChangeRowDataByTimeframe[selectedTimeframe],
  };
};

export default useBalanceChartChangeRow;
