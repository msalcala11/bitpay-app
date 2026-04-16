import {
  clearPortfolioWithRuntime,
  clearWalletPortfolioDataWithRuntime,
  populatePortfolioWithRuntime,
} from './portfolio.runtime.effects';
import {PortfolioActionTypes} from './portfolio.types';
import {getPortfolioRuntimeClient} from '../../portfolio/runtime/portfolioRuntime';
import {PortfolioPopulateService} from '../../portfolio/service';
import {
  isPortfolioRuntimeEligibleWallet,
  toPortfolioStoredWallet,
} from '../../portfolio/adapters/rn/walletMappers';
import {walletHasNonZeroLiveBalance} from '../../utils/portfolio/assets';
import {GetPrecision} from '../wallet/utils/currency';

jest.mock('../../portfolio/runtime/portfolioRuntime', () => ({
  getPortfolioRuntimeClient: jest.fn(),
}));

jest.mock('../../portfolio/service', () => ({
  PortfolioPopulateService: jest.fn(),
  getPortfolioPopulateDecisionsForWallets: jest.fn(),
}));

jest.mock('../../portfolio/adapters/rn/walletMappers', () => ({
  isPortfolioRuntimeEligibleWallet: jest.fn(),
  toPortfolioStoredWallet: jest.fn(),
}));

jest.mock('../../utils/portfolio/assets', () => ({
  getVisibleWalletsFromKeys: jest.fn(() => []),
  walletHasNonZeroLiveBalance: jest.fn(),
}));

jest.mock('../wallet/utils/currency', () => ({
  GetPrecision: jest.fn(),
}));

jest.mock('../../managers/LogManager', () => ({
  logManager: {
    warn: jest.fn(),
  },
}));

