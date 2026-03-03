import React from 'react';
import {TouchableWithoutFeedback} from 'react-native';
import styled from 'styled-components/native';
import {LineGraph, type GraphPoint} from 'react-native-graph';
import type {SelectionDotProps} from 'react-native-graph';
import Loader from '../loader/Loader';
import {WIDTH} from '../styled/Containers';

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

export type InteractiveLineChartProps = {
  points: GraphPoint[];
  color: string;
  gradientFillColors: [string, string];
  isLoading?: boolean;
  enablePanGesture?: boolean;
  panGestureDelay?: number;
  animated?: boolean;
  SelectionDot?: React.ComponentType<SelectionDotProps>;
  TopAxisLabel?: React.ComponentType<any>;
  BottomAxisLabel?: React.ComponentType<any>;
  onGestureStart?: () => void;
  onGestureEnd?: () => void;
  onPointSelected?: (point: GraphPoint) => void;
  /**
   * Optional diagnostics hook.
   * Long-press can be used to copy chart diagnostics.
   */
  onLongPress?: () => void;
  longPressDelayMs?: number;
};

const InteractiveLineChart = ({
  points,
  color,
  gradientFillColors,
  isLoading,
  enablePanGesture = true,
  panGestureDelay = 100,
  animated = true,
  SelectionDot,
  TopAxisLabel,
  BottomAxisLabel,
  onGestureEnd,
  onGestureStart,
  onPointSelected,
  onLongPress,
  longPressDelayMs = 800,
}: InteractiveLineChartProps): React.ReactElement => {
  const chartInner = (
    <ChartInner>
      <LineGraph
        points={points}
        animated={animated}
        panGestureDelay={panGestureDelay}
        enablePanGesture={enablePanGesture}
        color={color}
        gradientFillColors={gradientFillColors}
        TopAxisLabel={TopAxisLabel}
        BottomAxisLabel={BottomAxisLabel}
        SelectionDot={SelectionDot}
        onGestureStart={onGestureStart}
        onGestureEnd={onGestureEnd}
        onPointSelected={onPointSelected}
        style={{
          width: WIDTH,
          height: 200,
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
  );

  return (
    <ChartContainer>
      {onLongPress ? (
        <TouchableWithoutFeedback
          onLongPress={onLongPress}
          delayLongPress={longPressDelayMs}>
          {chartInner}
        </TouchableWithoutFeedback>
      ) : (
        chartInner
      )}
    </ChartContainer>
  );
};

export default InteractiveLineChart;
