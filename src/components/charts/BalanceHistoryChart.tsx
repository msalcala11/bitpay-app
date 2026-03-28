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
import Animated, {useAnimatedStyle} from 'react-native-reanimated';
import type {
  FiatRateSeriesCache,
  FiatRateInterval,
  Rates,
} from '../../store/rate/rate.models';
import {
  FIAT_RATE_SERIES_CACHED_INTERVALS,
  FIAT_RATE_SERIES_TARGET_POINTS,
  hasValidSeriesForCoin,
} from '../../store/rate/rate.models';
import type {
  BalanceSnapshot,
  BalanceSnapshotsByWalletId,
} from '../../store/portfolio/portfolio.models';
import type {Wallet} from '../../store/wallet/wallet.models';
import {
  buildPnlAnalysisSeriesAsync,
  type PnlAnalysisPoint,
} from '../../utils/portfolio/core/pnl/analysis';
import {
  DEFAULT_BALANCE_CHART_TIMEFRAME,
  FIAT_CHART_DISPLAY_ORDER,
  getFiatChartTimeframeOptions,
  getRangeLabelForFiatTimeframe,
  getSeriesIntervalForFiatTimeframe,
} from './fiatTimeframes';
import TimeframeSelector from './TimeframeSelector';
import InteractiveLineChart from './InteractiveLineChart';
import ChartSelectionDot from './ChartSelectionDot';
import ChartChangeRow from './ChartChangeRow';
import {Action, LinkBlue, White} from '../../styles/colors';
import {
  buildPnlCurrentRatesByRateKeyFromPortfolioSnapshots,
  buildPnlWalletInputsFromPortfolioSnapshotsAsync,
  getPortfolioWalletId,
  getPortfolioWalletSnapshots,
  isPortfolioWalletOnMainnet,
  type PnlWalletInputs,
} from '../../utils/portfolio/assets';
import {useAppDispatch, useAppSelector} from '../../utils/hooks';
import {fetchFiatRateSeriesInterval} from '../../store/wallet/effects';
import {isNumberSharedValue, type NumberSharedValue} from './sharedValueGuards';
import {logManager} from '../../managers/LogManager';
import {
  patchBalanceChartScopeLatestPoints,
  touchBalanceChartScope,
} from '../../store/portfolio-charts';
import {
  buildBalanceChartScopeId,
  buildBalanceChartTimeframeRevision,
  buildHistoricalRateDependencyMetadataFromCache,
  buildLatestPointPatchMetadataFromAnalysis,
  buildSnapshotVersionSig,
  deserializeCachedTimeframeToComputedSeries,
  getCachedBalanceChartTimeframe,
  getCachedTimeframeStatus,
  getCachedTimeframeStatusDetails,
  resolveBalanceChartSeriesExtrema,
  getSortedUniqueWalletIds,
  serializeComputedSeriesToCachedTimeframe,
  stableRateMapRevision,
  type CachedTimeframeStatusDetails,
  type HydratedBalanceChartSeries,
} from '../../utils/portfolio/chartCache';
import {isAbortError} from '../../utils/abort';
import {normalizeGraphPointsForChart} from '../../utils/portfolio/chartGraph';
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
  buildBalanceHistoryChartPrepFiatRateSeriesCacheKeys,
  buildBalanceHistoryChartRateFetchAssets,
  buildBalanceHistoryChartRelevantRateCacheAssets,
  getLatestFiatRateSeriesPointTs,
} from './balanceHistoryChartDataPrep';
import {
  buildHydratedBalanceChartTimeframes,
  getEffectiveCachedBalanceChartTimeframe,
} from './balanceHistoryChartHydration';
import {
  buildFiatRateSeriesCacheRevisionInfo,
  getRelevantFiatRateSeriesCacheKeys,
  summarizeFiatRateSeriesCacheKeyOwnership,
  summarizeFiatRateSeriesDependencyPlan,
  summarizeFiatRateSeriesCacheRevisionChange,
} from './balanceHistoryChartRateCacheRevision';
import {type ChangeRowData} from './balanceHistoryChartSelection';
import {formatUnknownError} from '../../utils/errors/formatUnknownError';
import {useBalanceHistoryChartComputeQueue} from './useBalanceHistoryChartComputeQueue';
import {useBalanceHistoryChartSelectionState} from './useBalanceHistoryChartSelectionState';
import {useScheduledAfterInteractionsRegistry} from './useScheduledAfterInteractionsRegistry';
import {useStableBalanceHistoryChartAxisLabels} from './useStableBalanceHistoryChartAxisLabels';
import {
  getPerfClockNowMs,
  measurePerfSync,
  recordPerfEvent,
  startPerfSpan,
  type PerfMetadata,
} from '../../utils/perfLogger';

const CHART_LOADER_DELAY_MS = 150;
const CHART_COMPUTE_YIELD_EVERY_POINTS = 4;
const PRECOMPUTE_TIMEFRAME_ORDER: FiatRateInterval[] = [
  ...FIAT_CHART_DISPLAY_ORDER,
];
const PREP_FX_CACHE_INTERVALS = FIAT_RATE_SERIES_CACHED_INTERVALS;
const EMPTY_BALANCE_SNAPSHOTS: BalanceSnapshot[] = [];

type AnalysisInputs = PnlWalletInputs;
type ComputedSeries = HydratedBalanceChartSeries;

const EMPTY_ANALYSIS_INPUTS = (quoteCurrency: string): AnalysisInputs => ({
  wallets: [],
  currentRatesByRateKey: {},
  quoteCurrency: (quoteCurrency || '').toUpperCase(),
});

const summarizeRateMapChange = (
  previousRatesByRateKey?: Record<string, number>,
  nextRatesByRateKey?: Record<string, number>,
  maxSampleSize = 6,
) => {
  const previousEntries = previousRatesByRateKey || {};
  const nextEntries = nextRatesByRateKey || {};
  const rateKeys = Array.from(
    new Set([...Object.keys(previousEntries), ...Object.keys(nextEntries)]),
  ).sort((a, b) => a.localeCompare(b));
  const changedRateKeysSample: string[] = [];
  let addedRateKeyCount = 0;
  let changedRateKeyCount = 0;
  let largestRateDelta = 0;
  let largestRateDeltaKey: string | undefined;
  let removedRateKeyCount = 0;
  let updatedRateKeyCount = 0;

  for (const rateKey of rateKeys) {
    const previousHasRate = Object.prototype.hasOwnProperty.call(
      previousEntries,
      rateKey,
    );
    const nextHasRate = Object.prototype.hasOwnProperty.call(nextEntries, rateKey);
    const previousRate = previousEntries[rateKey];
    const nextRate = nextEntries[rateKey];
    const reasons: string[] = [];

    if (!previousHasRate && nextHasRate) {
      addedRateKeyCount += 1;
      reasons.push('added');
    } else if (previousHasRate && !nextHasRate) {
      removedRateKeyCount += 1;
      reasons.push('removed');
    } else if (previousRate !== nextRate) {
      updatedRateKeyCount += 1;
      reasons.push('rate');
      const delta = Math.abs(Number(nextRate || 0) - Number(previousRate || 0));
      if (delta > largestRateDelta) {
        largestRateDelta = delta;
        largestRateDeltaKey = rateKey;
      }
    }

    if (!reasons.length) {
      continue;
    }

    changedRateKeyCount += 1;

    if (changedRateKeysSample.length < Math.max(1, maxSampleSize)) {
      changedRateKeysSample.push(`${rateKey}:${reasons.join(',')}`);
    }
  }

  return {
    addedRateKeyCount,
    changedRateKeyCount,
    changedRateKeysSample,
    largestRateDelta,
    largestRateDeltaKey,
    nextRateKeyCount: Object.keys(nextEntries).length,
    previousRateKeyCount: Object.keys(previousEntries).length,
    removedRateKeyCount,
    updatedRateKeyCount,
  };
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
  perfContext?: string;
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
  strokeScale?: number | NumberSharedValue;
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
  timeframeSelectorOpacity?: number | NumberSharedValue;
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
  axisLabelOpacity?: number | NumberSharedValue;
  onSelectedTimeframeChange?: (timeframe: FiatRateInterval) => void;
  enableBackgroundPrecompute?: boolean;
  isActive?: boolean;
};

