import React, {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  InteractionManager,
  StyleProp,
  View,
  ViewStyle,
} from 'react-native';
import {useTranslation} from 'react-i18next';
import {useTheme} from 'styled-components/native';
import type {GraphPoint} from 'react-native-graph';
import Animated, {
  type SharedValue,
  useAnimatedStyle,
} from 'react-native-reanimated';
import type {FiatRateSeriesCache, FiatRateInterval} from '../../store/rate/rate.models';
import type {Rates} from '../../store/rate/rate.models';
import type {BalanceSnapshot} from '../../store/portfolio/portfolio.models';
import type {Wallet} from '../../store/wallet/wallet.models';
import {FIAT_RATE_SERIES_TARGET_POINTS} from '../../store/rate/rate.models';
import {
  buildPnlAnalysisSeriesAsync,
  type PnlAnalysisPoint,
} from '../../utils/portfolio/core/pnl/analysis';
import {formatFiatAmount} from '../../utils/helper-methods';
import {
  getFiatChartTimeframeOptions,
  formatRangeOrSelectedPointLabel,
  getRangeLabelForFiatTimeframe,
  getSeriesIntervalForFiatTimeframe,
} from './fiatTimeframes';
import TimeframeSelector from './TimeframeSelector';
import InteractiveLineChart from './InteractiveLineChart';
import ChartAxisLabel from './ChartAxisLabel';
import ChartSelectionDot from './ChartSelectionDot';
import ChartChangeRow from './ChartChangeRow';
import {Action, LinkBlue, White} from '../../styles/colors';
import haptic from '../haptic-feedback/haptic';
import {
  buildPnlWalletInputsFromPortfolioSnapshotsAsync,
  buildPnlCurrentRatesByCoinFromWallets,
  type PnlWalletInputs,
} from '../../utils/portfolio/assets';
import {useAppDispatch, useAppSelector} from '../../utils/hooks';
import {fetchFiatRateSeriesInterval} from '../../store/wallet/effects';
import {normalizeFiatRateSeriesCoin} from '../../utils/portfolio/core/pnl/rates';
import {isNumberSharedValue} from './sharedValueGuards';
import {
  patchBalanceChartScopeLatestPoints,
  touchBalanceChartScope,
  upsertBalanceChartScopeTimeframes,
} from '../../store/portfolio-charts';
import type {CachedBalanceChartTimeframe} from '../../store/portfolio-charts';
import {
  buildBalanceChartScopeId,
  buildBalanceChartTimeframeRevision,
  buildHistoricalRateDependencyMetadataFromCache,
  buildLatestPointPatchMetadataFromAnalysis,
  buildSnapshotVersionSig,
  deserializeCachedTimeframeToComputedSeries,
  getCachedTimeframeStatus,
  getSortedUniqueWalletIds,
  patchCachedLatestPointWithSpotRates,
  serializeComputedSeriesToCachedTimeframe,
} from '../../utils/portfolio/chartCache';

const CHART_LOADER_DELAY_MS = 150;
const CHART_COMPUTE_YIELD_EVERY_POINTS = 4;
const PRECOMPUTE_TIMEFRAME_ORDER: FiatRateInterval[] = [
  '1D',
  '1W',
  '1M',
  'ALL',
  '3M',
  '1Y',
  '5Y',
];

type AnalysisInputs = PnlWalletInputs;

const EMPTY_ANALYSIS_INPUTS = (quoteCurrency: string): AnalysisInputs => ({
  wallets: [],
  currentRatesByCoin: {},
  quoteCurrency: (quoteCurrency || '').toUpperCase(),
});

type ComputedSeries = {
  graphPoints: GraphPoint[];
  analysisPoints: PnlAnalysisPoint[];
  pointByTimestamp: Map<number, PnlAnalysisPoint>;
  minIndex: number;
  maxIndex: number;
  minPoint: GraphPoint;
  maxPoint: GraphPoint;
};

type ScheduledAfterInteractionsHandle = {
  cancel: () => void;
};

const GRAPH_DRAWABLE_EPSILON = 0.0001;

