import type {
  Interval,
  MarketRatePoint,
  Series,
  ScopedPortfolioSlice,
  StoredRateInterval,
} from '../model';
import type {AssetGroupRowShellMemberInput} from './assetGroupRows';
import type {WeightedGroupRateConstituentInput} from './weightedGroupRates';
import {buildIntervalWindow} from '../__tests__/fixtures/intervalWindows';
import {
  buildPortfolioComputedState,
  stableWalletIdsKey,
  type AssetGroupComputedStateInput,
  type BuildPortfolioComputedStateArgs,
  type WalletComputedStateInput,
} from './portfolioState';

function expectValid(result: ReturnType<typeof buildPortfolioComputedState>) {
  expect(result.kind).toBe('valid');
  if (result.kind !== 'valid') {
    throw new Error(
      `Expected valid portfolio state, received ${result.reason}`,
    );
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
        percentChange: ((args.rateEnd - args.rateStart) / args.rateStart) * 100,
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

const totalSeries = makeSeries({
  interval: '1D',
  startTs: oneDayWindow.startTs,
  endTs: oneDayWindow.endTs,
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

function makeCachedScope(args: {
  walletIdsKey: string;
  walletIds: readonly string[];
  lastAccessedAt: number;
}): ScopedPortfolioSlice {
  return {
    walletIdsKey: args.walletIdsKey,
    walletIds: args.walletIds,
    fingerprint: `cached:${args.walletIdsKey}`,
    computedAtMs: 1,
    readiness: {
      empty: false,
      hasEverPublishedValidSeries: true,
      initialScopeReady: true,
      refreshing: false,
      invalidHistoryBlocked: false,
    },
    total: {},
    totalFingerprint: '',
    byAssetGroup: {},
    rowShells: [],
    orderedAssetGroupIdsForAssetList: [],
    invalidHistoryWalletIdsById: {},
    invalidHistoryAssetGroupIdsById: {},
    lastAccessedAt: args.lastAccessedAt,
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
    expect(state.byAssetGroup.usdc.fingerprint).toMatch(/^fnv1a:[0-9a-f]{8}$/);
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
    expect(
      state.readinessByScopeKey.persisted.hasEverPublishedValidSeries,
    ).toBe(true);
  });

  it('keeps partially invalid scopes ready without marking them fully blocked', () => {
    const state = expectValid(
      buildPortfolioComputedState(
        makeBaseArgs({
          populatedWalletIds: ['eth-usdc'],
          invalidHistoryWalletIds: ['btc-wallet'],
          scopes: [
            {
              scopeKey: 'mixed',
              walletIds: ['btc-wallet', 'eth-usdc'],
              hasPublishedValidSeriesThisPass: true,
            },
          ],
        }),
      ),
    );

    expect(state.readinessByScopeKey.mixed).toEqual({
      empty: false,
      hasEverPublishedValidSeries: true,
      initialScopeReady: true,
      refreshing: false,
      invalidHistoryBlocked: false,
    });
  });

  it('marks home readiness published when asset-group series exists without total', () => {
    const state = expectValid(
      buildPortfolioComputedState(
        makeBaseArgs({
          total: {},
        }),
      ),
    );

    expect(state.byAssetGroup.usdc.series['1D']?.points.length).toBeGreaterThan(
      0,
    );
    expect(state.readinessByScopeKey.home.hasEverPublishedValidSeries).toBe(
      true,
    );
  });

  it('changes total fingerprints when total series identity changes', () => {
    const base = expectValid(buildPortfolioComputedState(makeBaseArgs()));
    const changedSeries = expectValid(
      buildPortfolioComputedState(
        makeBaseArgs({
          total: {
            '1D': makeSeries({
              interval: '1D',
              startTs: 1,
              endTs: 2,
              fiatStart: 300,
              fiatEnd: 376,
              pnlChange: 76,
              pnlPercent: 25.333333333333336,
              fingerprint: 'total:1d:changed',
            }),
          },
        }),
      ),
    );
    const addedInterval = expectValid(
      buildPortfolioComputedState(
        makeBaseArgs({
          total: {
            '1D': totalSeries,
            ALL: makeSeries({
              interval: 'ALL',
              startTs: 10,
              endTs: 20,
              fiatStart: 100,
              fiatEnd: 200,
              pnlChange: 100,
              pnlPercent: 100,
              fingerprint: 'total:all',
              sampledFromStoredInterval: 'ALL',
            }),
          },
        }),
      ),
    );

    expect(changedSeries.totalFingerprint).not.toBe(base.totalFingerprint);
    expect(addedInterval.totalFingerprint).not.toBe(base.totalFingerprint);
  });

  it('builds scoped slices for arbitrary resolved wallet sets', () => {
    const walletIds = ['pol-usdc', 'eth-usdc'];
    const walletIdsKey = stableWalletIdsKey(walletIds);
    const state = expectValid(
      buildPortfolioComputedState(
        makeBaseArgs({
          scopedSlices: [
            {
              walletIds,
              walletIdsKey,
              total: {'1D': totalSeries},
              assetGroups: [makeUsdcAssetGroup()],
              lastAccessedAt: 999,
            },
          ],
        }),
      ),
    );

    const scoped = state.scopedByWalletSet[walletIdsKey];
    expect(scoped).toBeDefined();
    expect(scoped?.walletIds).toEqual(['eth-usdc', 'pol-usdc']);
    expect(scoped?.rowShells.map(row => row.assetGroupId)).toEqual(['usdc']);
    expect(scoped?.orderedAssetGroupIdsForAssetList).toEqual(['usdc']);
    expect(scoped?.readiness).toEqual({
      empty: false,
      hasEverPublishedValidSeries: true,
      initialScopeReady: true,
      refreshing: false,
      invalidHistoryBlocked: false,
    });
    expect(scoped?.byAssetGroup.usdc.rowToday).toEqual(
      scoped?.rowShells[0].rowToday,
    );
    expect(scoped?.totalFingerprint).toMatch(/^fnv1a:[0-9a-f]{8}$/);
    expect(scoped?.fingerprint).toMatch(/^fnv1a:[0-9a-f]{8}$/);
    expect(scoped?.lastAccessedAt).toBe(999);
  });

  it('marks scoped readiness published when asset-group series exists without total', () => {
    const walletIds = ['eth-usdc', 'pol-usdc'];
    const walletIdsKey = stableWalletIdsKey(walletIds);
    const state = expectValid(
      buildPortfolioComputedState(
        makeBaseArgs({
          scopedSlices: [
            {
              walletIds,
              walletIdsKey,
              assetGroups: [makeUsdcAssetGroup()],
            },
          ],
        }),
      ),
    );

    expect(
      state.scopedByWalletSet[walletIdsKey]?.readiness
        .hasEverPublishedValidSeries,
    ).toBe(true);
  });

  it('prunes deleted scoped entries, refreshes before LRU eviction, and protects current scopes', () => {
    const previousScopedByWalletSet = Object.fromEntries(
      Array.from({length: 9}, (_, index) => {
        const key = `scope-${index}`;
        return [
          key,
          makeCachedScope({
            walletIdsKey: key,
            walletIds:
              index === 1 ? ['deleted-wallet'] : [`cached-wallet-${index}`],
            lastAccessedAt: index,
          }),
        ];
      }),
    );
    const walletIds = ['eth-usdc', 'pol-usdc'];
    const walletIdsKey = stableWalletIdsKey(walletIds);
    const state = expectValid(
      buildPortfolioComputedState(
        makeBaseArgs({
          previousScopedByWalletSet,
          protectedScopedWalletIdsKeys: ['scope-0'],
          evictScopedWalletIds: ['deleted-wallet'],
          scopedSlices: [
            {
              walletIds,
              walletIdsKey,
              total: {'1D': totalSeries},
              assetGroups: [makeUsdcAssetGroup()],
              lastAccessedAt: 100,
            },
          ],
        }),
      ),
    );

    expect(Object.keys(state.scopedByWalletSet)).toHaveLength(8);
    expect(state.scopedByWalletSet['scope-0']).toBeDefined();
    expect(state.scopedByWalletSet['scope-1']).toBeUndefined();
    expect(state.scopedByWalletSet['scope-2']).toBeUndefined();
    expect(state.scopedByWalletSet[walletIdsKey]?.lastAccessedAt).toBe(100);
  });

  it('allows protected scoped entries to exceed the soft cache cap', () => {
    const previousScopedByWalletSet = Object.fromEntries(
      Array.from({length: 9}, (_, index) => {
        const key = `scope-${index}`;
        return [
          key,
          makeCachedScope({
            walletIdsKey: key,
            walletIds: [`cached-wallet-${index}`],
            lastAccessedAt: index,
          }),
        ];
      }),
    );
    const state = expectValid(
      buildPortfolioComputedState(
        makeBaseArgs({
          previousScopedByWalletSet,
          protectedScopedWalletIdsKeys: Object.keys(previousScopedByWalletSet),
        }),
      ),
    );

    expect(Object.keys(state.scopedByWalletSet)).toHaveLength(9);
  });

  it('rejects malformed top-level, status, and scope inputs', () => {
    expect(
      buildPortfolioComputedState(makeBaseArgs({workEpoch: Number.NaN})),
    ).toEqual({kind: 'invalid', reason: 'invalidWorkEpoch'});
    expect(buildPortfolioComputedState(makeBaseArgs({revision: -1}))).toEqual({
      kind: 'invalid',
      reason: 'invalidRevision',
    });
    expect(
      buildPortfolioComputedState(makeBaseArgs({quoteCurrency: ' EUR'})),
    ).toEqual({kind: 'invalid', reason: 'invalidQuoteCurrency'});
    expect(
      buildPortfolioComputedState(
        makeBaseArgs({computedAtMs: Number.POSITIVE_INFINITY}),
      ),
    ).toEqual({kind: 'invalid', reason: 'invalidComputedAtMs'});
    expect(
      buildPortfolioComputedState(makeBaseArgs({orderRevision: -1})),
    ).toEqual({kind: 'invalid', reason: 'invalidOrderRevision'});
    expect(
      buildPortfolioComputedState(
        makeBaseArgs({populatedWalletIds: [' btc-wallet']}),
      ),
    ).toEqual({kind: 'invalid', reason: 'invalidPopulatedWalletId'});
    expect(
      buildPortfolioComputedState(
        makeBaseArgs({missingRateSourceKeys: [' btc']}),
      ),
    ).toEqual({kind: 'invalid', reason: 'invalidStatusIdentity'});
    expect(
      buildPortfolioComputedState(
        makeBaseArgs({
          staleReasons: ['unknownReason' as any],
        }),
      ),
    ).toEqual({kind: 'invalid', reason: 'invalidStaleReason'});
    expect(
      buildPortfolioComputedState(
        makeBaseArgs({
          scopes: [{scopeKey: ' home', walletIds: ['btc-wallet']}],
        }),
      ),
    ).toEqual({kind: 'invalid', reason: 'invalidScopeKey'});
    expect(
      buildPortfolioComputedState(
        makeBaseArgs({
          scopes: [
            {scopeKey: 'home', walletIds: ['btc-wallet']},
            {scopeKey: 'home', walletIds: ['eth-usdc']},
          ],
        }),
      ),
    ).toEqual({kind: 'invalid', reason: 'duplicateScopeKey'});
    expect(
      buildPortfolioComputedState(
        makeBaseArgs({
          scopes: [{scopeKey: 'home', walletIds: [' btc-wallet']}],
        }),
      ),
    ).toEqual({kind: 'invalid', reason: 'invalidScopeWalletId'});
    expect(
      buildPortfolioComputedState(
        makeBaseArgs({
          scopes: [{scopeKey: 'home', walletIds: ['missing-wallet']}],
        }),
      ),
    ).toEqual({kind: 'invalid', reason: 'unknownScopeWalletId'});
    expect(
      buildPortfolioComputedState(
        makeBaseArgs({
          scopedSlices: [
            {
              walletIds: ['pol-usdc', 'eth-usdc'],
              walletIdsKey: 'pol-usdc|eth-usdc',
              assetGroups: [makeUsdcAssetGroup()],
            },
          ],
        }),
      ),
    ).toEqual({kind: 'invalid', reason: 'invalidScopedWalletIdsKey'});
    expect(
      buildPortfolioComputedState(
        makeBaseArgs({
          scopedSlices: [
            {
              walletIds: ['eth-usdc'],
              walletIdsKey: 'eth-usdc',
              assetGroups: [makeUsdcAssetGroup()],
            },
            {
              walletIds: ['eth-usdc'],
              walletIdsKey: 'eth-usdc',
              assetGroups: [makeUsdcAssetGroup()],
            },
          ],
        }),
      ),
    ).toEqual({kind: 'invalid', reason: 'duplicateScopedWalletIdsKey'});
    expect(
      buildPortfolioComputedState(
        makeBaseArgs({
          scopedSlices: [
            {
              walletIds: [' eth-usdc'],
              walletIdsKey: 'eth-usdc',
              assetGroups: [makeUsdcAssetGroup()],
            },
          ],
        }),
      ),
    ).toEqual({kind: 'invalid', reason: 'invalidScopedWalletIdsKey'});
    expect(
      buildPortfolioComputedState(
        makeBaseArgs({
          scopedSlices: [
            {
              walletIds: ['missing-wallet'],
              walletIdsKey: 'missing-wallet',
              assetGroups: [makeUsdcAssetGroup()],
            },
          ],
        }),
      ),
    ).toEqual({kind: 'invalid', reason: 'unknownScopedWalletId'});
    expect(
      buildPortfolioComputedState(
        makeBaseArgs({
          scopedSlices: [
            {
              walletIds: ['eth-usdc'],
              walletIdsKey: 'eth-usdc',
              assetGroups: [makeUsdcAssetGroup()],
              lastAccessedAt: Number.NaN,
            },
          ],
        }),
      ),
    ).toEqual({kind: 'invalid', reason: 'invalidScopedLastAccessedAt'});
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
