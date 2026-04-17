const mockHandlePrepareWalletOnPopulateWorklet = jest.fn();
const mockHandleProcessNextPageOnPopulateWorklet = jest.fn();
const mockHandleFinishWalletOnPopulateWorklet = jest.fn();
const mockHandleCloseWalletSessionOnPopulateWorklet = jest.fn();
const mockGetOrCreatePortfolioPopulateWorkletState = jest.fn();
const mockClearWorkletWalletSnapshots = jest.fn();

jest.mock('./portfolioPopulateWorklet', () => ({
  handlePrepareWalletOnPopulateWorklet: (...args: unknown[]) =>
    mockHandlePrepareWalletOnPopulateWorklet(...args),
  handleProcessNextPageOnPopulateWorklet: (...args: unknown[]) =>
    mockHandleProcessNextPageOnPopulateWorklet(...args),
  handleFinishWalletOnPopulateWorklet: (...args: unknown[]) =>
    mockHandleFinishWalletOnPopulateWorklet(...args),
  handleCloseWalletSessionOnPopulateWorklet: (...args: unknown[]) =>
    mockHandleCloseWalletSessionOnPopulateWorklet(...args),
  getOrCreatePortfolioPopulateWorkletState: (...args: unknown[]) =>
    mockGetOrCreatePortfolioPopulateWorkletState(...args),
}));

jest.mock('./portfolioWorkletSnapshots', () => ({
  clearWorkletWalletSnapshots: (...args: unknown[]) =>
    mockClearWorkletWalletSnapshots(...args),
}));

import {
  handleGetPopulateJobStatusOnWorklet,
  handleStartPopulateJobOnWorklet,
  resetPortfolioPopulateJobWorkletState,
} from './portfolioPopulateJobWorklet';

const config = {
  storage: {
    contains: jest.fn(),
    delete: jest.fn(),
    getString: jest.fn(),
    set: jest.fn(),
  },
  storageId: 'test-storage',
  registryKey: '__test-registry__',
} as any;

const params = {
  cfg: {
    baseUrl: 'https://bws.example',
    timeoutMs: 30000,
  },
  wallets: [
    {
      walletId: 'w1',
      credentials: {
        walletId: 'w1',
        requestPrivKey: 'priv-key',
      },
      summary: {
        walletId: 'w1',
        walletName: 'Wallet 1',
        chain: 'btc',
        network: 'livenet',
        currencyAbbreviation: 'btc',
        balanceAtomic: '100000000',
        balanceFormatted: '1',
      },
    },
  ],
  ingest: {
    quoteCurrency: 'USD',
    compressionEnabled: true,
    chunkRows: 128,
    snapshotDebugMode: 'none',
  },
  pageSize: 1000,
} as any;

async function waitForTerminalStatus(jobId: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const status = await handleGetPopulateJobStatusOnWorklet(config, jobId);
    if (status && !status.inProgress) {
      return status;
    }
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  throw new Error(`Populate job ${jobId} did not reach a terminal state.`);
}

