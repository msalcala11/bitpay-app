import {startTransition, useCallback, useRef} from 'react';
import type {Dispatch, MutableRefObject, SetStateAction} from 'react';
import type {FiatRateInterval} from '../../store/rate/rate.models';
import {upsertBalanceChartScopeTimeframes} from '../../store/portfolio-charts';
import {isAbortError} from '../../utils/abort';
import {formatUnknownError} from '../../utils/errors/formatUnknownError';
import {
  scheduleAfterInteractionsAndFrames,
  type ScheduledAfterInteractionsHandle,
} from '../../utils/scheduleAfterInteractionsAndFrames';
import type {CachedBalanceChartTimeframe} from '../../store/portfolio-charts';
import type {
  BalanceHistoryChartOrchestrationAction,
  TimeframeComputeDisposition,
} from './balanceHistoryChartOrchestration';

type RetryPolicy = 'retry_interrupted_attempts' | 'suppress_after_attempt';

export const useBalanceHistoryChartComputeQueue = <
  TSeries,
  TChangeRowData,
>(args: {
  computeGenerationRef: MutableRefObject<number>;
  computeSeriesForTimeframe: (
    timeframe: FiatRateInterval,
    signal: AbortSignal,
  ) => Promise<{
    cacheEntry: CachedBalanceChartTimeframe;
    series: TSeries;
  }>;
  dispatch: Dispatch<any>;
  dispatchTimeframeState: Dispatch<
    BalanceHistoryChartOrchestrationAction<TSeries, TChangeRowData>
  >;
  getComputeDispositionForTimeframe: (
    timeframe: FiatRateInterval,
    retryPolicy: RetryPolicy,
  ) => TimeframeComputeDisposition;
  getTimeframeAttemptRevision: (timeframe: FiatRateInterval) => string;
  getTimeframeRevision: (
    timeframe: FiatRateInterval,
    historicalRateDeps?: CachedBalanceChartTimeframe['historicalRateDeps'],
  ) => string;
  selectedTimeframe: FiatRateInterval;
  scopeId: string;
  sortedWalletIds: string[];
  balanceOffset: number;
  setDisplayState: Dispatch<
    SetStateAction<
      | {
          series: TSeries;
          timeframe: FiatRateInterval;
        }
      | undefined
    >
  >;
  trackScheduledHandle: (handle: ScheduledAfterInteractionsHandle) => void;
  onComputeError: (context: string, error: unknown) => void;
}) => {
  const {
    balanceOffset,
    computeGenerationRef,
    computeSeriesForTimeframe,
    dispatch,
    dispatchTimeframeState,
    getComputeDispositionForTimeframe,
    getTimeframeAttemptRevision,
    getTimeframeRevision,
    onComputeError,
    scopeId,
    selectedTimeframe,
    setDisplayState,
    sortedWalletIds,
    trackScheduledHandle,
  } = args;
  const enqueueComputeRef = useRef<FiatRateInterval[]>([]);
  const computingQueueRef = useRef(false);
  const selectedTimeframeRef = useRef(selectedTimeframe);
  const activeTimeframeRef = useRef<FiatRateInterval | undefined>(undefined);
  const activeHandleRef = useRef<ScheduledAfterInteractionsHandle | undefined>(
    undefined,
  );
  const queueGenerationRef = useRef(0);

  selectedTimeframeRef.current = selectedTimeframe;

  const resetComputeQueue = useCallback(() => {
    queueGenerationRef.current += 1;
    enqueueComputeRef.current = [];
    computingQueueRef.current = false;
    activeTimeframeRef.current = undefined;

    const activeHandle = activeHandleRef.current;
    activeHandleRef.current = undefined;
    activeHandle?.cancel();
  }, []);

  const cancelActiveTimeframeCompute = useCallback(() => {
    const activeTimeframe = activeTimeframeRef.current;
    const activeHandle = activeHandleRef.current;

    if (!activeTimeframe && !activeHandle) {
      return undefined;
    }

    queueGenerationRef.current += 1;
    computingQueueRef.current = false;
    activeTimeframeRef.current = undefined;
    activeHandleRef.current = undefined;
    activeHandle?.cancel();

    return activeTimeframe;
  }, []);

  const retainOnlyQueuedTimeframe = useCallback(
    (timeframe: FiatRateInterval) => {
      enqueueComputeRef.current = enqueueComputeRef.current.filter(
        queuedTimeframe => queuedTimeframe === timeframe,
      );
    },
    [],
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

    computingQueueRef.current = true;
    const queueGeneration = queueGenerationRef.current;

    const runNext = () => {
      if (queueGenerationRef.current !== queueGeneration) {
        return;
      }

      const nextTimeframe = enqueueComputeRef.current.shift();
      if (!nextTimeframe) {
        activeTimeframeRef.current = undefined;
        activeHandleRef.current = undefined;
        computingQueueRef.current = false;
        return;
      }

      activeTimeframeRef.current = nextTimeframe;

      const generation = computeGenerationRef.current;
      const attemptRevision = getTimeframeAttemptRevision(nextTimeframe);

      dispatchTimeframeState({
        type: 'startCompute',
        timeframe: nextTimeframe,
        attemptRevision,
        generation,
      });

      const computeHandle = scheduleAfterInteractionsAndFrames({
        callback: async signal => {
          try {
            if (queueGenerationRef.current !== queueGeneration) {
              return;
            }

            if (computeGenerationRef.current !== generation) {
              return;
            }

            const computed = await computeSeriesForTimeframe(
              nextTimeframe,
              signal,
            );
            const timeframeRevision = getTimeframeRevision(
              nextTimeframe,
              computed.cacheEntry.historicalRateDeps,
            );

            if (
              queueGenerationRef.current !== queueGeneration ||
              computeGenerationRef.current !== generation ||
              signal.aborted
            ) {
              return;
            }

            startTransition(() => {
              dispatchTimeframeState({
                type: 'resolveCompute',
                timeframe: nextTimeframe,
                attemptRevision,
                series: computed.series,
                seriesRevision: timeframeRevision,
                generation,
              });

              if (nextTimeframe === selectedTimeframeRef.current) {
                setDisplayState(previous =>
                  previous?.series === computed.series &&
                  previous?.timeframe === nextTimeframe
                    ? previous
                    : {
                        series: computed.series,
                        timeframe: nextTimeframe,
                      },
                );
              }
            });

            if (
              queueGenerationRef.current === queueGeneration &&
              computeGenerationRef.current === generation &&
              !signal.aborted
            ) {
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
          } catch (error: unknown) {
            if (
              computeGenerationRef.current !== generation ||
              signal.aborted ||
              isAbortError(error)
            ) {
              return;
            }

            onComputeError(`compute failed for ${nextTimeframe}`, error);
            dispatchTimeframeState({
              type: 'rejectCompute',
              timeframe: nextTimeframe,
              attemptRevision,
              error: formatUnknownError(error),
              generation,
            });
          } finally {
            if (activeHandleRef.current === computeHandle) {
              activeHandleRef.current = undefined;
            }
            if (activeTimeframeRef.current === nextTimeframe) {
              activeTimeframeRef.current = undefined;
            }

            if (queueGenerationRef.current !== queueGeneration) {
              return;
            }

            if (computeGenerationRef.current !== generation) {
              computingQueueRef.current = false;
              return;
            }

            runNext();
          }
        },
      });
      activeHandleRef.current = computeHandle;
      trackScheduledHandle(computeHandle);
    };

    runNext();
  }, [
    balanceOffset,
    computeGenerationRef,
    computeSeriesForTimeframe,
    dispatch,
    dispatchTimeframeState,
    getTimeframeAttemptRevision,
    getTimeframeRevision,
    onComputeError,
    scopeId,
    setDisplayState,
    sortedWalletIds,
    trackScheduledHandle,
  ]);

  const queueTimeframeCompute = useCallback(
    (timeframe: FiatRateInterval, prioritize = false) => {
      enqueueTimeframeCompute(timeframe, prioritize);
      processQueue();
    },
    [enqueueTimeframeCompute, processQueue],
  );

  const ensureTimeframeComputed = useCallback(
    (
      timeframe: FiatRateInterval,
      options?: {
        prioritize?: boolean;
        retryPolicy?: RetryPolicy;
      },
    ) => {
      const disposition = getComputeDispositionForTimeframe(
        timeframe,
        options?.retryPolicy || 'retry_interrupted_attempts',
      );
      if (!disposition.shouldQueue) {
        return;
      }

      queueTimeframeCompute(timeframe, !!options?.prioritize);
    },
    [getComputeDispositionForTimeframe, queueTimeframeCompute],
  );

  return {
    activeTimeframeRef,
    cancelActiveTimeframeCompute,
    ensureTimeframeComputed,
    queueTimeframeCompute,
    retainOnlyQueuedTimeframe,
    resetComputeQueue,
  };
};
