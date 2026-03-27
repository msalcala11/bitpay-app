import {FIAT_RATE_SERIES_TARGET_POINTS} from '../../../store/rate/rate.models';
import {downsampleSeries} from '../../../utils/portfolio/rate';
import {
  downsampleExchangeRateSeriesPreservingExtrema,
  formatExchangeRateChartData,
} from './useExchangeRateChartData';

const DAY_MS = 24 * 60 * 60 * 1000;

const createDeterministicSeries = (seed: number, length = 365) => {
  let state = seed >>> 0;
  const nextRandom = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };

  const points: Array<{ts: number; rate: number}> = [];

  for (let index = 0; index < length; index++) {
    const wave =
      Math.sin((index + seed) / 11) * 900 +
      Math.cos((index + seed * 3) / 17) * 650;
    const noise = (nextRandom() - 0.5) * 90;
    const positiveSpike =
      index % 23 === seed % 23 ? 2600 + nextRandom() * 400 : 0;
    const negativeSpike =
      index % 29 === (seed * 7) % 29 ? 2200 + nextRandom() * 350 : 0;

    points.push({
      ts: index * DAY_MS,
      rate:
        Math.round(
          (50000 + wave + noise + positiveSpike - negativeSpike) * 100,
        ) / 100,
    });
  }

  return points;
};

const getSeriesExtrema = (points: Array<{ts: number; rate: number}>) => {
  return points.reduce(
    (acc, point) => ({
      max: Math.max(acc.max, point.rate),
      min: Math.min(acc.min, point.rate),
    }),
    {
      max: Number.NEGATIVE_INFINITY,
      min: Number.POSITIVE_INFINITY,
    },
  );
};

const findSeriesWherePlainDownsamplingDropsExtrema = () => {
  for (let seed = 1; seed <= 2000; seed++) {
    const series = createDeterministicSeries(seed);
    const sampled = downsampleSeries(series, FIAT_RATE_SERIES_TARGET_POINTS, {
      strategy: 'lttb',
      mode: 'per_coin',
    });
    const rawExtrema = getSeriesExtrema(series);
    const sampledExtrema = getSeriesExtrema(sampled);

    if (
      sampledExtrema.max !== rawExtrema.max ||
      sampledExtrema.min !== rawExtrema.min
    ) {
      return {
        rawExtrema,
        series,
      };
    }
  }

  throw new Error('Expected to find a deterministic extrema-loss fixture');
};

describe('downsampleExchangeRateSeriesPreservingExtrema', () => {
  it('keeps the true max and min points in the rendered sample', () => {
    const {series, rawExtrema} = findSeriesWherePlainDownsamplingDropsExtrema();

    const sampled = downsampleExchangeRateSeriesPreservingExtrema(
      series,
      FIAT_RATE_SERIES_TARGET_POINTS,
    );

    expect(sampled).toHaveLength(FIAT_RATE_SERIES_TARGET_POINTS);
    expect(sampled.some(point => point.rate === rawExtrema.max)).toBe(true);
    expect(sampled.some(point => point.rate === rawExtrema.min)).toBe(true);
  });
});

describe('formatExchangeRateChartData', () => {
  it('uses the raw timeframe extrema for rendered axis labels', () => {
    const {series, rawExtrema} = findSeriesWherePlainDownsamplingDropsExtrema();

    const result = formatExchangeRateChartData(series, {
      assumeSortedByTsAsc: true,
    });

    expect(result.renderedMaxPoint?.point.value).toBe(rawExtrema.max);
    expect(result.renderedMinPoint?.point.value).toBe(rawExtrema.min);
  });
});
