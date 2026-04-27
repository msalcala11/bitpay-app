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
  runOnRuntimeAsync: jest.fn(() => Promise.resolve([])),
}));

const mockNitroRequestSync = jest.fn();
const mockNitroFetchClient = {
  request: jest.fn(),
  requestSync: mockNitroRequestSync,
};
const mockNitroFetchSingleton = {
  createClient: jest.fn(() => mockNitroFetchClient),
};
const mockNitroModulesBox = jest.fn((obj: unknown) => ({unbox: () => obj}));
const mockCreateHybridObject = jest.fn();

jest.mock('react-native-nitro-modules', () => ({
  NitroModules: {
    box: (obj: unknown) => mockNitroModulesBox(obj),
    createHybridObject: (name: string) => mockCreateHybridObject(name),
  },
}));

jest.mock('react-native-nitro-fetch', () => ({
  NitroFetch: mockNitroFetchSingleton,
}));

jest.mock('../../adapters/rn/workletMmkvBridge', () => ({
  __esModule: true,
  PORTFOLIO_WORKLET_MMKV_STORAGE_ID: 'bitpay.portfolio.engine',
  PORTFOLIO_WORKLET_MMKV_REGISTRY_KEY:
    '__bitpay.portfolio.engine.registry.v1__',
  getPortfolioMmkvStorageOnRN: () => mockMmkv,
  createPortfolioMmkvStorageOnRN: () => mockMmkv,
  getNativeMmkvStorageBridgeOnRN: () => mockMmkv,
  getPortfolioMmkvNativeStorageOnRN: () => mockMmkv,
}));

import {runOnRuntimeAsync} from 'react-native-worklets';

import * as txHistorySigning from '../../adapters/rn/txHistorySigning';
import {
  PORTFOLIO_RATE_FETCH_MAX_PARALLEL_TOKEN_REQUESTS,
  PORTFOLIO_WORK_EPOCH_KEY,
} from '../constants';
import {
  clearRecordedPortfolioV2MetricsForTesting,
  getRecordedPortfolioV2MetricsForTesting,
} from '../metrics';
import {
  clearPortfolioRuntimeLogPayloadsForTesting,
  getPortfolioRuntimeLogPayloadsForTesting,
} from '../logPortfolioRuntimeError';
import {resetPortfolioKvStoreForTesting} from '../kvStore';
import {resetPortfolioV2RuntimesForTesting} from '../runtimes';
import {
  buildEnsureFreshArgsForPopulateEligibleAssetGroups,
  buildEnsureFreshArgsForVisibleAssetGroups,
  getEligibleStoredWalletsFromStore,
  getPopulateEligibleWalletIdSetFromStore,
  getVisibleEligibleWalletsFromStore,
  initPortfolioReduxAccess,
  resetPortfolioReduxAccessForTesting,
} from '../reduxAccess';
import {getRateKey} from './ratesKv';
import {
  buildEnsureFreshDependencies,
  buildEnsureQuoteCurrencyFxBridgeDependencies,
  clearRateFetchRetryStateForTesting,
  ensureFresh,
  ensureQuoteCurrencyFxBridge,
  fetchTokenBatchesWithLimitForTesting,
  getRateFetchRetryStatesForTesting,
  setRateFetchExecutorForTesting,
  type RateFetchDependency,
  type RateFetchRuntimeResult,
} from './ratesFetch';

beforeEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  mockNitroRequestSync.mockReset();
  mockNitroFetchClient.request.mockReset();
  mockNitroFetchSingleton.createClient.mockClear();
  mockNitroModulesBox.mockClear();
  mockCreateHybridObject.mockClear();
  mockMmkv.data.clear();
  resetPortfolioKvStoreForTesting();
  resetPortfolioReduxAccessForTesting();
  resetPortfolioV2RuntimesForTesting();
  clearRecordedPortfolioV2MetricsForTesting();
  clearPortfolioRuntimeLogPayloadsForTesting();
  clearRateFetchRetryStateForTesting();
});

const btcAllKey = getRateKey({
  quoteCurrency: 'USD',
  asset: {coin: 'btc'},
  storedInterval: 'ALL',
});
const ltcAllKey = getRateKey({
  quoteCurrency: 'USD',
  asset: {coin: 'ltc'},
  storedInterval: 'ALL',
});
const ethAllKey = getRateKey({
  quoteCurrency: 'USD',
  asset: {coin: 'eth'},
  storedInterval: 'ALL',
});

function completeCredentials(overrides: Record<string, unknown> = {}) {
  return {
    walletId: 'wallet-id',
    network: 'livenet',
    coin: 'btc',
    copayerId: 'copayer-1',
    requestPrivKey: 'request-priv-key',
    isComplete: () => true,
    ...overrides,
  };
}

async function flushRateFetchMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index++) {
    await Promise.resolve();
  }
}

