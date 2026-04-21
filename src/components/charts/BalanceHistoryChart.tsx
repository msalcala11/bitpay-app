import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {StyleProp, View, ViewStyle} from 'react-native';
import {useTranslation} from 'react-i18next';
import {useTheme} from 'styled-components/native';
import type {GraphPoint} from 'react-native-graph';
import Animated, {useAnimatedStyle} from 'react-native-reanimated';
import type {FiatRateInterval, Rates} from '../../store/rate/rate.models';
import {FIAT_RATE_SERIES_TARGET_POINTS} from '../../store/rate/rate.models';
import type {Wallet} from '../../store/wallet/wallet.models';
import {HISTORIC_RATES_CACHE_DURATION} from '../../constants/wallet';
import {
  DEFAULT_BALANCE_CHART_TIMEFRAME,
  getFiatChartTimeframeOptions,
  getRangeLabelForFiatTimeframe,
  formatRangeOrSelectedPointLabel,
} from './fiatTimeframes';
import TimeframeSelector from './TimeframeSelector';
import InteractiveLineChart from './InteractiveLineChart';
import ChartSelectionDot from './ChartSelectionDot';
import ChartChangeRow from './ChartChangeRow';
import {Action, LinkBlue, White} from '../../styles/colors';
import {useAppDispatch} from '../../utils/hooks';
import {isNumberSharedValue, type NumberSharedValue} from './sharedValueGuards';
import {
  touchBalanceChartScope,
  upsertBalanceChartScopeTimeframes,
} from '../../store/portfolio-charts';
import {
  getCachedBalanceChartTimeframe,
  type HydratedBalanceChartSeries,
} from '../../utils/portfolio/chartCache';
import {
  buildBalanceHistoryChartChangeRowData,
  getDisplayedBalanceHistoryAnalysisPoint,
  getSelectedBalanceHistoryValue,
  type ChangeRowData,
} from './balanceHistoryChartSelection';
import {useStableBalanceHistoryChartAxisLabels} from './useStableBalanceHistoryChartAxisLabels';
import {runPortfolioChartQuery} from '../../portfolio/ui/common';
import {usePortfolioBalanceChartScope} from '../../portfolio/ui/hooks/usePortfolioBalanceChartScope';
import usePortfolioHistoricalRateDepsCache from '../../portfolio/ui/hooks/usePortfolioHistoricalRateDepsCache';
import {formatUnknownError} from '../../utils/errors/formatUnknownError';
import haptic from '../haptic-feedback/haptic';
import {
  areBalanceChartHistoricalRatesReady,
  buildBalanceChartHistoricalRateDeps,
  buildBalanceChartHistoricalRateRequests,
  buildCachedTimeframeFromRuntimeChart,
  buildHydratedSeriesFromRuntimeChart,
  getBalanceChartHistoricalRateCacheKeys,
  getBalanceChartHistoricalRateCacheRevision,
  resolveCachedBalanceChartSeries,
} from '../../utils/portfolio/balanceChartData';

export type BalanceHistoryChartProps = {
  wallets: Wallet[];
  quoteCurrency: string;
  initialSelectedTimeframe?: FiatRateInterval;
  rates?: Rates;
  lineColor?: string;
  lineThickness?: number;
  strokeScale?: number | NumberSharedValue;
  minStrokeScale?: number;
  gradientStartColor?: string;
  showLoaderWhenNoSnapshots?: boolean;
  balanceOffset?: number;
  onSelectedBalanceChange?: (balance?: number) => void;
  preChartContent?: React.ReactNode;
  preChartContentTopMargin?: number;
  changeRowStyle?: StyleProp<ViewStyle>;
  showChangeRow?: boolean;
  showTimeframeSelector?: boolean;
  timeframeSelectorOpacity?: number | NumberSharedValue;
  timeframeSelectorHorizontalInset?: string;
  timeframeSelectorWidth?: number;
  disablePanGesture?: boolean;
  onChangeRowData?: (data: {
    percent: number;
    deltaFiatFormatted?: string;
    rangeLabel?: string;
  } | undefined) => void;
  onDisplayedAnalysisPointChange?: (point?: {
    timestamp?: number;
    totalFiatBalance?: number;
    totalPnlChange?: number;
    totalPnlPercent?: number;
  }) => void;
  onDiagnosticsChange?: (diagnostics: BalanceHistoryChartDiagnostics) => void;
  axisLabelOpacity?: number | NumberSharedValue;
  onSelectedTimeframeChange?: (timeframe: FiatRateInterval) => void;
  onSelectionActiveChange?: (active: boolean) => void;
};

