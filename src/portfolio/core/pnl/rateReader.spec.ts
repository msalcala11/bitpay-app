import {readRateAt} from './rateReader';

describe('rateReader', () => {
  const series = {
    fetchedOn: 1,
    points: [
      {ts: 1000, rate: 10},
      {ts: 3000, rate: 30},
    ],
  };

  it('linearly interpolates render and quote-bridge rates', () => {
    expect(
      readRateAt({
        series,
        ts: 2000,
        policy: 'linearRender',
      }),
    ).toEqual({
      kind: 'rate',
      rate: 20,
      ts: 2000,
      source: 'interpolated',
    });
  });

  it('does not nearest-sample render rates outside the known series window', () => {
    expect(
      readRateAt({
        series,
        ts: 500,
        policy: 'linearRender',
      }),
    ).toEqual({
      kind: 'missing',
      reason: 'outOfRange',
    });
  });

  it('keeps nearest sampling explicit for snapshot ingest only', () => {
    expect(
      readRateAt({
        series,
        ts: 500,
        policy: 'nearestSnapshotIngest',
      }),
    ).toEqual({
      kind: 'rate',
      rate: 10,
      ts: 500,
      source: 'nearest',
    });
  });
});
