import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {InteractionManager} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import {useTranslation} from 'react-i18next';
import {useTheme} from 'styled-components/native';
import type {GraphPoint} from 'react-native-graph';
import type {FiatRateSeriesCache, FiatRateInterval} from '../../store/rate/rate.models';
import type {Rates} from '../../store/rate/rate.models';
import type {BalanceSnapshot} from '../../store/portfolio/portfolio.models';
import type {Wallet} from '../../store/wallet/wallet.models';
import {FIAT_RATE_SERIES_TARGET_POINTS} from '../../store/rate/rate.models';
import {
  buildPnlAnalysisSeries,
  type PnlAnalysisPoint,
} from '../../utils/portfolio/core/pnl/analysis';
import {formatFiatAmount} from '../../utils/helper-methods';
import {
  FIAT_CHART_TIMEFRAMES,
  formatRangeOrSelectedPointLabel,
  getRangeLabelForFiatTimeframe,
} from './fiatTimeframes';
import TimeframeSelector from './TimeframeSelector';
import InteractiveLineChart from './InteractiveLineChart';
import ChartAxisLabel from './ChartAxisLabel';
import ChartSelectionDot from './ChartSelectionDot';
import ChartChangeRow from './ChartChangeRow';
import {ProgressBlue, White} from '../../styles/colors';
import haptic from '../haptic-feedback/haptic';
import {buildPnlWalletInputsFromPortfolioSnapshots} from '../../utils/portfolio/assets';

const DAY_MS = 24 * 60 * 60 * 1000;

type ComputedSeries = {
  graphPoints: GraphPoint[];
  analysisPoints: PnlAnalysisPoint[];
  pointByTimestamp: Map<number, PnlAnalysisPoint>;
  minIndex: number;
  maxIndex: number;
  minPoint: GraphPoint;
  maxPoint: GraphPoint;
};

const GRAPH_DRAWABLE_EPSILON = 0.0001;

const normalizeGraphPointsForChart = (points: GraphPoint[]): GraphPoint[] => {
  if (!points.length) {
    return points;
  }

  const normalized: GraphPoint[] = [];
  const fallbackTsBase = Date.now();
  let prevTs = Number.NEGATIVE_INFINITY;
  let minV = Number.POSITIVE_INFINITY;
  let maxV = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < points.length; i++) {
    const src = points[i];
    const rawTs =
      src?.date instanceof Date ? src.date.getTime() : Number((src as any)?.date);
    let ts = Number.isFinite(rawTs) ? rawTs : fallbackTsBase + i;
    if (Number.isFinite(prevTs) && ts <= prevTs) {
      ts = prevTs + 1;
    }

    const fallbackValue = normalized.length
      ? normalized[normalized.length - 1].value
      : 0;
    const value = Number.isFinite(src?.value) ? src.value : fallbackValue;

    normalized.push({
      date: new Date(ts),
      value,
    });
    prevTs = ts;

    if (value < minV) {
      minV = value;
    }
    if (value > maxV) {
      maxV = value;
    }
  }

  // react-native-graph may render nothing when all values are identical (0 range).
  // Add a tiny epsilon to the last point to guarantee a drawable range without
  // affecting formatted labels.
  if (normalized.length >= 2 && minV === maxV) {
    normalized[normalized.length - 1] = {
      ...normalized[normalized.length - 1],
      value: normalized[normalized.length - 1].value + GRAPH_DRAWABLE_EPSILON,
    };
  }

  return normalized;
};

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

