import React from 'react';
import type {StyleProp, TextStyle, ViewStyle} from 'react-native';
import styled from 'styled-components/native';
import {TouchableOpacity} from '@components/base/TouchableOpacity';
import {ActiveOpacity} from '../styled/Containers';
import {BaseText} from '../styled/Text';
import {
  Action,
  LightBlue,
  LinkBlue,
  Midnight,
  Slate30,
  SlateDark,
} from '../../styles/colors';

export type TimeframeSelectorOption<T extends string> = {
  value: T;
  label: string;
  testID?: string;
};

type TimeframeSelectorSize = 'default' | 'compact';

type Props<T extends string> = {
  options: Array<TimeframeSelectorOption<T>>;
  selected: T;
  onSelect: (value: T) => void;
  width?: number;
  size?: TimeframeSelectorSize;
  containerStyle?: StyleProp<ViewStyle>;
  rowStyle?: StyleProp<ViewStyle>;
  pillStyle?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
};

const TIMEFRAME_SELECTOR_SIZES: Record<
  TimeframeSelectorSize,
  {
    pillHeight: number;
    pillMinWidth: number;
    pillHorizontalPadding: number;
    fontSize: number;
    lineHeight: number;
  }
> = {
  default: {
    pillHeight: 34,
    pillMinWidth: 44,
    pillHorizontalPadding: 12,
    fontSize: 16,
    lineHeight: 24,
  },
  compact: {
    pillHeight: 32,
    pillMinWidth: 40,
    pillHorizontalPadding: 10,
    fontSize: 15,
    lineHeight: 22,
  },
};

const TimeframeContainer = styled.View`
  width: 100%;
  margin-top: 5px;
  padding: 0;
`;

const TimeframeRow = styled.View<{$width?: number}>`
  flex-direction: row;
  justify-content: space-between;
  align-self: center;
  width: ${({$width}) =>
    typeof $width === 'number' && $width > 0 ? `${$width}px` : '100%'};
`;

const TimeframeHitSlop = {top: 10, bottom: 10, left: 10, right: 10} as const;

const TimeframePill = styled(TouchableOpacity)<{
  $active: boolean;
  $pillHeight: number;
  $pillMinWidth: number;
  $pillHorizontalPadding: number;
}>`
  height: ${({$pillHeight}) => `${$pillHeight}px`};
  min-width: ${({$pillMinWidth}) => `${$pillMinWidth}px`};
  padding: 0 ${({$pillHorizontalPadding}) => `${$pillHorizontalPadding}px`};
  border-radius: 18px;
  align-items: center;
  justify-content: center;
  background-color: ${({theme, $active}) =>
    $active ? (theme.dark ? Midnight : LightBlue) : 'transparent'};
`;

const TimeframeText = styled(BaseText)<{
  $active: boolean;
  $fontSize: number;
  $lineHeight: number;
}>`
  font-size: ${({$fontSize}) => `${$fontSize}px`};
  font-weight: 500;
  line-height: ${({$lineHeight}) => `${$lineHeight}px`};
  color: ${({theme, $active}) =>
    $active
      ? theme.dark
        ? LinkBlue
        : Action
      : theme.dark
      ? Slate30
      : SlateDark};
`;

export const TimeframeSelector = <T extends string>({
  options,
  selected,
  onSelect,
  width,
  size = 'default',
  containerStyle,
  rowStyle,
  pillStyle,
  textStyle,
}: Props<T>): React.ReactElement => {
  const metrics = TIMEFRAME_SELECTOR_SIZES[size] || TIMEFRAME_SELECTOR_SIZES.default;

  return (
    <TimeframeContainer style={containerStyle}>
      <TimeframeRow $width={width} style={rowStyle}>
        {options.map(opt => {
          const active = opt.value === selected;
          return (
            <TimeframePill
              key={opt.value}
              $active={active}
              $pillHeight={metrics.pillHeight}
              $pillMinWidth={metrics.pillMinWidth}
              $pillHorizontalPadding={metrics.pillHorizontalPadding}
              style={pillStyle}
              hitSlop={TimeframeHitSlop}
              activeOpacity={ActiveOpacity}
              onPress={() => onSelect(opt.value)}
              testID={opt.testID}>
              <TimeframeText
                $active={active}
                $fontSize={metrics.fontSize}
                $lineHeight={metrics.lineHeight}
                style={textStyle}>
                {opt.label}
              </TimeframeText>
            </TimeframePill>
          );
        })}
      </TimeframeRow>
    </TimeframeContainer>
  );
};

export default TimeframeSelector;
