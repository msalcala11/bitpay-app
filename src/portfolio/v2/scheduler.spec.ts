import {runOnRuntimeAsync} from 'react-native-worklets';

import {PORTFOLIO_WORK_EPOCH_KEY} from './constants';
import {
  clearPortfolioRuntimeLogPayloadsForTesting,
  getPortfolioRuntimeLogPayloadsForTesting,
} from './logPortfolioRuntimeError';
import {
  clearRecordedPortfolioV2MetricsForTesting,
  getRecordedPortfolioV2MetricsForTesting,
} from './metrics';
import {
  EMPTY_PORTFOLIO_STATE,
  type PortfolioState,
  type ScopeReadiness,
} from './model';
import {
  clearPendingRecomputesForTesting,
  drainPendingRecomputes,
  getPendingRecomputesForTesting,
  runNextPendingRecompute,
  scheduleRecompute,
} from './scheduler';
import {
  resetPortfolioV2RuntimesForTesting,
} from './runtimes';
import {
  sharedPortfolioState,
} from './sharedState';
import type {
  FormulaAssetGroupInput,
  FormulaWalletInput,
  FormulaWalletIntervalInput,
  NormalizedFormulaRecomputeInput,
} from './recompute';
import {recomputePortfolioState} from './recompute';
import {
  NO_TRANSACTION_PARITY_FIXTURE,
  ORACLE_TS,
} from './__tests__/fixtures/productOracles';

class FakeMmkv {
  readonly data = new Map<string, string>();

  getString(key: string): string | undefined {
    return this.data.get(key);
  }

  set(key: string, value: string): void {
    this.data.set(key, value);
  }
}

const mockMmkv = new FakeMmkv();

jest.mock('react-native-reanimated', () => ({
  makeMutable: (initial: unknown) => {
    let value = initial;
    return {
      get value() {
        return value;
      },
      set value(next: unknown) {
        value = next;
      },
      get: jest.fn(() => value),
      set: jest.fn((next: unknown) => {
        value = next;
      }),
      addListener: jest.fn(),
      removeListener: jest.fn(),
      modify: jest.fn(),
    };
  },
}));

