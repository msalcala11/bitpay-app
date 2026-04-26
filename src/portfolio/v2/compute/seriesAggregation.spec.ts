import type {Interval, Series} from '../model';
import {aggregateAlignedSeries} from './seriesAggregation';

function makeSeries(interval: Interval = '1D'): Series {
  return {
    fingerprint: `series:${interval}`,
    interval,
    windowStartTs: 1,
    windowEndTs: 2,
    sampledFromStoredInterval: interval === 'ALL' ? 'ALL' : '1D',
    finalPointSource: 'historicalRate',
    points: [
      {
        ts: 1,
        fiatBalance: 100,
        remainingUnrealizedPnlFiat: 0,
        pnlChange: 0,
        pnlPercent: 0,
      },
      {
        ts: 2,
        fiatBalance: 125,
        remainingUnrealizedPnlFiat: 25,
        pnlChange: 25,
        pnlPercent: 25,
      },
    ],
  };
}

describe('aggregateAlignedSeries', () => {
  it('rejects member series whose interval does not match the requested interval', () => {
    expect(
      aggregateAlignedSeries({
        identityKey: 'asset-group:btc',
        interval: 'ALL',
        memberSeries: [makeSeries('1D')],
      }),
    ).toBeNull();
  });

  it('publishes the requested interval after validating aligned members', () => {
    const aggregated = aggregateAlignedSeries({
      identityKey: 'asset-group:btc',
      interval: '1D',
      memberSeries: [makeSeries('1D'), makeSeries('1D')],
    });

    expect(aggregated?.interval).toBe('1D');
    expect(aggregated?.points[1]).toMatchObject({
      fiatBalance: 250,
      remainingUnrealizedPnlFiat: 50,
      pnlChange: 50,
    });
  });
});
