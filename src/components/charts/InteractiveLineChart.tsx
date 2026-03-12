import React from 'react';
import {LayoutChangeEvent} from 'react-native';
import {useIsFocused} from '@react-navigation/native';
import styled, {useTheme} from 'styled-components/native';
import {LineGraph, type GraphPoint} from 'react-native-graph';
import type {SelectionDotProps} from 'react-native-graph';
import Svg, {Line} from 'react-native-svg';
import Reanimated, {
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import Loader from '../loader/Loader';
import {Slate, SlateDark} from '../../styles/colors';
import {
  isNumberSharedValue,
  type NumberSharedValue,
} from './sharedValueGuards';

const ChartContainer = styled.View`
  margin-top: 0;
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

const AnimatedSvgLine = Reanimated.createAnimatedComponent(Line);

const FIRST_POINT_GUIDE_LINE_DASH_LENGTH = 2.5;
const FIRST_POINT_GUIDE_LINE_GAP_LENGTH = 4.1;
const FIRST_POINT_GUIDE_LINE_SVG_HEIGHT = 4;

export type InteractiveLineChartProps = {
  points: GraphPoint[];
  color: string;
  gradientFillColors: [string, string];
  lineThickness?: number;
  chartWidth?: number | string;
  /**
   * If the chart is being scaled by an ancestor transform, pass that scale here.
   *
   * We use this to compensate stroke widths (and dash pattern) so they appear
   * visually constant even while the chart view itself is being scaled.
   */
  strokeScale?: number | NumberSharedValue;
  /**
   * Optional lower bound for `strokeScale`.
   *
   * When the chart is animated with an ancestor scale transform, the
   * compensated stroke can become much thicker than its base thickness.
   * `react-native-graph` computes the path using a static `verticalPadding`, so
   * if we know the smallest scale the animation can reach we can reserve enough
   * padding up-front to avoid edge clipping without animating layout.
   */
  minStrokeScale?: number;
  isLoading?: boolean;
  hideLineWhileLoading?: boolean;
  enablePanGesture?: boolean;
  panGestureDelay?: number;
  animated?: boolean;
  SelectionDot?: React.ComponentType<SelectionDotProps>;
  TopAxisLabel?: React.ComponentType;
  BottomAxisLabel?: React.ComponentType;
  onGestureStart?: () => void;
  onGestureEnd?: () => void;
  onPointSelected?: (point: GraphPoint) => void;
  showFirstPointGuideLine?: boolean;
  firstPointGuideLineColor?: string;
};

type SvgLineAnimatedProps = Partial<React.ComponentProps<typeof Line>>;

const InteractiveLineChart = ({
  points,
  color,
  gradientFillColors,
  lineThickness,
  chartWidth,
  strokeScale,
  minStrokeScale,
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
  showFirstPointGuideLine = false,
  firstPointGuideLineColor,
}: InteractiveLineChartProps): React.ReactElement => {
  const theme = useTheme();
  const isFocused = useIsFocused();
  const graphHeight = 200;
  const graphMarginTop = 10;
  const axisLabelPadding = 20;
  const axisRowHeight = 17;

  const [lineGraphLayout, setLineGraphLayout] = React.useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const firstPointGuideLineTop = useSharedValue(0);
  const isGuideLineTopInitializedRef = React.useRef(false);

  const effectiveLineThickness =
    typeof lineThickness === 'number' ? lineThickness : theme.dark ? 2 : 4;

  const strokeScaleIsSharedValue = isNumberSharedValue(strokeScale);

  const strokeScaleNumber = typeof strokeScale === 'number' ? strokeScale : 1;
  const safeStrokeScaleNumber = strokeScaleNumber > 0 ? strokeScaleNumber : 1;
  const lineThicknessCompensationExponent = strokeScaleIsSharedValue ? 0.9 : 1;

  const strokeScaleValue = useDerivedValue(() => {
    'worklet';

    if (typeof strokeScale === 'number') {
      return strokeScale;
    }
    if (strokeScale != null && typeof strokeScale === 'object') {
      const value = (strokeScale as {value?: unknown}).value;
      return typeof value === 'number' ? value : 1;
    }
    return 1;
  }, [strokeScale]);

  const compensatedLineThickness = useDerivedValue(() => {
    'worklet';
    const scale = strokeScaleValue.value;
    const safeScale = scale > 0 ? scale : 1;
    return effectiveLineThickness / Math.pow(safeScale, 0.9);
  }, [effectiveLineThickness, strokeScaleValue]);

  const lineThicknessForGraph: number | NumberSharedValue =
    strokeScaleIsSharedValue
      ? compensatedLineThickness
      : effectiveLineThickness /
        Math.pow(safeStrokeScaleNumber, lineThicknessCompensationExponent);

  const firstPointGuideLineAnimatedProps = useAnimatedProps<SvgLineAnimatedProps>(
    () => {
      const scale = strokeScaleValue.value;
      const safeScale = scale > 0 ? scale : 1;

      return {
        strokeWidth: 1 / safeScale,
        strokeDasharray: [
          FIRST_POINT_GUIDE_LINE_DASH_LENGTH / safeScale,
          FIRST_POINT_GUIDE_LINE_GAP_LENGTH / safeScale,
        ],
      };
    },
    [strokeScaleValue],
  );

  const resolvedMinStrokeScale =
    typeof minStrokeScale === 'number' && minStrokeScale > 0
      ? Math.min(minStrokeScale, 1)
      : strokeScaleIsSharedValue
      ? 1
      : Math.min(safeStrokeScaleNumber, 1);

  const maxCompensatedLineThickness =
    effectiveLineThickness /
    Math.pow(resolvedMinStrokeScale, lineThicknessCompensationExponent);

  const stableVerticalPadding = Math.max(
    4,
    typeof lineThickness === 'number' ? lineThickness : 0,
    Math.ceil(maxCompensatedLineThickness),
  );
  const stableHorizontalPadding = 0;

  const styleSignature = `${color}|${gradientFillColors[0]}|${
    gradientFillColors[1]
  }|${effectiveLineThickness}|${stableVerticalPadding}|${chartWidth || 'auto'}`;

  const lastFocusedStyleSignatureRef = React.useRef<string | null>(null);
  const [focusRefreshNonce, setFocusRefreshNonce] = React.useState(0);

  React.useEffect(() => {
    if (!isFocused) {
      return;
    }

    const prev = lastFocusedStyleSignatureRef.current;
    lastFocusedStyleSignatureRef.current = styleSignature;

    if (prev != null && prev !== styleSignature) {
      setFocusRefreshNonce(n => n + 1);
    }
  }, [isFocused, styleSignature]);

  const lastLayoutStyleSignatureRef = React.useRef<string | null>(null);
  const [layoutRefreshNonce, setLayoutRefreshNonce] = React.useState(0);

  const onChartLayout = React.useCallback(
    (_event: LayoutChangeEvent) => {
      const prev = lastLayoutStyleSignatureRef.current;
      lastLayoutStyleSignatureRef.current = styleSignature;

      if (prev != null && prev !== styleSignature) {
        setLayoutRefreshNonce(n => n + 1);
      }
    },
    [styleSignature],
  );

  const pointsRefreshKey = React.useMemo(
    () => `${styleSignature}|${focusRefreshNonce}|${layoutRefreshNonce}`,
    [focusRefreshNonce, layoutRefreshNonce, styleSignature],
  );

  const pointsForGraph = React.useMemo(() => {
    return points.slice();
  }, [points, pointsRefreshKey]);
  const hasDrawablePoints = pointsForGraph.length >= 2;

  const firstPointGuideLine = React.useMemo(() => {
    if (!showFirstPointGuideLine || !pointsForGraph.length || !lineGraphLayout) {
      return null;
    }

    let minValue = Number.POSITIVE_INFINITY;
    let maxValue = Number.NEGATIVE_INFINITY;
    for (const point of pointsForGraph) {
      const value = Number(point?.value);
      if (!Number.isFinite(value)) {
        continue;
      }
      if (value < minValue) {
        minValue = value;
      }
      if (value > maxValue) {
        maxValue = value;
      }
    }

    if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) {
      return null;
    }

    const firstPointValue = Number.isFinite(pointsForGraph[0]?.value)
      ? Number(pointsForGraph[0]?.value)
      : minValue;
    const topAxisInset = TopAxisLabel ? axisLabelPadding + axisRowHeight : 0;
    const bottomAxisInset = BottomAxisLabel
      ? axisLabelPadding + axisRowHeight
      : 0;

    const canvasHeight = Math.max(
      0,
      lineGraphLayout.height - topAxisInset - bottomAxisInset,
    );
    const drawingHeight = Math.max(0, canvasHeight - stableVerticalPadding * 2);

    const yPositionInRange =
      maxValue === minValue
        ? 0.5
        : (firstPointValue - minValue) / (maxValue - minValue);
    const yInRange = Math.floor(drawingHeight * yPositionInRange);
    const y = drawingHeight - yInRange + stableVerticalPadding;
    const top = lineGraphLayout.y + topAxisInset + y;

    return {
      left: lineGraphLayout.x + stableHorizontalPadding,
      width: Math.max(0, lineGraphLayout.width - stableHorizontalPadding),
      top,
      color: firstPointGuideLineColor ?? (theme.dark ? Slate : SlateDark),
    };
  }, [
    BottomAxisLabel,
    TopAxisLabel,
    axisLabelPadding,
    axisRowHeight,
    firstPointGuideLineColor,
    lineGraphLayout,
    pointsForGraph,
    showFirstPointGuideLine,
    stableHorizontalPadding,
    stableVerticalPadding,
    theme.dark,
  ]);

  const firstPointGuideLineTopTarget =
    firstPointGuideLine != null
      ? firstPointGuideLine.top - FIRST_POINT_GUIDE_LINE_SVG_HEIGHT / 2
      : null;

  React.useEffect(() => {
    if (firstPointGuideLineTopTarget == null) {
      isGuideLineTopInitializedRef.current = false;
      return;
    }

    if (!isGuideLineTopInitializedRef.current) {
      firstPointGuideLineTop.value = firstPointGuideLineTopTarget;
      isGuideLineTopInitializedRef.current = true;
      return;
    }

    firstPointGuideLineTop.value = withTiming(firstPointGuideLineTopTarget, {
      duration: 260,
      easing: Easing.out(Easing.cubic),
    });
  }, [firstPointGuideLineTop, firstPointGuideLineTopTarget]);

  const firstPointGuideLineAnimatedStyle = useAnimatedStyle(() => {
    return {
      top: firstPointGuideLineTop.value,
    };
  }, [firstPointGuideLineTop]);

  const chartInner = (
    <ChartInner onLayout={onChartLayout}>
      {hasDrawablePoints ? (
        <LineGraph
          points={pointsForGraph}
          animated={animated}
          lineThickness={lineThicknessForGraph as unknown as number}
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
          onLayout={({nativeEvent: {layout}}) => {
            const next = {
              x: layout.x,
              y: layout.y,
              width: layout.width,
              height: layout.height,
            };
            setLineGraphLayout(prev =>
              prev &&
              prev.x === next.x &&
              prev.y === next.y &&
              prev.width === next.width &&
              prev.height === next.height
                ? prev
                : next,
            );
          }}
          style={{
            width: chartWidth || '100%',
            height: graphHeight,
            marginTop: graphMarginTop,
            opacity: isLoading ? (hideLineWhileLoading ? 0 : 0.25) : 1,
          }}
        />
      ) : null}
      {firstPointGuideLine ? (
        <Reanimated.View
          pointerEvents="none"
          style={[
            {
              position: 'absolute',
              left: firstPointGuideLine.left,
              width: firstPointGuideLine.width,
              height: FIRST_POINT_GUIDE_LINE_SVG_HEIGHT,
            },
            firstPointGuideLineAnimatedStyle,
          ]}>
          <Svg
            width={firstPointGuideLine.width}
            height={FIRST_POINT_GUIDE_LINE_SVG_HEIGHT}>
            <AnimatedSvgLine
              animatedProps={firstPointGuideLineAnimatedProps}
              x1={0}
              y1={FIRST_POINT_GUIDE_LINE_SVG_HEIGHT / 2}
              x2={firstPointGuideLine.width}
              y2={FIRST_POINT_GUIDE_LINE_SVG_HEIGHT / 2}
              stroke={firstPointGuideLine.color}
              strokeLinecap="butt"
            />
          </Svg>
        </Reanimated.View>
      ) : null}
      {isLoading ? (
        <ChartLoaderOverlay pointerEvents="none">
          <Loader size={32} spinning />
        </ChartLoaderOverlay>
      ) : null}
    </ChartInner>
  );

  return (
    <ChartContainer pointerEvents={isLoading ? 'none' : 'auto'}>
      {chartInner}
    </ChartContainer>
  );
};

export default InteractiveLineChart;
