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
import {
  getPerfClockNowMs,
  measurePerfSync,
  recordPerfEvent,
  startPerfSpan,
  type PerfMetadata,
} from '../../utils/perfLogger';

type RetryPolicy = 'retry_interrupted_attempts' | 'suppress_after_attempt';

export const useBalanceHistoryChartComputeQueue = <
  TSeries,
  TChangeRowData,
>(args: {
  computeGenerationRef: MutableRefObject<number>;
  buildPerfMetadata: (metadata?: PerfMetadata) => PerfMetadata;
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
  const enqueueComputeRef = useRef<FiatRateInterval[]>([]);
  const computingQueueRef = useRef(false);
  const selectedTimeframeRef = useRef(args.selectedTimeframe);
  const timeframeQueuedAtMsRef = useRef<
    Partial<Record<FiatRateInterval, number>>
  >({});

  selectedTimeframeRef.current = args.selectedTimeframe;

  const resetComputeQueue = useCallback(() => {
    enqueueComputeRef.current = [];
    computingQueueRef.current = false;
    timeframeQueuedAtMsRef.current = {};
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
          recordPerfEvent(
            'balance_chart.compute_reprioritized',
            args.buildPerfMetadata({
              prioritize,
              timeframe,
            }),
          );
        }
        return;
      }

      if (prioritize) {
        queue.unshift(timeframe);
      } else {
        queue.push(timeframe);
      }

      timeframeQueuedAtMsRef.current[timeframe] = getPerfClockNowMs();
      recordPerfEvent(
        'balance_chart.compute_enqueued',
        args.buildPerfMetadata({
          prioritize,
          timeframe,
        }),
      );
    },
    [args],
  );

  const processQueue = useCallback(() => {
    if (computingQueueRef.current) {
      return;
    }

    computingQueueRef.current = true;

    const runNext = () => {
      const nextTimeframe = enqueueComputeRef.current.shift();
      if (!nextTimeframe) {
        computingQueueRef.current = false;
        return;
      }

      const generation = args.computeGenerationRef.current;
      const attemptRevision = args.getTimeframeAttemptRevision(nextTimeframe);
      const scheduledAtMs = getPerfClockNowMs();
      const queuedAtMs =
        timeframeQueuedAtMsRef.current[nextTimeframe] || scheduledAtMs;

      args.dispatchTimeframeState({
        type: 'startCompute',
        timeframe: nextTimeframe,
        attemptRevision,
        generation,
      });

      const computeHandle = scheduleAfterInteractionsAndFrames({
        callback: async signal => {
          const computeStartedAtMs = getPerfClockNowMs();
          const computeSpan = startPerfSpan(
            'balance_chart.compute',
            args.buildPerfMetadata({
              attemptRevision,
              generation,
              queueWaitMs: computeStartedAtMs - queuedAtMs,
              scheduledWaitMs: computeStartedAtMs - scheduledAtMs,
              timeframe: nextTimeframe,
            }),
          );
          try {
            if (args.computeGenerationRef.current !== generation) {
              computeSpan.cancel({
                reason: 'generation_changed_before_start',
              });
              return;
            }

            const computed = await args.computeSeriesForTimeframe(
              nextTimeframe,
              signal,
            );
            const timeframeRevision = args.getTimeframeRevision(
              nextTimeframe,
              computed.cacheEntry.historicalRateDeps,
            );

            if (args.computeGenerationRef.current !== generation) {
              computeSpan.cancel({
                reason: 'generation_changed_after_compute',
              });
              return;
            }

            computeSpan.finish({
              graphPointCount: (computed.series as any)?.graphPoints?.length,
              historicalRateDependencyCount:
                computed.cacheEntry.historicalRateDeps?.length || 0,
              timeframeRevision,
            });

            startTransition(() => {
              args.dispatchTimeframeState({
                type: 'resolveCompute',
                timeframe: nextTimeframe,
                attemptRevision,
                series: computed.series,
                seriesRevision: timeframeRevision,
                generation,
              });

              if (nextTimeframe === selectedTimeframeRef.current) {
                args.setDisplayState(previous =>
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

            if (args.computeGenerationRef.current === generation) {
              measurePerfSync(
                'balance_chart.cache_upsert_dispatch',
                () =>
                  args.dispatch(
                    upsertBalanceChartScopeTimeframes({
                      scopeId: args.scopeId,
                      walletIds: args.sortedWalletIds,
                      quoteCurrency: computed.cacheEntry.quoteCurrency,
                      balanceOffset: args.balanceOffset,
                      timeframes: [computed.cacheEntry],
                    }),
                  ),
                args.buildPerfMetadata({
                  timeframe: nextTimeframe,
                  timeframeRevision,
                }),
              );
            }
          } catch (error: unknown) {
            if (
              args.computeGenerationRef.current !== generation ||
              signal.aborted ||
              isAbortError(error)
            ) {
              computeSpan.cancel({
                reason:
                  signal.aborted || isAbortError(error)
                    ? 'aborted'
                    : 'generation_changed_on_error',
              });
              return;
            }

            computeSpan.fail(error);
            args.onComputeError(`compute failed for ${nextTimeframe}`, error);
            args.dispatchTimeframeState({
              type: 'rejectCompute',
              timeframe: nextTimeframe,
              attemptRevision,
              error: formatUnknownError(error),
              generation,
            });
          } finally {
            if (args.computeGenerationRef.current !== generation) {
              computingQueueRef.current = false;
              delete timeframeQueuedAtMsRef.current[nextTimeframe];
              return;
            }

            delete timeframeQueuedAtMsRef.current[nextTimeframe];
            runNext();
          }
        },
      });
      args.trackScheduledHandle(computeHandle);
    };

    runNext();
  }, [
    args.balanceOffset,
    args.buildPerfMetadata,
    args.computeGenerationRef,
    args.computeSeriesForTimeframe,
    args.dispatch,
    args.dispatchTimeframeState,
    args.getTimeframeAttemptRevision,
    args.getTimeframeRevision,
    args.onComputeError,
    args.scopeId,
    args.setDisplayState,
    args.sortedWalletIds,
    args.trackScheduledHandle,
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
      const disposition = args.getComputeDispositionForTimeframe(
        timeframe,
        options?.retryPolicy || 'retry_interrupted_attempts',
      );
      if (!disposition.shouldQueue) {
        return;
      }

      queueTimeframeCompute(timeframe, !!options?.prioritize);
    },
    [args, queueTimeframeCompute],
  );

  return {
    ensureTimeframeComputed,
    queueTimeframeCompute,
    retainOnlyQueuedTimeframe,
    resetComputeQueue,
  };
};
