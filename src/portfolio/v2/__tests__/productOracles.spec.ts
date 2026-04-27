import {
  CHECKPOINT_VALIDITY_FIXTURE,
  ORACLE_1D_WINDOW,
  ORACLE_TS,
  TRANSFER_NON_NETTING_FIXTURES,
  WEIGHTED_GROUP_FIXTURE,
} from './fixtures/productOracles';
import {buildWalletSeriesFromEvents} from '../compute/seriesFormula';
import {buildWeightedGroupRateSeries} from '../compute/weightedGroupRates';
import type {Point, Series} from '../model';

const TRANSFER_FORMULA_ARGS = {
  interval: '1D' as const,
  windowStartTs: ORACLE_1D_WINDOW.windowStartTs,
  windowEndTs: ORACLE_1D_WINDOW.windowEndTs,
  windowAnchorTs: ORACLE_1D_WINDOW.windowEndTs,
  sampledFromStoredInterval: '1D' as const,
  finalPointSource: 'historicalRate' as const,
  maxPoints: 2,
};

function expectValidSeries(
  result: ReturnType<typeof buildWalletSeriesFromEvents>,
): Series {
  if (result.kind !== 'valid') {
    throw new Error(
      `Expected valid transfer oracle series, got ${result.reason}`,
    );
  }

  return result.series;
}

function lastPoint(series: Series): Point {
  return series.points[series.points.length - 1];
}

function remainingBasis(point: Point): number {
  return point.fiatBalance - point.remainingUnrealizedPnlFiat;
}

function transferWalletBasis(args: {
  seriesIdentityKey: string;
  baselineUnits: number;
  unitsDelta: number;
  baselineRate: number;
  eventRate: number;
  endRate?: number;
}): number {
  const series = expectValidSeries(
    buildWalletSeriesFromEvents({
      ...TRANSFER_FORMULA_ARGS,
      seriesIdentityKey: args.seriesIdentityKey,
      baselineUnits: args.baselineUnits,
      balanceEvents: [
        {
          ts: ORACLE_TS.middle,
          unitsDelta: args.unitsDelta,
          order: 1,
        },
      ],
      ratePoints: [
        {ts: ORACLE_TS.start, rate: args.baselineRate},
        {ts: ORACLE_TS.middle, rate: args.eventRate},
        {ts: ORACLE_TS.end, rate: args.endRate ?? args.eventRate},
      ],
    }),
  );

  return remainingBasis(lastPoint(series));
}

