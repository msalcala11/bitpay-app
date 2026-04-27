import {createWorkletRuntime} from 'react-native-worklets';

import {
  MANIFEST_KEY,
  POPULATE_QUEUE_KEY,
  PORTFOLIO_CACHE_INVALID_KEY,
  PORTFOLIO_V2_FLAG_KEY,
  PORTFOLIO_WORK_EPOCH_KEY,
} from './constants';

class FakeMmkv {
  readonly data = new Map<string, string>();

  contains(key: string): boolean {
    return this.data.has(key);
  }

  delete(key: string): void {
    this.data.delete(key);
  }

  getAllKeys(): string[] {
    return Array.from(this.data.keys()).sort();
  }

  getString(key: string): string | undefined {
    return this.data.get(key);
  }

  set(key: string, value: string): void {
    this.data.set(key, value);
  }
}

const mockMmkv = new FakeMmkv();
const mockInitializePopulateRuntimeGlobals = jest.fn();
const mockInitializeRateFetchRuntimeGlobals = jest.fn();

jest.mock('react-native-reanimated', () => ({
  makeMutable: (initial: unknown) => ({
    value: initial,
    get: jest.fn(() => initial),
    set: jest.fn(),
    addListener: jest.fn(),
    removeListener: jest.fn(),
    modify: jest.fn(),
  }),
}));

jest.mock('react-native-worklets', () => ({
  createWorkletRuntime: jest.fn((config: {name: string}) => ({
    name: config.name,
  })),
  runOnRuntimeAsync: jest.fn(() => Promise.resolve()),
}));

jest.mock('../adapters/rn/workletRuntimeShared', () => ({
  initializePortfolioPopulateRuntimeGlobals: () =>
    mockInitializePopulateRuntimeGlobals(),
  initializePortfolioRateFetchRuntimeGlobals: () =>
    mockInitializeRateFetchRuntimeGlobals(),
}));

jest.mock('../adapters/rn/workletMmkvBridge', () => ({
  __esModule: true,
  PORTFOLIO_WORKLET_MMKV_STORAGE_ID: 'bitpay.portfolio.engine',
  PORTFOLIO_WORKLET_MMKV_REGISTRY_KEY:
    '__bitpay.portfolio.engine.registry.v1__',
  getPortfolioMmkvStorageOnRN: () => mockMmkv,
  createPortfolioMmkvStorageOnRN: () => mockMmkv,
  getNativeMmkvStorageBridgeOnRN: () => mockMmkv,
  getPortfolioMmkvNativeStorageOnRN: () => mockMmkv,
}));

import {
  clearRecordedPortfolioV2MetricsForTesting,
  getRecordedPortfolioV2MetricsForTesting,
} from './metrics';
import {
  clearPortfolioRuntimeLogPayloadsForTesting,
  getPortfolioRuntimeLogPayloadsForTesting,
  logPortfolioRuntimeError,
} from './logPortfolioRuntimeError';
import {
  clearPortfolioMmkvKeysForReset,
  deletePortfolioMmkvKey,
  getPortfolioKvStore,
  resetPortfolioKvStoreForTesting,
  writePortfolioMmkvString,
} from './kvStore';
import {EMPTY_PORTFOLIO_STATE} from './model';
import {
  bumpPortfolioWorkEpoch,
  emptyPortfolioStateForEpoch,
  getCurrentPortfolioWorkEpoch,
  populateCancelFlag,
  populateLoopRunning,
  populateProgressTick,
  populateRetryTick,
  publishPortfolioState,
  resetSharedPortfolioStateForDebugClear,
  sharedPortfolioState,
  subscribeToPortfolioPublishedState,
} from './sharedState';
import {emptyManifest, loadManifest, saveManifest} from './manifest';
import {emptyQueue, loadQueue, saveQueue} from './populate/queue';
import {startPopulate, startPopulateForTesting} from './populate/api';
import {
  getPortfolioComputeRuntime,
  getPortfolioPopulateRuntime,
  getPortfolioRateFetchRuntime,
  initializePortfolioRuntimeGlobals,
  resetPortfolioV2RuntimesForTesting,
} from './runtimes';
import {
  buildBaseRecomputeInputsAtFireTime,
  getReduxStateForPortfolioV2,
  initPortfolioReduxAccess,
  isPortfolioReduxAccessInitialized,
  resetPortfolioReduxAccessForTesting,
} from './reduxAccess';
import {
  normalizeExchangeRateRouteParams,
  serializeExchangeRateRoute,
} from './routes/exchangeRateRoute';

