import type {
  Interval,
  MarketRatePoint,
  Series,
  StoredRateInterval,
} from '../model';
import type {AssetGroupRowShellMemberInput} from './assetGroupRows';
import type {WeightedGroupRateConstituentInput} from './weightedGroupRates';
import {
  buildPortfolioComputedState,
  type AssetGroupComputedStateInput,
  type BuildPortfolioComputedStateArgs,
  type WalletComputedStateInput,
} from './portfolioState';

function expectValid(
  result: ReturnType<typeof buildPortfolioComputedState>,
) {
  expect(result.kind).toBe('valid');
  if (result.kind !== 'valid') {
    throw new Error(`Expected valid portfolio state, received ${result.reason}`);
  }
  return result.state;
}

function makeSeries(args: {
  interval: Interval;
  startTs: number;
  endTs: number;
  fiatStart: number;
  fiatEnd: number;
  pnlChange: number;
  pnlPercent: number;
  fingerprint?: string;
  sampledFromStoredInterval?: StoredRateInterval;
}): Series {
  return {
    fingerprint:
      args.fingerprint ??
      [
        'series',
        args.interval,
        args.startTs,
        args.endTs,
        args.fiatStart,
        args.fiatEnd,
        args.pnlChange,
        args.pnlPercent,
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
    {ts: args.startTs, rate: args.rateStart, percentChange: 0},
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
        percentChange:
          ((args.rateEnd - args.rateStart) / args.rateStart) * 100,
      },
    ],
  };
}

function makeMember(args: {
  walletId: string;
  rateSourceKey: string;
  liveRate?: number;
  displayUnitsAtomic?: string;
}): AssetGroupRowShellMemberInput {
  return {
    walletId: args.walletId,
    assetIdentityKey: args.rateSourceKey,
    rateSourceKey: args.rateSourceKey,
    displayUnitsAtomic: args.displayUnitsAtomic ?? '100000000',
    displayUnitDecimals: 8,
    liveRate: args.liveRate ?? 2,
  };
}

function makeWallet(args: {
  walletId: string;
  assetGroupId: string;
  series?: WalletComputedStateInput['series'];
  rowToday?: WalletComputedStateInput['rowToday'];
  lastAccessedAt?: number;
}): WalletComputedStateInput {
  return {
    walletId: args.walletId,
    assetGroupId: args.assetGroupId,
    series: args.series ?? {},
    rowToday: args.rowToday,
    lastWrittenAt: 100,
    lastAccessedAt: args.lastAccessedAt ?? 200,
  };
}

const oneDaySeries = makeSeries({
  interval: '1D',
  startTs: 1,
  endTs: 2,
  fiatStart: 100,
  fiatEnd: 125,
  pnlChange: 25,
  pnlPercent: 25,
});

const allTimeSeries = makeSeries({
  interval: 'ALL',
  startTs: 10,
  endTs: 20,
  fiatStart: 50,
  fiatEnd: 150,
  pnlChange: 100,
  pnlPercent: 100,
  sampledFromStoredInterval: 'ALL',
});

const totalSeries = makeSeries({
  interval: '1D',
  startTs: 1,
  endTs: 2,
  fiatStart: 300,
  fiatEnd: 375,
  pnlChange: 75,
  pnlPercent: 25,
  fingerprint: 'total:1d',
});

function makeBtcAssetGroup(
  overrides: Partial<AssetGroupComputedStateInput> = {},
): AssetGroupComputedStateInput {
  return {
    assetGroupId: 'btc',
    displaySymbol: 'BTC',
    orderIndex: 2,
    series: {'1D': oneDaySeries, ALL: allTimeSeries},
    members: [makeMember({walletId: 'btc-wallet', rateSourceKey: 'btc'})],
    marketRatePointsByInterval: {
      '1D': makeMarketPoints({
        startTs: 1,
        endTs: 2,
        rateStart: 10,
        rateEnd: 15,
        percentChange: 49.5,
      }),
      ALL: makeMarketPoints({
        startTs: 10,
        endTs: 20,
        rateStart: 5,
        rateEnd: 20,
        percentChange: 250,
      }),
    },
    ...overrides,
  };
}

