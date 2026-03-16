import React from 'react';
import {render} from '@testing-library/react-native';
import type {HydratedBalanceChartSeries} from '../../utils/portfolio/chartCache';
import type {
  BalanceHistoryChartOrchestrationAction,
  TimeframeChartStateByTimeframe,
} from './balanceHistoryChartOrchestration';
import type {ChangeRowData} from './balanceHistoryChartSelection';
import {useBalanceHistoryChartSelectionState} from './useBalanceHistoryChartSelectionState';

jest.mock('../haptic-feedback/haptic', () => jest.fn());

const point = {
  timestamp: 1_000,
  totalFiatBalance: 100,
  totalRemainingCostBasisFiat: 80,
  totalUnrealizedPnlFiat: 20,
  totalPnlPercent: 25,
  byWalletId: {},
};

jest.mock('../../utils/helper-methods', () => ({
  formatFiatAmount: (value: number, currency: string) => `${currency}:${value}`,
}));

type HarnessProps = {
  activeSeries?: HydratedBalanceChartSeries;
  displayedTimeframe: '1D' | '1W';
  selectedTimeframe: '1D' | '1W';
  rangeLabel: string;
  timeframeStateByTimeframe?: TimeframeChartStateByTimeframe<
    HydratedBalanceChartSeries,
    ChangeRowData
  >;
  dispatchTimeframeState: React.Dispatch<
    BalanceHistoryChartOrchestrationAction<
      HydratedBalanceChartSeries,
      ChangeRowData
    >
  >;
  onChangeRowData?: (data: ChangeRowData) => void;
};

const activeSeries = {
  analysisPoints: [point],
  pointByTimestamp: new Map([[point.timestamp, point]]),
} as unknown as HydratedBalanceChartSeries;

const SelectionStateHarness = (props: HarnessProps) => {
  useBalanceHistoryChartSelectionState({
    activeSeries: props.activeSeries,
    cachedSelectedSeries: undefined,
    selectedTimeframe: props.selectedTimeframe,
    displayedTimeframe: props.displayedTimeframe,
    rangeLabel: props.rangeLabel,
    quoteCurrency: 'USD',
    balanceOffset: 0,
    timeframeStateByTimeframe: props.timeframeStateByTimeframe || {},
    dispatchTimeframeState: props.dispatchTimeframeState,
    onSelectedBalanceChangeRef: {current: undefined},
    onChangeRowData: props.onChangeRowData,
  });

  return null;
};

describe('useBalanceHistoryChartSelectionState', () => {
  it('does not cache change-row data for a pending selected timeframe', () => {
    const dispatchTimeframeState = jest.fn();
    const onChangeRowData = jest.fn();

    const screen = render(
      <SelectionStateHarness
        activeSeries={activeSeries}
        displayedTimeframe="1D"
        selectedTimeframe="1W"
        rangeLabel="Last Day"
        dispatchTimeframeState={dispatchTimeframeState}
        onChangeRowData={onChangeRowData}
      />,
    );

    expect(onChangeRowData).toHaveBeenLastCalledWith({
      percent: 25,
      deltaFiatFormatted: 'USD:20',
      rangeLabel: 'Last Day',
    });
    expect(dispatchTimeframeState).not.toHaveBeenCalled();

    screen.rerender(
      <SelectionStateHarness
        activeSeries={activeSeries}
        displayedTimeframe="1W"
        selectedTimeframe="1W"
        rangeLabel="Past Week"
        dispatchTimeframeState={dispatchTimeframeState}
        onChangeRowData={onChangeRowData}
      />,
    );

    expect(dispatchTimeframeState).toHaveBeenCalledWith({
      type: 'setResolvedChangeRowData',
      timeframe: '1W',
      data: {
        percent: 25,
        deltaFiatFormatted: 'USD:20',
        rangeLabel: 'Past Week',
      },
    });
  });
});