const BalanceHistoryChart = ({
  wallets,
  snapshotsByWalletId,
  quoteCurrency,
  perfContext = 'BalanceHistoryChart',
  initialSelectedTimeframe = DEFAULT_BALANCE_CHART_TIMEFRAME,
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
  enableBackgroundPrecompute = true,
  isActive = true,
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
  const [analysisInputsReadyRevision, setAnalysisInputsReadyRevision] =
    useState<string | undefined>(undefined);
  const [analysisInputsErrorRevision, setAnalysisInputsErrorRevision] =
    useState<string | undefined>(undefined);
  const [displayState, setDisplayState] = useState<
    | {
        series: ComputedSeries;
        timeframe: FiatRateInterval;
      }
    | undefined
  >(undefined);
  const [
    hasCompletedInitialInteractiveLoad,
    setHasCompletedInitialInteractiveLoad,
  ] = useState(false);
  const [isChartLoaderVisible, setIsChartLoaderVisible] = useState(false);

  const computeGenerationRef = useRef(0);
  const timeframeStateByTimeframe = timeframeState.byTimeframe;
  const {cancelAllScheduledWork, trackScheduledHandle, removeScheduledHandle} =
    useScheduledAfterInteractionsRegistry();

  // NOTE: Some call sites may pass inline callbacks. Avoid re-running effects
  // (and thus triggering render loops) when the callback identity changes.
  const onSelectedBalanceChangeRef = useRef(onSelectedBalanceChange);
  useEffect(() => {
    onSelectedBalanceChangeRef.current = onSelectedBalanceChange;
  }, [onSelectedBalanceChange]);

  const analysisHistoricalDepKeysRef = useRef<Set<string>>(new Set());
  const lastTouchedScopeIdRef = useRef<string | undefined>(undefined);
  const prepScopedDepIdentityIdsRef = useRef<WeakMap<object, number>>(
    new WeakMap(),
  );
  const prepScopedDepIdentityNextIdRef = useRef(1);
  const analysisInputsReadyRevisionRef = useRef<string | undefined>(undefined);
  const scopedWalletsRef = useRef<Wallet[]>([]);
  const scopedSnapshotsByWalletIdRef = useRef<BalanceSnapshotsByWalletId>({});
  const scopedSnapshotsVersionRef = useRef<string | undefined>(undefined);
  const fiatRateSeriesCacheRef = useRef(fiatRateSeriesCache);

  const {
    chartableSnapshotCount,
    hasAnySnapshots,
    hasAnyChartableSnapshots,
    hasAnyMainnetWallet,
    totalSnapshotCount,
  } = useMemo(() => {
      let totalSnapshotCount = 0;
      let totalChartableSnapshotCount = 0;
      let anyMainnetWallet = false;

      for (const wallet of wallets || []) {
        const walletId = getPortfolioWalletId(wallet);
        if (!walletId) {
          continue;
        }

        const snapshotCount = getPortfolioWalletSnapshots(
          snapshotsByWalletId,
          walletId,
        ).length;
        totalSnapshotCount += snapshotCount;

        if (!isPortfolioWalletOnMainnet(wallet)) {
          continue;
        }

        anyMainnetWallet = true;
        totalChartableSnapshotCount += snapshotCount;
      }

      return {
        chartableSnapshotCount: totalChartableSnapshotCount,
        hasAnySnapshots: totalSnapshotCount > 0,
        hasAnyChartableSnapshots: totalChartableSnapshotCount > 0,
        hasAnyMainnetWallet: anyMainnetWallet,
        totalSnapshotCount,
      };
    }, [snapshotsByWalletId, wallets]);

  const getPrepScopedDepIdentityId = useCallback((value: object): number => {
    const existingId = prepScopedDepIdentityIdsRef.current.get(value);
    if (typeof existingId === 'number') {
      return existingId;
    }

    const nextId = prepScopedDepIdentityNextIdRef.current;
    prepScopedDepIdentityNextIdRef.current += 1;
    prepScopedDepIdentityIdsRef.current.set(value, nextId);
    return nextId;
  }, []);

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

  const buildPerfMetadata = useCallback(
    (metadata?: PerfMetadata): PerfMetadata => {
      return {
        balanceOffset,
        chartableSnapshotCount,
        perfContext,
        quoteCurrency: quoteCurrency.toUpperCase(),
        scopeId,
        totalSnapshotCount,
        walletCount: sortedWalletIds.length,
        ...metadata,
      };
    },
    [
      balanceOffset,
      chartableSnapshotCount,
      perfContext,
      quoteCurrency,
      scopeId,
      sortedWalletIds.length,
      totalSnapshotCount,
    ],
  );

  const snapshotVersionSig = useAppSelector(state => {
    return buildSnapshotVersionSig({
      walletIds: sortedWalletIds,
      walletSnapshotVersionById:
        state.PORTFOLIO_CHARTS.walletSnapshotVersionById || {},
    });
  });

  const snapshotVersionState = useAppSelector(state => {
    const walletSnapshotVersionById =
      state.PORTFOLIO_CHARTS.walletSnapshotVersionById || {};
    let walletSnapshotVersionEntryCount = 0;
    let zeroSnapshotVersionWalletCount = 0;
    let nonZeroSnapshotVersionWalletCount = 0;

    for (const walletId of sortedWalletIds) {
      const rawVersion = walletSnapshotVersionById[walletId];
      if (rawVersion !== undefined) {
        walletSnapshotVersionEntryCount += 1;
      }

      const normalizedVersion = Math.max(
        0,
        Math.floor(
          typeof rawVersion === 'number' && Number.isFinite(rawVersion)
            ? rawVersion
            : 0,
        ),
      );

      if (normalizedVersion > 0) {
        nonZeroSnapshotVersionWalletCount += 1;
      } else {
        zeroSnapshotVersionWalletCount += 1;
      }
    }

    return {
      nonZeroSnapshotVersionWalletCount,
      walletSnapshotVersionEntryCount,
      zeroSnapshotVersionWalletCount,
    };
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

    if (Object.keys(previous).length !== sortedWalletIds.length) {
      didChange = true;
    }

    if (!didChange) {
      return previous;
    }

    scopedSnapshotsByWalletIdRef.current = next;
    scopedSnapshotsVersionRef.current = snapshotVersionSig;
    return next;
  }, [snapshotVersionSig, snapshotsByWalletId, sortedWalletIds]);

  const liveSpotRatesByRateKey = useMemo(() => {
    return measurePerfSync(
      'balance_chart.build_live_spot_rates',
      () =>
        buildPnlCurrentRatesByRateKeyFromPortfolioSnapshots({
          snapshotsByWalletId: snapshotsByWalletId || {},
          wallets: wallets || [],
          quoteCurrency,
          rates,
        }),
      buildPerfMetadata({
        ratesAssetCount: Object.keys(rates || {}).length,
      }),
    );
  }, [buildPerfMetadata, quoteCurrency, rates, snapshotsByWalletId, wallets]);

  const preparedSpotRatesByRateKey = analysisInputs.currentRatesByRateKey;

  const liveSpotRatesRevision = useMemo(() => {
    return stableRateMapRevision(liveSpotRatesByRateKey);
  }, [liveSpotRatesByRateKey]);

  const preparedSpotRatesRevision = useMemo(() => {
    return stableRateMapRevision(preparedSpotRatesByRateKey);
  }, [preparedSpotRatesByRateKey]);

  // Prefer the prepared rate map once it has caught up with the latest spot
  // inputs, but fall back to the live map so cache patching reacts immediately.
  const currentSpotRatesByRateKey = useMemo(() => {
    return preparedSpotRatesRevision === liveSpotRatesRevision
      ? preparedSpotRatesByRateKey
      : liveSpotRatesByRateKey;
  }, [
    liveSpotRatesByRateKey,
    liveSpotRatesRevision,
    preparedSpotRatesByRateKey,
    preparedSpotRatesRevision,
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
    return buildBalanceHistoryChartRateFetchAssets(
      scopedWallets,
      scopedSnapshotsByWalletId,
    );
  }, [scopedSnapshotsByWalletId, scopedWallets]);

  const relevantRateCacheAssets = useMemo(() => {
    return buildBalanceHistoryChartRelevantRateCacheAssets(rateFetchAssets);
  }, [rateFetchAssets]);

  const relevantFiatRateSeriesCacheKeys = useMemo(() => {
    return getRelevantFiatRateSeriesCacheKeys({
      fiatCode: quoteCurrency,
      assets: relevantRateCacheAssets,
      timeframes: PRECOMPUTE_TIMEFRAME_ORDER,
    });
  }, [quoteCurrency, relevantRateCacheAssets]);

  const relevantRateDependencyPlanSummary = useMemo(() => {
    return summarizeFiatRateSeriesDependencyPlan({
      relevantCacheKeys: relevantFiatRateSeriesCacheKeys,
      selectedTimeframe,
      timeframes: PRECOMPUTE_TIMEFRAME_ORDER,
    });
  }, [relevantFiatRateSeriesCacheKeys, selectedTimeframe]);

  useEffect(() => {
    if (
      !hasAnyChartableSnapshots ||
      !quoteCurrency ||
      !rateFetchAssets.length
    ) {
      return;
    }

    for (const asset of rateFetchAssets) {
      if (
        hasValidSeriesForCoin({
          cache: fiatRateSeriesCache,
          fiatCodeUpper: quoteCurrency,
          normalizedCoin: asset.coinForCacheCheck,
          intervals: [selectedSeriesInterval],
          requireFresh: true,
          chain: asset.chain,
          tokenAddress: asset.tokenAddress,
        })
      ) {
        continue;
      }

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
    fiatRateSeriesCache,
    hasAnyChartableSnapshots,
    quoteCurrency,
    rateFetchAssets,
    selectedSeriesInterval,
  ]);

  const relevantFiatRateSeriesCacheRevisionInfo = useMemo(() => {
    return buildFiatRateSeriesCacheRevisionInfo({
      fiatRateSeriesCache,
      relevantKeys: relevantFiatRateSeriesCacheKeys,
    });
  }, [fiatRateSeriesCache, relevantFiatRateSeriesCacheKeys]);
  const cacheRevision = relevantFiatRateSeriesCacheRevisionInfo.revision;

  const prepFiatRateSeriesCacheKeys = useMemo(() => {
    return buildBalanceHistoryChartPrepFiatRateSeriesCacheKeys({
      quoteCurrency,
      scopedSnapshotsByWalletId,
      prepIntervals: PREP_FX_CACHE_INTERVALS,
    });
  }, [quoteCurrency, scopedSnapshotsByWalletId]);

  const prepFiatRateSeriesCacheRevisionInfo = useMemo(() => {
    return buildFiatRateSeriesCacheRevisionInfo({
      fiatRateSeriesCache,
      relevantKeys: prepFiatRateSeriesCacheKeys,
    });
  }, [fiatRateSeriesCache, prepFiatRateSeriesCacheKeys]);
  const prepCacheRevision = prepFiatRateSeriesCacheRevisionInfo.revision;

  const preparedInputsTargetRevision = useMemo(() => {
    return [
      analysisInputsBaseKey,
      prepCacheRevision,
      `wallets:${getPrepScopedDepIdentityId(scopedWallets)}`,
      `snapshots:${getPrepScopedDepIdentityId(scopedSnapshotsByWalletId)}`,
    ].join('|');
  }, [
    analysisInputsBaseKey,
    getPrepScopedDepIdentityId,
    prepCacheRevision,
    scopedSnapshotsByWalletId,
    scopedWallets,
  ]);

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
        currentSpotRatesByRateKey,
      });
    },
    [
      cachedScope?.timeframes,
      currentSpotRatesByRateKey,
      scopeId,
      snapshotVersionSig,
    ],
  );

  const getTimeframeAttemptRevision = useCallback(
    (timeframe: FiatRateInterval) => {
      return [
        preparedInputsTargetRevision,
        analysisInputsReadyRevision || 'pending',
        liveSpotRatesRevision,
        cacheRevision,
        timeframe,
      ].join('|');
    },
    [
      analysisInputsReadyRevision,
      cacheRevision,
      liveSpotRatesRevision,
      preparedInputsTargetRevision,
    ],
  );

  const cachedTimeframeStatusDetailsByTimeframe = useMemo(() => {
    const next: Partial<Record<FiatRateInterval, CachedTimeframeStatusDetails>> =
      {};

    for (const timeframe of PRECOMPUTE_TIMEFRAME_ORDER) {
      next[timeframe] = getCachedTimeframeStatusDetails({
        cachedTimeframe: getCachedBalanceChartTimeframe(
          cachedScope?.timeframes,
          timeframe,
        ),
        currentSpotRatesByRateKey,
        currentWalletCount: sortedWalletIds.length,
        fiatRateSeriesCache,
        snapshotVersionSig,
      });
    }

    return next;
  }, [
    cachedScope?.timeframes,
    currentSpotRatesByRateKey,
    fiatRateSeriesCache,
    snapshotVersionSig,
    sortedWalletIds.length,
  ]);

  const cachedTimeframeStatusByTimeframe = useMemo(() => {
    const next: Partial<
      Record<
        FiatRateInterval,
        'fresh' | 'patchable' | 'stale_historical' | 'missing'
      >
    > = {};

    for (const timeframe of PRECOMPUTE_TIMEFRAME_ORDER) {
      next[timeframe] =
        cachedTimeframeStatusDetailsByTimeframe[timeframe]?.status ||
        getCachedTimeframeStatus({
          cachedTimeframe: getCachedBalanceChartTimeframe(
            cachedScope?.timeframes,
            timeframe,
          ),
          snapshotVersionSig,
          currentSpotRatesByRateKey,
          fiatRateSeriesCache,
        });
    }

    return next;
  }, [
    cachedTimeframeStatusDetailsByTimeframe,
    cachedScope?.timeframes,
    currentSpotRatesByRateKey,
    fiatRateSeriesCache,
    snapshotVersionSig,
  ]);

  const selectedCachedTimeframeStatusDetails = useMemo(() => {
    return (
      cachedTimeframeStatusDetailsByTimeframe[selectedTimeframe] ||
      getCachedTimeframeStatusDetails({
        currentSpotRatesByRateKey,
        currentWalletCount: sortedWalletIds.length,
        fiatRateSeriesCache,
        snapshotVersionSig,
      })
    );
  }, [
    cachedTimeframeStatusDetailsByTimeframe,
    currentSpotRatesByRateKey,
    fiatRateSeriesCache,
    selectedTimeframe,
    snapshotVersionSig,
    sortedWalletIds.length,
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
    hasAnyChartableSnapshots &&
    !!fiatRateSeriesCache &&
    (selectedTimeframeNeedsHistoricalRecompute ||
      (hasCompletedInitialInteractiveLoad &&
        hasAnyBackgroundHistoricalRecomputeNeeded));

  const previousRelevantRateCacheRevisionInfoRef = useRef(
    relevantFiatRateSeriesCacheRevisionInfo,
  );
  const previousPrepRateCacheRevisionInfoRef = useRef(
    prepFiatRateSeriesCacheRevisionInfo,
  );
  const previousLiveSpotRatesByRateKeyRef = useRef(liveSpotRatesByRateKey);
  const previousSnapshotVersionStateSigRef = useRef<string>();
  const previousSelectedCachedStatusDetailSigRef = useRef<string>();
  const previousGenerationInputsRef = useRef<{
    cacheRevision: string;
    liveSpotRatesRevision: string;
    preparedInputsTargetRevision: string;
  }>();

  useEffect(() => {
    analysisInputsReadyRevisionRef.current = analysisInputsReadyRevision;
  }, [analysisInputsReadyRevision]);

  useEffect(() => {
    const signature = [
      snapshotVersionSig.length,
      snapshotVersionState.walletSnapshotVersionEntryCount,
      snapshotVersionState.zeroSnapshotVersionWalletCount,
      snapshotVersionState.nonZeroSnapshotVersionWalletCount,
      sortedWalletIds.length,
    ].join('|');

    if (previousSnapshotVersionStateSigRef.current === signature) {
      return;
    }

    previousSnapshotVersionStateSigRef.current = signature;

    recordPerfEvent(
      'balance_chart.snapshot_version_sig_state',
      buildPerfMetadata({
        currentWalletCount: sortedWalletIds.length,
        nonZeroSnapshotVersionWalletCount:
          snapshotVersionState.nonZeroSnapshotVersionWalletCount,
        snapshotVersionSigLength: snapshotVersionSig.length,
        walletSnapshotVersionEntryCount:
          snapshotVersionState.walletSnapshotVersionEntryCount,
        zeroSnapshotVersionWalletCount:
          snapshotVersionState.zeroSnapshotVersionWalletCount,
      }),
    );
  }, [
    buildPerfMetadata,
    snapshotVersionSig.length,
    snapshotVersionState.nonZeroSnapshotVersionWalletCount,
    snapshotVersionState.walletSnapshotVersionEntryCount,
    snapshotVersionState.zeroSnapshotVersionWalletCount,
    sortedWalletIds.length,
  ]);

  useEffect(() => {
    const detail = selectedCachedTimeframeStatusDetails;
    const signature = [
      selectedTimeframe,
      detail.status,
      detail.reason,
      detail.builtAtAgeMs ?? 'na',
      detail.cachedWalletCount,
      detail.currentWalletCount,
      detail.cachedSnapshotVersionSigLength,
      detail.currentSnapshotVersionSigLength,
      detail.historicalDepCount,
      detail.missingHistoricalDepCount,
      detail.lastTsChangedHistoricalDepCount,
      detail.fetchedOnOnlyChangedHistoricalDepCount,
      detail.hasRenderableSeries,
      detail.renderablePointCount,
      detail.spotRateChanged,
      detail.spotRatePatchable,
      snapshotVersionState.walletSnapshotVersionEntryCount,
      snapshotVersionState.zeroSnapshotVersionWalletCount,
      snapshotVersionState.nonZeroSnapshotVersionWalletCount,
    ].join('|');

    if (previousSelectedCachedStatusDetailSigRef.current === signature) {
      return;
    }

    previousSelectedCachedStatusDetailSigRef.current = signature;

    recordPerfEvent(
      'balance_chart.selected_cached_status_reason',
      buildPerfMetadata({
        builtAtAgeMs: detail.builtAtAgeMs,
        cachedSnapshotVersionSigLength: detail.cachedSnapshotVersionSigLength,
        cachedWalletCount: detail.cachedWalletCount,
        currentSnapshotVersionSigLength:
          detail.currentSnapshotVersionSigLength,
        currentWalletCount: detail.currentWalletCount,
        fetchedOnOnlyChangedHistoricalDepCount:
          detail.fetchedOnOnlyChangedHistoricalDepCount,
        hasRenderableSeries: detail.hasRenderableSeries,
        historicalDepCount: detail.historicalDepCount,
        lastTsChangedHistoricalDepCount:
          detail.lastTsChangedHistoricalDepCount,
        missingHistoricalDepCount: detail.missingHistoricalDepCount,
        nonZeroSnapshotVersionWalletCount:
          snapshotVersionState.nonZeroSnapshotVersionWalletCount,
        reason: detail.reason,
        renderablePointCount: detail.renderablePointCount,
        selectedTimeframe,
        spotRateChanged: detail.spotRateChanged,
        spotRatePatchable: detail.spotRatePatchable,
        status: detail.status,
        walletSnapshotVersionEntryCount:
          snapshotVersionState.walletSnapshotVersionEntryCount,
        zeroSnapshotVersionWalletCount:
          snapshotVersionState.zeroSnapshotVersionWalletCount,
      }),
    );
  }, [
    buildPerfMetadata,
    selectedCachedTimeframeStatusDetails,
    selectedTimeframe,
    snapshotVersionState.nonZeroSnapshotVersionWalletCount,
    snapshotVersionState.walletSnapshotVersionEntryCount,
    snapshotVersionState.zeroSnapshotVersionWalletCount,
  ]);

  useEffect(() => {
    const previousRatesByRateKey = previousLiveSpotRatesByRateKeyRef.current;
    previousLiveSpotRatesByRateKeyRef.current = liveSpotRatesByRateKey;

    if (!previousRatesByRateKey) {
      return;
    }

    const rateMapChange = summarizeRateMapChange(
      previousRatesByRateKey,
      liveSpotRatesByRateKey,
    );

    if (!rateMapChange.changedRateKeyCount) {
      return;
    }

    recordPerfEvent(
      'balance_chart.live_spot_rates_changed',
      buildPerfMetadata({
        addedRateKeyCount: rateMapChange.addedRateKeyCount,
        changedRateKeyCount: rateMapChange.changedRateKeyCount,
        changedRateKeysSample: rateMapChange.changedRateKeysSample,
        largestRateDelta: rateMapChange.largestRateDelta,
        largestRateDeltaKey: rateMapChange.largestRateDeltaKey,
        nextRateKeyCount: rateMapChange.nextRateKeyCount,
        previousRateKeyCount: rateMapChange.previousRateKeyCount,
        removedRateKeyCount: rateMapChange.removedRateKeyCount,
        updatedRateKeyCount: rateMapChange.updatedRateKeyCount,
      }),
    );
  }, [buildPerfMetadata, liveSpotRatesByRateKey]);

  useEffect(() => {
    const previousInfo = previousRelevantRateCacheRevisionInfoRef.current;
    previousRelevantRateCacheRevisionInfoRef.current =
      relevantFiatRateSeriesCacheRevisionInfo;

    if (!previousInfo || previousInfo.revision === cacheRevision) {
      return;
    }

    const cacheChangeSummary = summarizeFiatRateSeriesCacheRevisionChange({
      nextState: relevantFiatRateSeriesCacheRevisionInfo.state,
      previousState: previousInfo.state,
    });
    const changedRelevantCacheKeyOwnershipSummary =
      summarizeFiatRateSeriesCacheKeyOwnership({
        cacheKeys: cacheChangeSummary.changedKeySample,
        selectedTimeframe,
        timeframes: PRECOMPUTE_TIMEFRAME_ORDER,
      });

    if (!cacheChangeSummary.changedKeyCount) {
      return;
    }

    recordPerfEvent(
      'balance_chart.relevant_rate_cache_revision_changed',
      buildPerfMetadata({
        addedRelevantCacheKeyCount: cacheChangeSummary.addedCount,
        cacheRevision,
        changedRelevantCacheKeyCount: cacheChangeSummary.changedKeyCount,
        changedRelevantCacheKeyReasonSample:
          cacheChangeSummary.changedKeyReasonSample,
        changedRelevantCacheKeyCountByInterval:
          changedRelevantCacheKeyOwnershipSummary.cacheKeyCountByInterval,
        changedRelevantCacheKeyOwnershipSample:
          changedRelevantCacheKeyOwnershipSummary.cacheKeyOwnershipSample,
        changedRelevantCacheKeysSample:
          cacheChangeSummary.changedKeySample,
        changedRelevantSelectedIntervalCacheKeyCount:
          changedRelevantCacheKeyOwnershipSummary.selectedIntervalCacheKeyCount,
        changedRelevantBackgroundCacheKeyCount:
          changedRelevantCacheKeyOwnershipSummary.backgroundCacheKeyCount,
        fetchedOnChangedRelevantCacheKeyCount:
          cacheChangeSummary.fetchedOnChangedCount,
        lastTsChangedRelevantCacheKeyCount:
          cacheChangeSummary.lastTsChangedCount,
        missingRelevantCacheKeyCount: cacheChangeSummary.missingKeyCount,
        pointCountChangedRelevantCacheKeyCount:
          cacheChangeSummary.pointCountChangedCount,
        presentRelevantCacheKeyCount: cacheChangeSummary.presentKeyCount,
        removedRelevantCacheKeyCount: cacheChangeSummary.removedCount,
        selectedTimeframe,
        selectedTimeframeCacheStatus:
          cachedTimeframeStatusByTimeframe[selectedTimeframe] || 'missing',
        selectedTimeframeSeriesInterval:
          relevantRateDependencyPlanSummary.selectedSeriesInterval,
        selectedTimeframeSharedIntervalTimeframeCount:
          relevantRateDependencyPlanSummary.selectedSeriesIntervalSharedTimeframeCount,
        selectedTimeframeSharedIntervalTimeframes:
          relevantRateDependencyPlanSummary.selectedSeriesIntervalSharedTimeframes,
        selectedTimeframeNeedsHistoricalRecompute,
        totalRelevantCacheKeyCount: cacheChangeSummary.totalKeyCount,
      }),
    );
  }, [
    buildPerfMetadata,
    cacheRevision,
    cachedTimeframeStatusByTimeframe,
    relevantFiatRateSeriesCacheRevisionInfo,
    relevantRateDependencyPlanSummary.selectedSeriesInterval,
    relevantRateDependencyPlanSummary.selectedSeriesIntervalSharedTimeframeCount,
    relevantRateDependencyPlanSummary.selectedSeriesIntervalSharedTimeframes,
    selectedTimeframe,
    selectedTimeframeNeedsHistoricalRecompute,
  ]);

  useEffect(() => {
    if (!hasAnyChartableSnapshots || !relevantFiatRateSeriesCacheKeys.length) {
      return;
    }

    recordPerfEvent(
      'balance_chart.relevant_rate_dependency_plan',
      buildPerfMetadata({
        backgroundRelevantCacheKeyCount:
          relevantRateDependencyPlanSummary.backgroundCacheKeyCount,
        precomputeTimeframeIntervalMap:
          relevantRateDependencyPlanSummary.timeframeIntervalMap,
        relevantCacheKeyCountByInterval:
          relevantRateDependencyPlanSummary.cacheKeyCountByInterval,
        relevantCacheKeyOwnershipSample:
          relevantRateDependencyPlanSummary.cacheKeyOwnershipSample,
        relevantRateCacheAssetCount: relevantRateCacheAssets.length,
        selectedRelevantCacheKeyCount:
          relevantRateDependencyPlanSummary.selectedIntervalCacheKeyCount,
        selectedTimeframe,
        selectedTimeframeSeriesInterval:
          relevantRateDependencyPlanSummary.selectedSeriesInterval,
        selectedTimeframeSharedIntervalTimeframeCount:
          relevantRateDependencyPlanSummary.selectedSeriesIntervalSharedTimeframeCount,
        selectedTimeframeSharedIntervalTimeframes:
          relevantRateDependencyPlanSummary.selectedSeriesIntervalSharedTimeframes,
        totalRelevantCacheKeyCount:
          relevantRateDependencyPlanSummary.totalCacheKeyCount,
      }),
    );
  }, [
    buildPerfMetadata,
    hasAnyChartableSnapshots,
    relevantFiatRateSeriesCacheKeys.length,
    relevantRateCacheAssets.length,
    relevantRateDependencyPlanSummary,
    selectedTimeframe,
  ]);

  useEffect(() => {
    const previousInfo = previousPrepRateCacheRevisionInfoRef.current;
    previousPrepRateCacheRevisionInfoRef.current =
      prepFiatRateSeriesCacheRevisionInfo;

    if (!previousInfo || previousInfo.revision === prepCacheRevision) {
      return;
    }

    const prepCacheChangeSummary = summarizeFiatRateSeriesCacheRevisionChange({
      nextState: prepFiatRateSeriesCacheRevisionInfo.state,
      previousState: previousInfo.state,
    });

    if (!prepCacheChangeSummary.changedKeyCount) {
      return;
    }

    recordPerfEvent(
      'balance_chart.prep_rate_cache_revision_changed',
      buildPerfMetadata({
        addedPrepCacheKeyCount: prepCacheChangeSummary.addedCount,
        changedPrepCacheKeyCount: prepCacheChangeSummary.changedKeyCount,
        changedPrepCacheKeyReasonSample:
          prepCacheChangeSummary.changedKeyReasonSample,
        changedPrepCacheKeysSample: prepCacheChangeSummary.changedKeySample,
        fetchedOnChangedPrepCacheKeyCount:
          prepCacheChangeSummary.fetchedOnChangedCount,
        lastTsChangedPrepCacheKeyCount:
          prepCacheChangeSummary.lastTsChangedCount,
        missingPrepCacheKeyCount: prepCacheChangeSummary.missingKeyCount,
        pointCountChangedPrepCacheKeyCount:
          prepCacheChangeSummary.pointCountChangedCount,
        prepCacheRevision,
        preparedInputsTargetRevision,
        presentPrepCacheKeyCount: prepCacheChangeSummary.presentKeyCount,
        removedPrepCacheKeyCount: prepCacheChangeSummary.removedCount,
        totalPrepCacheKeyCount: prepCacheChangeSummary.totalKeyCount,
      }),
    );
  }, [
    buildPerfMetadata,
    prepCacheRevision,
    prepFiatRateSeriesCacheRevisionInfo,
    preparedInputsTargetRevision,
  ]);

  useEffect(() => {
    if (!isActive) {
      return;
    }
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
  }, [cachedScope, dispatch, isActive, scopeId]);

  useEffect(() => {
    if (!isActive) {
      return;
    }
    if (!cachedScope) {
      return;
    }

    const {patchedTimeframes, hydratedTimeframes, selectedHydratedSeries} =
      measurePerfSync(
        'balance_chart.hydrate_cached_scope',
        () =>
          buildHydratedBalanceChartTimeframes<ComputedSeries>({
            timeframes: cachedScope.timeframes,
            timeframeOrder: PRECOMPUTE_TIMEFRAME_ORDER,
            selectedTimeframe,
            cachedStatusByTimeframe: cachedTimeframeStatusByTimeframe,
            currentSpotRatesByRateKey,
            deserializeTimeframe: deserializeCachedTimeframeToComputedSeries,
            getTimeframeRevision,
          }),
        buildPerfMetadata({
          cachedTimeframeCount: cachedScope.timeframes.length,
          selectedTimeframe,
        }),
      );

    startTransition(() => {
      dispatchTimeframeState({
        type: 'mergeHydratedSeries',
        updates: hydratedTimeframes,
      });

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
    buildPerfMetadata,
    cachedScope,
    cachedTimeframeStatusByTimeframe,
    currentSpotRatesByRateKey,
    dispatch,
    getTimeframeRevision,
    isActive,
    scopeId,
    selectedTimeframe,
  ]);

  const hasAnalysisPreparationError =
    analysisInputsErrorRevision === preparedInputsTargetRevision;

  const inputsReady =
    shouldPrepareAnalysisInputs &&
    !!fiatRateSeriesCache &&
    analysisInputs.wallets.length > 0 &&
    analysisInputsReadyRevision === preparedInputsTargetRevision &&
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
          currentRatesByRateKey:
            Object.keys(currentSpotRatesByRateKey || {}).length > 0
              ? currentSpotRatesByRateKey
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

      let result: Awaited<ReturnType<typeof buildPnlAnalysisSeriesAsync>>;
      try {
        result = await buildAnalysis(nowMs);
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

        recordPerfEvent(
          'balance_chart.compute_fallback_now_ms',
          buildPerfMetadata({
            fallbackNowMs,
            timeframe,
          }),
        );
        result = await buildAnalysis(fallbackNowMs);
      }

      const analysisPoints = result.points || [];
      if (analysisPoints.length !== FIAT_RATE_SERIES_TARGET_POINTS) {
        throw new Error(
          `Unexpected analysis point count: ${analysisPoints.length} (expected ${FIAT_RATE_SERIES_TARGET_POINTS})`,
        );
      }

      const rawGraphPoints: GraphPoint[] = analysisPoints.map(point => ({
        date: new Date(point.timestamp),
        value: point.totalFiatBalance + balanceOffset,
      }));
      const graphPoints = normalizeGraphPointsForChart(rawGraphPoints);
      const pointByTimestamp = new Map<number, PnlAnalysisPoint>();
      for (let i = 0; i < graphPoints.length; i++) {
        pointByTimestamp.set(graphPoints[i].date.getTime(), analysisPoints[i]);
      }

      const {minIndex, maxIndex, minPoint, maxPoint} =
        resolveBalanceChartSeriesExtrema({
          graphPoints,
          balanceOffset,
          exactExtrema: result.exactExtrema,
        });

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
        exactExtrema: result.exactExtrema,
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
      buildPerfMetadata,
      currentSpotRatesByRateKey,
      fiatRateSeriesCache,
      snapshotVersionSig,
      sortedWalletIds,
    ],
  );

  const getComputeDispositionForTimeframe = useCallback(
    (
      timeframe: FiatRateInterval,
      retryPolicy: 'retry_interrupted_attempts' | 'suppress_after_attempt',
    ) => {
      const cachedStatus =
        cachedTimeframeStatusByTimeframe[timeframe] || 'missing';
      const timeframeRevision = getTimeframeRevision(timeframe);
      const attemptRevision = getTimeframeAttemptRevision(timeframe);

      return getTimeframeComputeDisposition({
        cachedStatus,
        timeframeRevision,
        attemptRevision,
        timeframeState: timeframeStateByTimeframe[timeframe],
        hasAnySnapshots: hasAnyChartableSnapshots,
        inputsReady,
        retryPolicy,
      });
    },
    [
      cachedTimeframeStatusByTimeframe,
      getTimeframeAttemptRevision,
      getTimeframeRevision,
      hasAnyChartableSnapshots,
      inputsReady,
      timeframeStateByTimeframe,
    ],
  );

  const {
    ensureTimeframeComputed,
    queueTimeframeCompute,
    retainOnlyQueuedTimeframe,
    resetComputeQueue,
  } = useBalanceHistoryChartComputeQueue<ComputedSeries, ChangeRowData>({
    balanceOffset,
    buildPerfMetadata,
    computeGenerationRef,
    computeSeriesForTimeframe,
    dispatch,
    dispatchTimeframeState,
    getComputeDispositionForTimeframe,
    getTimeframeAttemptRevision,
    getTimeframeRevision,
    onComputeError: logBalanceHistoryChartError,
    scopeId,
    selectedTimeframe,
    setDisplayState,
    sortedWalletIds,
    trackScheduledHandle,
  });

  const invalidateComputeGeneration = useCallback(() => {
    computeGenerationRef.current += 1;
    cancelAllScheduledWork();
    resetComputeQueue();
    return computeGenerationRef.current;
  }, [cancelAllScheduledWork, resetComputeQueue]);

  useEffect(() => {
    return () => {
      invalidateComputeGeneration();
    };
  }, [invalidateComputeGeneration]);

  useEffect(() => {
    if (isActive) {
      return;
    }

    const generation = invalidateComputeGeneration();
    recordPerfEvent(
      'balance_chart.inactive_pause',
      buildPerfMetadata({
        generation,
      }),
    );
  }, [buildPerfMetadata, invalidateComputeGeneration, isActive]);

  const selectedTimeframeRevision = getTimeframeRevision(selectedTimeframe);
  const selectedTimeframeAttemptRevision =
    getTimeframeAttemptRevision(selectedTimeframe);
  const selectedTimeframeState = timeframeStateByTimeframe[selectedTimeframe];
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

    const effectiveCachedTimeframe = getEffectiveCachedBalanceChartTimeframe({
      cachedTimeframe,
      status: cachedTimeframeStatusByTimeframe[selectedTimeframe] || 'missing',
      currentSpotRatesByRateKey,
    });

    return deserializeCachedTimeframeToComputedSeries(effectiveCachedTimeframe);
  }, [
    cachedScope?.timeframes,
    cachedTimeframeStatusByTimeframe,
    currentSpotRatesByRateKey,
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

  const {
    displayedChangeRowData,
    clearSelection,
    onGestureStarted,
    onGestureEnded,
    onPointSelected,
  } = useBalanceHistoryChartSelectionState({
    activeSeries,
    cachedSelectedSeries,
    selectedTimeframe,
    displayedTimeframe,
    rangeLabel,
    quoteCurrency,
    balanceOffset,
    timeframeStateByTimeframe,
    dispatchTimeframeState,
    onSelectedBalanceChangeRef,
    onChangeRowData,
  });

  const {MaxAxisLabel, MinAxisLabel} = useStableBalanceHistoryChartAxisLabels({
    activeSeries,
    axisLabelOpacity,
    quoteCurrency,
  });

  const ensureTimeframeComputedRef = useRef(ensureTimeframeComputed);
  useEffect(() => {
    ensureTimeframeComputedRef.current = ensureTimeframeComputed;
  }, [ensureTimeframeComputed]);

  useEffect(() => {
    const previousGenerationInputs = previousGenerationInputsRef.current;
    previousGenerationInputsRef.current = {
      cacheRevision,
      liveSpotRatesRevision,
      preparedInputsTargetRevision,
    };
    const cacheRevisionChanged =
      !!previousGenerationInputs &&
      previousGenerationInputs.cacheRevision !== cacheRevision;
    const liveSpotRatesRevisionChanged =
      !!previousGenerationInputs &&
      previousGenerationInputs.liveSpotRatesRevision !== liveSpotRatesRevision;
    const preparedInputsTargetRevisionChanged =
      !!previousGenerationInputs &&
      previousGenerationInputs.preparedInputsTargetRevision !==
        preparedInputsTargetRevision;
    const changedInputKinds = previousGenerationInputs
      ? [
          cacheRevisionChanged ? 'cache_revision' : undefined,
          liveSpotRatesRevisionChanged ? 'live_spot_rates' : undefined,
          preparedInputsTargetRevisionChanged ? 'prepared_inputs' : undefined,
        ].filter(Boolean)
      : ['initial_mount'];
    const shouldAdvanceGeneration =
      !previousGenerationInputs || preparedInputsTargetRevisionChanged;
    const generation = shouldAdvanceGeneration
      ? invalidateComputeGeneration()
      : computeGenerationRef.current;
    recordPerfEvent(
      'balance_chart.compute_generation_advanced',
      buildPerfMetadata({
        cacheRevisionChanged,
        cacheRevision,
        changedInputKinds,
        generation,
        generationAdvanced: shouldAdvanceGeneration,
        liveSpotRatesRevisionChanged,
        liveSpotRatesRevision,
        preparedInputsTargetRevisionChanged,
        preparedInputsTargetRevision,
      }),
    );
    if (shouldAdvanceGeneration) {
      startTransition(() => {
        dispatchTimeframeState({
          type: 'advanceGeneration',
          generation,
        });
      });
    }
  }, [
    buildPerfMetadata,
    cacheRevision,
    computeGenerationRef,
    liveSpotRatesRevision,
    invalidateComputeGeneration,
    preparedInputsTargetRevision,
  ]);

  // Reset only when the chart scope changes (wallet set / quote / balance offset).
  useEffect(() => {
    const generation = invalidateComputeGeneration();
    recordPerfEvent(
      'balance_chart.scope_reset',
      buildPerfMetadata({
        generation,
      }),
    );
    analysisHistoricalDepKeysRef.current = new Set();
    lastTouchedScopeIdRef.current = undefined;
    analysisInputsReadyRevisionRef.current = undefined;
    setAnalysisInputs(EMPTY_ANALYSIS_INPUTS(quoteCurrency));
    setAnalysisInputsReadyRevision(undefined);
    setAnalysisInputsErrorRevision(undefined);
    setHasCompletedInitialInteractiveLoad(false);
    dispatchTimeframeState({
      type: 'resetAll',
      generation,
    });
    clearSelection();
    setDisplayState(undefined);
  }, [
    buildPerfMetadata,
    clearSelection,
    invalidateComputeGeneration,
    quoteCurrency,
    scopeId,
  ]);

  useEffect(() => {
    let prepareHandle: ScheduledAfterInteractionsHandle | undefined;
    let prepareSpan:
      | ReturnType<typeof startPerfSpan>
      | undefined;
    const shouldResetPreparedInputs =
      analysisInputsReadyRevisionRef.current !== preparedInputsTargetRevision;

    if (!isActive) {
      return;
    }

    if (!hasAnyChartableSnapshots || !shouldPrepareAnalysisInputs) {
      setAnalysisInputs(EMPTY_ANALYSIS_INPUTS(quoteCurrency));
      analysisHistoricalDepKeysRef.current = new Set();
      analysisInputsReadyRevisionRef.current = undefined;
      setAnalysisInputsReadyRevision(undefined);
      setAnalysisInputsErrorRevision(undefined);
      return;
    }

    // Preparing analysis inputs is scheduled work. Generation invalidations
    // cancel all scheduled work, so re-run this effect when the generation
    // changes and skip rescheduling when the current target is already ready.
    if (inputsReady) {
      return;
    }

    if (shouldResetPreparedInputs) {
      setAnalysisInputs(EMPTY_ANALYSIS_INPUTS(quoteCurrency));
      analysisInputsReadyRevisionRef.current = undefined;
      setAnalysisInputsReadyRevision(undefined);
      setAnalysisInputsErrorRevision(undefined);
    }

    const generation = computeGenerationRef.current;
    const prepareQueuedAtMs = getPerfClockNowMs();
    recordPerfEvent(
      'balance_chart.prepare_enqueued',
      buildPerfMetadata({
        generation,
        preparedInputsTargetRevision,
        selectedTimeframe,
      }),
    );
    prepareHandle = scheduleAfterInteractionsAndFrames({
      callback: async signal => {
        const prepareStartedAtMs = getPerfClockNowMs();
        prepareSpan = startPerfSpan(
          'balance_chart.prepare_inputs',
          buildPerfMetadata({
            generation,
            preparedInputsTargetRevision,
            queueWaitMs: prepareStartedAtMs - prepareQueuedAtMs,
            selectedTimeframe,
          }),
        );
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
          prepareSpan.cancel({
            historicalRateDependencyCount: historicalDepKeys.size,
            reason: 'generation_changed',
          });
          return;
        }

        const didPrepareWallets = prepared.wallets.length > 0;
        const nextReadyRevision = didPrepareWallets
          ? preparedInputsTargetRevision
          : undefined;
        analysisHistoricalDepKeysRef.current = historicalDepKeys;
        analysisInputsReadyRevisionRef.current = nextReadyRevision;
        if (!didPrepareWallets) {
          prepareSpan.finish({
            historicalRateDependencyCount: historicalDepKeys.size,
            preparedWalletCount: 0,
          });
          logBalanceHistoryChartError(
            'prepare produced no wallets',
            new Error('Prepared analysis inputs were empty.'),
          );
        } else {
          prepareSpan.finish({
            historicalRateDependencyCount: historicalDepKeys.size,
            preparedWalletCount: prepared.wallets.length,
          });
        }
        startTransition(() => {
          if (computeGenerationRef.current !== generation) {
            return;
          }

          if (!didPrepareWallets) {
            setAnalysisInputs(EMPTY_ANALYSIS_INPUTS(prepared.quoteCurrency));
            setAnalysisInputsReadyRevision(undefined);
            setAnalysisInputsErrorRevision(preparedInputsTargetRevision);
            return;
          }

          setAnalysisInputs(prepared);
          setAnalysisInputsReadyRevision(nextReadyRevision);
          setAnalysisInputsErrorRevision(undefined);
        });
      },
      onError: error => {
        if (
          computeGenerationRef.current !== generation ||
          isAbortError(error)
        ) {
          prepareSpan?.cancel({
            reason: isAbortError(error) ? 'aborted' : 'generation_changed',
          });
          return;
        }

        prepareSpan?.fail(error);
        logBalanceHistoryChartError('prepare failed', error);
        analysisHistoricalDepKeysRef.current = new Set();
        analysisInputsReadyRevisionRef.current = undefined;
        startTransition(() => {
          if (computeGenerationRef.current !== generation) {
            return;
          }

          setAnalysisInputs(EMPTY_ANALYSIS_INPUTS(quoteCurrency));
          setAnalysisInputsReadyRevision(undefined);
          setAnalysisInputsErrorRevision(preparedInputsTargetRevision);
        });
      },
    });
    trackScheduledHandle(prepareHandle);

    return () => {
      removeScheduledHandle(prepareHandle, true);
    };
  }, [
    buildPerfMetadata,
    hasAnyChartableSnapshots,
    inputsReady,
    isActive,
    preparedInputsTargetRevision,
    quoteCurrency,
    rates,
    scopedSnapshotsByWalletId,
    scopedWallets,
    shouldPrepareAnalysisInputs,
    timeframeState.generation,
    trackScheduledHandle,
    removeScheduledHandle,
  ]);

  // On timeframe change, keep the previously rendered series visible while
  // the new timeframe computes (shown with reduced opacity behind loader).
  // IMPORTANT: depend ONLY on timeframe/balanceOffset so we don't re-run on
  // every render due to callback identity or internal helper identity changes.
  useEffect(() => {
    if (!isActive) {
      return;
    }

    clearSelection();
    retainOnlyQueuedTimeframe(selectedTimeframe);

    // Compute selected timeframe (if possible) after painting.
    ensureTimeframeComputedRef.current(selectedTimeframe, {prioritize: true});
  }, [
    balanceOffset,
    clearSelection,
    isActive,
    retainOnlyQueuedTimeframe,
    selectedTimeframe,
  ]);

  // When inputs become ready, or a revision invalidates an in-flight compute,
  // retry the selected timeframe so first-render loaders do not get stuck on
  // aborted attempts.
  useEffect(() => {
    if (!isActive) {
      return;
    }

    if (!inputsReady) {
      return;
    }

    // Compute only the selected timeframe to avoid background JS work
    // freezing selector interactions.
    ensureTimeframeComputed(selectedTimeframe, {prioritize: true});
  }, [
    cacheRevision,
    ensureTimeframeComputed,
    inputsReady,
    isActive,
    liveSpotRatesRevision,
    selectedTimeframe,
  ]);

  // Opportunistically precompute additional timeframes in background so taps
  // switch instantly more often and avoid heavy foreground work.
  useEffect(() => {
    if (!isActive || !enableBackgroundPrecompute) {
      return;
    }
    if (!inputsReady || !hasAnyChartableSnapshots) {
      return;
    }
    if (!hasCompletedInitialInteractiveLoad) {
      return;
    }

    const nextToPrecompute = PRECOMPUTE_TIMEFRAME_ORDER.find(timeframe => {
      if (timeframe === selectedTimeframe) {
        return false;
      }

      return getComputeDispositionForTimeframe(
        timeframe,
        'suppress_after_attempt',
      ).shouldQueue;
    });

    if (!nextToPrecompute) {
      return;
    }

    queueTimeframeCompute(nextToPrecompute, false);
  }, [
    enableBackgroundPrecompute,
    getComputeDispositionForTimeframe,
    hasAnyChartableSnapshots,
    hasCompletedInitialInteractiveLoad,
    inputsReady,
    isActive,
    queueTimeframeCompute,
    selectedTimeframe,
  ]);

  const timeframeSelectorOpacityIsSharedValue = isNumberSharedValue(
    timeframeSelectorOpacity,
  );
  const sharedTimeframeSelectorOpacity = timeframeSelectorOpacityIsSharedValue
    ? timeframeSelectorOpacity
    : undefined;
  const timeframeSelectorOpacityNumber =
    typeof timeframeSelectorOpacity === 'number' &&
    Number.isFinite(timeframeSelectorOpacity)
      ? timeframeSelectorOpacity
      : 1;
  const timeframeSelectorAnimatedStyle = useAnimatedStyle(() => {
    const sharedOpacity = sharedTimeframeSelectorOpacity?.value;
    return {
      opacity:
        typeof sharedOpacity === 'number' && Number.isFinite(sharedOpacity)
          ? sharedOpacity
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
  const isChartLoadingRaw =
    hasAnyChartableSnapshots && isSelectedTimeframePending;

  useEffect(() => {
    if (hasRenderableSelectedSeries && !hasCompletedInitialInteractiveLoad) {
      setHasCompletedInitialInteractiveLoad(true);
    }

    if (!isChartLoadingRaw) {
      setIsChartLoaderVisible(false);
      return;
    }

    const isInitialInteractiveLoad = !hasCompletedInitialInteractiveLoad;
    if (isInitialInteractiveLoad) {
      setIsChartLoaderVisible(true);
      return;
    }

    setIsChartLoaderVisible(false);
    const timer = setTimeout(() => {
      setIsChartLoaderVisible(true);
    }, CHART_LOADER_DELAY_MS);

    return () => clearTimeout(timer);
  }, [
    hasCompletedInitialInteractiveLoad,
    hasRenderableSelectedSeries,
    isChartLoadingRaw,
  ]);

  const hideGuideLineForInitialInteractiveLoader =
    !hasCompletedInitialInteractiveLoad && isChartLoaderVisible;
  const hasAnyRenderableSeries =
    !!activeSeries ||
    Object.values(timeframeStateByTimeframe).some(
      state => !!state?.series?.graphPoints.length,
    );

  // Rare render invalidation races can leave the selected timeframe with no
  // renderable series and no active compute. Keep the chart self-healing by
  // re-queuing the selected timeframe after a short delay whenever the loader
  // is visible and nothing is actively computing it.
  useEffect(() => {
    if (
      !isActive ||
      !isChartLoadingRaw ||
      !inputsReady ||
      !!selectedTimeframeError ||
      hasAnalysisPreparationError ||
      selectedTimeframeState?.isComputing
    ) {
      return;
    }

    const retryTimer = setTimeout(() => {
      ensureTimeframeComputed(selectedTimeframe, {prioritize: true});
    }, CHART_LOADER_DELAY_MS);

    return () => clearTimeout(retryTimer);
  }, [
    ensureTimeframeComputed,
    hasAnalysisPreparationError,
    inputsReady,
    isActive,
    isChartLoadingRaw,
    selectedTimeframe,
    selectedTimeframeError,
    selectedTimeframeState?.isComputing,
  ]);

  const chartColor = lineColor || (theme.dark ? LinkBlue : Action);
  const gradientBackgroundColor =
    gradientStartColor || (theme.dark ? 'transparent' : White);

  // If there are no chartable snapshots, hide chart UI but still allow callers
  // to render any pre-chart badges/content. Preserve the legacy skeleton only
  // when a mainnet wallet in scope is still waiting for its first snapshots;
  // testnet-only scopes should stay hidden even before snapshots exist.
  if (!hasAnyChartableSnapshots) {
    if (showLoaderWhenNoSnapshots && hasAnyMainnetWallet && !hasAnySnapshots) {
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
        showFirstPointGuideLine={!hideGuideLineForInitialInteractiveLoader}
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
            onSelect={timeframe => {
              clearSelection();
              recordPerfEvent(
                'balance_chart.timeframe_selected',
                buildPerfMetadata({
                  nextTimeframe: timeframe,
                  previousTimeframe: selectedTimeframe,
                }),
              );
              onSelectedTimeframeChange?.(timeframe);
              setSelectedTimeframe(timeframe);
            }}
          />
        </Animated.View>
      ) : null}
    </>
  );
};

export default BalanceHistoryChart;
