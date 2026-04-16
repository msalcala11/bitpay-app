import {PortfolioPopulateService} from './portfolioPopulateService';

describe('PortfolioPopulateService', () => {
  const storedWallet = {
    walletId: 'wallet-1',
    addedAt: 1,
    credentials: {
      walletId: 'wallet-1',
      copayerId: 'copayer-1',
      requestPrivKey: 'priv-key',
    },
    summary: {
      walletId: 'wallet-1',
      walletName: 'Wallet 1',
      chain: 'btc',
      network: 'livenet',
      currencyAbbreviation: 'btc',
      balanceAtomic: '100000000',
      balanceFormatted: '1',
    },
  } as any;

  it('starts a runtime populate job, polls status, and reports aggregate progress', async () => {
    const client = {
      startPopulateJob: jest.fn().mockResolvedValue({
        jobId: 'job-1',
        status: {
          jobId: 'job-1',
          state: 'queued',
          inProgress: true,
          startedAt: 1,
          walletsTotal: 1,
          walletsCompleted: 0,
          txRequestsMade: 0,
          txsProcessed: 0,
          walletStatusById: {},
          errors: [],
          disabledForLargeHistory: false,
          lastUpdatedAt: 1,
        },
      }),
      getPopulateJobStatus: jest
        .fn()
        .mockResolvedValueOnce({
          jobId: 'job-1',
          state: 'running',
          inProgress: true,
          startedAt: 1,
          currentWalletId: 'wallet-1',
          walletsTotal: 1,
          walletsCompleted: 0,
          txRequestsMade: 1,
          txsProcessed: 1000,
          walletStatusById: {['wallet-1']: 'in_progress'},
          errors: [],
          disabledForLargeHistory: false,
          lastUpdatedAt: 2,
        })
        .mockResolvedValueOnce({
          jobId: 'job-1',
          state: 'completed',
          inProgress: false,
          startedAt: 1,
          finishedAt: 10,
          walletsTotal: 1,
          walletsCompleted: 1,
          txRequestsMade: 2,
          txsProcessed: 1000,
          walletStatusById: {['wallet-1']: 'done'},
          errors: [],
          disabledForLargeHistory: false,
          lastUpdatedAt: 3,
          result: {
            startedAt: 1,
            finishedAt: 10,
            cancelled: false,
            disabledForLargeHistory: false,
            results: [
              {
                walletId: 'wallet-1',
                prepared: {checkpoint: {nextSkip: 0}},
                processResults: [
                  {
                    checkpoint: {nextSkip: 1000},
                    appendedSnapshots: 5,
                    fetchedTxs: 1000,
                    logicalPageSize: 1000,
                    done: false,
                    fetchMs: 12,
                    computeMs: 8,
                  },
                  {
                    checkpoint: {nextSkip: 1000},
                    appendedSnapshots: 0,
                    fetchedTxs: 0,
                    logicalPageSize: 0,
                    done: true,
                    fetchMs: 3,
                    computeMs: 0,
                  },
                ],
                finished: {
                  checkpoint: {nextSkip: 1000},
                  appendedSnapshots: 2,
                },
                appendedSnapshots: 7,
                txRequestsMade: 2,
                txsProcessed: 1000,
                cancelled: false,
                disabledForLargeHistory: false,
              },
            ],
          },
        }),
      cancelPopulateJob: jest.fn().mockResolvedValue(null),
    } as any;

    const progressEvents: any[] = [];
    const service = new PortfolioPopulateService({
      client,
      pollIntervalMs: 100,
    });
    const result = await service.populateWallets({
      wallets: [storedWallet],
      onProgress: progress => progressEvents.push(progress),
    });

    expect(client.startPopulateJob).toHaveBeenCalledTimes(1);
    expect(client.getPopulateJobStatus).toHaveBeenCalledTimes(2);
    expect(client.cancelPopulateJob).not.toHaveBeenCalled();
    expect(result.cancelled).toBe(false);
    expect(result.results[0]).toMatchObject({
      walletId: 'wallet-1',
      appendedSnapshots: 7,
      txRequestsMade: 2,
      txsProcessed: 1000,
      cancelled: false,
    });
    expect(progressEvents[progressEvents.length - 1]).toMatchObject({
      inProgress: false,
      walletsCompleted: 1,
      txRequestsMade: 2,
      txsProcessed: 1000,
    });
  });

  it('cancels the active runtime populate job when requested', async () => {
    let service: PortfolioPopulateService;
    const client = {
      startPopulateJob: jest.fn().mockResolvedValue({
        jobId: 'job-1',
        status: {
          jobId: 'job-1',
          state: 'queued',
          inProgress: true,
          startedAt: 1,
          walletsTotal: 1,
          walletsCompleted: 0,
          txRequestsMade: 0,
          txsProcessed: 0,
          walletStatusById: {},
          errors: [],
          disabledForLargeHistory: false,
          lastUpdatedAt: 1,
        },
      }),
      getPopulateJobStatus: jest.fn().mockImplementation(async () => {
        if ((client.getPopulateJobStatus as jest.Mock).mock.calls.length === 1) {
          service.cancel();
          return {
            jobId: 'job-1',
            state: 'running',
            inProgress: true,
            startedAt: 1,
            currentWalletId: 'wallet-1',
            walletsTotal: 1,
            walletsCompleted: 0,
            txRequestsMade: 1,
            txsProcessed: 250,
            walletStatusById: {['wallet-1']: 'in_progress'},
            errors: [],
            disabledForLargeHistory: false,
            lastUpdatedAt: 2,
          };
        }

        return {
          jobId: 'job-1',
          state: 'cancelled',
          inProgress: false,
          startedAt: 1,
          finishedAt: 5,
          walletsTotal: 1,
          walletsCompleted: 1,
          txRequestsMade: 1,
          txsProcessed: 250,
          walletStatusById: {},
          errors: [],
          disabledForLargeHistory: false,
          lastUpdatedAt: 3,
          result: {
            startedAt: 1,
            finishedAt: 5,
            cancelled: true,
            disabledForLargeHistory: false,
            results: [
              {
                walletId: 'wallet-1',
                prepared: {checkpoint: {nextSkip: 0}},
                processResults: [],
                finished: null,
                appendedSnapshots: 0,
                txRequestsMade: 1,
                txsProcessed: 250,
                cancelled: true,
                disabledForLargeHistory: false,
              },
            ],
          },
        };
      }),
      cancelPopulateJob: jest.fn().mockResolvedValue({
        jobId: 'job-1',
        state: 'running',
        inProgress: true,
        startedAt: 1,
        walletsTotal: 1,
        walletsCompleted: 0,
        txRequestsMade: 1,
        txsProcessed: 250,
        walletStatusById: {['wallet-1']: 'in_progress'},
        errors: [],
        disabledForLargeHistory: false,
        lastUpdatedAt: 2,
      }),
    } as any;

    service = new PortfolioPopulateService({client, pollIntervalMs: 100});
    const result = await service.populateWallets({wallets: [storedWallet]});

    expect(result.cancelled).toBe(true);
    expect(client.cancelPopulateJob).toHaveBeenCalledWith({jobId: 'job-1'});
  });
});