beforeEach(() => {
  mockMmkv.data.clear();
  mockInitializePopulateRuntimeGlobals.mockClear();
  mockInitializeRateFetchRuntimeGlobals.mockClear();
  (createWorkletRuntime as jest.Mock).mockClear();
  resetPortfolioKvStoreForTesting();
  resetPortfolioV2RuntimesForTesting();
  resetPortfolioReduxAccessForTesting();
  clearRecordedPortfolioV2MetricsForTesting();
  clearPortfolioRuntimeLogPayloadsForTesting();
  sharedPortfolioState.value = EMPTY_PORTFOLIO_STATE;
  populateCancelFlag.value = false;
  populateLoopRunning.value = false;
  populateProgressTick.value = 0;
  populateRetryTick.value = 0;
});

describe('portfolio v2 Phase 1 scaffolding', () => {
  it('creates epoch-correct empty states and publishes only with a matching epoch', () => {
    mockMmkv.set(PORTFOLIO_WORK_EPOCH_KEY, '3');
    const state = emptyPortfolioStateForEpoch({
      workEpoch: 3,
      quoteCurrency: 'EUR',
      computedAtMs: 123,
    });

    expect(state.workEpoch).toBe(3);
    expect(state.quoteCurrency).toBe('EUR');
    expect(state.computedAtMs).toBe(123);

    publishPortfolioState({
      canonical: {...state, revision: 4},
      reason: 'warmPublish',
      startEpoch: 2,
    });
    expect(sharedPortfolioState.value.revision).toBe(0);
    expect(getRecordedPortfolioV2MetricsForTesting()).toHaveLength(0);
    expect(getPortfolioRuntimeLogPayloadsForTesting()).toEqual([
      expect.objectContaining({
        tag: 'staleWorkEpoch',
        startEpoch: 2,
        currentEpoch: 3,
      }),
    ]);

    publishPortfolioState({
      canonical: {...state, revision: 5},
      reason: 'warmPublish',
      startEpoch: 3,
    });
    expect(sharedPortfolioState.value.revision).toBe(5);
    expect(getRecordedPortfolioV2MetricsForTesting()).toEqual([
      expect.objectContaining({
        kind: 'publish',
        reason: 'warmPublish',
        revision: 5,
      }),
    ]);
  });

  it('notifies portfolio state subscribers after successful publishes only', () => {
    mockMmkv.set(PORTFOLIO_WORK_EPOCH_KEY, '4');
    const listener = jest.fn();
    const unsubscribe = subscribeToPortfolioPublishedState(listener);

    publishPortfolioState({
      canonical: emptyPortfolioStateForEpoch({
        workEpoch: 4,
        quoteCurrency: 'USD',
        computedAtMs: 1,
      }),
      reason: 'warmPublish',
      startEpoch: 3,
    });
    expect(listener).not.toHaveBeenCalled();

    publishPortfolioState({
      canonical: {
        ...emptyPortfolioStateForEpoch({
          workEpoch: 4,
          quoteCurrency: 'USD',
          computedAtMs: 2,
        }),
        revision: 1,
      },
      reason: 'warmPublish',
      startEpoch: 4,
    });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    publishPortfolioState({
      canonical: {
        ...emptyPortfolioStateForEpoch({
          workEpoch: 4,
          quoteCurrency: 'USD',
          computedAtMs: 3,
        }),
        revision: 2,
      },
      reason: 'warmPublish',
      startEpoch: 4,
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('bumps and persists the work epoch through the MMKV mutation helper', () => {
    expect(getCurrentPortfolioWorkEpoch()).toBe(0);
    expect(bumpPortfolioWorkEpoch('resetStart')).toBe(1);
    expect(mockMmkv.getString(PORTFOLIO_WORK_EPOCH_KEY)).toBe('1');
    expect(getRecordedPortfolioV2MetricsForTesting()).toEqual([
      expect.objectContaining({
        kind: 'mmkvWrite',
        reason: 'workEpoch',
        keyPrefixFamily: 'portfolio:v2',
      }),
    ]);
  });

  it('resets published state through publish helper and only resets coordination ticks directly', () => {
    mockMmkv.set(PORTFOLIO_WORK_EPOCH_KEY, '7');
    populateProgressTick.value = 4;
    populateRetryTick.value = 5;

    resetSharedPortfolioStateForDebugClear({
      publishEpoch: 7,
      quoteCurrency: 'GBP',
      computedAtMs: 99,
    });

    expect(sharedPortfolioState.value.workEpoch).toBe(7);
    expect(sharedPortfolioState.value.quoteCurrency).toBe('GBP');
    expect(populateProgressTick.value).toBe(0);
    expect(populateRetryTick.value).toBe(0);
    expect(getRecordedPortfolioV2MetricsForTesting()).toEqual([
      expect.objectContaining({
        kind: 'publish',
        reason: 'debugClear',
      }),
    ]);
  });

  it('saves and validates manifest and queue JSON', () => {
    const manifest = emptyManifest(100);
    saveManifest(manifest);
    expect(loadManifest()).toEqual(manifest);

    mockMmkv.set(MANIFEST_KEY, JSON.stringify({schemaVersion: 999}));
    expect(loadManifest()).toBeNull();

    const queue = emptyQueue(200);
    saveQueue(queue);
    expect(loadQueue()).toEqual(queue);

    mockMmkv.set(POPULATE_QUEUE_KEY, '{');
    expect(loadQueue()).toBeNull();
    mockMmkv.set(
      POPULATE_QUEUE_KEY,
      JSON.stringify({
        schemaVersion: 1,
        pending: [],
        completedInRunItemIds: {},
        startedAt: 1,
        updatedAt: 1,
        pageSize: 1000,
      }),
    );
    expect(loadQueue()).toBeNull();
    expect(getPortfolioRuntimeLogPayloadsForTesting()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({tag: 'loadManifest'}),
        expect.objectContaining({tag: 'loadQueue'}),
      ]),
    );
  });

  it('keeps populate pending items sorted by priority lanes', () => {
    startPopulate({
      walletIds: ['background-wallet'],
      reason: 'initial',
      isFirstPopulate: false,
    });
    startPopulate({
      walletIds: ['normal-wallet'],
      reason: 'manual',
      isFirstPopulate: false,
    });
    startPopulate({
      walletIds: ['urgent-wallet'],
      reason: 'send',
      isFirstPopulate: false,
    });

    expect(loadQueue()?.pending.map(item => item.walletId)).toEqual([
      'urgent-wallet',
      'normal-wallet',
      'background-wallet',
    ]);
    expect(populateLoopRunning.value).toBe(true);
  });

  it('supersedes older unstarted same-wallet background work for urgent populate', () => {
    startPopulate({
      walletIds: ['wallet-a'],
      reason: 'initial',
      isFirstPopulate: false,
    });
    startPopulate({
      walletIds: ['wallet-a'],
      reason: 'send',
      isFirstPopulate: false,
    });

    expect(
      loadQueue()?.pending.map(item => `${item.walletId}:${item.reason}`),
    ).toEqual(['wallet-a:send']);
  });

  it('re-kicks existing populate work when duplicate requests insert no items', () => {
    startPopulateForTesting({
      walletIds: ['wallet-a'],
      reason: 'initial',
      isFirstPopulate: false,
      testRunId: 'run-1',
    });
    populateCancelFlag.value = true;
    populateLoopRunning.value = false;

    startPopulateForTesting({
      walletIds: ['wallet-a'],
      reason: 'initial',
      isFirstPopulate: false,
      testRunId: 'run-1',
    });

    expect(loadQueue()?.pending).toHaveLength(1);
    expect(populateCancelFlag.value).toBe(false);
    expect(populateLoopRunning.value).toBe(true);
  });

  it('preserves active same-wallet work when urgent populate is queued', () => {
    const active = {
      itemId: 'run-1:wallet-a',
      runId: 'run-1',
      walletId: 'wallet-a',
      reason: 'initial' as const,
      priority: 'background' as const,
      requestedAtMs: 1,
    };
    saveQueue({
      ...emptyQueue(1),
      active,
      pending: [
        {
          ...active,
          itemId: 'run-2:wallet-a',
          runId: 'run-2',
          requestedAtMs: 2,
        },
      ],
    });

    startPopulateForTesting({
      walletIds: ['wallet-a'],
      reason: 'send',
      isFirstPopulate: false,
      testRunId: 'run-3',
    });

    const queue = loadQueue();
    expect(queue?.active).toEqual(active);
    expect(queue?.pending.map(item => `${item.runId}:${item.reason}`)).toEqual([
      'run-3:send',
    ]);
  });

  it('logs an explicit Phase 1 gap for first-populate eligibility without wallet ids', () => {
    startPopulate({reason: 'initial', isFirstPopulate: true});

    expect(loadQueue()).toBeNull();
    expect(getPortfolioRuntimeLogPayloadsForTesting()).toEqual([
      expect.objectContaining({
        tag: 'startPopulate',
        reason: 'phase1FirstPopulateEligibilityNotImplemented',
      }),
    ]);
  });

  it('routes all MMKV mutations through helpers with redacted metrics and reset exclusions', async () => {
    writePortfolioMmkvString({
      key: MANIFEST_KEY,
      value: '{"ok":true}',
      reason: 'manifest',
    });
    writePortfolioMmkvString({
      key: PORTFOLIO_V2_FLAG_KEY,
      value: '1',
      reason: 'flag',
    });
    writePortfolioMmkvString({
      key: PORTFOLIO_CACHE_INVALID_KEY,
      value: '1',
      reason: 'cacheInvalid',
    });
    writePortfolioMmkvString({
      key: PORTFOLIO_WORK_EPOCH_KEY,
      value: '8',
      reason: 'workEpoch',
    });
    writePortfolioMmkvString({
      key: 'snap:chunk:v2:w1:0',
      value: '[]',
      reason: 'snapChunk',
    });
    writePortfolioMmkvString({
      key: 'rate:v1:USD:btc:1D',
      value: '[]',
      reason: 'rate',
    });
    mockMmkv.set('portfolio:v2:orphan', 'orphan');

    deletePortfolioMmkvKey({key: 'portfolio:v2:orphan', reason: 'wipe'});
    mockMmkv.set('portfolio:v2:orphan', 'orphan');
    clearPortfolioMmkvKeysForReset({reason: 'reset'});

    expect(mockMmkv.contains(MANIFEST_KEY)).toBe(false);
    expect(mockMmkv.contains('snap:chunk:v2:w1:0')).toBe(false);
    expect(mockMmkv.contains('portfolio:v2:orphan')).toBe(false);
    expect(mockMmkv.contains(PORTFOLIO_V2_FLAG_KEY)).toBe(true);
    expect(mockMmkv.contains(PORTFOLIO_CACHE_INVALID_KEY)).toBe(true);
    expect(mockMmkv.contains(PORTFOLIO_WORK_EPOCH_KEY)).toBe(true);
    expect(mockMmkv.contains('rate:v1:USD:btc:1D')).toBe(true);

    const registryKeys = await getPortfolioKvStore().listKeys();
    expect(registryKeys).not.toEqual(
      expect.arrayContaining([MANIFEST_KEY, 'snap:chunk:v2:w1:0']),
    );

    const mmkvMetrics = getRecordedPortfolioV2MetricsForTesting().filter(
      metric => metric.kind === 'mmkvWrite',
    );
    expect(mmkvMetrics.length).toBeGreaterThan(0);
    expect(mmkvMetrics[0]).toHaveProperty('localKeyHash');
    expect(JSON.stringify(mmkvMetrics)).not.toContain(MANIFEST_KEY);
  });

  it('sanitizes runtime error logs and keeps raw messages/extra objects out', () => {
    logPortfolioRuntimeError(new Error('wallet-123 raw secret'), {
      tag: 'runtimeFailure',
      walletCount: 2,
      startEpoch: 1,
      currentEpoch: 2,
      // The cast simulates a caller trying to smuggle an arbitrary field.
      rawKey: 'rate:v1:USD:wallet-123',
    } as any);

    const payload = getPortfolioRuntimeLogPayloadsForTesting()[0];
    expect(payload).toEqual(
      expect.objectContaining({
        subsystem: 'portfolio-v2',
        errorName: 'Error',
        tag: 'runtimeFailure',
        walletCount: 2,
        startEpoch: 1,
        currentEpoch: 2,
      }),
    );
    expect(JSON.stringify(payload)).not.toContain('wallet-123');
    expect(JSON.stringify(payload)).not.toContain('raw secret');
    expect(JSON.stringify(payload)).not.toContain('rate:v1');

    logPortfolioRuntimeError(
      {name: 'https://bws.example/wallet-123'},
      {
        tag: 'wallet-123',
        reason: 'rate:v1:USD:wallet-123',
        errorCode: 'SAFE_CODE',
        walletCount: Number.POSITIVE_INFINITY,
        warning: true,
      },
    );

    const unsafePayload = getPortfolioRuntimeLogPayloadsForTesting()[1];
    expect(unsafePayload).toEqual(
      expect.objectContaining({
        subsystem: 'portfolio-v2',
        errorName: 'Error',
        errorCode: 'SAFE_CODE',
      }),
    );
    expect(unsafePayload).not.toHaveProperty('tag');
    expect(unsafePayload).not.toHaveProperty('reason');
    expect(unsafePayload).not.toHaveProperty('walletCount');
    expect(unsafePayload.warning).toBe(true);
    expect(JSON.stringify(unsafePayload)).not.toContain('wallet-123');
    expect(JSON.stringify(unsafePayload)).not.toContain('rate:v1');
  });

  it('initializes redux access only after an explicit store injection', () => {
    expect(isPortfolioReduxAccessInitialized()).toBe(false);
    expect(() => getReduxStateForPortfolioV2()).toThrow(
      'Portfolio v2 Redux access has not been initialized',
    );

    const store = {
      getState: () => ({APP: {defaultAltCurrencyIsoCode: 'USD'}}),
      dispatch: jest.fn(),
      subscribe: jest.fn(),
      replaceReducer: jest.fn(),
    } as any;
    initPortfolioReduxAccess(store);
    expect(isPortfolioReduxAccessInitialized()).toBe(true);
    expect(getReduxStateForPortfolioV2()).toEqual({
      APP: {defaultAltCurrencyIsoCode: 'USD'},
    });
  });

  it('builds base recompute inputs from fire-time Redux and MMKV data', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    const first = now - 6 * 365 * 24 * 60 * 60 * 1000;
    const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);

    mockMmkv.set(
      MANIFEST_KEY,
      JSON.stringify({
        ...emptyManifest(now),
        populatedWalletIds: ['w1'],
        populateOrderWalletIds: ['w1'],
        populateOrderAssetGroupIds: ['btc'],
        orderRevision: 3,
      }),
    );
    mockMmkv.set(
      'snap:index:v2:w1',
      JSON.stringify({
        v: 2,
        walletId: 'w1',
        revision: 4,
        compressionEnabled: false,
        chunkRows: 128,
        chunks: [
          {
            id: 0,
            fromTs: first,
            toTs: now,
            rows: 2,
            debugMode: 'none',
          },
        ],
        checkpoint: {
          nextSkip: 0,
          balanceAtomic: '100000000',
          remainingCostBasisFiat: 0,
          lastMarkRate: 0,
          lastTimestamp: now,
          firstNonZeroTs: first,
        },
        updatedAt: now,
      }),
    );
    mockMmkv.set(
      'snap:chunk:v2:w1:0',
      JSON.stringify({
        v: 2,
        rows: [
          [first, '100000000'],
          [now, '100000000'],
        ],
      }),
    );
    for (const interval of ['1D', '1W', '1M', 'ALL']) {
      mockMmkv.set(
        `rate:v1:USD:btc:${interval}`,
        JSON.stringify({
          v: 3,
          f: now,
          p: [
            [first, 100],
            [now, 110],
          ],
        }),
      );
    }

    initPortfolioReduxAccess({
      getState: () =>
        ({
          APP: {
            defaultAltCurrencyIsoCode: 'USD',
            showPortfolioValue: true,
          },
          RATE: {
            rates: {
              btc: [{code: 'USD', rate: 110}],
            },
          },
          WALLET: {
            keys: {
              key1: {
                id: 'key1',
                show: true,
                wallets: [
                  {
                    id: 'w1',
                    chain: 'btc',
                    network: 'livenet',
                    currencyAbbreviation: 'btc',
                    balance: {
                      crypto: '1',
                      sat: 100000000,
                    },
                    credentials: {
                      walletId: 'w1',
                      coin: 'btc',
                      network: 'livenet',
                    },
                  },
                ],
              },
            },
          },
        } as any),
      dispatch: jest.fn(),
      subscribe: jest.fn(),
      replaceReducer: jest.fn(),
    } as any);

    const input = buildBaseRecomputeInputsAtFireTime();
    dateNowSpy.mockRestore();

    expect(input).toMatchObject({
      computedAtMs: now,
      populatedWalletIds: ['w1'],
      orderRevision: 3,
      formula: {
        quoteCurrency: 'USD',
        assetGroups: [{assetGroupId: 'btc', displaySymbol: 'BTC'}],
      },
    });
    expect(input?.formula.wallets).toHaveLength(1);
    expect(input?.formula.wallets[0]).toMatchObject({
      walletId: 'w1',
      assetGroupId: 'btc',
      displayUnitsAtomic: '100000000',
      displayUnitDecimals: 8,
      liveRate: 110,
    });
    expect(
      input?.formula.wallets[0].intervals.map(item => item.interval),
    ).toEqual(['1D', '1W', '1M', '3M', '1Y', '5Y', 'ALL']);
    expect(input?.formula.wallets[0].intervals[0].ratePoints).toHaveLength(2);
  });

  it('uses authoritative unit decimals when current wallet balances are zero', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    const first = now - 6 * 365 * 24 * 60 * 60 * 1000;
    const usdcAddress = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);

    mockMmkv.set(
      MANIFEST_KEY,
      JSON.stringify({
        ...emptyManifest(now),
        populatedWalletIds: ['btc-zero', 'usdc-zero'],
        populateOrderWalletIds: ['btc-zero', 'usdc-zero'],
        populateOrderAssetGroupIds: ['btc', 'usdc'],
        orderRevision: 4,
      }),
    );

    for (const [walletId, atomic] of [
      ['btc-zero', '100000000'],
      ['usdc-zero', '1000000'],
    ] as const) {
      mockMmkv.set(
        `snap:index:v2:${walletId}`,
        JSON.stringify({
          v: 2,
          walletId,
          revision: 4,
          compressionEnabled: false,
          chunkRows: 128,
          chunks: [
            {
              id: 0,
              fromTs: first,
              toTs: now,
              rows: 2,
              debugMode: 'none',
            },
          ],
          checkpoint: {
            nextSkip: 0,
            balanceAtomic: atomic,
            remainingCostBasisFiat: 0,
            lastMarkRate: 0,
            lastTimestamp: now,
            firstNonZeroTs: first,
          },
          updatedAt: now,
        }),
      );
      mockMmkv.set(
        `snap:chunk:v2:${walletId}:0`,
        JSON.stringify({
          v: 2,
          rows: [
            [first, atomic],
            [now, atomic],
          ],
        }),
      );
    }

    for (const interval of ['1D', '1W', '1M', 'ALL']) {
      mockMmkv.set(
        `rate:v1:USD:btc:${interval}`,
        JSON.stringify({
          v: 3,
          f: now,
          p: [
            [first, 100],
            [now, 110],
          ],
        }),
      );
      mockMmkv.set(
        `rate:v1:USD:usdc:${interval}:eth:${usdcAddress}`,
        JSON.stringify({
          v: 3,
          f: now,
          p: [
            [first, 1],
            [now, 1],
          ],
        }),
      );
    }

    initPortfolioReduxAccess({
      getState: () =>
        ({
          APP: {
            defaultAltCurrencyIsoCode: 'USD',
            showPortfolioValue: true,
          },
          RATE: {
            rates: {
              btc: [{code: 'USD', rate: 110}],
              usdc: [{code: 'USD', rate: 1}],
            },
          },
          WALLET: {
            customTokenDataByAddress: {},
            keys: {
              key1: {
                id: 'key1',
                show: true,
                wallets: [
                  {
                    id: 'btc-zero',
                    chain: 'btc',
                    network: 'livenet',
                    currencyAbbreviation: 'btc',
                    balance: {
                      crypto: '0',
                      sat: 0,
                    },
                    credentials: {
                      walletId: 'btc-zero',
                      coin: 'btc',
                      network: 'livenet',
                    },
                  },
                  {
                    id: 'usdc-zero',
                    chain: 'eth',
                    network: 'livenet',
                    currencyAbbreviation: 'usdc',
                    tokenAddress: usdcAddress,
                    balance: {
                      crypto: '0',
                      sat: 0,
                    },
                    credentials: {
                      walletId: 'usdc-zero',
                      coin: 'eth',
                      chain: 'eth',
                      network: 'livenet',
                      token: {
                        address: usdcAddress,
                        decimals: 6,
                        symbol: 'usdc',
                      },
                    },
                  },
                ],
              },
            },
          },
        } as any),
      dispatch: jest.fn(),
      subscribe: jest.fn(),
      replaceReducer: jest.fn(),
    } as any);

    const input = buildBaseRecomputeInputsAtFireTime();
    dateNowSpy.mockRestore();

    const wallets = new Map(
      (input?.formula.wallets || []).map(wallet => [wallet.walletId, wallet]),
    );
    const btcAll = wallets
      .get('btc-zero')
      ?.intervals.find(interval => interval.interval === 'ALL');
    const usdcAll = wallets
      .get('usdc-zero')
      ?.intervals.find(interval => interval.interval === 'ALL');

    expect(wallets.get('btc-zero')).toMatchObject({
      displayUnitDecimals: 8,
      displayUnitsAtomic: '100000000',
    });
    expect(btcAll?.baselineUnits).toBe(1);
    expect(wallets.get('usdc-zero')).toMatchObject({
      displayUnitDecimals: 6,
      displayUnitsAtomic: '1000000',
    });
    expect(usdcAll?.baselineUnits).toBe(1);
  });

  it('uses token-specific live-rate keys before coarse ticker fallbacks', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    const first = now - 6 * 365 * 24 * 60 * 60 * 1000;
    const daiAddress = '0x6b175474e89094c44da98b954eedeac495271d0f';
    const usdcEthAddress = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const usdcPolygonAddress = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174';
    const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);

    const wallets = [
      {
        id: 'dai-eth',
        coin: 'dai',
        chain: 'eth',
        tokenAddress: daiAddress,
        decimals: 18,
        atomic: '3000000000000000000',
      },
      {
        id: 'usdc-eth',
        coin: 'usdc',
        chain: 'eth',
        tokenAddress: usdcEthAddress,
        decimals: 6,
        atomic: '1000000',
      },
      {
        id: 'usdc-polygon',
        coin: 'usdc',
        chain: 'matic',
        tokenAddress: usdcPolygonAddress,
        decimals: 6,
        atomic: '2000000',
      },
    ] as const;

    mockMmkv.set(
      MANIFEST_KEY,
      JSON.stringify({
        ...emptyManifest(now),
        populatedWalletIds: wallets.map(wallet => wallet.id),
        populateOrderWalletIds: wallets.map(wallet => wallet.id),
        populateOrderAssetGroupIds: ['dai', 'usdc'],
        orderRevision: 5,
      }),
    );

    for (const wallet of wallets) {
      mockMmkv.set(
        `snap:index:v2:${wallet.id}`,
        JSON.stringify({
          v: 2,
          walletId: wallet.id,
          revision: 5,
          compressionEnabled: false,
          chunkRows: 128,
          chunks: [
            {
              id: 0,
              fromTs: first,
              toTs: now,
              rows: 2,
              debugMode: 'none',
            },
          ],
          checkpoint: {
            nextSkip: 0,
            balanceAtomic: wallet.atomic,
            remainingCostBasisFiat: 0,
            lastMarkRate: 0,
            lastTimestamp: now,
            firstNonZeroTs: first,
          },
          updatedAt: now,
        }),
      );
      mockMmkv.set(
        `snap:chunk:v2:${wallet.id}:0`,
        JSON.stringify({
          v: 2,
          rows: [
            [first, wallet.atomic],
            [now, wallet.atomic],
          ],
        }),
      );

      for (const interval of ['1D', '1W', '1M', 'ALL']) {
        mockMmkv.set(
          `rate:v1:USD:${wallet.coin}:${interval}:${
            wallet.chain
          }:${wallet.tokenAddress.toLowerCase()}`,
          JSON.stringify({
            v: 3,
            f: now,
            p: [
              [first, 1],
              [now, 1],
            ],
          }),
        );
      }
    }

    initPortfolioReduxAccess({
      getState: () =>
        ({
          APP: {
            defaultAltCurrencyIsoCode: 'USD',
            showPortfolioValue: true,
          },
          RATE: {
            rates: {
              [`${daiAddress}_e`]: [{code: 'USD', rate: 1.02}],
              [`${usdcEthAddress}_e`]: [{code: 'USD', rate: 1.01}],
              usdc: [{code: 'USD', rate: 99}],
            },
          },
          WALLET: {
            customTokenDataByAddress: {},
            keys: {
              key1: {
                id: 'key1',
                show: true,
                wallets: wallets.map(wallet => ({
                  id: wallet.id,
                  chain: wallet.chain,
                  network: 'livenet',
                  currencyAbbreviation: wallet.coin,
                  tokenAddress: wallet.tokenAddress,
                  balance: {
                    crypto: '1',
                    sat: 0,
                  },
                  credentials: {
                    walletId: wallet.id,
                    coin: wallet.chain,
                    chain: wallet.chain,
                    network: 'livenet',
                    token: {
                      address: wallet.tokenAddress,
                      decimals: wallet.decimals,
                      symbol: wallet.coin,
                    },
                  },
                })),
              },
            },
          },
        } as any),
      dispatch: jest.fn(),
      subscribe: jest.fn(),
      replaceReducer: jest.fn(),
    } as any);

    const input = buildBaseRecomputeInputsAtFireTime();
    dateNowSpy.mockRestore();

    const formulaWallets = new Map(
      (input?.formula.wallets || []).map(wallet => [wallet.walletId, wallet]),
    );

    expect(formulaWallets.get('dai-eth')?.liveRate).toBe(1.02);
    expect(formulaWallets.get('usdc-eth')).toMatchObject({
      assetGroupId: 'usdc',
      liveRate: 1.01,
    });
    expect(formulaWallets.get('usdc-polygon')).toMatchObject({
      assetGroupId: 'usdc',
    });
    expect(formulaWallets.get('usdc-polygon')).not.toHaveProperty('liveRate');
    expect(formulaWallets.get('usdc-polygon')?.assetIdentityKey).not.toBe(
      formulaWallets.get('usdc-eth')?.assetIdentityKey,
    );
  });

  it('normalizes legacy exchange-rate params and serialized route wrappers', () => {
    const route = normalizeExchangeRateRouteParams({
      currencyAbbreviation: 'BTC',
      chain: 'btc',
    });
    expect(route).toEqual({
      kind: 'marketAsset',
      fiatRateAssetRef: {
        coin: 'btc',
        chain: 'btc',
        tokenAddress: undefined,
      },
    });
    const serialized = serializeExchangeRateRoute(route, '1D');
    expect(serialized).toEqual({
      route,
      initialInterval: '1D',
    });
    expect(normalizeExchangeRateRouteParams(serialized)).toEqual(route);
  });

  it('uses react-native-worklets runtimes and scoped initializers', () => {
    expect(getPortfolioComputeRuntime()).toEqual({name: 'portfolio-compute'});
    expect(getPortfolioPopulateRuntime()).toEqual({name: 'portfolio-populate'});
    expect(getPortfolioRateFetchRuntime()).toEqual({
      name: 'portfolio-rate-fetch',
    });

    expect(createWorkletRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'portfolio-compute',
        enableEventLoop: true,
      }),
    );
    expect(createWorkletRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'portfolio-populate',
        enableEventLoop: true,
      }),
    );
    expect(createWorkletRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'portfolio-rate-fetch',
        enableEventLoop: true,
      }),
    );

    initializePortfolioRuntimeGlobals('compute');
    expect(mockInitializePopulateRuntimeGlobals).not.toHaveBeenCalled();
    expect(mockInitializeRateFetchRuntimeGlobals).not.toHaveBeenCalled();
    initializePortfolioRuntimeGlobals('populate');
    expect(mockInitializePopulateRuntimeGlobals).toHaveBeenCalledTimes(1);
    expect(mockInitializeRateFetchRuntimeGlobals).not.toHaveBeenCalled();
    initializePortfolioRuntimeGlobals('rateFetch');
    expect(mockInitializePopulateRuntimeGlobals).toHaveBeenCalledTimes(1);
    expect(mockInitializeRateFetchRuntimeGlobals).toHaveBeenCalledTimes(1);
  });
});
