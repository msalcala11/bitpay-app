import {startTransition, useEffect, useMemo, useRef, useState} from 'react';
import type {
  FiatRateSeriesCache,
  FiatRateInterval,
} from '../../store/rate/rate.models';
import {FIAT_CHART_PRECOMPUTE_TIMEFRAME_ORDER} from './fiatTimeframes';
import {
  patchBalanceChartScopeLatestPoints,
  touchBalanceChartScope,
  type CachedBalanceChartScope,
  type CachedBalanceChartTimeframe,
  type HistoricalRateDependencyMeta,
} from '../../store/portfolio-charts';
import type {
  BalanceChartRevisionByTimeframe,
  BalanceChartSeriesByTimeframe,
  BalanceChartStatusByTimeframe,
} from './balanceHistoryChart.state';
import {
  deserializeCachedTimeframeToComputedSeries,
  getCachedTimeframeStatus,
  patchCachedLatestPointWithSpotRates,
} from '../../utils/portfolio/chartCache';
import {debugBalanceChartRepeatedEffect} from './balanceChartDebug';

const EMPTY_SERIES_BY_TIMEFRAME: BalanceChartSeriesByTimeframe = {};
const EMPTY_REVISION_BY_TIMEFRAME: BalanceChartRevisionByTimeframe = {};

export type UseBalanceChartCacheHydrationArgs = {
  cachedScope?: CachedBalanceChartScope;
  currentSpotRatesByAssetId: Record<string, number>;
  dispatch: (action: any) => void;
  fiatRateSeriesCache?: FiatRateSeriesCache;
  quoteCurrency: string;
  scopeId: string;
  snapshotVersionSig: string;
  getTimeframeRevision: (
    timeframe: FiatRateInterval,
    historicalRateDeps?: HistoricalRateDependencyMeta[],
  ) => string;
};

