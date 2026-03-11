import React, {useEffect, useMemo, useState} from 'react';
import {useWindowDimensions} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import {useTheme} from 'styled-components/native';
import {BaseText} from '../styled/Text';
import {formatFiatAmount} from '../../utils/helper-methods';
import {Slate30, SlateDark} from '../../styles/colors';
import {
  isNumberSharedValue,
  type NumberSharedValue,
} from './sharedValueGuards';

export type ChartAxisLabelProps = {
  value: number;
  index: number;
  arrayLength: number;
  chartWidth?: number;
  quoteCurrency: string;
  currencyAbbreviation?: string;
  type: 'min' | 'max';
  textColor?: string;
  contentOpacity?: number | NumberSharedValue;
};

const AnimatedBaseText = Animated.createAnimatedComponent(BaseText);

const ChartAxisLabel = ({
  value,
  index,
  arrayLength,
  chartWidth,
  quoteCurrency,
  currencyAbbreviation,
  type,
  textColor,
  contentOpacity = 1,
}: ChartAxisLabelProps): React.ReactElement => {
  const theme = useTheme();
  const {width: windowWidth} = useWindowDimensions();

  const labelText = useMemo(() => {
    return formatFiatAmount(value, quoteCurrency, {
      currencyAbbreviation,
    });
  }, [currencyAbbreviation, quoteCurrency, value]);

  // We need an accurate text width to position the label without clipping.
  // Measuring via onLayout is correct, but between timeframes the label text can
  // change (different number of digits). If we keep using the *previous* width
  // until the next onLayout fires, the computed clamped X can be wildly wrong
  // (often snapping to an edge) and then "correcting" a frame later.
  //
  // To avoid that jarring intermediate snap, we track the width *for the
  // specific text we measured* and fall back to a cheap estimate for new text
  // until its layout is measured.
  const [measuredTextLayout, setMeasuredTextLayout] = useState<{
    text: string;
    width: number;
  }>({text: '', width: 50});

  const estimatedTextWidth = useMemo(() => {
    const fontSize = 13;
    // Digits and punctuation in RN's default fonts average ~0.55–0.6em.
    const avgCharWidth = fontSize * 0.58;
    const padding = 8;
    const estimated = labelText.length * avgCharWidth + padding;
    // Keep the estimate sane; it only needs to avoid edge-clamp snaps.
    return Math.min(Math.max(estimated, 40), 220);
  }, [labelText]);

  const textWidth =
    measuredTextLayout.text === labelText && measuredTextLayout.width > 0
      ? measuredTextLayout.width
      : estimatedTextWidth;

  const effectiveChartWidth =
    typeof chartWidth === 'number' && chartWidth > 0 ? chartWidth : windowWidth;

  const getPointRatio = (pointIndex: number, length: number): number => {
    if (length <= 1) {
      return 0.5;
    }

    const maxIndex = length - 1;
    const safePointIndex = Math.min(Math.max(pointIndex, 0), maxIndex);
    return safePointIndex / maxIndex;
  };

  const location = getPointRatio(index, arrayLength) * effectiveChartWidth - textWidth / 2;

  const getTranslateX = (loc: number) => {
    const minLocation = 5;
    const maxLocation = Math.max(minLocation, effectiveChartWidth - textWidth);
    return Math.min(Math.max(loc, minLocation), maxLocation);
  };

  const newTranslateX = getTranslateX(location);

  const translateX = useSharedValue(newTranslateX);
  useEffect(() => {
    if (Math.abs(translateX.value - newTranslateX) < 0.5) {
      translateX.value = newTranslateX;
      return;
    }

    translateX.value = withSpring(newTranslateX, {
      mass: 1,
      stiffness: 500,
      damping: 400,
      velocity: 0,
    });
  }, [newTranslateX, translateX]);

  const translateY = type === 'min' ? 5 : -5;

  const opacity = useSharedValue(0);
  useEffect(() => {
    opacity.value = withTiming(1, {duration: 800});
  }, [opacity]);

  const labelColor = textColor ?? (theme.dark ? Slate30 : SlateDark);

  const contentOpacityIsSharedValue = isNumberSharedValue(contentOpacity);
  const sharedContentOpacity = contentOpacityIsSharedValue
    ? contentOpacity
    : undefined;

  const contentOpacityNumber =
    typeof contentOpacity === 'number' ? contentOpacity : 1;

  const contentOpacityAnimatedStyle = useAnimatedStyle(() => {
    return {
      opacity: sharedContentOpacity
        ? sharedContentOpacity.value
        : contentOpacityNumber,
    };
  }, [contentOpacityNumber, sharedContentOpacity]);

  return (
    <Animated.View
      style={{
        flexDirection: 'row',
        transform: [{translateY}],
        opacity,
      }}>
      <Animated.View
        style={{transform: [{translateX}]}}
        onLayout={event => {
          const w = event.nativeEvent.layout.width;
          if (!Number.isFinite(w) || w <= 0) {
            return;
          }
          setMeasuredTextLayout(prev => {
            // Avoid setState churn for tiny diffs.
            if (prev.text === labelText && Math.abs(prev.width - w) < 0.5) {
              return prev;
            }
            return {text: labelText, width: w};
          });
        }}>
        <AnimatedBaseText
          style={[
            {
              color: labelColor,
              fontWeight: '400',
              fontSize: 13,
            },
            contentOpacityAnimatedStyle,
          ]}>
          {labelText}
        </AnimatedBaseText>
      </Animated.View>
    </Animated.View>
  );
};

export default ChartAxisLabel;
