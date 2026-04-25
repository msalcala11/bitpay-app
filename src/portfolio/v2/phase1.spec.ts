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
const mockInitializeLegacyRuntimeGlobals = jest.fn();

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
  initializePortfolioRuntimeGlobals: () => mockInitializeLegacyRuntimeGlobals(),
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
  populateProgressTick,
  populateRetryTick,
  publishPortfolioState,
  resetSharedPortfolioStateForDebugClear,
  sharedPortfolioState,
} from './sharedState';
import {emptyManifest, loadManifest, saveManifest} from './manifest';
import {emptyQueue, loadQueue, saveQueue} from './populate/queue';
import {
  getPortfolioComputeRuntime,
  getPortfolioPopulateRuntime,
  getPortfolioRateFetchRuntime,
  initializePortfolioRuntimeGlobals,
  resetPortfolioV2RuntimesForTesting,
} from './runtimes';
import {
  getReduxStateForPortfolioV2,
  initPortfolioReduxAccess,
  isPortfolioReduxAccessInitialized,
  resetPortfolioReduxAccessForTesting,
} from './reduxAccess';

beforeEach(() => {
  mockMmkv.data.clear();
  mockInitializeLegacyRuntimeGlobals.mockClear();
  (createWorkletRuntime as jest.Mock).mockClear();
  resetPortfolioKvStoreForTesting();
  resetPortfolioV2RuntimesForTesting();
  resetPortfolioReduxAccessForTesting();
  clearRecordedPortfolioV2MetricsForTesting();
  clearPortfolioRuntimeLogPayloadsForTesting();
  sharedPortfolioState.value = EMPTY_PORTFOLIO_STATE;
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
    expect(getPortfolioRuntimeLogPayloadsForTesting()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({tag: 'loadManifest'}),
        expect.objectContaining({tag: 'loadQueue'}),
      ]),
    );
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
    expect(mockInitializeLegacyRuntimeGlobals).not.toHaveBeenCalled();
    initializePortfolioRuntimeGlobals('populate');
    initializePortfolioRuntimeGlobals('rateFetch');
    expect(mockInitializeLegacyRuntimeGlobals).toHaveBeenCalledTimes(2);
  });
});
