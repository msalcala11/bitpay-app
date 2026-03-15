import {
  FIAT_TIMEFRAME_METADATA,
  FIAT_TIMEFRAME_VALUES,
  getFiatTimeframeSeriesInterval,
  getFiatTimeframeWindowMs,
} from './fiatTimeframes';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('fiatTimeframes', () => {
  it('preserves the shared timeframe order and user-visible labels', () => {
    expect(FIAT_TIMEFRAME_VALUES).toEqual([
      'ALL',
      '1D',
      '1W',
      '1M',
      '3M',
      '1Y',
      '5Y',
    ]);

    expect(
      FIAT_TIMEFRAME_VALUES.map(timeframe => ({
        timeframe,
        displayLabel: FIAT_TIMEFRAME_METADATA[timeframe].displayLabel,
        rangeLabel: FIAT_TIMEFRAME_METADATA[timeframe].rangeLabel,
      })),
    ).toEqual([
      {
        timeframe: 'ALL',
        displayLabel: 'All',
        rangeLabel: 'All-time',
      },
      {
        timeframe: '1D',
        displayLabel: '1D',
        rangeLabel: 'Last Day',
      },
      {
        timeframe: '1W',
        displayLabel: '1W',
        rangeLabel: 'Past Week',
      },
      {
        timeframe: '1M',
        displayLabel: '1M',
        rangeLabel: 'Past Month',
      },
      {
        timeframe: '3M',
        displayLabel: '3M',
        rangeLabel: 'Past 3 Months',
      },
      {
        timeframe: '1Y',
        displayLabel: '1Y',
        rangeLabel: 'Past Year',
      },
      {
        timeframe: '5Y',
        displayLabel: '5Y',
        rangeLabel: 'Past 5 Years',
      },
    ]);
  });

  it('maps timeframes to windows and backing series intervals from one place', () => {
    expect(
      FIAT_TIMEFRAME_VALUES.map(timeframe => ({
        timeframe,
        windowMs: getFiatTimeframeWindowMs(timeframe),
        seriesInterval: getFiatTimeframeSeriesInterval(timeframe),
      })),
    ).toEqual([
      {
        timeframe: 'ALL',
        windowMs: undefined,
        seriesInterval: 'ALL',
      },
      {
        timeframe: '1D',
        windowMs: 1 * DAY_MS,
        seriesInterval: '1D',
      },
      {
        timeframe: '1W',
        windowMs: 7 * DAY_MS,
        seriesInterval: '1W',
      },
      {
        timeframe: '1M',
        windowMs: 30 * DAY_MS,
        seriesInterval: '1M',
      },
      {
        timeframe: '3M',
        windowMs: 90 * DAY_MS,
        seriesInterval: 'ALL',
      },
      {
        timeframe: '1Y',
        windowMs: 365 * DAY_MS,
        seriesInterval: 'ALL',
      },
      {
        timeframe: '5Y',
        windowMs: 1825 * DAY_MS,
        seriesInterval: 'ALL',
      },
    ]);
  });
});
