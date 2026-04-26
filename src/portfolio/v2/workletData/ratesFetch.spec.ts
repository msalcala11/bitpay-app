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
    box: (...args: unknown[]) => mockNitroModulesBox(...args),
    createHybridObject: (...args: unknown[]) => mockCreateHybridObject(...args),
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
import {PORTFOLIO_WORK_EPOCH_KEY} from '../constants';
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
  initPortfolioReduxAccess,
  resetPortfolioReduxAccessForTesting,
} from '../reduxAccess';
import {getRateKey} from './ratesKv';
import {
  buildEnsureFreshDependencies,
  clearRateFetchRetryStateForTesting,
  ensureFresh,
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
    const executor = jest.fn(async (dependencies: readonly RateFetchDependency[]) =>
      dependencies.map(
        dependency =>
          ({
            dependency,
            series: {fetchedOn: 123, points: [{ts: 1, rate: 100}]},
          }) satisfies RateFetchRuntimeResult,
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

  it('records retry state and prevents background fetch spin until forced', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(10_000);
    const failingExecutor = jest.fn(
      async (dependencies: readonly RateFetchDependency[]) =>
      dependencies.map(
        dependency =>
          ({
            dependency,
            errorKind: 'network' as const,
          }) satisfies RateFetchRuntimeResult,
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
          }) satisfies RateFetchRuntimeResult,
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
          }) satisfies RateFetchRuntimeResult,
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
          }) satisfies RateFetchRuntimeResult,
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
    (runOnRuntimeAsync as jest.Mock).mockImplementationOnce(
      async (
        _runtime: unknown,
        workletFn: (...args: any[]) => unknown,
        ...args: any[]
      ) => workletFn(...args),
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
    expect(mockMmkv.getString(btcAllKey)).toBe('{"v":3,"f":123,"p":[[1,100]]}');
    expect(
      txHistorySigning.getPortfolioTxHistorySigningDispatchContextOnRuntime(),
    ).toBeUndefined();
    expect(() =>
      txHistorySigning.takeNextPortfolioTransferredSignHandleOnRuntime(),
    ).toThrow('No portfolio runtime request context is initialized');
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

    expect(mockNitroRequestSync).toHaveBeenCalledTimes(2);
    const dispatchContext = (runOnRuntimeAsync as jest.Mock).mock.calls[0][4];
    expect(dispatchContext).toEqual(expect.objectContaining({requestCount: 2}));
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

  it('drops fetched results when the work epoch changes before persist', async () => {
    mockMmkv.set(PORTFOLIO_WORK_EPOCH_KEY, '1');
    setRateFetchExecutorForTesting(async dependencies => {
      mockMmkv.set(PORTFOLIO_WORK_EPOCH_KEY, '2');
      return dependencies.map(
        dependency =>
          ({
            dependency,
            series: {fetchedOn: 123, points: [{ts: 1, rate: 100}]},
          }) satisfies RateFetchRuntimeResult,
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
    setRateFetchExecutorForTesting(async dependencies => dependencies.slice(0, 1).map(
      dependency =>
        ({
          dependency,
          series: {fetchedOn: 123, points: [{ts: 1, rate: 100}]},
        }) satisfies RateFetchRuntimeResult,
    ));

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

  it('builds populate dependencies from hidden eligible wallets but visible dependencies from visible wallets', () => {
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
                  },
                  {
                    id: 'hidden-eth',
                    chain: 'eth',
                    network: 'livenet',
                    currencyAbbreviation: 'eth',
                    hideWallet: true,
                  },
                  {
                    id: 'testnet-doge',
                    chain: 'doge',
                    network: 'testnet',
                    currencyAbbreviation: 'doge',
                  },
                ],
              },
            },
          },
        }) as any,
    } as any);

    expect(
      buildEnsureFreshArgsForPopulateEligibleAssetGroups({
        intervals: ['ALL'],
      }).assetRefs,
    ).toEqual([{coin: 'btc'}, {coin: 'eth'}]);
    expect(
      buildEnsureFreshArgsForVisibleAssetGroups({intervals: ['ALL']}).assetRefs,
    ).toEqual([{coin: 'btc'}]);
  });
});