const buildPlaceholderSeries = (args: {
  timeframe: FiatRateInterval;
  nowMs: number;
  value: number;
}): ComputedSeries => {
  const windowMs = (() => {
    switch (args.timeframe) {
      case '1D':
        return 1 * DAY_MS;
      case '1W':
        return 7 * DAY_MS;
      case '1M':
        return 30 * DAY_MS;
      case '3M':
        return 90 * DAY_MS;
      case '1Y':
        return 365 * DAY_MS;
      case '5Y':
        return 1825 * DAY_MS;
      case 'ALL':
      default:
        return 1825 * DAY_MS;
    }
  })();

  const end = args.nowMs;
  const start = end - windowMs;
  const step = windowMs / (FIAT_RATE_SERIES_TARGET_POINTS - 1);

  const analysisPoints: PnlAnalysisPoint[] = [];
  const rawGraphPoints: GraphPoint[] = [];

  for (let i = 0; i < FIAT_RATE_SERIES_TARGET_POINTS; i++) {
    const ts = Math.round(start + step * i);
    const ap: PnlAnalysisPoint = {
      timestamp: ts,
      totalFiatBalance: args.value,
      totalRemainingCostBasisFiat: args.value,
      totalUnrealizedPnlFiat: 0,
      totalPnlPercent: 0,
      byWalletId: {},
    };
    analysisPoints.push(ap);
    rawGraphPoints.push({date: new Date(ts), value: args.value});
  }

  const graphPoints = normalizeGraphPointsForChart(rawGraphPoints);
  const pointByTimestamp = new Map<number, PnlAnalysisPoint>();
  for (let i = 0; i < graphPoints.length; i++) {
    pointByTimestamp.set(graphPoints[i].date.getTime(), analysisPoints[i]);
  }

  const {minIndex, maxIndex, minPoint, maxPoint} = computeMinMax(graphPoints);

  return {
    graphPoints,
    analysisPoints,
    pointByTimestamp,
    minIndex,
    maxIndex,
    minPoint,
    maxPoint,
  };
};

const computeMinMax = (points: GraphPoint[]) => {
  let minIndex = 0;
  let maxIndex = 0;
  let minValue = Number.POSITIVE_INFINITY;
  let maxValue = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < points.length; i++) {
    const v = points[i].value;
    if (v < minValue) {
      minValue = v;
      minIndex = i;
    }
    if (v > maxValue) {
      maxValue = v;
      maxIndex = i;
    }
  }

  return {
    minIndex,
    maxIndex,
    minPoint: points[minIndex],
    maxPoint: points[maxIndex],
  };
};

export type BalanceHistoryChartProps = {
  wallets: Wallet[];
  snapshotsByWalletId: {[walletId: string]: BalanceSnapshot[] | undefined};
  quoteCurrency: string;
  rates?: Rates;
  fiatRateSeriesCache?: FiatRateSeriesCache;
  /**
   * Optional constant offset to add to rendered balance points.
   * Useful when a portion of the displayed balance cannot be historized.
   */
  balanceOffset?: number;
  onSelectedBalanceChange?: (balance?: number) => void;
};

