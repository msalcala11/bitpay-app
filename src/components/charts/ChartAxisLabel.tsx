import React, {useState} from 'react';
import Animated, {
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import {useTheme} from 'styled-components/native';
import {WIDTH} from '../styled/Containers';
import {BaseText} from '../styled/Text';
import {formatFiatAmount} from '../../utils/helper-methods';
import type {RootState} from '../../store';
import {useAppSelector} from '../../utils/hooks';
import {Slate30, SlateDark} from '../../styles/colors';

export type ChartAxisLabelProps = {
  value: number;
  index: number;
  prevIndex?: number;
  arrayLength: number;
  currencyAbbreviation?: string;
  type: 'min' | 'max';
  textColor?: string;
};

const ChartAxisLabel = ({
  value,
  index,
  prevIndex,
  arrayLength,
  currencyAbbreviation,
  type,
  textColor,
}: ChartAxisLabelProps): React.ReactElement => {
  const defaultAltCurrency = useAppSelector(
    ({APP}: RootState) => APP.defaultAltCurrency,
  );
  const theme = useTheme();
  const [textWidth, setTextWidth] = useState(50);

  const prevLocation =
    ((prevIndex ?? index) / arrayLength) * WIDTH - textWidth / 2;
  const location = (index / arrayLength) * WIDTH - textWidth / 2;

  const getTranslateX = (loc: number) => {
    const minLocation = 5;
    const maxLocation = WIDTH - textWidth;
    return Math.min(Math.max(loc, minLocation), maxLocation);
  };

  const prevTranslateX = getTranslateX(prevLocation);
  const newTranslateX = getTranslateX(location);

  const translateX = useSharedValue(prevTranslateX);
  translateX.value = withSpring(newTranslateX, {
    mass: 1,
    stiffness: 500,
    damping: 400,
    velocity: 0,
  });

  const translateY = type === 'min' ? 5 : -5;

  const opacity = useSharedValue(typeof prevIndex !== 'undefined' ? 1 : 0);
  opacity.value = withTiming(1, {duration: 800});

  const labelColor = textColor ?? (theme.dark ? Slate30 : SlateDark);

  return (
    <Animated.View
      style={{
        flexDirection: 'row',
        transform: [{translateY}],
        opacity,
      }}>
      <Animated.View
        style={{transform: [{translateX}]}}
        onLayout={event => setTextWidth(event.nativeEvent.layout.width)}>
        <BaseText
          style={{
            color: labelColor,
            fontWeight: '400',
            fontSize: 13,
          }}>
          {formatFiatAmount(value, defaultAltCurrency.isoCode, {
            currencyAbbreviation,
          })}
        </BaseText>
      </Animated.View>
    </Animated.View>
  );
};

export default ChartAxisLabel;
