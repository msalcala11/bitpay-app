import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {useIsFocused} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';
import {View, type LayoutRectangle} from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import styled from 'styled-components/native';
import type {RootState} from '../../../../store';
import type {Key, Wallet} from '../../../../store/wallet/wallet.models';
import type {FiatRateInterval} from '../../../../store/rate/rate.models';
import {useAppDispatch, useAppSelector} from '../../../../utils/hooks';
import {
  getQuoteCurrency,
  getVisibleWalletsFromKeys,
  walletHasNonZeroLiveBalance,
} from '../../../../utils/portfolio/assets';
import {
  getPerfClockNowMs,
  measurePerfSync,
} from '../../../../utils/perfLogger';
import BalanceHistoryChart from '../../../../components/charts/BalanceHistoryChart';
import {DEFAULT_BALANCE_CHART_TIMEFRAME} from '../../../../components/charts/fiatTimeframes';
import {
  ActiveOpacity,
  ScreenGutter,
} from '../../../../components/styled/Containers';
import {setHomeChartCollapsed} from '../../../../store/portfolio-charts';
import CollapseContentButton from './CollapseContentButton';
import {TouchableOpacity} from '@components/base/TouchableOpacity';

const ChartStage = styled.View`
  width: 100%;
  position: relative;
  overflow: visible;
`;

const CollapseButtonContainer = styled(Animated.View)`
  position: absolute;
  right: 12px;
  top: 27px;
  z-index: 30;
`;

type PortfolioBalanceChartSectionProps = {
  defaultAltCurrencyIsoCode: string;
  hideAllBalances: boolean;
  homeCarouselConfig: RootState['APP']['homeCarouselConfig'];
  keys: Record<string, Key>;
  onChangeRowData: (data?: {
    percent: number;
    deltaFiatFormatted?: string;
    rangeLabel?: string;
  }) => void;
  onChartTimeframeInteraction?: (interaction: {
    nextTimeframe: FiatRateInterval;
    previousTimeframe: FiatRateInterval;
    selectedAtMs: number;
    sequence: number;
  }) => void;
  onHasChartDataChange: (hasChartData: boolean) => void;
  onSelectedBalanceChange: (balance?: number) => void;
  visibleKeyIdsSig: string;
};

