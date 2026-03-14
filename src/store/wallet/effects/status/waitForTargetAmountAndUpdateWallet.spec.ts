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

const flushPromises = async (iterations = 8) => {
  for (let i = 0; i < iterations; i += 1) {
    await Promise.resolve();
  }
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

const createState = ({
  key,
  recipientKey,
}: {
  key: any;
  recipientKey?: any;
}) => {
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
    jest.useRealTimers();
  });

  it('does not overlap status polls while a previous request is still in flight', async () => {
    const pendingCallbacks: Array<(err?: unknown, status?: any) => void> = [];
    const wallet = createWallet({
      getStatus: jest.fn((_opts: unknown, cb: (err?: unknown, status?: any) => void) => {
        pendingCallbacks.push(cb);
      }),
    });
    const key = {id: 'key-1', wallets: [wallet]};
    const getState = () => createState({key});
    const dispatch = jest.fn((action: unknown) => Promise.resolve(action));

    await waitForTargetAmountAndUpdateWallet({
      key,
      wallet,
      targetAmount: 500,
    })(dispatch, getState);

    jest.advanceTimersByTime(5000);
    await flushPromises();
    expect(wallet.getStatus).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(20000);
    await flushPromises();
    expect(wallet.getStatus).toHaveBeenCalledTimes(1);

    pendingCallbacks[0](undefined, {balance: {totalAmount: 900}});
    await flushPromises();

    jest.advanceTimersByTime(5000);
    await flushPromises();
    expect(wallet.getStatus).toHaveBeenCalledTimes(2);
  });

  it('refreshes the source and recipient wallets once the target balance is reached or passed', async () => {
    const pendingCallbacks: Array<(err?: unknown, status?: any) => void> = [];
    const wallet = createWallet({
      getStatus: jest.fn((_opts: unknown, cb: (err?: unknown, status?: any) => void) => {
        pendingCallbacks.push(cb);
      }),
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

    jest.advanceTimersByTime(5000);
    await flushPromises();
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

    jest.advanceTimersByTime(20000);
    await flushPromises();
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
      jest.advanceTimersByTime(5000);
      await flushPromises();
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
