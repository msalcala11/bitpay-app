import type {RowPayload, Series, WeightedGroupRateSeries} from '../model';
import {
  atomicToDisplayUnitAmount,
  buildAssetGroupRowPayload,
  buildAssetGroupRowShell,
} from './assetGroupRows';

type ValidWeightedGroupRateSeries = Extract<
  WeightedGroupRateSeries,
  {availability: 'valid'}
>;

function expectVisibleShell(
  result: ReturnType<typeof buildAssetGroupRowShell>,
) {
  expect(result.kind).toBe('visible');
  if (result.kind !== 'visible') {
    throw new Error(`Expected visible shell, received ${result.kind}`);
  }
  return result.rowShell;
}

function expectValidRowPayload(
  result: ReturnType<typeof buildAssetGroupRowPayload>,
) {
  expect(result.kind).toBe('valid');
  if (result.kind !== 'valid') {
    throw new Error(`Expected valid row payload, received ${result.kind}`);
  }
  return result.row;
}

const rowToday: RowPayload = {
  assetGroupId: 'usdc',
  rowFingerprint: 'today',
  fiatStart: 100,
  fiatEnd: 110,
  pnlChange: 10,
  pnlPercent: 10,
  rateStart: 1,
  rateEnd: 1.1,
  ratePercent: 10,
};

