jest.mock('../../../index', () => ({}));

const mockEmit = jest.fn();
jest.mock('react-native', () => ({
  DeviceEventEmitter: {
    emit: (...args: unknown[]) => mockEmit(...args),
  },
}));

const mockStartUpdateWalletStatus = jest.fn();
jest.mock('./status', () => ({
  startUpdateWalletStatus: (...args: unknown[]) =>
    mockStartUpdateWalletStatus(...args),
}));

const mockMaybePopulatePortfolioForWallets = jest.fn();
jest.mock('../../../portfolio', () => ({
  maybePopulatePortfolioForWallets: (...args: unknown[]) =>
    mockMaybePopulatePortfolioForWallets(...args),
}));

const mockGetQuoteCurrency = jest.fn();
jest.mock('../../../../utils/portfolio/assets', () => ({
  getQuoteCurrency: (...args: unknown[]) => mockGetQuoteCurrency(...args),
}));

const mockFindWalletById = jest.fn();
jest.mock('../../utils/wallet', () => ({
  findWalletById: (...args: unknown[]) => mockFindWalletById(...args),
}));

const mockLogError = jest.fn();
jest.mock('../../../../managers/LogManager', () => ({
  logManager: {
    error: (...args: unknown[]) => mockLogError(...args),
  },
}));

import {DeviceEmitterEvents} from '../../../../constants/device-emitter-events';
import {WalletActionTypes} from '../../wallet.types';
import {waitForTargetAmountAndUpdateWallet} from './waitForTargetAmountAndUpdateWallet';

let mockNow = 0;

const flushPromises = async (iterations = 8) => {
  for (let i = 0; i < iterations; i += 1) {
    await Promise.resolve();
  }
};

const advanceTime = async (ms: number, flushIterations = 8) => {
  mockNow += ms;
  jest.advanceTimersByTime(ms);
  await flushPromises(flushIterations);
};

const createWallet = (overrides: Partial<any> = {}) => {
  const wallet = {
    id: 'wallet-1',
    chain: 'eth',
    network: 'livenet',
    balance: {
      sat: 1000,
    },
    credentials: {
      token: undefined,
      multisigEthInfo: undefined,
    },
    getStatus: jest.fn(),
    ...overrides,
  };

  wallet.balance = {
    sat: 1000,
    ...(overrides.balance || {}),
  };
  wallet.credentials = {
    token: undefined,
    multisigEthInfo: undefined,
    ...(overrides.credentials || {}),
  };

  return wallet;
};

const createState = ({key, recipientKey}: {key: any; recipientKey?: any}) => {
  const keys: Record<string, any> = {
    [key.id]: key,
  };

  if (recipientKey) {
    keys[recipientKey.id] = recipientKey;
  }

  return {
    WALLET: {keys},
    PORTFOLIO: {quoteCurrency: 'usd'},
    APP: {defaultAltCurrency: {isoCode: 'usd'}},
  };
};

