import React from 'react';
import {StyleProp, ViewStyle} from 'react-native';
import type {SelectionDotProps} from 'react-native-graph';
import {GraphPoint, LineGraph} from 'react-native-graph';
import styled from 'styled-components/native';
import {TouchableOpacity} from '../base/TouchableOpacity';
import Loader from '../loader/Loader';
import {ActiveOpacity, WIDTH} from '../styled/Containers';
import {BaseText} from '../styled/Text';
import type {FiatRateInterval} from '../../store/rate/rate.models';
import {
  Action,
  LightBlue,
  LinkBlue,
  Midnight,
  Slate30,
  SlateDark,
} from '../../styles/colors';

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

const TimeframeHitSlop = {top: 10, bottom: 10, left: 10, right: 10} as const;

const TimeframePill = styled(TouchableOpacity)<{active: boolean}>`
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

export type TimeframeLineGraphProps = {
  points: GraphPoint[];
  selectedTimeframe: FiatRateInterval;
  onTimeframeChange: (timeframe: FiatRateInterval) => void;

  color: string;
  gradientFillColors: string[];

  isLoading?: boolean;
  enablePanGesture?: boolean;
  panGestureDelay?: number;

  onGestureStart?: () => void;
  onPointSelected?: (point: GraphPoint) => void;
  onGestureEnd?: () => void;

  TopAxisLabel?: React.ComponentType<any>;
  BottomAxisLabel?: React.ComponentType<any>;
  SelectionDot?: React.ComponentType<SelectionDotProps>;

  graphStyle?: StyleProp<ViewStyle>;
};

const DEFAULT_TIMEFRAMES: Array<{label: string; value: FiatRateInterval}> = [
  {label: 'All', value: 'ALL'},
  {label: '1D', value: '1D'},
  {label: '1W', value: '1W'},
  {label: '1M', value: '1M'},
  {label: '3M', value: '3M'},
  {label: '1Y', value: '1Y'},
  {label: '5Y', value: '5Y'},
];

/**
 * Shared line-graph UI with the 7 timeframe switcher underneath.
 * Designed to mimic the ExchangeRate chart area so it can be reused across screens.
 */
const TimeframeLineGraph: React.FC<TimeframeLineGraphProps> = props => {
  const {
    points,
    selectedTimeframe,
    onTimeframeChange,
    isLoading,
    color,
    gradientFillColors,
    enablePanGesture = true,
    panGestureDelay = 100,
    onGestureStart,
    onPointSelected,
    onGestureEnd,
    TopAxisLabel,
    BottomAxisLabel,
    SelectionDot,
    graphStyle,
  } = props;

  return (
    <>
      <ChartContainer>
        <ChartInner>
          <LineGraph
            points={points}
            animated={true}
            gradientFillColors={gradientFillColors}
            enablePanGesture={enablePanGesture}
            panGestureDelay={panGestureDelay}
            onGestureStart={onGestureStart}
            onPointSelected={onPointSelected}
            onGestureEnd={onGestureEnd}
            TopAxisLabel={TopAxisLabel}
            BottomAxisLabel={BottomAxisLabel}
            SelectionDot={SelectionDot}
            color={color}
            style={[
              {
                width: WIDTH,
                height: 200,
                marginTop: 10,
                opacity: isLoading ? 0.25 : 1,
              },
              graphStyle,
            ]}
          />
          {isLoading ? (
            <ChartLoaderOverlay pointerEvents="none">
              <Loader size={32} spinning />
            </ChartLoaderOverlay>
          ) : null}
        </ChartInner>
      </ChartContainer>

      <TimeframeContainer>
        <TimeframeRow>
          {DEFAULT_TIMEFRAMES.map(({label, value}) => {
            const active = selectedTimeframe === value;
            return (
              <TimeframePill
                key={value}
                active={active}
                hitSlop={TimeframeHitSlop}
                activeOpacity={ActiveOpacity}
                onPress={() => onTimeframeChange(value)}>
                <TimeframeText active={active}>{label}</TimeframeText>
              </TimeframePill>
            );
          })}
        </TimeframeRow>
      </TimeframeContainer>
    </>
  );
};

export default TimeframeLineGraph;
