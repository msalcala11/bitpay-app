import React, {useCallback, useMemo, useState} from 'react';
import type {SelectionDotProps} from 'react-native-graph';
import {GraphPoint, LineGraph} from 'react-native-graph';
import {Circle, Group} from '@shopify/react-native-skia';
import {
  runOnJS,
  useAnimatedReaction,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import styled, {useTheme} from 'styled-components/native';
import {
  Action,
  Black,
  LightBlue,
  LinkBlue,
  Midnight,
  Slate30,
  SlateDark,
  White,
} from '../../styles/colors';
import {ActiveOpacity, WIDTH} from '../styled/Containers';
import {BaseText} from '../styled/Text';
import Loader from '../loader/Loader';
import {
  DEFAULT_BALANCE_CHART_INTERVALS,
  type BalanceChartData,
  type BalanceChartPoint,
} from '../../utils/assets';
import type {FiatRateInterval} from '../../store/rate/rate.models';
import {changeOpacity, formatFiatAmount} from '../../utils/helper-methods';

type BalanceChartTimeframe = {
  label: string;
  value: FiatRateInterval;
};

type AxisLabelProps = {
  value: number;
  index: number;
  arrayLength: number;
  quoteCurrency: string;
  currencyAbbreviation?: string;
  type: 'min' | 'max';
  textColor?: string;
};

type BalanceChartProps = {
  data: BalanceChartData;
  quoteCurrency: string;
  currencyAbbreviation?: string;
  assetColor?: string;
  color?: string;
  gradientFillColors?: string[];
  height?: number;
  width?: number;
  isLoading?: boolean;
  showAxisLabels?: boolean;
  showTimeframes?: boolean;
  timeframes?: BalanceChartTimeframe[];
  selectedTimeframe?: FiatRateInterval;
  onTimeframeChange?: (interval: FiatRateInterval) => void;
  enablePanGesture?: boolean;
  onPointSelected?: (point: GraphPoint) => void;
  onGestureStart?: () => void;
  onGestureEnd?: () => void;
  style?: React.ComponentProps<typeof ChartContainer>['style'];
};

const DEFAULT_TIMEFRAME_LABELS: Record<FiatRateInterval, string> = {
  ALL: 'All',
  '1D': '1D',
  '1W': '1W',
  '1M': '1M',
  '3M': '3M',
  '1Y': '1Y',
  '5Y': '5Y',
};

const TimeframeHitSlop = {top: 10, bottom: 10, left: 10, right: 10} as const;

const ChartContainer = styled.View`
  margin-top: 8px;
`;

const ChartInner = styled.View`
  position: relative;
  align-items: center;
  justify-content: center;
  height: 220px;
`;

const ChartLoaderOverlay = styled.View`
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  justify-content: center;
  align-items: center;
`;

const TimeframeContainer = styled.View`
  margin-top: 5px;
  padding: 0 0px;
`;

const TimeframeRow = styled.View`
  flex-direction: row;
  justify-content: space-between;
  align-self: center;
  width: ${WIDTH - 24}px;
`;

const TimeframePill = styled.TouchableOpacity<{active: boolean}>`
  height: 34px;
  min-width: 44px;
  padding: 0 12px;
  border-radius: 18px;
  align-items: center;
  justify-content: center;
  background-color: ${({theme, active}) =>
    active ? (theme.dark ? Midnight : LightBlue) : 'transparent'};
`;

const TimeframeText = styled(BaseText)<{active: boolean}>`
  font-size: 14px;
  font-weight: ${({active}) => (active ? 500 : 400)};
  color: ${({theme, active}) =>
    active
      ? theme.dark
        ? LinkBlue
        : Action
      : theme.dark
      ? Slate30
      : SlateDark};
`;

const AxisLabelContainer = styled.View``;

const AxisLabelText = styled(BaseText)`
  font-weight: 400;
  font-size: 13px;
`;

const AxisLabel = ({
  value,
  index,
  arrayLength,
  quoteCurrency,
  currencyAbbreviation,
  type,
  textColor,
}: AxisLabelProps): React.ReactElement => {
  const theme = useTheme();
  const [textWidth, setTextWidth] = useState(50);
  const location = (index / arrayLength) * WIDTH - textWidth / 2;
  const minLocation = 5;
  const maxLocation = WIDTH - textWidth;
  const translateX = Math.min(Math.max(location, minLocation), maxLocation);
  const translateY = type === 'min' ? 5 : -5;
  const labelColor = textColor ?? (theme.dark ? Slate30 : SlateDark);

  return (
    <AxisLabelContainer
      style={{
        transform: [{translateY}],
        position: 'absolute',
      }}>
      <AxisLabelText
        style={{
          transform: [{translateX}],
          color: labelColor,
        }}
        onLayout={event => setTextWidth(event.nativeEvent.layout.width)}>
        {formatFiatAmount(value, quoteCurrency, {
          customPrecision: 'minimal',
          currencyAbbreviation,
        })}
      </AxisLabelText>
    </AxisLabelContainer>
  );
};

const ChartSelectionDot = ({
  isActive,
  color,
  circleX,
  circleY,
}: SelectionDotProps): React.ReactElement => {
  const outerRadius = useSharedValue(0);
  const innerRadius = useSharedValue(0);

  const setIsActive = useCallback(
    (active: boolean) => {
      outerRadius.value = withSpring(active ? 9 : 0, {
        mass: 1,
        stiffness: 1000,
        damping: 50,
        velocity: 0,
      });
      innerRadius.value = withSpring(active ? 4 : 0, {
        mass: 1,
        stiffness: 1000,
        damping: 50,
        velocity: 0,
      });
    },
    [innerRadius, outerRadius],
  );

  useAnimatedReaction(
    () => isActive.value,
    active => {
      runOnJS(setIsActive)(active);
    },
    [setIsActive],
  );
  return (
    <Group>
      <Circle
        cx={circleX}
        cy={circleY}
        r={outerRadius}
        color={color}
        opacity={0.18}
      />
      <Circle cx={circleX} cy={circleY} r={innerRadius} color={color} />
    </Group>
  );
};

const BalanceChart = ({
  data,
  quoteCurrency,
  currencyAbbreviation,
  assetColor,
  color,
  gradientFillColors,
  height = 200,
  width = WIDTH,
  isLoading,
  showAxisLabels = true,
  showTimeframes = true,
  timeframes,
  selectedTimeframe,
  onTimeframeChange,
  enablePanGesture,
  onPointSelected,
  onGestureStart,
  onGestureEnd,
  style,
}: BalanceChartProps): React.ReactElement => {
  const theme = useTheme();
  const chartPoints = data.data ?? [];

  const resolvedColor = useMemo(() => {
    if (color) {
      return color;
    }
    if (assetColor) {
      return theme.dark && assetColor === Black ? White : assetColor;
    }
    return theme.dark ? LinkBlue : Action;
  }, [assetColor, color, theme.dark]);

  const resolvedGradient = useMemo(() => {
    if (gradientFillColors?.length) {
      return gradientFillColors;
    }
    const opacity = theme.dark ? 0.16 : 0.12;
    return [changeOpacity(resolvedColor, opacity), 'transparent'];
  }, [gradientFillColors, resolvedColor, theme.dark]);

  const chartTimeframes = useMemo(() => {
    if (timeframes?.length) {
      return timeframes;
    }
    return DEFAULT_BALANCE_CHART_INTERVALS.map(interval => ({
      value: interval,
      label: DEFAULT_TIMEFRAME_LABELS[interval],
    }));
  }, [timeframes]);

  const shouldShowTimeframes =
    showTimeframes &&
    !!chartTimeframes.length &&
    !!selectedTimeframe &&
    typeof onTimeframeChange === 'function';

  const shouldShowAxisLabels =
    showAxisLabels &&
    !isLoading &&
    chartPoints.length > 0 &&
    typeof data.maxIndex === 'number' &&
    typeof data.minIndex === 'number' &&
    data.maxPoint?.value != null &&
    data.minPoint?.value != null;

  const maxAxisLabel = useCallback(() => {
    if (!shouldShowAxisLabels || typeof data.maxIndex !== 'number') {
      return null;
    }
    return (
      <AxisLabel
        value={data.maxPoint?.value ?? 0}
        index={data.maxIndex}
        arrayLength={chartPoints.length}
        quoteCurrency={quoteCurrency}
        currencyAbbreviation={currencyAbbreviation}
        type="max"
      />
    );
  }, [
    chartPoints.length,
    currencyAbbreviation,
    data.maxIndex,
    data.maxPoint?.value,
    quoteCurrency,
    shouldShowAxisLabels,
  ]);

  const minAxisLabel = useCallback(() => {
    if (!shouldShowAxisLabels || typeof data.minIndex !== 'number') {
      return null;
    }
    return (
      <AxisLabel
        value={data.minPoint?.value ?? 0}
        index={data.minIndex}
        arrayLength={chartPoints.length}
        quoteCurrency={quoteCurrency}
        currencyAbbreviation={currencyAbbreviation}
        type="min"
      />
    );
  }, [
    chartPoints.length,
    currencyAbbreviation,
    data.minIndex,
    data.minPoint?.value,
    quoteCurrency,
    shouldShowAxisLabels,
  ]);

  const usePanGesture =
    typeof enablePanGesture === 'boolean'
      ? enablePanGesture
      : Boolean(onPointSelected || onGestureStart || onGestureEnd);

  return (
    <>
      <ChartContainer style={style}>
        <ChartInner>
          <LineGraph
            points={chartPoints as BalanceChartPoint[]}
            animated={true}
            gradientFillColors={resolvedGradient}
            enablePanGesture={usePanGesture}
            panGestureDelay={100}
            onGestureStart={onGestureStart}
            onPointSelected={onPointSelected}
            onGestureEnd={onGestureEnd}
            TopAxisLabel={maxAxisLabel}
            BottomAxisLabel={minAxisLabel}
            SelectionDot={usePanGesture ? ChartSelectionDot : undefined}
            color={resolvedColor}
            style={{
              width,
              height,
              marginTop: 10,
              opacity: isLoading ? 0.25 : 1,
            }}
          />
          {isLoading ? (
            <ChartLoaderOverlay pointerEvents="none">
              <Loader size={32} spinning />
            </ChartLoaderOverlay>
          ) : null}
        </ChartInner>
      </ChartContainer>

      {shouldShowTimeframes ? (
        <TimeframeContainer>
          <TimeframeRow>
            {chartTimeframes.map(({label, value}) => {
              const active = selectedTimeframe === value;
              return (
                <TimeframePill
                  key={value}
                  active={active}
                  hitSlop={TimeframeHitSlop}
                  activeOpacity={ActiveOpacity}
                  onPress={() => onTimeframeChange?.(value)}>
                  <TimeframeText active={active}>{label}</TimeframeText>
                </TimeframePill>
              );
            })}
          </TimeframeRow>
        </TimeframeContainer>
      ) : null}
    </>
  );
};

export default BalanceChart;
