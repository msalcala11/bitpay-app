import {useEffect, useState} from 'react';
import type {Dispatch, SetStateAction} from 'react';

const CHART_LOADER_DELAY_MS = 150;

type UseBalanceChartLoaderStateArgs = {
  hasAnySnapshots: boolean;
  hasCompletedInitialSelectedTimeframeLoad: boolean;
  hasRenderableSelectedSeries: boolean;
  selectedTimeframeError?: string;
  setHasCompletedInitialSelectedTimeframeLoad: Dispatch<SetStateAction<boolean>>;
};

export const useBalanceChartLoaderState = ({
  hasAnySnapshots,
  hasCompletedInitialSelectedTimeframeLoad,
  hasRenderableSelectedSeries,
  selectedTimeframeError,
  setHasCompletedInitialSelectedTimeframeLoad,
}: UseBalanceChartLoaderStateArgs) => {
  const [isChartLoaderVisible, setIsChartLoaderVisible] = useState(false);

  const isSelectedTimeframePending =
    !hasRenderableSelectedSeries && !selectedTimeframeError;
  const isChartLoadingRaw = hasAnySnapshots && isSelectedTimeframePending;

  useEffect(() => {
    if (!hasRenderableSelectedSeries || hasCompletedInitialSelectedTimeframeLoad) {
      return;
    }

    setHasCompletedInitialSelectedTimeframeLoad(true);
  }, [
    hasCompletedInitialSelectedTimeframeLoad,
    hasRenderableSelectedSeries,
  ]);

  useEffect(() => {
    if (!isChartLoadingRaw) {
      setIsChartLoaderVisible(false);
      return;
    }

    if (!hasCompletedInitialSelectedTimeframeLoad) {
      setIsChartLoaderVisible(true);
      return;
    }

    setIsChartLoaderVisible(false);
    const timer = setTimeout(() => {
      setIsChartLoaderVisible(true);
    }, CHART_LOADER_DELAY_MS);

    return () => clearTimeout(timer);
  }, [hasCompletedInitialSelectedTimeframeLoad, isChartLoadingRaw]);

  return {
    isChartLoaderVisible,
    isChartLoadingRaw,
    hideGuideLineForInitialLoader:
      !hasCompletedInitialSelectedTimeframeLoad && isChartLoaderVisible,
  };
};

export default useBalanceChartLoaderState;
