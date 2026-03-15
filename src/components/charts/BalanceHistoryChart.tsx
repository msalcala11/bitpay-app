import React, {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import {StyleProp, View, ViewStyle} from 'react-native';
import {useTranslation} from 'react-i18next';
import {useTheme} from 'styled-components/native';
import type {GraphPoint} from 'react-native-graph';
import Animated, {
  type SharedValue,
  useAnimatedStyle,
} from 'react-native-reanimated';
import type {
  FiatRateSeriesCache,
  FiatRateInterval,
} from '../../store/rate/rate.models';
import type {Rates} from '../../store/rate/rate.models';
import {getFiatRateSeriesCacheKey} from '../../store/rate/rate.models';
import type {
  BalanceSnapshot,
  BalanceSnapshotsByWalletId,
} from '../../store/portfolio/portfolio.models';
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
import InteractiveLineChart, {
  type InteractiveLineChartAxisLabelProps,
} from './InteractiveLineChart';
import ChartAxisLabel from './ChartAxisLabel';
import ChartSelectionDot from './ChartSelectionDot';
import ChartChangeRow from './ChartChangeRow';
import {Action, LinkBlue, White} from '../../styles/colors';
import haptic from '../haptic-feedback/haptic';
import {
  buildPnlWalletInputsFromPortfolioSnapshotsAsync,
  buildPnlCurrentRatesByCoinFromPortfolioSnapshots,
  getPortfolioWalletChainLower,
  getPortfolioWalletCurrencyAbbreviation,
  getPortfolioWalletId,
  getPortfolioWalletSnapshots,
  getPortfolioWalletTokenAddressNormalized,
  type PnlWalletInputs,
} from '../../utils/portfolio/assets';
import {useAppDispatch, useAppSelector} from '../../utils/hooks';
import {fetchFiatRateSeriesInterval} from '../../store/wallet/effects';
import {normalizeFiatRateSeriesCoin} from '../../utils/portfolio/core/pnl/rates';
import {isNumberSharedValue} from './sharedValueGuards';
import {logManager} from '../../managers/LogManager';
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
  getCachedBalanceChartTimeframe,
  getCachedTimeframeStatus,
  getSortedUniqueWalletIds,
  patchCachedLatestPointWithSpotRates,
  serializeComputedSeriesToCachedTimeframe,
} from '../../utils/portfolio/chartCache';
import {isAbortError} from '../../utils/abort';
import {
  normalizeGraphPointsForChart,
  recomputeMinMaxFromGraphPoints,
} from '../../utils/portfolio/chartGraph';
import {
  balanceHistoryChartOrchestrationReducer,
  createInitialBalanceHistoryChartOrchestrationState,
  getTimeframeComputeDisposition,
  selectComputedSeriesForAttempt,
  selectTimeframeErrorForAttempt,
} from './balanceHistoryChartOrchestration';
import {
  scheduleAfterInteractionsAndFrames,
  type ScheduledAfterInteractionsHandle,
} from '../../utils/scheduleAfterInteractionsAndFrames';
import {
  computeFiatRateSeriesCacheRevision,
  getRelevantFiatRateSeriesCacheKeys,
} from './balanceHistoryChartRateCacheRevision';
import {formatUnknownError} from '../../utils/errors/formatUnknownError';

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
const PREP_FX_CACHE_INTERVALS: FiatRateInterval[] = ['1D', '1W', '1M', 'ALL'];
const EMPTY_BALANCE_SNAPSHOTS: BalanceSnapshot[] = [];

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