export const useBalanceChartCacheHydration = ({
  cachedScope,
  currentSpotRatesByAssetId,
  dispatch,
  fiatRateSeriesCache,
  quoteCurrency,
  scopeId,
  snapshotVersionSig,
  getTimeframeRevision,
}: UseBalanceChartCacheHydrationArgs) => {
  const [seriesByTimeframe, setSeriesByTimeframe] =
    useState<BalanceChartSeriesByTimeframe>(EMPTY_SERIES_BY_TIMEFRAME);
  const [seriesRevisionByTimeframe, setSeriesRevisionByTimeframe] =
    useState<BalanceChartRevisionByTimeframe>(EMPTY_REVISION_BY_TIMEFRAME);
  const lastTouchedScopeIdRef = useRef<string | undefined>(undefined);
  const lastPatchDispatchSignatureRef = useRef<string | undefined>(undefined);

  const cachedTimeframeStatusByTimeframe =
    useMemo<BalanceChartStatusByTimeframe>(() => {
      const next: BalanceChartStatusByTimeframe = {};

      for (const timeframe of FIAT_CHART_PRECOMPUTE_TIMEFRAME_ORDER) {
        next[timeframe] = getCachedTimeframeStatus({
          cachedTimeframe: cachedScope?.timeframes?.[timeframe],
          snapshotVersionSig,
          currentSpotRatesByAssetId,
          fiatRateSeriesCache,
        });
      }

      return next;
    }, [
      cachedScope?.timeframes,
      currentSpotRatesByAssetId,
      fiatRateSeriesCache,
      snapshotVersionSig,
    ]);

  useEffect(() => {
    lastTouchedScopeIdRef.current = undefined;
    lastPatchDispatchSignatureRef.current = undefined;
    setSeriesByTimeframe(EMPTY_SERIES_BY_TIMEFRAME);
    setSeriesRevisionByTimeframe(EMPTY_REVISION_BY_TIMEFRAME);
  }, [quoteCurrency, scopeId]);

  useEffect(() => {
    if (!cachedScope) {
      return;
    }
    if (lastTouchedScopeIdRef.current === scopeId) {
      return;
    }

    lastTouchedScopeIdRef.current = scopeId;
    debugBalanceChartRepeatedEffect({
      effectName: 'cacheHydration.touchScope',
      scopeId,
      signature: scopeId,
      payload: {
        timeframes: Object.keys(cachedScope.timeframes || {}).sort(),
      },
    });
    dispatch(
      touchBalanceChartScope({
        scopeId,
      }),
    );
  }, [cachedScope, dispatch, scopeId]);

  useEffect(() => {
    if (!cachedScope) {
      return;
    }

    const patchedTimeframes: CachedBalanceChartTimeframe[] = [];
    const nextSeriesByTimeframe: BalanceChartSeriesByTimeframe = {};
    const nextSeriesRevisionByTimeframe: BalanceChartRevisionByTimeframe = {};
    const patchableTimeframes: FiatRateInterval[] = [];

    for (const timeframe of FIAT_CHART_PRECOMPUTE_TIMEFRAME_ORDER) {
      const cachedTimeframe = cachedScope.timeframes?.[timeframe];
      if (!cachedTimeframe) {
        continue;
      }

      const status = cachedTimeframeStatusByTimeframe[timeframe] || 'missing';
      if (status === 'patchable') {
        patchableTimeframes.push(timeframe);
      }
      const effectiveCachedTimeframe =
        status === 'patchable'
          ? patchCachedLatestPointWithSpotRates({
              cachedTimeframe,
              currentSpotRatesByAssetId,
            })
          : cachedTimeframe;

      if (effectiveCachedTimeframe !== cachedTimeframe) {
        patchedTimeframes.push(effectiveCachedTimeframe);
      }

      nextSeriesByTimeframe[timeframe] =
        deserializeCachedTimeframeToComputedSeries(effectiveCachedTimeframe);
      nextSeriesRevisionByTimeframe[timeframe] =
        status === 'fresh' || status === 'patchable'
          ? getTimeframeRevision(
              timeframe,
              effectiveCachedTimeframe.historicalRateDeps,
            )
          : `stale:${effectiveCachedTimeframe.builtAt}:${timeframe}`;
    }

    startTransition(() => {
      setSeriesByTimeframe(prev => ({
        ...prev,
        ...nextSeriesByTimeframe,
      }));
      setSeriesRevisionByTimeframe(prev => ({
        ...prev,
        ...nextSeriesRevisionByTimeframe,
      }));
    });

    if (patchedTimeframes.length) {
      const patchDispatchSignature = [
        scopeId,
        patchableTimeframes.sort().join(','),
        patchedTimeframes
          .map(timeframe => timeframe.timeframe)
          .sort()
          .join(','),
      ].join('|');
      const isDuplicatePatchDispatch =
        lastPatchDispatchSignatureRef.current === patchDispatchSignature;

      debugBalanceChartRepeatedEffect({
        effectName: 'cacheHydration.patchScope',
        scopeId,
        signature: patchDispatchSignature,
        payload: {
          patchableTimeframes: patchableTimeframes.sort(),
          patchedTimeframes: patchedTimeframes
            .map(timeframe => timeframe.timeframe)
            .sort(),
          duplicateDispatchSuppressed: isDuplicatePatchDispatch,
        },
      });

      if (isDuplicatePatchDispatch) {
        return;
      }

      lastPatchDispatchSignatureRef.current = patchDispatchSignature;
      dispatch(
        patchBalanceChartScopeLatestPoints({
          scopeId,
          timeframes: patchedTimeframes,
        }),
      );
      return;
    }

    lastPatchDispatchSignatureRef.current = undefined;
  }, [
    cachedScope,
    cachedTimeframeStatusByTimeframe,
    currentSpotRatesByAssetId,
    dispatch,
    getTimeframeRevision,
    scopeId,
  ]);

  return {
    cachedTimeframeStatusByTimeframe,
    seriesByTimeframe,
    setSeriesByTimeframe,
    seriesRevisionByTimeframe,
    setSeriesRevisionByTimeframe,
  };
};

export default useBalanceChartCacheHydration;