jest.mock('react-native-worklets', () => ({
  createWorkletRuntime: jest.fn((config: {name: string}) => ({
    name: config.name,
  })),
  runOnRuntimeAsync: jest.fn(
    async (
      _runtime: unknown,
      workletFn: (...args: any[]) => unknown,
      ...args: any[]
    ) => workletFn(...args),
  ),
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

const READY_SCOPE: ScopeReadiness = {
  empty: false,
  hasEverPublishedValidSeries: true,
  initialScopeReady: true,
  refreshing: false,
  invalidHistoryBlocked: false,
};

function makeCurrentState(
  overrides: Partial<PortfolioState> = {},
): PortfolioState {
  return {
    ...EMPTY_PORTFOLIO_STATE,
    workEpoch: 7,
    revision: 4,
    quoteCurrency: 'USD',
    computedAtMs: 50,
    populatedWalletIdsKey: 'eth-wallet',
    populatedWalletIdsById: {'eth-wallet': true},
    readinessByScopeKey: {home: READY_SCOPE},
    ...overrides,
  };
}

function oneDayInterval(
  overrides: Partial<FormulaWalletIntervalInput> = {},
): FormulaWalletIntervalInput {
  return {
    interval: '1D',
    seriesIdentityKey: 'wallet:eth|asset:eth|quote:USD|snap:1|rate:1',
    windowStartTs: ORACLE_TS.start,
    windowEndTs: ORACLE_TS.end,
    sampledFromStoredInterval: '1D',
    finalPointSource: 'historicalRate',
    baselineUnits: NO_TRANSACTION_PARITY_FIXTURE.baselineUnits,
    ratePoints: NO_TRANSACTION_PARITY_FIXTURE.ratePoints,
    maxPoints: 2,
    ...overrides,
  };
}

function formulaWalletInput(
  overrides: Partial<FormulaWalletInput> = {},
): FormulaWalletInput {
  return {
    walletId: 'eth-wallet',
    assetGroupId: 'eth',
    assetIdentityKey: 'eth',
    rateSourceKey: 'eth',
    displayUnitsAtomic: '2000000000000000000',
    displayUnitDecimals: 18,
    liveRate: 125,
    lastWrittenAt: 10,
    lastAccessedAt: 20,
    intervals: [oneDayInterval()],
    ...overrides,
  };
}

function formulaAssetGroupInput(
  overrides: Partial<FormulaAssetGroupInput> = {},
): FormulaAssetGroupInput {
  return {
    assetGroupId: 'eth',
    displaySymbol: 'ETH',
    orderIndex: 1,
    ...overrides,
  };
}

function normalizedInput(
  overrides: Partial<NormalizedFormulaRecomputeInput> = {},
): NormalizedFormulaRecomputeInput {
  return {
    computedAtMs: 100,
    populatedWalletIds: ['eth-wallet'],
    formula: {
      quoteCurrency: 'USD',
      wallets: [formulaWalletInput()],
      assetGroups: [formulaAssetGroupInput()],
    },
    ...overrides,
  };
}

beforeEach(() => {
  mockMmkv.data.clear();
  mockMmkv.set(PORTFOLIO_WORK_EPOCH_KEY, '7');
  jest.clearAllMocks();
  clearPendingRecomputesForTesting();
  clearRecordedPortfolioV2MetricsForTesting();
  clearPortfolioRuntimeLogPayloadsForTesting();
  resetPortfolioV2RuntimesForTesting();
  sharedPortfolioState.value = makeCurrentState();
});

describe('portfolio v2 scheduler compute-runtime publish bridge', () => {
  it('dispatches scheduled full recompute work to portfolio-compute and publishes through the helper', async () => {
    scheduleRecompute({
      scope: 'full',
      startEpoch: 7,
      normalizedFormulaInput: normalizedInput(),
    });

    expect(getPendingRecomputesForTesting()).toHaveLength(1);
    const result = await runNextPendingRecompute();

    expect(result.kind).toBe('published');
    expect(runOnRuntimeAsync).toHaveBeenCalledTimes(1);
    expect((runOnRuntimeAsync as jest.Mock).mock.calls[0][0]).toEqual({
      name: 'portfolio-compute',
    });
    expect(sharedPortfolioState.value).toMatchObject({
      workEpoch: 7,
      revision: 5,
      computedAtMs: 100,
    });
    expect(sharedPortfolioState.value.rowShells[0].rowToday).toMatchObject({
      fiatStart: 200,
      fiatEnd: 250,
      pnlPercent: 25,
    });
    expect(getRecordedPortfolioV2MetricsForTesting()).toEqual([
      expect.objectContaining({
        kind: 'publish',
        reason: 'fullRecompute',
        revision: 5,
      }),
    ]);
    expect(getPendingRecomputesForTesting()).toHaveLength(0);
  });

  it('rejects stale compute output at publish time without writing shared state directly', async () => {
    const current = makeCurrentState();
    sharedPortfolioState.value = current;
    scheduleRecompute({
      scope: 'full',
      startEpoch: 7,
      normalizedFormulaInput: normalizedInput(),
    });
    mockMmkv.set(PORTFOLIO_WORK_EPOCH_KEY, '8');

    const result = await runNextPendingRecompute();

    expect(result.kind).toBe('discarded');
    expect(runOnRuntimeAsync).toHaveBeenCalledTimes(1);
    expect(sharedPortfolioState.value).toBe(current);
    expect(getRecordedPortfolioV2MetricsForTesting()).toEqual([]);
    expect(getPortfolioRuntimeLogPayloadsForTesting()).toEqual([
      expect.objectContaining({
        tag: 'staleWorkEpoch',
        startEpoch: 7,
        currentEpoch: 8,
      }),
    ]);
  });

  it('does not publish when compute returns the current state for invalid input', async () => {
    const current = makeCurrentState();
    sharedPortfolioState.value = current;
    scheduleRecompute({
      scope: 'full',
      startEpoch: 7,
      normalizedFormulaInput: normalizedInput({
        formula: {
          quoteCurrency: ' USD',
          wallets: [],
          assetGroups: [],
        },
      }),
    });

    await expect(runNextPendingRecompute()).resolves.toEqual({
      kind: 'unchanged',
    });
    expect(runOnRuntimeAsync).toHaveBeenCalledTimes(1);
    expect(sharedPortfolioState.value).toBe(current);
    expect(getRecordedPortfolioV2MetricsForTesting()).toEqual([]);
  });

  it('reports idle when no recompute work is queued', async () => {
    await expect(runNextPendingRecompute()).resolves.toEqual({kind: 'idle'});
    expect(runOnRuntimeAsync).not.toHaveBeenCalled();
  });

  it('coalesces and subsumes pending work using the scheduler merge table', () => {
    scheduleRecompute({
      scope: {kind: 'liveRateTouch', changedAssetIds: ['eth']},
      startEpoch: 7,
      normalizedFormulaInput: normalizedInput(),
    });
    scheduleRecompute({
      scope: {kind: 'liveRateTouch', changedAssetIds: ['btc']},
      startEpoch: 7,
      normalizedFormulaInput: normalizedInput(),
    });
    expect(getPendingRecomputesForTesting().map(request => request.scope)).toEqual(
      [{kind: 'liveRateTouch', changedAssetIds: ['btc', 'eth']}],
    );

    scheduleRecompute({
      scope: 'full',
      startEpoch: 7,
      normalizedFormulaInput: normalizedInput(),
    });
    expect(getPendingRecomputesForTesting().map(request => request.scope)).toEqual([
      'full',
    ]);

    scheduleRecompute({
      scope: {kind: 'wallet', walletId: 'eth-wallet'},
      startEpoch: 7,
      normalizedFormulaInput: normalizedInput(),
    });
    scheduleRecompute({
      scope: {kind: 'touchWallet', walletId: 'eth-wallet'},
      startEpoch: 7,
      computedAtMs: 200,
    });
    scheduleRecompute({
      scope: {kind: 'touchWallet', walletId: 'btc-wallet'},
      startEpoch: 7,
      computedAtMs: 201,
    });
    scheduleRecompute({
      scope: {kind: 'wallet', walletId: 'btc-wallet'},
      startEpoch: 7,
      normalizedFormulaInput: normalizedInput(),
    });

    expect(getPendingRecomputesForTesting().map(request => request.scope)).toEqual([
      'full',
      {kind: 'wallets', walletIds: ['btc-wallet', 'eth-wallet']},
    ]);
  });

  it('merges normalized payloads when wallet scopes coalesce', () => {
    scheduleRecompute({
      scope: {kind: 'wallet', walletId: 'eth-wallet'},
      startEpoch: 7,
      normalizedFormulaInput: normalizedInput({
        computedAtMs: 100,
        populatedWalletIds: ['eth-wallet'],
        invalidHistoryWalletIds: ['legacy-invalid'],
        retryScheduledWalletIds: ['retry-wallet-a'],
        retryScheduledRateSourceKeys: ['retry-rate-a'],
        staleReasons: ['missingSnapshot'],
        orderRevision: 1,
        scopes: [{scopeKey: 'eth-wallet', walletIds: ['eth-wallet']}],
        scopedSlices: [
          {
            walletIds: ['eth-wallet'],
            walletIdsKey: 'eth-wallet',
            assetGroups: [],
            lastAccessedAt: 10,
          },
        ],
        protectedScopedWalletIdsKeys: ['eth-wallet'],
        evictScopedWalletIds: ['deleted-a'],
        formula: {
          quoteCurrency: 'USD',
          wallets: [formulaWalletInput({liveRate: 111})],
          assetGroups: [formulaAssetGroupInput({orderIndex: 2})],
        },
      }),
    });

    scheduleRecompute({
      scope: {kind: 'wallet', walletId: 'btc-wallet'},
      startEpoch: 7,
      normalizedFormulaInput: normalizedInput({
        computedAtMs: 120,
        populatedWalletIds: ['btc-wallet'],
        invalidHistoryWalletIds: ['new-invalid'],
        retryScheduledWalletIds: ['retry-wallet-b'],
        retryScheduledRateSourceKeys: ['retry-rate-b'],
        staleReasons: ['missingHistoricalRate'],
        orderRevision: 3,
        scopes: [{scopeKey: 'btc-wallet', walletIds: ['btc-wallet']}],
        scopedSlices: [
          {
            walletIds: ['btc-wallet'],
            walletIdsKey: 'btc-wallet',
            assetGroups: [],
            lastAccessedAt: 11,
          },
        ],
        protectedScopedWalletIdsKeys: ['btc-wallet'],
        evictScopedWalletIds: ['deleted-b'],
        formula: {
          quoteCurrency: 'USD',
          wallets: [
            formulaWalletInput({
              walletId: 'btc-wallet',
              assetGroupId: 'btc',
              assetIdentityKey: 'btc',
              rateSourceKey: 'btc',
              displayUnitsAtomic: '100000000',
              displayUnitDecimals: 8,
              liveRate: 222,
            }),
          ],
          assetGroups: [
            formulaAssetGroupInput({
              assetGroupId: 'btc',
              displaySymbol: 'BTC',
              orderIndex: 1,
            }),
          ],
        },
      }),
    });

    const [pending] = getPendingRecomputesForTesting();
    expect(pending.scope).toEqual({
      kind: 'wallets',
      walletIds: ['btc-wallet', 'eth-wallet'],
    });
    const input = pending.normalizedFormulaInput;
    expect(input).toBeDefined();
    expect(input?.computedAtMs).toBe(120);
    expect(input?.orderRevision).toBe(3);
    expect(input?.formula.wallets.map(wallet => wallet.walletId)).toEqual([
      'btc-wallet',
      'eth-wallet',
    ]);
    expect(
      input?.formula.wallets.find(wallet => wallet.walletId === 'btc-wallet')
        ?.liveRate,
    ).toBe(222);
    expect(
      input?.formula.wallets.find(wallet => wallet.walletId === 'eth-wallet')
        ?.liveRate,
    ).toBe(111);
    expect(input?.formula.assetGroups.map(group => group.assetGroupId)).toEqual([
      'btc',
      'eth',
    ]);
    expect(input?.populatedWalletIds).toEqual(['btc-wallet', 'eth-wallet']);
    expect(input?.invalidHistoryWalletIds).toEqual([
      'legacy-invalid',
      'new-invalid',
    ]);
    expect(input?.retryScheduledWalletIds).toEqual([
      'retry-wallet-a',
      'retry-wallet-b',
    ]);
    expect(input?.retryScheduledRateSourceKeys).toEqual([
      'retry-rate-a',
      'retry-rate-b',
    ]);
    expect(input?.staleReasons).toEqual([
      'missingHistoricalRate',
      'missingSnapshot',
    ]);
    expect(input?.scopes?.map(scope => scope.scopeKey)).toEqual([
      'btc-wallet',
      'eth-wallet',
    ]);
    expect(input?.scopedSlices?.map(slice => slice.walletIdsKey)).toEqual([
      'btc-wallet',
      'eth-wallet',
    ]);
    expect(input?.protectedScopedWalletIdsKeys).toEqual([
      'btc-wallet',
      'eth-wallet',
    ]);
    expect(input?.evictScopedWalletIds).toEqual(['deleted-a', 'deleted-b']);
  });

  it('merges newer live-rate payloads into a pending full recompute when the touch is subsumed', () => {
    scheduleRecompute({
      scope: 'full',
      startEpoch: 7,
      normalizedFormulaInput: normalizedInput({
        computedAtMs: 100,
        protectedScopedWalletIdsKeys: ['old-scope'],
        formula: {
          quoteCurrency: 'USD',
          wallets: [formulaWalletInput({liveRate: 100})],
          assetGroups: [formulaAssetGroupInput()],
        },
      }),
    });

    scheduleRecompute({
      scope: {kind: 'liveRateTouch', changedAssetIds: ['eth']},
      startEpoch: 7,
      normalizedFormulaInput: normalizedInput({
        computedAtMs: 130,
        protectedScopedWalletIdsKeys: ['new-scope'],
        evictScopedWalletIds: ['deleted-wallet'],
        formula: {
          quoteCurrency: 'USD',
          wallets: [formulaWalletInput({liveRate: 150})],
          assetGroups: [formulaAssetGroupInput()],
        },
      }),
    });

    const [pending] = getPendingRecomputesForTesting();
    expect(getPendingRecomputesForTesting()).toHaveLength(1);
    expect(pending.scope).toBe('full');
    expect(pending.normalizedFormulaInput?.computedAtMs).toBe(130);
    expect(pending.normalizedFormulaInput?.formula.wallets[0].liveRate).toBe(
      150,
    );
    expect(pending.normalizedFormulaInput?.protectedScopedWalletIdsKeys).toEqual(
      ['new-scope', 'old-scope'],
    );
    expect(pending.normalizedFormulaInput?.evictScopedWalletIds).toEqual([
      'deleted-wallet',
    ]);
  });

  it('does not promote stale pending payloads across work epochs', () => {
    scheduleRecompute({
      scope: 'full',
      startEpoch: 7,
      normalizedFormulaInput: normalizedInput({
        computedAtMs: 100,
        protectedScopedWalletIdsKeys: ['old-scope'],
        formula: {
          quoteCurrency: 'USD',
          wallets: [formulaWalletInput({liveRate: 100})],
          assetGroups: [formulaAssetGroupInput()],
        },
      }),
    });

    mockMmkv.set(PORTFOLIO_WORK_EPOCH_KEY, '8');
    sharedPortfolioState.value = makeCurrentState({workEpoch: 8});

    scheduleRecompute({
      scope: {kind: 'liveRateTouch', changedAssetIds: ['eth']},
      startEpoch: 8,
      normalizedFormulaInput: normalizedInput({
        computedAtMs: 130,
        protectedScopedWalletIdsKeys: ['new-scope'],
        formula: {
          quoteCurrency: 'USD',
          wallets: [formulaWalletInput({liveRate: 150})],
          assetGroups: [formulaAssetGroupInput()],
        },
      }),
    });

    const [pending] = getPendingRecomputesForTesting();
    expect(getPendingRecomputesForTesting()).toHaveLength(1);
    expect(pending.startEpoch).toBe(8);
    expect(pending.scope).toEqual({
      kind: 'liveRateTouch',
      changedAssetIds: ['eth'],
    });
    expect(pending.normalizedFormulaInput?.computedAtMs).toBe(130);
    expect(pending.normalizedFormulaInput?.formula.wallets[0].liveRate).toBe(
      150,
    );
    expect(pending.normalizedFormulaInput?.protectedScopedWalletIdsKeys).toEqual(
      ['new-scope'],
    );

    scheduleRecompute({
      scope: 'full',
      startEpoch: 7,
      normalizedFormulaInput: normalizedInput({computedAtMs: 200}),
    });
    expect(getPendingRecomputesForTesting()).toEqual([pending]);
  });

  it('keeps the newest duplicate keyed scoped payload when an older request arrives later', () => {
    scheduleRecompute({
      scope: {kind: 'wallet', walletId: 'eth-wallet'},
      startEpoch: 7,
      normalizedFormulaInput: normalizedInput({
        computedAtMs: 200,
        scopes: [
          {
            scopeKey: 'shared-scope',
            walletIds: ['eth-wallet'],
            refreshing: true,
          },
        ],
        scopedSlices: [
          {
            walletIds: ['eth-wallet'],
            walletIdsKey: 'shared-scope',
            assetGroups: [],
            refreshing: true,
            lastAccessedAt: 200,
          },
        ],
        formula: {
          quoteCurrency: 'USD',
          wallets: [formulaWalletInput({liveRate: 200})],
          assetGroups: [formulaAssetGroupInput()],
        },
      }),
    });

    scheduleRecompute({
      scope: {kind: 'wallet', walletId: 'btc-wallet'},
      startEpoch: 7,
      normalizedFormulaInput: normalizedInput({
        computedAtMs: 100,
        scopes: [
          {
            scopeKey: 'shared-scope',
            walletIds: ['btc-wallet'],
            refreshing: false,
          },
        ],
        scopedSlices: [
          {
            walletIds: ['btc-wallet'],
            walletIdsKey: 'shared-scope',
            assetGroups: [],
            refreshing: false,
            lastAccessedAt: 100,
          },
        ],
        formula: {
          quoteCurrency: 'USD',
          wallets: [
            formulaWalletInput({
              walletId: 'btc-wallet',
              assetGroupId: 'btc',
              assetIdentityKey: 'btc',
              rateSourceKey: 'btc',
              displayUnitsAtomic: '100000000',
              displayUnitDecimals: 8,
              liveRate: 100,
            }),
          ],
          assetGroups: [
            formulaAssetGroupInput({
              assetGroupId: 'btc',
              displaySymbol: 'BTC',
              orderIndex: 2,
            }),
          ],
        },
      }),
    });

    const [pending] = getPendingRecomputesForTesting();
    expect(pending.normalizedFormulaInput?.computedAtMs).toBe(200);
    expect(pending.normalizedFormulaInput?.scopes).toEqual([
      {
        scopeKey: 'shared-scope',
        walletIds: ['eth-wallet'],
        refreshing: true,
      },
    ]);
    expect(pending.normalizedFormulaInput?.scopedSlices).toEqual([
      expect.objectContaining({
        walletIds: ['eth-wallet'],
        walletIdsKey: 'shared-scope',
        refreshing: true,
        lastAccessedAt: 200,
      }),
    ]);
  });

  it('folds touch metadata into the wallet recompute that subsumes it', () => {
    scheduleRecompute({
      scope: {kind: 'touchWallet', walletId: 'eth-wallet'},
      startEpoch: 7,
      computedAtMs: 300,
    });
    scheduleRecompute({
      scope: {kind: 'wallet', walletId: 'eth-wallet'},
      startEpoch: 7,
      normalizedFormulaInput: normalizedInput({computedAtMs: 100}),
    });

    let pending = getPendingRecomputesForTesting();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      scope: {kind: 'wallet', walletId: 'eth-wallet'},
      computedAtMs: 300,
      accessTouchWalletIds: ['eth-wallet'],
    });

    clearPendingRecomputesForTesting();
    scheduleRecompute({
      scope: {kind: 'wallet', walletId: 'eth-wallet'},
      startEpoch: 7,
      normalizedFormulaInput: normalizedInput({computedAtMs: 100}),
    });
    scheduleRecompute({
      scope: {kind: 'touchWallet', walletId: 'eth-wallet'},
      startEpoch: 7,
      computedAtMs: 320,
    });

    pending = getPendingRecomputesForTesting();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      scope: {kind: 'wallet', walletId: 'eth-wallet'},
      computedAtMs: 320,
      accessTouchWalletIds: ['eth-wallet'],
    });
  });

  it('publishes folded touch access metadata when the wallet recompute drains', async () => {
    (runOnRuntimeAsync as jest.Mock).mockImplementation(
      async (
        _runtime: unknown,
        workletFn: (...args: any[]) => unknown,
        ...args: any[]
      ) => workletFn(...args),
    );
    const built = recomputePortfolioState(makeCurrentState(), {
      scope: 'full',
      startEpoch: 7,
      normalizedFormulaInput: normalizedInput(),
    });
    sharedPortfolioState.value = built;
    const originalWallet = built.byWallet['eth-wallet'];

    scheduleRecompute({
      scope: {kind: 'touchWallet', walletId: 'eth-wallet'},
      startEpoch: 7,
      computedAtMs: 300,
    });
    scheduleRecompute({
      scope: {kind: 'wallet', walletId: 'eth-wallet'},
      startEpoch: 7,
      normalizedFormulaInput: normalizedInput({computedAtMs: 100}),
    });

    await expect(runNextPendingRecompute()).resolves.toEqual(
      expect.objectContaining({kind: 'published'}),
    );
    expect(sharedPortfolioState.value.revision).toBe(built.revision + 1);
    expect(sharedPortfolioState.value.computedAtMs).toBe(built.computedAtMs);
    expect(
      sharedPortfolioState.value.byWallet['eth-wallet'].lastAccessedAt,
    ).toBe(300);
    expect(sharedPortfolioState.value.byWallet['eth-wallet'].series).toBe(
      originalWallet.series,
    );
  });

  it('only touches folded wallet ids inside merged wallet recompute scopes', async () => {
    (runOnRuntimeAsync as jest.Mock).mockImplementation(
      async (
        _runtime: unknown,
        workletFn: (...args: any[]) => unknown,
        ...args: any[]
      ) => workletFn(...args),
    );
    const twoWalletInput = normalizedInput({
      populatedWalletIds: ['eth-wallet', 'btc-wallet'],
      formula: {
        quoteCurrency: 'USD',
        wallets: [
          formulaWalletInput(),
          formulaWalletInput({
            walletId: 'btc-wallet',
            assetGroupId: 'btc',
            assetIdentityKey: 'btc',
            rateSourceKey: 'btc',
            displayUnitsAtomic: '100000000',
            displayUnitDecimals: 8,
            intervals: [
              oneDayInterval({
                seriesIdentityKey:
                  'wallet:btc|asset:btc|quote:USD|snap:1|rate:1',
              }),
            ],
          }),
        ],
        assetGroups: [
          formulaAssetGroupInput(),
          formulaAssetGroupInput({
            assetGroupId: 'btc',
            displaySymbol: 'BTC',
            orderIndex: 2,
          }),
        ],
      },
    });
    const built = recomputePortfolioState(makeCurrentState(), {
      scope: 'full',
      startEpoch: 7,
      normalizedFormulaInput: twoWalletInput,
    });
    const runScenario = async (order: 'touch-first' | 'wallets-first') => {
      clearPendingRecomputesForTesting();
      sharedPortfolioState.value = built;

      const touchRequest = {
        scope: {kind: 'touchWallet' as const, walletId: 'eth-wallet'},
        startEpoch: 7,
        computedAtMs: 333,
      };
      const walletsRequest = {
        scope: {
          kind: 'wallets' as const,
          walletIds: ['btc-wallet', 'eth-wallet'],
        },
        startEpoch: 7,
        normalizedFormulaInput: twoWalletInput,
      };

      if (order === 'touch-first') {
        scheduleRecompute(touchRequest);
        scheduleRecompute(walletsRequest);
      } else {
        scheduleRecompute(walletsRequest);
        scheduleRecompute(touchRequest);
      }

      expect(getPendingRecomputesForTesting()[0]).toMatchObject({
        scope: {
          kind: 'wallets',
          walletIds: ['btc-wallet', 'eth-wallet'],
        },
        computedAtMs: 333,
        accessTouchWalletIds: ['eth-wallet'],
      });

      await expect(runNextPendingRecompute()).resolves.toEqual(
        expect.objectContaining({kind: 'published'}),
      );
      expect(
        sharedPortfolioState.value.byWallet['eth-wallet'].lastAccessedAt,
      ).toBe(333);
      expect(
        sharedPortfolioState.value.byWallet['btc-wallet'].lastAccessedAt,
      ).toBe(built.byWallet['btc-wallet'].lastAccessedAt);
    };

    await runScenario('touch-first');
    await runScenario('wallets-first');
  });

  it('drains by plan priority instead of FIFO while preserving FIFO inside a class', async () => {
    const current = makeCurrentState();
    sharedPortfolioState.value = current;
    (runOnRuntimeAsync as jest.Mock).mockImplementation(
      async (
        _runtime: unknown,
        _workletFn: unknown,
        passedCurrent: PortfolioState,
      ) => passedCurrent,
    );

    scheduleRecompute({
      scope: {kind: 'touchWallet', walletId: 'sol-wallet'},
      startEpoch: 7,
      computedAtMs: 200,
    });
    scheduleRecompute({
      scope: {kind: 'liveRateTouch', changedAssetIds: ['eth']},
      startEpoch: 7,
      normalizedFormulaInput: normalizedInput(),
    });
    scheduleRecompute({
      scope: {kind: 'wallet', walletId: 'btc-wallet'},
      startEpoch: 7,
      normalizedFormulaInput: normalizedInput(),
    });
    scheduleRecompute({
      scope: {kind: 'wallet', walletId: 'eth-wallet'},
      startEpoch: 7,
      normalizedFormulaInput: normalizedInput(),
    });

    await expect(drainPendingRecomputes()).resolves.toMatchObject({
      kind: 'drained',
      results: [
        {kind: 'unchanged'},
        {kind: 'unchanged'},
        {kind: 'unchanged'},
      ],
    });

    expect(
      (runOnRuntimeAsync as jest.Mock).mock.calls.map(call => call[3].scope),
    ).toEqual([
      {kind: 'wallets', walletIds: ['btc-wallet', 'eth-wallet']},
      {kind: 'liveRateTouch', changedAssetIds: ['eth']},
      {kind: 'touchWallet', walletId: 'sol-wallet'},
    ]);
  });

  it('serializes concurrent drain calls and keeps draining queued work', async () => {
    const current = makeCurrentState();
    sharedPortfolioState.value = current;
    let resolveRuntime: ((state: PortfolioState) => void) | undefined;
    (runOnRuntimeAsync as jest.Mock).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveRuntime = resolve as (state: PortfolioState) => void;
        }),
    );

    scheduleRecompute({
      scope: 'full',
      startEpoch: 7,
      normalizedFormulaInput: normalizedInput(),
    });
    scheduleRecompute({
      scope: {kind: 'wallet', walletId: 'eth-wallet'},
      startEpoch: 7,
      normalizedFormulaInput: normalizedInput({computedAtMs: 101}),
    });

    const first = drainPendingRecomputes();
    const second = drainPendingRecomputes();
    expect(runOnRuntimeAsync).toHaveBeenCalledTimes(1);
    expect(getPendingRecomputesForTesting()).toHaveLength(1);

    resolveRuntime?.(current);
    await expect(first).resolves.toMatchObject({
      kind: 'drained',
      results: [{kind: 'unchanged'}, {kind: 'unchanged'}],
    });
    await expect(second).resolves.toMatchObject({
      kind: 'drained',
      results: [{kind: 'unchanged'}, {kind: 'unchanged'}],
    });
    expect(runOnRuntimeAsync).toHaveBeenCalledTimes(2);
    expect(getPendingRecomputesForTesting()).toHaveLength(0);
  });

  it('picks up work scheduled while a drain is already in flight', async () => {
    const current = makeCurrentState();
    sharedPortfolioState.value = current;
    let resolveRuntime: ((state: PortfolioState) => void) | undefined;
    (runOnRuntimeAsync as jest.Mock).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveRuntime = resolve as (state: PortfolioState) => void;
        }),
    );

    scheduleRecompute({
      scope: 'full',
      startEpoch: 7,
      normalizedFormulaInput: normalizedInput(),
    });

    const drain = drainPendingRecomputes();
    expect(runOnRuntimeAsync).toHaveBeenCalledTimes(1);

    scheduleRecompute({
      scope: {kind: 'wallet', walletId: 'eth-wallet'},
      startEpoch: 7,
      normalizedFormulaInput: normalizedInput({computedAtMs: 101}),
    });
    expect(getPendingRecomputesForTesting()).toHaveLength(1);

    resolveRuntime?.(current);
    await expect(drain).resolves.toMatchObject({
      kind: 'drained',
      results: [{kind: 'unchanged'}, {kind: 'unchanged'}],
    });
    expect(runOnRuntimeAsync).toHaveBeenCalledTimes(2);
    expect(getPendingRecomputesForTesting()).toHaveLength(0);
  });
});
