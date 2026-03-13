import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type {GraphPoint} from 'react-native-graph';
import type {
  FiatRateInterval,
  FiatRateSeriesCache,
} from '../../store/rate/rate.models';
import {FIAT_RATE_SERIES_TARGET_POINTS} from '../../store/rate/rate.models';
import type {BalanceSnapshot} from '../../store/portfolio/portfolio.models';
import type {Wallet} from '../../store/wallet/wallet.models';
import {buildPnlAnalysisSeriesAsync} from '../../utils/portfolio/core/pnl/analysis';
import {
  buildPnlWalletInputsFromPortfolioSnapshotsAsync,
  type PnlWalletInputs,
} from '../../utils/portfolio/assets';
import {getErrorString} from '../../utils/helper-methods';
import {
  buildHistoricalRateDependencyMetadataFromCache,
  buildHistoricalRateDependencyRevision,
  buildLatestPointPatchMetadataFromAnalysis,
  normalizeGraphPointsForChart,
  recomputeMinMaxFromGraphPoints,
  serializeComputedSeriesToCachedTimeframe,
} from '../../utils/portfolio/chartCache';
import {FIAT_CHART_PRECOMPUTE_TIMEFRAME_ORDER} from './fiatTimeframes';
import type {
  BalanceChartBooleanByTimeframe,
  BalanceChartRevisionByTimeframe,
  BalanceChartSeriesByTimeframe,
  BalanceChartStatusByTimeframe,
} from './balanceHistoryChart.state';
import type {ComputedSeries} from './balanceHistoryChart.types';
import {useTrackedInteractionWork} from './useTrackedInteractionWork';
import {
  upsertBalanceChartScopeTimeframes,
  type HistoricalRateDependencyMeta,
} from '../../store/portfolio-charts';
import {buildBalanceChartPointByTimestampMap} from '../../utils/portfolio/balanceChartShared';
import {CHART_COMPUTE_YIELD_EVERY_POINTS} from './useBalanceChartComputationQueue.constants';
import {debugBalanceChartRepeatedEffect} from './balanceChartDebug';

const EMPTY_BOOLEAN_BY_TIMEFRAME: BalanceChartBooleanByTimeframe = {};
const EMPTY_REVISION_BY_TIMEFRAME: BalanceChartRevisionByTimeframe = {};
const EMPTY_ANALYSIS_INPUTS = (quoteCurrency: string): PnlWalletInputs => ({
  wallets: [],
  quoteCurrency: (quoteCurrency || '').toUpperCase(),
});

const getLatestFiatRateSeriesPointTs = (
  cache?: FiatRateSeriesCache,
): number | undefined => {
  if (!cache) {
    return undefined;
  }

  let maxTs = 0;
  for (const cacheKey in cache) {
    if (!Object.prototype.hasOwnProperty.call(cache, cacheKey)) {
      continue;
    }
    const points = cache?.[cacheKey]?.points;
    if (!Array.isArray(points) || !points.length) {
      continue;
    }
    const lastTs = Number(points[points.length - 1]?.ts);
    if (Number.isFinite(lastTs) && lastTs > maxTs) {
      maxTs = lastTs;
    }
  }

  return maxTs > 0 ? maxTs : undefined;
};