function makeUsdcAssetGroup(
  overrides: Partial<AssetGroupComputedStateInput> = {},
): AssetGroupComputedStateInput {
  return {
    assetGroupId: 'usdc',
    displaySymbol: 'USDC',
    orderIndex: 1,
    series: {'1D': oneDaySeries, ALL: allTimeSeries},
    members: [
      makeMember({walletId: 'eth-usdc', rateSourceKey: 'usdc|eth'}),
      makeMember({walletId: 'pol-usdc', rateSourceKey: 'usdc|pol'}),
    ],
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
          rateEnd: 1.2,
        }),
      ],
      ALL: [
        makeConstituent({
          rateSourceKey: 'usdc|eth',
          baselineUnits: 1,
          startTs: 10,
          endTs: 20,
          rateStart: 1,
          rateEnd: 2,
        }),
        makeConstituent({
          rateSourceKey: 'usdc|pol',
          baselineUnits: 1,
          startTs: 10,
          endTs: 20,
          rateStart: 1,
          rateEnd: 2,
        }),
      ],
    },
    ...overrides,
  };
}

function makeBaseArgs(
  overrides: Partial<BuildPortfolioComputedStateArgs> = {},
): BuildPortfolioComputedStateArgs {
  return {
    workEpoch: 3,
    revision: 7,
    quoteCurrency: 'EUR',
    computedAtMs: 1234,
    orderRevision: 11,
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
    assetGroups: [makeBtcAssetGroup(), makeUsdcAssetGroup()],
    total: {'1D': totalSeries},
    populatedWalletIds: ['pol-usdc', 'btc-wallet', 'eth-usdc'],
    ...overrides,
  };
}