export type BalanceHistoryChartDiagnostics = {
  timeframe: FiatRateInterval;
  displayedTimeframe: FiatRateInterval;
  queryRevisionKey: string;
  quoteCurrency: string;
  storedWalletRequestSig: string;
  currentRatesSignature: string;
  currentSpotRatesSignature: string;
  cachedSelectedTimeframeStatus?: string;
  loading: boolean;
  hasRenderableSeries: boolean;
  selectionActive: boolean;
  renderedSeriesPointsCount: number;
  renderedSeriesFirstPoint?: {
    timestamp?: number;
    totalFiatBalance?: number;
    totalPnlChange?: number;
    totalPnlPercent?: number;
  };
  renderedSeriesLastPoint?: {
    timestamp?: number;
    totalFiatBalance?: number;
    totalPnlChange?: number;
    totalPnlPercent?: number;
  };
  displayedAnalysisPoint?: {
    timestamp?: number;
    totalFiatBalance?: number;
    totalPnlChange?: number;
    totalPnlPercent?: number;
  };
};

type DisplayState = {
  series: HydratedBalanceChartSeries;
  timeframe: FiatRateInterval;
  queryRevisionKey: string;
  quoteCurrency: string;
};

const PENDING_CHART_OVERLAY_DELAY_MS = 120;

