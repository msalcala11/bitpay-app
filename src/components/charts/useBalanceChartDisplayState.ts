import {startTransition, useEffect, useMemo, useState} from 'react';
import type {Dispatch, SetStateAction} from 'react';
import type {FiatRateInterval} from '../../store/rate/rate.models';
import type {
  BalanceChartDisplayState,
  BalanceChartRevisionByTimeframe,
  BalanceChartSeriesByTimeframe,
} from './balanceHistoryChart.state';
import {CHART_LOADER_DELAY_MS} from './useBalanceChartComputationQueue.constants';
import {debugBalanceChartRepeatedEffect} from './balanceChartDebug';

export type UseBalanceChartDisplayStateArgs = {
  getTimeframeAttemptRevision: (timeframe: FiatRateInterval) => string;
  getTimeframeRevision: (timeframe: FiatRateInterval) => string;
  hasAnySnapshots: boolean;
  hasCompletedInitialSelectedLoad: boolean;
  lastAttemptRevisionByTimeframe: BalanceChartRevisionByTimeframe;
  lastErrorByTimeframe: BalanceChartRevisionByTimeframe;
  resetKey: string;
  selectedTimeframe: FiatRateInterval;
  seriesByTimeframe: BalanceChartSeriesByTimeframe;
  seriesRevisionByTimeframe: BalanceChartRevisionByTimeframe;
  setHasCompletedInitialSelectedLoad: Dispatch<SetStateAction<boolean>>;
};

export const useBalanceChartDisplayState = ({
  getTimeframeAttemptRevision,
  getTimeframeRevision,
  hasAnySnapshots,
  hasCompletedInitialSelectedLoad,
  lastAttemptRevisionByTimeframe,
  lastErrorByTimeframe,
  resetKey,
  selectedTimeframe,
  seriesByTimeframe,
  seriesRevisionByTimeframe,
  setHasCompletedInitialSelectedLoad,
}: UseBalanceChartDisplayStateArgs) => {
  const [displayState, setDisplayState] = useState<BalanceChartDisplayState>();
  const [isChartLoaderVisible, setIsChartLoaderVisible] = useState(false);

  useEffect(() => {
    debugBalanceChartRepeatedEffect({
      effectName: 'displayState.reset',
      scopeId: resetKey,
      signature: resetKey,
    });
    setDisplayState(undefined);
    setIsChartLoaderVisible(false);
  }, [resetKey]);

  const selectedTimeframeRevision = getTimeframeRevision(selectedTimeframe);
  const selectedTimeframeAttemptRevision =
    getTimeframeAttemptRevision(selectedTimeframe);

  const selectedComputedSeries = useMemo(() => {
    if (
      seriesRevisionByTimeframe[selectedTimeframe] === selectedTimeframeRevision
    ) {
      return seriesByTimeframe[selectedTimeframe];
    }

    return undefined;
  }, [
    selectedTimeframe,
    selectedTimeframeRevision,
    seriesByTimeframe,
    seriesRevisionByTimeframe,
  ]);

  const selectedTimeframeError =
    lastAttemptRevisionByTimeframe[selectedTimeframe] ===
    selectedTimeframeAttemptRevision
      ? lastErrorByTimeframe[selectedTimeframe]
      : undefined;

  const displayedTimeframe = selectedComputedSeries
    ? selectedTimeframe
    : displayState?.timeframe ?? selectedTimeframe;
  const activeSeries = selectedComputedSeries || displayState?.series;
  const hydratedSelectedSeries = useMemo(() => {
    return seriesByTimeframe[selectedTimeframe];
  }, [selectedTimeframe, seriesByTimeframe]);

  useEffect(() => {
    if (!selectedComputedSeries) {
      return;
    }

    debugBalanceChartRepeatedEffect({
      effectName: 'displayState.promoteSelectedSeries',
      scopeId: resetKey,
      signature: `${selectedTimeframe}|${selectedTimeframeRevision}`,
    });
    startTransition(() => {
      setDisplayState(prev =>
        prev?.revision === selectedTimeframeRevision &&
        prev?.timeframe === selectedTimeframe
          ? prev
          : {
              revision: selectedTimeframeRevision,
              series: selectedComputedSeries,
              timeframe: selectedTimeframe,
            },
      );
    });
  }, [selectedComputedSeries, selectedTimeframe, selectedTimeframeRevision]);

  const hasRenderableSelectedSeries =
    !!selectedComputedSeries ||
    (displayState?.timeframe === selectedTimeframe && !!displayState?.series);
  const isSelectedTimeframePending =
    !hasRenderableSelectedSeries && !selectedTimeframeError;
  const isChartLoadingRaw = hasAnySnapshots && isSelectedTimeframePending;

  useEffect(() => {
    if (!isChartLoadingRaw) {
      setIsChartLoaderVisible(false);
      if (!hasCompletedInitialSelectedLoad && hasRenderableSelectedSeries) {
        setHasCompletedInitialSelectedLoad(true);
      }
      return;
    }

    const isInitialSelectedLoad = !hasCompletedInitialSelectedLoad;
    if (isInitialSelectedLoad) {
      setIsChartLoaderVisible(true);
      return;
    }

    setIsChartLoaderVisible(false);
    const timer = setTimeout(() => {
      setIsChartLoaderVisible(true);
    }, CHART_LOADER_DELAY_MS);

    return () => clearTimeout(timer);
  }, [
    hasCompletedInitialSelectedLoad,
    hasRenderableSelectedSeries,
    isChartLoadingRaw,
    setHasCompletedInitialSelectedLoad,
  ]);

  const hideGuideLineForInitialSelectedLoader =
    !hasCompletedInitialSelectedLoad && isChartLoaderVisible;

  const hasAnyRenderableSeries =
    !!activeSeries ||
    Object.values(seriesByTimeframe).some(
      series => !!series?.graphPoints.length,
    );

  return {
    activeSeries,
    displayedTimeframe,
    hasAnyRenderableSeries,
    hideGuideLineForInitialSelectedLoader,
    hydratedSelectedSeries,
    isChartLoaderVisible,
    isChartLoadingRaw,
    selectedTimeframeError,
  };
};

export default useBalanceChartDisplayState;