describe('portfolio v2 computed state producer', () => {
  it('builds a full PortfolioState with status, readiness, order, and fingerprints', () => {
    const state = expectValid(buildPortfolioComputedState(makeBaseArgs()));

    expect(state).toMatchObject({
      schemaVersion: 1,
      workEpoch: 3,
      revision: 7,
      quoteCurrency: 'EUR',
      canonicalRateQuoteCurrency: 'USD',
      computedAtMs: 1234,
      orderRevision: 11,
      populatedWalletIdsKey: 'btc-wallet|eth-usdc|pol-usdc',
      invalidHistoryWalletIdsKey: '',
      orderedAssetGroupIdsForAssetList: ['usdc', 'btc'],
    });
    expect(state.populatedWalletIdsById).toEqual({
      'btc-wallet': true,
      'eth-usdc': true,
      'pol-usdc': true,
    });
    expect(state.readinessByScopeKey.home).toEqual({
      empty: false,
      hasEverPublishedValidSeries: true,
      initialScopeReady: true,
      refreshing: false,
      invalidHistoryBlocked: false,
    });
    expect(state.status).toEqual({
      invalidHistoryWalletIds: [],
      missingRateSourceKeys: [],
      staleReasons: [],
      retryScheduledWalletIds: [],
      retryScheduledRateSourceKeys: [],
    });
    expect(state.byWallet['btc-wallet']?.fingerprint).toMatch(
      /^fnv1a:[0-9a-f]{8}$/,
    );
    expect(state.byAssetGroup.usdc.fingerprint).toMatch(
      /^fnv1a:[0-9a-f]{8}$/,
    );
    expect(state.totalFingerprint).toMatch(/^fnv1a:[0-9a-f]{8}$/);
    expect(state.scopedByWalletSet).toEqual({});
  });

  it('changes fingerprints for rows, weighted rates, membership, shell values, and series', () => {
    const base = expectValid(buildPortfolioComputedState(makeBaseArgs()));
    const rowChanged = expectValid(
      buildPortfolioComputedState(
        makeBaseArgs({
          assetGroups: [
            makeBtcAssetGroup({
              marketRatePointsByInterval: {
                '1D': makeMarketPoints({
                  startTs: 1,
                  endTs: 2,
                  rateStart: 10,
                  rateEnd: 15,
                  percentChange: 51,
                }),
              },
            }),
            makeUsdcAssetGroup(),
          ],
        }),
      ),
    );
    const weightedChanged = expectValid(
      buildPortfolioComputedState(
        makeBaseArgs({
          assetGroups: [
            makeBtcAssetGroup(),
            makeUsdcAssetGroup({
              weightedConstituentsByInterval: {
                '1D': [
                  makeConstituent({
                    rateSourceKey: 'usdc|eth',
                    baselineUnits: 1,
                    startTs: 1,
                    endTs: 2,
                    rateStart: 1,
                    rateEnd: 1.3,
                  }),
                  makeConstituent({
                    rateSourceKey: 'usdc|pol',
                    baselineUnits: 1,
                    startTs: 1,
                    endTs: 2,
                    rateStart: 1,
                    rateEnd: 1.2,
                  }),
                ],
              },
            }),
          ],
        }),
      ),
    );
    const membershipChanged = expectValid(
      buildPortfolioComputedState(
        makeBaseArgs({
          wallets: [
            makeWallet({walletId: 'btc-wallet', assetGroupId: 'btc'}),
            makeWallet({walletId: 'eth-usdc', assetGroupId: 'usdc'}),
            makeWallet({walletId: 'avax-usdc', assetGroupId: 'usdc'}),
          ],
          assetGroups: [
            makeBtcAssetGroup(),
            makeUsdcAssetGroup({
              members: [
                makeMember({
                  walletId: 'eth-usdc',
                  rateSourceKey: 'usdc|eth',
                }),
                makeMember({
                  walletId: 'avax-usdc',
                  rateSourceKey: 'usdc|avax',
                }),
              ],
            }),
          ],
        }),
      ),
    );
    const shellValueChanged = expectValid(
      buildPortfolioComputedState(
        makeBaseArgs({
          assetGroups: [
            makeBtcAssetGroup(),
            makeUsdcAssetGroup({
              members: [
                makeMember({
                  walletId: 'eth-usdc',
                  rateSourceKey: 'usdc|eth',
                  liveRate: 3,
                }),
                makeMember({
                  walletId: 'pol-usdc',
                  rateSourceKey: 'usdc|pol',
                }),
              ],
            }),
          ],
        }),
      ),
    );
    const seriesChanged = expectValid(
      buildPortfolioComputedState(
        makeBaseArgs({
          wallets: [
            makeWallet({
              walletId: 'btc-wallet',
              assetGroupId: 'btc',
              series: {
                '1D': makeSeries({
                  interval: '1D',
                  startTs: 1,
                  endTs: 2,
                  fiatStart: 100,
                  fiatEnd: 126,
                  pnlChange: 26,
                  pnlPercent: 26,
                }),
              },
            }),
            makeWallet({walletId: 'eth-usdc', assetGroupId: 'usdc'}),
            makeWallet({walletId: 'pol-usdc', assetGroupId: 'usdc'}),
          ],
          assetGroups: [
            makeBtcAssetGroup({
              series: {
                '1D': makeSeries({
                  interval: '1D',
                  startTs: 1,
                  endTs: 2,
                  fiatStart: 100,
                  fiatEnd: 126,
                  pnlChange: 26,
                  pnlPercent: 26,
                }),
              },
            }),
            makeUsdcAssetGroup(),
          ],
        }),
      ),
    );
    const touchedOnly = expectValid(
      buildPortfolioComputedState(
        makeBaseArgs({
          wallets: [
            makeWallet({
              walletId: 'btc-wallet',
              assetGroupId: 'btc',
              series: {'1D': oneDaySeries},
              lastAccessedAt: 999,
            }),
            makeWallet({walletId: 'eth-usdc', assetGroupId: 'usdc'}),
            makeWallet({walletId: 'pol-usdc', assetGroupId: 'usdc'}),
          ],
        }),
      ),
    );

    expect(rowChanged.byAssetGroup.btc.fingerprint).not.toBe(
      base.byAssetGroup.btc.fingerprint,
    );
    expect(weightedChanged.byAssetGroup.usdc.fingerprint).not.toBe(
      base.byAssetGroup.usdc.fingerprint,
    );
    expect(membershipChanged.byAssetGroup.usdc.fingerprint).not.toBe(
      base.byAssetGroup.usdc.fingerprint,
    );
    expect(shellValueChanged.byAssetGroup.usdc.fingerprint).not.toBe(
      base.byAssetGroup.usdc.fingerprint,
    );
    expect(seriesChanged.byAssetGroup.btc.fingerprint).not.toBe(
      base.byAssetGroup.btc.fingerprint,
    );
    expect(seriesChanged.byWallet['btc-wallet']?.fingerprint).not.toBe(
      base.byWallet['btc-wallet']?.fingerprint,
    );
    expect(touchedOnly.byWallet['btc-wallet']?.lastAccessedAt).toBe(999);
    expect(touchedOnly.byWallet['btc-wallet']?.fingerprint).toBe(
      base.byWallet['btc-wallet']?.fingerprint,
    );
  });

  it('aggregates minimal status and scope readiness', () => {
    const state = expectValid(
      buildPortfolioComputedState(
        makeBaseArgs({
          wallets: [makeWallet({walletId: 'btc-wallet', assetGroupId: 'btc'})],
          assetGroups: [makeBtcAssetGroup()],
          total: {},
          populatedWalletIds: [],
          invalidHistoryWalletIds: ['btc-wallet'],
          missingRateSourceKeys: ['usdc|eth', 'btc'],
          retryScheduledWalletIds: ['btc-wallet'],
          retryScheduledRateSourceKeys: ['usdc|pol'],
          staleReasons: ['balanceMismatch'],
          previousReadinessByScopeKey: {
            persisted: {
              empty: false,
              hasEverPublishedValidSeries: true,
              initialScopeReady: true,
              refreshing: false,
              invalidHistoryBlocked: false,
            },
          },
          scopes: [
            {
              scopeKey: 'home',
              walletIds: ['btc-wallet'],
              refreshing: true,
              hasPublishedValidSeriesThisPass: false,
            },
            {scopeKey: 'empty', walletIds: []},
            {
              scopeKey: 'persisted',
              walletIds: ['btc-wallet'],
              hasPublishedValidSeriesThisPass: false,
            },
          ],
        }),
      ),
    );

    expect(state.status).toEqual({
      invalidHistoryWalletIds: ['btc-wallet'],
      missingRateSourceKeys: ['btc', 'usdc|eth'],
      staleReasons: [
        'balanceMismatch',
        'missingHistoricalRate',
        'invalidHistory',
        'populateRetryPending',
        'rateFetchRetryPending',
      ],
      retryScheduledWalletIds: ['btc-wallet'],
      retryScheduledRateSourceKeys: ['usdc|pol'],
    });
    expect(state.invalidHistoryWalletIdsKey).toBe('btc-wallet');
    expect(state.invalidHistoryWalletIdsById).toEqual({'btc-wallet': true});
    expect(state.readinessByScopeKey.home).toEqual({
      empty: false,
      hasEverPublishedValidSeries: false,
      initialScopeReady: true,
      refreshing: true,
      invalidHistoryBlocked: true,
    });
    expect(state.readinessByScopeKey.empty).toEqual({
      empty: true,
      hasEverPublishedValidSeries: false,
      initialScopeReady: false,
      refreshing: false,
      invalidHistoryBlocked: false,
    });
    expect(state.readinessByScopeKey.persisted.hasEverPublishedValidSeries).toBe(
      true,
    );
  });

  it('propagates structural assembly failures without publishing state', () => {
    expect(
      buildPortfolioComputedState(
        makeBaseArgs({
          wallets: [makeWallet({walletId: 'btc-wallet', assetGroupId: 'btc'})],
          assetGroups: [
            makeBtcAssetGroup({
              members: [
                makeMember({walletId: 'missing-wallet', rateSourceKey: 'btc'}),
              ],
            }),
          ],
        }),
      ),
    ).toEqual({kind: 'invalid', reason: 'missingAssetGroupMember'});
  });
});
