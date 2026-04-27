import type {
  Interval,
  MarketRatePoint,
  Series,
  StoredRateInterval,
} from '../model';
import type {AssetGroupRowShellMemberInput} from './assetGroupRows';
import type {WeightedGroupRateConstituentInput} from './weightedGroupRates';
import {buildIntervalWindow} from '../__tests__/fixtures/intervalWindows';
import {
  buildRecomputeStateSlices,
  type AssetGroupSliceAssemblyInput,
  type WalletSliceAssemblyInput,
} from './recomputeState';

function expectValid(result: ReturnType<typeof buildRecomputeStateSlices>) {
  expect(result.kind).toBe('valid');
  if (result.kind !== 'valid') {
    throw new Error(
      `Expected valid recompute slices, received ${result.reason}`,
    );
  }
  return result;
}

function makeSeries(args: {
  interval: Interval;
  startTs: number;
  endTs: number;
  fiatStart: number;
  fiatEnd: number;
  pnlChange: number;
  pnlPercent: number;
  sampledFromStoredInterval?: StoredRateInterval;
}): Series {
  return {
    fingerprint: [
      'series',
      args.interval,
      args.startTs,
      args.endTs,
      args.fiatStart,
      args.fiatEnd,
    ].join(':'),
    interval: args.interval,
    windowStartTs: args.startTs,
    windowEndTs: args.endTs,
    sampledFromStoredInterval: args.sampledFromStoredInterval ?? '1D',
    finalPointSource: 'historicalRate',
    points: [
      {
        ts: args.startTs,
        fiatBalance: args.fiatStart,
        remainingUnrealizedPnlFiat: 0,
        pnlChange: 0,
        pnlPercent: 0,
      },
      {
        ts: args.endTs,
        fiatBalance: args.fiatEnd,
        remainingUnrealizedPnlFiat: args.pnlChange,
        pnlChange: args.pnlChange,
        pnlPercent: args.pnlPercent,
      },
    ],
  };
}

function makeMarketPoints(args: {
  startTs: number;
  endTs: number;
  rateStart: number;
  rateEnd: number;
  percentChange: number;
}): readonly MarketRatePoint[] {
  return [
    {
      ts: args.startTs,
      rate: args.rateStart,
      percentChange: 0,
    },
    {
      ts: args.endTs,
      rate: args.rateEnd,
      percentChange: args.percentChange,
    },
  ];
}

function makeConstituent(args: {
  rateSourceKey: string;
  baselineUnits: number;
  startTs: number;
  endTs: number;
  rateStart: number;
  rateEnd: number;
}): WeightedGroupRateConstituentInput {
  return {
    rateSourceKey: args.rateSourceKey,
    baselineUnits: args.baselineUnits,
    points: [
      {ts: args.startTs, rate: args.rateStart, percentChange: 0},
      {
        ts: args.endTs,
        rate: args.rateEnd,
        percentChange: ((args.rateEnd - args.rateStart) / args.rateStart) * 100,
      },
    ],
  };
}

function makeMember(args: {
  walletId: string;
  rateSourceKey: string;
  displayUnitsAtomic?: string;
  displayUnitDecimals?: number;
}): AssetGroupRowShellMemberInput {
  return {
    walletId: args.walletId,
    assetIdentityKey: args.rateSourceKey,
    rateSourceKey: args.rateSourceKey,
    displayUnitsAtomic: args.displayUnitsAtomic ?? '100000000',
    displayUnitDecimals: args.displayUnitDecimals ?? 8,
    liveRate: 2,
  };
}

function makeWallet(args: {
  walletId: string;
  assetGroupId: string;
  series?: WalletSliceAssemblyInput['series'];
}): WalletSliceAssemblyInput {
  return {
    walletId: args.walletId,
    assetGroupId: args.assetGroupId,
    fingerprint: `wallet:${args.walletId}`,
    series: args.series ?? {},
    lastWrittenAt: 10,
    lastAccessedAt: 20,
  };
}

