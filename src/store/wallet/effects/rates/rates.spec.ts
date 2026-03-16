jest.mock(
  '@env',
  () => ({
    BASE_FIATRATES_MARKETSTATS_URL_DEVELOPMENT: '',
  }),
  {virtual: true},
);

jest.mock('../../../../constants/config', () => ({
  BASE_BWS_URL: 'https://bws.test',
}));

jest.mock('../../../../constants/currencies', () => ({
  SUPPORTED_VM_TOKENS: [],
}));

jest.mock('../../../../constants/tokens', () => ({
  BitpaySupportedTokenOptsByAddress: {},
}));

jest.mock('../../../../utils/helper-methods', () => ({
  addTokenChainSuffix: jest.fn(),
  getLastDayTimestampStartOfHourMs: () => 0,
  getErrorString: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

jest.mock('../../../../store/moralis/moralis.effects', () => ({
  getMultipleTokenPrices: jest.fn(),
}));

jest.mock('../../../../store/buy-crypto/buy-crypto.effects', () => ({
  calculateUsdToAltFiat: jest.fn(),
}));

jest.mock('../../utils/currency', () => ({
  IsERCToken: jest.fn(),
}));

jest.mock('../../utils/wallet', () => ({
  isCacheKeyStale: jest.fn(() => false),
}));

jest.mock('../../../../managers/TokenManager', () => ({
  tokenManager: {
    getTokenOptions: () => ({
      tokenOptionsByAddress: {},
    }),
  },
}));

jest.mock('../../../../managers/LogManager', () => ({
  logManager: {
    info: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    isAxiosError: (error: unknown) => Boolean((error as any)?.isAxiosError),
  },
}));

import axios from 'axios';
import {rateReducer} from '../../../rate/rate.reducer';
import {getFiatRateSeriesCacheKey} from '../../../rate/rate.models';
import {fetchFiatRateSeriesInterval} from './rates';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error?: unknown) => void;
};

const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {promise, resolve, reject};
};

const createThunkHarness = () => {
  let state = {
    RATE: rateReducer(undefined, {type: '@@INIT'} as any),
  };
  const actions: any[] = [];

  const getState = () => state as any;
  const dispatch = (action: any): any => {
    if (typeof action === 'function') {
      return action(dispatch, getState);
    }

    actions.push(action);
    state = {
      ...state,
      RATE: rateReducer(state.RATE, action),
    };
    return action;
  };

  return {
    dispatch,
    getState,
    getActions: () => actions.slice(),
  };
};

describe('fetchFiatRateSeriesInterval', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('dedupes concurrent requests for the same asset-specific identity', async () => {
    const deferred = createDeferred<{
      data: Array<{ts: number; rate: number}>;
    }>();
    (axios.get as jest.Mock).mockImplementation(() => deferred.promise);

    const {dispatch, getState} = createThunkHarness();
    const args = {
      fiatCode: 'USD',
      interval: 'ALL' as const,
      coinForCacheCheck: 'usdc',
      coin: 'usdc',
      chain: 'eth',
      tokenAddress: '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    };

    const requestA = fetchFiatRateSeriesInterval(args)(dispatch, getState);
    const requestB = fetchFiatRateSeriesInterval(args)(dispatch, getState);

    expect(axios.get).toHaveBeenCalledTimes(1);

    deferred.resolve({
      data: [
        {ts: 1, rate: 1},
        {ts: 2, rate: 1.01},
      ],
    });

    await expect(Promise.all([requestA, requestB])).resolves.toEqual([
      true,
      true,
    ]);

    expect(getState().RATE.fiatRateSeriesCache).toEqual({
      [getFiatRateSeriesCacheKey('USD', 'usdc', 'ALL', {
        chain: 'eth',
        tokenAddress: '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      })]: {
        fetchedOn: expect.any(Number),
        points: [
          {ts: 1, rate: 1},
          {ts: 2, rate: 1.01},
        ],
      },
    });
  });

  it('does not collide same-coin requests for different token identities', async () => {
    const deferredEth = createDeferred<{
      data: Array<{ts: number; rate: number}>;
    }>();
    const deferredBase = createDeferred<{
      data: Array<{ts: number; rate: number}>;
    }>();

    (axios.get as jest.Mock)
      .mockImplementationOnce(() => deferredEth.promise)
      .mockImplementationOnce(() => deferredBase.promise);

    const {dispatch, getState} = createThunkHarness();

    const ethArgs = {
      fiatCode: 'USD',
      interval: 'ALL' as const,
      coinForCacheCheck: 'usdc',
      coin: 'usdc',
      chain: 'eth',
      tokenAddress: '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    };
    const baseArgs = {
      fiatCode: 'USD',
      interval: 'ALL' as const,
      coinForCacheCheck: 'usdc',
      coin: 'usdc',
      chain: 'base',
      tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    };

    const ethRequest = fetchFiatRateSeriesInterval(ethArgs)(dispatch, getState);
    const baseRequest = fetchFiatRateSeriesInterval(baseArgs)(
      dispatch,
      getState,
    );

    expect(axios.get).toHaveBeenCalledTimes(2);

    deferredEth.resolve({
      data: [
        {ts: 1, rate: 1},
        {ts: 2, rate: 1.01},
      ],
    });
    deferredBase.resolve({
      data: [
        {ts: 1, rate: 2},
        {ts: 2, rate: 2.02},
      ],
    });

    await expect(Promise.all([ethRequest, baseRequest])).resolves.toEqual([
      true,
      true,
    ]);

    expect(getState().RATE.fiatRateSeriesCache).toEqual({
      [getFiatRateSeriesCacheKey('USD', 'usdc', 'ALL', {
        chain: 'eth',
        tokenAddress: '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      })]: {
        fetchedOn: expect.any(Number),
        points: [
          {ts: 1, rate: 1},
          {ts: 2, rate: 1.01},
        ],
      },
      [getFiatRateSeriesCacheKey('USD', 'usdc', 'ALL', {
        chain: 'base',
        tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      })]: {
        fetchedOn: expect.any(Number),
        points: [
          {ts: 1, rate: 2},
          {ts: 2, rate: 2.02},
        ],
      },
    });
  });
});
