import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {StyleProp, View, ViewStyle} from 'react-native';
import {useTranslation} from 'react-i18next';
import {useTheme} from 'styled-components/native';
import type {GraphPoint} from 'react-native-graph';
import Animated, {
  type SharedValue,
  useAnimatedStyle,
} from 'react-native-reanimated';
import type {
  FiatRateInterval,
  FiatRateSeriesCache,
  Rates,
} from '../../store/rate/rate.models';
import type {BalanceSnapshot} from '../../store/portfolio/portfolio.models';
import type {Wallet} from '../../store/wallet/wallet.models';
import TimeframeSelector from './TimeframeSelector';
import InteractiveLineChart from './InteractiveLineChart';
import ChartSelectionDot from './ChartSelectionDot';
import ChartChangeRow from './ChartChangeRow';
import {useBalanceChartChangeRow} from './useBalanceChartChangeRow';
import {Action, LinkBlue, White} from '../../styles/colors';
import haptic from '../haptic-feedback/haptic';
import {buildPnlCurrentRatesByCoinFromWallets} from '../../utils/portfolio/assets';
import {useAppDispatch, useAppSelector} from '../../utils/hooks';
import {fetchFiatRateSeriesInterval} from '../../store/wallet/effects';
import {normalizeFiatRateSeriesCoin} from '../../utils/portfolio/core/pnl/rates';
import {isNumberSharedValue} from './sharedValueGuards';
import {
  buildBalanceChartScopeId,
  buildBalanceChartTimeframeRevision,
  buildHistoricalRateDependencyMetadataFromCache,
  buildSnapshotVersionSig,
} from '../../utils/portfolio/chartCache';
import {getSortedUniqueWalletIds} from '../../utils/portfolio/balanceChartShared';
import {
  getFiatChartTimeframeOptions,
  getSeriesIntervalForFiatTimeframe,
} from './fiatTimeframes';
import {useBalanceChartCacheHydration} from './useBalanceChartCacheHydration';
import {useBalanceChartComputationQueue} from './useBalanceChartComputationQueue';
import {useBalanceChartDisplayState} from './useBalanceChartDisplayState';
import {useChartAxisLabelRenderers} from './useChartAxisLabelRenderers';

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
  onChangeRowData?: (data?: {
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
  const [chartWidth, setChartWidth] = useState<number | undefined>(undefined);
  const [selectedPoint, setSelectedPoint] = useState<GraphPoint | undefined>();
  const [hasCompletedInitialSelectedLoad, setHasCompletedInitialSelectedLoad] =
    useState(false);

  const gestureStarted = useRef(false);
  const lastHapticPointTsRef = useRef<number | undefined>(undefined);

  // NOTE: Some call sites may pass inline callbacks. Avoid re-running effects
  // when callback identity changes by reading the latest callback from refs.
  const onSelectedBalanceChangeRef = useRef(onSelectedBalanceChange);
  useEffect(() => {
    onSelectedBalanceChangeRef.current = onSelectedBalanceChange;
  }, [onSelectedBalanceChange]);

  const walletsSig = useMemo(() => {
    return (wallets || [])
      .map(wallet => String(wallet.id || ''))
      .filter(Boolean)
      .join(',');
  }, [wallets]);

  const snapshotsSig = useMemo(() => {
    const parts: string[] = [];
    for (const wallet of wallets || []) {
      const walletId = String(wallet.id || '');
      if (!walletId) {
        continue;
      }

      const snapshots = snapshotsByWalletId?.[walletId] || [];
      const lastSnapshotTs = snapshots.length ? snapshots.at(-1)?.timestamp : 0;
      parts.push(`${walletId}:${snapshots.length}:${lastSnapshotTs || 0}`);
    }

    return parts.join('|');
  }, [snapshotsByWalletId, wallets]);

  const totalSnapshotCount = useMemo(() => {
    let totalCount = 0;

    for (const wallet of wallets || []) {
      const walletId = String(wallet.id || '');
      if (!walletId) {
        continue;
      }

      const snapshots = Array.isArray(snapshotsByWalletId?.[walletId])
        ? (snapshotsByWalletId?.[walletId] as BalanceSnapshot[])
        : [];
      totalCount += snapshots.length;
    }

    return totalCount;
  }, [snapshotsByWalletId, wallets]);

  const hasAnySnapshots = totalSnapshotCount > 0;

  const sortedWalletIds = useMemo(() => {
    return getSortedUniqueWalletIds(
      (wallets || []).map(wallet => String(wallet.id || '')),
    );
  }, [wallets]);

  const scopeId = useMemo(() => {
    return buildBalanceChartScopeId({
      walletIds: sortedWalletIds,
      quoteCurrency,
      balanceOffset,
    });
  }, [balanceOffset, quoteCurrency, sortedWalletIds]);

  useEffect(() => {
    gestureStarted.current = false;
    lastHapticPointTsRef.current = undefined;
    setSelectedPoint(undefined);
    setHasCompletedInitialSelectedLoad(false);
    onSelectedBalanceChangeRef.current?.(undefined);
  }, [scopeId]);

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

  const rateFetchAssets = useMemo(() => {
    const assets: Array<{
      coinForCacheCheck: string;
      chain?: string;
      tokenAddress?: string;
    }> = [];
    const seen = new Set<string>();

    for (const wallet of wallets || []) {
      const coinForCacheCheck = normalizeFiatRateSeriesCoin(
        wallet.currencyAbbreviation || '',
      );
      if (!coinForCacheCheck) {
        continue;
      }

      const chainRaw = typeof wallet.chain === 'string' ? wallet.chain : '';
      const chain = chainRaw ? chainRaw.toLowerCase() : undefined;
      const tokenAddressRaw =
        typeof wallet.tokenAddress === 'string' ? wallet.tokenAddress : '';
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

  const getCachedTimeframeHistoricalDepKeys = useCallback(
    (timeframe: FiatRateInterval) => {
      return (cachedScope?.timeframes?.[timeframe]?.historicalRateDeps || [])
        .map(dep => dep?.cacheKey)
        .filter((cacheKey): cacheKey is string => !!cacheKey);
    },
    [cachedScope?.timeframes],
  );

  const getLiveHistoricalRateDepsForTimeframe = useCallback(
    (timeframe: FiatRateInterval) => {
      const cachedDepKeys = getCachedTimeframeHistoricalDepKeys(timeframe);
      if (!cachedDepKeys.length) {
        return undefined;
      }

      return buildHistoricalRateDependencyMetadataFromCache({
        depKeys: cachedDepKeys,
        fiatRateSeriesCache,
      });
    },
    [fiatRateSeriesCache, getCachedTimeframeHistoricalDepKeys],
  );

  const getTimeframeRevision = useCallback(
    (
      timeframe: FiatRateInterval,
      historicalRateDeps = getLiveHistoricalRateDepsForTimeframe(timeframe) ||
        [],
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
      currentSpotRatesByCoin,
      getLiveHistoricalRateDepsForTimeframe,
      scopeId,
      snapshotVersionSig,
    ],
  );

  const {
    cachedTimeframeStatusByTimeframe,
    seriesByTimeframe,
    setSeriesByTimeframe,
    seriesRevisionByTimeframe,
    setSeriesRevisionByTimeframe,
  } = useBalanceChartCacheHydration({
    cachedScope,
    currentSpotRatesByCoin,
    dispatch,
    fiatRateSeriesCache,
    quoteCurrency,
    scopeId,
    snapshotVersionSig,
    getTimeframeRevision,
  });

  const {
    getTimeframeAttemptRevision,
    lastAttemptRevisionByTimeframe,
    lastErrorByTimeframe,
  } = useBalanceChartComputationQueue({
    balanceOffset,
    cachedTimeframeStatusByTimeframe,
    currentRatesRevision,
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
  });

  const {
    activeSeries,
    displayedTimeframe,
    hasAnyRenderableSeries,
    hideGuideLineForInitialSelectedLoader,
    hydratedSelectedSeries,
    isChartLoaderVisible,
    isChartLoadingRaw,
  } = useBalanceChartDisplayState({
    getTimeframeAttemptRevision,
    getTimeframeRevision,
    hasAnySnapshots,
    hasCompletedInitialSelectedLoad,
    lastAttemptRevisionByTimeframe,
    lastErrorByTimeframe,
    resetKey: scopeId,
    selectedTimeframe,
    seriesByTimeframe,
    seriesRevisionByTimeframe,
    setHasCompletedInitialSelectedLoad,
  });

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

  const fallbackLastAnalysisPoint = useMemo(() => {
    const points = hydratedSelectedSeries?.analysisPoints || [];
    return points.length ? points[points.length - 1] : undefined;
  }, [hydratedSelectedSeries]);

  const {displayedChangeRowData} = useBalanceChartChangeRow({
    activeSeries,
    fallbackAnalysisPoint: fallbackLastAnalysisPoint,
    selectedPoint,
    selectedTimeframe,
    displayedTimeframe,
    quoteCurrency,
    t,
    resetCacheKey: scopeId,
  });

  useEffect(() => {
    if (!onChangeRowData) {
      return;
    }

    if (!displayedChangeRowData) {
      onChangeRowData(undefined);
      return;
    }

    onChangeRowData({
      percent: displayedChangeRowData.percent,
      deltaFiatFormatted: displayedChangeRowData.deltaFiatFormatted,
      rangeLabel: displayedChangeRowData.rangeLabel,
    });
  }, [displayedChangeRowData, onChangeRowData]);

  const {MinAxisLabel, MaxAxisLabel} = useChartAxisLabelRenderers({
    minLabel: activeSeries
      ? {
          value: activeSeries.minPoint.value,
          index: activeSeries.minIndex,
          arrayLength: activeSeries.graphPoints.length,
        }
      : undefined,
    maxLabel: activeSeries
      ? {
          value: activeSeries.maxPoint.value,
          index: activeSeries.maxIndex,
          arrayLength: activeSeries.graphPoints.length,
        }
      : undefined,
    quoteCurrency,
    chartWidth,
    contentOpacity: axisLabelOpacity,
  });

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
    (point: GraphPoint) => {
      if (!gestureStarted.current || !activeSeries) {
        return;
      }

      setSelectedPoint(point);
      const pointTs = point.date.getTime();
      if (lastHapticPointTsRef.current !== pointTs) {
        haptic('impactLight');
        lastHapticPointTsRef.current = pointTs;
      }

      const analysisPoint = activeSeries.pointByTimestamp.get(pointTs);
      const actualBalance =
        typeof analysisPoint?.totalFiatBalance === 'number'
          ? analysisPoint.totalFiatBalance + balanceOffset
          : point.value;
      onSelectedBalanceChangeRef.current?.(actualBalance);
    },
    [activeSeries, balanceOffset],
  );

  const chartColor = lineColor || (theme.dark ? LinkBlue : Action);
  const gradientBackgroundColor =
    gradientStartColor || (theme.dark ? 'transparent' : White);

  const onChartLayout = useCallback(({nativeEvent: {layout}}) => {
    const nextWidth = Math.round(layout.width);
    if (nextWidth > 0) {
      setChartWidth(prevWidth =>
        prevWidth === nextWidth ? prevWidth : nextWidth,
      );
    }
  }, []);

  if (!hasAnySnapshots) {
    if (showLoaderWhenNoSnapshots) {
      return (
        <View style={{width: '100%'}} onLayout={onChartLayout}>
          {preChartContent ? (
            <View style={{marginTop: preChartContentTopMargin}}>
              {preChartContent}
            </View>
          ) : null}
          <InteractiveLineChart
            points={[]}
            color={chartColor}
            lineThickness={lineThickness}
            chartWidth={chartWidth}
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
      );
    }

    return preChartContent ? (
      <View style={{marginTop: preChartContentTopMargin}}>
        {preChartContent}
      </View>
    ) : null;
  }

  return (
    <View style={{width: '100%'}} onLayout={onChartLayout}>
      {showChangeRow && displayedChangeRowData ? (
        <ChartChangeRow
          percent={displayedChangeRowData.percent}
          deltaFiatFormatted={displayedChangeRowData.deltaFiatFormatted}
          rangeLabel={displayedChangeRowData.rangeLabel}
          style={changeRowStyle}
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
        chartWidth={chartWidth}
        showFirstPointGuideLine={!hideGuideLineForInitialSelectedLoader}
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
            width={chartWidth}
            onSelect={timeframe => {
              setSelectedPoint(undefined);
              onSelectedBalanceChangeRef.current?.(undefined);
              onSelectedTimeframeChange?.(timeframe);
              setSelectedTimeframe(timeframe);
            }}
          />
        </Animated.View>
      ) : null}
    </View>
  );
};

export default BalanceHistoryChart;
