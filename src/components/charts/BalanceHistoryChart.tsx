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
  type LayoutChangeEvent,
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
import useBalanceChartChangeRow from './useBalanceChartChangeRow';
import useBalanceChartLoaderState from './useBalanceChartLoaderState';
import {Action, LinkBlue, White} from '../../styles/colors';
import haptic from '../haptic-feedback/haptic';
import {
  buildPnlWalletInputsFromPortfolioSnapshotsAsync,
  buildPnlCurrentRatesByAssetKeyFromWallets,
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
  normalizeGraphPointsForChart,
  patchCachedLatestPointWithSpotRates,
  recomputeMinMaxFromGraphPoints,
  serializeComputedSeriesToCachedTimeframe,
} from '../../utils/portfolio/chartCache';

const CHART_COMPUTE_YIELD_EVERY_POINTS = 4;
const SCHEDULE_AFTER_INTERACTIONS_FALLBACK_MS = 700;
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

const scheduleAfterInteractionsAndFrames = (
  cb: () => void | Promise<void>,
): ScheduledAfterInteractionsHandle => {
  let cancelled = false;
  let didRun = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let fallbackTimeout: ReturnType<typeof setTimeout> | undefined;
  let firstFrame: number | undefined;
  let secondFrame: number | undefined;

  const clearScheduledTimers = () => {
    if (fallbackTimeout) {
      clearTimeout(fallbackTimeout);
      fallbackTimeout = undefined;
    }
    if (timeout) {
      clearTimeout(timeout);
      timeout = undefined;
    }
  };

  const runCallback = () => {
    if (cancelled || didRun) {
      return;
    }

    didRun = true;
    clearScheduledTimers();

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
    if (cancelled || didRun) {
      return;
    }

    if (typeof requestAnimationFrame === 'function') {
      firstFrame = requestAnimationFrame(() => {
        if (cancelled || didRun) {
          return;
        }

        secondFrame = requestAnimationFrame(runCallback);
      });
      return;
    }

    runCallback();
  });

  // Some navigation/layout transitions can leave runAfterInteractions pending
  // longer than expected. Fall back to running the work anyway so the chart
  // queue cannot remain stuck forever for a new scope.
  fallbackTimeout = setTimeout(
    runCallback,
    SCHEDULE_AFTER_INTERACTIONS_FALLBACK_MS,
  );

  return {
    cancel: () => {
      cancelled = true;
      task.cancel();
      clearScheduledTimers();

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
    },
  };
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

export type BalanceHistoryChartProps = {
  wallets: Wallet[];
  snapshotsByWalletId: {[walletId: string]: BalanceSnapshot[] | undefined};
  quoteCurrency: string;
  initialSelectedTimeframe?: FiatRateInterval;
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
  onSelectedTimeframeChange?: (timeframe: FiatRateInterval) => void;
};

