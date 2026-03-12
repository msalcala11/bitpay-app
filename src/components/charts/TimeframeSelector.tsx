import React from 'react';
import type {StyleProp, ViewStyle} from 'react-native';
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

type Props<T extends string> = {
  options: Array<TimeframeSelectorOption<T>>;
  selected: T;
  onSelect: (value: T) => void;
  width?: number | string;
  horizontalPadding?: number;
  containerStyle?: StyleProp<ViewStyle>;
  rowStyle?: StyleProp<ViewStyle>;
};

const getWidthValue = (width?: number | string): string => {
  if (typeof width === 'number') {
    return `${width}px`;
  }

  return width || '100%';
};

const TimeframeContainer = styled.View<{$horizontalPadding: number}>`
  margin-top: 5px;
  padding: 0 ${({$horizontalPadding}) => $horizontalPadding}px;
`;

const TimeframeRow = styled.View<{$width?: number | string}>`
  flex-direction: row;
  justify-content: space-between;
  align-self: center;
  width: ${({$width}) => getWidthValue($width)};
  max-width: 100%;
`;

const TimeframeHitSlop = {top: 10, bottom: 10, left: 10, right: 10} as const;

const TimeframePill = styled(TouchableOpacity)<{$active: boolean}>`
  height: 34px;
  min-width: 44px;
  padding: 0 12px;
  border-radius: 18px;
  align-items: center;
  justify-content: center;
  background-color: ${({theme, $active}) =>
    $active ? (theme.dark ? Midnight : LightBlue) : 'transparent'};
`;

const TimeframeText = styled(BaseText)<{$active: boolean}>`
  font-size: 16px;
  font-weight: 500;
  line-height: 24px;
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
  horizontalPadding = 12,
  containerStyle,
  rowStyle,
}: Props<T>): React.ReactElement => {
  return (
    <TimeframeContainer
      $horizontalPadding={horizontalPadding}
      style={containerStyle}>
      <TimeframeRow $width={width} style={rowStyle}>
        {options.map(opt => {
          const active = opt.value === selected;
          return (
            <TimeframePill
              key={opt.value}
              $active={active}
              hitSlop={TimeframeHitSlop}
              activeOpacity={ActiveOpacity}
              onPress={() => onSelect(opt.value)}
              testID={opt.testID}>
              <TimeframeText $active={active}>{opt.label}</TimeframeText>
            </TimeframePill>
          );
        })}
      </TimeframeRow>
    </TimeframeContainer>
  );
};

export default TimeframeSelector;
