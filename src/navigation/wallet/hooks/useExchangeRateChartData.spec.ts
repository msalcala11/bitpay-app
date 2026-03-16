jest.mock('../../../utils/helper-methods', () => ({
  calculatePercentageDifference: (current: number, previous: number) => {
    if (!Number.isFinite(current) || !Number.isFinite(previous) || !previous) {
      return 0;
    }

    return ((current - previous) / previous) * 100;
  },
}));

import {FIAT_RATE_SERIES_TARGET_POINTS} from '../../../store/rate/rate.models';
import {GRAPH_DRAWABLE_EPSILON} from '../../../utils/portfolio/chartGraph';
import {
  formatExchangeRateChartData,
  prepareExchangeRateChartPoints,
} from './useExchangeRateChartData';

const buildSeededSeries = ({seed}: {seed: number}) => {
  let state = seed >>> 0;
  const nextRandom = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };

  const length = 100 + Math.floor(nextRandom() * 150);
  let rate = 100;
  return Array.from({length}, (_, index) => {
    rate += (nextRandom() - 0.5) * 2;
    if (nextRandom() < 0.08) {
      rate += (nextRandom() - 0.5) * 20;
    }

    return {
      ts: index,
      rate: Number(rate.toFixed(3)),
    };
  });
};

describe('formatExchangeRateChartData', () => {
  it('keeps the rendered max value aligned with its rendered index after downsampling', () => {
    const points = buildSeededSeries({
      // This seed produces a raw high-water mark that LTTB omits.
      seed: 12,
    });

    const rawMax = Math.max(...points.map(point => point.rate));
    const displayData = formatExchangeRateChartData(points);

    expect(displayData.data).toHaveLength(FIAT_RATE_SERIES_TARGET_POINTS);
    expect(displayData.data.some(point => point.value === rawMax)).toBe(false);
    expect(displayData.renderedMaxPoint).toBeDefined();
    expect(displayData.renderedMaxPoint!.point.value).toBeLessThan(rawMax);
    expect(displayData.data[displayData.renderedMaxPoint!.index]).toBe(
      displayData.renderedMaxPoint!.point,
    );
    expect(displayData.data[displayData.renderedMaxPoint!.index].value).toBe(
      displayData.renderedMaxPoint!.point.value,
    );
  });

  it('keeps constant-rate input drawable after normalization', () => {
    const displayData = formatExchangeRateChartData([
      {ts: 100, rate: 7},
      {ts: 200, rate: 7},
      {ts: 300, rate: 7},
    ]);

    expect(displayData.data.map(point => point.value)).toEqual([
      7,
      7,
      7 + GRAPH_DRAWABLE_EPSILON,
    ]);
    expect(displayData.priceChange).toBe(0);
    expect(displayData.percentChange).toBe(0);
    expect(displayData.renderedMinPoint).toEqual({
      index: 0,
      point: displayData.data[0],
    });
    expect(displayData.renderedMaxPoint).toEqual({
      index: 2,
      point: displayData.data[2],
    });
  });
});

describe('prepareExchangeRateChartPoints', () => {
  it('does not treat a zero current fiat rate as missing', () => {
    const input = [
      {ts: 100, rate: 10},
      {ts: 200, rate: 12},
    ];

    const prepared = prepareExchangeRateChartPoints({
      selectedSeriesPoints: input,
      selectedTimeframe: '1D',
      seriesDataInterval: '1D',
      currentFiatRate: 0,
    });

    expect(prepared).toEqual([
      {ts: 100, rate: 10},
      {ts: 200, rate: 0},
    ]);
    expect(input[1].rate).toBe(12);
  });

  it('does not patch the last point for non-finite spot rates', () => {
    const input = [
      {ts: 100, rate: 10},
      {ts: 200, rate: 12},
    ];

    expect(
      prepareExchangeRateChartPoints({
        selectedSeriesPoints: input,
        selectedTimeframe: '1D',
        seriesDataInterval: '1D',
        currentFiatRate: Number.NaN,
      }),
    ).toBe(input);

    expect(
      prepareExchangeRateChartPoints({
        selectedSeriesPoints: input,
        selectedTimeframe: '1D',
        seriesDataInterval: '1D',
        currentFiatRate: Number.POSITIVE_INFINITY,
      }),
    ).toBe(input);
  });
});
