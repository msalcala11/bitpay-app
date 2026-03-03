import React from 'react';
import {LayoutChangeEvent, TouchableWithoutFeedback} from 'react-native';
import {useIsFocused} from '@react-navigation/native';
import styled, {useTheme} from 'styled-components/native';
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
  lineThickness?: number;
  isLoading?: boolean;
  hideLineWhileLoading?: boolean;
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
  lineThickness,
  isLoading,
  hideLineWhileLoading = false,
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
  const theme = useTheme();
  const isFocused = useIsFocused();

  const effectiveLineThickness =
    typeof lineThickness === 'number' ? lineThickness : theme.dark ? 2 : 4;

  /**
   * THEME SWITCH BEHAVIOR (important)
   *
   * Requirements:
   *   - Theme changes must immediately update chart color + thickness.
   *   - Theme changes must not trigger any visible animation.
   *   - Timeframe switches (points changes) should continue to animate.
   *
   * Why theme updates can look "inconsistent":
   *   - `react-native-graph` renders via Skia. When the chart's screen is not
   *     focused (e.g. you're in Settings), React can still re-render props, but
   *     the underlying native/Skia view may be detached/frozen by navigation.
   *   - In those cases, the color update can be "lost" visually until *some*
   *     later event forces the graph to recompute/refresh (e.g. timeframe
   *     changes).
   *
   * Fix strategy:
   *   1) Keep path geometry stable across light/dark so thickness changes don't
   *      alter the computed path (avoids the visible "scale/morph").
   *   2) Force a cheap redraw by passing a new `points` array reference (same
   *      values) when:
   *        - the style signature changes (theme switch), and
   *        - the screen becomes focused again after a theme switch that
   *          happened while unfocused (so the redraw occurs while visible).
   */

  // Keep geometry stable across theme switches (AnimatedLineGraph defaults
  // verticalPadding to lineThickness).
  const stableVerticalPadding = Math.max(
    // max thickness used across themes (light: 4, dark: 2)
    4,
    typeof lineThickness === 'number' ? lineThickness : 0,
  );
  const stableHorizontalPadding = 0;

  // A compact signature of everything that should change with theme.
  const styleSignature = `${color}|${gradientFillColors[0]}|${
    gradientFillColors[1]
  }|${effectiveLineThickness}`;

  /**
   * If the theme changes while this screen is NOT focused, we want to trigger a
   * redraw the moment it becomes focused again.
   */
  const lastFocusedStyleSignatureRef = React.useRef<string | null>(null);
  const [focusRefreshNonce, setFocusRefreshNonce] = React.useState(0);

  React.useEffect(() => {
    if (!isFocused) {
      return;
    }

    const prev = lastFocusedStyleSignatureRef.current;

    // Update the ref so it always represents the currently-focused signature.
    lastFocusedStyleSignatureRef.current = styleSignature;

    // If we are focused AND the signature differs from the last time we were
    // focused, a theme/style change happened while we were away. Force a redraw
    // now that we're visible again.
    if (prev != null && prev !== styleSignature) {
      setFocusRefreshNonce(n => n + 1);
    }
  }, [isFocused, styleSignature]);

  /**
   * In addition to focus changes, "reattaching" the view can happen without a
   * focus transition in some navigation setups. We treat the first layout after
   * a theme/style change as another opportunity to force a redraw.
   */
  const lastLayoutStyleSignatureRef = React.useRef<string | null>(null);
  const [layoutRefreshNonce, setLayoutRefreshNonce] = React.useState(0);

  const onChartLayout = React.useCallback(
    (_e: LayoutChangeEvent) => {
      const prev = lastLayoutStyleSignatureRef.current;
      lastLayoutStyleSignatureRef.current = styleSignature;

      if (prev != null && prev !== styleSignature) {
        setLayoutRefreshNonce(n => n + 1);
      }
    },
    [styleSignature],
  );

  // Force a new points array reference whenever either:
  //   - data changes (timeframe switch -> animation desired),
  //   - style changes (theme switch),
  //   - we regain focus after a theme switch (ensures redraw is visible),
  //   - layout happens after a theme switch (handles detach/reattach cases).
  const pointsForGraph = React.useMemo(
    () => points.slice(),
    [points, styleSignature, focusRefreshNonce, layoutRefreshNonce],
  );

  const chartInner = (
    <ChartInner onLayout={onChartLayout}>
      <LineGraph
        points={pointsForGraph}
        animated={animated}
        lineThickness={effectiveLineThickness}
        // Keep geometry stable across theme switches.
        verticalPadding={stableVerticalPadding}
        horizontalPadding={stableHorizontalPadding}
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
          opacity: isLoading ? (hideLineWhileLoading ? 0 : 0.25) : 1,
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