const PortfolioBalanceChartSection = ({
  defaultAltCurrencyIsoCode,
  hideAllBalances,
  homeCarouselConfig,
  keys,
  onChangeRowData,
  onChartTimeframeInteraction,
  onHasChartDataChange,
  onSelectedBalanceChange,
  visibleKeyIdsSig,
}: PortfolioBalanceChartSectionProps) => {
  const {t} = useTranslation();
  const isFocused = useIsFocused();
  const dispatch = useAppDispatch();
  const portfolioQuoteCurrency = useAppSelector(
    ({PORTFOLIO}) => PORTFOLIO.quoteCurrency,
  );
  const snapshotsByWalletId = useAppSelector(
    ({PORTFOLIO}) => PORTFOLIO.snapshotsByWalletId,
  );
  const rates = useAppSelector(({RATE}) => RATE.rates);
  const fiatRateSeriesCache = useAppSelector(
    ({RATE}) => RATE.fiatRateSeriesCache,
  );
  const persistedHomeChartCollapsed = useAppSelector(
    ({PORTFOLIO_CHARTS}) => PORTFOLIO_CHARTS.homeChartCollapsed,
  );
  const homeChartRemountNonce = useAppSelector(
    ({PORTFOLIO_CHARTS}) => PORTFOLIO_CHARTS.homeChartRemountNonce,
  );

  const [isChartCollapsed, setIsChartCollapsed] = useState(
    persistedHomeChartCollapsed,
  );
  const [isCollapseButtonActive, setIsCollapseButtonActive] = useState(false);
  const collapseProgress = useSharedValue(persistedHomeChartCollapsed ? 1 : 0);
  const [chartBlockHeight, setChartBlockHeight] = useState(0);
  const [chartStageWidth, setChartStageWidth] = useState(0);
  const [chartStageY, setChartStageY] = useState(0);
  const collapseButtonPressOpacity = useSharedValue(1);
  const [collapseButtonLayout, setCollapseButtonLayout] =
    useState<LayoutRectangle>();
  const selectedChartTimeframeRef = useRef<FiatRateInterval>(
    DEFAULT_BALANCE_CHART_TIMEFRAME,
  );
  const timeframeInteractionSequenceRef = useRef(0);

  const walletsAcrossKeys: Wallet[] = useMemo(() => {
    return measurePerfSync(
      'screen.home_root.wallets_across_keys',
      () => {
        const allWallets = getVisibleWalletsFromKeys(keys, homeCarouselConfig);
        const snapshotsMap = snapshotsByWalletId || {};

        const byId = new Map<string, Wallet>();
        for (const wallet of allWallets) {
          if (!wallet?.id) {
            continue;
          }
          const hasSnaps = !!snapshotsMap[wallet.id]?.length;
          if (!walletHasNonZeroLiveBalance(wallet) && !hasSnaps) {
            continue;
          }
          if (!byId.has(wallet.id)) {
            byId.set(wallet.id, wallet);
          }
        }
        return Array.from(byId.values());
      },
      {
        screen: 'HomeRoot',
        snapshotWalletCount: Object.keys(snapshotsByWalletId || {}).length,
      },
    );
  }, [homeCarouselConfig, keys, snapshotsByWalletId]);

  const hasChartData = useMemo(() => {
    const snapshotsMap = snapshotsByWalletId || {};
    return walletsAcrossKeys.some(
      wallet => (snapshotsMap[wallet.id] || []).length > 0,
    );
  }, [snapshotsByWalletId, walletsAcrossKeys]);

  useEffect(() => {
    onHasChartDataChange(hasChartData);
  }, [hasChartData, onHasChartDataChange]);

  const shouldLeftAlignTopSection = hasChartData && !hideAllBalances;
  const collapsedScale = 0.26;
  const fullChartHeight = chartBlockHeight || 330;

  useEffect(() => {
    const nextCollapsed =
      shouldLeftAlignTopSection && persistedHomeChartCollapsed;
    setIsChartCollapsed(nextCollapsed);
    cancelAnimation(collapseProgress);
    collapseProgress.value = nextCollapsed ? 1 : 0;
  }, [
    collapseProgress,
    persistedHomeChartCollapsed,
    shouldLeftAlignTopSection,
  ]);

  const buttonAnimatedStyle = useAnimatedStyle(() => {
    return {
      opacity:
        interpolate(collapseProgress.value, [0, 1], [1, 0]) *
        collapseButtonPressOpacity.value,
    };
  }, []);

  const chartScale = useDerivedValue(() => {
    return interpolate(collapseProgress.value, [0, 1], [1, collapsedScale]);
  }, [collapsedScale]);

  const chartSpacerAnimatedStyle = useAnimatedStyle(() => {
    return {
      height: interpolate(collapseProgress.value, [0, 1], [fullChartHeight, 0]),
    };
  }, [fullChartHeight]);

  const axisLabelOpacity = useDerivedValue(() => {
    return interpolate(collapseProgress.value, [0, 0.08, 1], [1, 0, 0]);
  }, []);

  const timeframeSelectorOpacity = useDerivedValue(() => {
    return interpolate(collapseProgress.value, [0, 0.28, 1], [1, 0, 0]);
  }, []);

  const miniChartVerticalNudge = -8;
  const fallbackCollapsedTranslateX = 128;
  const fallbackCollapsedTranslateY =
    -fullChartHeight * 0.72 + miniChartVerticalNudge;
  const targetChartRightInset =
    collapseButtonLayout && chartStageWidth
      ? Math.max(
          0,
          chartStageWidth -
            (collapseButtonLayout.x + collapseButtonLayout.width),
        )
      : 12;
  const collapsedTranslateX =
    chartStageWidth > 0
      ? chartStageWidth * ((1 - collapsedScale) / 2) - targetChartRightInset
      : fallbackCollapsedTranslateX;
  const targetChartTopInStage =
    collapseButtonLayout && chartStageWidth
      ? collapseButtonLayout.y - chartStageY
      : undefined;
  const collapsedTranslateY =
    typeof targetChartTopInStage === 'number'
      ? targetChartTopInStage -
        fullChartHeight * ((1 - collapsedScale) / 2) +
        miniChartVerticalNudge
      : fallbackCollapsedTranslateY;

  const chartWrapperAnimatedStyle = useAnimatedStyle(() => {
    const progress = collapseProgress.value;
    return {
      transform: [
        {
          translateX: interpolate(progress, [0, 1], [0, collapsedTranslateX]),
        },
        {
          translateY: interpolate(progress, [0, 1], [0, collapsedTranslateY]),
        },
        {scale: chartScale.value},
      ],
    };
  }, [collapsedTranslateX, collapsedTranslateY]);

  const persistHomeChartCollapsePreference = useCallback(
    (collapsed: boolean) => {
      dispatch(setHomeChartCollapsed(collapsed));
    },
    [dispatch],
  );

  const runChartCollapseAnimation = useCallback(
    (toCollapsed: boolean) => {
      if (!shouldLeftAlignTopSection) {
        return;
      }
      if (toCollapsed) {
        setIsChartCollapsed(true);
      }

      cancelAnimation(collapseProgress);
      collapseProgress.value = withTiming(
        toCollapsed ? 1 : 0,
        {
          duration: 360,
          easing: Easing.inOut(Easing.cubic),
        },
        finished => {
          if (!finished) {
            return;
          }
          runOnJS(persistHomeChartCollapsePreference)(toCollapsed);
          if (!toCollapsed) {
            runOnJS(setIsChartCollapsed)(false);
          }
        },
      );
    },
    [
      collapseProgress,
      persistHomeChartCollapsePreference,
      shouldLeftAlignTopSection,
    ],
  );

  const onCollapseButtonPressIn = useCallback(() => {
    setIsCollapseButtonActive(true);
    cancelAnimation(collapseButtonPressOpacity);
    collapseButtonPressOpacity.value = withTiming(ActiveOpacity, {
      duration: 80,
      easing: Easing.linear,
    });
  }, [collapseButtonPressOpacity]);

  const onCollapseButtonPressOut = useCallback(() => {
    setIsCollapseButtonActive(false);
    cancelAnimation(collapseButtonPressOpacity);
    collapseButtonPressOpacity.value = withTiming(1, {
      duration: 120,
      easing: Easing.linear,
    });
  }, [collapseButtonPressOpacity]);

  const onCollapseChartPress = useCallback(() => {
    setIsCollapseButtonActive(false);
    runChartCollapseAnimation(true);
  }, [runChartCollapseAnimation]);

  const onExpandChartPress = useCallback(() => {
    runChartCollapseAnimation(false);
  }, [runChartCollapseAnimation]);

  const onSelectedChartTimeframeChange = useCallback(
    (timeframe: FiatRateInterval) => {
      const previousTimeframe = selectedChartTimeframeRef.current;
      if (previousTimeframe === timeframe) {
        return;
      }

      selectedChartTimeframeRef.current = timeframe;
      timeframeInteractionSequenceRef.current += 1;
      onChartTimeframeInteraction?.({
        nextTimeframe: timeframe,
        previousTimeframe,
        selectedAtMs: getPerfClockNowMs(),
        sequence: timeframeInteractionSequenceRef.current,
      });
    },
    [onChartTimeframeInteraction],
  );

  const quoteCurrency = getQuoteCurrency({
    portfolioQuoteCurrency,
    defaultAltCurrencyIsoCode,
  });
  const collapseChartAccessibilityLabel = t('Collapse portfolio chart');
  const expandChartAccessibilityLabel = t('Expand portfolio chart');
  const chartLifecycleKey = useMemo(
    () =>
      `home-portfolio-charts:${quoteCurrency}:${homeChartRemountNonce}:${visibleKeyIdsSig}`,
    [homeChartRemountNonce, quoteCurrency, visibleKeyIdsSig],
  );
  const hasInitializedChartLifecycleRef = useRef(false);

  useEffect(() => {
    if (!hasInitializedChartLifecycleRef.current) {
      hasInitializedChartLifecycleRef.current = true;
      return;
    }

    onSelectedBalanceChange(undefined);
    onChangeRowData(undefined);
  }, [chartLifecycleKey, onChangeRowData, onSelectedBalanceChange]);

  if (hideAllBalances) {
    return null;
  }

  if (!hasChartData) {
    return (
      <BalanceHistoryChart
        key={chartLifecycleKey}
        wallets={walletsAcrossKeys}
        snapshotsByWalletId={snapshotsByWalletId || {}}
        quoteCurrency={quoteCurrency}
        perfContext="HomeRoot"
        isActive={isFocused}
        initialSelectedTimeframe={selectedChartTimeframeRef.current}
        rates={rates}
        fiatRateSeriesCache={fiatRateSeriesCache}
        onSelectedTimeframeChange={onSelectedChartTimeframeChange}
        timeframeSelectorHorizontalInset={ScreenGutter}
        onSelectedBalanceChange={onSelectedBalanceChange}
        onChangeRowData={onChangeRowData}
      />
    );
  }

  return (
    <ChartStage
      onLayout={e => {
        const {width, y} = e.nativeEvent.layout;
        if (width > 0 && width !== chartStageWidth) {
          setChartStageWidth(width);
        }
        if (y !== chartStageY) {
          setChartStageY(y);
        }
      }}>
      <CollapseButtonContainer
        onLayout={e => {
          const nextLayout = e.nativeEvent.layout;
          setCollapseButtonLayout(prev =>
            prev &&
            prev.x === nextLayout.x &&
            prev.y === nextLayout.y &&
            prev.width === nextLayout.width &&
            prev.height === nextLayout.height
              ? prev
              : nextLayout,
          );
        }}
        pointerEvents={isChartCollapsed ? 'none' : 'auto'}
        accessibilityElementsHidden={isChartCollapsed}
        importantForAccessibility={
          isChartCollapsed ? 'no-hide-descendants' : 'yes'
        }
        style={buttonAnimatedStyle}>
        <CollapseContentButton
          isActive={isCollapseButtonActive}
          onPressIn={onCollapseButtonPressIn}
          onPressOut={onCollapseButtonPressOut}
          onPress={onCollapseChartPress}
          accessibilityLabel={collapseChartAccessibilityLabel}
          accessibilityState={{
            expanded: !isChartCollapsed,
            selected: isCollapseButtonActive,
          }}
        />
      </CollapseButtonContainer>
      <Animated.View style={chartSpacerAnimatedStyle} />
      <Animated.View
        style={[
          {
            position: 'absolute',
            left: 0,
            right: 0,
            top: 0,
            zIndex: isChartCollapsed ? 20 : 1,
          },
          chartWrapperAnimatedStyle,
        ]}>
        <View
          onLayout={e => {
            const height = Math.round(e.nativeEvent.layout.height);
            if (height > 0 && height !== chartBlockHeight) {
              setChartBlockHeight(height);
            }
          }}>
          <BalanceHistoryChart
            key={chartLifecycleKey}
            wallets={walletsAcrossKeys}
            snapshotsByWalletId={snapshotsByWalletId || {}}
            quoteCurrency={quoteCurrency}
            perfContext="HomeRoot"
            isActive={isFocused}
            initialSelectedTimeframe={selectedChartTimeframeRef.current}
            rates={rates}
            fiatRateSeriesCache={fiatRateSeriesCache}
            strokeScale={chartScale}
            minStrokeScale={collapsedScale}
            onChangeRowData={onChangeRowData}
            onSelectedTimeframeChange={onSelectedChartTimeframeChange}
            axisLabelOpacity={axisLabelOpacity}
            showChangeRow={false}
            showTimeframeSelector
            timeframeSelectorOpacity={timeframeSelectorOpacity}
            timeframeSelectorHorizontalInset={ScreenGutter}
            disablePanGesture={isChartCollapsed}
            onSelectedBalanceChange={onSelectedBalanceChange}
          />
          {isChartCollapsed ? (
            <TouchableOpacity
              touchableLibrary="react-native"
              activeOpacity={ActiveOpacity}
              hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top: 0,
                bottom: 0,
                zIndex: 50,
              }}
              accessibilityRole="button"
              accessibilityLabel={expandChartAccessibilityLabel}
              accessibilityState={{expanded: false}}
              onPress={onExpandChartPress}
            />
          ) : null}
        </View>
      </Animated.View>
    </ChartStage>
  );
};

export default React.memo(PortfolioBalanceChartSection);
