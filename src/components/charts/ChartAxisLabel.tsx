import React, {useEffect, useMemo, useState} from 'react';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import {useTheme} from 'styled-components/native';
import {WIDTH} from '../styled/Containers';
import {BaseText} from '../styled/Text';
import {formatFiatAmount} from '../../utils/helper-methods';
import {Slate30, SlateDark} from '../../styles/colors';
import {isNumberSharedValue, type NumberSharedValue} from './sharedValueGuards';

export type ChartAxisLabelProps = {
  value: number;
  index: number;
  prevIndex?: number;
  /**
   * Previous series length.
   *
   * When switching timeframes, the previous chart series can have a different
   * number of points than the new series. `prevIndex` is relative to the
   * previous series, so we must normalize it using the previous length.
   *
   * If we instead divide `prevIndex` by the *new* array length, the computed
   * starting X can be wildly wrong (often clamped to an edge), which looks like
   * a jump before the label animates to its final position.
   */
  prevArrayLength?: number;
  arrayLength: number;
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
  prevIndex,
  prevArrayLength,
  arrayLength,
  quoteCurrency,
  currencyAbbreviation,
  type,
  textColor,
  contentOpacity = 1,
}: ChartAxisLabelProps): React.ReactElement => {
  const theme = useTheme();

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

  const getPointRatio = (pointIndex: number, length: number): number => {
    if (length <= 1) {
      return 0.5;
    }

    const maxIndex = length - 1;
    const safePointIndex = Math.min(Math.max(pointIndex, 0), maxIndex);
    return safePointIndex / maxIndex;
  };

  const resolvedPrevArrayLength =
    typeof prevArrayLength === 'number' ? prevArrayLength : arrayLength;
  const prevLocation =
    getPointRatio(prevIndex ?? index, resolvedPrevArrayLength) * WIDTH -
    textWidth / 2;
  const location = getPointRatio(index, arrayLength) * WIDTH - textWidth / 2;

  const getTranslateX = (loc: number) => {
    const minLocation = 5;
    const maxLocation = Math.max(minLocation, WIDTH - textWidth);
    return Math.min(Math.max(loc, minLocation), maxLocation);
  };

  const prevTranslateX = getTranslateX(prevLocation);
  const newTranslateX = getTranslateX(location);

  const translateX = useSharedValue(prevTranslateX);
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

  const opacity = useSharedValue(typeof prevIndex !== 'undefined' ? 1 : 0);
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
