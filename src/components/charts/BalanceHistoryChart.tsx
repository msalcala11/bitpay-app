import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {StyleProp, View, ViewStyle} from 'react-native';
import {useTranslation} from 'react-i18next';
import {useTheme} from 'styled-components/native';
import type {GraphPoint} from 'react-native-graph';
import Animated, {useAnimatedStyle} from 'react-native-reanimated';
import type {FiatRateInterval, Rates} from '../../store/rate/rate.models';
import {FIAT_RATE_SERIES_TARGET_POINTS} from '../../store/rate/rate.models';
import type {Wallet} from '../../store/wallet/wallet.models';
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
import {useAppDispatch, useAppSelector} from '../../utils/hooks';
import {isNumberSharedValue, type NumberSharedValue} from './sharedValueGuards';
import {
  touchBalanceChartScope,
  upsertBalanceChartScopeTimeframes,
} from '../../store/portfolio-charts';
import {
  buildBalanceChartScopeId,
  deserializeCachedTimeframeToComputedSeries,
  getCachedBalanceChartTimeframe,
  getCachedTimeframeStatus,
  getSortedUniqueWalletIds,
  serializeComputedSeriesToCachedTimeframe,
  type HydratedBalanceChartSeries,
} from '../../utils/portfolio/chartCache';
import {
  normalizeGraphPointsForChart,
  recomputeMinMaxFromGraphPoints,
} from '../../utils/portfolio/chartGraph';
import {
  buildBalanceHistoryChartChangeRowData,
  getDisplayedBalanceHistoryAnalysisPoint,
  getSelectedBalanceHistoryValue,
  type ChangeRowData,
} from './balanceHistoryChartSelection';
import {useStableBalanceHistoryChartAxisLabels} from './useStableBalanceHistoryChartAxisLabels';
import {
  buildCurrentRatesByAssetId,
  buildCommittedPortfolioRevisionToken,
  getCurrentRatesByAssetIdSignature,
  getStoredWalletRequestSignature,
  mapWalletsToStoredWallets,
  resolveCommittedPortfolioQuoteCurrency,
  runPortfolioChartQuery,
} from '../../portfolio/ui/common';
import type {
  PnlAnalysisChartResult,
  PnlAnalysisPoint,
} from '../../portfolio/core/pnl/analysisStreaming';
import {formatUnknownError} from '../../utils/errors/formatUnknownError';

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
  }) => void;
  axisLabelOpacity?: number | NumberSharedValue;
  onSelectedTimeframeChange?: (timeframe: FiatRateInterval) => void;
};

type DisplayState = {
  series: HydratedBalanceChartSeries;
  timeframe: FiatRateInterval;
};

const buildHydratedSeriesFromRuntimeChart = (args: {
  chart: PnlAnalysisChartResult;
  balanceOffset: number;
}): HydratedBalanceChartSeries | undefined => {
  const length = Math.min(
    args.chart.timestamps.length,
    args.chart.totalFiatBalance.length,
    args.chart.totalRemainingCostBasisFiat.length,
    args.chart.totalUnrealizedPnlFiat.length,
    args.chart.totalPnlChange.length,
    args.chart.totalPnlPercent.length,
  );

  if (!length) {
    return undefined;
  }

  const analysisPoints: PnlAnalysisPoint[] = [];
  const rawGraphPoints: GraphPoint[] = [];

  for (let index = 0; index < length; index++) {
    const timestamp = Number(args.chart.timestamps[index]);
    const totalFiatBalance = Number(args.chart.totalFiatBalance[index]);
    const totalRemainingCostBasisFiat = Number(
      args.chart.totalRemainingCostBasisFiat[index],
    );
    const totalUnrealizedPnlFiat = Number(
      args.chart.totalUnrealizedPnlFiat[index],
    );
    const totalPnlChange = Number(args.chart.totalPnlChange[index]);
    const totalPnlPercent = Number(args.chart.totalPnlPercent[index]);

    if (
      ![
        timestamp,
        totalFiatBalance,
        totalRemainingCostBasisFiat,
        totalUnrealizedPnlFiat,
        totalPnlChange,
        totalPnlPercent,
      ].every(Number.isFinite)
    ) {
      continue;
    }

    analysisPoints.push({
      timestamp,
      totalFiatBalance,
      totalRemainingCostBasisFiat,
      totalUnrealizedPnlFiat,
      totalPnlPercent,
      byWalletId: {},
      // Runtime charts expose explicit interval change; keep it on the point so
      // the existing change-row formatter can use it when present.
      ...({totalPnlChange} as any),
    } as PnlAnalysisPoint);

    rawGraphPoints.push({
      date: new Date(timestamp),
      value: totalFiatBalance + args.balanceOffset,
    });
  }

  if (!analysisPoints.length || !rawGraphPoints.length) {
    return undefined;
  }

  const graphPoints = normalizeGraphPointsForChart(rawGraphPoints);
  const pointByTimestamp = new Map<number, PnlAnalysisPoint>();
  for (
    let index = 0;
    index < Math.min(graphPoints.length, analysisPoints.length);
    index++
  ) {
    pointByTimestamp.set(
      graphPoints[index].date.getTime(),
      analysisPoints[index],
    );
  }

  const extrema = recomputeMinMaxFromGraphPoints(graphPoints);
  return {
    graphPoints,
    analysisPoints,
    pointByTimestamp,
    ...extrema,
  };
};