describe('portfolio v2 ensureFresh', () => {
  it('builds dependencies with canonical and target BTC bridge coverage', () => {
    expect(
      buildEnsureFreshDependencies({
        quoteCurrency: 'EUR',
        assetRefs: [{coin: 'eth'}],
        intervals: ['1D', 'ALL'],
      }),
    ).toEqual([
      {
        quoteCurrency: 'EUR',
        asset: {coin: 'btc', chain: undefined, tokenAddress: undefined},
        storedInterval: '1D',
      },
      {
        quoteCurrency: 'EUR',
        asset: {coin: 'btc', chain: undefined, tokenAddress: undefined},
        storedInterval: 'ALL',
      },
      {
        quoteCurrency: 'USD',
        asset: {coin: 'btc', chain: undefined, tokenAddress: undefined},
        storedInterval: '1D',
      },
      {
        quoteCurrency: 'USD',
        asset: {coin: 'btc', chain: undefined, tokenAddress: undefined},
        storedInterval: 'ALL',
      },
      {
        quoteCurrency: 'USD',
        asset: {coin: 'eth', chain: undefined, tokenAddress: undefined},
        storedInterval: '1D',
      },
      {
        quoteCurrency: 'USD',
        asset: {coin: 'eth', chain: undefined, tokenAddress: undefined},
        storedInterval: 'ALL',
      },
    ]);
  });

  it('builds quote-switch bridge dependencies for target BTC only', () => {
    expect(
      buildEnsureQuoteCurrencyFxBridgeDependencies({
        quoteCurrency: 'EUR',
        intervals: ['1D', 'ALL'],
      }),
    ).toEqual([
      {
        quoteCurrency: 'EUR',
        asset: {coin: 'btc', chain: undefined, tokenAddress: undefined},
        storedInterval: '1D',
      },
      {
        quoteCurrency: 'EUR',
        asset: {coin: 'btc', chain: undefined, tokenAddress: undefined},
        storedInterval: 'ALL',
      },
    ]);

    expect(
      buildEnsureQuoteCurrencyFxBridgeDependencies({
        quoteCurrency: 'USD',
        intervals: ['1D', 'ALL'],
      }),
    ).toEqual([]);
  });

  it('ensures quote-switch bridge freshness without fetching canonical assets', async () => {
    const executor = jest.fn(
      async (dependencies: readonly RateFetchDependency[]) =>
        dependencies.map(
          dependency =>
            ({
              dependency,
              series: {fetchedOn: 123, points: [{ts: 1, rate: 100}]},
            } satisfies RateFetchRuntimeResult),
        ),
    );
    setRateFetchExecutorForTesting(executor);

    await ensureQuoteCurrencyFxBridge({
      quoteCurrency: 'EUR',
      intervals: ['ALL'],
      force: true,
    });

    expect(executor).toHaveBeenCalledWith(
      [
        {
          quoteCurrency: 'EUR',
          asset: {coin: 'btc', chain: undefined, tokenAddress: undefined},
          storedInterval: 'ALL',
        },
      ],
      {},
      expect.any(Number),
    );
    expect(mockMmkv.getString(ethAllKey)).toBeUndefined();
    expect(mockMmkv.getString(ltcAllKey)).toBeUndefined();
    expect(
      mockMmkv.getString(
        getRateKey({
          quoteCurrency: 'EUR',
          asset: {coin: 'btc'},
          storedInterval: 'ALL',
        }),
      ),
    ).toBe('{"v":3,"f":123,"p":[[1,100]]}');
  });

  it('rejects display-only intervals at the fetch/persist boundary', () => {
    expect(() =>
      buildEnsureFreshDependencies({
        quoteCurrency: 'USD',
        assetRefs: [{coin: 'btc'}],
        intervals: ['3M' as any],
      }),
    ).toThrow(/must be resolved to a stored interval/);
  });

  it('persists fetched rates through the v2 MMKV mutation helper', async () => {
    const executor = jest.fn(
      async (dependencies: readonly RateFetchDependency[]) =>
        dependencies.map(
          dependency =>
            ({
              dependency,
              series: {fetchedOn: 123, points: [{ts: 1, rate: 100}]},
            } satisfies RateFetchRuntimeResult),
        ),
    );
    setRateFetchExecutorForTesting(executor);

    await ensureFresh({
      quoteCurrency: 'USD',
      assetRefs: [{coin: 'btc'}],
      intervals: ['ALL'],
      force: true,
    });

    expect(executor).toHaveBeenCalledTimes(1);
    expect(mockMmkv.getString(btcAllKey)).toBe('{"v":3,"f":123,"p":[[1,100]]}');
    expect(getRecordedPortfolioV2MetricsForTesting()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'mmkvWrite',
          reason: 'rate',
          keyPrefixFamily: 'rate:v1',
        }),
      ]),
    );
  });

  it('treats non-positive fetched rates as parse failures instead of fresh data', async () => {
    setRateFetchExecutorForTesting(async dependencies =>
      dependencies.map(
        dependency =>
          ({
            dependency,
            series: {
              fetchedOn: 123,
              points: [
                {ts: 1, rate: 100},
                {ts: 2, rate: 0},
              ],
            },
          } satisfies RateFetchRuntimeResult),
      ),
    );

    await ensureFresh({
      quoteCurrency: 'USD',
      assetRefs: [{coin: 'btc'}],
      intervals: ['ALL'],
      force: true,
    });

    expect(mockMmkv.getString(btcAllKey)).toBeUndefined();
    expect(getRateFetchRetryStatesForTesting()).toEqual([
      expect.objectContaining({
        quoteCurrency: 'USD',
        storedInterval: 'ALL',
        rateSourceKey: 'btc',
        lastErrorKind: 'parse',
      }),
    ]);
  });

  it('skips fresh persisted rates without fetching', async () => {
    mockMmkv.set(btcAllKey, '{"v":3,"f":1000,"p":[[1,100]]}');
    const executor = jest.fn(async () => []);
    setRateFetchExecutorForTesting(executor);

    await ensureFresh({
      quoteCurrency: 'USD',
      assetRefs: [{coin: 'btc'}],
      intervals: ['ALL'],
    });

    expect(executor).not.toHaveBeenCalled();
  });

  it('honors forced in-flight upgrades before a freshness skip', async () => {
    mockMmkv.set(btcAllKey, '{"v":3,"f":1000,"p":[[1,100]]}');
    const executor = jest.fn(
      async (dependencies: readonly RateFetchDependency[]) =>
        dependencies.map(
          dependency =>
            ({
              dependency,
              series: {fetchedOn: 123, points: [{ts: 1, rate: 101}]},
            } satisfies RateFetchRuntimeResult),
        ),
    );
    setRateFetchExecutorForTesting(executor);

    const background = ensureFresh({
      quoteCurrency: 'USD',
      assetRefs: [{coin: 'btc'}],
      intervals: ['ALL'],
    });
    const forced = ensureFresh({
      quoteCurrency: 'USD',
      assetRefs: [{coin: 'btc'}],
      intervals: ['ALL'],
      force: true,
    });

    await Promise.all([background, forced]);

    expect(executor).toHaveBeenCalledTimes(1);
    expect(mockMmkv.getString(btcAllKey)).toBe('{"v":3,"f":123,"p":[[1,101]]}');
  });

  it('records retry state and prevents background fetch spin until forced', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(10_000);
    const failingExecutor = jest.fn(
      async (dependencies: readonly RateFetchDependency[]) =>
        dependencies.map(
          dependency =>
            ({
              dependency,
              errorKind: 'network' as const,
            } satisfies RateFetchRuntimeResult),
        ),
    );
    setRateFetchExecutorForTesting(failingExecutor);

    await ensureFresh({
      quoteCurrency: 'USD',
      assetRefs: [{coin: 'btc'}],
      intervals: ['ALL'],
      force: true,
    });
    expect(getRateFetchRetryStatesForTesting()).toEqual([
      expect.objectContaining({
        quoteCurrency: 'USD',
        storedInterval: 'ALL',
        rateSourceKey: 'btc',
        attempt: 1,
        lastErrorKind: 'network',
        lastErrorAtMs: 10_000,
        nextRetryAtMs: 42_500,
      }),
    ]);

    await ensureFresh({
      quoteCurrency: 'USD',
      assetRefs: [{coin: 'btc'}],
      intervals: ['ALL'],
    });
    expect(failingExecutor).toHaveBeenCalledTimes(1);

    const successExecutor = jest.fn(
      async (dependencies: readonly RateFetchDependency[]) =>
        dependencies.map(
          dependency =>
            ({
              dependency,
              series: {fetchedOn: 2000, points: [{ts: 1, rate: 101}]},
            } satisfies RateFetchRuntimeResult),
        ),
    );
    setRateFetchExecutorForTesting(successExecutor);

    await ensureFresh({
      quoteCurrency: 'USD',
      assetRefs: [{coin: 'btc'}],
      intervals: ['ALL'],
      force: true,
    });

    expect(successExecutor).toHaveBeenCalledTimes(1);
    expect(getRateFetchRetryStatesForTesting()).toEqual([]);
  });

  it('records retry state when the rate-fetch executor rejects', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(50_000);
    const executor = jest.fn(async () => {
      throw new Error('runtime unavailable');
    });
    setRateFetchExecutorForTesting(executor);

    await expect(
      ensureFresh({
        quoteCurrency: 'USD',
        assetRefs: [{coin: 'btc'}],
        intervals: ['ALL'],
        force: true,
      }),
    ).resolves.toBeUndefined();

    expect(getRateFetchRetryStatesForTesting()).toEqual([
      expect.objectContaining({
        quoteCurrency: 'USD',
        storedInterval: 'ALL',
        rateSourceKey: 'btc',
        attempt: 1,
        lastErrorKind: 'unknown',
        lastErrorAtMs: 50_000,
      }),
    ]);
    expect(getPortfolioRuntimeLogPayloadsForTesting()).toEqual([
      expect.objectContaining({
        tag: 'ensureFresh',
        reason: 'executorFailed',
        runtimeKind: 'rateFetch',
      }),
    ]);
  });

  it('does not record retry state when executor failure is stale', async () => {
    mockMmkv.set(PORTFOLIO_WORK_EPOCH_KEY, '1');
    setRateFetchExecutorForTesting(async () => {
      mockMmkv.set(PORTFOLIO_WORK_EPOCH_KEY, '2');
      throw new Error('runtime unavailable after reset');
    });

    await ensureFresh({
      quoteCurrency: 'USD',
      assetRefs: [{coin: 'btc'}],
      intervals: ['ALL'],
      force: true,
    });

    expect(getRateFetchRetryStatesForTesting()).toEqual([]);
    expect(getPortfolioRuntimeLogPayloadsForTesting()).toEqual([
      expect.objectContaining({
        tag: 'staleWorkEpoch',
        reason: 'executorFailed',
        startEpoch: 1,
        currentEpoch: 2,
        runtimeKind: 'rateFetch',
      }),
    ]);
  });

  it('does not record retry state when dependency failures are stale', async () => {
    mockMmkv.set(PORTFOLIO_WORK_EPOCH_KEY, '1');
    setRateFetchExecutorForTesting(async dependencies => {
      mockMmkv.set(PORTFOLIO_WORK_EPOCH_KEY, '2');
      return dependencies.map(
        dependency =>
          ({
            dependency,
            errorKind: 'network' as const,
          } satisfies RateFetchRuntimeResult),
      );
    });

    await ensureFresh({
      quoteCurrency: 'USD',
      assetRefs: [{coin: 'btc'}],
      intervals: ['ALL'],
      force: true,
    });

    expect(getRateFetchRetryStatesForTesting()).toEqual([]);
    expect(getPortfolioRuntimeLogPayloadsForTesting()).toEqual([
      expect.objectContaining({
        tag: 'staleWorkEpoch',
        reason: 'runtimeResultFailed',
        startEpoch: 1,
        currentEpoch: 2,
        runtimeKind: 'rateFetch',
      }),
    ]);
  });

  it('logs one failed stale result for mixed success and failure batches', async () => {
    mockMmkv.set(PORTFOLIO_WORK_EPOCH_KEY, '1');
    setRateFetchExecutorForTesting(async dependencies => {
      mockMmkv.set(PORTFOLIO_WORK_EPOCH_KEY, '2');
      return dependencies.map((dependency, index) =>
        index === 0
          ? ({
              dependency,
              series: {fetchedOn: 123, points: [{ts: 1, rate: 100}]},
            } satisfies RateFetchRuntimeResult)
          : ({
              dependency,
              errorKind: 'network' as const,
            } satisfies RateFetchRuntimeResult),
      );
    });

    await ensureFresh({
      quoteCurrency: 'EUR',
      assetRefs: [{coin: 'eth'}],
      intervals: ['ALL'],
      force: true,
    });

    expect(getRateFetchRetryStatesForTesting()).toEqual([]);
    expect(getPortfolioRuntimeLogPayloadsForTesting()).toHaveLength(1);
    expect(getPortfolioRuntimeLogPayloadsForTesting()).toEqual([
      expect.objectContaining({
        tag: 'staleWorkEpoch',
        reason: 'runtimeResultFailed',
        startEpoch: 1,
        currentEpoch: 2,
        runtimeKind: 'rateFetch',
      }),
    ]);
  });

  it('classifies dropped stale runtime results as failed', async () => {
    mockMmkv.set(PORTFOLIO_WORK_EPOCH_KEY, '1');
    setRateFetchExecutorForTesting(async () => {
      mockMmkv.set(PORTFOLIO_WORK_EPOCH_KEY, '2');
      return [];
    });

    await ensureFresh({
      quoteCurrency: 'EUR',
      assetRefs: [{coin: 'eth'}],
      intervals: ['ALL'],
      force: true,
    });

    expect(getRateFetchRetryStatesForTesting()).toEqual([]);
    expect(getPortfolioRuntimeLogPayloadsForTesting()).toEqual([
      expect.objectContaining({
        tag: 'staleWorkEpoch',
        reason: 'runtimeResultFailed',
        startEpoch: 1,
        currentEpoch: 2,
        runtimeKind: 'rateFetch',
      }),
    ]);
  });

  it('classifies wrong-dependency stale runtime results as failed', async () => {
    mockMmkv.set(PORTFOLIO_WORK_EPOCH_KEY, '1');
    setRateFetchExecutorForTesting(async dependencies => {
      mockMmkv.set(PORTFOLIO_WORK_EPOCH_KEY, '2');
      return dependencies.map(
        dependency =>
          ({
            dependency: dependencies[0] ?? dependency,
            series: {fetchedOn: 123, points: [{ts: 1, rate: 100}]},
          } satisfies RateFetchRuntimeResult),
      );
    });

    await ensureFresh({
      quoteCurrency: 'EUR',
      assetRefs: [{coin: 'eth'}],
      intervals: ['ALL'],
      force: true,
    });

    expect(getRateFetchRetryStatesForTesting()).toEqual([]);
    expect(getPortfolioRuntimeLogPayloadsForTesting()).toEqual([
      expect.objectContaining({
        tag: 'staleWorkEpoch',
        reason: 'runtimeResultFailed',
        startEpoch: 1,
        currentEpoch: 2,
        runtimeKind: 'rateFetch',
      }),
    ]);
  });

  it('dispatches default rate fetch work to the rate-fetch runtime without JS trampolines', async () => {
    const mutableGlobal = globalThis as unknown as {fetch?: unknown};
    const originalFetch = mutableGlobal.fetch;
    const fetchSpy = jest.fn();
    const createSigningContextSpy = jest.spyOn(
      txHistorySigning,
      'createPortfolioTxHistorySigningDispatchContextOnRN',
    );
    const bitcoreSigningSpy = jest.spyOn(
      txHistorySigning,
      'signBwsGetRequestWithBitcore',
    );
    mutableGlobal.fetch = fetchSpy;

    try {
      await ensureFresh({
        quoteCurrency: 'USD',
        assetRefs: [{coin: 'btc'}],
        intervals: ['ALL'],
        force: true,
        cfg: {baseUrl: 'https://bws.example'},
      });
    } finally {
      if (typeof originalFetch === 'undefined') {
        delete mutableGlobal.fetch;
      } else {
        mutableGlobal.fetch = originalFetch;
      }
    }

    expect(runOnRuntimeAsync).toHaveBeenCalledTimes(1);
    expect((runOnRuntimeAsync as jest.Mock).mock.calls[0][0]).toEqual({
      name: 'portfolio-rate-fetch',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(createSigningContextSpy).not.toHaveBeenCalled();
    expect(bitcoreSigningSpy).not.toHaveBeenCalled();
  });

  it('executes default rate fetch work with a fetch-only Nitro context', async () => {
    let runtimeResults: readonly RateFetchRuntimeResult[] | undefined;
    (runOnRuntimeAsync as jest.Mock).mockImplementationOnce(
      async (
        _runtime: unknown,
        workletFn: (...args: any[]) => unknown,
        ...args: any[]
      ) => {
        runtimeResults = (await workletFn(
          ...args,
        )) as readonly RateFetchRuntimeResult[];
        return runtimeResults;
      },
    );
    mockNitroRequestSync.mockReturnValueOnce({
      ok: true,
      status: 200,
      bodyString: JSON.stringify({
        btc: {fetchedOn: 123, points: [{ts: 1, rate: 100}]},
      }),
    });

    await ensureFresh({
      quoteCurrency: 'USD',
      assetRefs: [{coin: 'btc'}],
      intervals: ['ALL'],
      force: true,
      cfg: {baseUrl: 'https://bws.example'},
    });

    expect(mockNitroRequestSync).toHaveBeenCalledTimes(1);
    expect(runtimeResults).toEqual([
      expect.objectContaining({persisted: true}),
    ]);
    expect(runtimeResults?.[0]).not.toHaveProperty('series');
    expect(mockMmkv.getString(btcAllKey)).toBe('{"v":3,"f":123,"p":[[1,100]]}');
    expect(
      txHistorySigning.getPortfolioTxHistorySigningDispatchContextOnRuntime(),
    ).toBeUndefined();
    expect(() =>
      txHistorySigning.takeNextPortfolioTransferredSignHandleOnRuntime(),
    ).toThrow('No portfolio runtime request context is initialized');
  });

  it('tears down default rate-fetch runtime globals after runtime failure', async () => {
    (runOnRuntimeAsync as jest.Mock).mockImplementationOnce(
      async (
        _runtime: unknown,
        workletFn: (...args: any[]) => unknown,
        ...args: any[]
      ) => workletFn(...args),
    );
    mockNitroRequestSync.mockImplementationOnce(() => {
      throw new Error('runtime request failed');
    });

    await ensureFresh({
      quoteCurrency: 'USD',
      assetRefs: [{coin: 'btc'}],
      intervals: ['ALL'],
      force: true,
      cfg: {baseUrl: 'https://bws.example'},
    });

    expect(
      txHistorySigning.getPortfolioTxHistorySigningDispatchContextOnRuntime(),
    ).toBeUndefined();
    expect(() =>
      txHistorySigning.takeNextPortfolioTransferredSignHandleOnRuntime(),
    ).toThrow('No portfolio runtime request context is initialized');
  });

  it('batches mixed native assets into one V4 request per interval', async () => {
    (runOnRuntimeAsync as jest.Mock).mockImplementationOnce(
      async (
        _runtime: unknown,
        workletFn: (...args: any[]) => unknown,
        ...args: any[]
      ) => workletFn(...args),
    );
    mockNitroRequestSync.mockReturnValue({
      ok: true,
      status: 200,
      bodyString: JSON.stringify({
        btc: {fetchedOn: 123, points: [{ts: 1, rate: 100}]},
        eth: {fetchedOn: 124, points: [{ts: 1, rate: 2000}]},
        sol: {fetchedOn: 125, points: [{ts: 1, rate: 150}]},
      }),
    });

    await ensureFresh({
      quoteCurrency: 'USD',
      assetRefs: [{coin: 'eth'}, {coin: 'sol'}],
      intervals: ['1D'],
      force: true,
      cfg: {baseUrl: 'https://bws.example'},
    });

    expect(mockNitroRequestSync).toHaveBeenCalledTimes(1);
    expect(mockNitroRequestSync).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://bws.example/v4/fiatrates/USD?days=1',
      }),
    );
    expect(
      mockMmkv.getString(
        getRateKey({
          quoteCurrency: 'USD',
          asset: {coin: 'btc'},
          storedInterval: '1D',
        }),
      ),
    ).toBe('{"v":3,"f":123,"p":[[1,100]]}');
    expect(
      mockMmkv.getString(
        getRateKey({
          quoteCurrency: 'USD',
          asset: {coin: 'eth'},
          storedInterval: '1D',
        }),
      ),
    ).toBe('{"v":3,"f":124,"p":[[1,2000]]}');
    expect(
      mockMmkv.getString(
        getRateKey({
          quoteCurrency: 'USD',
          asset: {coin: 'sol'},
          storedInterval: '1D',
        }),
      ),
    ).toBe('{"v":3,"f":125,"p":[[1,150]]}');
  });

  it('issues one native V4 batch per stored interval', async () => {
    (runOnRuntimeAsync as jest.Mock).mockImplementationOnce(
      async (
        _runtime: unknown,
        workletFn: (...args: any[]) => unknown,
        ...args: any[]
      ) => workletFn(...args),
    );
    mockNitroRequestSync.mockImplementation(request => {
      const url = String(request.url);
      return {
        ok: true,
        status: 200,
        bodyString: JSON.stringify({
          btc: {
            fetchedOn: url.includes('days=1') ? 123 : 223,
            points: [{ts: 1, rate: 100}],
          },
          eth: {
            fetchedOn: url.includes('days=1') ? 124 : 224,
            points: [{ts: 1, rate: 2000}],
          },
        }),
      };
    });

    await ensureFresh({
      quoteCurrency: 'USD',
      assetRefs: [{coin: 'eth'}],
      intervals: ['1D', 'ALL'],
      force: true,
      cfg: {baseUrl: 'https://bws.example'},
    });

    expect(mockNitroRequestSync).toHaveBeenCalledTimes(2);
    expect(mockNitroRequestSync).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://bws.example/v4/fiatrates/USD?days=1',
      }),
    );
    expect(mockNitroRequestSync).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://bws.example/v4/fiatrates/USD',
      }),
    );
    expect(
      mockMmkv.getString(
        getRateKey({
          quoteCurrency: 'USD',
          asset: {coin: 'eth'},
          storedInterval: '1D',
        }),
      ),
    ).toBe('{"v":3,"f":124,"p":[[1,2000]]}');
    expect(mockMmkv.getString(ethAllKey)).toBe(
      '{"v":3,"f":224,"p":[[1,2000]]}',
    );
  });

  it('keeps token V4 requests separate from the native interval batch', async () => {
    (runOnRuntimeAsync as jest.Mock).mockImplementationOnce(
      async (
        _runtime: unknown,
        workletFn: (...args: any[]) => unknown,
        ...args: any[]
      ) => workletFn(...args),
    );
    const tokenAddress = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
    mockNitroRequestSync.mockImplementation(request => {
      const url = String(request.url);
      return {
        ok: true,
        status: 200,
        bodyString: JSON.stringify(
          url.includes('tokenAddress=')
            ? {usdc: {fetchedOn: 225, points: [{ts: 1, rate: 1.01}]}}
            : {
                btc: {fetchedOn: 123, points: [{ts: 1, rate: 100}]},
                eth: {fetchedOn: 124, points: [{ts: 1, rate: 2000}]},
              },
        ),
      };
    });

    await ensureFresh({
      quoteCurrency: 'USD',
      assetRefs: [
        {coin: 'eth'},
        {
          coin: 'usdc',
          chain: 'arb',
          tokenAddress,
        },
      ],
      intervals: ['1D'],
      force: true,
      cfg: {baseUrl: 'https://bws.example'},
    });

    expect(mockNitroRequestSync).toHaveBeenCalledTimes(2);
    expect(mockNitroRequestSync).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://bws.example/v4/fiatrates/USD?days=1',
      }),
    );
    expect(mockNitroRequestSync).toHaveBeenCalledWith(
      expect.objectContaining({
        url: `https://bws.example/v4/fiatrates/USD?days=1&chain=arb&tokenAddress=${tokenAddress}`,
      }),
    );
    expect(
      mockMmkv.getString(
        getRateKey({
          quoteCurrency: 'USD',
          asset: {coin: 'eth'},
          storedInterval: '1D',
        }),
      ),
    ).toBe('{"v":3,"f":124,"p":[[1,2000]]}');
    expect(
      mockMmkv.getString(
        getRateKey({
          quoteCurrency: 'USD',
          asset: {coin: 'usdc', chain: 'arb', tokenAddress},
          storedInterval: '1D',
        }),
      ),
    ).toBe('{"v":3,"f":225,"p":[[1,1.01]]}');
  });

  it('keeps the fetch-only Nitro context active for the whole dependency batch', async () => {
    (runOnRuntimeAsync as jest.Mock).mockImplementationOnce(
      async (
        _runtime: unknown,
        workletFn: (...args: any[]) => unknown,
        ...args: any[]
      ) => workletFn(...args),
    );
    mockNitroRequestSync.mockReturnValue({
      ok: true,
      status: 200,
      bodyString: JSON.stringify({
        btc: {fetchedOn: 123, points: [{ts: 1, rate: 100}]},
        eth: {fetchedOn: 124, points: [{ts: 1, rate: 2000}]},
      }),
    });

    await ensureFresh({
      quoteCurrency: 'USD',
      assetRefs: [{coin: 'eth'}],
      intervals: ['ALL'],
      force: true,
      cfg: {baseUrl: 'https://bws.example'},
    });

    expect(mockNitroRequestSync).toHaveBeenCalledTimes(1);
    const dispatchContext = (runOnRuntimeAsync as jest.Mock).mock.calls[0][4];
    expect(dispatchContext).toEqual(expect.objectContaining({requestCount: 1}));
    expect(dispatchContext).not.toHaveProperty('requestPrivKey');
    expect(dispatchContext).not.toHaveProperty('requestPubKey');
    expect(dispatchContext).not.toHaveProperty('signHandleHybrids');
    expect(mockMmkv.getString(btcAllKey)).toBe('{"v":3,"f":123,"p":[[1,100]]}');
    expect(mockMmkv.getString(ethAllKey)).toBe(
      '{"v":3,"f":124,"p":[[1,2000]]}',
    );
    expect(
      txHistorySigning.getPortfolioTxHistorySigningDispatchContextOnRuntime(),
    ).toBeUndefined();
  });

  it('drops default runtime-fetched rates when the work epoch changes before runtime persist', async () => {
    mockMmkv.set(PORTFOLIO_WORK_EPOCH_KEY, '1');
    (runOnRuntimeAsync as jest.Mock).mockImplementationOnce(
      async (
        _runtime: unknown,
        workletFn: (...args: any[]) => unknown,
        ...args: any[]
      ) => workletFn(...args),
    );
    mockNitroRequestSync.mockImplementationOnce(() => {
      mockMmkv.set(PORTFOLIO_WORK_EPOCH_KEY, '2');
      return {
        ok: true,
        status: 200,
        bodyString: JSON.stringify({
          btc: {fetchedOn: 123, points: [{ts: 1, rate: 100}]},
        }),
      };
    });

    await ensureFresh({
      quoteCurrency: 'USD',
      assetRefs: [{coin: 'btc'}],
      intervals: ['ALL'],
      force: true,
    });

    expect(mockMmkv.getString(btcAllKey)).toBeUndefined();
    expect(getRateFetchRetryStatesForTesting()).toEqual([]);
    expect(getPortfolioRuntimeLogPayloadsForTesting()).toEqual([
      expect.objectContaining({
        tag: 'staleWorkEpoch',
        reason: 'runtimeResultSucceeded',
        startEpoch: 1,
        currentEpoch: 2,
        runtimeKind: 'rateFetch',
      }),
    ]);
  });

  it('records retry state for current-epoch fetched-only runtime results', async () => {
    setRateFetchExecutorForTesting(async dependencies =>
      dependencies.map(
        dependency =>
          ({
            dependency,
            fetched: true,
          } satisfies RateFetchRuntimeResult),
      ),
    );

    await ensureFresh({
      quoteCurrency: 'USD',
      assetRefs: [{coin: 'btc'}],
      intervals: ['ALL'],
      force: true,
    });

    expect(mockMmkv.getString(btcAllKey)).toBeUndefined();
    expect(getRateFetchRetryStatesForTesting()).toEqual([
      expect.objectContaining({
        quoteCurrency: 'USD',
        storedInterval: 'ALL',
        rateSourceKey: 'btc',
        lastErrorKind: 'parse',
      }),
    ]);
  });

  it('drops fetched results when the work epoch changes before persist', async () => {
    mockMmkv.set(PORTFOLIO_WORK_EPOCH_KEY, '1');
    setRateFetchExecutorForTesting(async dependencies => {
      mockMmkv.set(PORTFOLIO_WORK_EPOCH_KEY, '2');
      return dependencies.map(
        dependency =>
          ({
            dependency,
            series: {fetchedOn: 123, points: [{ts: 1, rate: 100}]},
          } satisfies RateFetchRuntimeResult),
      );
    });

    await ensureFresh({
      quoteCurrency: 'USD',
      assetRefs: [{coin: 'btc'}],
      intervals: ['ALL'],
      force: true,
      startEpoch: 1,
    });

    expect(mockMmkv.getString(btcAllKey)).toBeUndefined();
    expect(getPortfolioRuntimeLogPayloadsForTesting()).toEqual([
      expect.objectContaining({
        tag: 'staleWorkEpoch',
        reason: 'runtimeResultSucceeded',
        startEpoch: 1,
        currentEpoch: 2,
        runtimeKind: 'rateFetch',
      }),
    ]);
  });

  it('records retry state for current-epoch dropped runtime results', async () => {
    setRateFetchExecutorForTesting(async dependencies =>
      dependencies.slice(0, 1).map(
        dependency =>
          ({
            dependency,
            series: {fetchedOn: 123, points: [{ts: 1, rate: 100}]},
          } satisfies RateFetchRuntimeResult),
      ),
    );

    await ensureFresh({
      quoteCurrency: 'EUR',
      assetRefs: [{coin: 'eth'}],
      intervals: ['ALL'],
      force: true,
    });

    expect(getRateFetchRetryStatesForTesting()).toEqual([
      expect.objectContaining({
        quoteCurrency: 'USD',
        storedInterval: 'ALL',
        rateSourceKey: 'btc',
        lastErrorKind: 'unknown',
      }),
      expect.objectContaining({
        quoteCurrency: 'USD',
        storedInterval: 'ALL',
        rateSourceKey: 'eth',
        lastErrorKind: 'unknown',
      }),
    ]);
    expect(getPortfolioRuntimeLogPayloadsForTesting()).toEqual([
      expect.objectContaining({
        tag: 'ensureFresh',
        reason: 'runtimeResultMismatch',
        runtimeKind: 'rateFetch',
      }),
    ]);
  });

  it('does not persist unexpected current-epoch runtime results', async () => {
    setRateFetchExecutorForTesting(async () => [
      {
        dependency: {
          quoteCurrency: 'USD',
          asset: {coin: 'ltc'},
          storedInterval: 'ALL',
        },
        series: {fetchedOn: 123, points: [{ts: 1, rate: 100}]},
      },
    ]);

    await ensureFresh({
      quoteCurrency: 'USD',
      assetRefs: [{coin: 'eth'}],
      intervals: ['ALL'],
      force: true,
    });

    expect(mockMmkv.getString(ltcAllKey)).toBeUndefined();
    expect(getRateFetchRetryStatesForTesting()).toEqual([
      expect.objectContaining({
        quoteCurrency: 'USD',
        storedInterval: 'ALL',
        rateSourceKey: 'btc',
        lastErrorKind: 'unknown',
      }),
      expect.objectContaining({
        quoteCurrency: 'USD',
        storedInterval: 'ALL',
        rateSourceKey: 'eth',
        lastErrorKind: 'unknown',
      }),
    ]);
    expect(getPortfolioRuntimeLogPayloadsForTesting()).toEqual([
      expect.objectContaining({
        tag: 'ensureFresh',
        reason: 'runtimeResultMismatch',
        runtimeKind: 'rateFetch',
      }),
    ]);
  });

  it('records retry state for duplicate current-epoch runtime results', async () => {
    let duplicatedKey: string | undefined;
    setRateFetchExecutorForTesting(async dependencies => {
      duplicatedKey = getRateKey(dependencies[0]);
      return [
        {
          dependency: dependencies[0],
          series: {fetchedOn: 123, points: [{ts: 1, rate: 100}]},
        },
        {
          dependency: dependencies[0],
          series: {fetchedOn: 124, points: [{ts: 2, rate: 101}]},
        },
      ];
    });

    await ensureFresh({
      quoteCurrency: 'USD',
      assetRefs: [{coin: 'eth'}],
      intervals: ['ALL'],
      force: true,
    });

    expect(mockMmkv.getString(duplicatedKey!)).toBe(
      '{"v":3,"f":123,"p":[[1,100]]}',
    );
    expect(getRateFetchRetryStatesForTesting()).toEqual([
      expect.objectContaining({
        quoteCurrency: 'USD',
        storedInterval: 'ALL',
        rateSourceKey: 'eth',
        lastErrorKind: 'unknown',
      }),
    ]);
    expect(getPortfolioRuntimeLogPayloadsForTesting()).toEqual([
      expect.objectContaining({
        tag: 'ensureFresh',
        reason: 'runtimeResultMismatch',
        runtimeKind: 'rateFetch',
      }),
    ]);
  });

  it('builds populate and visible dependencies with canonical BTC intervals', () => {
    initPortfolioReduxAccess({
      getState: () =>
        ({
          APP: {
            defaultAltCurrencyIsoCode: 'USD',
            homeCarouselConfig: [],
          },
          WALLET: {
            keys: {
              key1: {
                wallets: [
                  {
                    id: 'visible-btc',
                    chain: 'btc',
                    network: 'livenet',
                    currencyAbbreviation: 'btc',
                    credentials: completeCredentials({
                      walletId: 'visible-btc',
                      chain: 'btc',
                      coin: 'btc',
                    }),
                  },
                  {
                    id: 'hidden-eth',
                    chain: 'eth',
                    network: 'livenet',
                    currencyAbbreviation: 'eth',
                    hideWallet: true,
                    credentials: completeCredentials({
                      walletId: 'hidden-eth',
                      chain: 'eth',
                      coin: 'eth',
                    }),
                  },
                  {
                    id: 'testnet-doge',
                    chain: 'doge',
                    network: 'testnet',
                    currencyAbbreviation: 'doge',
                    credentials: completeCredentials({
                      walletId: 'testnet-doge',
                      chain: 'doge',
                      coin: 'doge',
                      network: 'testnet',
                    }),
                  },
                ],
              },
            },
          },
        } as any),
    } as any);

    expect(
      buildEnsureFreshArgsForPopulateEligibleAssetGroups({
        intervals: ['ALL'],
      }),
    ).toEqual({
      quoteCurrency: 'USD',
      assetRefs: [{coin: 'btc'}, {coin: 'eth'}],
      intervals: ['1D', '1W', '1M', 'ALL'],
      force: undefined,
    });
    expect(
      buildEnsureFreshArgsForVisibleAssetGroups({intervals: ['ALL']}),
    ).toEqual({
      quoteCurrency: 'USD',
      assetRefs: [{coin: 'btc'}],
      intervals: ['1D', '1W', '1M', 'ALL'],
      force: undefined,
    });
  });

  it('filters populate/background wallets through complete runtime eligibility', () => {
    initPortfolioReduxAccess({
      getState: () =>
        ({
          APP: {
            defaultAltCurrencyIsoCode: 'USD',
            homeCarouselConfig: [],
          },
          WALLET: {
            keys: {
              key1: {
                wallets: [
                  {
                    id: 'valid-hidden-eth',
                    chain: 'eth',
                    network: 'livenet',
                    currencyAbbreviation: 'eth',
                    hideWallet: true,
                    credentials: completeCredentials({
                      walletId: 'valid-hidden-eth',
                      chain: 'eth',
                      coin: 'eth',
                    }),
                  },
                  {
                    id: 'valid-visible-ltc',
                    chain: 'ltc',
                    network: 'livenet',
                    currencyAbbreviation: 'ltc',
                    credentials: completeCredentials({
                      walletId: 'valid-visible-ltc',
                      chain: 'ltc',
                      coin: 'ltc',
                    }),
                  },
                  {
                    id: 'missing-copayer',
                    chain: 'btc',
                    network: 'livenet',
                    currencyAbbreviation: 'btc',
                    credentials: completeCredentials({
                      walletId: 'missing-copayer',
                      copayerId: '',
                    }),
                  },
                  {
                    id: 'missing-priv',
                    chain: 'ltc',
                    network: 'livenet',
                    currencyAbbreviation: 'ltc',
                    credentials: completeCredentials({
                      walletId: 'missing-priv',
                      coin: 'ltc',
                      requestPrivKey: '',
                    }),
                  },
                  {
                    id: 'incomplete',
                    chain: 'doge',
                    network: 'livenet',
                    currencyAbbreviation: 'doge',
                    credentials: completeCredentials({
                      walletId: 'incomplete',
                      coin: 'doge',
                      isComplete: () => false,
                    }),
                  },
                  {
                    id: 'pending-tss',
                    chain: 'xrp',
                    network: 'livenet',
                    currencyAbbreviation: 'xrp',
                    pendingTssSession: true,
                    credentials: completeCredentials({
                      walletId: 'pending-tss',
                      coin: 'xrp',
                    }),
                  },
                  {
                    id: 'deleted-wallet',
                    chain: 'sol',
                    network: 'livenet',
                    currencyAbbreviation: 'sol',
                    deleted: true,
                    credentials: completeCredentials({
                      walletId: 'deleted-wallet',
                      coin: 'sol',
                    }),
                  },
                  {
                    id: 'testnet-dash',
                    chain: 'dash',
                    network: 'testnet',
                    currencyAbbreviation: 'dash',
                    credentials: completeCredentials({
                      walletId: 'testnet-dash',
                      coin: 'dash',
                      network: 'testnet',
                    }),
                  },
                ],
              },
            },
          },
        } as any),
    } as any);

    expect(
      getEligibleStoredWalletsFromStore()
        .map(wallet => wallet.id)
        .sort(),
    ).toEqual(['valid-hidden-eth', 'valid-visible-ltc']);
    expect(
      Array.from(getPopulateEligibleWalletIdSetFromStore()).sort(),
    ).toEqual(['valid-hidden-eth', 'valid-visible-ltc']);
    expect(
      getVisibleEligibleWalletsFromStore()
        .map(wallet => wallet.id)
        .sort(),
    ).toEqual(['valid-visible-ltc']);
    expect(
      buildEnsureFreshArgsForPopulateEligibleAssetGroups({intervals: ['ALL']})
        .assetRefs,
    ).toEqual([{coin: 'btc'}, {coin: 'eth'}, {coin: 'ltc'}]);
    expect(
      buildEnsureFreshArgsForVisibleAssetGroups({intervals: ['ALL']}).assetRefs,
    ).toEqual([{coin: 'btc'}, {coin: 'ltc'}]);
  });

  it('coalesces overlapping dependency fetches and schedules forced follow-up after start', async () => {
    let releaseFirstFetch: (() => void) | undefined;
    const executor = jest.fn(
      async (dependencies: readonly RateFetchDependency[]) => {
        await new Promise<void>(resolve => {
          releaseFirstFetch = resolve;
        });
        return dependencies.map(
          dependency =>
            ({
              dependency,
              series: {fetchedOn: 123, points: [{ts: 1, rate: 100}]},
            } satisfies RateFetchRuntimeResult),
        );
      },
    );
    setRateFetchExecutorForTesting(executor);

    const first = ensureFresh({
      quoteCurrency: 'USD',
      assetRefs: [{coin: 'btc'}],
      intervals: ['ALL'],
      force: true,
    });
    const second = ensureFresh({
      quoteCurrency: 'USD',
      assetRefs: [{coin: 'btc'}],
      intervals: ['ALL'],
      force: true,
    });

    await flushRateFetchMicrotasks();
    expect(executor).toHaveBeenCalledTimes(1);
    releaseFirstFetch?.();
    await Promise.all([first, second]);
    expect(executor).toHaveBeenCalledTimes(1);

    const releaseCalls: Array<() => void> = [];
    const followUpExecutor = jest.fn(
      async (dependencies: readonly RateFetchDependency[]) => {
        await new Promise<void>(resolve => releaseCalls.push(resolve));
        return dependencies.map(
          dependency =>
            ({
              dependency,
              series: {fetchedOn: 124, points: [{ts: 1, rate: 101}]},
            } satisfies RateFetchRuntimeResult),
        );
      },
    );
    setRateFetchExecutorForTesting(followUpExecutor);

    const background = ensureQuoteCurrencyFxBridge({
      quoteCurrency: 'CAD',
      intervals: ['ALL'],
    });
    await flushRateFetchMicrotasks();
    const forced = ensureQuoteCurrencyFxBridge({
      quoteCurrency: 'CAD',
      intervals: ['ALL'],
      force: true,
    });
    await flushRateFetchMicrotasks();
    expect(followUpExecutor).toHaveBeenCalledTimes(1);
    releaseCalls[0]?.();
    await flushRateFetchMicrotasks();
    expect(followUpExecutor).toHaveBeenCalledTimes(2);
    releaseCalls[1]?.();
    await Promise.all([background, forced]);
  });

  it('shares forced follow-up work across multiple forced callers', async () => {
    const releaseCalls: Array<() => void> = [];
    const executor = jest.fn(
      async (dependencies: readonly RateFetchDependency[]) => {
        await new Promise<void>(resolve => releaseCalls.push(resolve));
        return dependencies.map(
          dependency =>
            ({
              dependency,
              series: {
                fetchedOn: 123 + releaseCalls.length,
                points: [{ts: 1, rate: 100}],
              },
            } satisfies RateFetchRuntimeResult),
        );
      },
    );
    setRateFetchExecutorForTesting(executor);

    const background = ensureFresh({
      quoteCurrency: 'USD',
      assetRefs: [{coin: 'btc'}],
      intervals: ['ALL'],
    });
    await flushRateFetchMicrotasks();
    const forcedA = ensureFresh({
      quoteCurrency: 'USD',
      assetRefs: [{coin: 'btc'}],
      intervals: ['ALL'],
      force: true,
    });
    const forcedB = ensureFresh({
      quoteCurrency: 'USD',
      assetRefs: [{coin: 'btc'}],
      intervals: ['ALL'],
      force: true,
    });
    await flushRateFetchMicrotasks();

    expect(executor).toHaveBeenCalledTimes(1);
    releaseCalls[0]?.();
    await flushRateFetchMicrotasks();
    expect(executor).toHaveBeenCalledTimes(2);
    releaseCalls[1]?.();
    await Promise.all([background, forcedA, forcedB]);
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it('does not schedule forced follow-up for already-forced in-flight work', async () => {
    const releaseCalls: Array<() => void> = [];
    const executor = jest.fn(
      async (dependencies: readonly RateFetchDependency[]) => {
        await new Promise<void>(resolve => releaseCalls.push(resolve));
        return dependencies.map(
          dependency =>
            ({
              dependency,
              series: {fetchedOn: 123, points: [{ts: 1, rate: 100}]},
            } satisfies RateFetchRuntimeResult),
        );
      },
    );
    setRateFetchExecutorForTesting(executor);

    const forcedA = ensureFresh({
      quoteCurrency: 'USD',
      assetRefs: [{coin: 'btc'}],
      intervals: ['ALL'],
      force: true,
    });
    await flushRateFetchMicrotasks();
    expect(executor).toHaveBeenCalledTimes(1);

    const forcedB = ensureFresh({
      quoteCurrency: 'USD',
      assetRefs: [{coin: 'btc'}],
      intervals: ['ALL'],
      force: true,
    });
    await flushRateFetchMicrotasks();
    expect(executor).toHaveBeenCalledTimes(1);

    releaseCalls[0]?.();
    await Promise.all([forcedA, forcedB]);
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('does not let a new epoch wait on stale in-flight work', async () => {
    mockMmkv.set(PORTFOLIO_WORK_EPOCH_KEY, '1');
    let releaseStale: (() => void) | undefined;
    const executor = jest.fn(
      async (
        dependencies: readonly RateFetchDependency[],
        _cfg,
        startEpoch,
      ) => {
        if (startEpoch === 1) {
          await new Promise<void>(resolve => {
            releaseStale = resolve;
          });
        }
        return dependencies.map(
          dependency =>
            ({
              dependency,
              series: {
                fetchedOn: 200 + startEpoch,
                points: [{ts: 1, rate: 100 + startEpoch}],
              },
            } satisfies RateFetchRuntimeResult),
        );
      },
    );
    setRateFetchExecutorForTesting(executor);

    const stale = ensureFresh({
      quoteCurrency: 'USD',
      assetRefs: [{coin: 'btc'}],
      intervals: ['ALL'],
      startEpoch: 1,
    });
    await flushRateFetchMicrotasks();
    mockMmkv.set(PORTFOLIO_WORK_EPOCH_KEY, '2');
    await ensureFresh({
      quoteCurrency: 'USD',
      assetRefs: [{coin: 'btc'}],
      intervals: ['ALL'],
      startEpoch: 2,
    });
    releaseStale?.();
    await stale;

    expect(executor).toHaveBeenCalledTimes(2);
    expect(executor.mock.calls.map(call => call[2])).toEqual([1, 2]);
    expect(mockMmkv.getString(btcAllKey)).toBe('{"v":3,"f":202,"p":[[1,102]]}');
  });

  it('cleans in-flight state after executor failure and stale discard', async () => {
    mockMmkv.set(PORTFOLIO_WORK_EPOCH_KEY, '1');
    const failingExecutor = jest.fn(async () => {
      throw new Error('network down');
    });
    setRateFetchExecutorForTesting(failingExecutor);

    await ensureFresh({
      quoteCurrency: 'USD',
      assetRefs: [{coin: 'btc'}],
      intervals: ['ALL'],
      force: true,
      startEpoch: 1,
    });
    await ensureFresh({
      quoteCurrency: 'USD',
      assetRefs: [{coin: 'btc'}],
      intervals: ['ALL'],
      force: true,
      startEpoch: 1,
    });
    expect(failingExecutor).toHaveBeenCalledTimes(2);

    const staleExecutor = jest.fn(
      async (dependencies: readonly RateFetchDependency[]) => {
        mockMmkv.set(PORTFOLIO_WORK_EPOCH_KEY, '2');
        return dependencies.map(
          dependency =>
            ({
              dependency,
              series: {fetchedOn: 300, points: [{ts: 1, rate: 101}]},
            } satisfies RateFetchRuntimeResult),
        );
      },
    );
    clearRateFetchRetryStateForTesting();
    mockMmkv.set(PORTFOLIO_WORK_EPOCH_KEY, '1');
    setRateFetchExecutorForTesting(staleExecutor);
    await ensureFresh({
      quoteCurrency: 'USD',
      assetRefs: [{coin: 'btc'}],
      intervals: ['ALL'],
      force: true,
      startEpoch: 1,
    });
    await ensureFresh({
      quoteCurrency: 'USD',
      assetRefs: [{coin: 'btc'}],
      intervals: ['ALL'],
      force: true,
      startEpoch: 2,
    });
    expect(staleExecutor).toHaveBeenCalledTimes(2);
  });

  it('bounds token request concurrency and returns partial token failures', async () => {
    let active = 0;
    let maxActive = 0;
    const tokenDependencies: RateFetchDependency[] = Array.from(
      {length: PORTFOLIO_RATE_FETCH_MAX_PARALLEL_TOKEN_REQUESTS + 3},
      (_value, index) => ({
        quoteCurrency: 'USD',
        asset: {
          coin: `tok${index}`,
          chain: 'eth',
          tokenAddress: `0x${String(index + 1).padStart(40, '0')}`,
        },
        storedInterval: 'ALL',
      }),
    );
    const results = await fetchTokenBatchesWithLimitForTesting(
      tokenDependencies.map(dependency => [dependency]),
      {},
      async dependency => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        return dependency.asset.coin === 'tok2'
          ? {dependency, errorKind: 'network'}
          : {
              dependency,
              series: {fetchedOn: 123, points: [{ts: 1, rate: 1}]},
            };
      },
    );

    expect(maxActive).toBeLessThanOrEqual(
      PORTFOLIO_RATE_FETCH_MAX_PARALLEL_TOKEN_REQUESTS,
    );
    expect(results).toHaveLength(tokenDependencies.length);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dependency: tokenDependencies[2],
          errorKind: 'network',
        }),
      ]),
    );
  });

  it('exposes the bounded token parallelism cap', () => {
    expect(PORTFOLIO_RATE_FETCH_MAX_PARALLEL_TOKEN_REQUESTS).toBeGreaterThan(0);
    expect(
      Number.isInteger(PORTFOLIO_RATE_FETCH_MAX_PARALLEL_TOKEN_REQUESTS),
    ).toBe(true);
  });
});