describe('portfolio.runtime.effects', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('clears runtime storage and resets redux portfolio state', async () => {
    const client = {
      clearAllStorage: jest.fn().mockResolvedValue(undefined),
      cancelPopulateJob: jest.fn().mockResolvedValue({inProgress: false}),
      getPopulateJobStatus: jest.fn().mockResolvedValue({inProgress: false}),
      kvStats: jest.fn().mockResolvedValue({totalKeys: 0}),
      listRates: jest.fn().mockResolvedValue([]),
    } as any;
    (getPortfolioRuntimeClient as jest.Mock).mockReturnValue(client);

    const dispatched: any[] = [];
    const dispatch = (action: any) => {
      dispatched.push(action);
      return action;
    };
    const getState = () => ({
      PORTFOLIO: {
        populateStatus: {
          inProgress: true,
        },
      },
    });

    await clearPortfolioWithRuntime({populateDisabled: false})(
      dispatch as any,
      getState as any,
    );

    expect(client.clearAllStorage).toHaveBeenCalledTimes(1);
    expect(client.kvStats).toHaveBeenCalledTimes(1);
    expect(client.listRates).toHaveBeenCalledTimes(1);
    expect(dispatched.map(action => action.type)).toEqual([
      PortfolioActionTypes.CANCEL_POPULATE_PORTFOLIO,
      PortfolioActionTypes.CLEAR_PORTFOLIO,
    ]);
  });

  it('retries clearing runtime storage if the populate job is still stopping', async () => {
    const client = {
      clearAllStorage: jest
        .fn()
        .mockRejectedValueOnce(
          new Error(
            'Cannot clear portfolio storage while a background populate job is running.',
          ),
        )
        .mockResolvedValue(undefined),
      cancelPopulateJob: jest.fn().mockResolvedValue({inProgress: false}),
      getPopulateJobStatus: jest.fn().mockResolvedValue({inProgress: false}),
      kvStats: jest.fn().mockResolvedValue({totalKeys: 0}),
      listRates: jest.fn().mockResolvedValue([]),
    } as any;
    (getPortfolioRuntimeClient as jest.Mock).mockReturnValue(client);

    const dispatched: any[] = [];
    const dispatch = (action: any) => {
      dispatched.push(action);
      return action;
    };
    const getState = () => ({
      PORTFOLIO: {
        populateStatus: {
          inProgress: true,
        },
      },
    });

    await clearPortfolioWithRuntime({populateDisabled: false})(
      dispatch as any,
      getState as any,
    );

    expect(client.clearAllStorage).toHaveBeenCalledTimes(2);
    expect(client.cancelPopulateJob).toHaveBeenCalledTimes(2);
    expect(client.kvStats).toHaveBeenCalledTimes(1);
    expect(client.listRates).toHaveBeenCalledTimes(1);
    expect(dispatched.map(action => action.type)).toEqual([
      PortfolioActionTypes.CANCEL_POPULATE_PORTFOLIO,
      PortfolioActionTypes.CLEAR_PORTFOLIO,
    ]);
  });

  it('waits for runtime storage verification to finish before clearing redux state', async () => {
    const client = {
      clearAllStorage: jest.fn().mockResolvedValue(undefined),
      cancelPopulateJob: jest.fn().mockResolvedValue({inProgress: false}),
      getPopulateJobStatus: jest.fn().mockResolvedValue({inProgress: false}),
      kvStats: jest
        .fn()
        .mockResolvedValueOnce({totalKeys: 2})
        .mockResolvedValueOnce({totalKeys: 0}),
      listRates: jest.fn().mockResolvedValue([]),
    } as any;
    (getPortfolioRuntimeClient as jest.Mock).mockReturnValue(client);

    const dispatched: any[] = [];
    const dispatch = (action: any) => {
      dispatched.push(action);
      return action;
    };
    const getState = () => ({
      WALLET: {
        keys: {},
      },
      PORTFOLIO: {
        populateStatus: {
          inProgress: false,
        },
      },
    });

    await clearPortfolioWithRuntime({populateDisabled: false})(
      dispatch as any,
      getState as any,
    );

    expect(client.clearAllStorage).toHaveBeenCalledTimes(1);
    expect(client.kvStats).toHaveBeenCalledTimes(2);
    expect(client.listRates).toHaveBeenCalledTimes(1);
    expect(dispatched.map(action => action.type)).toEqual([
      PortfolioActionTypes.CLEAR_PORTFOLIO,
    ]);
  });

  it('throws when runtime clear fails and preserves redux portfolio state', async () => {
    const client = {
      clearAllStorage: jest
        .fn()
        .mockRejectedValue(new Error('MMKV clear failed hard.')),
      cancelPopulateJob: jest.fn().mockResolvedValue({inProgress: false}),
      getPopulateJobStatus: jest.fn().mockResolvedValue({inProgress: false}),
      kvStats: jest.fn(),
      listRates: jest.fn(),
    } as any;
    (getPortfolioRuntimeClient as jest.Mock).mockReturnValue(client);

    const dispatched: any[] = [];
    const dispatch = (action: any) => {
      dispatched.push(action);
      return action;
    };
    const getState = () => ({
      WALLET: {
        keys: {},
      },
      PORTFOLIO: {
        populateStatus: {
          inProgress: false,
        },
      },
    });

    await expect(
      clearPortfolioWithRuntime({populateDisabled: false})(
        dispatch as any,
        getState as any,
      ),
    ).rejects.toThrow('MMKV clear failed hard.');

    expect(dispatched).toEqual([]);
    expect(client.kvStats).not.toHaveBeenCalled();
    expect(client.listRates).not.toHaveBeenCalled();
  });

  it('clears wallet-scoped runtime storage and removes wallet state entries', async () => {
    const client = {
      clearWallet: jest.fn().mockResolvedValue(undefined),
      cancelPopulateJob: jest.fn().mockResolvedValue({inProgress: false}),
      getPopulateJobStatus: jest.fn().mockResolvedValue({inProgress: false}),
    } as any;
    (getPortfolioRuntimeClient as jest.Mock).mockReturnValue(client);

    const dispatched: any[] = [];
    const dispatch = (action: any) => {
      dispatched.push(action);
      return action;
    };
    const getState = () => ({
      PORTFOLIO: {
        populateStatus: {
          inProgress: false,
        },
      },
    });

    await clearWalletPortfolioDataWithRuntime({
      walletIds: ['w1', 'w2', 'w1'],
    })(dispatch as any, getState as any);

    expect(client.clearWallet).toHaveBeenCalledTimes(2);
    expect(client.clearWallet).toHaveBeenNthCalledWith(1, {walletId: 'w1'});
    expect(client.clearWallet).toHaveBeenNthCalledWith(2, {walletId: 'w2'});
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      type: PortfolioActionTypes.CLEAR_WALLET_PORTFOLIO_STATE,
      payload: {walletIds: ['w1', 'w2']},
    });
  });

  it('includes a human-readable stop reason in FINISH_POPULATE_PORTFOLIO', async () => {
    const client = {} as any;
    const precisionRequest = {type: 'TEST_PRECISION'};
    const wallet = {
      id: 'w1',
      network: 'livenet',
      chain: 'btc',
      currencyAbbreviation: 'btc',
      tokenAddress: undefined,
    } as any;
    const storedWallet = {
      walletId: 'w1',
      credentials: {walletId: 'w1'},
      summary: {walletId: 'w1'},
      addedAt: 1,
    } as any;
    const populateWallets = jest.fn(async () => {
      return {
        startedAt: 1,
        finishedAt: 10,
        cancelled: false,
        disabledForLargeHistory: false,
        status: {
          jobId: 'job-1',
          state: 'completed',
          inProgress: false,
          startedAt: 1,
          finishedAt: 10,
          currentWalletId: 'w1',
          walletsTotal: 1,
          walletsCompleted: 1,
          txRequestsMade: 1,
          txsProcessed: 0,
          walletStatusById: {w1: 'error'},
          errors: [
            {
              walletId: 'w1',
              message: 'BWS txhistory request failed with status 401.',
            },
          ],
          disabledForLargeHistory: false,
          lastUpdatedAt: 10,
        },
        results: [
          {
            walletId: 'w1',
            prepared: null,
            processResults: [],
            finished: null,
            appendedSnapshots: 0,
            txRequestsMade: 1,
            txsProcessed: 0,
            cancelled: false,
            disabledForLargeHistory: false,
          },
        ],
      };
    });

    (getPortfolioRuntimeClient as jest.Mock).mockReturnValue(client);
    (GetPrecision as jest.Mock).mockReturnValue(precisionRequest);
    (walletHasNonZeroLiveBalance as jest.Mock).mockReturnValue(true);
    (isPortfolioRuntimeEligibleWallet as jest.Mock).mockReturnValue(true);
    (toPortfolioStoredWallet as jest.Mock).mockReturnValue(storedWallet);
    (PortfolioPopulateService as unknown as jest.Mock).mockImplementation(
      () => ({
        populateWallets,
        cancel: jest.fn(),
      }),
    );

    const dispatched: any[] = [];
    const dispatch = (action: any) => {
      if (action === precisionRequest) {
        return {unitDecimals: 8};
      }
      dispatched.push(action);
      return action;
    };
    const getState = () => ({
      APP: {
        showPortfolioValue: true,
        defaultAltCurrency: {isoCode: 'USD'},
      },
      PORTFOLIO: {
        populateDisabled: false,
        populateStatus: {
          inProgress: false,
        },
      },
    });

    await populatePortfolioWithRuntime({wallets: [wallet]})(
      dispatch as any,
      getState as any,
    );

    const finishAction = dispatched.find(
      action => action.type === PortfolioActionTypes.FINISH_POPULATE_PORTFOLIO,
    );

    expect(populateWallets).toHaveBeenCalledTimes(1);
    expect(finishAction).toMatchObject({
      type: PortfolioActionTypes.FINISH_POPULATE_PORTFOLIO,
      payload: {
        finishedAt: 10,
        reason:
          'completed with wallet error: w1: BWS txhistory request failed with status 401.',
      },
    });
  });

  it('clears stored mismatch flags for wallets that finished populating successfully', async () => {
    const client = {} as any;
    const precisionRequest = {type: 'TEST_PRECISION'};
    const wallet = {
      id: 'w1',
      network: 'livenet',
      chain: 'btc',
      currencyAbbreviation: 'btc',
      tokenAddress: undefined,
    } as any;
    const storedWallet = {
      walletId: 'w1',
      credentials: {walletId: 'w1'},
      summary: {walletId: 'w1'},
      addedAt: 1,
    } as any;
    const populateWallets = jest.fn(async () => {
      return {
        startedAt: 1,
        finishedAt: 10,
        cancelled: false,
        disabledForLargeHistory: false,
        status: {
          jobId: 'job-1',
          state: 'completed',
          inProgress: false,
          startedAt: 1,
          finishedAt: 10,
          currentWalletId: undefined,
          walletsTotal: 1,
          walletsCompleted: 1,
          txRequestsMade: 1,
          txsProcessed: 1,
          walletStatusById: {w1: 'done'},
          errors: [],
          disabledForLargeHistory: false,
          lastUpdatedAt: 10,
        },
        results: [
          {
            walletId: 'w1',
            prepared: {checkpoint: {nextSkip: 0}},
            processResults: [],
            finished: {checkpoint: {nextSkip: 1}, appendedSnapshots: 1},
            appendedSnapshots: 1,
            txRequestsMade: 1,
            txsProcessed: 1,
            cancelled: false,
            disabledForLargeHistory: false,
          },
        ],
      };
    });

    (getPortfolioRuntimeClient as jest.Mock).mockReturnValue(client);
    (GetPrecision as jest.Mock).mockReturnValue(precisionRequest);
    (walletHasNonZeroLiveBalance as jest.Mock).mockReturnValue(true);
    (isPortfolioRuntimeEligibleWallet as jest.Mock).mockReturnValue(true);
    (toPortfolioStoredWallet as jest.Mock).mockReturnValue(storedWallet);
    (PortfolioPopulateService as unknown as jest.Mock).mockImplementation(
      () => ({
        populateWallets,
        cancel: jest.fn(),
      }),
    );

    const dispatched: any[] = [];
    const dispatch = (action: any) => {
      if (action === precisionRequest) {
        return {unitDecimals: 8};
      }
      dispatched.push(action);
      return action;
    };
    const getState = () => ({
      APP: {
        showPortfolioValue: true,
        defaultAltCurrency: {isoCode: 'USD'},
      },
      PORTFOLIO: {
        populateDisabled: false,
        populateStatus: {
          inProgress: false,
        },
        snapshotBalanceMismatchesByWalletId: {
          w1: {
            walletId: 'w1',
            computedUnitsHeld: '0',
            currentWalletBalance: '1',
            delta: '-1',
          },
        },
      },
    });

    await populatePortfolioWithRuntime({wallets: [wallet]})(
      dispatch as any,
      getState as any,
    );

    expect(dispatched).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: PortfolioActionTypes.SET_SNAPSHOT_BALANCE_MISMATCHES_BY_WALLET_ID_UPDATES,
          payload: {w1: undefined},
        }),
      ]),
    );
  });
});