type ChangeRowData = {
  percent: number;
  deltaFiatFormatted?: string;
  rangeLabel?: string;
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

const logBalanceHistoryChartError = (context: string, error: unknown) => {
  logManager.error(
    `[BalanceHistoryChart] ${context}`,
    formatUnknownError(error),
  );
};

export type BalanceHistoryChartProps = {
  wallets: Wallet[];
  snapshotsByWalletId: BalanceSnapshotsByWalletId;
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
  timeframeSelectorHorizontalInset?: string;
  timeframeSelectorWidth?: number;
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
  timeframeSelectorHorizontalInset,
  timeframeSelectorWidth,
  disablePanGesture = false,
  onChangeRowData,
  axisLabelOpacity = 1,
  onSelectedTimeframeChange,
}: BalanceHistoryChartProps): React.ReactElement | null => {
  const {t} = useTranslation();
  const theme = useTheme();
  const dispatch = useAppDispatch();

  const [selectedTimeframe, setSelectedTimeframe] = useState<FiatRateInterval>(
    initialSelectedTimeframe,
  );

  const [timeframeState, dispatchTimeframeState] = useReducer(
    balanceHistoryChartOrchestrationReducer<ComputedSeries, ChangeRowData>,
    undefined,
    createInitialBalanceHistoryChartOrchestrationState,
  );
  const [analysisInputs, setAnalysisInputs] = useState<AnalysisInputs>(() => ({
    ...EMPTY_ANALYSIS_INPUTS(quoteCurrency),
  }));
  const [analysisInputsReadyKey, setAnalysisInputsReadyKey] = useState<
    string | undefined
  >(undefined);
  const [analysisInputsErrorKey, setAnalysisInputsErrorKey] = useState<
    string | undefined
  >(undefined);

  const [displayState, setDisplayState] = useState<
    | {
        series: ComputedSeries;
        timeframe: FiatRateInterval;
      }
    | undefined
  >(undefined);

  const enqueueComputeRef = useRef<FiatRateInterval[]>([]);
  const computingQueueRef = useRef(false);
  const computeGenerationRef = useRef(0);
  const scheduledHandlesRef = useRef<Set<ScheduledAfterInteractionsHandle>>(
    new Set(),
  );

  const [selectedPoint, setSelectedPoint] = useState<GraphPoint | undefined>();
  const timeframeStateByTimeframe = timeframeState.byTimeframe;

  const cancelAllScheduledWork = useCallback(() => {
    for (const handle of scheduledHandlesRef.current) {
      handle.cancel();
    }
    scheduledHandlesRef.current.clear();
  }, []);

  const trackScheduledHandle = useCallback(
    (handle: ScheduledAfterInteractionsHandle) => {
      scheduledHandlesRef.current.add(handle);
      void handle.done.finally(() => {
        scheduledHandlesRef.current.delete(handle);
      });
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
    return computeGenerationRef.current;
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

  const totalSnapshotCount = useMemo(() => {
    let totalCount = 0;
    for (const w of wallets || []) {
      const id = getPortfolioWalletId(w);
      if (!id) {
        continue;
      }
      totalCount += getPortfolioWalletSnapshots(snapshotsByWalletId, id).length;
    }

    return totalCount;
  }, [snapshotsByWalletId, wallets]);

  const hasAnySnapshots = totalSnapshotCount > 0;
  const analysisInputsReadyKeyRef = useRef<string | undefined>(undefined);
  const scopedWalletsRef = useRef<Wallet[]>([]);
  const scopedSnapshotsByWalletIdRef = useRef<BalanceSnapshotsByWalletId>({});
  const scopedSnapshotsVersionRef = useRef<string | undefined>(undefined);
  const fiatRateSeriesCacheRef = useRef(fiatRateSeriesCache);

  const scopedWallets = useMemo(() => {
    const previous = scopedWalletsRef.current;
    const next = wallets || [];
    let didChange = previous.length !== next.length;

    if (!didChange) {
      for (let i = 0; i < next.length; i++) {
        if (previous[i] !== next[i]) {
          didChange = true;
          break;
        }
      }
    }

    if (!didChange) {
      return previous;
    }

    scopedWalletsRef.current = next;
    return next;
  }, [wallets]);

  const sortedWalletIds = useMemo(() => {
    return getSortedUniqueWalletIds((wallets || []).map(getPortfolioWalletId));
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

  const scopedSnapshotsByWalletId = useMemo(() => {
    const previous = scopedSnapshotsByWalletIdRef.current;
    const next: BalanceSnapshotsByWalletId = {};
    let didChange = scopedSnapshotsVersionRef.current !== snapshotVersionSig;

    for (const walletId of sortedWalletIds) {
      const snapshots = Array.isArray(snapshotsByWalletId?.[walletId])
        ? snapshotsByWalletId[walletId]
        : EMPTY_BALANCE_SNAPSHOTS;
      next[walletId] = snapshots;
      if (previous[walletId] !== snapshots) {
        didChange = true;
      }
    }

    const previousWalletIds = Object.keys(previous);
    if (previousWalletIds.length !== sortedWalletIds.length) {
      didChange = true;
    }

    if (!didChange) {
      return previous;
    }

    scopedSnapshotsByWalletIdRef.current = next;
    scopedSnapshotsVersionRef.current = snapshotVersionSig;
    return next;
  }, [snapshotVersionSig, snapshotsByWalletId, sortedWalletIds]);

  const liveCurrentSpotRatesByCoin = useMemo(() => {
    return buildPnlCurrentRatesByCoinFromPortfolioSnapshots({
      snapshotsByWalletId: snapshotsByWalletId || {},
      wallets: wallets || [],
      quoteCurrency,
      rates,
    });
  }, [quoteCurrency, rates, snapshotsByWalletId, wallets]);

  const currentRatesRevision = useMemo(() => {
    return Object.entries(liveCurrentSpotRatesByCoin || {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([coin, rate]) => `${coin}:${rate}`)
      .join('|');
  }, [liveCurrentSpotRatesByCoin]);

  const preparedCurrentRatesRevision = useMemo(() => {
    return Object.entries(analysisInputs.currentRatesByCoin || {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([coin, rate]) => `${coin}:${rate}`)
      .join('|');
  }, [analysisInputs.currentRatesByCoin]);

  // Prefer the prepared rate map once it has caught up with the latest spot
  // inputs, but fall back to the live map so cache patching reacts immediately.
  const currentSpotRatesByCoin = useMemo(() => {
    return preparedCurrentRatesRevision === currentRatesRevision
      ? analysisInputs.currentRatesByCoin
      : liveCurrentSpotRatesByCoin;
  }, [
    analysisInputs.currentRatesByCoin,
    currentRatesRevision,
    liveCurrentSpotRatesByCoin,
    preparedCurrentRatesRevision,
  ]);

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
        getPortfolioWalletCurrencyAbbreviation(w),
      );
      if (!coinForCacheCheck) {
        continue;
      }

      const chainLower = getPortfolioWalletChainLower(w);
      const chain = chainLower || undefined;
      const tokenAddress = getPortfolioWalletTokenAddressNormalized(w);
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

  const relevantRateCacheCoins = useMemo(() => {
    return Array.from(
      new Set(
        rateFetchAssets
          .map(asset => asset.coinForCacheCheck)
          .filter((coin): coin is string => !!coin),
      ),
    ).sort((a, b) => a.localeCompare(b));
  }, [rateFetchAssets]);

  const relevantFiatRateSeriesCacheKeys = useMemo(() => {
    return getRelevantFiatRateSeriesCacheKeys({
      fiatCode: quoteCurrency,
      coins: relevantRateCacheCoins,
      timeframes: PRECOMPUTE_TIMEFRAME_ORDER,
    });
  }, [quoteCurrency, relevantRateCacheCoins]);

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
        }),
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
    return computeFiatRateSeriesCacheRevision({
      fiatRateSeriesCache,
      relevantKeys: relevantFiatRateSeriesCacheKeys,
    });
  }, [fiatRateSeriesCache, relevantFiatRateSeriesCacheKeys]);

  const prepFiatRateSeriesCacheKeys = useMemo(() => {
    const targetQuoteCurrency = (quoteCurrency || '').toUpperCase();
    if (!targetQuoteCurrency) {
      return [];
    }

    const quoteCurrencies = new Set<string>();
    let needsTargetQuoteCurrencySeries = false;

    for (const snapshots of Object.values(scopedSnapshotsByWalletId)) {
      for (const snapshot of snapshots || EMPTY_BALANCE_SNAPSHOTS) {
        const snapshotQuoteCurrency = (snapshot?.quoteCurrency || '').toUpperCase();
        if (
          !snapshotQuoteCurrency ||
          snapshotQuoteCurrency === targetQuoteCurrency
        ) {
          continue;
        }

        quoteCurrencies.add(snapshotQuoteCurrency);
        needsTargetQuoteCurrencySeries = true;
      }
    }

    if (!needsTargetQuoteCurrencySeries) {
      return [];
    }

    quoteCurrencies.add(targetQuoteCurrency);

    const keys = new Set<string>();
    for (const fiatCode of Array.from(quoteCurrencies).sort((a, b) =>
      a.localeCompare(b),
    )) {
      for (const interval of PREP_FX_CACHE_INTERVALS) {
        keys.add(getFiatRateSeriesCacheKey(fiatCode, 'btc', interval));
      }
    }

    return Array.from(keys).sort((a, b) => a.localeCompare(b));
  }, [quoteCurrency, scopedSnapshotsByWalletId]);

  const prepCacheRevision = useMemo(() => {
    return computeFiatRateSeriesCacheRevision({
      fiatRateSeriesCache,
      relevantKeys: prepFiatRateSeriesCacheKeys,
    });
  }, [fiatRateSeriesCache, prepFiatRateSeriesCacheKeys]);

  useEffect(() => {
    fiatRateSeriesCacheRef.current = fiatRateSeriesCache;
  }, [fiatRateSeriesCache]);

  const getTimeframeRevision = useCallback(
    (
      timeframe: FiatRateInterval,
      historicalRateDeps = getCachedBalanceChartTimeframe(
        cachedScope?.timeframes,
        timeframe,
      )?.historicalRateDeps || [],
    ) => {
      return buildBalanceChartTimeframeRevision({
        scopeId,
        timeframe,
        snapshotVersionSig,
        historicalRateDeps,
        currentSpotRatesByCoin,
      });
    },
    [
      cachedScope?.timeframes,
      currentSpotRatesByCoin,
      scopeId,
      snapshotVersionSig,
    ],
  );

  const getTimeframeAttemptRevision = useCallback(
    (timeframe: FiatRateInterval) => {
      return [
        analysisInputsBaseKey,
        currentRatesRevision,
        cacheRevision,
        timeframe,
      ].join('|');
    },
    [analysisInputsBaseKey, cacheRevision, currentRatesRevision],
  );

  const cachedTimeframeStatusByTimeframe = useMemo(() => {
    const next: Partial<
      Record<
        FiatRateInterval,
        'fresh' | 'patchable' | 'stale_historical' | 'missing'
      >
    > = {};

    for (const timeframe of PRECOMPUTE_TIMEFRAME_ORDER) {
      next[timeframe] = getCachedTimeframeStatus({
        cachedTimeframe: getCachedBalanceChartTimeframe(
          cachedScope?.timeframes,
          timeframe,
        ),
        snapshotVersionSig,
        currentSpotRatesByCoin,
        fiatRateSeriesCache,
      });
    }

    return next;
  }, [
    cachedScope?.timeframes,
    currentSpotRatesByCoin,
    fiatRateSeriesCache,
    snapshotVersionSig,
  ]);

  const selectedTimeframeNeedsHistoricalRecompute = useMemo(() => {
    const status =
      cachedTimeframeStatusByTimeframe[selectedTimeframe] || 'missing';
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
      (hasCompletedInitialAllLoad &&
        hasAnyBackgroundHistoricalRecomputeNeeded));

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
    const hydratedTimeframes: Partial<
      Record<
        FiatRateInterval,
        {
          series: ComputedSeries;
          seriesRevision: string;
        }
      >
    > = {};

    for (const timeframe of PRECOMPUTE_TIMEFRAME_ORDER) {
      const cachedTimeframe = getCachedBalanceChartTimeframe(
        cachedScope.timeframes,
        timeframe,
      );
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

      hydratedTimeframes[timeframe] = {
        series: deserializeCachedTimeframeToComputedSeries(
          effectiveCachedTimeframe,
        ),
        seriesRevision:
          status === 'fresh' || status === 'patchable'
            ? getTimeframeRevision(
                timeframe,
                effectiveCachedTimeframe.historicalRateDeps,
              )
            : `stale:${effectiveCachedTimeframe.builtAt}:${timeframe}`,
      };
    }

    startTransition(() => {
      dispatchTimeframeState({
        type: 'mergeHydratedSeries',
        updates: hydratedTimeframes,
      });

      const selectedHydratedSeries =
        hydratedTimeframes[selectedTimeframe]?.series;
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
    const generation = invalidateComputeGeneration();
    startTransition(() => {
      dispatchTimeframeState({
        type: 'advanceGeneration',
        generation,
      });
    });
  }, [
    analysisInputsBaseKey,
    cacheRevision,
    currentRatesRevision,
    invalidateComputeGeneration,
  ]);

  useEffect(() => {
    let prepareHandle: ScheduledAfterInteractionsHandle | undefined;
    const shouldResetPreparedInputs =
      analysisInputsReadyKeyRef.current !== analysisInputsBaseKey;

    if (!hasAnySnapshots || !shouldPrepareAnalysisInputs) {
      setAnalysisInputs(EMPTY_ANALYSIS_INPUTS(quoteCurrency));
      analysisHistoricalDepKeysRef.current = new Set();
      analysisInputsReadyKeyRef.current = undefined;
      setAnalysisInputsReadyKey(undefined);
      setAnalysisInputsErrorKey(undefined);
      return;
    }

    if (shouldResetPreparedInputs) {
      setAnalysisInputs(EMPTY_ANALYSIS_INPUTS(quoteCurrency));
      analysisInputsReadyKeyRef.current = undefined;
      setAnalysisInputsReadyKey(undefined);
      setAnalysisInputsErrorKey(undefined);
    }

    const generation = computeGenerationRef.current;
    prepareHandle = scheduleAfterInteractionsAndFrames({
      callback: async signal => {
        const historicalDepKeys = new Set<string>();
        const prepared = await buildPnlWalletInputsFromPortfolioSnapshotsAsync(
          {
            snapshotsByWalletId: scopedSnapshotsByWalletId,
            wallets: scopedWallets,
            quoteCurrency,
            rates,
            fiatRateSeriesCache: fiatRateSeriesCacheRef.current,
            onHistoricalRateDependency: cacheKey => {
              if (cacheKey) {
                historicalDepKeys.add(cacheKey);
              }
            },
          },
          {
            signal,
            yieldEveryWallets: 1,
            yieldEverySnapshots: 150,
          },
        );

        if (computeGenerationRef.current !== generation) {
          return;
        }

        const nextReadyKey = prepared.wallets.length
          ? analysisInputsBaseKey
          : undefined;
        analysisHistoricalDepKeysRef.current = historicalDepKeys;
        analysisInputsReadyKeyRef.current = nextReadyKey;
        startTransition(() => {
          if (computeGenerationRef.current !== generation) {
            return;
          }

          setAnalysisInputs(prepared);
          setAnalysisInputsReadyKey(nextReadyKey);
          setAnalysisInputsErrorKey(undefined);
        });
      },
      onError: error => {
        if (
          computeGenerationRef.current !== generation ||
          isAbortError(error)
        ) {
          return;
        }

        logBalanceHistoryChartError('prepare failed', error);
        analysisHistoricalDepKeysRef.current = new Set();
        analysisInputsReadyKeyRef.current = undefined;
        startTransition(() => {
          if (computeGenerationRef.current !== generation) {
            return;
          }

          setAnalysisInputs(EMPTY_ANALYSIS_INPUTS(quoteCurrency));
          setAnalysisInputsReadyKey(undefined);
          setAnalysisInputsErrorKey(analysisInputsBaseKey);
        });
      },
    });
    trackScheduledHandle(prepareHandle);

    return () => {
      removeScheduledHandle(prepareHandle, true);
    };
  }, [
    analysisInputsBaseKey,
    hasAnySnapshots,
    prepCacheRevision,
    quoteCurrency,
    rates,
    scopedSnapshotsByWalletId,
    scopedWallets,
    shouldPrepareAnalysisInputs,
    trackScheduledHandle,
    removeScheduledHandle,
  ]);

  const hasAnalysisPreparationError =
    analysisInputsErrorKey === analysisInputsBaseKey;

  const inputsReady =
    shouldPrepareAnalysisInputs &&
    !!fiatRateSeriesCache &&
    analysisInputs.wallets.length > 0 &&
    analysisInputsReadyKey === analysisInputsBaseKey &&
    !hasAnalysisPreparationError;

  const computeSeriesForTimeframe = useCallback(
    async (
      timeframe: FiatRateInterval,
      signal: AbortSignal,
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
          currentRatesByCoin:
            Object.keys(currentSpotRatesByCoin || {}).length > 0
              ? currentSpotRatesByCoin
              : undefined,
          nowMs: targetNowMs,
          maxPoints: FIAT_RATE_SERIES_TARGET_POINTS,
          signal,
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
        if (isAbortError(firstError)) {
          throw firstError;
        }

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

      dispatchTimeframeState({
        type: 'startCompute',
        timeframe: next,
        attemptRevision,
        generation,
      });

      const computeHandle = scheduleAfterInteractionsAndFrames({
        callback: async signal => {
          try {
            if (computeGenerationRef.current !== generation) {
              return;
            }

            const computed = await computeSeriesForTimeframe(next, signal);
            const timeframeRevision = getTimeframeRevision(
              next,
              computed.cacheEntry.historicalRateDeps,
            );

            if (computeGenerationRef.current !== generation) {
              return;
            }

            startTransition(() => {
              dispatchTimeframeState({
                type: 'resolveCompute',
                timeframe: next,
                attemptRevision,
                series: computed.series,
                seriesRevision: timeframeRevision,
                generation,
              });
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
          } catch (error: unknown) {
            if (
              computeGenerationRef.current !== generation ||
              signal.aborted ||
              isAbortError(error)
            ) {
              return;
            }

            const msg = formatUnknownError(error);
            logBalanceHistoryChartError(`compute failed for ${next}`, error);
            dispatchTimeframeState({
              type: 'rejectCompute',
              timeframe: next,
              attemptRevision,
              error: msg,
              generation,
            });
          } finally {
            if (computeGenerationRef.current !== generation) {
              computingQueueRef.current = false;
              return;
            }

            runNext();
          }
        },
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
    scopeId,
    selectedTimeframe,
    sortedWalletIds,
    trackScheduledHandle,
  ]);

  const getComputeDispositionForTimeframe = useCallback(
    (
      tf: FiatRateInterval,
      retryPolicy: 'retry_interrupted_attempts' | 'suppress_after_attempt',
    ) => {
      const cachedStatus = cachedTimeframeStatusByTimeframe[tf] || 'missing';
      const timeframeRevision = getTimeframeRevision(tf);
      const attemptRevision = getTimeframeAttemptRevision(tf);

      return getTimeframeComputeDisposition({
        cachedStatus,
        timeframeRevision,
        attemptRevision,
        timeframeState: timeframeStateByTimeframe[tf],
        hasAnySnapshots,
        inputsReady,
        retryPolicy,
      });
    },
    [
      cachedTimeframeStatusByTimeframe,
      getTimeframeAttemptRevision,
      getTimeframeRevision,
      hasAnySnapshots,
      inputsReady,
      timeframeStateByTimeframe,
    ],
  );

  const ensureTimeframeComputed = useCallback(
    (tf: FiatRateInterval, options?: {prioritize?: boolean}) => {
      const disposition = getComputeDispositionForTimeframe(
        tf,
        'retry_interrupted_attempts',
      );

      if (!disposition.shouldQueue) {
        return;
      }

      enqueueTimeframeCompute(tf, !!options?.prioritize);
      processQueue();
    },
    [enqueueTimeframeCompute, getComputeDispositionForTimeframe, processQueue],
  );

  const ensureTimeframeComputedRef = useRef(ensureTimeframeComputed);
  useEffect(() => {
    ensureTimeframeComputedRef.current = ensureTimeframeComputed;
  }, [ensureTimeframeComputed]);

  // Reset only when the chart scope changes (wallet set / quote / balance offset).
  useEffect(() => {
    const generation = invalidateComputeGeneration();
    analysisHistoricalDepKeysRef.current = new Set();
    lastTouchedScopeIdRef.current = undefined;
    analysisInputsReadyKeyRef.current = undefined;
    setAnalysisInputs(EMPTY_ANALYSIS_INPUTS(quoteCurrency));
    setAnalysisInputsReadyKey(undefined);
    setAnalysisInputsErrorKey(undefined);
    setHasCompletedInitialAllLoad(false);
    dispatchTimeframeState({
      type: 'resetAll',
      generation,
    });
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
      if (tf === selectedTimeframe) {
        return false;
      }
      return getComputeDispositionForTimeframe(tf, 'suppress_after_attempt')
        .shouldQueue;
    });

    if (!nextToPrecompute) {
      return;
    }

    enqueueTimeframeCompute(nextToPrecompute, false);
    processQueue();
  }, [
    enqueueTimeframeCompute,
    getComputeDispositionForTimeframe,
    hasAnySnapshots,
    hasCompletedInitialAllLoad,
    inputsReady,
    processQueue,
    selectedTimeframe,
  ]);

  const selectedTimeframeRevision = getTimeframeRevision(selectedTimeframe);
  const selectedTimeframeAttemptRevision =
    getTimeframeAttemptRevision(selectedTimeframe);
  const selectedComputedSeries = useMemo(() => {
    return selectComputedSeriesForAttempt({
      timeframeState: timeframeStateByTimeframe[selectedTimeframe],
      timeframeRevision: selectedTimeframeRevision,
      attemptRevision: selectedTimeframeAttemptRevision,
    });
  }, [
    selectedTimeframe,
    selectedTimeframeAttemptRevision,
    selectedTimeframeRevision,
    timeframeStateByTimeframe,
  ]);
  const selectedTimeframeError = selectTimeframeErrorForAttempt({
    timeframeState: timeframeStateByTimeframe[selectedTimeframe],
    attemptRevision: selectedTimeframeAttemptRevision,
  });
  const displayedTimeframe = selectedComputedSeries
    ? selectedTimeframe
    : displayState?.timeframe ?? selectedTimeframe;
  const activeSeries = selectedComputedSeries || displayState?.series;
  const cachedSelectedSeries = useMemo(() => {
    const cachedTimeframe = getCachedBalanceChartTimeframe(
      cachedScope?.timeframes,
      selectedTimeframe,
    );
    if (!cachedTimeframe) {
      return undefined;
    }

    const status =
      cachedTimeframeStatusByTimeframe[selectedTimeframe] || 'missing';
    const effectiveCachedTimeframe =
      status === 'patchable'
        ? patchCachedLatestPointWithSpotRates({
            cachedTimeframe,
            currentSpotRatesByCoin,
          })
        : cachedTimeframe;

    return deserializeCachedTimeframeToComputedSeries(effectiveCachedTimeframe);
  }, [
    cachedScope?.timeframes,
    cachedTimeframeStatusByTimeframe,
    currentSpotRatesByCoin,
    selectedTimeframe,
  ]);

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
    typeof timeframeSelectorOpacity === 'number' ? timeframeSelectorOpacity : 1;

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
    !hasRenderableSelectedSeries &&
    !selectedTimeframeError &&
    !hasAnalysisPreparationError;
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

    const isInitialAllLoad =
      selectedTimeframe === 'ALL' && !hasCompletedInitialAllLoad;
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
    selectedTimeframe === 'ALL' &&
    !hasCompletedInitialAllLoad &&
    isChartLoaderVisible;

  const hasAnyRenderableSeries =
    !!activeSeries ||
    Object.values(timeframeStateByTimeframe).some(
      state => !!state?.series?.graphPoints.length,
    );

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
  const cachedLastAnalysisPoint = useMemo(() => {
    const pts = cachedSelectedSeries?.analysisPoints || [];
    return pts.length ? pts[pts.length - 1] : undefined;
  }, [cachedSelectedSeries]);
  const displayedAnalysisPoint =
    selectedAnalysisPoint ?? lastAnalysisPoint ?? cachedLastAnalysisPoint;

  // IMPORTANT: For balance screens, the change row is unrealized profit vs cost basis
  // (NOT start→end balance delta). This mirrors the existing PnL engine UI elsewhere.
  const pnlDeltaFiat = displayedAnalysisPoint?.totalUnrealizedPnlFiat ?? 0;
  const pnlPercent = displayedAnalysisPoint?.totalPnlPercent ?? 0;
  const hasResolvedChangeRowData = !!displayedAnalysisPoint;

  const formattedDeltaFiat = useMemo(() => {
    if (!hasResolvedChangeRowData) {
      return undefined;
    }
    return formatFiatAmount(pnlDeltaFiat, quoteCurrency, {
      customPrecision: 'minimal',
      currencyDisplay: 'symbol',
    });
  }, [hasResolvedChangeRowData, pnlDeltaFiat, quoteCurrency]);

  const resolvedChangeRowData = useMemo<ChangeRowData | undefined>(() => {
    if (!hasResolvedChangeRowData) {
      return undefined;
    }

    return {
      percent: pnlPercent,
      deltaFiatFormatted: formattedDeltaFiat,
      rangeLabel: rangeOrSelectedPointLabel,
    };
  }, [
    formattedDeltaFiat,
    hasResolvedChangeRowData,
    pnlPercent,
    rangeOrSelectedPointLabel,
  ]);

  useEffect(() => {
    if (!resolvedChangeRowData) {
      return;
    }

    const existing =
      timeframeStateByTimeframe[selectedTimeframe]?.lastResolvedChangeRowData;
    if (
      existing?.percent === resolvedChangeRowData.percent &&
      existing?.deltaFiatFormatted ===
        resolvedChangeRowData.deltaFiatFormatted &&
      existing?.rangeLabel === resolvedChangeRowData.rangeLabel
    ) {
      return;
    }

    dispatchTimeframeState({
      type: 'setResolvedChangeRowData',
      timeframe: selectedTimeframe,
      data: resolvedChangeRowData,
    });
  }, [resolvedChangeRowData, selectedTimeframe, timeframeStateByTimeframe]);

  const displayedChangeRowData =
    resolvedChangeRowData ||
    timeframeStateByTimeframe[selectedTimeframe]?.lastResolvedChangeRowData;

  useEffect(() => {
    if (!displayedChangeRowData) {
      return;
    }
    onChangeRowData?.({
      percent: displayedChangeRowData.percent,
      deltaFiatFormatted: displayedChangeRowData.deltaFiatFormatted,
      rangeLabel: displayedChangeRowData.rangeLabel,
    });
  }, [displayedChangeRowData, onChangeRowData]);

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
  const MaxAxisLabel = useCallback(
    ({width}: InteractiveLineChartAxisLabelProps) => {
      const series = activeSeriesRef.current;
      if (!series?.graphPoints.length) {
        return null;
      }

      return (
        <ChartAxisLabel
          width={width}
          value={series.maxPoint.value}
          index={series.maxIndex}
          arrayLength={series.graphPoints.length}
          quoteCurrency={quoteCurrencyRef.current}
          currencyAbbreviation={undefined}
          type="max"
          contentOpacity={axisLabelOpacityRef.current}
        />
      );
    },
    [],
  );

  const MinAxisLabel = useCallback(
    ({width}: InteractiveLineChartAxisLabelProps) => {
      const series = activeSeriesRef.current;
      if (!series?.graphPoints.length) {
        return null;
      }

      return (
        <ChartAxisLabel
          width={width}
          value={series.minPoint.value}
          index={series.minIndex}
          arrayLength={series.graphPoints.length}
          quoteCurrency={quoteCurrencyRef.current}
          currencyAbbreviation={undefined}
          type="min"
          contentOpacity={axisLabelOpacityRef.current}
        />
      );
    },
    [],
  );

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
      <View style={{marginTop: preChartContentTopMargin}}>
        {preChartContent}
      </View>
    ) : null;
  }

  return (
    <>
      {showChangeRow ? (
        <ChartChangeRow
          percent={displayedChangeRowData?.percent ?? 0}
          deltaFiatFormatted={displayedChangeRowData?.deltaFiatFormatted}
          rangeLabel={displayedChangeRowData?.rangeLabel}
          style={[
            changeRowStyle,
            !displayedChangeRowData ? {opacity: 0} : null,
          ]}
        />
      ) : null}
      {preChartContent ? (
        <View style={{marginTop: preChartContentTopMargin}}>
          {preChartContent}
        </View>
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
            width={timeframeSelectorWidth}
            horizontalInset={timeframeSelectorHorizontalInset}
            onSelect={tf => {
              setSelectedPoint(undefined);
              onSelectedBalanceChangeRef.current?.(undefined);
              onSelectedTimeframeChange?.(tf);
              setSelectedTimeframe(tf);
            }}
          />
        </Animated.View>
      ) : null}
    </>
  );
};

export default BalanceHistoryChart;
