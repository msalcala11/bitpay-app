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

const BASE_FORMULA_ARGS = {
  interval: '1D' as const,
  seriesIdentityKey: 'wallet:eth|asset:eth|quote:USD|snap:1|rate:1',
  windowStartTs: ORACLE_TS.start,
  windowEndTs: ORACLE_TS.end,
  sampledFromStoredInterval: '1D' as const,
  finalPointSource: 'historicalRate' as const,
};

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

  it('dedupes rounded sample timestamps while preserving endpoints', () => {
    expect(
      buildCappedSampleGrid({
        windowStartTs: 1,
        windowEndTs: 2,
        maxPoints: 5,
      }),
    ).toEqual([1, 2]);
    expect(
      buildCappedSampleGrid({
        windowStartTs: 1.1,
        windowEndTs: 1.2,
        maxPoints: 5,
      }),
    ).toEqual([]);
  });

  it('makes no-transaction pnl percent match the exchange-rate percent', () => {
    const series = expectValidSeries(
      buildWalletSeriesFromEvents({
        ...BASE_FORMULA_ARGS,
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
        ...BASE_FORMULA_ARGS,
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

  it('rejects exact-window-start events because baselineUnits is already post-start state', () => {
    expect(
      buildWalletSeriesFromEvents({
        ...BASE_FORMULA_ARGS,
        baselineUnits: 1,
        balanceEvents: [
          {ts: ORACLE_TS.start, unitsDelta: 1, order: 1},
        ],
        ratePoints: IN_WINDOW_BUY_FIXTURE.ratePoints,
        maxPoints: 2,
      }),
    ).toEqual({kind: 'invalidHistory', reason: 'malformedBalanceEvent'});
  });

  it('uses deterministic event order for same-timestamp buy/sell groups', () => {
    const buyFirst = expectValidSeries(
      buildWalletSeriesFromEvents({
        ...BASE_FORMULA_ARGS,
        baselineUnits: 0,
        balanceEvents: [
          {ts: ORACLE_TS.middle, unitsDelta: -1, order: 2},
          {ts: ORACLE_TS.middle, unitsDelta: 2, order: 1},
        ],
        ratePoints: IN_WINDOW_BUY_FIXTURE.ratePoints,
        maxPoints: 2,
      }),
    );

    expect(buyFirst.points[buyFirst.points.length - 1].fiatBalance).toBe(130);
    expect(
      buildWalletSeriesFromEvents({
        ...BASE_FORMULA_ARGS,
        baselineUnits: 0,
        balanceEvents: [
          {ts: ORACLE_TS.middle, unitsDelta: 2, order: 2},
          {ts: ORACLE_TS.middle, unitsDelta: -1, order: 1},
        ],
        ratePoints: IN_WINDOW_BUY_FIXTURE.ratePoints,
        maxPoints: 2,
      }),
    ).toEqual({kind: 'invalidHistory', reason: 'negativeUnits'});
  });

  it('scales basis on partial sells and resets basis after full disposal before rebuy', () => {
    const partialSell = expectValidSeries(
      buildWalletSeriesFromEvents({
        ...BASE_FORMULA_ARGS,
        baselineUnits: 10,
        balanceEvents: [
          {ts: ORACLE_TS.middle, unitsDelta: -4, order: 1},
        ],
        ratePoints: IN_WINDOW_BUY_FIXTURE.ratePoints,
        maxPoints: 2,
      }),
    );
    const partialSellLast = partialSell.points[partialSell.points.length - 1];
    expect(partialSellLast.fiatBalance).toBe(780);
    expect(
      partialSellLast.fiatBalance -
        partialSellLast.remainingUnrealizedPnlFiat,
    ).toBe(600);

    const fullDisposalThenRebuy = expectValidSeries(
      buildWalletSeriesFromEvents({
        ...BASE_FORMULA_ARGS,
        baselineUnits: 1,
        balanceEvents: [
          {ts: ORACLE_TS.middle, unitsDelta: -1, order: 1},
          {ts: ORACLE_TS.middle, unitsDelta: 2, order: 2},
        ],
        ratePoints: IN_WINDOW_BUY_FIXTURE.ratePoints,
        maxPoints: 2,
      }),
    );
    const rebuyLast =
      fullDisposalThenRebuy.points[fullDisposalThenRebuy.points.length - 1];
    expect(rebuyLast.fiatBalance).toBe(260);
    expect(rebuyLast.fiatBalance - rebuyLast.remainingUnrealizedPnlFiat).toBe(
      220,
    );
  });

  it('quarantines impossible negative running balances instead of clamping', () => {
    expect(
      buildWalletSeriesFromEvents({
        ...BASE_FORMULA_ARGS,
        baselineUnits: 1,
        balanceEvents: [{ts: ORACLE_TS.middle, unitsDelta: -2, order: 1}],
        ratePoints: IN_WINDOW_BUY_FIXTURE.ratePoints,
        maxPoints: 2,
      }),
    ).toEqual({kind: 'invalidHistory', reason: 'negativeUnits'});
  });

  it('returns missingRate instead of publishing partial output when a required rate is absent', () => {
    expect(
      buildWalletSeriesFromEvents({
        ...BASE_FORMULA_ARGS,
        baselineUnits: 1,
        balanceEvents: [{ts: ORACLE_TS.middle, unitsDelta: 1, order: 1}],
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
        ...BASE_FORMULA_ARGS,
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
        ...BASE_FORMULA_ARGS,
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

  it('fingerprints input identity even when emitted points are identical', () => {
    const first = expectValidSeries(
      buildWalletSeriesFromEvents({
        ...BASE_FORMULA_ARGS,
        seriesIdentityKey: 'wallet:a|asset:eth|quote:USD|snap:1|rate:1',
        baselineUnits: 1,
        ratePoints: NO_TRANSACTION_PARITY_FIXTURE.ratePoints,
        maxPoints: 2,
      }),
    );
    const second = expectValidSeries(
      buildWalletSeriesFromEvents({
        ...BASE_FORMULA_ARGS,
        seriesIdentityKey: 'wallet:b|asset:eth|quote:USD|snap:1|rate:1',
        baselineUnits: 1,
        ratePoints: NO_TRANSACTION_PARITY_FIXTURE.ratePoints,
        maxPoints: 2,
      }),
    );

    expect(second.points).toEqual(first.points);
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it('rejects runtime-cast invalid interval metadata', () => {
    expect(
      buildWalletSeriesFromEvents({
        ...BASE_FORMULA_ARGS,
        interval: 'BAD' as any,
        baselineUnits: 1,
        ratePoints: NO_TRANSACTION_PARITY_FIXTURE.ratePoints,
        maxPoints: 2,
      }),
    ).toEqual({kind: 'invalidHistory', reason: 'invalidInterval'});
    expect(
      buildWalletSeriesFromEvents({
        ...BASE_FORMULA_ARGS,
        sampledFromStoredInterval: '3M' as any,
        baselineUnits: 1,
        ratePoints: NO_TRANSACTION_PARITY_FIXTURE.ratePoints,
        maxPoints: 2,
      }),
    ).toEqual({kind: 'invalidHistory', reason: 'invalidStoredInterval'});
    expect(
      buildWalletSeriesFromEvents({
        ...BASE_FORMULA_ARGS,
        finalPointSource: 'BAD' as any,
        baselineUnits: 1,
        ratePoints: NO_TRANSACTION_PARITY_FIXTURE.ratePoints,
        maxPoints: 2,
      }),
    ).toEqual({kind: 'invalidHistory', reason: 'invalidFinalPointSource'});
  });
});
