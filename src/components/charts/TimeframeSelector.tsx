import React from 'react';
import styled from 'styled-components/native';
import {TouchableOpacity} from '@components/base/TouchableOpacity';
import {ActiveOpacity, WIDTH} from '../styled/Containers';
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
  onLongPressOption?: (value: T) => void;
  longPressDelayMs?: number;
};

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
  font-size: 16px;
  font-weight: 500;
  line-height: 24px;
  color: ${({theme, active}) =>
    active
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
  onLongPressOption,
  longPressDelayMs = 700,
}: Props<T>): React.ReactElement => {
  return (
    <TimeframeContainer>
      <TimeframeRow>
        {options.map(opt => {
          const active = opt.value === selected;
          return (
            <TimeframePill
              key={opt.value}
              active={active}
              hitSlop={TimeframeHitSlop}
              activeOpacity={ActiveOpacity}
              onPress={() => onSelect(opt.value)}
              onLongPress={
                onLongPressOption
                  ? () => onLongPressOption(opt.value)
                  : undefined
              }
              delayLongPress={longPressDelayMs}
              testID={opt.testID}>
              <TimeframeText active={active}>{opt.label}</TimeframeText>
            </TimeframePill>
          );
        })}
      </TimeframeRow>
    </TimeframeContainer>
  );
};

export default TimeframeSelector;