const portfolioSeries: Pick<Series, 'interval' | 'points'> = {
  interval: '1D',
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

function makeWeightedSeries(
  weightedRateStart: number,
  weightedRateEnd: number,
): ValidWeightedGroupRateSeries {
  return {
    availability: 'valid',
    fingerprint: 'weighted',
    interval: '1D',
    windowStartTs: 1,
    windowEndTs: 2,
    windowAnchorTs: 2,
    sampledFromStoredInterval: '1D',
    memberRateSourceKeys: ['usdc|eth', 'usdc|pol'],
    baselineUnitsByRateSourceKey: {
      'usdc|eth': 100,
      'usdc|pol': 40,
    },
    weighting: 'baselineUnitWeightedCollapsedGroup',
    points: [
      {ts: 1, weightedRate: weightedRateStart, weightedPercent: 0},
      {ts: 2, weightedRate: weightedRateEnd, weightedPercent: 20},
    ],
  };
}

describe('portfolio v2 asset-group row shell compute adapter', () => {
  it('sums display-unit amounts and publishes collapsed health metadata', () => {
    const rowShell = expectVisibleShell(
      buildAssetGroupRowShell({
        assetGroupId: 'usdc',
        displaySymbol: 'USDC',
        orderIndex: 2,
        rowToday,
        members: [
          {
            walletId: 'eth-usdc',
            assetIdentityKey: 'usdc|eth|0x1',
            rateSourceKey: 'usdc|eth|0x1',
            displayUnitsAtomic: '1500000',
            displayUnitDecimals: 6,
            liveRate: 1.01,
          },
          {
            walletId: 'pol-usdc',
            assetIdentityKey: 'usdc|pol|0x2',
            rateSourceKey: 'usdc|pol|0x2',
            displayUnitsAtomic: '2000000000000000000',
            displayUnitDecimals: 18,
          },
          {
            walletId: 'sol-usdc',
            assetIdentityKey: 'usdc|sol|mint',
            rateSourceKey: 'usdc|sol|mint',
            displayUnitsAtomic: '0',
            displayUnitDecimals: 6,
            invalidHistoryBlocked: true,
          },
        ],
      }),
    );

    expect(rowShell.currentCryptoAmount).toBe('3.5');
    expect(rowShell).not.toHaveProperty('currentFiatValue');
    expect(rowShell.memberWalletIds).toEqual([
      'eth-usdc',
      'pol-usdc',
      'sol-usdc',
    ]);
    expect(rowShell.memberWalletIdsKey).toMatch(/^walletIds:v2:3:fnv1a128:/);
    expect(rowShell.memberRateSourceKeys).toEqual([
      'usdc|eth|0x1',
      'usdc|pol|0x2',
      'usdc|sol|mint',
    ]);
    expect(rowShell).not.toHaveProperty('canonicalUnitDecimals');
    expect(rowShell.groupHealth).toEqual({
      collapsedAcrossDistinctAssets: true,
      decimalConflict: true,
      missingLiveRateMemberWalletIds: ['pol-usdc', 'sol-usdc'],
      nonzeroMissingLiveRateMemberWalletIds: ['pol-usdc'],
    });
    expect(rowShell.readyToday).toBe(true);
    expect(rowShell.readyAllTime).toBe(false);
    expect(rowShell.invalidHistoryBlocked).toBe(true);
  });

  it('publishes zero fiat value when every visible member has zero units', () => {
    const rowShell = expectVisibleShell(
      buildAssetGroupRowShell({
        assetGroupId: 'doge',
        displaySymbol: 'DOGE',
        orderIndex: 0,
        members: [
          {
            walletId: 'doge-a',
            assetIdentityKey: 'doge',
            rateSourceKey: 'doge',
            displayUnitsAtomic: '0',
            displayUnitDecimals: 8,
          },
          {
            walletId: 'doge-b',
            assetIdentityKey: 'doge',
            rateSourceKey: 'doge',
            displayUnitsAtomic: '0',
            displayUnitDecimals: 8,
          },
        ],
      }),
    );

    expect(rowShell.currentCryptoAmount).toBe('0');
    expect(rowShell.currentFiatValue).toBe(0);
    expect(rowShell.canonicalUnitDecimals).toBe(8);
    expect(rowShell.groupHealth).toMatchObject({
      collapsedAcrossDistinctAssets: false,
      decimalConflict: false,
      missingLiveRateMemberWalletIds: ['doge-a', 'doge-b'],
      nonzeroMissingLiveRateMemberWalletIds: [],
    });
  });

  it('sums current fiat value per member rate source when rates are present', () => {
    const rowShell = expectVisibleShell(
      buildAssetGroupRowShell({
        assetGroupId: 'usdc',
        displaySymbol: 'USDC',
        orderIndex: 1,
        members: [
          {
            walletId: 'pol-usdc',
            assetIdentityKey: 'usdc|pol|0x2',
            rateSourceKey: 'usdc|pol|0x2',
            displayUnitsAtomic: '2000000',
            displayUnitDecimals: 6,
            liveRate: 1.02,
          },
          {
            walletId: 'eth-usdc',
            assetIdentityKey: 'usdc|eth|0x1',
            rateSourceKey: 'usdc|eth|0x1',
            displayUnitsAtomic: '1500000',
            displayUnitDecimals: 6,
            liveRate: 1.01,
          },
        ],
      }),
    );

    expect(rowShell.currentCryptoAmount).toBe('3.5');
    expect(rowShell.currentFiatValue).toBeCloseTo(3.555);
    expect(rowShell.memberWalletIds).toEqual(['pol-usdc', 'eth-usdc']);
    expect(rowShell.memberWalletIdsKey).toMatch(/^walletIds:v2:2:fnv1a128:/);
    expect(rowShell.canonicalUnitDecimals).toBe(6);
  });

  it('keeps high-precision display-unit sums exact in the row shell', () => {
    const rowShell = expectVisibleShell(
      buildAssetGroupRowShell({
        assetGroupId: 'dust',
        displaySymbol: 'DUST',
        orderIndex: 0,
        members: [
          {
            walletId: 'dust-a',
            assetIdentityKey: 'dust',
            rateSourceKey: 'dust',
            displayUnitsAtomic: '1',
            displayUnitDecimals: 18,
            liveRate: 1,
          },
          {
            walletId: 'dust-b',
            assetIdentityKey: 'dust',
            rateSourceKey: 'dust',
            displayUnitsAtomic: '2',
            displayUnitDecimals: 18,
            liveRate: 1,
          },
        ],
      }),
    );

    expect(rowShell.currentCryptoAmount).toBe('0.000000000000000003');
    expect(rowShell.currentFiatValue).toBeCloseTo(3e-18);
  });

  it('scales atomics before numeric fiat math and rejects unsafe display amounts', () => {
    expect(
      atomicToDisplayUnitAmount({
        atomic: '1000000000000000001',
        decimals: 18,
      }),
    ).toEqual({
      decimalString: '1.000000000000000001',
      approximateNumber: 1,
    });

    expect(
      buildAssetGroupRowShell({
        assetGroupId: 'unsafe',
        displaySymbol: 'UNSAFE',
        orderIndex: 0,
        members: [
          {
            walletId: 'unsafe-wallet',
            assetIdentityKey: 'unsafe',
            rateSourceKey: 'unsafe',
            displayUnitsAtomic: String(Number.MAX_SAFE_INTEGER + 1),
            displayUnitDecimals: 0,
            liveRate: 1,
          },
        ],
      }),
    ).toEqual({kind: 'invalid', reason: 'unsafeDisplayUnits'});
  });

  it('publishes UI-safe member descriptors without raw identifiers', () => {
    const rowShell = expectVisibleShell(
      buildAssetGroupRowShell({
        assetGroupId: 'usdc',
        displaySymbol: 'USDC',
        orderIndex: 1,
        symbolCollisionSuspected: true,
        members: [
          {
            walletId: 'wallet-raw-id',
            assetIdentityKey: 'usdc|eth|0xabc',
            rateSourceKey: 'rate:v1:USD:usdc',
            displayUnitsAtomic: '1000000',
            displayUnitDecimals: 6,
            liveRate: 1,
            descriptor: {
              displaySymbol: 'USDC',
              chainLabel: 'Ethereum',
              tokenAddressLabel: '0x1234567890abcdef1234',
            },
          },
        ],
      }),
    );

    expect(rowShell.memberDescriptors).toEqual([
      {
        displaySymbol: 'USDC',
        chainLabel: 'Ethereum',
        walletCount: 1,
      },
    ]);
    expect(rowShell.groupHealth.symbolCollisionSuspected).toBe(true);
    expect(JSON.stringify(rowShell.memberDescriptors)).not.toContain(
      'wallet-raw-id',
    );
    expect(JSON.stringify(rowShell.memberDescriptors)).not.toContain('rate:v1');
    expect(JSON.stringify(rowShell.memberDescriptors)).not.toContain('0x1234');
  });

  it('formats whole numbers, trailing decimals, zero, and mixed-scale sums', () => {
    const whole = expectVisibleShell(
      buildAssetGroupRowShell({
        assetGroupId: 'whole',
        displaySymbol: 'WHOLE',
        orderIndex: 0,
        members: [
          {
            walletId: 'whole-a',
            assetIdentityKey: 'whole',
            rateSourceKey: 'whole',
            displayUnitsAtomic: '123000000',
            displayUnitDecimals: 6,
            liveRate: 1,
          },
          {
            walletId: 'whole-b',
            assetIdentityKey: 'whole',
            rateSourceKey: 'whole',
            displayUnitsAtomic: '450000',
            displayUnitDecimals: 6,
            liveRate: 1,
          },
        ],
      }),
    );
    const zero = expectVisibleShell(
      buildAssetGroupRowShell({
        assetGroupId: 'zero',
        displaySymbol: 'ZERO',
        orderIndex: 0,
        members: [
          {
            walletId: 'zero-a',
            assetIdentityKey: 'zero',
            rateSourceKey: 'zero',
            displayUnitsAtomic: '0',
            displayUnitDecimals: 18,
          },
        ],
      }),
    );
    const mixedScale = expectVisibleShell(
      buildAssetGroupRowShell({
        assetGroupId: 'mixed',
        displaySymbol: 'MIXED',
        orderIndex: 0,
        members: [
          {
            walletId: 'mixed-six',
            assetIdentityKey: 'mixed-six',
            rateSourceKey: 'mixed-six',
            displayUnitsAtomic: '1',
            displayUnitDecimals: 6,
            liveRate: 1,
          },
          {
            walletId: 'mixed-eighteen',
            assetIdentityKey: 'mixed-eighteen',
            rateSourceKey: 'mixed-eighteen',
            displayUnitsAtomic: '1',
            displayUnitDecimals: 18,
            liveRate: 1,
          },
        ],
      }),
    );

    expect(whole.currentCryptoAmount).toBe('123.45');
    expect(zero.currentCryptoAmount).toBe('0');
    expect(zero.currentFiatValue).toBe(0);
    expect(mixedScale.currentCryptoAmount).toBe('0.000001000000000001');
  });

  it('trims display symbols while keeping identity fields strict', () => {
    const rowShell = expectVisibleShell(
      buildAssetGroupRowShell({
        assetGroupId: 'btc',
        displaySymbol: '  Bitcoin Cash  ',
        orderIndex: 0,
        members: [
          {
            walletId: 'btc-wallet',
            assetIdentityKey: 'btc',
            rateSourceKey: 'btc',
            displayUnitsAtomic: '100000000',
            displayUnitDecimals: 8,
          },
        ],
      }),
    );

    expect(rowShell.displaySymbol).toBe('Bitcoin Cash');
    expect(
      buildAssetGroupRowShell({
        assetGroupId: 'btc',
        displaySymbol: '   ',
        orderIndex: 0,
        members: [
          {
            walletId: 'btc-wallet',
            assetIdentityKey: 'btc',
            rateSourceKey: 'btc',
            displayUnitsAtomic: '100000000',
            displayUnitDecimals: 8,
          },
        ],
      }),
    ).toEqual({kind: 'invalid', reason: 'missingDisplaySymbol'});
  });

  it('returns empty or invalid instead of publishing malformed row shells', () => {
    expect(
      buildAssetGroupRowShell({
        assetGroupId: 'btc',
        displaySymbol: 'BTC',
        orderIndex: 0,
        members: [],
      }),
    ).toEqual({kind: 'empty'});
    expect(
      buildAssetGroupRowShell({
        assetGroupId: ' btc',
        displaySymbol: 'BTC',
        orderIndex: 0,
        members: [
          {
            walletId: 'btc-wallet',
            assetIdentityKey: 'btc',
            rateSourceKey: 'btc',
            displayUnitsAtomic: '100000000',
            displayUnitDecimals: 8,
          },
        ],
      }),
    ).toEqual({kind: 'invalid', reason: 'missingAssetGroupId'});
    expect(
      buildAssetGroupRowShell({
        assetGroupId: 'btc',
        displaySymbol: 'BTC',
        orderIndex: 0,
        members: [
          {
            walletId: 'btc-wallet',
            assetIdentityKey: 'btc',
            rateSourceKey: 'btc',
            displayUnitsAtomic: '-1',
            displayUnitDecimals: 8,
          },
        ],
      }),
    ).toEqual({kind: 'invalid', reason: 'negativeDisplayUnitsAtomic'});
    expect(
      buildAssetGroupRowShell({
        assetGroupId: 'btc',
        displaySymbol: 'BTC',
        orderIndex: 0,
        members: [
          {
            walletId: 'btc-wallet',
            assetIdentityKey: 'btc',
            rateSourceKey: 'btc',
            displayUnitsAtomic: '100000000',
            displayUnitDecimals: 8,
          },
          {
            walletId: 'btc-wallet',
            assetIdentityKey: 'btc',
            rateSourceKey: 'btc',
            displayUnitsAtomic: '200000000',
            displayUnitDecimals: 8,
          },
        ],
      }),
    ).toEqual({kind: 'invalid', reason: 'duplicateWalletId'});
    expect(
      buildAssetGroupRowShell({
        assetGroupId: 'huge',
        displaySymbol: 'HUGE',
        orderIndex: 0,
        members: [
          {
            walletId: 'huge-wallet',
            assetIdentityKey: 'huge',
            rateSourceKey: 'huge',
            displayUnitsAtomic: `1${'0'.repeat(400)}`,
            displayUnitDecimals: 0,
            liveRate: 1,
          },
        ],
      }),
    ).toEqual({kind: 'invalid', reason: 'nonFiniteDisplayUnits'});
  });

  it('uses market rate endpoints for single-source row payloads', () => {
    const row = expectValidRowPayload(
      buildAssetGroupRowPayload({
        assetGroupId: 'btc',
        series: portfolioSeries,
        rateSource: {
          kind: 'marketRateSeries',
          points: [
            {ts: 1, rate: 10, percentChange: 0},
            {ts: 2, rate: 15, percentChange: 49.5},
          ],
        },
      }),
    );

    expect(row.rateStart).toBe(10);
    expect(row.rateEnd).toBe(15);
    expect(row.ratePercent).toBe(49.5);
  });

  it('uses weighted group endpoints for collapsed row payloads', () => {
    const row = expectValidRowPayload(
      buildAssetGroupRowPayload({
        assetGroupId: 'usdc',
        series: portfolioSeries,
        rateSource: {
          kind: 'weightedGroupRateSeries',
          series: makeWeightedSeries(1, 1.19),
        },
      }),
    );

    expect(row.rateStart).toBe(1);
    expect(row.rateEnd).toBe(1.19);
    expect(row.ratePercent).toBeCloseTo(20);
  });

  it('rejects rate endpoints that do not align with portfolio series endpoints', () => {
    expect(
      buildAssetGroupRowPayload({
        assetGroupId: 'btc',
        series: portfolioSeries,
        rateSource: {
          kind: 'marketRateSeries',
          points: [
            {ts: 0, rate: 10, percentChange: 0},
            {ts: 2, rate: 15, percentChange: 50},
          ],
        },
      }),
    ).toEqual({kind: 'missingRateSource', reason: 'rateEndpointMismatch'});
    expect(
      buildAssetGroupRowPayload({
        assetGroupId: 'usdc',
        series: portfolioSeries,
        rateSource: {
          kind: 'weightedGroupRateSeries',
          series: {
            ...makeWeightedSeries(1, 1.2),
            points: [
              {ts: 1, weightedRate: 1, weightedPercent: 0},
              {ts: 3, weightedRate: 1.2, weightedPercent: 20},
            ],
          },
        },
      }),
    ).toEqual({kind: 'missingRateSource', reason: 'rateEndpointMismatch'});
  });

  it('rejects malformed market and weighted rate timelines', () => {
    expect(
      buildAssetGroupRowPayload({
        assetGroupId: 'btc',
        series: portfolioSeries,
        rateSource: {
          kind: 'marketRateSeries',
          points: [
            {ts: 1, rate: 10, percentChange: 0},
            {ts: 1, rate: 15, percentChange: 50},
          ],
        },
      }),
    ).toEqual({
      kind: 'missingRateSource',
      reason: 'malformedMarketRateSeries',
    });
    expect(
      buildAssetGroupRowPayload({
        assetGroupId: 'usdc',
        series: portfolioSeries,
        rateSource: {
          kind: 'weightedGroupRateSeries',
          series: {
            ...makeWeightedSeries(1, 1.2),
            points: [
              {ts: 1, weightedRate: 1, weightedPercent: 0},
              {
                ts: 2,
                weightedRate: 1.2,
                weightedPercent: Number.POSITIVE_INFINITY,
              },
            ],
          },
        },
      }),
    ).toEqual({
      kind: 'missingRateSource',
      reason: 'malformedWeightedRateSeries',
    });
  });

  it('does not build collapsed row payloads from unavailable weighted rates', () => {
    const result = buildAssetGroupRowPayload({
      assetGroupId: 'usdc',
      series: portfolioSeries,
      rateSource: {
        kind: 'weightedGroupRateSeries',
        series: {
          ...makeWeightedSeries(1, 1.2),
          availability: 'unavailable',
          unavailableReason: 'missingConstituentRate',
          points: [],
        },
      },
    });

    expect(result).toEqual({
      kind: 'missingRateSource',
      reason: 'weightedRateUnavailable',
    });
  });
});