const BalanceHistoryChart = ({
  wallets,
  snapshotsByWalletId,
  quoteCurrency,
  rates,
  fiatRateSeriesCache,
  balanceOffset = 0,
  onSelectedBalanceChange,
}: BalanceHistoryChartProps): React.ReactElement | null => {
  const {t} = useTranslation();
  const theme = useTheme();

  const [selectedTimeframe, setSelectedTimeframe] =
    useState<FiatRateInterval>('ALL');

  const [seriesByTimeframe, setSeriesByTimeframe] = useState<
    Partial<Record<FiatRateInterval, ComputedSeries>>
  >({});

  const [isComputingByTimeframe, setIsComputingByTimeframe] = useState<
    Partial<Record<FiatRateInterval, boolean>>
  >({});

  const [lastAttemptRevisionByTimeframe, setLastAttemptRevisionByTimeframe] =
    useState<Partial<Record<FiatRateInterval, string>>>({});

  const [lastErrorByTimeframe, setLastErrorByTimeframe] = useState<
    Partial<Record<FiatRateInterval, string>>
  >({});

  const [displayData, setDisplayData] = useState<ComputedSeries>(() =>
    buildPlaceholderSeries({
      timeframe: 'ALL',
      nowMs: Date.now(),
      value: balanceOffset,
    }),
  );

  const prevDisplayDataRef = useRef<ComputedSeries>(displayData);

  const [selectedPoint, setSelectedPoint] = useState<GraphPoint | undefined>();

  const renderCountRef = useRef(0);
  renderCountRef.current += 1;

  // NOTE: Some call sites may pass inline callbacks. Avoid re-running effects
  // (and thus triggering render loops) when the callback identity changes.
  const onSelectedBalanceChangeRef = useRef(onSelectedBalanceChange);
  useEffect(() => {
    onSelectedBalanceChangeRef.current = onSelectedBalanceChange;
  }, [onSelectedBalanceChange]);

  const gestureStarted = useRef(false);

  const walletsSig = useMemo(() => {
    return (wallets || [])
      .map(w => String((w as any)?.id || ''))
      .filter(Boolean)
      .join(',');
  }, [wallets]);

  const snapshotsSig = useMemo(() => {
    const parts: string[] = [];
    for (const w of wallets || []) {
      const id = String((w as any)?.id || '');
      if (!id) continue;
      const snaps = snapshotsByWalletId?.[id] || [];
      const last = snaps.length ? (snaps[snaps.length - 1] as any)?.timestamp : 0;
      parts.push(`${id}:${snaps.length}:${last || 0}`);
    }
    return parts.join('|');
  }, [snapshotsByWalletId, wallets]);

  const snapshotStats = useMemo(() => {
    const stats: Array<{
      walletId: string;
      count: number;
      firstTs: number | null;
      lastTs: number | null;
    }> = [];

    let totalCount = 0;
    for (const w of wallets || []) {
      const id = String((w as any)?.id || '');
      if (!id) {
        continue;
      }
      const snaps = Array.isArray(snapshotsByWalletId?.[id])
        ? (snapshotsByWalletId?.[id] as BalanceSnapshot[])
        : [];
      const count = snaps.length;
      totalCount += count;
      const firstTs = count ? Number((snaps[0] as any)?.timestamp || 0) : null;
      const lastTs = count
        ? Number((snaps[count - 1] as any)?.timestamp || 0)
        : null;
      stats.push({walletId: id, count, firstTs, lastTs});
    }

    return {stats, totalCount};
  }, [snapshotsByWalletId, wallets]);

  const hasAnySnapshots = snapshotStats.totalCount > 0;

  const cacheRevision = useMemo(() => {
    if (!fiatRateSeriesCache) {
      return '0';
    }

    let keysCount = 0;
    let maxFetchedOn = 0;
    for (const k in fiatRateSeriesCache) {
      if (!Object.prototype.hasOwnProperty.call(fiatRateSeriesCache, k)) {
        continue;
      }
      keysCount += 1;
      const fetchedOn = (fiatRateSeriesCache as any)?.[k]?.fetchedOn;
      if (typeof fetchedOn === 'number' && fetchedOn > maxFetchedOn) {
        maxFetchedOn = fetchedOn;
      }
    }

    return `${keysCount}:${maxFetchedOn}`;
  }, [fiatRateSeriesCache]);

  const analysisInputs = useMemo(() => {
    return buildPnlWalletInputsFromPortfolioSnapshots({
      snapshotsByWalletId: snapshotsByWalletId || {},
      wallets: wallets || [],
      quoteCurrency,
      rates,
      fiatRateSeriesCache,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletsSig, snapshotsSig, quoteCurrency, rates, fiatRateSeriesCache]);

  const inputsReady =
    hasAnySnapshots &&
    !!fiatRateSeriesCache &&
    analysisInputs.wallets.length > 0;

  const computeSeriesForTimeframe = useCallback(
    (timeframe: FiatRateInterval): ComputedSeries => {
      const nowMs = Date.now();

      if (!fiatRateSeriesCache) {
        throw new Error('fiatRateSeriesCache missing');
      }
      if (!analysisInputs.wallets.length) {
        throw new Error('analysisInputs.wallets empty');
      }

      const buildAnalysis = (targetNowMs: number) =>
        buildPnlAnalysisSeries({
          wallets: analysisInputs.wallets,
          timeframe: timeframe as any,
          quoteCurrency: analysisInputs.quoteCurrency,
          fiatRateSeriesCache: fiatRateSeriesCache as any,
          currentRatesByCoin:
            Object.keys(analysisInputs.currentRatesByCoin || {}).length > 0
              ? analysisInputs.currentRatesByCoin
              : undefined,
          nowMs: targetNowMs,
          maxPoints: FIAT_RATE_SERIES_TARGET_POINTS,
        });

      let res: ReturnType<typeof buildPnlAnalysisSeries>;
      try {
        res = buildAnalysis(nowMs);
      } catch (firstError) {
        const fallbackNowMs = getLatestFiatRateSeriesPointTs(fiatRateSeriesCache);
        if (
          !fallbackNowMs ||
          !Number.isFinite(fallbackNowMs) ||
          fallbackNowMs >= nowMs
        ) {
          throw firstError;
        }
        res = buildAnalysis(fallbackNowMs);
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
      const pointByTimestamp = new Map<number, PnlAnalysisPoint>();
      for (let i = 0; i < graphPoints.length; i++) {
        pointByTimestamp.set(graphPoints[i].date.getTime(), analysisPoints[i]);
      }

      const {minIndex, maxIndex, minPoint, maxPoint} = computeMinMax(graphPoints);

      return {
        graphPoints,
        analysisPoints,
        pointByTimestamp,
        minIndex,
        maxIndex,
        minPoint,
        maxPoint,
      };
    },
    [analysisInputs, balanceOffset, fiatRateSeriesCache],
  );

  const enqueueComputeRef = useRef<FiatRateInterval[]>([]);
  const computingQueueRef = useRef(false);

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

    InteractionManager.runAfterInteractions(() => {
      const runNext = () => {
        const next = enqueueComputeRef.current.shift();
        if (!next) {
          computingQueueRef.current = false;
          return;
        }

        setIsComputingByTimeframe(prev => ({...prev, [next]: true}));
        setLastAttemptRevisionByTimeframe(prev => ({...prev, [next]: cacheRevision}));

        // Let loading state render before running potentially heavy analysis.
        const scheduleCompute = (cb: () => void) => {
          if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => {
              setTimeout(cb, 0);
            });
            return;
          }
          setTimeout(cb, 0);
        };

        scheduleCompute(() => {
          try {
            const computed = computeSeriesForTimeframe(next);
            setSeriesByTimeframe(prev => ({...prev, [next]: computed}));
            setLastErrorByTimeframe(prev => ({...prev, [next]: undefined}));
          } catch (e: any) {
            const msg =
              e instanceof Error
                ? e.message
                : typeof e === 'string'
                ? e
                : JSON.stringify(e);
            setLastErrorByTimeframe(prev => ({...prev, [next]: msg}));
          }

          setIsComputingByTimeframe(prev => ({...prev, [next]: false}));
          runNext();
        }, 0);
      };

      runNext();
    });
  }, [cacheRevision, computeSeriesForTimeframe]);

  const ensureTimeframeComputed = useCallback(
    (tf: FiatRateInterval, options?: {prioritize?: boolean}) => {
      if (seriesByTimeframe[tf]) {
        return;
      }
      if (isComputingByTimeframe[tf]) {
        return;
      }
      if (!hasAnySnapshots) {
        return;
      }
      if (!inputsReady) {
        return;
      }
      // Avoid retry loops: only attempt again when the fiat-rate cache revision changes.
      if (lastAttemptRevisionByTimeframe[tf] === cacheRevision) {
        return;
      }
      enqueueTimeframeCompute(tf, !!options?.prioritize);
      processQueue();
    },
    [
      cacheRevision,
      enqueueTimeframeCompute,
      hasAnySnapshots,
      inputsReady,
      isComputingByTimeframe,
      lastAttemptRevisionByTimeframe,
      processQueue,
      seriesByTimeframe,
    ],
  );

  const ensureTimeframeComputedRef = useRef(ensureTimeframeComputed);
  useEffect(() => {
    ensureTimeframeComputedRef.current = ensureTimeframeComputed;
  }, [ensureTimeframeComputed]);

  // Reset computed state when the wallet set or quote currency changes.
  useEffect(() => {
    enqueueComputeRef.current = [];
    computingQueueRef.current = false;

    setSeriesByTimeframe({});
    setIsComputingByTimeframe({});
    setLastAttemptRevisionByTimeframe({});
    setLastErrorByTimeframe({});
    setSelectedPoint(undefined);
    onSelectedBalanceChangeRef.current?.(undefined);

    setDisplayData(
      buildPlaceholderSeries({
        timeframe: selectedTimeframe,
        nowMs: Date.now(),
        value: balanceOffset,
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletsSig, snapshotsSig, quoteCurrency, balanceOffset]);

  // On timeframe change, keep the previously rendered series visible while
  // the new timeframe computes (shown with reduced opacity behind loader).
  // IMPORTANT: depend ONLY on timeframe/balanceOffset so we don't re-run on
  // every render due to callback identity or internal helper identity changes.
  useEffect(() => {
    setSelectedPoint(undefined);
    onSelectedBalanceChangeRef.current?.(undefined);
    enqueueComputeRef.current = enqueueComputeRef.current.filter(
      tf => tf === selectedTimeframe,
    );

    // Compute selected timeframe (if possible) after painting.
    ensureTimeframeComputedRef.current(selectedTimeframe, {prioritize: true});
  }, [selectedTimeframe, balanceOffset]);

  // When inputs become ready or the fiat-rate cache updates, try computing missing series.
  useEffect(() => {
    if (!inputsReady) {
      return;
    }

    // Compute only the selected timeframe to avoid background JS work
    // freezing selector interactions.
    ensureTimeframeComputed(selectedTimeframe, {prioritize: true});
  }, [cacheRevision, ensureTimeframeComputed, inputsReady, selectedTimeframe]);

  const selectedComputedSeries = seriesByTimeframe[selectedTimeframe];
  const selectedTimeframeError = lastErrorByTimeframe[selectedTimeframe];

  const selectedOrFallbackComputedSeries = useMemo(() => {
    if (selectedComputedSeries) {
      return selectedComputedSeries;
    }
    if (!selectedTimeframeError) {
      return undefined;
    }

    const fallbackOrder: FiatRateInterval[] = [
      'ALL',
      '1W',
      '1M',
      '3M',
      '1Y',
      '5Y',
      '1D',
    ];
    for (const tf of fallbackOrder) {
      if (tf === selectedTimeframe) {
        continue;
      }
      const cached = seriesByTimeframe[tf];
      if (cached) {
        return cached;
      }
    }

    return undefined;
  }, [
    selectedComputedSeries,
    selectedTimeframe,
    selectedTimeframeError,
    seriesByTimeframe,
  ]);

  // Swap in the computed series once available.
  useEffect(() => {
    if (!selectedComputedSeries) {
      return;
    }

    setDisplayData(prev => {
      prevDisplayDataRef.current = prev;
      return selectedComputedSeries;
    });
  }, [selectedComputedSeries]);

  const rangeLabel = useMemo(
    () => getRangeLabelForFiatTimeframe(t, selectedTimeframe),
    [selectedTimeframe, t],
  );

  const rangeOrSelectedPointLabel = useMemo(() => {
    return formatRangeOrSelectedPointLabel({
      rangeLabel,
      selectedTimeframe,
      selectedDate: selectedPoint?.date,
    });
  }, [rangeLabel, selectedPoint?.date, selectedTimeframe]);

  // Show loader while computing, or while waiting for required inputs/series.
  const isSelectedTimeframePending =
    !selectedComputedSeries && !selectedTimeframeError;
  const isChartLoading =
    !inputsReady ||
    !!isComputingByTimeframe[selectedTimeframe] ||
    isSelectedTimeframePending;

  const activeSeries =
    selectedComputedSeries || selectedOrFallbackComputedSeries || displayData;
  const isUsingFallbackSeries =
    !selectedComputedSeries && !!selectedOrFallbackComputedSeries;

  const selectedAnalysisPoint = useMemo(() => {
    if (!selectedPoint) {
      return undefined;
    }
    const ts = selectedPoint.date.getTime();
    return activeSeries.pointByTimestamp.get(ts);
  }, [activeSeries.pointByTimestamp, selectedPoint]);

  const lastAnalysisPoint = useMemo(() => {
    const pts = activeSeries.analysisPoints;
    return pts.length ? pts[pts.length - 1] : undefined;
  }, [activeSeries.analysisPoints]);

  // IMPORTANT: For balance screens, the change row is unrealized profit vs cost basis
  // (NOT start→end balance delta). This mirrors the existing PnL engine UI elsewhere.
  const pnlDeltaFiat =
    selectedAnalysisPoint?.totalUnrealizedPnlFiat ??
    lastAnalysisPoint?.totalUnrealizedPnlFiat ??
    0;
  const pnlPercent =
    selectedAnalysisPoint?.totalPnlPercent ??
    lastAnalysisPoint?.totalPnlPercent ??
    0;

  const formattedDeltaFiat = useMemo(() => {
    return formatFiatAmount(pnlDeltaFiat, quoteCurrency, {
      customPrecision: 'minimal',
      currencyDisplay: 'symbol',
    });
  }, [pnlDeltaFiat, quoteCurrency]);

  const onGestureStarted = useCallback(() => {
    gestureStarted.current = true;
  }, []);

  const onGestureEnded = useCallback(() => {
    haptic('impactLight');
    gestureStarted.current = false;
    setSelectedPoint(undefined);
    onSelectedBalanceChangeRef.current?.(undefined);
  }, []);

  const onPointSelected = useCallback(
    (p: GraphPoint) => {
      if (!gestureStarted.current) {
        return;
      }
      setSelectedPoint(p);
      const ap = activeSeries.pointByTimestamp.get(p.date.getTime());
      const actualBalance =
        typeof ap?.totalFiatBalance === 'number'
          ? ap.totalFiatBalance + balanceOffset
          : p.value;
      onSelectedBalanceChangeRef.current?.(actualBalance);
    },
    [activeSeries.pointByTimestamp, balanceOffset],
  );

  // Axis labels animate using prevDisplayDataRef (matches ExchangeRate behavior).
  const MaxAxisLabel = useCallback(() => {
    if (isChartLoading) {
      return null;
    }
    const prevMaxIndex = prevDisplayDataRef.current?.maxIndex;

    return (
      <ChartAxisLabel
        value={activeSeries.maxPoint.value}
        index={activeSeries.maxIndex}
        prevIndex={prevMaxIndex}
        arrayLength={activeSeries.graphPoints.length}
        currencyAbbreviation={undefined}
        type="max"
      />
    );
  }, [activeSeries, isChartLoading]);

  const MinAxisLabel = useCallback(() => {
    if (isChartLoading) {
      return null;
    }
    const prevMinIndex = prevDisplayDataRef.current?.minIndex;

    return (
      <ChartAxisLabel
        value={activeSeries.minPoint.value}
        index={activeSeries.minIndex}
        prevIndex={prevMinIndex}
        arrayLength={activeSeries.graphPoints.length}
        currencyAbbreviation={undefined}
        type="min"
      />
    );
  }, [activeSeries, isChartLoading]);

  const copyDiagnosticsToClipboard = useCallback(
    (requestedTimeframe?: FiatRateInterval, source: 'chart' | 'selector' = 'chart') => {
    try {
      const computedTfs = Object.keys(seriesByTimeframe || {});
      const tf = requestedTimeframe || selectedTimeframe;
      const requestedSeries = seriesByTimeframe[tf];
      const requestedError = lastErrorByTimeframe[tf];
      const requestedPoints = requestedSeries?.graphPoints || [];
      const requestedFirstTs = requestedPoints.length
        ? requestedPoints[0].date.getTime()
        : undefined;
      const requestedLastTs = requestedPoints.length
        ? requestedPoints[requestedPoints.length - 1].date.getTime()
        : undefined;
      const diag = {
        kind: 'BalanceHistoryChartDiagnostics',
        nowMs: Date.now(),
        renderCount: renderCountRef.current,
        source,
        requestedTimeframe: tf,
        selectedTimeframe,
        selectedTimeframeError,
        quoteCurrency,
        walletsSig,
        snapshotsSig,
        walletsCount: (wallets || []).length,
        snapshotStats,
        inputsReady,
        analysisWalletsCount: analysisInputs.wallets.length,
        analysisCoins: analysisInputs.wallets.map(w => w.currencyAbbreviation),
        fiatRateSeriesCachePresent: !!fiatRateSeriesCache,
        cacheRevision,
        computedTimeframes: computedTfs,
        selectedTimeframeComputed: !!selectedComputedSeries,
        selectedOrFallbackComputed: !!selectedOrFallbackComputedSeries,
        isUsingFallbackSeries,
        isComputingByTimeframe,
        lastAttemptRevisionByTimeframe,
        lastErrorByTimeframe,
        requestedTimeframeComputed: !!requestedSeries,
        requestedTimeframeError: requestedError,
        requestedTimeframePointCount: requestedPoints.length,
        requestedTimeframeFirstTs: requestedFirstTs,
        requestedTimeframeLastTs: requestedLastTs,
      };

      Clipboard.setString(JSON.stringify(diag, null, 2));
      haptic('impactLight');
    } catch {
      // no-op
    }
    },
    [
      analysisInputs.wallets,
      cacheRevision,
      fiatRateSeriesCache,
      inputsReady,
      isComputingByTimeframe,
      isUsingFallbackSeries,
      lastAttemptRevisionByTimeframe,
      lastErrorByTimeframe,
      quoteCurrency,
      selectedComputedSeries,
      selectedOrFallbackComputedSeries,
      selectedTimeframe,
      selectedTimeframeError,
      seriesByTimeframe,
      snapshotStats,
      snapshotsSig,
      wallets,
      walletsSig,
    ],
  );

  const chartColor = ProgressBlue;
  const gradientBackgroundColor = theme.dark ? 'transparent' : White;

  // Per product requirements: if there has never been any transaction history
  // (i.e., no portfolio snapshots for this wallet set), hide the chart entirely.
  if (!hasAnySnapshots) {
    return null;
  }

  return (
    <>
      <ChartChangeRow
        percent={pnlPercent}
        deltaFiatFormatted={formattedDeltaFiat}
        rangeLabel={rangeOrSelectedPointLabel}
        isLoading={isChartLoading}
      />

      <InteractiveLineChart
        points={activeSeries.graphPoints}
        color={chartColor}
        gradientFillColors={[
          gradientBackgroundColor,
          theme.dark ? 'transparent' : White,
        ]}
        isLoading={isChartLoading}
        enablePanGesture={!isChartLoading}
        SelectionDot={ChartSelectionDot}
        TopAxisLabel={MaxAxisLabel}
        BottomAxisLabel={MinAxisLabel}
        onGestureStart={onGestureStarted}
        onGestureEnd={onGestureEnded}
        onPointSelected={onPointSelected}
        onLongPress={() => copyDiagnosticsToClipboard(selectedTimeframe, 'chart')}
      />

      <TimeframeSelector
        options={FIAT_CHART_TIMEFRAMES.map(({label, value}) => ({
          label,
          value,
        }))}
        selected={selectedTimeframe}
        onLongPressOption={tf => copyDiagnosticsToClipboard(tf, 'selector')}
        onSelect={tf => {
          setSelectedPoint(undefined);
          onSelectedBalanceChangeRef.current?.(undefined);
          setSelectedTimeframe(tf);
        }}
      />
    </>
  );
};

export default BalanceHistoryChart;
