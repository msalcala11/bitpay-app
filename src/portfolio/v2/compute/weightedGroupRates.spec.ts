import {
  buildWeightedGroupRateSeries,
  type WeightedGroupRateConstituentInput,
} from './weightedGroupRates';

function constituent(
  rateSourceKey: string,
  baselineUnits: number,
  rates: readonly number[],
  timestamps: readonly number[] = [1, 2],
): WeightedGroupRateConstituentInput {
  return {
    rateSourceKey,
    baselineUnits,
    points: rates.map((rate, index) => ({
      ts: timestamps[index],
      rate,
      percentChange: index === 0 ? 0 : ((rate - rates[0]) / rates[0]) * 100,
    })),
  };
}

function buildSeries(
  constituents: readonly WeightedGroupRateConstituentInput[],
  windowStartTs = 1,
  windowEndTs = 2,
) {
  return buildWeightedGroupRateSeries({
    quoteCurrency: 'USD',
    assetGroupId: 'usdc',
    walletIdsKey: 'wallet-a|wallet-b',
    interval: '1D',
    windowStartTs,
    windowEndTs,
    sampledFromStoredInterval: '1D',
    constituents,
  });
}

describe('portfolio v2 weighted group rate series compute adapter', () => {
  it('builds the pinned baseline-unit weighted group fixture', () => {
    const series = buildSeries([
      constituent('eth-usdc', 100, [1, 1.002]),
      constituent('pol-usdc', 40, [1.005, 1.006]),
      constituent('sol-usdc', 40, [1.0048, 1.0038]),
    ]);

    expect(series.availability).toBe('valid');
    if (series.availability !== 'valid') {
      throw new Error(series.unavailableReason);
    }
    expect(series.memberRateSourceKeys).toEqual([
      'eth-usdc',
      'pol-usdc',
      'sol-usdc',
    ]);
    expect(series.baselineUnitsByRateSourceKey).toEqual({
      'eth-usdc': 100,
      'pol-usdc': 40,
      'sol-usdc': 40,
    });
    expect(series.points).toHaveLength(2);
    expect(series.points[0].weightedRate).toBeCloseTo(180.392 / 180, 12);
    expect(series.points[0].weightedPercent).toBe(0);
    expect(series.points[1].weightedRate).toBeCloseTo(
      180.592 / 180,
      12,
    );
    expect(series.points[1].weightedPercent).toBeCloseTo(
      ((180.592 - 180.392) / 180.392) * 100,
      10,
    );
    expect(series.fingerprint).toMatch(/^fnv1a:[0-9a-f]{8}$/);
  });

  it('publishes zeroBaseline unavailable when no constituent has baseline weight', () => {
    const series = buildSeries([
      constituent('eth-usdc', 0, []),
      constituent('pol-usdc', 0, []),
    ]);

    expect(series).toMatchObject({
      availability: 'unavailable',
      unavailableReason: 'zeroBaseline',
      points: [],
      memberRateSourceKeys: ['eth-usdc', 'pol-usdc'],
      baselineUnitsByRateSourceKey: {
        'eth-usdc': 0,
        'pol-usdc': 0,
      },
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
    expect(series.points[1]).toEqual({
      ts: 2,
      weightedRate: 1.2,
      weightedPercent: 19.999999999999996,
    });
  });

  it('returns missingConstituentRate instead of publishing partial charts', () => {
    const missing = buildSeries([
      constituent('eth-usdc', 2, [1, 1.2]),
      constituent('pol-usdc', 1, []),
    ]);
    const mismatchedGrid = buildSeries(
      [
        constituent('eth-usdc', 2, [1, 1.2], [1, 2]),
        constituent('pol-usdc', 1, [1, 1.1], [1, 3]),
      ],
      1,
      2,
    );
    const malformed = buildSeries([
      constituent('eth-usdc', 2, [1, 1.2]),
      constituent('pol-usdc', 1, [1, 0]),
    ]);

    for (const series of [missing, mismatchedGrid, malformed]) {
      expect(series).toMatchObject({
        availability: 'unavailable',
        unavailableReason: 'missingConstituentRate',
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
      windowEndTs: 3,
      sampledFromStoredInterval: '1D',
      constituents: [
        constituent('eth-usdc', 100, [1, 1.1, 1.2], [1, 2, 3]),
        constituent('pol-usdc', 40, [1, 1.1, 1.2], [1, 2, 3]),
      ],
    });
    const middleChanged = buildWeightedGroupRateSeries({
      quoteCurrency: 'USD',
      assetGroupId: 'usdc',
      walletIdsKey: 'wallet-a|wallet-b',
      interval: '1D',
      windowStartTs: 1,
      windowEndTs: 3,
      sampledFromStoredInterval: '1D',
      constituents: [
        constituent('eth-usdc', 100, [1, 1.15, 1.2], [1, 2, 3]),
        constituent('pol-usdc', 40, [1, 1.1, 1.2], [1, 2, 3]),
      ],
    });
    const weightsChangedSamePoints = buildWeightedGroupRateSeries({
      quoteCurrency: 'USD',
      assetGroupId: 'usdc',
      walletIdsKey: 'wallet-a|wallet-b',
      interval: '1D',
      windowStartTs: 1,
      windowEndTs: 3,
      sampledFromStoredInterval: '1D',
      constituents: [
        constituent('eth-usdc', 80, [1, 1.1, 1.2], [1, 2, 3]),
        constituent('pol-usdc', 60, [1, 1.1, 1.2], [1, 2, 3]),
      ],
    });

    expect(base.availability).toBe('valid');
    expect(middleChanged.availability).toBe('valid');
    expect(weightsChangedSamePoints.availability).toBe('valid');
    expect(middleChanged.points[0]).toEqual(base.points[0]);
    expect(middleChanged.points[2]).toEqual(base.points[2]);
    expect(middleChanged.fingerprint).not.toBe(base.fingerprint);
    expect(weightsChangedSamePoints.points).toEqual(base.points);
    expect(weightsChangedSamePoints.fingerprint).not.toBe(base.fingerprint);
  });

  it('fingerprints the sampled stored interval', () => {
    const oneDay = buildWeightedGroupRateSeries({
      quoteCurrency: 'USD',
      assetGroupId: 'usdc',
      walletIdsKey: 'wallet-a|wallet-b',
      interval: '3M',
      windowStartTs: 1,
      windowEndTs: 2,
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
      windowEndTs: 2,
      sampledFromStoredInterval: 'ALL',
      constituents: [
        constituent('eth-usdc', 100, [1, 1.2]),
        constituent('pol-usdc', 40, [1, 1.2]),
      ],
    });

    expect(oneDay.points).toEqual(all.points);
    expect(oneDay.fingerprint).not.toBe(all.fingerprint);
  });

  it('treats duplicate or malformed constituent identities as missing rates', () => {
    const duplicate = buildSeries([
      constituent('eth-usdc', 1, [1, 1.1]),
      constituent('eth-usdc', 2, [1, 1.1]),
    ]);
    const blank = buildSeries([constituent(' ', 1, [1, 1.1])]);
    const negativeUnits = buildSeries([
      constituent('eth-usdc', -1, [1, 1.1]),
    ]);

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
    const blankAssetGroup = buildWeightedGroupRateSeries({
      quoteCurrency: 'USD',
      assetGroupId: ' usdc',
      walletIdsKey: 'wallet-a|wallet-b',
      interval: '1D',
      windowStartTs: 1,
      windowEndTs: 2,
      sampledFromStoredInterval: '1D',
      constituents: validConstituents,
    });
    const malformedWindow = buildWeightedGroupRateSeries({
      quoteCurrency: 'USD',
      assetGroupId: 'usdc',
      walletIdsKey: 'wallet-a|wallet-b',
      interval: '1D',
      windowStartTs: 2,
      windowEndTs: 1,
      sampledFromStoredInterval: '1D',
      constituents: validConstituents,
    });

    for (const series of [blankAssetGroup, malformedWindow]) {
      expect(series).toMatchObject({
        availability: 'unavailable',
        unavailableReason: 'missingConstituentRate',
        points: [],
      });
    }
  });
});