describe('waitForTargetAmountAndUpdateWallet', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockNow = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => mockNow);

    mockStartUpdateWalletStatus.mockImplementation((args: unknown) => ({
      type: 'START_UPDATE_WALLET_STATUS',
      payload: args,
    }));
    mockMaybePopulatePortfolioForWallets.mockImplementation(
      (args: unknown) => ({
        type: 'MAYBE_POPULATE_PORTFOLIO',
        payload: args,
      }),
    );
    mockGetQuoteCurrency.mockReturnValue('usd');
    mockFindWalletById.mockImplementation((wallets: any[], walletId: string) =>
      wallets.find(wallet => wallet.id === walletId),
    );
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('does not overlap status polls while a previous request is still in flight', async () => {
    const pendingCallbacks: Array<(err?: unknown, status?: any) => void> = [];
    const wallet = createWallet({
      getStatus: jest.fn(
        (_opts: unknown, cb: (err?: unknown, status?: any) => void) => {
          pendingCallbacks.push(cb);
        },
      ),
    });
    const key = {id: 'key-1', wallets: [wallet]};
    const getState = () => createState({key});
    const dispatch = jest.fn((action: unknown) => Promise.resolve(action));

    await waitForTargetAmountAndUpdateWallet({
      key,
      wallet,
      targetAmount: 500,
    })(dispatch, getState);

    await advanceTime(5000);
    expect(wallet.getStatus).toHaveBeenCalledTimes(1);

    await advanceTime(15000);
    expect(wallet.getStatus).toHaveBeenCalledTimes(1);

    pendingCallbacks[0](undefined, {balance: {totalAmount: 900}});
    await flushPromises();

    await advanceTime(5000);
    expect(wallet.getStatus).toHaveBeenCalledTimes(2);
  });

  it('keeps request starts roughly 5s apart by subtracting request latency from the next delay', async () => {
    const pendingCallbacks: Array<(err?: unknown, status?: any) => void> = [];
    let requestNumber = 0;
    const wallet = createWallet({
      getStatus: jest.fn(
        (_opts: unknown, cb: (err?: unknown, status?: any) => void) => {
          requestNumber += 1;

          if (requestNumber === 1) {
            setTimeout(() => {
              cb(undefined, {balance: {totalAmount: 900}});
            }, 3000);
            return;
          }

          pendingCallbacks.push(cb);
        },
      ),
    });
    const key = {id: 'key-1', wallets: [wallet]};
    const getState = () => createState({key});
    const dispatch = jest.fn((action: unknown) => Promise.resolve(action));

    await waitForTargetAmountAndUpdateWallet({
      key,
      wallet,
      targetAmount: 500,
    })(dispatch, getState);

    await advanceTime(5000);
    expect(wallet.getStatus).toHaveBeenCalledTimes(1);

    await advanceTime(2999);
    expect(wallet.getStatus).toHaveBeenCalledTimes(1);

    await advanceTime(1, 12);
    expect(wallet.getStatus).toHaveBeenCalledTimes(1);

    await advanceTime(1999);
    expect(wallet.getStatus).toHaveBeenCalledTimes(1);

    await advanceTime(1);
    expect(wallet.getStatus).toHaveBeenCalledTimes(2);

    pendingCallbacks[0](undefined, {balance: {totalAmount: 499}});
    await flushPromises(12);
  });

  it('stops refreshing at the overall deadline when getStatus never settles', async () => {
    const pendingCallbacks: Array<(err?: unknown, status?: any) => void> = [];
    const wallet = createWallet({
      getStatus: jest.fn(
        (_opts: unknown, cb: (err?: unknown, status?: any) => void) => {
          pendingCallbacks.push(cb);
        },
      ),
    });
    const key = {id: 'key-1', wallets: [wallet]};
    const getState = () => createState({key});
    const dispatch = jest.fn((action: unknown) => Promise.resolve(action));

    await waitForTargetAmountAndUpdateWallet({
      key,
      wallet,
      targetAmount: 500,
    })(dispatch, getState);

    await advanceTime(5000);
    expect(wallet.getStatus).toHaveBeenCalledTimes(1);

    await advanceTime(25000);

    expect(mockStartUpdateWalletStatus).not.toHaveBeenCalled();
    expect(mockMaybePopulatePortfolioForWallets).not.toHaveBeenCalled();
    expect(
      mockEmit.mock.calls.filter(
        ([eventName]) => eventName === DeviceEmitterEvents.SET_REFRESHING,
      ),
    ).toEqual([[DeviceEmitterEvents.SET_REFRESHING, false]]);

    pendingCallbacks[0](undefined, {balance: {totalAmount: 499}});
    await flushPromises(12);

    expect(mockStartUpdateWalletStatus).not.toHaveBeenCalled();
    expect(mockMaybePopulatePortfolioForWallets).not.toHaveBeenCalled();
  });

  it('refreshes the source and recipient wallets once the target balance is reached or passed', async () => {
    const pendingCallbacks: Array<(err?: unknown, status?: any) => void> = [];
    const wallet = createWallet({
      getStatus: jest.fn(
        (_opts: unknown, cb: (err?: unknown, status?: any) => void) => {
          pendingCallbacks.push(cb);
        },
      ),
    });
    const recipientWallet = createWallet({id: 'wallet-2'});
    const key = {id: 'key-1', wallets: [wallet]};
    const recipientKey = {id: 'key-2', wallets: [recipientWallet]};
    const getState = () => createState({key, recipientKey});
    const dispatch = jest.fn((action: unknown) => Promise.resolve(action));

    await waitForTargetAmountAndUpdateWallet({
      key,
      wallet,
      targetAmount: 500,
      recipient: {
        walletId: recipientWallet.id,
        keyId: recipientKey.id,
      } as any,
    })(dispatch, getState);

    await advanceTime(5000);
    pendingCallbacks[0](undefined, {balance: {totalAmount: 499}});
    await flushPromises(12);

    expect(mockStartUpdateWalletStatus).toHaveBeenCalledTimes(2);
    expect(mockStartUpdateWalletStatus).toHaveBeenNthCalledWith(1, {
      key,
      wallet,
      force: true,
    });
    expect(mockStartUpdateWalletStatus).toHaveBeenNthCalledWith(2, {
      key: recipientKey,
      wallet: recipientWallet,
      force: true,
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: WalletActionTypes.UPDATE_PORTFOLIO_BALANCE,
      }),
    );
    expect(mockMaybePopulatePortfolioForWallets).toHaveBeenCalledWith({
      wallets: [wallet, recipientWallet],
      quoteCurrency: 'USD',
    });
    expect(
      mockEmit.mock.calls.filter(
        ([eventName]) => eventName === DeviceEmitterEvents.WALLET_LOAD_HISTORY,
      ),
    ).toHaveLength(2);
    expect(
      mockEmit.mock.calls.filter(
        ([eventName]) => eventName === DeviceEmitterEvents.SET_REFRESHING,
      ),
    ).toEqual([[DeviceEmitterEvents.SET_REFRESHING, false]]);

    await advanceTime(20000);
    expect(wallet.getStatus).toHaveBeenCalledTimes(1);
  });

  it('continues polling after status errors and stops refreshing after timing out', async () => {
    const wallet = createWallet({
      getStatus: jest.fn(
        (_opts: unknown, cb: (err?: unknown, status?: any) => void) => {
          cb(new Error('boom'));
        },
      ),
    });
    const key = {id: 'key-1', wallets: [wallet]};
    const getState = () => createState({key});
    const dispatch = jest.fn((action: unknown) => Promise.resolve(action));

    await waitForTargetAmountAndUpdateWallet({
      key,
      wallet,
      targetAmount: 500,
    })(dispatch, getState);

    for (let i = 0; i < 6; i += 1) {
      await advanceTime(5000);
    }

    expect(wallet.getStatus).toHaveBeenCalledTimes(5);
    expect(mockLogError).toHaveBeenCalledWith(
      'error [waitForTargetAmountAndUpdateWallet]: boom',
    );
    expect(mockStartUpdateWalletStatus).not.toHaveBeenCalled();
    expect(
      mockEmit.mock.calls.filter(
        ([eventName]) => eventName === DeviceEmitterEvents.SET_REFRESHING,
      ),
    ).toEqual([[DeviceEmitterEvents.SET_REFRESHING, false]]);
  });
});
