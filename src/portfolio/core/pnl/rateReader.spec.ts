import {createPreparedRateReader, readRateAt} from './rateReader';

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

  it('returns exact first and last render points', () => {
    expect(
      readRateAt({
        series,
        ts: 1000,
        policy: 'linearRender',
      }),
    ).toEqual({
      kind: 'rate',
      rate: 10,
      ts: 1000,
      source: 'exact',
    });

    expect(
      readRateAt({
        series,
        ts: 3000,
        policy: 'linearRender',
      }),
    ).toEqual({
      kind: 'rate',
      rate: 30,
      ts: 3000,
      source: 'exact',
    });
  });

  it('only allows exact timestamps for single-point linear render series', () => {
    const onePointSeries = {
      fetchedOn: 1,
      points: [{ts: 1000, rate: 10}],
    };

    expect(
      readRateAt({
        series: onePointSeries,
        ts: 1000,
        policy: 'linearRender',
      }),
    ).toEqual({
      kind: 'rate',
      rate: 10,
      ts: 1000,
      source: 'exact',
    });
    expect(
      readRateAt({
        series: onePointSeries,
        ts: 1001,
        policy: 'linearRender',
      }),
    ).toEqual({
      kind: 'missing',
      reason: 'outOfRange',
    });
  });

  it('treats non-positive rates as missing', () => {
    const invalidSeries = {
      fetchedOn: 1,
      points: [
        {ts: 1000, rate: 0},
        {ts: 2000, rate: 20},
      ],
    };

    expect(
      readRateAt({
        series: invalidSeries,
        ts: 1000,
        policy: 'linearRender',
      }),
    ).toEqual({
      kind: 'missing',
      reason: 'nonPositiveRate',
    });
    expect(
      readRateAt({
        series: invalidSeries,
        ts: 1500,
        policy: 'linearRender',
      }),
    ).toEqual({
      kind: 'missing',
      reason: 'nonPositiveRate',
    });
    expect(
      readRateAt({
        series: invalidSeries,
        ts: 1000,
        policy: 'nearestSnapshotIngest',
      }),
    ).toEqual({
      kind: 'missing',
      reason: 'nonPositiveRate',
    });
  });

  it('uses the first exact duplicate timestamp deterministically', () => {
    expect(
      readRateAt({
        series: {
          fetchedOn: 1,
          points: [
            {ts: 1000, rate: 10},
            {ts: 1000, rate: 11},
            {ts: 3000, rate: 30},
          ],
        },
        ts: 1000,
        policy: 'linearRender',
      }),
    ).toEqual({
      kind: 'rate',
      rate: 10,
      ts: 1000,
      source: 'exact',
    });
  });

  it('prepares and reuses normalized points for hot bridge/read loops', () => {
    const reader = createPreparedRateReader({
      series: {
        fetchedOn: 1,
        points: [
          {ts: 3000, rate: 30},
          {ts: 1000, rate: 10},
        ],
      },
      policy: 'linearRender',
    });

    expect(reader.hasPoints).toBe(true);
    expect(reader.read(2000)).toEqual({
      kind: 'rate',
      rate: 20,
      ts: 2000,
      source: 'interpolated',
    });
  });
});