const scheduleAfterInteractionsAndFrames = (
  cb: () => void | Promise<void>,
): ScheduledAfterInteractionsHandle => {
  let cancelled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let firstFrame: number | undefined;
  let secondFrame: number | undefined;

  const runCallback = () => {
    if (cancelled) {
      return;
    }

    timeout = setTimeout(() => {
      if (cancelled) {
        return;
      }

      try {
        const maybePromise = cb();
        if (
          maybePromise &&
          typeof (maybePromise as Promise<unknown>).catch === 'function'
        ) {
          (maybePromise as Promise<unknown>).catch(() => undefined);
        }
      } catch {
        // no-op
      }
    }, 0);
  };

  const task = InteractionManager.runAfterInteractions(() => {
    if (cancelled) {
      return;
    }

    if (typeof requestAnimationFrame === 'function') {
      firstFrame = requestAnimationFrame(() => {
        if (cancelled) {
          return;
        }

        secondFrame = requestAnimationFrame(runCallback);
      });
      return;
    }

    runCallback();
  });

  return {
    cancel: () => {
      cancelled = true;
      task.cancel();

      if (
        typeof firstFrame === 'number' &&
        typeof cancelAnimationFrame === 'function'
      ) {
        cancelAnimationFrame(firstFrame);
      }
      if (
        typeof secondFrame === 'number' &&
        typeof cancelAnimationFrame === 'function'
      ) {
        cancelAnimationFrame(secondFrame);
      }
      if (timeout) {
        clearTimeout(timeout);
      }
    },
  };
};

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
  lineColor?: string;
  lineThickness?: number;
  /**
   * Optional scale applied by an ancestor transform. When provided, chart
   * strokes (and guide line dash pattern) will be compensated so they remain
   * visually constant under scaling.
   */
  strokeScale?: number | SharedValue<number> | Readonly<SharedValue<number>>;
  /**
   * Optional lower bound for `strokeScale`. When provided, the chart can
   * reserve enough static path padding up-front to avoid edge clipping at the
   * smallest collapse scale.
   */
  minStrokeScale?: number;
  gradientStartColor?: string;
  showLoaderWhenNoSnapshots?: boolean;
  /**
   * Optional constant offset to add to rendered balance points.
   * Useful when a portion of the displayed balance cannot be historized.
   */
  balanceOffset?: number;
  onSelectedBalanceChange?: (balance?: number) => void;
  /**
   * Optional content rendered between the PnL change row and the line chart.
   */
  preChartContent?: React.ReactNode;
  /**
   * Optional top spacing for preChartContent. Defaults to 22.
   */
  preChartContentTopMargin?: number;
  /**
   * Optional style override for the PnL change row container.
   */
  changeRowStyle?: StyleProp<ViewStyle>;
  /**
   * Whether to render the top PnL change row. Defaults to true.
   */
  showChangeRow?: boolean;
  /**
   * Whether to render the timeframe selector row. Defaults to true.
   */
  showTimeframeSelector?: boolean;
  /**
   * Optional opacity for the timeframe selector row.
   */
  timeframeSelectorOpacity?:
    | number
    | SharedValue<number>
    | Readonly<SharedValue<number>>;
  /**
   * Disable chart scrubbing interactions.
   */
  disablePanGesture?: boolean;
  /**
   * Optional callback with computed change-row values.
   */
  onChangeRowData?: (data: {
    percent: number;
    deltaFiatFormatted?: string;
    rangeLabel?: string;
    isLoading?: boolean;
  }) => void;
  /**
   * Optional opacity for min/max axis labels.
   */
  axisLabelOpacity?:
    | number
    | SharedValue<number>
    | Readonly<SharedValue<number>>;
};

