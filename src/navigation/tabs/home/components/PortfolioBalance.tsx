import React, {useCallback, useMemo, useState} from 'react';
import styled from 'styled-components/native';
import {BaseText, H2} from '../../../../components/styled/Text';
import {SlateDark, White} from '../../../../styles/colors';
import {useSelector} from 'react-redux';
import {RootState} from '../../../../store';
import {formatFiatAmount} from '../../../../utils/helper-methods';
import InfoSvg from './InfoSvg';
import {
  ActiveOpacity,
  ScreenGutter,
} from '../../../../components/styled/Containers';
import {useAppDispatch, useAppSelector} from '../../../../utils/hooks';
import {
  showBottomNotificationModal,
  toggleHideAllBalances,
} from '../../../../store/app/app.actions';
import BalanceHistoryChart from '../../../../components/charts/BalanceHistoryChart';
import ChartChangeRow from '../../../../components/charts/ChartChangeRow';
import {COINBASE_ENV} from '../../../../api/coinbase/coinbase.constants';
import {useTranslation} from 'react-i18next';
import {TouchableOpacity} from '@components/base/TouchableOpacity';
import {View, type LayoutRectangle} from 'react-native';
import Animated, {
  Easing,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import {maskIfHidden} from '../../../../utils/hideBalances';
import {
  getQuoteCurrency,
  getVisibleKeysFromKeys,
  getVisibleWalletsFromKeys,
  walletHasNonZeroLiveBalance,
} from '../../../../utils/portfolio/assets';
import type {Wallet} from '../../../../store/wallet/wallet.models';
import CollapseContentButton from './CollapseContentButton';

const PortfolioContainer = styled.View`
  justify-content: center;
  align-items: center;
  width: 100%;
`;

const PortfolioTopContent = styled.View<{$leftAligned?: boolean}>`
  width: 100%;
  padding: 0 ${ScreenGutter};
  align-items: ${({$leftAligned}) => ($leftAligned ? 'flex-start' : 'center')};
`;

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

const CollapseButtonHitArea = styled(Animated.View)`
  position: absolute;
  right: -4px;
  top: 11px;
  width: 72px;
  height: 72px;
  z-index: 31;
`;

const PortfolioBalanceHeader = styled(TouchableOpacity)`
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
`;

const PortfolioBalanceTitle = styled(BaseText)`
  margin-right: 3px;
  font-size: 13px;
  line-height: 18px;
  color: ${({theme: {dark}}) => (dark ? White : SlateDark)};
`;

const PortfolioBalanceText = styled(BaseText)`
  font-size: 39px;
  font-weight: 700;
  line-height: 59px;
  color: ${({theme}) => theme.colors.text};
  margin: 2px 0;
`;

const HiddenBalance = styled(H2)`
  line-height: 50px;
  margin: 6px 0;
`;

const PortfolioBalance = () => {
  const {t} = useTranslation();
  const coinbaseBalance =
    useAppSelector(({COINBASE}) => COINBASE.balance[COINBASE_ENV]) || 0.0;

  const keys = useSelector(({WALLET}: RootState) => WALLET.keys);
  const portfolio = useSelector(({PORTFOLIO}: RootState) => PORTFOLIO);
  const {rates, fiatRateSeriesCache} = useSelector(({RATE}: RootState) => RATE);

  const defaultAltCurrency = useAppSelector(({APP}) => APP.defaultAltCurrency);
  const hideAllBalances = useAppSelector(({APP}) => APP.hideAllBalances);
  const homeCarouselConfig = useAppSelector(({APP}) => APP.homeCarouselConfig);

  const [selectedChartBalance, setSelectedChartBalance] = useState<
    number | undefined
  >();
  const [chartChangeRowData, setChartChangeRowData] = useState<{
    percent: number;
    deltaFiatFormatted?: string;
    rangeLabel?: string;
    isLoading?: boolean;
  }>();
  const [isChartCollapsed, setIsChartCollapsed] = useState(false);
  const [isCollapseButtonActive, setIsCollapseButtonActive] = useState(false);
  const collapseProgress = useSharedValue(0);
  const [chartBlockHeight, setChartBlockHeight] = useState(0);
  const [chartStageWidth, setChartStageWidth] = useState(0);
  const [chartStageY, setChartStageY] = useState(0);
  const collapseButtonPressOpacity = useSharedValue(1);
  const [collapseButtonLayout, setCollapseButtonLayout] =
    useState<LayoutRectangle>();

  const visibleKeys = useMemo(
    () => getVisibleKeysFromKeys(keys, homeCarouselConfig),
    [homeCarouselConfig, keys],
  );

  const visibleCurrentBalance = useMemo(
    () =>
      visibleKeys.reduce((total, key) => total + (key.totalBalance || 0), 0),
    [visibleKeys],
  );

  const totalBalanceIncludingCoinbase: number =
    visibleCurrentBalance + coinbaseBalance;

  const dispatch = useAppDispatch();

  const walletsAcrossKeys: Wallet[] = useMemo(() => {
    const allWallets = getVisibleWalletsFromKeys(keys, homeCarouselConfig);
    const snapshotsMap = portfolio?.snapshotsByWalletId || {};

    const byId = new Map<string, Wallet>();
    for (const w of allWallets) {
      if (!w?.id) {
        continue;
      }
      const hasSnaps = !!snapshotsMap[w.id]?.length;
      if (!walletHasNonZeroLiveBalance(w) && !hasSnaps) {
        continue;
      }
      if (!byId.has(w.id)) {
        byId.set(w.id, w);
      }
    }
    return Array.from(byId.values());
  }, [homeCarouselConfig, keys, portfolio?.snapshotsByWalletId]);

  const hasChartData = useMemo(() => {
    const snapshotsMap = portfolio?.snapshotsByWalletId || {};
    return walletsAcrossKeys.some(w => (snapshotsMap[w.id] || []).length > 0);
  }, [portfolio?.snapshotsByWalletId, walletsAcrossKeys]);
  const shouldLeftAlignTopSection = hasChartData && !hideAllBalances;
  const collapsedScale = 0.26;
  const fullChartHeight = chartBlockHeight || 330;

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

  // Fine-tune the final collapsed Y alignment so the mini chart sits perfectly
  // next to the large portfolio balance number (without looking slightly low).
  // Positive values push the chart DOWN; smaller values move it UP.
  const miniChartVerticalNudge = -8;
  const fallbackCollapsedTranslateX = 128;
  const fallbackCollapsedTranslateY =
    -fullChartHeight * 0.72 + miniChartVerticalNudge;
  const targetChartRightInset =
    collapseButtonLayout && chartStageWidth
      ? Math.max(0, chartStageWidth - (collapseButtonLayout.x + collapseButtonLayout.width))
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
          translateX: interpolate(
            progress,
            [0, 1],
            [0, collapsedTranslateX],
          ),
        },
        {
          translateY: interpolate(
            progress,
            [0, 1],
            [0, collapsedTranslateY],
          ),
        },
        {scale: chartScale.value},
      ],
    };
  }, [collapsedTranslateX, collapsedTranslateY]);

  const runChartCollapseAnimation = useCallback((toCollapsed: boolean) => {
    if (!shouldLeftAlignTopSection) {
      return;
    }
    if (toCollapsed) {
      setIsChartCollapsed(true);
    }

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
        if (!toCollapsed) {
          runOnJS(setIsChartCollapsed)(false);
        }
      },
    );
  }, [collapseProgress, shouldLeftAlignTopSection]);

  const onCollapseButtonPressIn = useCallback(() => {
    setIsCollapseButtonActive(true);
    collapseButtonPressOpacity.value = withTiming(ActiveOpacity, {
      duration: 80,
      easing: Easing.linear,
    });
  }, [collapseButtonPressOpacity]);

  const onCollapseButtonPressOut = useCallback(() => {
    setIsCollapseButtonActive(false);
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

  const quoteCurrency = getQuoteCurrency({
    portfolioQuoteCurrency: portfolio?.quoteCurrency,
    defaultAltCurrencyIsoCode: defaultAltCurrency?.isoCode,
  });
  // Home may stay mounted while the user toggles this setting from the
  // Settings tab. Key the chart to the latest populate cycle *start* so we
  // still force a fresh instance after re-enabling portfolio, but avoid a
  // second remount at populate completion that can throw away freshly-built
  // chart state.
  const chartLifecycleSeed =
    portfolio?.populateStatus?.startedAt || portfolio?.lastPopulatedAt || 0;
  const chartLifecycleKey = useMemo(
    () => `home-portfolio-charts:${quoteCurrency}:${chartLifecycleSeed}`,
    [chartLifecycleSeed, quoteCurrency],
  );

  const displayedPortfolioBalance =
    typeof selectedChartBalance === 'number'
      ? selectedChartBalance
      : totalBalanceIncludingCoinbase;

  const showPortfolioBalanceInfoModal = () => {
    dispatch(
      showBottomNotificationModal({
        type: 'info',
        title: t('Portfolio balance'),
        message: t(
          'Your Portfolio Balance is the total of all your crypto assets.',
        ),
        enableBackdropDismiss: true,
        actions: [
          {
            text: t('GOT IT'),
            action: () => null,
            primary: true,
          },
        ],
      }),
    );
  };

  return (
    <PortfolioContainer>
      {shouldLeftAlignTopSection ? (
        <>
          <CollapseButtonHitArea
            pointerEvents={isChartCollapsed ? 'none' : 'auto'}
            style={buttonAnimatedStyle}>
            <TouchableOpacity
              touchableLibrary="react-native"
              activeOpacity={ActiveOpacity}
              style={{flex: 1}}
              onPressIn={onCollapseButtonPressIn}
              onPressOut={onCollapseButtonPressOut}
              onPress={onCollapseChartPress}
            />
          </CollapseButtonHitArea>
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
            style={buttonAnimatedStyle}>
            <CollapseContentButton
              isActive={isCollapseButtonActive}
              onPressIn={onCollapseButtonPressIn}
              onPressOut={onCollapseButtonPressOut}
              onPress={onCollapseChartPress}
            />
          </CollapseButtonContainer>
        </>
      ) : null}
      <PortfolioTopContent $leftAligned={shouldLeftAlignTopSection}>
        <PortfolioBalanceHeader
          activeOpacity={ActiveOpacity}
          onPress={showPortfolioBalanceInfoModal}>
          <PortfolioBalanceTitle>{t('Portfolio Balance')}</PortfolioBalanceTitle>
          <InfoSvg width={16} height={16} />
        </PortfolioBalanceHeader>
        <TouchableOpacity
          onLongPress={() => {
            dispatch(toggleHideAllBalances());
          }}>
          {!hideAllBalances ? (
            <>
              <PortfolioBalanceText>
                {formatFiatAmount(
                  displayedPortfolioBalance,
                  defaultAltCurrency.isoCode,
                  {
                    currencyDisplay: 'symbol',
                  },
                )}
              </PortfolioBalanceText>
            </>
          ) : (
            <HiddenBalance>
              {maskIfHidden(true, totalBalanceIncludingCoinbase)}
            </HiddenBalance>
          )}
        </TouchableOpacity>
      </PortfolioTopContent>

      {shouldLeftAlignTopSection && chartChangeRowData ? (
        <ChartChangeRow
          percent={chartChangeRowData.percent}
          deltaFiatFormatted={chartChangeRowData.deltaFiatFormatted}
          rangeLabel={chartChangeRowData.rangeLabel}
          isLoading={chartChangeRowData.isLoading}
          style={{
            width: '100%',
            justifyContent: 'flex-start',
            paddingLeft: 12,
          }}
        />
      ) : null}

      {!hideAllBalances ? (
        hasChartData ? (
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
                  const h = Math.round(e.nativeEvent.layout.height);
                  if (!isChartCollapsed && h > 0 && h !== chartBlockHeight) {
                    setChartBlockHeight(h);
                  }
                }}>
                <BalanceHistoryChart
                  key={chartLifecycleKey}
                  wallets={walletsAcrossKeys}
                  snapshotsByWalletId={portfolio?.snapshotsByWalletId || {}}
                  quoteCurrency={quoteCurrency}
                  rates={rates}
                  fiatRateSeriesCache={fiatRateSeriesCache}
                  strokeScale={chartScale}
                  minStrokeScale={collapsedScale}
                  onChangeRowData={setChartChangeRowData}
                  axisLabelOpacity={axisLabelOpacity}
                  showChangeRow={false}
                  showTimeframeSelector
                  timeframeSelectorOpacity={timeframeSelectorOpacity}
                  disablePanGesture={isChartCollapsed}
                  // NOTE: Coinbase balance is intentionally excluded from the balance chart
                  // (Option B per product requirements) because we do not have historized
                  // Coinbase balance snapshots.
                  onSelectedBalanceChange={setSelectedChartBalance}
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
                    onPressIn={onExpandChartPress}
                  />
                ) : null}
              </View>
            </Animated.View>
          </ChartStage>
        ) : (
          <BalanceHistoryChart
            key={chartLifecycleKey}
            wallets={walletsAcrossKeys}
            snapshotsByWalletId={portfolio?.snapshotsByWalletId || {}}
            quoteCurrency={quoteCurrency}
            rates={rates}
            fiatRateSeriesCache={fiatRateSeriesCache}
            // NOTE: Coinbase balance is intentionally excluded from the balance chart
            // (Option B per product requirements) because we do not have historized
            // Coinbase balance snapshots.
            onSelectedBalanceChange={setSelectedChartBalance}
          />
        )
      ) : null}
    </PortfolioContainer>
  );
};

export default PortfolioBalance;