describe('portfolio v2 shared product oracle fixtures', () => {
  it('pins same-chain transfer non-netting at $100.20 aggregate basis', () => {
    const fixture = TRANSFER_NON_NETTING_FIXTURES.sameChainUsdc;
    const sourceBasis = transferWalletBasis({
      seriesIdentityKey: 'oracle:transfer:same-chain:source',
      baselineUnits: fixture.baselineUnits.source,
      unitsDelta: -fixture.sourceTransferUnits,
      baselineRate: fixture.baselineRate,
      eventRate: fixture.baselineRate,
      endRate: fixture.baselineRate,
    });
    const destinationBasis = transferWalletBasis({
      seriesIdentityKey: 'oracle:transfer:same-chain:destination',
      baselineUnits: fixture.baselineUnits.destination,
      unitsDelta: fixture.sourceTransferUnits,
      baselineRate: fixture.baselineRate,
      eventRate: fixture.destinationSpotRate,
      endRate: fixture.destinationSpotRate,
    });
    const aggregateBasis = sourceBasis + destinationBasis;

    expect(sourceBasis).toBeCloseTo(
      fixture.expected.sourceRemainingCostBasisFiatEnd,
      10,
    );
    expect(destinationBasis).toBeCloseTo(
      fixture.expected.destinationRemainingCostBasisFiatEnd,
      10,
    );
    expect(aggregateBasis).toBeCloseTo(
      fixture.expected.aggregateRemainingCostBasisFiatEnd,
      10,
    );
    expect(aggregateBasis).not.toBeCloseTo(100, 10);
  });

  it('pins cross-chain transfer non-netting at $100.192 aggregate basis', () => {
    const fixture = TRANSFER_NON_NETTING_FIXTURES.crossChainUsdc;
    const sourceBasis = transferWalletBasis({
      seriesIdentityKey: 'oracle:transfer:cross-chain:source',
      baselineUnits: fixture.baselineUnits.source,
      unitsDelta: -fixture.sourceTransferUnits,
      baselineRate: fixture.sourceBaselineRate,
      eventRate: fixture.sourceBaselineRate,
      endRate: fixture.sourceBaselineRate,
    });
    const destinationBasis = transferWalletBasis({
      seriesIdentityKey: 'oracle:transfer:cross-chain:destination',
      baselineUnits: fixture.baselineUnits.destination,
      unitsDelta: fixture.sourceTransferUnits,
      baselineRate: fixture.sourceBaselineRate,
      eventRate: fixture.destinationSpotRate,
      endRate: fixture.destinationSpotRate,
    });
    const aggregateBasis = sourceBasis + destinationBasis;

    expect(sourceBasis).toBeCloseTo(
      fixture.expected.sourceRemainingCostBasisFiatEnd,
      10,
    );
    expect(destinationBasis).toBeCloseTo(
      fixture.expected.destinationRemainingCostBasisFiatEnd,
      10,
    );
    expect(aggregateBasis).toBeCloseTo(
      fixture.expected.aggregateRemainingCostBasisFiatEnd,
      10,
    );
    expect(aggregateBasis).not.toBeCloseTo(100, 10);
  });

  it('keeps the weighted-group fixture executable from the shared oracle library', () => {
    const series = buildWeightedGroupRateSeries({
      quoteCurrency: WEIGHTED_GROUP_FIXTURE.quoteCurrency,
      assetGroupId: WEIGHTED_GROUP_FIXTURE.assetGroupId,
      walletIdsKey: WEIGHTED_GROUP_FIXTURE.walletIdsKey,
      interval: WEIGHTED_GROUP_FIXTURE.interval,
      windowStartTs: WEIGHTED_GROUP_FIXTURE.windowStartTs,
      windowEndTs: WEIGHTED_GROUP_FIXTURE.windowEndTs,
      windowAnchorTs: WEIGHTED_GROUP_FIXTURE.windowAnchorTs,
      sampledFromStoredInterval:
        WEIGHTED_GROUP_FIXTURE.sampledFromStoredInterval,
      constituents: WEIGHTED_GROUP_FIXTURE.constituents,
    });

    expect(series.availability).toBe('valid');
    if (series.availability !== 'valid') {
      throw new Error(series.unavailableReason);
    }
    expect(series.points[0].weightedRate).toBeCloseTo(
      WEIGHTED_GROUP_FIXTURE.expected.weightedRateStart,
      12,
    );
    expect(series.points[series.points.length - 1].weightedRate).toBeCloseTo(
      WEIGHTED_GROUP_FIXTURE.expected.weightedRateEnd,
      12,
    );
    expect(series.points[series.points.length - 1].weightedPercent).toBeCloseTo(
      WEIGHTED_GROUP_FIXTURE.expected.weightedPercentEnd,
      10,
    );
  });

  it('keeps the checkpoint oracle JSON-serializable for the Phase 5 validator', () => {
    expect(
      JSON.parse(JSON.stringify(CHECKPOINT_VALIDITY_FIXTURE.valid)),
    ).toEqual(CHECKPOINT_VALIDITY_FIXTURE.valid);
    expect(new Set(CHECKPOINT_VALIDITY_FIXTURE.invalidityReasons).size).toBe(
      CHECKPOINT_VALIDITY_FIXTURE.invalidityReasons.length,
    );
  });
});