describe('portfolioPopulateJobWorklet', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetPortfolioPopulateJobWorkletState(config);
    mockGetOrCreatePortfolioPopulateWorkletState.mockReturnValue({
      sessionsByWalletId: {},
      storageId: config.storageId,
      registryKey: config.registryKey,
    });
  });

  it('keeps populating after processing more than 1000 transactions', async () => {
    mockHandlePrepareWalletOnPopulateWorklet.mockResolvedValue({
      checkpoint: {nextSkip: 0},
    });
    mockHandleProcessNextPageOnPopulateWorklet
      .mockResolvedValueOnce({
        checkpoint: {nextSkip: 1000},
        appendedSnapshots: 4,
        fetchedTxs: 1000,
        logicalPageSize: 1000,
        done: false,
        fetchMs: 10,
        computeMs: 5,
      })
      .mockResolvedValueOnce({
        checkpoint: {nextSkip: 1001},
        appendedSnapshots: 1,
        fetchedTxs: 1,
        logicalPageSize: 1,
        done: false,
        fetchMs: 2,
        computeMs: 1,
      })
      .mockResolvedValueOnce({
        checkpoint: {nextSkip: 1001},
        appendedSnapshots: 0,
        fetchedTxs: 0,
        logicalPageSize: 0,
        done: true,
        fetchMs: 1,
        computeMs: 0,
      });
    mockHandleFinishWalletOnPopulateWorklet.mockResolvedValue({
      checkpoint: {nextSkip: 1001},
      appendedSnapshots: 2,
    });

    const started = await handleStartPopulateJobOnWorklet(config, params, {
      w1: {
        requestPrivKey: 'priv-key',
        nextSignHandleIndex: 0,
      },
    });
    const status = await waitForTerminalStatus(started.jobId);

    expect(status?.state).toBe('completed');
    expect(status?.disabledForLargeHistory).toBe(false);
    expect(status?.txsProcessed).toBe(1001);
    expect(status?.walletsCompleted).toBe(1);
    expect(status?.result?.results[0]).toMatchObject({
      walletId: 'w1',
      txsProcessed: 1001,
      txRequestsMade: 3,
      cancelled: false,
      disabledForLargeHistory: false,
    });
    expect(mockHandleFinishWalletOnPopulateWorklet).toHaveBeenCalledTimes(1);
    expect(mockClearWorkletWalletSnapshots).not.toHaveBeenCalled();
  });

  it('skips a wallet prepare failure and continues populating the remaining wallets', async () => {
    const paramsWithTwoWallets = {
      ...params,
      wallets: [
        params.wallets[0],
        {
          walletId: 'w2',
          credentials: {
            walletId: 'w2',
            requestPrivKey: 'priv-key-2',
          },
          summary: {
            walletId: 'w2',
            walletName: 'Wallet 2',
            chain: 'btc',
            network: 'livenet',
            currencyAbbreviation: 'btc',
            balanceAtomic: '200000000',
            balanceFormatted: '2',
          },
        },
      ],
    } as any;

    mockHandlePrepareWalletOnPopulateWorklet
      .mockRejectedValueOnce(
        new Error(
          'Failed to fetch fiat rates (400) for https://bws.bitpay.com/bws/api/v4/fiatrates/USD?days=1',
        ),
      )
      .mockResolvedValueOnce({
        checkpoint: {nextSkip: 0},
      });
    mockHandleProcessNextPageOnPopulateWorklet.mockResolvedValueOnce({
      checkpoint: {nextSkip: 0},
      appendedSnapshots: 0,
      fetchedTxs: 0,
      logicalPageSize: 0,
      done: true,
      fetchMs: 1,
      computeMs: 0,
    });
    mockHandleFinishWalletOnPopulateWorklet.mockResolvedValueOnce({
      checkpoint: {nextSkip: 0},
      appendedSnapshots: 1,
    });

    const started = await handleStartPopulateJobOnWorklet(
      config,
      paramsWithTwoWallets,
      {
        w1: {
          requestPrivKey: 'priv-key',
          nextSignHandleIndex: 0,
        },
        w2: {
          requestPrivKey: 'priv-key-2',
          nextSignHandleIndex: 0,
        },
      },
    );
    const status = await waitForTerminalStatus(started.jobId);

    expect(status?.state).toBe('completed');
    expect(status?.failureMessage).toBeUndefined();
    expect(status?.walletsCompleted).toBe(1);
    expect(status?.walletStatusById).toMatchObject({
      w1: 'error',
      w2: 'done',
    });
    expect(status?.errors).toEqual([
      {
        walletId: 'w1',
        message:
          'Failed to fetch fiat rates (400) for https://bws.bitpay.com/bws/api/v4/fiatrates/USD?days=1',
      },
    ]);
    expect(status?.result?.results).toHaveLength(1);
    expect(status?.result?.results[0]).toMatchObject({
      walletId: 'w2',
      cancelled: false,
    });
    expect(mockHandlePrepareWalletOnPopulateWorklet).toHaveBeenCalledTimes(2);
    expect(mockHandleFinishWalletOnPopulateWorklet).toHaveBeenCalledTimes(1);
    expect(mockClearWorkletWalletSnapshots).toHaveBeenCalledTimes(1);
    expect(mockClearWorkletWalletSnapshots).toHaveBeenCalledWith(
      {
        storage: config.storage,
        registryKey: config.registryKey,
      },
      'w1',
    );
  });

  it('skips a wallet txhistory page failure and continues populating the remaining wallets', async () => {
    const paramsWithTwoWallets = {
      ...params,
      wallets: [
        params.wallets[0],
        {
          walletId: 'w2',
          credentials: {
            walletId: 'w2',
            requestPrivKey: 'priv-key-2',
          },
          summary: {
            walletId: 'w2',
            walletName: 'Wallet 2',
            chain: 'btc',
            network: 'livenet',
            currencyAbbreviation: 'btc',
            balanceAtomic: '200000000',
            balanceFormatted: '2',
          },
        },
      ],
    } as any;

    mockHandlePrepareWalletOnPopulateWorklet
      .mockResolvedValueOnce({
        checkpoint: {nextSkip: 0},
      })
      .mockResolvedValueOnce({
        checkpoint: {nextSkip: 0},
      });
    mockHandleProcessNextPageOnPopulateWorklet
      .mockRejectedValueOnce(
        new Error(
          'BWS txhistory request failed with status 404 for /v1/txhistory/?limit=1000&reverse=1. Not found.',
        ),
      )
      .mockResolvedValueOnce({
        checkpoint: {nextSkip: 0},
        appendedSnapshots: 0,
        fetchedTxs: 0,
        logicalPageSize: 0,
        done: true,
        fetchMs: 1,
        computeMs: 0,
      });
    mockHandleFinishWalletOnPopulateWorklet.mockResolvedValueOnce({
      checkpoint: {nextSkip: 0},
      appendedSnapshots: 1,
    });

    const started = await handleStartPopulateJobOnWorklet(
      config,
      paramsWithTwoWallets,
      {
        w1: {
          requestPrivKey: 'priv-key',
          nextSignHandleIndex: 0,
        },
        w2: {
          requestPrivKey: 'priv-key-2',
          nextSignHandleIndex: 0,
        },
      },
    );
    const status = await waitForTerminalStatus(started.jobId);

    expect(status?.state).toBe('completed');
    expect(status?.failureMessage).toBeUndefined();
    expect(status?.walletsCompleted).toBe(1);
    expect(status?.walletStatusById).toMatchObject({
      w1: 'error',
      w2: 'done',
    });
    expect(status?.errors).toEqual([
      {
        walletId: 'w1',
        message:
          'BWS txhistory request failed with status 404 for /v1/txhistory/?limit=1000&reverse=1. Not found.',
      },
    ]);
    expect(status?.result?.results).toHaveLength(1);
    expect(status?.result?.results[0]).toMatchObject({
      walletId: 'w2',
      cancelled: false,
    });
    expect(mockHandlePrepareWalletOnPopulateWorklet).toHaveBeenCalledTimes(2);
    expect(mockHandleProcessNextPageOnPopulateWorklet).toHaveBeenCalledTimes(2);
    expect(mockHandleFinishWalletOnPopulateWorklet).toHaveBeenCalledTimes(1);
    expect(mockClearWorkletWalletSnapshots).toHaveBeenCalledTimes(1);
    expect(mockClearWorkletWalletSnapshots).toHaveBeenCalledWith(
      {
        storage: config.storage,
        registryKey: config.registryKey,
      },
      'w1',
    );
  });
});
