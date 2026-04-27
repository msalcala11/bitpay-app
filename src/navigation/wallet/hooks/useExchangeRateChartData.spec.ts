import {
  formatExchangeRateChartData,
  getDisplayedExchangeRateRangeMs,
  prepareExchangeRateChartPoints,
} from './useExchangeRateChartData';
import {
  buildIntervalWindow,
  ONE_DAY_MS,
  ONE_HOUR_MS,
} from '../../../portfolio/v2/__tests__/fixtures/intervalWindows';

describe('prepareExchangeRateChartPoints', () => {
  it('uses the explicit nowMs when clipping an ALL-series window for display', () => {
    const intervalWindow = buildIntervalWindow();
    const dateNowSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValue(intervalWindow.endTs + ONE_DAY_MS * 7);

    try {
      const result = prepareExchangeRateChartPoints({
        selectedSeriesPoints: [
          {ts: intervalWindow.startTs - 1, rate: 99},
          {ts: intervalWindow.startTs, rate: 100},
          {ts: intervalWindow.endTs, rate: 101},
        ],
        selectedTimeframe: '1D',
        seriesDataInterval: 'ALL',
        currentFiatRate: 101,
        nowMs: intervalWindow.endTs,
      });

      expect(result).toEqual([
        {ts: intervalWindow.startTs, rate: 100},
        {ts: intervalWindow.endTs, rate: 101},
      ]);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it('appends a live terminal point at nowMs when the live point is newer than history', () => {
    const intervalWindow = buildIntervalWindow();
    const historicalEndMs = intervalWindow.endTs - ONE_HOUR_MS;

    const result = prepareExchangeRateChartPoints({
      selectedSeriesPoints: [
        {ts: intervalWindow.startTs, rate: 100},
        {ts: historicalEndMs, rate: 101},
      ],
      selectedTimeframe: '1D',
      seriesDataInterval: '1D',
      currentFiatRate: 102,
      nowMs: intervalWindow.endTs,
    });

    expect(result).toEqual([
      {ts: intervalWindow.startTs, rate: 100},
      {ts: historicalEndMs, rate: 101},
      {ts: intervalWindow.endTs, rate: 102},
    ]);
  });

  it('appends a live terminal point even when the live rate matches the last historical rate', () => {
    const intervalWindow = buildIntervalWindow();
    const historicalEndMs = intervalWindow.endTs - ONE_HOUR_MS;

    const result = prepareExchangeRateChartPoints({
      selectedSeriesPoints: [
        {ts: intervalWindow.startTs, rate: 100},
        {ts: historicalEndMs, rate: 101},
      ],
      selectedTimeframe: '1D',
      seriesDataInterval: '1D',
      currentFiatRate: 101,
      nowMs: intervalWindow.endTs,
    });

    expect(result).toEqual([
      {ts: intervalWindow.startTs, rate: 100},
      {ts: historicalEndMs, rate: 101},
      {ts: intervalWindow.endTs, rate: 101},
    ]);
  });

  it('replaces the last point rate when the live terminal timestamp matches the historical terminal timestamp', () => {
    const intervalWindow = buildIntervalWindow();

    const result = prepareExchangeRateChartPoints({
      selectedSeriesPoints: [
        {ts: intervalWindow.startTs, rate: 100},
        {ts: intervalWindow.endTs, rate: 101},
      ],
      selectedTimeframe: '1D',
      seriesDataInterval: '1D',
      currentFiatRate: 102,
      nowMs: intervalWindow.endTs,
    });

    expect(result).toEqual([
      {ts: intervalWindow.startTs, rate: 100},
      {ts: intervalWindow.endTs, rate: 102},
    ]);
  });

  it('computes displayed range metadata from the prepared points including an appended live terminal point', () => {
    const intervalWindow = buildIntervalWindow();
    const historicalEndMs = intervalWindow.endTs - ONE_HOUR_MS;

    const prepared = prepareExchangeRateChartPoints({
      selectedSeriesPoints: [
        {ts: intervalWindow.startTs, rate: 100},
        {ts: historicalEndMs, rate: 101},
      ],
      selectedTimeframe: '1D',
      seriesDataInterval: '1D',
      currentFiatRate: 102,
      nowMs: intervalWindow.endTs,
    });

    expect(getDisplayedExchangeRateRangeMs(prepared)).toBe(
      intervalWindow.durationMs,
    );
  });
});

describe('formatExchangeRateChartData', () => {
  it('returns the raw percent change without rounding in the math layer', () => {
    const result = formatExchangeRateChartData([
      {ts: 1, rate: 100},
      {ts: 2, rate: 110.123456},
    ]);

    expect(result.percentChange).toBeCloseTo(10.123456, 6);
  });
});