const BalanceHistoryChart = ({
  wallets,
  quoteCurrency,
  initialSelectedTimeframe = DEFAULT_BALANCE_CHART_TIMEFRAME,
  rates: _rates,
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
  onDisplayedAnalysisPointChange,
  onDiagnosticsChange,
  axisLabelOpacity = 1,
  onSelectedTimeframeChange,
  onSelectionActiveChange,
}: BalanceHistoryChartProps): React.ReactElement | null => {
  const {t} = useTranslation();
  const theme = useTheme();
  const dispatch = useAppDispatch();
  const {
    asOfMs,
    cachedScope,
    chartDataRevisionSig,
    currentRatesByAssetId,
    currentRatesSignature,
    currentSpotRatesByRateKey,
    currentSpotRatesSignature,
    quoteCurrency: committedQueryQuoteCurrency,
    scopeId,
    sortedWalletIds,
    storedWalletRequestSig,
    storedWallets,
  } = usePortfolioBalanceChartScope({
    wallets,
    balanceOffset,
    quoteCurrency,
    rates: _rates,
  });

  const [selectedTimeframe, setSelectedTimeframe] = useState<FiatRateInterval>(
    initialSelectedTimeframe,
  );
  const [displayState, setDisplayState] = useState<DisplayState | undefined>();
  const [selectedPoint, setSelectedPoint] = useState<GraphPoint | undefined>();
  const [loading, setLoading] = useState(false);
  const [pendingOverlayVisible, setPendingOverlayVisible] = useState(false);
  const [error, setError] = useState<Error | undefined>();
  const activeRequestIdRef = useRef(0);
  const gestureStartedRef = useRef(false);
  const lastHapticPointTsRef = useRef<number | undefined>(undefined);
  const pendingSelectedTimestampRef = useRef<number | undefined>(undefined);
  const shouldPreserveSelectionOnQueryRef = useRef(true);
  const selectedPointRef = useRef<GraphPoint | undefined>(undefined);
  const onSelectedBalanceChangeRef = useRef(onSelectedBalanceChange);
  const onSelectionActiveChangeRef = useRef(onSelectionActiveChange);

  useEffect(() => {
    onSelectedBalanceChangeRef.current = onSelectedBalanceChange;
  }, [onSelectedBalanceChange]);

  useEffect(() => {
    onSelectionActiveChangeRef.current = onSelectionActiveChange;
  }, [onSelectionActiveChange]);

  useEffect(() => {
    selectedPointRef.current = selectedPoint;
  }, [selectedPoint]);

  useEffect(() => {
    setSelectedTimeframe(initialSelectedTimeframe);
  }, [initialSelectedTimeframe]);

  const cachedSelectedTimeframe = useMemo(() => {
    return getCachedBalanceChartTimeframe(
      cachedScope?.timeframes,
      selectedTimeframe,
    );
  }, [cachedScope?.timeframes, selectedTimeframe]);

  const historicalRateRequests = useMemo(() => {
    return buildBalanceChartHistoricalRateRequests({
      wallets: storedWallets,
      quoteCurrency: committedQueryQuoteCurrency,
      timeframes: [selectedTimeframe],
    });
  }, [committedQueryQuoteCurrency, selectedTimeframe, storedWallets]);

  const {
    cache: fiatRateSeriesCache,
    error: fiatRateSeriesCacheError,
    loading: fiatRateSeriesCacheLoading,
  } = usePortfolioHistoricalRateDepsCache({
    wallets: storedWallets,
    quoteCurrency: committedQueryQuoteCurrency,
    timeframes: [selectedTimeframe],
    maxAgeMs: HISTORIC_RATES_CACHE_DURATION * 1000,
    enabled:
      !!committedQueryQuoteCurrency &&
      historicalRateRequests.some(group => group.requests.length > 0),
  });

  const historicalRateDepKeys = useMemo(() => {
    return getBalanceChartHistoricalRateCacheKeys({
      wallets: storedWallets,
      quoteCurrency: committedQueryQuoteCurrency,
      timeframes: [selectedTimeframe],
    });
  }, [committedQueryQuoteCurrency, selectedTimeframe, storedWallets]);

  const historicalRateCacheReady = useMemo(() => {
    return (
      !historicalRateDepKeys.length ||
      areBalanceChartHistoricalRatesReady({
        depKeys: historicalRateDepKeys,
        fiatRateSeriesCache,
      })
    );
  }, [fiatRateSeriesCache, historicalRateDepKeys]);

  const historicalRateCacheRevision = useMemo(() => {
    return getBalanceChartHistoricalRateCacheRevision({
      depKeys: historicalRateDepKeys,
      fiatRateSeriesCache,
    });
  }, [fiatRateSeriesCache, historicalRateDepKeys]);

  const historicalRateDeps = useMemo(() => {
    return buildBalanceChartHistoricalRateDeps({
      wallets: storedWallets,
      quoteCurrency: committedQueryQuoteCurrency,
      timeframes: [selectedTimeframe],
      fiatRateSeriesCache,
    });
  }, [
    committedQueryQuoteCurrency,
    fiatRateSeriesCache,
    selectedTimeframe,
    storedWallets,
  ]);

  const cachedSelectedSeriesResult = useMemo(() => {
    return resolveCachedBalanceChartSeries({
      cachedTimeframe: cachedSelectedTimeframe,
      currentSpotRatesByRateKey,
      dataRevisionSig: chartDataRevisionSig,
      asOfMs,
      fiatRateSeriesCache: historicalRateCacheReady
        ? fiatRateSeriesCache
        : undefined,
    });
  }, [
    asOfMs,
    cachedSelectedTimeframe,
    chartDataRevisionSig,
    currentSpotRatesByRateKey,
    fiatRateSeriesCache,
    historicalRateCacheReady,
  ]);
  const cachedSelectedTimeframeStatus = cachedSelectedSeriesResult.status;
  const cachedSelectedSeries = cachedSelectedSeriesResult.series;
  const committableCachedSelectedSeries =
    cachedSelectedTimeframeStatus === 'fresh' ||
    cachedSelectedTimeframeStatus === 'patchable' ||
    cachedSelectedTimeframeStatus === 'pending_historical'
      ? cachedSelectedSeries
      : undefined;

  const queryRevisionKey = useMemo(() => {
    return [
      scopeId,
      selectedTimeframe,
      chartDataRevisionSig,
      storedWalletRequestSig,
      currentRatesSignature,
      currentSpotRatesSignature,
      historicalRateCacheRevision,
    ].join('|');
  }, [
    chartDataRevisionSig,
    currentRatesSignature,
    currentSpotRatesSignature,
    historicalRateCacheRevision,
    scopeId,
    selectedTimeframe,
    storedWalletRequestSig,
  ]);

  useEffect(() => {
    if (!committableCachedSelectedSeries) {
      return;
    }

    setDisplayState(prev => {
      if (
        prev?.timeframe === selectedTimeframe &&
        prev?.series === committableCachedSelectedSeries &&
        prev?.queryRevisionKey === queryRevisionKey &&
        prev?.quoteCurrency === committedQueryQuoteCurrency
      ) {
        return prev;
      }

      return {
        series: committableCachedSelectedSeries,
        timeframe: selectedTimeframe,
        queryRevisionKey,
        quoteCurrency: committedQueryQuoteCurrency,
      };
    });
    setLoading(false);
    setError(undefined);
    dispatch(
      touchBalanceChartScope({
        scopeId,
      }),
    );
  }, [
    committableCachedSelectedSeries,
    dispatch,
    committedQueryQuoteCurrency,
    queryRevisionKey,
    scopeId,
    selectedTimeframe,
  ]);
  const chartQueryArgsRef = useRef({
    wallets: storedWallets,
    quoteCurrency: committedQueryQuoteCurrency,
    timeframe: selectedTimeframe,
    maxPoints: FIAT_RATE_SERIES_TARGET_POINTS,
    currentRatesByAssetId,
    dataRevisionSig: chartDataRevisionSig,
    walletIds: sortedWalletIds,
    asOfMs,
  });
  chartQueryArgsRef.current = {
    wallets: storedWallets,
    quoteCurrency: committedQueryQuoteCurrency,
    timeframe: selectedTimeframe,
    maxPoints: FIAT_RATE_SERIES_TARGET_POINTS,
    currentRatesByAssetId,
    dataRevisionSig: chartDataRevisionSig,
    walletIds: sortedWalletIds,
    asOfMs,
  };

  useEffect(() => {
    if (cachedSelectedSeries) {
      return;
    }

    if (
      historicalRateDepKeys.length &&
      !historicalRateCacheReady &&
      !fiatRateSeriesCacheError &&
      fiatRateSeriesCacheLoading
    ) {
      setLoading(true);
      setError(undefined);
      return;
    }

    const chartQueryArgs = chartQueryArgsRef.current;

    if (!chartQueryArgs.wallets.length) {
      setLoading(false);
      setError(undefined);
      setDisplayState(undefined);
      return;
    }

    let cancelled = false;
    const requestId = activeRequestIdRef.current + 1;
    activeRequestIdRef.current = requestId;
    setLoading(true);
    setError(undefined);

    runPortfolioChartQuery(chartQueryArgs)
      .then(chart => {
        if (cancelled || activeRequestIdRef.current !== requestId) {
          return;
        }

        const series = buildHydratedSeriesFromRuntimeChart({
          chart,
          balanceOffset,
        });

        if (!series) {
          setLoading(false);
          return;
        }

        setDisplayState({
          series,
          timeframe: chartQueryArgs.timeframe,
          queryRevisionKey,
          quoteCurrency: chartQueryArgs.quoteCurrency,
        });
        setLoading(false);

        const cacheEntry = buildCachedTimeframeFromRuntimeChart({
          chart,
          timeframe: chartQueryArgs.timeframe,
          walletIds: chartQueryArgs.walletIds,
          quoteCurrency: chartQueryArgs.quoteCurrency,
          balanceOffset,
          dataRevisionSig: chartQueryArgs.dataRevisionSig,
          historicalRateDeps,
        });
        if (!cacheEntry) {
          return;
        }

        dispatch(
          upsertBalanceChartScopeTimeframes({
            scopeId,
            walletIds: chartQueryArgs.walletIds,
            quoteCurrency: chartQueryArgs.quoteCurrency,
            balanceOffset,
            timeframes: [cacheEntry],
          }),
        );
      })
      .catch(err => {
        if (cancelled || activeRequestIdRef.current !== requestId) {
          return;
        }

        setLoading(false);
        setError(err instanceof Error ? err : new Error(String(err)));
      });

    return () => {
      cancelled = true;
    };
  }, [
    balanceOffset,
    cachedSelectedSeries,
    chartDataRevisionSig,
    dispatch,
    fiatRateSeriesCacheError,
    fiatRateSeriesCacheLoading,
    historicalRateCacheReady,
    historicalRateDepKeys.length,
    historicalRateDeps,
    queryRevisionKey,
    scopeId,
    sortedWalletIds,
  ]);

  useEffect(() => {
    shouldPreserveSelectionOnQueryRef.current = false;
    gestureStartedRef.current = false;
    lastHapticPointTsRef.current = undefined;
    pendingSelectedTimestampRef.current = undefined;
    setSelectedPoint(undefined);
    onSelectedBalanceChangeRef.current?.(undefined);
  }, [selectedTimeframe]);

  useEffect(() => {
    const activeSelectedPoint = selectedPointRef.current;
    if (shouldPreserveSelectionOnQueryRef.current && activeSelectedPoint) {
      pendingSelectedTimestampRef.current = activeSelectedPoint.date.getTime();
    }

    shouldPreserveSelectionOnQueryRef.current = true;
    gestureStartedRef.current = false;
    lastHapticPointTsRef.current = undefined;
    setSelectedPoint(undefined);
    onSelectedBalanceChangeRef.current?.(undefined);
  }, [queryRevisionKey]);

  useEffect(() => {
    onSelectionActiveChangeRef.current?.(!!selectedPoint);
  }, [selectedPoint]);

  const activeDisplayState =
    displayState?.timeframe === selectedTimeframe &&
    displayState?.queryRevisionKey === queryRevisionKey &&
    displayState?.quoteCurrency === committedQueryQuoteCurrency
      ? displayState
      : undefined;
  const staleSelectedTimeframeDisplayState =
    !activeDisplayState &&
    !committableCachedSelectedSeries &&
    displayState?.timeframe === selectedTimeframe &&
    displayState?.quoteCurrency === committedQueryQuoteCurrency
      ? displayState
      : undefined;
  const staleTimeframeDisplayState =
    !activeDisplayState &&
    !committableCachedSelectedSeries &&
    displayState?.timeframe !== selectedTimeframe &&
    displayState?.quoteCurrency === committedQueryQuoteCurrency
      ? displayState
      : undefined;
  const renderedSeries =
    activeDisplayState?.series ||
    committableCachedSelectedSeries ||
    staleSelectedTimeframeDisplayState?.series ||
    staleTimeframeDisplayState?.series;
  const displayedTimeframe =
    activeDisplayState?.timeframe ??
    (committableCachedSelectedSeries ? selectedTimeframe : undefined) ??
    staleSelectedTimeframeDisplayState?.timeframe ??
    staleTimeframeDisplayState?.timeframe ??
    selectedTimeframe;

  useEffect(() => {
    const pendingTimestamp = pendingSelectedTimestampRef.current;
    if (typeof pendingTimestamp !== 'number' || !Number.isFinite(pendingTimestamp)) {
      return;
    }
    if (!renderedSeries?.graphPoints?.length) {
      return;
    }
    if (!renderedSeries.pointByTimestamp.has(pendingTimestamp)) {
      pendingSelectedTimestampRef.current = undefined;
      return;
    }

    const matchingPoint = renderedSeries.graphPoints.find(
      point => point.date.getTime() === pendingTimestamp,
    );
    if (!matchingPoint) {
      pendingSelectedTimestampRef.current = undefined;
      return;
    }

    pendingSelectedTimestampRef.current = undefined;
    setSelectedPoint(matchingPoint);
    onSelectedBalanceChangeRef.current?.(
      getSelectedBalanceHistoryValue({
        point: matchingPoint,
        activeSeries: renderedSeries,
        balanceOffset,
      }),
    );
  }, [balanceOffset, queryRevisionKey, renderedSeries]);
  const rangeLabel = useMemo(
    () => getRangeLabelForFiatTimeframe(t, displayedTimeframe),
    [displayedTimeframe, t],
  );

  const displayedRangeMs = useMemo(() => {
    const series = renderedSeries;
    const firstTimestamp = series?.analysisPoints?.[0]?.timestamp;
    const lastTimestamp =
      series?.analysisPoints?.[(series.analysisPoints?.length || 1) - 1]
        ?.timestamp;

    return typeof firstTimestamp === 'number' &&
      typeof lastTimestamp === 'number'
      ? Math.max(0, lastTimestamp - firstTimestamp)
      : undefined;
  }, [renderedSeries]);

  const displayedAnalysisPoint = useMemo(() => {
    return getDisplayedBalanceHistoryAnalysisPoint({
      selectedPoint,
      activeSeries: renderedSeries,
      cachedSelectedSeries: renderedSeries,
    });
  }, [renderedSeries, selectedPoint]);

  const displayedChangeRowData = useMemo<ChangeRowData | undefined>(() => {
    return buildBalanceHistoryChartChangeRowData({
      displayedAnalysisPoint,
      quoteCurrency: committedQueryQuoteCurrency,
      label: formatRangeOrSelectedPointLabel({
        rangeLabel,
        selectedTimeframe: displayedTimeframe,
        selectedDate: selectedPoint?.date,
        displayedRangeMs,
      }),
    });
  }, [
    committedQueryQuoteCurrency,
    displayedAnalysisPoint,
    displayedRangeMs,
    displayedTimeframe,
    rangeLabel,
    selectedPoint?.date,
  ]);

  useEffect(() => {
    onChangeRowData?.(
      displayedChangeRowData
        ? {
            percent: displayedChangeRowData.percent,
            deltaFiatFormatted: displayedChangeRowData.deltaFiatFormatted,
            rangeLabel: displayedChangeRowData.rangeLabel,
          }
        : undefined,
    );
  }, [displayedChangeRowData, onChangeRowData]);

  useEffect(() => {
    onDisplayedAnalysisPointChange?.(
      displayedAnalysisPoint
        ? {
            timestamp: displayedAnalysisPoint.timestamp,
            totalFiatBalance: displayedAnalysisPoint.totalFiatBalance,
            totalPnlChange: displayedAnalysisPoint.totalPnlChange,
            totalPnlPercent: displayedAnalysisPoint.totalPnlPercent,
          }
        : undefined,
    );
  }, [displayedAnalysisPoint, onDisplayedAnalysisPointChange]);

  const {MaxAxisLabel, MinAxisLabel} = useStableBalanceHistoryChartAxisLabels({
    activeSeries: renderedSeries,
    axisLabelOpacity,
    quoteCurrency: committedQueryQuoteCurrency,
  });

  const chartColor = lineColor || (theme.dark ? LinkBlue : Action);
  const gradientBackgroundColor =
    gradientStartColor || (theme.dark ? 'transparent' : White);

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

  const hasRenderableSeries = !!renderedSeries?.graphPoints?.length;
  const hasAnyWallets = wallets.some(wallet => {
    const walletId = String(wallet?.id || '');
    return !!walletId && !!wallet;
  });
  const isBusy = loading;
  const shouldDelayPendingOverlay = isBusy && hasRenderableSeries;

  useEffect(() => {
    if (!shouldDelayPendingOverlay) {
      setPendingOverlayVisible(false);
      return;
    }

    const timeout = setTimeout(() => {
      setPendingOverlayVisible(true);
    }, PENDING_CHART_OVERLAY_DELAY_MS);

    return () => {
      clearTimeout(timeout);
    };
  }, [shouldDelayPendingOverlay]);

  const shouldShowLoader =
    pendingOverlayVisible ||
    (isBusy && !hasRenderableSeries) ||
    (!hasRenderableSeries &&
      showLoaderWhenNoSnapshots &&
      hasAnyWallets);

  useEffect(() => {
    const firstAnalysisPoint = renderedSeries?.analysisPoints?.[0];
    const lastAnalysisPoint =
      renderedSeries?.analysisPoints?.[
        (renderedSeries.analysisPoints?.length || 1) - 1
      ];

    onDiagnosticsChange?.({
      timeframe: selectedTimeframe,
      displayedTimeframe,
      queryRevisionKey,
      quoteCurrency: committedQueryQuoteCurrency,
      storedWalletRequestSig,
      currentRatesSignature,
      currentSpotRatesSignature,
      cachedSelectedTimeframeStatus,
      loading: isBusy,
      hasRenderableSeries,
      selectionActive: !!selectedPoint,
      renderedSeriesPointsCount: renderedSeries?.analysisPoints?.length || 0,
      renderedSeriesFirstPoint: firstAnalysisPoint
        ? {
            timestamp: firstAnalysisPoint.timestamp,
            totalFiatBalance: firstAnalysisPoint.totalFiatBalance,
            totalPnlChange: firstAnalysisPoint.totalPnlChange,
            totalPnlPercent: firstAnalysisPoint.totalPnlPercent,
          }
        : undefined,
      renderedSeriesLastPoint: lastAnalysisPoint
        ? {
            timestamp: lastAnalysisPoint.timestamp,
            totalFiatBalance: lastAnalysisPoint.totalFiatBalance,
            totalPnlChange: lastAnalysisPoint.totalPnlChange,
            totalPnlPercent: lastAnalysisPoint.totalPnlPercent,
          }
        : undefined,
      displayedAnalysisPoint: displayedAnalysisPoint
        ? {
            timestamp: displayedAnalysisPoint.timestamp,
            totalFiatBalance: displayedAnalysisPoint.totalFiatBalance,
            totalPnlChange: displayedAnalysisPoint.totalPnlChange,
            totalPnlPercent: displayedAnalysisPoint.totalPnlPercent,
          }
        : undefined,
    });
  }, [
    cachedSelectedTimeframeStatus,
    committedQueryQuoteCurrency,
    currentRatesSignature,
    currentSpotRatesSignature,
    displayedAnalysisPoint,
    displayedTimeframe,
    hasRenderableSeries,
    isBusy,
    onDiagnosticsChange,
    queryRevisionKey,
    renderedSeries,
    selectedPoint,
    selectedTimeframe,
    storedWalletRequestSig,
  ]);

  const onGestureStarted = useCallback(() => {
    if (!hasRenderableSeries) {
      return;
    }

    gestureStartedRef.current = true;
    lastHapticPointTsRef.current = undefined;
    haptic('impactLight');
  }, [hasRenderableSeries]);

  const onGestureEnded = useCallback(() => {
    if (!gestureStartedRef.current && !selectedPoint) {
      return;
    }

    gestureStartedRef.current = false;
    lastHapticPointTsRef.current = undefined;
    setSelectedPoint(undefined);
    onSelectedBalanceChangeRef.current?.(undefined);
    haptic('impactLight');
  }, [selectedPoint]);

  const onPointSelected = useCallback(
    (point: GraphPoint) => {
      if (!gestureStartedRef.current) {
        return;
      }

      const pointTs = point.date.getTime();

      setSelectedPoint(point);
      onSelectedBalanceChangeRef.current?.(
        getSelectedBalanceHistoryValue({
          point,
          activeSeries: renderedSeries,
          balanceOffset,
        }),
      );

      if (lastHapticPointTsRef.current !== pointTs) {
        haptic('impactLight');
        lastHapticPointTsRef.current = pointTs;
      }
    },
    [balanceOffset, renderedSeries],
  );

  if (!hasAnyWallets && !preChartContent) {
    return null;
  }

  if (!hasRenderableSeries && !shouldShowLoader && !preChartContent) {
    return null;
  }

  if (error && !hasRenderableSeries && __DEV__) {
    console.warn(
      '[BalanceHistoryChart] runtime query failed',
      formatUnknownError(error),
    );
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
        points={renderedSeries?.graphPoints || []}
        color={chartColor}
        lineThickness={lineThickness}
        strokeScale={strokeScale}
        minStrokeScale={minStrokeScale}
        gradientFillColors={[
          gradientBackgroundColor,
          theme.dark ? 'transparent' : White,
        ]}
        showFirstPointGuideLine={hasRenderableSeries}
        isLoading={shouldShowLoader}
        hideLineWhileLoading={!hasRenderableSeries}
        enablePanGesture={!isBusy && !disablePanGesture && hasRenderableSeries}
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
            options={getFiatChartTimeframeOptions(t)}
            selected={selectedTimeframe}
            width={timeframeSelectorWidth}
            horizontalInset={timeframeSelectorHorizontalInset}
            onSelect={timeframe => {
              if (timeframe === selectedTimeframe) {
                return;
              }
              setSelectedPoint(undefined);
              onSelectedBalanceChangeRef.current?.(undefined);
              onSelectionActiveChangeRef.current?.(false);
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
