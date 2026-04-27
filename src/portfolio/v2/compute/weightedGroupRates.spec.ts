import {
  buildWeightedGroupRateSeries,
  type WeightedGroupRateConstituentInput,
} from './weightedGroupRates';
import {MAX_CHART_POINTS} from '../constants';
import {
  WEIGHTED_GROUP_FIXTURE,
  WEIGHTED_MISSING_CONSTITUENT_FIXTURE,
  WEIGHTED_ZERO_BASELINE_FIXTURE,
} from '../__tests__/fixtures/productOracles';

function constituent(
  rateSourceKey: string,
  baselineUnits: number,
  rates: readonly number[],
  timestamps: readonly number[] = Array.from(
    {length: MAX_CHART_POINTS},
    (_, index) => 1 + index,
  ),
): WeightedGroupRateConstituentInput {
  const expandedRates =
    rates.length === timestamps.length
      ? rates
      : timestamps.map((_, index) => {
          const start = rates[0] ?? 0;
          const end = rates[rates.length - 1] ?? start;
          return start + ((end - start) * index) / (timestamps.length - 1);
        });
  return {
    rateSourceKey,
    baselineUnits,
    points: expandedRates.map((rate, index) => ({
      ts: timestamps[index],
      rate,
      percentChange:
        index === 0 ? 0 : ((rate - expandedRates[0]) / expandedRates[0]) * 100,
    })),
  };
}

function buildSeries(
  constituents: readonly WeightedGroupRateConstituentInput[],
  windowStartTs = 1,
  windowEndTs = MAX_CHART_POINTS,
) {
  return buildWeightedGroupRateSeries({
    quoteCurrency: 'USD',
    assetGroupId: 'usdc',
    walletIdsKey: 'wallet-a|wallet-b',
    interval: '1D',
    windowStartTs,
    windowEndTs,
    windowAnchorTs: windowEndTs,
    sampledFromStoredInterval: '1D',
    constituents,
  });
}

function buildOracleWeightedSeries(
  constituents: readonly WeightedGroupRateConstituentInput[] = WEIGHTED_GROUP_FIXTURE.constituents,
) {
  return buildWeightedGroupRateSeries({
    quoteCurrency: WEIGHTED_GROUP_FIXTURE.quoteCurrency,
    assetGroupId: WEIGHTED_GROUP_FIXTURE.assetGroupId,
    walletIdsKey: WEIGHTED_GROUP_FIXTURE.walletIdsKey,
    interval: WEIGHTED_GROUP_FIXTURE.interval,
    windowStartTs: WEIGHTED_GROUP_FIXTURE.windowStartTs,
    windowEndTs: WEIGHTED_GROUP_FIXTURE.windowEndTs,
    windowAnchorTs: WEIGHTED_GROUP_FIXTURE.windowAnchorTs,
    sampledFromStoredInterval: WEIGHTED_GROUP_FIXTURE.sampledFromStoredInterval,
    constituents,
  });
}