const buildCachedTimeframeFromSeries = (args: {
  timeframe: FiatRateInterval;
  walletIds: string[];
  quoteCurrency: string;
  balanceOffset: number;
  dataRevisionSig: string;
  series: HydratedBalanceChartSeries;
}): ReturnType<typeof serializeComputedSeriesToCachedTimeframe> => {
  const lastAnalysisPoint = args.series.analysisPoints.length
    ? args.series.analysisPoints[args.series.analysisPoints.length - 1]
    : undefined;

  return serializeComputedSeriesToCachedTimeframe({
    timeframe: args.timeframe,
    walletIds: args.walletIds,
    quoteCurrency: args.quoteCurrency,
    balanceOffset: args.balanceOffset,
    dataRevisionSig: args.dataRevisionSig,
    historicalRateDeps: [],
    analysisPoints: args.series.analysisPoints,
    patchMetadata: {
      lastSpotRatesByRateKey: {},
      latestHoldingsByRateKey: {},
      latestRemainingCostBasisFiatTotal:
        lastAnalysisPoint?.totalRemainingCostBasisFiat || 0,
    },
  });
};

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
  axisLabelOpacity = 1,
  onSelectedTimeframeChange,
}: BalanceHistoryChartProps): React.ReactElement | null => {
  const {t} = useTranslation();
  const theme = useTheme();
  const dispatch = useAppDispatch();

  const defaultAltCurrencyIsoCode = useAppSelector(
    ({APP}) => APP.defaultAltCurrency?.isoCode,
  );
  const committedPortfolioQuoteCurrency = useAppSelector(
    ({PORTFOLIO}) => PORTFOLIO.quoteCurrency,
  );
  const committedPortfolioLastPopulatedAt = useAppSelector(
    ({PORTFOLIO}) => PORTFOLIO.lastPopulatedAt,
  );

  const committedQueryQuoteCurrency = useMemo(() => {
    return resolveCommittedPortfolioQuoteCurrency({
      portfolioQuoteCurrency: committedPortfolioQuoteCurrency || quoteCurrency,
      defaultAltCurrencyIsoCode: defaultAltCurrencyIsoCode,
    });
  }, [
    committedPortfolioQuoteCurrency,
    defaultAltCurrencyIsoCode,
    quoteCurrency,
  ]);

  const committedDataRevisionSig = useMemo(() => {
    return buildCommittedPortfolioRevisionToken({
      quoteCurrency:
        committedPortfolioQuoteCurrency ||
        quoteCurrency ||
        defaultAltCurrencyIsoCode,
      lastPopulatedAt: committedPortfolioLastPopulatedAt,
    });
  }, [
    committedPortfolioLastPopulatedAt,
    committedPortfolioQuoteCurrency,
    defaultAltCurrencyIsoCode,
    quoteCurrency,
  ]);

  const {storedWallets, eligibleWallets} = useMemo(() => {
    return mapWalletsToStoredWallets({
      dispatch,
      wallets,
    });
  }, [dispatch, wallets]);

  const sortedWalletIds = useMemo(
    () =>
      getSortedUniqueWalletIds(eligibleWallets.map(wallet => wallet?.id || '')),
    [eligibleWallets],
  );
  const storedWalletRequestSig = useMemo(
    () => getStoredWalletRequestSignature(storedWallets),
    [storedWallets],
  );
  const currentRatesByAssetId = useMemo(() => {
    return buildCurrentRatesByAssetId({
      storedWallets,
      quoteCurrency: committedQueryQuoteCurrency,
      rates: _rates,
    });
  }, [_rates, committedQueryQuoteCurrency, storedWallets]);
  const currentRatesSignature = useMemo(() => {
    return getCurrentRatesByAssetIdSignature(currentRatesByAssetId);
  }, [currentRatesByAssetId]);
  const chartDataRevisionSig = useMemo(() => {
    return [committedDataRevisionSig, currentRatesSignature].join('|');
  }, [committedDataRevisionSig, currentRatesSignature]);

  const scopeId = useMemo(() => {
    return buildBalanceChartScopeId({
      walletIds: sortedWalletIds,
      quoteCurrency: committedQueryQuoteCurrency,
      balanceOffset,
    });
  }, [balanceOffset, committedQueryQuoteCurrency, sortedWalletIds]);

  const cachedScope = useAppSelector(
    ({PORTFOLIO_CHARTS}) => PORTFOLIO_CHARTS.cacheByScopeId?.[scopeId],
  );

  const [selectedTimeframe, setSelectedTimeframe] = useState<FiatRateInterval>(
    initialSelectedTimeframe,
  );
  const [displayState, setDisplayState] = useState<DisplayState | undefined>();
  const [selectedPoint, setSelectedPoint] = useState<GraphPoint | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | undefined>();
  const activeRequestIdRef = useRef(0);
  const onSelectedBalanceChangeRef = useRef(onSelectedBalanceChange);

  useEffect(() => {
    onSelectedBalanceChangeRef.current = onSelectedBalanceChange;
  }, [onSelectedBalanceChange]);

  useEffect(() => {
    setSelectedTimeframe(initialSelectedTimeframe);
  }, [initialSelectedTimeframe]);

  const cachedSelectedTimeframe = useMemo(() => {
    return getCachedBalanceChartTimeframe(
      cachedScope?.timeframes,
      selectedTimeframe,
    );
  }, [cachedScope?.timeframes, selectedTimeframe]);

  const cachedSelectedTimeframeStatus = useMemo(() => {
    return getCachedTimeframeStatus({
      cachedTimeframe: cachedSelectedTimeframe,
      dataRevisionSig: chartDataRevisionSig,
      currentSpotRatesByRateKey: {},
      fiatRateSeriesCache: undefined,
    });
  }, [cachedSelectedTimeframe, chartDataRevisionSig]);

  const cachedSelectedSeries = useMemo(() => {
    if (!cachedSelectedTimeframe) {
      return undefined;
    }
    if (
      cachedSelectedTimeframeStatus === 'missing' ||
      cachedSelectedTimeframeStatus === 'stale_historical'
    ) {
      return undefined;
    }
    return deserializeCachedTimeframeToComputedSeries(cachedSelectedTimeframe);
  }, [cachedSelectedTimeframe, cachedSelectedTimeframeStatus]);

  useEffect(() => {
    if (!cachedSelectedSeries) {
      return;
    }

    setDisplayState(prev => {
      if (
        prev?.timeframe === selectedTimeframe &&
        prev?.series === cachedSelectedSeries
      ) {
        return prev;
      }

      return {
        series: cachedSelectedSeries,
        timeframe: selectedTimeframe,
      };
    });
    setLoading(false);
    setError(undefined);
    dispatch(
      touchBalanceChartScope({
        scopeId,
      }),
    );
  }, [cachedSelectedSeries, dispatch, scopeId, selectedTimeframe]);

  const queryRevisionKey = useMemo(() => {
    return [
      scopeId,
      selectedTimeframe,
      chartDataRevisionSig,
      storedWalletRequestSig,
    ].join('|');
  }, [
    chartDataRevisionSig,
    scopeId,
    selectedTimeframe,
    storedWalletRequestSig,
  ]);
  const chartQueryArgsRef = useRef({
    wallets: storedWallets,
    quoteCurrency: committedQueryQuoteCurrency,
    timeframe: selectedTimeframe,
    maxPoints: FIAT_RATE_SERIES_TARGET_POINTS,
    currentRatesByAssetId,
    dataRevisionSig: chartDataRevisionSig,
    walletIds: sortedWalletIds,
  });
  chartQueryArgsRef.current = {
    wallets: storedWallets,
    quoteCurrency: committedQueryQuoteCurrency,
    timeframe: selectedTimeframe,
    maxPoints: FIAT_RATE_SERIES_TARGET_POINTS,
    currentRatesByAssetId,
    dataRevisionSig: chartDataRevisionSig,
    walletIds: sortedWalletIds,
  };

  useEffect(() => {
    if (cachedSelectedSeries) {
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
        });
        setLoading(false);

        dispatch(
          upsertBalanceChartScopeTimeframes({
            scopeId,
            walletIds: chartQueryArgs.walletIds,
            quoteCurrency: chartQueryArgs.quoteCurrency,
            balanceOffset,
            timeframes: [
              buildCachedTimeframeFromSeries({
                timeframe: chartQueryArgs.timeframe,
                walletIds: chartQueryArgs.walletIds,
                quoteCurrency: chartQueryArgs.quoteCurrency,
                balanceOffset,
                dataRevisionSig: chartQueryArgs.dataRevisionSig,
                series,
              }),
            ],
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
    queryRevisionKey,
    scopeId,
    sortedWalletIds,
  ]);

  useEffect(() => {
    setSelectedPoint(undefined);
    onSelectedBalanceChangeRef.current?.(undefined);
  }, [queryRevisionKey, selectedTimeframe]);

  const displayedTimeframe = displayState?.timeframe ?? selectedTimeframe;
  const activeSeries = displayState?.series;
  const rangeLabel = useMemo(
    () => getRangeLabelForFiatTimeframe(t, displayedTimeframe),
    [displayedTimeframe, t],
  );

  const displayedRangeMs = useMemo(() => {
    const series = activeSeries || cachedSelectedSeries;
    const firstTimestamp = series?.analysisPoints?.[0]?.timestamp;
    const lastTimestamp =
      series?.analysisPoints?.[(series.analysisPoints?.length || 1) - 1]
        ?.timestamp;

    return typeof firstTimestamp === 'number' &&
      typeof lastTimestamp === 'number'
      ? Math.max(0, lastTimestamp - firstTimestamp)
      : undefined;
  }, [activeSeries, cachedSelectedSeries]);

  const displayedAnalysisPoint = useMemo(() => {
    return getDisplayedBalanceHistoryAnalysisPoint({
      selectedPoint,
      activeSeries,
      cachedSelectedSeries,
    });
  }, [activeSeries, cachedSelectedSeries, selectedPoint]);

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
    if (!displayedChangeRowData) {
      return;
    }

    onChangeRowData?.({
      percent: displayedChangeRowData.percent,
      deltaFiatFormatted: displayedChangeRowData.deltaFiatFormatted,
      rangeLabel: displayedChangeRowData.rangeLabel,
    });
  }, [displayedChangeRowData, onChangeRowData]);

  const {MaxAxisLabel, MinAxisLabel} = useStableBalanceHistoryChartAxisLabels({
    activeSeries,
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

  const hasRenderableSeries = !!activeSeries?.graphPoints?.length;
  const hasAnyWallets = wallets.some(wallet => {
    const walletId = String(wallet?.id || '');
    return !!walletId && !!wallet;
  });
  const shouldShowLoader =
    !hasRenderableSeries &&
    (loading || (showLoaderWhenNoSnapshots && hasAnyWallets));

  const onGestureStarted = useCallback(() => {
    // No-op; we keep the current series visible and update the selected point as
    // the user scrubs. The previous snapshot engine emitted more events here, but
    // the committed-only runtime bridge intentionally stays quiet.
  }, []);

  const onGestureEnded = useCallback(() => {
    setSelectedPoint(undefined);
    onSelectedBalanceChangeRef.current?.(undefined);
  }, []);

  const onPointSelected = useCallback(
    (point: GraphPoint) => {
      setSelectedPoint(point);
      onSelectedBalanceChangeRef.current?.(
        getSelectedBalanceHistoryValue({
          point,
          activeSeries,
          balanceOffset,
        }),
      );
    },
    [activeSeries, balanceOffset],
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
        points={activeSeries?.graphPoints || []}
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
        enablePanGesture={!loading && !disablePanGesture && hasRenderableSeries}
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