const BalanceHistoryChart = ({
  wallets,
  snapshotsByWalletId,
  quoteCurrency,
  rates,
  fiatRateSeriesCache,
  lineColor,
  lineThickness,
  strokeScale,
  minStrokeScale,
  gradientStartColor,
  showLoaderWhenNoSnapshots = false,
  balanceOffset = 0,
  onSelectedBalanceChange,
  preChartContent,
  preChartContentTopMargin = 22,
  changeRowStyle,
  showChangeRow = true,
  showTimeframeSelector = true,
  timeframeSelectorOpacity = 1,
  disablePanGesture = false,
  onChangeRowData,
  axisLabelOpacity = 1,
}: BalanceHistoryChartProps): React.ReactElement | null => {
  const {t} = useTranslation();
  const theme = useTheme();
  const dispatch = useAppDispatch();

  const [selectedTimeframe, setSelectedTimeframe] =
    useState<FiatRateInterval>('ALL');

  const [seriesByTimeframe, setSeriesByTimeframe] = useState<
    Partial<Record<FiatRateInterval, ComputedSeries>>
  >({});
  const [seriesRevisionByTimeframe, setSeriesRevisionByTimeframe] = useState<
    Partial<Record<FiatRateInterval, string>>
  >({});

  const [isComputingByTimeframe, setIsComputingByTimeframe] = useState<
    Partial<Record<FiatRateInterval, boolean>>
  >({});
  const [analysisInputs, setAnalysisInputs] = useState<AnalysisInputs>(() => ({
    ...EMPTY_ANALYSIS_INPUTS(quoteCurrency),
  }));
  const [analysisInputsReadyKey, setAnalysisInputsReadyKey] = useState<
    string | undefined
  >(undefined);

  const [lastAttemptRevisionByTimeframe, setLastAttemptRevisionByTimeframe] =
    useState<Partial<Record<FiatRateInterval, string>>>({});

  const [lastErrorByTimeframe, setLastErrorByTimeframe] = useState<
    Partial<Record<FiatRateInterval, string>>
  >({});

  const [displayState, setDisplayState] = useState<
    | {
        series: ComputedSeries;
        timeframe: FiatRateInterval;
      }
    | undefined
  >(
    undefined,
  );

  const enqueueComputeRef = useRef<FiatRateInterval[]>([]);
  const computingQueueRef = useRef(false);
  const computeGenerationRef = useRef(0);
  const scheduledHandlesRef = useRef<Set<ScheduledAfterInteractionsHandle>>(
    new Set(),
  );

  const [selectedPoint, setSelectedPoint] = useState<GraphPoint | undefined>();

  const cancelAllScheduledWork = useCallback(() => {
    for (const handle of scheduledHandlesRef.current) {
      handle.cancel();
    }
    scheduledHandlesRef.current.clear();
  }, []);

  const trackScheduledHandle = useCallback(
    (handle: ScheduledAfterInteractionsHandle) => {
      scheduledHandlesRef.current.add(handle);
    },
    [],
  );

  const removeScheduledHandle = useCallback(
    (handle: ScheduledAfterInteractionsHandle | undefined, cancel = false) => {
      if (!handle) {
        return;
      }

      scheduledHandlesRef.current.delete(handle);
      if (cancel) {
        handle.cancel();
      }
    },
    [],
  );

  const invalidateComputeGeneration = useCallback(() => {
    computeGenerationRef.current += 1;
    cancelAllScheduledWork();
    enqueueComputeRef.current = [];
    computingQueueRef.current = false;
  }, [cancelAllScheduledWork]);

  // NOTE: Some call sites may pass inline callbacks. Avoid re-running effects
  // (and thus triggering render loops) when the callback identity changes.
  const onSelectedBalanceChangeRef = useRef(onSelectedBalanceChange);
  useEffect(() => {
    onSelectedBalanceChangeRef.current = onSelectedBalanceChange;
  }, [onSelectedBalanceChange]);

  useEffect(() => {
    return () => {
      invalidateComputeGeneration();
    };
  }, [invalidateComputeGeneration]);

  const gestureStarted = useRef(false);
  const lastHapticPointTsRef = useRef<number | undefined>(undefined);
  const analysisHistoricalDepKeysRef = useRef<Set<string>>(new Set());
  const lastTouchedScopeIdRef = useRef<string | undefined>(undefined);
  const [hasCompletedInitialAllLoad, setHasCompletedInitialAllLoad] =
    useState(false);

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

  const totalSnapshotCount = useMemo(() => {
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
    }

    return totalCount;
  }, [snapshotsByWalletId, wallets]);

  const hasAnySnapshots = totalSnapshotCount > 0;
  const analysisInputsReadyKeyRef = useRef<string | undefined>(undefined);

  const sortedWalletIds = useMemo(() => {
    return getSortedUniqueWalletIds(
      (wallets || []).map(w => String((w as any)?.id || '')),
    );
  }, [wallets]);

  const scopeId = useMemo(() => {
    return buildBalanceChartScopeId({
      walletIds: sortedWalletIds,
      quoteCurrency,
      balanceOffset,
    });
  }, [balanceOffset, quoteCurrency, sortedWalletIds]);

  const snapshotVersionSig = useAppSelector(state => {
    return buildSnapshotVersionSig({
      walletIds: sortedWalletIds,
      walletSnapshotVersionById:
        state.PORTFOLIO_CHARTS.walletSnapshotVersionById || {},
    });
  });

  const cachedScope = useAppSelector(
    state => state.PORTFOLIO_CHARTS.cacheByScopeId[scopeId],
  );

  const currentSpotRatesByCoin = useMemo(() => {
    return buildPnlCurrentRatesByCoinFromWallets({
      wallets: wallets || [],
      quoteCurrency,
      rates,
    });
  }, [quoteCurrency, rates, wallets]);

  const currentRatesRevision = useMemo(() => {
    return Object.entries(currentSpotRatesByCoin || {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([coin, rate]) => `${coin}:${rate}`)
      .join('|');
  }, [currentSpotRatesByCoin]);

  const selectedSeriesInterval = useMemo(() => {
    return getSeriesIntervalForFiatTimeframe(selectedTimeframe);
  }, [selectedTimeframe]);

  const fiatChartTimeframeOptions = useMemo(
    () => getFiatChartTimeframeOptions(t),
    [t],
  );

  const analysisInputsBaseKey = useMemo(
    () => `${scopeId}|${snapshotVersionSig}`,
    [scopeId, snapshotVersionSig],
  );

  const rateFetchAssets = useMemo(() => {
    const assets: Array<{
      coinForCacheCheck: string;
      chain?: string;
      tokenAddress?: string;
    }> = [];
    const seen = new Set<string>();

    for (const w of wallets || []) {
      const coinForCacheCheck = normalizeFiatRateSeriesCoin(
        (w as any)?.currencyAbbreviation || '',
      );
      if (!coinForCacheCheck) {
        continue;
      }

      const chainRaw =
        typeof (w as any)?.chain === 'string' ? (w as any).chain : '';
      const chain = chainRaw ? chainRaw.toLowerCase() : undefined;
      const tokenAddressRaw =
        typeof (w as any)?.tokenAddress === 'string'
          ? (w as any).tokenAddress
          : '';
      const tokenAddress = tokenAddressRaw
        ? tokenAddressRaw.toLowerCase()
        : undefined;
      const dedupeKey = `${coinForCacheCheck}|${chain || ''}|${
        tokenAddress || ''
      }`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);

      assets.push({
        coinForCacheCheck,
        chain: tokenAddress ? chain : undefined,
        tokenAddress,
      });
    }

    return assets;
  }, [wallets]);

  useEffect(() => {
    if (!hasAnySnapshots || !quoteCurrency || !rateFetchAssets.length) {
      return;
    }

    for (const asset of rateFetchAssets) {
      dispatch(
        fetchFiatRateSeriesInterval({
          fiatCode: quoteCurrency,
          interval: selectedSeriesInterval,
          coinForCacheCheck: asset.coinForCacheCheck,
          chain: asset.chain,
          tokenAddress: asset.tokenAddress,
        }) as any,
      );
    }
  }, [
    dispatch,
    hasAnySnapshots,
    quoteCurrency,
    rateFetchAssets,
    selectedSeriesInterval,
  ]);

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

  const getTimeframeRevision = useCallback(
    (
      timeframe: FiatRateInterval,
      historicalRateDeps =
        cachedScope?.timeframes?.[timeframe]?.historicalRateDeps || [],
    ) => {
      return buildBalanceChartTimeframeRevision({
        scopeId,
        timeframe,
        snapshotVersionSig,
        historicalRateDeps,
        currentSpotRatesByCoin,
      });
    },
    [cachedScope?.timeframes, currentSpotRatesByCoin, scopeId, snapshotVersionSig],
  );

  const getTimeframeAttemptRevision = useCallback(
    (timeframe: FiatRateInterval) => {
      return [analysisInputsBaseKey, currentRatesRevision, cacheRevision, timeframe].join(
        '|',
      );
    },
    [analysisInputsBaseKey, cacheRevision, currentRatesRevision],
  );

  const cachedTimeframeStatusByTimeframe = useMemo(() => {
    const next: Partial<Record<FiatRateInterval, 'fresh' | 'patchable' | 'stale_historical' | 'missing'>> = {};

    for (const timeframe of PRECOMPUTE_TIMEFRAME_ORDER) {
      next[timeframe] = getCachedTimeframeStatus({
        cachedTimeframe: cachedScope?.timeframes?.[timeframe],
        snapshotVersionSig,
        currentSpotRatesByCoin,
        fiatRateSeriesCache,
      });
    }

    return next;
  }, [cachedScope?.timeframes, currentSpotRatesByCoin, fiatRateSeriesCache, snapshotVersionSig]);

  const selectedTimeframeNeedsHistoricalRecompute = useMemo(() => {
    const status = cachedTimeframeStatusByTimeframe[selectedTimeframe] || 'missing';
    return status === 'missing' || status === 'stale_historical';
  }, [cachedTimeframeStatusByTimeframe, selectedTimeframe]);

  const hasAnyBackgroundHistoricalRecomputeNeeded = useMemo(() => {
    return PRECOMPUTE_TIMEFRAME_ORDER.some(timeframe => {
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
      (hasCompletedInitialAllLoad && hasAnyBackgroundHistoricalRecomputeNeeded));

  useEffect(() => {
    analysisInputsReadyKeyRef.current = analysisInputsReadyKey;
  }, [analysisInputsReadyKey]);

  useEffect(() => {
    if (!cachedScope) {
      return;
    }
    if (lastTouchedScopeIdRef.current === scopeId) {
      return;
    }

    lastTouchedScopeIdRef.current = scopeId;
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
    const nextSeriesByTimeframe: Partial<Record<FiatRateInterval, ComputedSeries>> =
      {};
    const nextSeriesRevisionByTimeframe: Partial<Record<FiatRateInterval, string>> =
      {};

    for (const timeframe of PRECOMPUTE_TIMEFRAME_ORDER) {
      const cachedTimeframe = cachedScope.timeframes?.[timeframe];
      if (!cachedTimeframe) {
        continue;
      }

      const status = cachedTimeframeStatusByTimeframe[timeframe] || 'missing';
      const effectiveCachedTimeframe =
        status === 'patchable'
          ? patchCachedLatestPointWithSpotRates({
              cachedTimeframe,
              currentSpotRatesByCoin,
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

      const selectedHydratedSeries = nextSeriesByTimeframe[selectedTimeframe];
      if (selectedHydratedSeries) {
        setDisplayState(prev =>
          prev?.series === selectedHydratedSeries &&
          prev?.timeframe === selectedTimeframe
            ? prev
            : {
                series: selectedHydratedSeries,
                timeframe: selectedTimeframe,
              },
        );
      }
    });

    if (patchedTimeframes.length) {
      dispatch(
        patchBalanceChartScopeLatestPoints({
          scopeId,
          timeframes: patchedTimeframes,
        }),
      );
    }
  }, [
    cachedScope,
    cachedTimeframeStatusByTimeframe,
    currentSpotRatesByCoin,
    dispatch,
    getTimeframeRevision,
    scopeId,
    selectedTimeframe,
  ]);

  useEffect(() => {
    invalidateComputeGeneration();
    setIsComputingByTimeframe({});
  }, [analysisInputsBaseKey, cacheRevision, currentRatesRevision, invalidateComputeGeneration]);

  useEffect(() => {
    let cancelled = false;
    let prepareHandle: ScheduledAfterInteractionsHandle | undefined;
    const shouldResetPreparedInputs =
      analysisInputsReadyKeyRef.current !== analysisInputsBaseKey;

    if (!hasAnySnapshots || !shouldPrepareAnalysisInputs) {
      setAnalysisInputs(EMPTY_ANALYSIS_INPUTS(quoteCurrency));
      analysisHistoricalDepKeysRef.current = new Set();
      analysisInputsReadyKeyRef.current = undefined;
      setAnalysisInputsReadyKey(undefined);
      return;
    }

    if (shouldResetPreparedInputs) {
      setAnalysisInputs(EMPTY_ANALYSIS_INPUTS(quoteCurrency));
      analysisInputsReadyKeyRef.current = undefined;
      setAnalysisInputsReadyKey(undefined);
    }

    const generation = computeGenerationRef.current;
    prepareHandle = scheduleAfterInteractionsAndFrames(async () => {
      const historicalDepKeys = new Set<string>();
      const prepared = await buildPnlWalletInputsFromPortfolioSnapshotsAsync(
        {
          snapshotsByWalletId: snapshotsByWalletId || {},
          wallets: wallets || [],
          quoteCurrency,
          rates,
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
      analysisHistoricalDepKeysRef.current = historicalDepKeys;
      analysisInputsReadyKeyRef.current = nextReadyKey;
      startTransition(() => {
        setAnalysisInputs(prev =>
          computeGenerationRef.current === generation ? prepared : prev,
        );
        setAnalysisInputsReadyKey(prev =>
          computeGenerationRef.current === generation ? nextReadyKey : prev,
        );
      });
    });
    trackScheduledHandle(prepareHandle);

    return () => {
      cancelled = true;
      removeScheduledHandle(prepareHandle, true);
    };
  }, [
    fiatRateSeriesCache,
    hasAnySnapshots,
    analysisInputsBaseKey,
    quoteCurrency,
    rates,
    shouldPrepareAnalysisInputs,
    snapshotsByWalletId,
    snapshotsSig,
    trackScheduledHandle,
    removeScheduledHandle,
    wallets,
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
          timeframe: timeframe as any,
          quoteCurrency: analysisInputs.quoteCurrency,
          fiatRateSeriesCache: fiatRateSeriesCache as any,
          currentRatesByCoin:
            Object.keys(currentSpotRatesByCoin || {}).length > 0
              ? currentSpotRatesByCoin
              : undefined,
          nowMs: targetNowMs,
          maxPoints: FIAT_RATE_SERIES_TARGET_POINTS,
          yieldEveryPoints: CHART_COMPUTE_YIELD_EVERY_POINTS,
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
        const fallbackNowMs = getLatestFiatRateSeriesPointTs(fiatRateSeriesCache);
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
      const pointByTimestamp = new Map<number, PnlAnalysisPoint>();
      for (let i = 0; i < graphPoints.length; i++) {
        pointByTimestamp.set(graphPoints[i].date.getTime(), analysisPoints[i]);
      }

      const {minIndex, maxIndex, minPoint, maxPoint} = computeMinMax(graphPoints);

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

    computingQueueRef.current = true;

    const runNext = () => {
      const next = enqueueComputeRef.current.shift();
      if (!next) {
        computingQueueRef.current = false;
        return;
      }

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

      let computeHandle: ScheduledAfterInteractionsHandle | undefined;
      computeHandle = scheduleAfterInteractionsAndFrames(async () => {
        removeScheduledHandle(computeHandle);

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
            if (next === selectedTimeframe) {
              setDisplayState(prev =>
                prev?.series === computed.series && prev?.timeframe === next
                  ? prev
                  : {
                      series: computed.series,
                      timeframe: next,
                    },
              );
            }
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

          const msg =
            e instanceof Error
              ? e.message
              : typeof e === 'string'
              ? e
              : JSON.stringify(e);
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
      });
      trackScheduledHandle(computeHandle);
    };

    runNext();
  }, [
    balanceOffset,
    computeSeriesForTimeframe,
    dispatch,
    getTimeframeAttemptRevision,
    getTimeframeRevision,
    removeScheduledHandle,
    scopeId,
    selectedTimeframe,
    sortedWalletIds,
    trackScheduledHandle,
  ]);

  const ensureTimeframeComputed = useCallback(
    (tf: FiatRateInterval, options?: {prioritize?: boolean}) => {
      const cachedStatus = cachedTimeframeStatusByTimeframe[tf] || 'missing';
      const timeframeRevision = getTimeframeRevision(tf);
      const attemptRevision = getTimeframeAttemptRevision(tf);

      if (cachedStatus === 'fresh' || cachedStatus === 'patchable') {
        return;
      }

      if (
        seriesByTimeframe[tf] &&
        seriesRevisionByTimeframe[tf] === timeframeRevision
      ) {
        return;
      }
      if (
        seriesByTimeframe[tf] &&
        lastAttemptRevisionByTimeframe[tf] === attemptRevision &&
        !lastErrorByTimeframe[tf]
      ) {
        return;
      }
      if (
        isComputingByTimeframe[tf] &&
        lastAttemptRevisionByTimeframe[tf] === attemptRevision
      ) {
        return;
      }
      if (!hasAnySnapshots) {
        return;
      }
      if (!inputsReady) {
        return;
      }
      // Avoid retry loops: only attempt again when the compute inputs change.
      if (lastAttemptRevisionByTimeframe[tf] === attemptRevision) {
        return;
      }
      enqueueTimeframeCompute(tf, !!options?.prioritize);
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

  // Reset only when the chart scope changes (wallet set / quote / balance offset).
  useEffect(() => {
    invalidateComputeGeneration();
    analysisHistoricalDepKeysRef.current = new Set();
    lastTouchedScopeIdRef.current = undefined;
    analysisInputsReadyKeyRef.current = undefined;
    setAnalysisInputs(EMPTY_ANALYSIS_INPUTS(quoteCurrency));
    setAnalysisInputsReadyKey(undefined);
    setHasCompletedInitialAllLoad(false);
    setSeriesByTimeframe({});
    setSeriesRevisionByTimeframe({});
    setIsComputingByTimeframe({});
    setLastAttemptRevisionByTimeframe({});
    setLastErrorByTimeframe({});
    setSelectedPoint(undefined);
    onSelectedBalanceChangeRef.current?.(undefined);

    setDisplayState(undefined);
  }, [invalidateComputeGeneration, quoteCurrency, scopeId]);

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

  // Opportunistically precompute additional timeframes in background so taps
  // switch instantly more often and avoid heavy foreground work.
  useEffect(() => {
    if (!inputsReady || !hasAnySnapshots) {
      return;
    }
    if (!hasCompletedInitialAllLoad) {
      return;
    }

    const nextToPrecompute = PRECOMPUTE_TIMEFRAME_ORDER.find(tf => {
      const cachedStatus = cachedTimeframeStatusByTimeframe[tf] || 'missing';
      const timeframeRevision = getTimeframeRevision(tf);
      const attemptRevision = getTimeframeAttemptRevision(tf);

      if (tf === selectedTimeframe) {
        return false;
      }
      if (cachedStatus === 'fresh' || cachedStatus === 'patchable') {
        return false;
      }
      if (
        seriesByTimeframe[tf] &&
        seriesRevisionByTimeframe[tf] === timeframeRevision
      ) {
        return false;
      }
      if (
        seriesByTimeframe[tf] &&
        lastAttemptRevisionByTimeframe[tf] === attemptRevision &&
        !lastErrorByTimeframe[tf]
      ) {
        return false;
      }
      if (
        isComputingByTimeframe[tf] &&
        lastAttemptRevisionByTimeframe[tf] === attemptRevision
      ) {
        return false;
      }
      if (lastAttemptRevisionByTimeframe[tf] === attemptRevision) {
        return false;
      }
      return true;
    });

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
    hasCompletedInitialAllLoad,
    inputsReady,
    isComputingByTimeframe,
    lastErrorByTimeframe,
    lastAttemptRevisionByTimeframe,
    processQueue,
    selectedTimeframe,
    seriesRevisionByTimeframe,
    seriesByTimeframe,
  ]);

  const selectedTimeframeRevision = getTimeframeRevision(selectedTimeframe);
  const selectedTimeframeAttemptRevision = getTimeframeAttemptRevision(
    selectedTimeframe,
  );
  const selectedComputedSeries = useMemo(() => {
    if (
      seriesRevisionByTimeframe[selectedTimeframe] === selectedTimeframeRevision
    ) {
      return seriesByTimeframe[selectedTimeframe];
    }

    if (
      seriesByTimeframe[selectedTimeframe] &&
      lastAttemptRevisionByTimeframe[selectedTimeframe] ===
        selectedTimeframeAttemptRevision &&
      !lastErrorByTimeframe[selectedTimeframe]
    ) {
      return seriesByTimeframe[selectedTimeframe];
    }

    return undefined;
  }, [
    lastAttemptRevisionByTimeframe,
    lastErrorByTimeframe,
    selectedTimeframe,
    selectedTimeframeAttemptRevision,
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

  // Swap in the computed series once available.
  useEffect(() => {
    if (!selectedComputedSeries) {
      return;
    }

    startTransition(() => {
      setDisplayState(prev =>
        prev?.series === selectedComputedSeries &&
        prev?.timeframe === selectedTimeframe
          ? prev
          : {
              series: selectedComputedSeries,
              timeframe: selectedTimeframe,
            },
      );
    });
  }, [selectedComputedSeries, selectedTimeframe]);

  const rangeLabel = useMemo(
    () => getRangeLabelForFiatTimeframe(t, displayedTimeframe),
    [displayedTimeframe, t],
  );

  const rangeOrSelectedPointLabel = useMemo(() => {
    return formatRangeOrSelectedPointLabel({
      rangeLabel,
      selectedTimeframe: displayedTimeframe,
      selectedDate: selectedPoint?.date,
    });
  }, [displayedTimeframe, rangeLabel, selectedPoint?.date]);

  const timeframeSelectorOpacityIsSharedValue = isNumberSharedValue(
    timeframeSelectorOpacity,
  );
  const sharedTimeframeSelectorOpacity = timeframeSelectorOpacityIsSharedValue
    ? timeframeSelectorOpacity
    : undefined;

  const timeframeSelectorOpacityNumber =
    typeof timeframeSelectorOpacity === 'number'
      ? timeframeSelectorOpacity
      : 1;

  const timeframeSelectorAnimatedStyle = useAnimatedStyle(() => {
    return {
      opacity: sharedTimeframeSelectorOpacity
        ? sharedTimeframeSelectorOpacity.value
        : timeframeSelectorOpacityNumber,
    };
  }, [sharedTimeframeSelectorOpacity, timeframeSelectorOpacityNumber]);

  // Only show the loader when the selected timeframe does not have a computed
  // series yet. If we already have selected-timeframe data, keep it visible at
  // full opacity even if background refresh/recompute work is still happening.
  const hasRenderableSelectedSeries =
    !!selectedComputedSeries ||
    (displayState?.timeframe === selectedTimeframe && !!displayState?.series);
  const isSelectedTimeframePending =
    !hasRenderableSelectedSeries && !selectedTimeframeError;
  const isChartLoadingRaw = hasAnySnapshots && isSelectedTimeframePending;
  const [isChartLoaderVisible, setIsChartLoaderVisible] = useState(false);

  useEffect(() => {
    if (!isChartLoadingRaw) {
      setIsChartLoaderVisible(false);
      if (!hasCompletedInitialAllLoad && selectedTimeframe === 'ALL') {
        setHasCompletedInitialAllLoad(true);
      }
      return;
    }

    const isInitialAllLoad = selectedTimeframe === 'ALL' && !hasCompletedInitialAllLoad;
    if (isInitialAllLoad) {
      setIsChartLoaderVisible(true);
      return;
    }

    setIsChartLoaderVisible(false);
    const timer = setTimeout(() => {
      setIsChartLoaderVisible(true);
    }, CHART_LOADER_DELAY_MS);

    return () => clearTimeout(timer);
  }, [hasCompletedInitialAllLoad, isChartLoadingRaw, selectedTimeframe]);

  const hideGuideLineForInitialAllLoader =
    selectedTimeframe === 'ALL' && !hasCompletedInitialAllLoad && isChartLoaderVisible;

  const hasAnyRenderableSeries =
    !!activeSeries ||
    Object.values(seriesByTimeframe).some(series => !!series?.graphPoints.length);

  // Axis label renderers are passed to `react-native-graph` as *component
  // types*. If we recreate them on every render (e.g. via useCallback deps),
  // React treats them as new component types and will unmount/remount the
  // labels. That resets internal measurement/animation state and can manifest
  // as a jarring "jump" to a clamped edge before the label slides to its next
  // position.
  //
  // Keep a stable component identity and read the latest values from refs.
  const activeSeriesRef = useRef(activeSeries);
  activeSeriesRef.current = activeSeries;
  const axisLabelOpacityRef = useRef(axisLabelOpacity);
  axisLabelOpacityRef.current = axisLabelOpacity;
  const quoteCurrencyRef = useRef(quoteCurrency);
  quoteCurrencyRef.current = quoteCurrency;

  const selectedAnalysisPoint = useMemo(() => {
    if (!selectedPoint || !activeSeries) {
      return undefined;
    }
    const ts = selectedPoint.date.getTime();
    return activeSeries.pointByTimestamp.get(ts);
  }, [activeSeries, selectedPoint]);

  const lastAnalysisPoint = useMemo(() => {
    const pts = activeSeries?.analysisPoints || [];
    return pts.length ? pts[pts.length - 1] : undefined;
  }, [activeSeries]);

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

  useEffect(() => {
    onChangeRowData?.({
      percent: pnlPercent,
      deltaFiatFormatted: formattedDeltaFiat,
      rangeLabel: rangeOrSelectedPointLabel,
      isLoading: isChartLoaderVisible,
    });
  }, [
    formattedDeltaFiat,
    isChartLoaderVisible,
    onChangeRowData,
    pnlPercent,
    rangeOrSelectedPointLabel,
  ]);

  const onGestureStarted = useCallback(() => {
    gestureStarted.current = true;
    lastHapticPointTsRef.current = undefined;
  }, []);

  const onGestureEnded = useCallback(() => {
    haptic('impactLight');
    gestureStarted.current = false;
    lastHapticPointTsRef.current = undefined;
    setSelectedPoint(undefined);
    onSelectedBalanceChangeRef.current?.(undefined);
  }, []);

  const onPointSelected = useCallback(
    (p: GraphPoint) => {
      if (!gestureStarted.current || !activeSeries) {
        return;
      }
      setSelectedPoint(p);
      const pointTs = p.date.getTime();
      if (lastHapticPointTsRef.current !== pointTs) {
        haptic('impactLight');
        lastHapticPointTsRef.current = pointTs;
      }
      const ap = activeSeries.pointByTimestamp.get(p.date.getTime());
      const actualBalance =
        typeof ap?.totalFiatBalance === 'number'
          ? ap.totalFiatBalance + balanceOffset
          : p.value;
      onSelectedBalanceChangeRef.current?.(actualBalance);
    },
    [activeSeries, balanceOffset],
  );

  // Axis labels smoothly animate between x positions as the timeframe changes.
  // IMPORTANT: these must be stable component identities (see refs above).
  const MaxAxisLabel = useCallback(() => {
    const series = activeSeriesRef.current;
    if (!series?.graphPoints.length) {
      return null;
    }

    return (
      <ChartAxisLabel
        value={series.maxPoint.value}
        index={series.maxIndex}
        arrayLength={series.graphPoints.length}
        quoteCurrency={quoteCurrencyRef.current}
        currencyAbbreviation={undefined}
        type="max"
        contentOpacity={axisLabelOpacityRef.current}
      />
    );
  }, []);

  const MinAxisLabel = useCallback(() => {
    const series = activeSeriesRef.current;
    if (!series?.graphPoints.length) {
      return null;
    }

    return (
      <ChartAxisLabel
        value={series.minPoint.value}
        index={series.minIndex}
        arrayLength={series.graphPoints.length}
        quoteCurrency={quoteCurrencyRef.current}
        currencyAbbreviation={undefined}
        type="min"
        contentOpacity={axisLabelOpacityRef.current}
      />
    );
  }, []);

  const chartColor = lineColor || (theme.dark ? LinkBlue : Action);
  const gradientBackgroundColor =
    gradientStartColor || (theme.dark ? 'transparent' : White);

  // If there are no snapshots, hide chart UI but still allow callers to render
  // any pre-chart badges/content.
  if (!hasAnySnapshots) {
    if (showLoaderWhenNoSnapshots) {
      return (
        <>
          {preChartContent ? (
            <View style={{marginTop: preChartContentTopMargin}}>
              {preChartContent}
            </View>
          ) : null}
          <InteractiveLineChart
            points={displayState?.series.graphPoints || []}
            color={chartColor}
            lineThickness={lineThickness}
            strokeScale={strokeScale}
            minStrokeScale={minStrokeScale}
            gradientFillColors={[
              gradientBackgroundColor,
              theme.dark ? 'transparent' : White,
            ]}
            isLoading
            hideLineWhileLoading
            enablePanGesture={false}
          />
        </>
      );
    }

    return preChartContent ? (
      <View style={{marginTop: preChartContentTopMargin}}>{preChartContent}</View>
    ) : null;
  }

  return (
    <>
      {showChangeRow ? (
        <ChartChangeRow
          percent={pnlPercent}
          deltaFiatFormatted={formattedDeltaFiat}
          rangeLabel={rangeOrSelectedPointLabel}
          isLoading={isChartLoaderVisible}
          style={changeRowStyle}
        />
      ) : null}
      {preChartContent ? (
        <View style={{marginTop: preChartContentTopMargin}}>{preChartContent}</View>
      ) : null}

      <InteractiveLineChart
        points={activeSeries?.graphPoints || []}
        color={chartColor}
        lineThickness={lineThickness}
        strokeScale={strokeScale}
        minStrokeScale={minStrokeScale}
        gradientFillColors={[
          gradientBackgroundColor,
          theme.dark ? 'transparent' : White,
        ]}
        showFirstPointGuideLine={!hideGuideLineForInitialAllLoader}
        isLoading={isChartLoaderVisible}
        hideLineWhileLoading={!hasAnyRenderableSeries}
        enablePanGesture={!isChartLoadingRaw && !disablePanGesture}
        SelectionDot={ChartSelectionDot}
        TopAxisLabel={MaxAxisLabel}
        BottomAxisLabel={MinAxisLabel}
        onGestureStart={onGestureStarted}
        onGestureEnd={onGestureEnded}
        onPointSelected={onPointSelected}
      />

      {showTimeframeSelector ? (
        <Animated.View style={timeframeSelectorAnimatedStyle}>
          <TimeframeSelector
            options={fiatChartTimeframeOptions}
            selected={selectedTimeframe}
            onSelect={tf => {
              setSelectedPoint(undefined);
              onSelectedBalanceChangeRef.current?.(undefined);
              setSelectedTimeframe(tf);
            }}
          />
        </Animated.View>
      ) : null}
    </>
  );
};

export default BalanceHistoryChart;
