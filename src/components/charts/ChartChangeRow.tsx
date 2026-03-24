import React from 'react';
import {Pressable, type StyleProp, type ViewStyle} from 'react-native';
import styled from 'styled-components/native';
import Percentage from '../percentage/Percentage';

const PercentRow = styled(Pressable)`
  flex-direction: row;
  align-items: center;
  justify-content: center;
`;

export type ChartChangeRowProps = {
  percent: number;
  deltaFiatFormatted?: string;
  rangeLabel?: string;
  style?: StyleProp<ViewStyle>;
  onLongPress?: () => void;
};

const ChartChangeRow = ({
  percent,
  deltaFiatFormatted,
  rangeLabel,
  style,
  onLongPress,
}: ChartChangeRowProps): React.ReactElement => {
  return (
    <PercentRow
      style={style}
      disabled={!onLongPress}
      delayLongPress={350}
      onLongPress={onLongPress}>
      <Percentage
        percentageDifference={percent}
        hideArrow
        hideSign
        priceChange={deltaFiatFormatted}
        rangeLabel={rangeLabel}
        fractionDigits={2}
      />
    </PercentRow>
  );
};

export default ChartChangeRow;