const oneDayWindow = buildIntervalWindow({startTs: 1, endTs: 2});
const allTimeWindow = buildIntervalWindow({startTs: 10, endTs: 20});

const oneDaySeries = makeSeries({
  interval: '1D',
  startTs: oneDayWindow.startTs,
  endTs: oneDayWindow.endTs,
  fiatStart: 100,
  fiatEnd: 125,
  pnlChange: 25,
  pnlPercent: 25,
});

const allTimeSeries = makeSeries({
  interval: 'ALL',
  startTs: allTimeWindow.startTs,
  endTs: allTimeWindow.endTs,
  fiatStart: 50,
  fiatEnd: 150,
  pnlChange: 100,
  pnlPercent: 100,
  sampledFromStoredInterval: 'ALL',
});

function makeSingleSourceAssetGroup(
  overrides: Partial<AssetGroupSliceAssemblyInput> = {},
): AssetGroupSliceAssemblyInput {
  return {
    assetGroupId: 'btc',
    fingerprint: 'asset-group:btc',
    displaySymbol: 'BTC',
    orderIndex: 2,
    series: {
      '1D': oneDaySeries,
      ALL: allTimeSeries,
    },
    members: [makeMember({walletId: 'btc-wallet', rateSourceKey: 'btc'})],
    marketRatePointsByInterval: {
      '1D': makeMarketPoints({
        startTs: oneDayWindow.startTs,
        endTs: oneDayWindow.endTs,
        rateStart: 10,
        rateEnd: 15,
        percentChange: 49.5,
      }),
      ALL: makeMarketPoints({
        startTs: allTimeWindow.startTs,
        endTs: allTimeWindow.endTs,
        rateStart: 5,
        rateEnd: 20,
        percentChange: 250,
      }),
    },
    ...overrides,
  };
}

function makeCollapsedAssetGroup(
  overrides: Partial<AssetGroupSliceAssemblyInput> = {},
): AssetGroupSliceAssemblyInput {
  return {
    assetGroupId: 'usdc',
    fingerprint: 'asset-group:usdc',
    displaySymbol: 'USDC',
    orderIndex: 1,
    series: {
      '1D': oneDaySeries,
      ALL: allTimeSeries,
    },
    members: [
      makeMember({walletId: 'eth-usdc', rateSourceKey: 'usdc|eth'}),
      makeMember({walletId: 'pol-usdc', rateSourceKey: 'usdc|pol'}),
    ],
    marketRatePointsByInterval: {
      '1D': makeMarketPoints({
        startTs: oneDayWindow.startTs,
        endTs: oneDayWindow.endTs,
        rateStart: 1,
        rateEnd: 9,
        percentChange: 999,
      }),
      ALL: makeMarketPoints({
        startTs: allTimeWindow.startTs,
        endTs: allTimeWindow.endTs,
        rateStart: 1,
        rateEnd: 9,
        percentChange: 999,
      }),
    },
    weightedConstituentsByInterval: {
      '1D': [
        makeConstituent({
          rateSourceKey: 'usdc|eth',
          baselineUnits: 1,
          startTs: oneDayWindow.startTs,
          endTs: oneDayWindow.endTs,
          rateStart: 1,
          rateEnd: 1.2,
        }),
        makeConstituent({
          rateSourceKey: 'usdc|pol',
          baselineUnits: 1,
          startTs: oneDayWindow.startTs,
          endTs: oneDayWindow.endTs,
          rateStart: 1,
          rateEnd: 1.2,
        }),
      ],
      ALL: [
        makeConstituent({
          rateSourceKey: 'usdc|eth',
          baselineUnits: 1,
          startTs: allTimeWindow.startTs,
          endTs: allTimeWindow.endTs,
          rateStart: 1,
          rateEnd: 2,
        }),
        makeConstituent({
          rateSourceKey: 'usdc|pol',
          baselineUnits: 1,
          startTs: allTimeWindow.startTs,
          endTs: allTimeWindow.endTs,
          rateStart: 1,
          rateEnd: 2,
        }),
      ],
    },
    ...overrides,
  };
}

