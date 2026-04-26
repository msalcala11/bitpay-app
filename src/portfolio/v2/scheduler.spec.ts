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
  FormulaWalletIntervalInput,
  NormalizedFormulaRecomputeInput,
} from './recompute';
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

function normalizedInput(
  overrides: Partial<NormalizedFormulaRecomputeInput> = {},
): NormalizedFormulaRecomputeInput {
  return {
    computedAtMs: 100,
    populatedWalletIds: ['eth-wallet'],
    formula: {
      quoteCurrency: 'USD',
      wallets: [
        {
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
        },
      ],
      assetGroups: [
        {
          assetGroupId: 'eth',
          displaySymbol: 'ETH',
          orderIndex: 1,
        },
      ],
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
    mockMmkv.set(PORTFOLIO_WORK_EPOCH_KEY, '8');
    scheduleRecompute({
      scope: 'full',
      startEpoch: 7,
      normalizedFormulaInput: normalizedInput(),
    });

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
});
