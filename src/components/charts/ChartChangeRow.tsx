import React from 'react';
import styled from 'styled-components/native';
import Percentage from '../percentage/Percentage';

const PercentRow = styled.View`
  flex-direction: row;
  align-items: center;
  justify-content: center;
`;

export type ChartChangeRowProps = {
  percent: number;
  deltaFiatFormatted?: string;
  rangeLabel?: string;
  isLoading?: boolean;
  style?: any;
};

const ChartChangeRow = ({
  percent,
  deltaFiatFormatted,
  rangeLabel,
  isLoading,
  style,
}: ChartChangeRowProps): React.ReactElement => {
  return (
    <PercentRow style={[style, {opacity: isLoading ? 0 : 1}]}>
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
