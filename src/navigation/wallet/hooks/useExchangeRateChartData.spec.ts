jest.mock('../../../utils/helper-methods', () => ({
  calculatePercentageDifference: jest.fn(() => 0),
}));

import {prepareExchangeRateChartPoints} from './useExchangeRateChartData';

describe('prepareExchangeRateChartPoints', () => {
  it('uses the explicit nowMs when clipping an ALL-series window for display', () => {
    const nowMs = Date.UTC(2026, 3, 20, 15, 0, 0);
    const dayMs = 24 * 60 * 60 * 1000;
    const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(nowMs + dayMs * 7);

    try {
      const result = prepareExchangeRateChartPoints({
        selectedSeriesPoints: [
          {ts: nowMs - dayMs - 1, rate: 99},
          {ts: nowMs - dayMs, rate: 100},
          {ts: nowMs, rate: 101},
        ],
        selectedTimeframe: '1D',
        seriesDataInterval: 'ALL',
        currentFiatRate: 101,
        nowMs,
      });

      expect(result).toEqual([
        {ts: nowMs - dayMs, rate: 100},
        {ts: nowMs, rate: 101},
      ]);
    } finally {
      dateNowSpy.mockRestore();
    }
  });
});
