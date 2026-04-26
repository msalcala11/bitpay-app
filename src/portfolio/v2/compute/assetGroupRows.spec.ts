import type {
  RowPayload,
  Series,
  WeightedGroupRateSeries,
} from '../model';
import {
  buildAssetGroupRowPayload,
  buildAssetGroupRowShell,
} from './assetGroupRows';

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
): WeightedGroupRateSeries {
  return {
    availability: 'valid',
    fingerprint: 'weighted',
    interval: '1D',
    windowStartTs: 1,
    windowEndTs: 2,
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
            displayUnits: 1.5,
            displayUnitDecimals: 6,
            liveRate: 1.01,
          },
          {
            walletId: 'pol-usdc',
            assetIdentityKey: 'usdc|pol|0x2',
            rateSourceKey: 'usdc|pol|0x2',
            displayUnits: 2,
            displayUnitDecimals: 18,
          },
          {
            walletId: 'sol-usdc',
            assetIdentityKey: 'usdc|sol|mint',
            rateSourceKey: 'usdc|sol|mint',
            displayUnits: 0,
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
    expect(rowShell.memberWalletIdsKey).toBe(
      'eth-usdc|pol-usdc|sol-usdc',
    );
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
            displayUnits: 0,
            displayUnitDecimals: 8,
          },
          {
            walletId: 'doge-b',
            assetIdentityKey: 'doge',
            rateSourceKey: 'doge',
            displayUnits: 0,
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
            walletId: 'eth-usdc',
            assetIdentityKey: 'usdc|eth|0x1',
            rateSourceKey: 'usdc|eth|0x1',
            displayUnits: 1.5,
            displayUnitDecimals: 6,
            liveRate: 1.01,
          },
          {
            walletId: 'pol-usdc',
            assetIdentityKey: 'usdc|pol|0x2',
            rateSourceKey: 'usdc|pol|0x2',
            displayUnits: 2,
            displayUnitDecimals: 6,
            liveRate: 1.02,
          },
        ],
      }),
    );

    expect(rowShell.currentCryptoAmount).toBe('3.5');
    expect(rowShell.currentFiatValue).toBeCloseTo(3.555);
    expect(rowShell.canonicalUnitDecimals).toBe(6);
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
            displayUnits: 1,
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
            displayUnits: -1,
            displayUnitDecimals: 8,
          },
        ],
      }),
    ).toEqual({kind: 'invalid', reason: 'negativeDisplayUnits'});
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
            {ts: 2, rate: 15, percentChange: 50},
          ],
        },
      }),
    );

    expect(row.rateStart).toBe(10);
    expect(row.rateEnd).toBe(15);
    expect(row.ratePercent).toBe(50);
  });

  it('uses weighted group endpoints for collapsed row payloads', () => {
    const row = expectValidRowPayload(
      buildAssetGroupRowPayload({
        assetGroupId: 'usdc',
        series: portfolioSeries,
        rateSource: {
          kind: 'weightedGroupRateSeries',
          series: makeWeightedSeries(1, 1.2),
        },
      }),
    );

    expect(row.rateStart).toBe(1);
    expect(row.rateEnd).toBe(1.2);
    expect(row.ratePercent).toBeCloseTo(20);
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