const BalanceHistoryChart = ({
  wallets,
  snapshotsByWalletId,
  quoteCurrency,
  initialSelectedTimeframe = 'ALL',
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
  onSelectedTimeframeChange,
}: BalanceHistoryChartProps): React.ReactElement | null => {
  const {t, i18n} = useTranslation();
  const theme = useTheme();
  const dispatch = useAppDispatch();

  const [selectedTimeframe, setSelectedTimeframe] =
    useState<FiatRateInterval>(initialSelectedTimeframe);

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
  const [chartWidth, setChartWidth] = useState<number | undefined>(undefined);
  const chartWidthRef = useRef<number | undefined>(chartWidth);
  chartWidthRef.current = chartWidth;

  const handleChartLayout = useCallback((event: LayoutChangeEvent) => {
    const nextWidth = event.nativeEvent.layout.width;
    if (!Number.isFinite(nextWidth) || nextWidth <= 0) {
      return;
    }

    setChartWidth(prev =>
      typeof prev === 'number' && Math.abs(prev - nextWidth) < 0.5
        ? prev
        : nextWidth,
    );
  }, []);

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

  const logScheduledWorkError = useCallback(
    (label: string, error: unknown) => {
      if (!__DEV__) {
        return;
      }

      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
          ? error
          : JSON.stringify(error);

      console.warn(
        `[BalanceHistoryChart] ${label} failed for scope ${scopeIdRef.current}: ${message}`,
      );
    },
    [],
  );

  const scheduleTrackedWork = useCallback(
    (
      label: string,
      work: () => void | Promise<void>,
    ): ScheduledAfterInteractionsHandle => {
      let handle: ScheduledAfterInteractionsHandle | undefined;

      handle = scheduleAfterInteractionsAndFrames(async () => {
        removeScheduledHandle(handle);

        try {
          await work();
        } catch (error) {
          logScheduledWorkError(label, error);
        }
      });

      trackScheduledHandle(handle);
      return handle;
    },
    [logScheduledWorkError, removeScheduledHandle, trackScheduledHandle],
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
  const scopeIdRef = useRef<string>('');
  const [hasCompletedInitialSelectedTimeframeLoad, setHasCompletedInitialSelectedTimeframeLoad] =
    useState(false);
  const [analysisHistoricalDepsRevision, setAnalysisHistoricalDepsRevision] =
    useState('');
  const hydratedRevisionByTimeframeRef = useRef<
    Partial<Record<FiatRateInterval, string>>
  >({});

  const walletsSig = useMemo(() => {
    return (wallets || [])
      .map(w => String(w.id))
      .filter(Boolean)
      .join(',');
  }, [wallets]);

  const snapshotsSig = useMemo(() => {
    const parts: string[] = [];
    for (const w of wallets || []) {
      const id = String(w.id);
      if (!id) {
        continue;
      }
      const snaps = snapshotsByWalletId?.[id] || [];
      const lastSnapshot = snaps.length ? snaps[snaps.length - 1] : undefined;
      const last = lastSnapshot?.timestamp ?? 0;
      parts.push(`${id}:${snaps.length}:${last || 0}`);
    }
    return parts.join('|');
  }, [snapshotsByWalletId, wallets]);

  const totalSnapshotCount = useMemo(() => {
    let totalCount = 0;
    for (const w of wallets || []) {
      const id = String(w.id);
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
    return getSortedUniqueWalletIds((wallets || []).map(w => String(w.id)));
  }, [wallets]);

  const scopeId = useMemo(() => {
    return buildBalanceChartScopeId({
      walletIds: sortedWalletIds,
      quoteCurrency,
      balanceOffset,
    });
  }, [balanceOffset, quoteCurrency, sortedWalletIds]);
  scopeIdRef.current = scopeId;

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

  const currentSpotRatesByAssetKey = useMemo(() => {
    return buildPnlCurrentRatesByAssetKeyFromWallets({
      wallets: wallets || [],
      quoteCurrency,
      rates,
    });
  }, [quoteCurrency, rates, wallets]);

  const currentRatesRevision = useMemo(() => {
    return Object.entries(currentSpotRatesByAssetKey || {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([assetKey, rate]) => `${assetKey}:${rate}`)
      .join('|');
  }, [currentSpotRatesByAssetKey]);

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
        w.currencyAbbreviation,
      );
      if (!coinForCacheCheck) {
        continue;
      }

      const chain = w.chain ? w.chain.toLowerCase() : undefined;
      const tokenAddress = w.tokenAddress
        ? w.tokenAddress.toLowerCase()
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
        // The effect creator's thunk type is broader than this dispatch signature.
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

  const serializeHistoricalRateDepsRevision = useCallback(
    (historicalRateDeps: Array<{
      cacheKey: string;
      fetchedOn?: number;
      lastTs?: number;
    }>) => {
      return (historicalRateDeps || [])
        .filter(dep => !!dep?.cacheKey)
        .slice()
        .sort((a, b) => a.cacheKey.localeCompare(b.cacheKey))
        .map(
          dep => `${dep.cacheKey}:${dep.fetchedOn ?? 'na'}:${dep.lastTs ?? 'na'}`,
        )
        .join('|');
    },
    [],
  );

  const getCurrentHistoricalDepRevision = useCallback(
    (timeframe: FiatRateInterval) => {
      const depKeys = (cachedScope?.timeframes?.[timeframe]?.historicalRateDeps || [])
        .map(dep => dep.cacheKey)
        .filter(Boolean);

      if (depKeys.length) {
        return serializeHistoricalRateDepsRevision(
          buildHistoricalRateDependencyMetadataFromCache({
            depKeys,
            fiatRateSeriesCache,
          }),
        );
      }

      return analysisHistoricalDepsRevision;
    },
    [
      analysisHistoricalDepsRevision,
      cachedScope?.timeframes,
      fiatRateSeriesCache,
      serializeHistoricalRateDepsRevision,
    ],
  );

  const selectedTimeframeHistoricalDepRevision = useMemo(
    () => getCurrentHistoricalDepRevision(selectedTimeframe),
    [getCurrentHistoricalDepRevision, selectedTimeframe],
  );

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
        currentSpotRatesByAssetKey,
      });
    },
    [cachedScope?.timeframes, currentSpotRatesByAssetKey, scopeId, snapshotVersionSig],
  );

  const getTimeframeAttemptRevision = useCallback(
    (timeframe: FiatRateInterval) => {
      return [
        analysisInputsBaseKey,
        currentRatesRevision,
        getCurrentHistoricalDepRevision(timeframe),
        timeframe,
      ].join('|');
    },
    [
      analysisInputsBaseKey,
      currentRatesRevision,
      getCurrentHistoricalDepRevision,
    ],
  );

  const cachedTimeframeStatusByTimeframe = useMemo(() => {
    const next: Partial<Record<FiatRateInterval, 'fresh' | 'patchable' | 'stale_historical' | 'missing'>> = {};

    for (const timeframe of PRECOMPUTE_TIMEFRAME_ORDER) {
      next[timeframe] = getCachedTimeframeStatus({
        cachedTimeframe: cachedScope?.timeframes?.[timeframe],
        snapshotVersionSig,
        currentSpotRatesByAssetKey,
        fiatRateSeriesCache,
      });
    }

    return next;
  }, [
    cachedScope?.timeframes,
    currentSpotRatesByAssetKey,
    fiatRateSeriesCache,
    snapshotVersionSig,
  ]);

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
      (
        hasCompletedInitialSelectedTimeframeLoad &&
        hasAnyBackgroundHistoricalRecomputeNeeded
      ));

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
    const nextHydratedRevisionByTimeframe = {
      ...hydratedRevisionByTimeframeRef.current,
    };
    let hasHydratedUpdates = false;

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
              currentSpotRatesByAssetKey,
            })
          : cachedTimeframe;

      if (effectiveCachedTimeframe !== cachedTimeframe) {
        patchedTimeframes.push(effectiveCachedTimeframe);
      }

      const nextRevision =
        status === 'fresh' || status === 'patchable'
          ? getTimeframeRevision(
              timeframe,
              effectiveCachedTimeframe.historicalRateDeps,
            )
          : `stale:${effectiveCachedTimeframe.builtAt}:${timeframe}`;

      if (hydratedRevisionByTimeframeRef.current[timeframe] === nextRevision) {
        continue;
      }

      nextSeriesByTimeframe[timeframe] =
        deserializeCachedTimeframeToComputedSeries(effectiveCachedTimeframe);
      nextSeriesRevisionByTimeframe[timeframe] = nextRevision;
      nextHydratedRevisionByTimeframe[timeframe] = nextRevision;
      hasHydratedUpdates = true;
    }

    if (hasHydratedUpdates) {
      hydratedRevisionByTimeframeRef.current = nextHydratedRevisionByTimeframe;

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
    }

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
    currentSpotRatesByAssetKey,
    dispatch,
    getTimeframeRevision,
    scopeId,
    selectedTimeframe,
  ]);

  useEffect(() => {
    invalidateComputeGeneration();
    setIsComputingByTimeframe({});
  }, [
    analysisInputsBaseKey,
    currentRatesRevision,
    invalidateComputeGeneration,
    selectedTimeframeHistoricalDepRevision,
  ]);

  useEffect(() => {
    let cancelled = false;
    let prepareHandle: ScheduledAfterInteractionsHandle | undefined;
    const shouldResetPreparedInputs =
      analysisInputsReadyKeyRef.current !== analysisInputsBaseKey;

    if (!hasAnySnapshots || !shouldPrepareAnalysisInputs) {
      setAnalysisInputs(EMPTY_ANALYSIS_INPUTS(quoteCurrency));
      analysisHistoricalDepKeysRef.current = new Set();
      analysisInputsReadyKeyRef.current = undefined;
      setAnalysisHistoricalDepsRevision('');
      setAnalysisInputsReadyKey(undefined);
      return;
    }

    if (shouldResetPreparedInputs) {
      setAnalysisInputs(EMPTY_ANALYSIS_INPUTS(quoteCurrency));
      analysisInputsReadyKeyRef.current = undefined;
      setAnalysisHistoricalDepsRevision('');
      setAnalysisInputsReadyKey(undefined);
    }

    const generation = computeGenerationRef.current;
    prepareHandle = scheduleTrackedWork('prepare-analysis-inputs', async () => {
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
      const nextHistoricalDepsRevision = serializeHistoricalRateDepsRevision(
        buildHistoricalRateDependencyMetadataFromCache({
          depKeys: historicalDepKeys,
          fiatRateSeriesCache,
        }),
      );
      analysisHistoricalDepKeysRef.current = historicalDepKeys;
      analysisInputsReadyKeyRef.current = nextReadyKey;
      startTransition(() => {
        setAnalysisInputs(prev =>
          computeGenerationRef.current === generation ? prepared : prev,
        );
        setAnalysisHistoricalDepsRevision(prev =>
          computeGenerationRef.current === generation
            ? nextHistoricalDepsRevision
            : prev,
        );
        setAnalysisInputsReadyKey(prev =>
          computeGenerationRef.current === generation ? nextReadyKey : prev,
        );
      });
    });

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
    scheduleTrackedWork,
    removeScheduledHandle,
    serializeHistoricalRateDepsRevision,
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
          timeframe,
          quoteCurrency: analysisInputs.quoteCurrency,
          fiatRateSeriesCache,
          currentRatesByAssetKey:
            Object.keys(currentSpotRatesByAssetKey || {}).length > 0
              ? currentSpotRatesByAssetKey
              : undefined,
          mode: 'chart',
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
      currentSpotRatesByAssetKey,
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

      scheduleTrackedWork(`compute:${next}`, async () => {
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
    selectedTimeframe,
    sortedWalletIds,
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
      // Avoid retry loops after a real compute error, but do allow retrying a
      // revision if the prior attempt never produced either a series or an
      // error (for example, if it was interrupted during a timeframe/scope
      // transition).
      if (
        lastAttemptRevisionByTimeframe[tf] === attemptRevision &&
        !!lastErrorByTimeframe[tf]
      ) {
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
    setAnalysisHistoricalDepsRevision('');
    hydratedRevisionByTimeframeRef.current = {};
    setHasCompletedInitialSelectedTimeframeLoad(false);
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
  }, [
    ensureTimeframeComputed,
    inputsReady,
    selectedTimeframe,
    selectedTimeframeHistoricalDepRevision,
  ]);

  // Opportunistically precompute additional timeframes in background so taps
  // switch instantly more often and avoid heavy foreground work.
  useEffect(() => {
    if (!inputsReady || !hasAnySnapshots) {
      return;
    }
    if (!hasCompletedInitialSelectedTimeframeLoad) {
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
    hasCompletedInitialSelectedTimeframeLoad,
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

  const pointDisplayByTimestampMs = useMemo(() => {
    const next = new Map<
      number,
      {
        selectedLabel: string;
        deltaFiatFormatted: string;
      }
    >();

    if (!activeSeries?.graphPoints.length) {
      return next;
    }

    for (let index = 0; index < activeSeries.graphPoints.length; index++) {
      const graphPoint = activeSeries.graphPoints[index];
      const analysisPoint = activeSeries.analysisPoints[index];
      const timestampMs = graphPoint.date.getTime();
      next.set(timestampMs, {
        selectedLabel: formatRangeOrSelectedPointLabel({
          rangeLabel,
          selectedTimeframe: displayedTimeframe,
          selectedDate: graphPoint.date,
        }),
        deltaFiatFormatted: formatFiatAmount(
          analysisPoint?.totalUnrealizedPnlFiat ?? 0,
          quoteCurrency,
          {
            customPrecision: 'minimal',
            currencyDisplay: 'symbol',
          },
        ),
      });
    }

    return next;
  }, [activeSeries, displayedTimeframe, i18n.language, quoteCurrency, rangeLabel]);

  const selectedPointDisplay = useMemo(() => {
    if (!selectedPoint) {
      return undefined;
    }

    return pointDisplayByTimestampMs.get(selectedPoint.date.getTime());
  }, [pointDisplayByTimestampMs, selectedPoint]);

  const rangeOrSelectedPointLabel = selectedPointDisplay?.selectedLabel ?? rangeLabel;

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
  const hasAnyRenderableSeries =
    !!activeSeries ||
    PRECOMPUTE_TIMEFRAME_ORDER.some(timeframe => !!seriesByTimeframe[timeframe]?.graphPoints.length);
  const {
    isChartLoaderVisible,
    isChartLoadingRaw,
    hideGuideLineForInitialLoader,
  } = useBalanceChartLoaderState({
    hasAnySnapshots,
    hasCompletedInitialSelectedTimeframeLoad,
    hasRenderableSelectedSeries,
    selectedTimeframeError,
    setHasCompletedInitialSelectedTimeframeLoad,
  });

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

  const {displayedChangeRowData} = useBalanceChartChangeRow({
    activeSeries,
    quoteCurrency,
    rangeLabel: rangeOrSelectedPointLabel,
    selectedPoint,
    selectedPointDisplay,
    selectedTimeframe,
  });

  useEffect(() => {
    if (!displayedChangeRowData) {
      return;
    }
    onChangeRowData?.({
      percent: displayedChangeRowData.percent,
      deltaFiatFormatted: displayedChangeRowData.deltaFiatFormatted,
      rangeLabel: displayedChangeRowData.rangeLabel,
      isLoading: isChartLoaderVisible,
    });
  }, [
    displayedChangeRowData,
    isChartLoaderVisible,
    onChangeRowData,
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
        chartWidth={chartWidthRef.current}
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
        chartWidth={chartWidthRef.current}
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
          <View onLayout={handleChartLayout}>
            <InteractiveLineChart
              points={displayState?.series.graphPoints || []}
              chartWidth={chartWidth}
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
          </View>
        </>
      );
    }

    return preChartContent ? (
      <View style={{marginTop: preChartContentTopMargin}}>{preChartContent}</View>
    ) : null;
  }

  return (
    <>
      {showChangeRow && displayedChangeRowData ? (
        <ChartChangeRow
          percent={displayedChangeRowData.percent}
          deltaFiatFormatted={displayedChangeRowData.deltaFiatFormatted}
          rangeLabel={displayedChangeRowData.rangeLabel}
          isLoading={isChartLoaderVisible}
          style={changeRowStyle}
        />
      ) : null}
      {preChartContent ? (
        <View style={{marginTop: preChartContentTopMargin}}>{preChartContent}</View>
      ) : null}

      <View onLayout={handleChartLayout}>
        <InteractiveLineChart
          points={activeSeries?.graphPoints || []}
          chartWidth={chartWidth}
          color={chartColor}
          lineThickness={lineThickness}
          strokeScale={strokeScale}
          minStrokeScale={minStrokeScale}
          gradientFillColors={[
            gradientBackgroundColor,
            theme.dark ? 'transparent' : White,
          ]}
          showFirstPointGuideLine={!hideGuideLineForInitialLoader}
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
              width={chartWidth}
              selected={selectedTimeframe}
              onSelect={tf => {
                setSelectedPoint(undefined);
                onSelectedBalanceChangeRef.current?.(undefined);
                onSelectedTimeframeChange?.(tf);
                setSelectedTimeframe(tf);
              }}
            />
          </Animated.View>
        ) : null}
      </View>
    </>
  );
};

export default BalanceHistoryChart;