describe('portfolio v2 weighted group rate series compute adapter', () => {
  it('builds the pinned baseline-unit weighted group fixture', () => {
    const series = buildOracleWeightedSeries();

    expect(series.availability).toBe('valid');
    if (series.availability !== 'valid') {
      throw new Error(series.unavailableReason);
    }
    expect(series.memberRateSourceKeys).toEqual(
      WEIGHTED_GROUP_FIXTURE.expected.memberRateSourceKeys,
    );
    expect(series.baselineUnitsByRateSourceKey).toEqual(
      WEIGHTED_GROUP_FIXTURE.expected.baselineUnitsByRateSourceKey,
    );
    expect(series.points).toHaveLength(MAX_CHART_POINTS);
    expect(series.points[0].weightedRate).toBeCloseTo(
      WEIGHTED_GROUP_FIXTURE.expected.weightedRateStart,
      12,
    );
    expect(series.points[0].weightedPercent).toBe(0);
    expect(series.points[series.points.length - 1].weightedRate).toBeCloseTo(
      WEIGHTED_GROUP_FIXTURE.expected.weightedRateEnd,
      12,
    );
    expect(series.points[series.points.length - 1].weightedPercent).toBeCloseTo(
      WEIGHTED_GROUP_FIXTURE.expected.weightedPercentEnd,
      10,
    );
    expect(series.fingerprint).toMatch(/^fnv1a:[0-9a-f]{8}$/);
  });

  it('publishes zeroBaseline unavailable when no constituent has baseline weight', () => {
    const series = buildOracleWeightedSeries(
      WEIGHTED_ZERO_BASELINE_FIXTURE.constituents,
    );

    expect(series).toMatchObject({
      availability: 'unavailable',
      unavailableReason:
        WEIGHTED_ZERO_BASELINE_FIXTURE.expected.unavailableReason,
      points: [],
      memberRateSourceKeys:
        WEIGHTED_ZERO_BASELINE_FIXTURE.expected.memberRateSourceKeys,
      baselineUnitsByRateSourceKey:
        WEIGHTED_ZERO_BASELINE_FIXTURE.expected.baselineUnitsByRateSourceKey,
    });
    expect(series.fingerprint).toMatch(/^fnv1a:[0-9a-f]{8}$/);
  });

  it('allows zero-weight constituents to lack rates without blocking the group', () => {
    const series = buildSeries([
      constituent('eth-usdc', 2, [1, 1.2]),
      constituent('pol-usdc', 0, []),
    ]);

    expect(series.availability).toBe('valid');
    if (series.availability !== 'valid') {
      throw new Error(series.unavailableReason);
    }
    expect(series.baselineUnitsByRateSourceKey).toEqual({
      'eth-usdc': 2,
      'pol-usdc': 0,
    });
    expect(series.points[series.points.length - 1]).toEqual({
      ts: MAX_CHART_POINTS,
      weightedRate: 1.2,
      weightedPercent: 19.999999999999996,
    });
  });

  it('returns missingConstituentRate instead of publishing partial charts', () => {
    const missing = buildOracleWeightedSeries(
      WEIGHTED_MISSING_CONSTITUENT_FIXTURE.constituents,
    );
    const mismatchedGrid = buildSeries(
      [
        constituent('eth-usdc', 2, [1, 1.2], [1, MAX_CHART_POINTS]),
        constituent('pol-usdc', 1, [1, 1.1], [1, MAX_CHART_POINTS + 1]),
      ],
      1,
      MAX_CHART_POINTS,
    );
    const malformed = buildSeries([
      constituent('eth-usdc', 2, [1, 1.2]),
      constituent('pol-usdc', 1, [1, 0]),
    ]);

    for (const series of [missing, mismatchedGrid, malformed]) {
      expect(series).toMatchObject({
        availability: 'unavailable',
        unavailableReason:
          WEIGHTED_MISSING_CONSTITUENT_FIXTURE.expected.unavailableReason,
        points: [],
      });
    }
  });

  it('keeps fingerprints stable across input order by sorting rate-source keys', () => {
    const first = buildSeries([
      constituent('pol-usdc', 40, [1.005, 1.006]),
      constituent('eth-usdc', 100, [1, 1.002]),
    ]);
    const second = buildSeries([
      constituent('eth-usdc', 100, [1, 1.002]),
      constituent('pol-usdc', 40, [1.005, 1.006]),
    ]);

    expect(first.memberRateSourceKeys).toEqual(['eth-usdc', 'pol-usdc']);
    expect(second.memberRateSourceKeys).toEqual(['eth-usdc', 'pol-usdc']);
    expect(first.baselineUnitsByRateSourceKey).toEqual(
      second.baselineUnitsByRateSourceKey,
    );
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it('fingerprints middle points and baseline weight vectors, not just endpoints', () => {
    const base = buildWeightedGroupRateSeries({
      quoteCurrency: 'USD',
      assetGroupId: 'usdc',
      walletIdsKey: 'wallet-a|wallet-b',
      interval: '1D',
      windowStartTs: 1,
      windowEndTs: MAX_CHART_POINTS,
      windowAnchorTs: MAX_CHART_POINTS,
      sampledFromStoredInterval: '1D',
      constituents: [
        constituent('eth-usdc', 100, [1, 1.2]),
        constituent('pol-usdc', 40, [1, 1.2]),
      ],
    });
    const middleChanged = buildWeightedGroupRateSeries({
      quoteCurrency: 'USD',
      assetGroupId: 'usdc',
      walletIdsKey: 'wallet-a|wallet-b',
      interval: '1D',
      windowStartTs: 1,
      windowEndTs: MAX_CHART_POINTS,
      windowAnchorTs: MAX_CHART_POINTS,
      sampledFromStoredInterval: '1D',
      constituents: [
        constituent(
          'eth-usdc',
          100,
          Array.from({length: MAX_CHART_POINTS}, (_, index) =>
            index === 44 ? 1.15 : 1 + (0.2 * index) / (MAX_CHART_POINTS - 1),
          ),
        ),
        constituent('pol-usdc', 40, [1, 1.2]),
      ],
    });
    const weightsChangedSamePoints = buildWeightedGroupRateSeries({
      quoteCurrency: 'USD',
      assetGroupId: 'usdc',
      walletIdsKey: 'wallet-a|wallet-b',
      interval: '1D',
      windowStartTs: 1,
      windowEndTs: MAX_CHART_POINTS,
      windowAnchorTs: MAX_CHART_POINTS,
      sampledFromStoredInterval: '1D',
      constituents: [
        constituent('eth-usdc', 80, [1, 1.2]),
        constituent('pol-usdc', 60, [1, 1.2]),
      ],
    });

    expect(base.availability).toBe('valid');
    expect(middleChanged.availability).toBe('valid');
    expect(weightsChangedSamePoints.availability).toBe('valid');
    expect(middleChanged.points[0]).toEqual(base.points[0]);
    expect(middleChanged.points[middleChanged.points.length - 1]).toEqual(
      base.points[base.points.length - 1],
    );
    expect(middleChanged.fingerprint).not.toBe(base.fingerprint);
    expect(weightsChangedSamePoints.points[0]).toEqual(base.points[0]);
    expect(
      weightsChangedSamePoints.points[
        weightsChangedSamePoints.points.length - 1
      ].weightedRate,
    ).toBeCloseTo(base.points[base.points.length - 1].weightedRate, 12);
    expect(weightsChangedSamePoints.fingerprint).not.toBe(base.fingerprint);
  });

  it('fingerprints the sampled stored interval', () => {
    const oneDay = buildWeightedGroupRateSeries({
      quoteCurrency: 'USD',
      assetGroupId: 'usdc',
      walletIdsKey: 'wallet-a|wallet-b',
      interval: '3M',
      windowStartTs: 1,
      windowEndTs: MAX_CHART_POINTS,
      windowAnchorTs: MAX_CHART_POINTS,
      sampledFromStoredInterval: '1D',
      constituents: [
        constituent('eth-usdc', 100, [1, 1.2]),
        constituent('pol-usdc', 40, [1, 1.2]),
      ],
    });
    const all = buildWeightedGroupRateSeries({
      quoteCurrency: 'USD',
      assetGroupId: 'usdc',
      walletIdsKey: 'wallet-a|wallet-b',
      interval: '3M',
      windowStartTs: 1,
      windowEndTs: MAX_CHART_POINTS,
      windowAnchorTs: MAX_CHART_POINTS,
      sampledFromStoredInterval: 'ALL',
      constituents: [
        constituent('eth-usdc', 100, [1, 1.2]),
        constituent('pol-usdc', 40, [1, 1.2]),
      ],
    });

    expect(oneDay.points).toEqual(all.points);
    expect(oneDay.fingerprint).not.toBe(all.fingerprint);
  });

  it('fingerprints the shared window anchor', () => {
    const first = buildSeries([
      constituent('eth-usdc', 100, [1, 1.2]),
      constituent('pol-usdc', 40, [1, 1.2]),
    ]);
    const second = buildWeightedGroupRateSeries({
      quoteCurrency: 'USD',
      assetGroupId: 'usdc',
      walletIdsKey: 'wallet-a|wallet-b',
      interval: '1D',
      windowStartTs: 1,
      windowEndTs: MAX_CHART_POINTS,
      windowAnchorTs: MAX_CHART_POINTS + 1,
      sampledFromStoredInterval: '1D',
      constituents: [
        constituent('eth-usdc', 100, [1, 1.2]),
        constituent('pol-usdc', 40, [1, 1.2]),
      ],
    });

    expect(first.points).toEqual(second.points);
    expect(first.fingerprint).not.toBe(second.fingerprint);
  });

  it('returns missingConstituentRate for otherwise valid short weighted charts', () => {
    const series = buildWeightedGroupRateSeries({
      quoteCurrency: 'USD',
      assetGroupId: 'usdc',
      walletIdsKey: 'wallet-a|wallet-b',
      interval: '1D',
      windowStartTs: 1,
      windowEndTs: 2,
      windowAnchorTs: 2,
      sampledFromStoredInterval: '1D',
      constituents: [
        constituent('eth-usdc', 100, [1, 1.2], [1, 2]),
        constituent('pol-usdc', 40, [1, 1.2], [1, 2]),
      ],
    });

    expect(series).toMatchObject({
      availability: 'unavailable',
      unavailableReason: 'missingConstituentRate',
      points: [],
    });
  });

  it('treats duplicate or malformed constituent identities as missing rates', () => {
    const duplicate = buildSeries([
      constituent('eth-usdc', 1, [1, 1.1]),
      constituent('eth-usdc', 2, [1, 1.1]),
    ]);
    const blank = buildSeries([constituent(' ', 1, [1, 1.1])]);
    const negativeUnits = buildSeries([constituent('eth-usdc', -1, [1, 1.1])]);

    for (const series of [duplicate, blank, negativeUnits]) {
      expect(series).toMatchObject({
        availability: 'unavailable',
        unavailableReason: 'missingConstituentRate',
        points: [],
      });
    }
  });

  it('treats malformed top-level identity or window inputs as missing rates', () => {
    const validConstituents = [
      constituent('eth-usdc', 1, [1, 1.1]),
      constituent('pol-usdc', 1, [1, 1.1]),
    ];
    const invalidStoredInterval = buildWeightedGroupRateSeries({
      quoteCurrency: 'USD',
      assetGroupId: 'usdc',
      walletIdsKey: 'wallet-a|wallet-b',
      interval: '1D',
      windowStartTs: 1,
      windowEndTs: MAX_CHART_POINTS,
      windowAnchorTs: MAX_CHART_POINTS,
      sampledFromStoredInterval: '3M' as any,
      constituents: validConstituents,
    });
    const malformedSeries = [
      buildWeightedGroupRateSeries({
        quoteCurrency: '',
        assetGroupId: 'usdc',
        walletIdsKey: 'wallet-a|wallet-b',
        interval: '1D',
        windowStartTs: 1,
        windowEndTs: MAX_CHART_POINTS,
        windowAnchorTs: MAX_CHART_POINTS,
        sampledFromStoredInterval: '1D',
        constituents: validConstituents,
      }),
      buildWeightedGroupRateSeries({
        quoteCurrency: 'USD',
        assetGroupId: ' usdc',
        walletIdsKey: 'wallet-a|wallet-b',
        interval: '1D',
        windowStartTs: 1,
        windowEndTs: MAX_CHART_POINTS,
        windowAnchorTs: MAX_CHART_POINTS,
        sampledFromStoredInterval: '1D',
        constituents: validConstituents,
      }),
      buildWeightedGroupRateSeries({
        quoteCurrency: 'USD',
        assetGroupId: 'usdc',
        walletIdsKey: ' ',
        interval: '1D',
        windowStartTs: 1,
        windowEndTs: MAX_CHART_POINTS,
        windowAnchorTs: MAX_CHART_POINTS,
        sampledFromStoredInterval: '1D',
        constituents: validConstituents,
      }),
      buildWeightedGroupRateSeries({
        quoteCurrency: 'USD',
        assetGroupId: 'usdc',
        walletIdsKey: 'wallet-a|wallet-b',
        interval: '1D',
        windowStartTs: Number.NaN,
        windowEndTs: MAX_CHART_POINTS,
        windowAnchorTs: MAX_CHART_POINTS,
        sampledFromStoredInterval: '1D',
        constituents: validConstituents,
      }),
      buildWeightedGroupRateSeries({
        quoteCurrency: 'USD',
        assetGroupId: 'usdc',
        walletIdsKey: 'wallet-a|wallet-b',
        interval: '1D',
        windowStartTs: 1,
        windowEndTs: 1,
        windowAnchorTs: 1,
        sampledFromStoredInterval: '1D',
        constituents: validConstituents,
      }),
      buildWeightedGroupRateSeries({
        quoteCurrency: 'USD',
        assetGroupId: 'usdc',
        walletIdsKey: 'wallet-a|wallet-b',
        interval: '1D',
        windowStartTs: 2,
        windowEndTs: 1,
        windowAnchorTs: 1,
        sampledFromStoredInterval: '1D',
        constituents: validConstituents,
      }),
      invalidStoredInterval,
    ];

    for (const series of malformedSeries) {
      expect(series).toMatchObject({
        availability: 'unavailable',
        unavailableReason: 'missingConstituentRate',
        points: [],
      });
    }
    expect(invalidStoredInterval.sampledFromStoredInterval).toBe('ALL');
  });
});
