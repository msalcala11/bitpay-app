import {
  IN_WINDOW_BUY_FIXTURE,
  MID_SERIES_MUTATION_FIXTURE,
  NO_TRANSACTION_PARITY_FIXTURE,
  ORACLE_1D_WINDOW,
  ORACLE_TS,
} from '../__tests__/fixtures/productOracles';
import {
  buildCappedSampleGrid,
  buildWalletSeriesFromEvents,
} from './seriesFormula';
import {MAX_CHART_POINTS} from '../constants';

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
  windowStartTs: ORACLE_1D_WINDOW.windowStartTs,
  windowEndTs: ORACLE_1D_WINDOW.windowEndTs,
  windowAnchorTs: ORACLE_1D_WINDOW.windowEndTs,
  sampledFromStoredInterval: '1D' as const,
  finalPointSource: 'historicalRate' as const,
};

describe('portfolio v2 wallet series formula adapter', () => {
  it('builds a capped sample grid with endpoint preservation', () => {
    const grid = buildCappedSampleGrid({
      windowStartTs: ORACLE_1D_WINDOW.windowStartTs,
      windowEndTs: ORACLE_1D_WINDOW.windowEndTs,
      maxPoints: 5,
    });

    expect(grid).toHaveLength(MAX_CHART_POINTS);
    expect(grid[0]).toBe(ORACLE_1D_WINDOW.windowStartTs);
    expect(grid[grid.length - 1]).toBe(ORACLE_1D_WINDOW.windowEndTs);
  });

  it('emits exact 89 points even for short valid windows', () => {
    const grid = buildCappedSampleGrid({
      windowStartTs: 1,
      windowEndTs: 2,
      maxPoints: 5,
    });

    expect(grid).toHaveLength(MAX_CHART_POINTS);
    expect(grid[0]).toBe(1);
    expect(grid[grid.length - 1]).toBe(2);
    expect(
      buildCappedSampleGrid({
        windowStartTs: 1.1,
        windowEndTs: 1.2,
        maxPoints: 5,
      }),
    ).toHaveLength(MAX_CHART_POINTS);
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

    expect(series.points).toHaveLength(MAX_CHART_POINTS);
    expect(series.windowAnchorTs).toBe(ORACLE_1D_WINDOW.windowEndTs);
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

    expect(series.points).toHaveLength(MAX_CHART_POINTS);
    expect(series.points[0].ts).toBe(ORACLE_TS.start);
    expect(series.points[series.points.length - 1].ts).toBe(ORACLE_TS.end);
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

  it('scales atomic baselines and deltas before wallet-series fiat math', () => {
    const series = expectValidSeries(
      buildWalletSeriesFromEvents({
        ...BASE_FORMULA_ARGS,
        displayUnitDecimals: 18,
        baselineUnits: Number.MAX_SAFE_INTEGER,
        baselineUnitsAtomic: '2000000000000000000',
        balanceEvents: [
          {
            ts: ORACLE_TS.middle,
            unitsDelta: Number.MAX_SAFE_INTEGER,
            unitsDeltaAtomic: '1000000000000000000',
            order: 1,
          },
        ],
        ratePoints: IN_WINDOW_BUY_FIXTURE.ratePoints,
      }),
    );

    const last = series.points.at(-1);
    expect(last?.fiatBalance).toBe(390);
    expect(last?.pnlChange).toBe(80);
    expect(last?.pnlPercent).toBeCloseTo((80 / 310) * 100, 10);
  });

  it('rejects malformed and unsafe atomic series inputs without rounding', () => {
    expect(
      buildWalletSeriesFromEvents({
        ...BASE_FORMULA_ARGS,
        displayUnitDecimals: 18,
        baselineUnits: 0,
        baselineUnitsAtomic: 'not-atomic',
        ratePoints: IN_WINDOW_BUY_FIXTURE.ratePoints,
      }),
    ).toEqual({kind: 'invalidHistory', reason: 'invalidBaselineUnitsAtomic'});

    expect(
      buildWalletSeriesFromEvents({
        ...BASE_FORMULA_ARGS,
        displayUnitDecimals: 0,
        baselineUnits: 0,
        baselineUnitsAtomic: String(BigInt(Number.MAX_SAFE_INTEGER) + 1n),
        ratePoints: IN_WINDOW_BUY_FIXTURE.ratePoints,
      }),
    ).toEqual({kind: 'invalidHistory', reason: 'unsafeBaselineUnits'});

    expect(
      buildWalletSeriesFromEvents({
        ...BASE_FORMULA_ARGS,
        displayUnitDecimals: 0,
        baselineUnits: 1,
        balanceEvents: [
          {
            ts: ORACLE_TS.middle,
            unitsDelta: 0,
            unitsDeltaAtomic: 'nope',
            order: 1,
          },
        ],
        ratePoints: IN_WINDOW_BUY_FIXTURE.ratePoints,
      }),
    ).toEqual({kind: 'invalidHistory', reason: 'invalidBalanceEventAtomic'});
  });

  it('rejects unsafe numeric unit inputs as invalid history', () => {
    expect(
      buildWalletSeriesFromEvents({
        ...BASE_FORMULA_ARGS,
        baselineUnits: Number.MAX_SAFE_INTEGER + 1,
        ratePoints: IN_WINDOW_BUY_FIXTURE.ratePoints,
      }),
    ).toEqual({kind: 'invalidHistory', reason: 'unsafeBaselineUnits'});

    expect(
      buildWalletSeriesFromEvents({
        ...BASE_FORMULA_ARGS,
        baselineUnits: 1,
        balanceEvents: [
          {
            ts: ORACLE_TS.middle,
            unitsDelta: Number.MAX_SAFE_INTEGER + 1,
            order: 1,
          },
        ],
        ratePoints: IN_WINDOW_BUY_FIXTURE.ratePoints,
      }),
    ).toEqual({kind: 'invalidHistory', reason: 'unsafeBalanceEventUnits'});
  });

  it('rejects exact-window-start events because baselineUnits is already post-start state', () => {
    expect(
      buildWalletSeriesFromEvents({
        ...BASE_FORMULA_ARGS,
        baselineUnits: 1,
        balanceEvents: [{ts: ORACLE_TS.start, unitsDelta: 1, order: 1}],
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

  it('rejects non-integer or duplicate event ordering keys', () => {
    expect(
      buildWalletSeriesFromEvents({
        ...BASE_FORMULA_ARGS,
        baselineUnits: 0,
        balanceEvents: [{ts: ORACLE_TS.middle, unitsDelta: 1, order: 1.5}],
        ratePoints: IN_WINDOW_BUY_FIXTURE.ratePoints,
        maxPoints: 2,
      }),
    ).toEqual({kind: 'invalidHistory', reason: 'malformedBalanceEvent'});
    expect(
      buildWalletSeriesFromEvents({
        ...BASE_FORMULA_ARGS,
        baselineUnits: 0,
        balanceEvents: [{ts: ORACLE_TS.middle, unitsDelta: 1, order: -1}],
        ratePoints: IN_WINDOW_BUY_FIXTURE.ratePoints,
        maxPoints: 2,
      }),
    ).toEqual({kind: 'invalidHistory', reason: 'malformedBalanceEvent'});
    expect(
      buildWalletSeriesFromEvents({
        ...BASE_FORMULA_ARGS,
        baselineUnits: 0,
        balanceEvents: [
          {ts: ORACLE_TS.middle, unitsDelta: 1, order: 1},
          {ts: ORACLE_TS.middle, unitsDelta: -1, order: 1},
        ],
        ratePoints: IN_WINDOW_BUY_FIXTURE.ratePoints,
        maxPoints: 2,
      }),
    ).toEqual({kind: 'invalidHistory', reason: 'malformedBalanceEvent'});
  });

  it('scales basis on partial sells and resets basis after full disposal before rebuy', () => {
    const partialSell = expectValidSeries(
      buildWalletSeriesFromEvents({
        ...BASE_FORMULA_ARGS,
        baselineUnits: 10,
        balanceEvents: [{ts: ORACLE_TS.middle, unitsDelta: -4, order: 1}],
        ratePoints: IN_WINDOW_BUY_FIXTURE.ratePoints,
        maxPoints: 2,
      }),
    );
    const partialSellLast = partialSell.points[partialSell.points.length - 1];
    expect(partialSellLast.fiatBalance).toBe(780);
    expect(
      partialSellLast.fiatBalance - partialSellLast.remainingUnrealizedPnlFiat,
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
        baselineUnits: MID_SERIES_MUTATION_FIXTURE.baselineUnits,
        ratePoints: MID_SERIES_MUTATION_FIXTURE.ratePoints.base,
        maxPoints: 3,
      }),
    );
    const middleChanged = expectValidSeries(
      buildWalletSeriesFromEvents({
        ...BASE_FORMULA_ARGS,
        baselineUnits: MID_SERIES_MUTATION_FIXTURE.baselineUnits,
        ratePoints: MID_SERIES_MUTATION_FIXTURE.ratePoints.middleChanged,
        maxPoints: 3,
      }),
    );

    expect(middleChanged.points[0]).toEqual(base.points[0]);
    expect(middleChanged.points[middleChanged.points.length - 1]).toEqual(
      base.points[base.points.length - 1],
    );
    expect(middleChanged.fingerprint).not.toBe(base.fingerprint);
  });

  it('fingerprints window anchors even when emitted points are identical', () => {
    const first = expectValidSeries(
      buildWalletSeriesFromEvents({
        ...BASE_FORMULA_ARGS,
        baselineUnits: 1,
        ratePoints: NO_TRANSACTION_PARITY_FIXTURE.ratePoints,
      }),
    );
    const second = expectValidSeries(
      buildWalletSeriesFromEvents({
        ...BASE_FORMULA_ARGS,
        windowAnchorTs: ORACLE_1D_WINDOW.windowEndTs + 1,
        baselineUnits: 1,
        ratePoints: NO_TRANSACTION_PARITY_FIXTURE.ratePoints,
      }),
    );

    expect(second.points).toEqual(first.points);
    expect(second.fingerprint).not.toBe(first.fingerprint);
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
