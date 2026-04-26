import {
  IN_WINDOW_BUY_FIXTURE,
  NO_TRANSACTION_PARITY_FIXTURE,
  ORACLE_TS,
} from '../__tests__/fixtures/productOracles';
import {
  buildCappedSampleGrid,
  buildWalletSeriesFromEvents,
} from './seriesFormula';

function expectValidSeries(
  result: ReturnType<typeof buildWalletSeriesFromEvents>,
) {
  if (result.kind !== 'valid') {
    throw new Error(`Expected valid series, received ${result.reason}`);
  }

  return result.series;
}

describe('portfolio v2 wallet series formula adapter', () => {
  it('builds a capped sample grid with endpoint preservation', () => {
    const grid = buildCappedSampleGrid({
      windowStartTs: ORACLE_TS.start,
      windowEndTs: ORACLE_TS.end,
      maxPoints: 5,
    });

    expect(grid).toHaveLength(5);
    expect(grid[0]).toBe(ORACLE_TS.start);
    expect(grid[grid.length - 1]).toBe(ORACLE_TS.end);
  });

  it('makes no-transaction pnl percent match the exchange-rate percent', () => {
    const series = expectValidSeries(
      buildWalletSeriesFromEvents({
        interval: '1D',
        windowStartTs: ORACLE_TS.start,
        windowEndTs: ORACLE_TS.end,
        sampledFromStoredInterval: '1D',
        finalPointSource: 'historicalRate',
        baselineUnits: NO_TRANSACTION_PARITY_FIXTURE.baselineUnits,
        ratePoints: NO_TRANSACTION_PARITY_FIXTURE.ratePoints,
        maxPoints: 2,
      }),
    );

    const first = series.points[0];
    const last = series.points[series.points.length - 1];

    expect(first.fiatBalance).toBe(
      NO_TRANSACTION_PARITY_FIXTURE.expected.fiatStart,
    );
    expect(last.fiatBalance).toBe(
      NO_TRANSACTION_PARITY_FIXTURE.expected.fiatEnd,
    );
    expect(last.pnlChange).toBe(
      NO_TRANSACTION_PARITY_FIXTURE.expected.pnlChange,
    );
    expect(last.pnlPercent).toBe(
      NO_TRANSACTION_PARITY_FIXTURE.expected.pnlPercent,
    );
    expect(last.pnlPercent).toBe(
      NO_TRANSACTION_PARITY_FIXTURE.expected.ratePercent,
    );
  });

  it('consumes in-window balance changes even when they are not emitted sample points', () => {
    const series = expectValidSeries(
      buildWalletSeriesFromEvents({
        interval: '1D',
        windowStartTs: ORACLE_TS.start,
        windowEndTs: ORACLE_TS.end,
        sampledFromStoredInterval: '1D',
        finalPointSource: 'historicalRate',
        baselineUnits: IN_WINDOW_BUY_FIXTURE.baselineUnits,
        balanceEvents: IN_WINDOW_BUY_FIXTURE.balanceEvents,
        ratePoints: IN_WINDOW_BUY_FIXTURE.ratePoints,
        maxPoints: 2,
      }),
    );

    expect(series.points.map(point => point.ts)).toEqual([
      ORACLE_TS.start,
      ORACLE_TS.end,
    ]);
    const last = series.points[series.points.length - 1];
    expect(last.fiatBalance).toBe(IN_WINDOW_BUY_FIXTURE.expected.fiatEnd);
    expect(last.fiatBalance - last.remainingUnrealizedPnlFiat).toBe(
      IN_WINDOW_BUY_FIXTURE.expected.finalRemainingCostBasisFiat,
    );
    expect(last.remainingUnrealizedPnlFiat).toBe(
      IN_WINDOW_BUY_FIXTURE.expected.pnlChange,
    );
    expect(last.pnlChange).toBe(IN_WINDOW_BUY_FIXTURE.expected.pnlChange);
    expect(last.pnlPercent).toBeCloseTo(
      IN_WINDOW_BUY_FIXTURE.expected.pnlPercent,
      10,
    );
  });

  it('quarantines impossible negative running balances instead of clamping', () => {
    expect(
      buildWalletSeriesFromEvents({
        interval: '1D',
        windowStartTs: ORACLE_TS.start,
        windowEndTs: ORACLE_TS.end,
        sampledFromStoredInterval: '1D',
        finalPointSource: 'historicalRate',
        baselineUnits: 1,
        balanceEvents: [{ts: ORACLE_TS.middle, unitsDelta: -2}],
        ratePoints: IN_WINDOW_BUY_FIXTURE.ratePoints,
        maxPoints: 2,
      }),
    ).toEqual({kind: 'invalidHistory', reason: 'negativeUnits'});
  });

  it('returns missingRate instead of publishing partial output when a required rate is absent', () => {
    expect(
      buildWalletSeriesFromEvents({
        interval: '1D',
        windowStartTs: ORACLE_TS.start,
        windowEndTs: ORACLE_TS.end,
        sampledFromStoredInterval: '1D',
        finalPointSource: 'historicalRate',
        baselineUnits: 1,
        balanceEvents: [{ts: ORACLE_TS.middle, unitsDelta: 1}],
        ratePoints: [
          {ts: ORACLE_TS.start, rate: 100},
          {ts: ORACLE_TS.middle - 1, rate: 110},
        ],
        maxPoints: 2,
      }),
    ).toEqual({kind: 'missingRate', reason: 'missingHistoricalRate'});
  });

  it('fingerprints full point arrays, not only endpoints', () => {
    const base = expectValidSeries(
      buildWalletSeriesFromEvents({
        interval: '1D',
        windowStartTs: ORACLE_TS.start,
        windowEndTs: ORACLE_TS.end,
        sampledFromStoredInterval: '1D',
        finalPointSource: 'historicalRate',
        baselineUnits: 1,
        ratePoints: [
          {ts: ORACLE_TS.start, rate: 100},
          {ts: ORACLE_TS.middle, rate: 110},
          {ts: ORACLE_TS.end, rate: 120},
        ],
        maxPoints: 3,
      }),
    );
    const middleChanged = expectValidSeries(
      buildWalletSeriesFromEvents({
        interval: '1D',
        windowStartTs: ORACLE_TS.start,
        windowEndTs: ORACLE_TS.end,
        sampledFromStoredInterval: '1D',
        finalPointSource: 'historicalRate',
        baselineUnits: 1,
        ratePoints: [
          {ts: ORACLE_TS.start, rate: 100},
          {ts: ORACLE_TS.middle, rate: 115},
          {ts: ORACLE_TS.end, rate: 120},
        ],
        maxPoints: 3,
      }),
    );

    expect(middleChanged.points[0]).toEqual(base.points[0]);
    expect(middleChanged.points[2]).toEqual(base.points[2]);
    expect(middleChanged.fingerprint).not.toBe(base.fingerprint);
  });
});