export type UseBalanceChartComputationQueueArgs = {
  balanceOffset: number;
  cachedTimeframeStatusByTimeframe: BalanceChartStatusByTimeframe;
  currentRatesRevision: string;
  currentSpotRatesByAssetId: Record<string, number>;
  currentSpotRatesByCoin: Record<string, number>;
  dispatch: (action: any) => void;
  fiatRateSeriesCache?: FiatRateSeriesCache;
  getLiveHistoricalRateDepsForTimeframe: (
    timeframe: FiatRateInterval,
  ) => HistoricalRateDependencyMeta[] | undefined;
  getTimeframeRevision: (
    timeframe: FiatRateInterval,
    historicalRateDeps?: HistoricalRateDependencyMeta[],
  ) => string;
  hasAnySnapshots: boolean;
  hasCompletedInitialSelectedLoad: boolean;
  quoteCurrency: string;
  scopeId: string;
  selectedTimeframe: FiatRateInterval;
  seriesByTimeframe: BalanceChartSeriesByTimeframe;
  seriesRevisionByTimeframe: BalanceChartRevisionByTimeframe;
  setSeriesByTimeframe: Dispatch<SetStateAction<BalanceChartSeriesByTimeframe>>;
  setSeriesRevisionByTimeframe: Dispatch<
    SetStateAction<BalanceChartRevisionByTimeframe>
  >;
  snapshotVersionSig: string;
  snapshotsByWalletId: {[walletId: string]: BalanceSnapshot[] | undefined};
  snapshotsSig: string;
  sortedWalletIds: string[];
  wallets: Wallet[];
  walletsSig: string;
};

