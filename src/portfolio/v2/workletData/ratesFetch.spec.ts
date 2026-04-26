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
  mockMmkv.data.clear();
  resetPortfolioKvStoreForTesting();
  resetPortfolioReduxAccessForTesting();
  clearRecordedPortfolioV2MetricsForTesting();
  clearPortfolioRuntimeLogPayloadsForTesting();
  clearRateFetchRetryStateForTesting();
});

const btcAllKey = getRateKey({
  quoteCurrency: 'USD',
  asset: {coin: 'btc'},
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
        quoteCurrency: 'EUR',
        asset: {coin: 'eth', chain: undefined, tokenAddress: undefined},
        storedInterval: '1D',
      },
      {
        quoteCurrency: 'EUR',
        asset: {coin: 'eth', chain: undefined, tokenAddress: undefined},
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
    ]);
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
        startEpoch: 1,
        currentEpoch: 2,
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