describe('portfolio v2 recompute state assembly adapter', () => {
  it('assembles single-source rows from market rates without weighted series', () => {
    const result = expectValid(
      buildRecomputeStateSlices({
        quoteCurrency: 'USD',
        wallets: [
          makeWallet({
            walletId: 'btc-wallet',
            assetGroupId: 'btc',
            series: {'1D': oneDaySeries, ALL: allTimeSeries},
          }),
        ],
        assetGroups: [makeSingleSourceAssetGroup()],
      }),
    );

    const btc = result.byAssetGroup.btc;
    expect(btc.weightedGroupRateSeries).toBeUndefined();
    expect(btc.memberWalletIds).toEqual(['btc-wallet']);
    expect(btc.memberWalletIdsKey).toBe('btc-wallet');
    expect(btc.rowToday).toMatchObject({
      assetGroupId: 'btc',
      fiatStart: 100,
      fiatEnd: 125,
      pnlChange: 25,
      pnlPercent: 25,
      rateStart: 10,
      rateEnd: 15,
      ratePercent: 49.5,
    });
    expect(btc.rowAllTime).toMatchObject({
      fiatStart: 50,
      fiatEnd: 150,
      pnlChange: 100,
      pnlPercent: 100,
      rateStart: 5,
      rateEnd: 20,
      ratePercent: 250,
    });
    expect(result.rowShells).toHaveLength(1);
    expect(result.rowShells[0]).toMatchObject({
      assetGroupId: 'btc',
      readyToday: true,
      readyAllTime: true,
      rowToday: btc.rowToday,
      rowAllTime: btc.rowAllTime,
    });
  });

  it('ignores accidental weighted inputs for single-source groups', () => {
    const result = expectValid(
      buildRecomputeStateSlices({
        quoteCurrency: 'USD',
        wallets: [
          makeWallet({
            walletId: 'btc-wallet',
            assetGroupId: 'btc',
            series: {'1D': oneDaySeries},
          }),
        ],
        assetGroups: [
          makeSingleSourceAssetGroup({
            weightedConstituentsByInterval: {
              '1D': [
                makeConstituent({
                  rateSourceKey: 'btc',
                  baselineUnits: 1,
                  startTs: 1,
                  endTs: 2,
                  rateStart: 10,
                  rateEnd: 12,
                }),
              ],
            },
          }),
        ],
      }),
    );

    expect(result.byAssetGroup.btc.weightedGroupRateSeries).toBeUndefined();
    expect(result.byAssetGroup.btc.rowToday?.ratePercent).toBe(49.5);
  });

  it('assembles collapsed rows from weighted group rates and sorts row shells', () => {
    const result = expectValid(
      buildRecomputeStateSlices({
        quoteCurrency: 'USD',
        wallets: [
          makeWallet({
            walletId: 'btc-wallet',
            assetGroupId: 'btc',
            series: {'1D': oneDaySeries},
          }),
          makeWallet({
            walletId: 'eth-usdc',
            assetGroupId: 'usdc',
            series: {'1D': oneDaySeries},
          }),
          makeWallet({
            walletId: 'pol-usdc',
            assetGroupId: 'usdc',
            series: {'1D': oneDaySeries},
          }),
        ],
        assetGroups: [makeSingleSourceAssetGroup(), makeCollapsedAssetGroup()],
      }),
    );

    const usdc = result.byAssetGroup.usdc;
    expect(result.rowShells.map(row => row.assetGroupId)).toEqual([
      'usdc',
      'btc',
    ]);
    expect(usdc.memberWalletIds).toEqual(['eth-usdc', 'pol-usdc']);
    expect(usdc.memberWalletIdsKey).toBe('eth-usdc|pol-usdc');
    expect(usdc.weightedGroupRateSeries?.['1D']).toMatchObject({
      availability: 'valid',
      memberRateSourceKeys: ['usdc|eth', 'usdc|pol'],
    });
    expect(usdc.rowToday).toMatchObject({
      assetGroupId: 'usdc',
      fiatStart: 100,
      fiatEnd: 125,
      pnlChange: 25,
      pnlPercent: 25,
      rateStart: 1,
      rateEnd: 1.2,
    });
    expect(usdc.rowToday?.ratePercent).toBeCloseTo(20);
    expect(usdc.rowToday?.ratePercent).not.toBe(999);
    expect(usdc.rowAllTime?.ratePercent).toBe(100);
    expect(result.rowShells[0].rowToday).toEqual(usdc.rowToday);
    expect(result.rowShells[0].rowAllTime).toEqual(usdc.rowAllTime);
  });

  it('uses asset group id as a deterministic row-shell tie breaker', () => {
    const result = expectValid(
      buildRecomputeStateSlices({
        quoteCurrency: 'USD',
        wallets: [
          makeWallet({walletId: 'btc-wallet', assetGroupId: 'btc'}),
          makeWallet({walletId: 'eth-usdc', assetGroupId: 'usdc'}),
          makeWallet({walletId: 'pol-usdc', assetGroupId: 'usdc'}),
        ],
        assetGroups: [
          makeCollapsedAssetGroup({orderIndex: 1}),
          makeSingleSourceAssetGroup({orderIndex: 1}),
        ],
      }),
    );

    expect(result.rowShells.map(row => row.assetGroupId)).toEqual([
      'btc',
      'usdc',
    ]);
  });

  it('normalizes display symbols without loosening asset-group identity', () => {
    const result = expectValid(
      buildRecomputeStateSlices({
        quoteCurrency: 'USD',
        wallets: [makeWallet({walletId: 'btc-wallet', assetGroupId: 'btc'})],
        assetGroups: [
          makeSingleSourceAssetGroup({
            displaySymbol: '  Bitcoin Cash  ',
          }),
        ],
      }),
    );

    expect(result.rowShells[0].displaySymbol).toBe('Bitcoin Cash');
    expect(
      buildRecomputeStateSlices({
        quoteCurrency: 'USD',
        wallets: [makeWallet({walletId: 'btc-wallet', assetGroupId: 'btc'})],
        assetGroups: [
          makeSingleSourceAssetGroup({
            assetGroupId: ' btc',
            displaySymbol: '  Bitcoin Cash  ',
          }),
        ],
      }),
    ).toEqual({kind: 'invalid', reason: 'invalidAssetGroupIdentity'});
    expect(
      buildRecomputeStateSlices({
        quoteCurrency: 'USD',
        wallets: [makeWallet({walletId: 'btc-wallet', assetGroupId: 'btc'})],
        assetGroups: [
          makeSingleSourceAssetGroup({
            displaySymbol: '   ',
          }),
        ],
      }),
    ).toEqual({kind: 'invalid', reason: 'invalidAssetGroupIdentity'});
  });

  it('does not fall back to market rows for collapsed groups without weighted constituents', () => {
    const result = expectValid(
      buildRecomputeStateSlices({
        quoteCurrency: 'USD',
        wallets: [
          makeWallet({walletId: 'eth-usdc', assetGroupId: 'usdc'}),
          makeWallet({walletId: 'pol-usdc', assetGroupId: 'usdc'}),
        ],
        assetGroups: [
          makeCollapsedAssetGroup({
            weightedConstituentsByInterval: undefined,
          }),
        ],
      }),
    );

    expect(result.byAssetGroup.usdc.weightedGroupRateSeries).toBeUndefined();
    expect(result.byAssetGroup.usdc.rowToday).toBeUndefined();
    expect(result.rowShells[0]).toMatchObject({
      assetGroupId: 'usdc',
      readyToday: false,
      readyAllTime: false,
    });
  });

  it('publishes unavailable weighted series without row payloads', () => {
    const result = expectValid(
      buildRecomputeStateSlices({
        quoteCurrency: 'USD',
        wallets: [
          makeWallet({walletId: 'eth-usdc', assetGroupId: 'usdc'}),
          makeWallet({walletId: 'pol-usdc', assetGroupId: 'usdc'}),
        ],
        assetGroups: [
          makeCollapsedAssetGroup({
            weightedConstituentsByInterval: {
              '1D': [
                makeConstituent({
                  rateSourceKey: 'usdc|eth',
                  baselineUnits: 1,
                  startTs: 1,
                  endTs: 2,
                  rateStart: 1,
                  rateEnd: 1.2,
                }),
                makeConstituent({
                  rateSourceKey: 'usdc|pol',
                  baselineUnits: 1,
                  startTs: 1,
                  endTs: 2,
                  rateStart: 1,
                  rateEnd: 0,
                }),
              ],
            },
          }),
        ],
      }),
    );

    expect(
      result.byAssetGroup.usdc.weightedGroupRateSeries?.['1D'],
    ).toMatchObject({
      availability: 'unavailable',
      unavailableReason: 'missingConstituentRate',
      points: [],
    });
    expect(result.byAssetGroup.usdc.rowToday).toBeUndefined();
    expect(result.rowShells[0]).toMatchObject({
      assetGroupId: 'usdc',
      readyToday: false,
    });
  });

  it('rejects duplicate identities, missing members, mismatches, and invalid row shells', () => {
    const wallet = makeWallet({walletId: 'btc-wallet', assetGroupId: 'btc'});
    expect(
      buildRecomputeStateSlices({
        quoteCurrency: 'USD',
        wallets: [makeWallet({walletId: ' btc-wallet', assetGroupId: 'btc'})],
        assetGroups: [],
      }),
    ).toEqual({kind: 'invalid', reason: 'invalidWalletIdentity'});

    expect(
      buildRecomputeStateSlices({
        quoteCurrency: 'USD',
        wallets: [wallet, wallet],
        assetGroups: [],
      }),
    ).toEqual({kind: 'invalid', reason: 'duplicateWalletId'});

    const group = makeSingleSourceAssetGroup();
    expect(
      buildRecomputeStateSlices({
        quoteCurrency: 'USD',
        wallets: [wallet],
        assetGroups: [group, group],
      }),
    ).toEqual({kind: 'invalid', reason: 'duplicateAssetGroupId'});

    expect(
      buildRecomputeStateSlices({
        quoteCurrency: 'USD',
        wallets: [wallet],
        assetGroups: [makeSingleSourceAssetGroup({assetGroupId: ' btc'})],
      }),
    ).toEqual({kind: 'invalid', reason: 'invalidAssetGroupIdentity'});

    expect(
      buildRecomputeStateSlices({
        quoteCurrency: 'USD',
        wallets: [wallet],
        assetGroups: [
          makeSingleSourceAssetGroup({
            members: [makeMember({walletId: 'missing', rateSourceKey: 'btc'})],
          }),
        ],
      }),
    ).toEqual({kind: 'invalid', reason: 'missingAssetGroupMember'});

    expect(
      buildRecomputeStateSlices({
        quoteCurrency: 'USD',
        wallets: [makeWallet({walletId: 'btc-wallet', assetGroupId: 'btc'})],
        assetGroups: [
          makeCollapsedAssetGroup({
            members: [
              makeMember({
                walletId: 'btc-wallet',
                rateSourceKey: 'usdc|eth',
              }),
            ],
          }),
        ],
      }),
    ).toEqual({kind: 'invalid', reason: 'assetGroupMemberMismatch'});

    expect(
      buildRecomputeStateSlices({
        quoteCurrency: 'USD',
        wallets: [wallet],
        assetGroups: [
          makeSingleSourceAssetGroup({
            members: [
              makeMember({walletId: 'btc-wallet', rateSourceKey: 'btc'}),
              makeMember({walletId: 'btc-wallet', rateSourceKey: 'btc'}),
            ],
          }),
        ],
      }),
    ).toEqual({kind: 'invalid', reason: 'invalidRowShell'});
  });
});
