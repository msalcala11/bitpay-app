jest.mock('../../../utils/helper-methods', () => ({
  calculatePercentageDifference: (current: number, previous: number) => {
    if (!Number.isFinite(current) || !Number.isFinite(previous) || !previous) {
      return 0;
    }

    return ((current - previous) / previous) * 100;
  },
}));

import {FIAT_RATE_SERIES_TARGET_POINTS} from '../../../store/rate/rate.models';
import {formatExchangeRateChartData} from './useExchangeRateChartData';

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
});
