import type {GraphPoint} from 'react-native-graph';
import {
  areBalanceHistoryChartChangeRowDataEqual,
  buildBalanceHistoryChartChangeRowData,
  getDisplayedBalanceHistoryAnalysisPoint,
  getSelectedBalanceHistoryValue,
} from './balanceHistoryChartSelection';

jest.mock('../../utils/helper-methods', () => ({
  formatFiatAmount: (value: number, currency: string) => `${currency}:${value}`,
}));

const pointA = {
  timestamp: 1_000,
  totalFiatBalance: 100,
  totalRemainingCostBasisFiat: 80,
  totalUnrealizedPnlFiat: 20,
  totalPnlPercent: 25,
  byWalletId: {},
};

const pointB = {
  timestamp: 2_000,
  totalFiatBalance: 120,
  totalRemainingCostBasisFiat: 90,
  totalUnrealizedPnlFiat: 30,
  totalPnlPercent: 33.33,
  byWalletId: {},
};

const cachedPoint = {
  ...pointB,
  timestamp: 3_000,
  totalFiatBalance: 130,
};

describe('balanceHistoryChartSelection', () => {
  it('prefers the selected analysis point, then the active latest point, then cached fallback', () => {
    const selectedPoint = {
      date: new Date(pointA.timestamp),
      value: 999,
    } as GraphPoint;
    const activeSeries = {
      analysisPoints: [pointA, pointB],
      pointByTimestamp: new Map([
        [pointA.timestamp, pointA],
        [pointB.timestamp, pointB],
      ]),
    } as any;
    const cachedSelectedSeries = {
      analysisPoints: [cachedPoint],
    } as any;

    expect(
      getDisplayedBalanceHistoryAnalysisPoint({
        selectedPoint,
        activeSeries,
        cachedSelectedSeries,
      }),
    ).toBe(pointA);
    expect(
      getDisplayedBalanceHistoryAnalysisPoint({
        activeSeries,
        cachedSelectedSeries,
      }),
    ).toBe(pointB);
    expect(
      getDisplayedBalanceHistoryAnalysisPoint({
        cachedSelectedSeries,
      }),
    ).toBe(cachedPoint);
  });

  it('builds change-row data and selected balances from resolved points', () => {
    const selectedPoint = {
      date: new Date(pointA.timestamp),
      value: 555,
    } as GraphPoint;
    const activeSeries = {
      analysisPoints: [pointA, pointB],
      pointByTimestamp: new Map([[pointA.timestamp, pointA]]),
    } as any;

    const changeRowData = buildBalanceHistoryChartChangeRowData({
      displayedAnalysisPoint: pointB as any,
      quoteCurrency: 'USD',
      label: 'Past Week',
    });

    expect(changeRowData).toEqual({
      percent: 33.33,
      deltaFiatFormatted: 'USD:30',
      rangeLabel: 'Past Week',
    });
    expect(
      areBalanceHistoryChartChangeRowDataEqual(changeRowData, {
        percent: 33.33,
        deltaFiatFormatted: 'USD:30',
        rangeLabel: 'Past Week',
      }),
    ).toBe(true);
    expect(
      getSelectedBalanceHistoryValue({
        point: selectedPoint,
        activeSeries,
        balanceOffset: 5,
      }),
    ).toBe(105);
    expect(
      getSelectedBalanceHistoryValue({
        point: selectedPoint,
        activeSeries: undefined,
        balanceOffset: 5,
      }),
    ).toBe(555);
  });
});