export const useBalanceChartComputationQueue = ({
  balanceOffset,
  cachedTimeframeStatusByTimeframe,
  currentRatesRevision,
  currentSpotRatesByAssetId,
  currentSpotRatesByCoin,
  dispatch,
  fiatRateSeriesCache,
  getLiveHistoricalRateDepsForTimeframe,
  getTimeframeRevision,
  hasAnySnapshots,
  hasCompletedInitialSelectedLoad,
  quoteCurrency,
  scopeId,
  selectedTimeframe,
  seriesByTimeframe,
  seriesRevisionByTimeframe,
  setSeriesByTimeframe,
  setSeriesRevisionByTimeframe,
  snapshotVersionSig,
  snapshotsByWalletId,
  snapshotsSig,
  sortedWalletIds,
  wallets,
  walletsSig,
}: UseBalanceChartComputationQueueArgs) => {
  const [analysisInputs, setAnalysisInputs] = useState<PnlWalletInputs>(() => ({
    ...EMPTY_ANALYSIS_INPUTS(quoteCurrency),
  }));
  const [analysisInputsReadyKey, setAnalysisInputsReadyKey] = useState<
    string | undefined
  >(undefined);
  const [analysisHistoricalDepRevision, setAnalysisHistoricalDepRevision] =
    useState('pending');
  const [isComputingByTimeframe, setIsComputingByTimeframe] =
    useState<BalanceChartBooleanByTimeframe>(EMPTY_BOOLEAN_BY_TIMEFRAME);
  const [lastAttemptRevisionByTimeframe, setLastAttemptRevisionByTimeframe] =
    useState<BalanceChartRevisionByTimeframe>(EMPTY_REVISION_BY_TIMEFRAME);
  const [lastErrorByTimeframe, setLastErrorByTimeframe] =
    useState<BalanceChartRevisionByTimeframe>(EMPTY_REVISION_BY_TIMEFRAME);

  const enqueueComputeRef = useRef<FiatRateInterval[]>([]);
  const computingQueueRef = useRef(false);
  const computeGenerationRef = useRef(0);
  const analysisHistoricalDepKeysRef = useRef<Set<string>>(new Set());
  const analysisInputsReadyKeyRef = useRef<string | undefined>(undefined);
  const snapshotsByWalletIdRef = useRef(snapshotsByWalletId);
  const walletsRef = useRef(wallets);
  const {cancelAllScheduledWork, scheduleTrackedWork} =
    useTrackedInteractionWork();

  useEffect(() => {
    snapshotsByWalletIdRef.current = snapshotsByWalletId;
  }, [snapshotsByWalletId]);

  useEffect(() => {
    walletsRef.current = wallets;
  }, [wallets]);

  const invalidateComputeGeneration = useCallback(() => {
    computeGenerationRef.current += 1;
    cancelAllScheduledWork();
    enqueueComputeRef.current = [];
    computingQueueRef.current = false;
  }, [cancelAllScheduledWork]);

  useEffect(() => {
    return () => {
      invalidateComputeGeneration();
    };
  }, [invalidateComputeGeneration]);

  const analysisInputsBaseKey = useMemo(
    () => `${scopeId}|${snapshotVersionSig}`,
    [scopeId, snapshotVersionSig],
  );

  const selectedTimeframeNeedsHistoricalRecompute = useMemo(() => {
    const status =
      cachedTimeframeStatusByTimeframe[selectedTimeframe] || 'missing';
    return status === 'missing' || status === 'stale_historical';
  }, [cachedTimeframeStatusByTimeframe, selectedTimeframe]);

  const hasAnyBackgroundHistoricalRecomputeNeeded = useMemo(() => {
    return FIAT_CHART_PRECOMPUTE_TIMEFRAME_ORDER.some(timeframe => {
      if (timeframe === selectedTimeframe) {
        return false;
      }
      const status = cachedTimeframeStatusByTimeframe[timeframe] || 'missing';
      return status === 'missing' || status === 'stale_historical';
    });
  }, [cachedTimeframeStatusByTimeframe, selectedTimeframe]);

  const shouldPrepareAnalysisInputs =
    hasAnySnapshots &&
    !!fiatRateSeriesCache &&
    (selectedTimeframeNeedsHistoricalRecompute ||
      (hasCompletedInitialSelectedLoad &&
        hasAnyBackgroundHistoricalRecomputeNeeded));

  const getTimeframeHistoricalRevision = useCallback(
    (timeframe: FiatRateInterval) => {
      const liveHistoricalRateDeps =
        getLiveHistoricalRateDepsForTimeframe(timeframe);
      if (liveHistoricalRateDeps?.length) {
        return (
          buildHistoricalRateDependencyRevision({
            historicalRateDeps: liveHistoricalRateDeps,
          }) || 'none'
        );
      }

      return analysisHistoricalDepRevision;
    },
    [analysisHistoricalDepRevision, getLiveHistoricalRateDepsForTimeframe],
  );

  const getTimeframeAttemptRevision = useCallback(
    (timeframe: FiatRateInterval) => {
      return [
        analysisInputsBaseKey,
        currentRatesRevision,
        getTimeframeHistoricalRevision(timeframe),
        timeframe,
      ].join('|');
    },
    [
      analysisInputsBaseKey,
      currentRatesRevision,
      getTimeframeHistoricalRevision,
    ],
  );

  const selectedTimeframeHistoricalRevision = useMemo(
    () => getTimeframeHistoricalRevision(selectedTimeframe),
    [getTimeframeHistoricalRevision, selectedTimeframe],
  );

  useEffect(() => {
    analysisInputsReadyKeyRef.current = analysisInputsReadyKey;
  }, [analysisInputsReadyKey]);

  useEffect(() => {
    debugBalanceChartRepeatedEffect({
      effectName: 'computeQueue.resetScope',
      scopeId,
      signature: `${scopeId}|${quoteCurrency}`,
    });
    invalidateComputeGeneration();
    analysisHistoricalDepKeysRef.current = new Set();
    analysisInputsReadyKeyRef.current = undefined;
    setAnalysisInputs(EMPTY_ANALYSIS_INPUTS(quoteCurrency));
    setAnalysisInputsReadyKey(undefined);
    setAnalysisHistoricalDepRevision('pending');
    setIsComputingByTimeframe(EMPTY_BOOLEAN_BY_TIMEFRAME);
    setLastAttemptRevisionByTimeframe(EMPTY_REVISION_BY_TIMEFRAME);
    setLastErrorByTimeframe(EMPTY_REVISION_BY_TIMEFRAME);
  }, [invalidateComputeGeneration, quoteCurrency, scopeId]);

  useEffect(() => {
    debugBalanceChartRepeatedEffect({
      effectName: 'computeQueue.invalidateInputs',
      scopeId,
      signature: [
        analysisInputsBaseKey,
        currentRatesRevision,
        selectedTimeframeHistoricalRevision,
      ].join('|'),
    });
    invalidateComputeGeneration();
    setIsComputingByTimeframe(EMPTY_BOOLEAN_BY_TIMEFRAME);
  }, [
    analysisInputsBaseKey,
    currentRatesRevision,
    invalidateComputeGeneration,
    selectedTimeframeHistoricalRevision,
  ]);

  useEffect(() => {
    let cancelled = false;
    const shouldResetPreparedInputs =
      analysisInputsReadyKeyRef.current !== analysisInputsBaseKey;

    if (!hasAnySnapshots || !shouldPrepareAnalysisInputs) {
      setAnalysisInputs(EMPTY_ANALYSIS_INPUTS(quoteCurrency));
      analysisHistoricalDepKeysRef.current = new Set();
      analysisInputsReadyKeyRef.current = undefined;
      setAnalysisInputsReadyKey(undefined);
      setAnalysisHistoricalDepRevision('pending');
      return;
    }

    if (shouldResetPreparedInputs) {
      setAnalysisInputs(EMPTY_ANALYSIS_INPUTS(quoteCurrency));
      analysisInputsReadyKeyRef.current = undefined;
      setAnalysisInputsReadyKey(undefined);
      setAnalysisHistoricalDepRevision('pending');
    }

    const generation = computeGenerationRef.current;
    const prepareHandle = scheduleTrackedWork(
      async () => {
        const historicalDepKeys = new Set<string>();
        const prepared = await buildPnlWalletInputsFromPortfolioSnapshotsAsync(
          {
            snapshotsByWalletId: snapshotsByWalletIdRef.current || {},
            wallets: walletsRef.current || [],
            quoteCurrency,
            fiatRateSeriesCache,
            onHistoricalRateDependency: cacheKey => {
              if (cacheKey) {
                historicalDepKeys.add(cacheKey);
              }
            },
          },
          {
            yieldEveryWallets: 1,
            yieldEverySnapshots: 150,
          },
        );

        if (cancelled || computeGenerationRef.current !== generation) {
          return;
        }

        const nextReadyKey = prepared.wallets.length
          ? analysisInputsBaseKey
          : undefined;
        const nextHistoricalDepRevision =
          buildHistoricalRateDependencyRevision({
            depKeys: historicalDepKeys,
            fiatRateSeriesCache,
          }) || 'none';

        analysisHistoricalDepKeysRef.current = historicalDepKeys;
        analysisInputsReadyKeyRef.current = nextReadyKey;
        startTransition(() => {
          if (computeGenerationRef.current !== generation) {
            return;
          }

          setAnalysisInputs(prepared);
          setAnalysisInputsReadyKey(nextReadyKey);
          setAnalysisHistoricalDepRevision(nextHistoricalDepRevision);
        });
      },
      {
        label: 'prepare-analysis-inputs',
        context: `scopeId=${scopeId}`,
      },
    );

    return () => {
      cancelled = true;
      prepareHandle.cancel();
    };
  }, [
    analysisInputsBaseKey,
    fiatRateSeriesCache,
    hasAnySnapshots,
    quoteCurrency,
    scheduleTrackedWork,
    scopeId,
    shouldPrepareAnalysisInputs,
    snapshotsSig,
    walletsSig,
  ]);

  const inputsReady =
    shouldPrepareAnalysisInputs &&
    !!fiatRateSeriesCache &&
    analysisInputs.wallets.length > 0 &&
    analysisInputsReadyKey === analysisInputsBaseKey;

  const computeSeriesForTimeframe = useCallback(
    async (
      timeframe: FiatRateInterval,
    ): Promise<{
      cacheEntry: ReturnType<typeof serializeComputedSeriesToCachedTimeframe>;
      series: ComputedSeries;
    }> => {
      const nowMs = Date.now();

      if (!fiatRateSeriesCache) {
        throw new Error('fiatRateSeriesCache missing');
      }
      if (!analysisInputs.wallets.length) {
        throw new Error('analysisInputs.wallets empty');
      }

      const historicalDepKeys = new Set<string>(
        Array.from(analysisHistoricalDepKeysRef.current || []),
      );

      const buildAnalysis = (targetNowMs: number) =>
        buildPnlAnalysisSeriesAsync({
          wallets: analysisInputs.wallets,
          timeframe,
          quoteCurrency: analysisInputs.quoteCurrency,
          fiatRateSeriesCache,
          currentRatesByAssetId:
            Object.keys(currentSpotRatesByAssetId || {}).length > 0
              ? currentSpotRatesByAssetId
              : undefined,
          currentRatesByCoin:
            Object.keys(currentSpotRatesByCoin || {}).length > 0
              ? currentSpotRatesByCoin
              : undefined,
          nowMs: targetNowMs,
          maxPoints: FIAT_RATE_SERIES_TARGET_POINTS,
          yieldEveryPoints: CHART_COMPUTE_YIELD_EVERY_POINTS,
          outputMode: 'chart',
          onHistoricalRateDependency: cacheKey => {
            if (cacheKey) {
              historicalDepKeys.add(cacheKey);
            }
          },
        });

      let res: Awaited<ReturnType<typeof buildPnlAnalysisSeriesAsync>>;
      try {
        res = await buildAnalysis(nowMs);
      } catch (firstError) {
        const fallbackNowMs =
          getLatestFiatRateSeriesPointTs(fiatRateSeriesCache);
        if (
          !fallbackNowMs ||
          !Number.isFinite(fallbackNowMs) ||
          fallbackNowMs >= nowMs
        ) {
          throw firstError;
        }
        res = await buildAnalysis(fallbackNowMs);
      }

      const analysisPoints = res.points || [];
      if (analysisPoints.length !== FIAT_RATE_SERIES_TARGET_POINTS) {
        throw new Error(
          `Unexpected analysis point count: ${analysisPoints.length} (expected ${FIAT_RATE_SERIES_TARGET_POINTS})`,
        );
      }

      const rawGraphPoints: GraphPoint[] = analysisPoints.map(p => {
        return {
          date: new Date(p.timestamp),
          value: p.totalFiatBalance + balanceOffset,
        };
      });
      const graphPoints = normalizeGraphPointsForChart(rawGraphPoints);
      const pointByTimestamp = buildBalanceChartPointByTimestampMap({
        graphPoints,
        analysisPoints,
      });

      const {minIndex, maxIndex, minPoint, maxPoint} =
        recomputeMinMaxFromGraphPoints(graphPoints);

      const patchMetadata = buildLatestPointPatchMetadataFromAnalysis({
        analysisPoints,
        wallets: analysisInputs.wallets,
      });
      const historicalRateDeps = buildHistoricalRateDependencyMetadataFromCache(
        {
          depKeys: historicalDepKeys,
          fiatRateSeriesCache,
        },
      );
      const cacheEntry = serializeComputedSeriesToCachedTimeframe({
        timeframe,
        walletIds: sortedWalletIds,
        quoteCurrency: analysisInputs.quoteCurrency,
        balanceOffset,
        snapshotVersionSig,
        historicalRateDeps,
        analysisPoints,
        patchMetadata,
      });

      return {
        cacheEntry,
        series: {
          graphPoints,
          analysisPoints,
          pointByTimestamp,
          minIndex,
          maxIndex,
          minPoint,
          maxPoint,
        },
      };
    },
    [
      analysisInputs,
      balanceOffset,
      currentSpotRatesByAssetId,
      currentSpotRatesByCoin,
      fiatRateSeriesCache,
      snapshotVersionSig,
      sortedWalletIds,
    ],
  );

  const enqueueTimeframeCompute = useCallback(
    (timeframe: FiatRateInterval, prioritize = false) => {
      const queue = enqueueComputeRef.current;
      const existingIndex = queue.indexOf(timeframe);
      if (existingIndex >= 0) {
        if (prioritize && existingIndex > 0) {
          queue.splice(existingIndex, 1);
          queue.unshift(timeframe);
        }
        return;
      }

      if (prioritize) {
        queue.unshift(timeframe);
      } else {
        queue.push(timeframe);
      }
    },
    [],
  );

  const processQueue = useCallback(() => {
    if (computingQueueRef.current) {
      return;
    }

    const runNext = () => {
      const next = enqueueComputeRef.current.shift();
      if (!next) {
        computingQueueRef.current = false;
        return;
      }

      computingQueueRef.current = true;
      const generation = computeGenerationRef.current;
      const attemptRevision = getTimeframeAttemptRevision(next);

      setIsComputingByTimeframe(prev =>
        computeGenerationRef.current === generation
          ? {...prev, [next]: true}
          : prev,
      );
      setLastAttemptRevisionByTimeframe(prev =>
        computeGenerationRef.current === generation
          ? {...prev, [next]: attemptRevision}
          : prev,
      );
      setLastErrorByTimeframe(prev =>
        computeGenerationRef.current === generation
          ? {...prev, [next]: undefined}
          : prev,
      );

      scheduleTrackedWork(
        async () => {
          if (computeGenerationRef.current !== generation) {
            computingQueueRef.current = false;
            return;
          }

          try {
            const computed = await computeSeriesForTimeframe(next);
            const timeframeRevision = getTimeframeRevision(
              next,
              computed.cacheEntry.historicalRateDeps,
            );

            if (computeGenerationRef.current !== generation) {
              computingQueueRef.current = false;
              return;
            }

            startTransition(() => {
              setSeriesByTimeframe(prev =>
                computeGenerationRef.current === generation
                  ? {...prev, [next]: computed.series}
                  : prev,
              );
              setSeriesRevisionByTimeframe(prev =>
                computeGenerationRef.current === generation
                  ? {
                      ...prev,
                      [next]: timeframeRevision,
                    }
                  : prev,
              );
            });
            setLastErrorByTimeframe(prev =>
              computeGenerationRef.current === generation
                ? {...prev, [next]: undefined}
                : prev,
            );
            if (computeGenerationRef.current === generation) {
              dispatch(
                upsertBalanceChartScopeTimeframes({
                  scopeId,
                  walletIds: sortedWalletIds,
                  quoteCurrency: computed.cacheEntry.quoteCurrency,
                  balanceOffset,
                  timeframes: [computed.cacheEntry],
                }),
              );
            }
          } catch (e: unknown) {
            if (computeGenerationRef.current !== generation) {
              computingQueueRef.current = false;
              return;
            }

            const msg = typeof e === 'string' ? e : getErrorString(e);
            setLastErrorByTimeframe(prev =>
              computeGenerationRef.current === generation
                ? {...prev, [next]: msg}
                : prev,
            );
          }

          if (computeGenerationRef.current !== generation) {
            computingQueueRef.current = false;
            return;
          }

          setIsComputingByTimeframe(prev =>
            computeGenerationRef.current === generation
              ? {...prev, [next]: false}
              : prev,
          );
          runNext();
        },
        {
          label: 'compute-balance-history-chart',
          context: `scopeId=${scopeId};timeframe=${next}`,
        },
      );
    };

    runNext();
  }, [
    balanceOffset,
    computeSeriesForTimeframe,
    dispatch,
    getTimeframeAttemptRevision,
    getTimeframeRevision,
    scheduleTrackedWork,
    scopeId,
    setSeriesByTimeframe,
    setSeriesRevisionByTimeframe,
    sortedWalletIds,
  ]);

  const ensureTimeframeComputed = useCallback(
    (timeframe: FiatRateInterval, options?: {prioritize?: boolean}) => {
      const cachedStatus =
        cachedTimeframeStatusByTimeframe[timeframe] || 'missing';
      const timeframeRevision = getTimeframeRevision(timeframe);
      const attemptRevision = getTimeframeAttemptRevision(timeframe);

      if (cachedStatus === 'fresh' || cachedStatus === 'patchable') {
        return;
      }

      if (
        seriesByTimeframe[timeframe] &&
        seriesRevisionByTimeframe[timeframe] === timeframeRevision
      ) {
        return;
      }
      if (
        isComputingByTimeframe[timeframe] &&
        lastAttemptRevisionByTimeframe[timeframe] === attemptRevision
      ) {
        return;
      }
      if (!hasAnySnapshots) {
        return;
      }
      if (!inputsReady) {
        return;
      }
      if (
        lastAttemptRevisionByTimeframe[timeframe] === attemptRevision &&
        !!lastErrorByTimeframe[timeframe]
      ) {
        return;
      }
      enqueueTimeframeCompute(timeframe, !!options?.prioritize);
      processQueue();
    },
    [
      cachedTimeframeStatusByTimeframe,
      enqueueTimeframeCompute,
      getTimeframeAttemptRevision,
      getTimeframeRevision,
      hasAnySnapshots,
      inputsReady,
      isComputingByTimeframe,
      lastErrorByTimeframe,
      lastAttemptRevisionByTimeframe,
      processQueue,
      seriesRevisionByTimeframe,
      seriesByTimeframe,
    ],
  );

  const ensureTimeframeComputedRef = useRef(ensureTimeframeComputed);
  useEffect(() => {
    ensureTimeframeComputedRef.current = ensureTimeframeComputed;
  }, [ensureTimeframeComputed]);

  useEffect(() => {
    enqueueComputeRef.current = enqueueComputeRef.current.filter(
      timeframe => timeframe === selectedTimeframe,
    );

    ensureTimeframeComputedRef.current(selectedTimeframe, {prioritize: true});
  }, [balanceOffset, selectedTimeframe]);

  useEffect(() => {
    if (!inputsReady) {
      return;
    }

    ensureTimeframeComputed(selectedTimeframe, {prioritize: true});
  }, [
    ensureTimeframeComputed,
    inputsReady,
    selectedTimeframe,
    selectedTimeframeHistoricalRevision,
  ]);

  useEffect(() => {
    if (!inputsReady || !hasAnySnapshots) {
      return;
    }
    if (!hasCompletedInitialSelectedLoad) {
      return;
    }

    const nextToPrecompute = FIAT_CHART_PRECOMPUTE_TIMEFRAME_ORDER.find(
      timeframe => {
        const cachedStatus =
          cachedTimeframeStatusByTimeframe[timeframe] || 'missing';
        const timeframeRevision = getTimeframeRevision(timeframe);
        const attemptRevision = getTimeframeAttemptRevision(timeframe);

        if (timeframe === selectedTimeframe) {
          return false;
        }
        if (cachedStatus === 'fresh' || cachedStatus === 'patchable') {
          return false;
        }
        if (
          seriesByTimeframe[timeframe] &&
          seriesRevisionByTimeframe[timeframe] === timeframeRevision
        ) {
          return false;
        }
        if (
          isComputingByTimeframe[timeframe] &&
          lastAttemptRevisionByTimeframe[timeframe] === attemptRevision
        ) {
          return false;
        }
        if (
          lastAttemptRevisionByTimeframe[timeframe] === attemptRevision &&
          !!lastErrorByTimeframe[timeframe]
        ) {
          return false;
        }
        return true;
      },
    );

    if (!nextToPrecompute) {
      return;
    }

    enqueueTimeframeCompute(nextToPrecompute, false);
    processQueue();
  }, [
    cachedTimeframeStatusByTimeframe,
    enqueueTimeframeCompute,
    getTimeframeAttemptRevision,
    getTimeframeRevision,
    hasAnySnapshots,
    hasCompletedInitialSelectedLoad,
    inputsReady,
    isComputingByTimeframe,
    lastErrorByTimeframe,
    lastAttemptRevisionByTimeframe,
    processQueue,
    selectedTimeframe,
    seriesRevisionByTimeframe,
    seriesByTimeframe,
  ]);

  return {
    getTimeframeAttemptRevision,
    lastAttemptRevisionByTimeframe,
    lastErrorByTimeframe,
  };
};

export default useBalanceChartComputationQueue;
