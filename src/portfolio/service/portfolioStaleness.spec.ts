import {
  getPortfolioPopulateDecisionForWallet,
  getPortfolioPopulateDecisionsForWallets,
} from './portfolioStaleness';

describe('portfolioStaleness', () => {
  const wallet = {
    id: 'wallet-1',
    chain: 'btc',
    network: 'livenet',
    currencyAbbreviation: 'btc',
    balance: {
      crypto: '1.5',
      sat: 150000000,
      satConfirmed: 150000000,
      satPending: 0,
    },
  } as any;

  it('marks wallets with no snapshot index for populate', async () => {
    const client = {
      getInvalidHistory: jest.fn().mockResolvedValue(null),
      getSnapshotIndex: jest.fn().mockResolvedValue(null),
      getLatestSnapshot: jest.fn(),
    } as any;

    const decision = await getPortfolioPopulateDecisionForWallet({
      client,
      wallet,
      unitDecimals: 8,
    });

    expect(decision.shouldPopulate).toBe(true);
    expect(decision.reason).toBe('missing_index');
    expect(client.getInvalidHistory).toHaveBeenCalledWith({walletId: 'wallet-1'});
    expect(client.getLatestSnapshot).not.toHaveBeenCalled();
  });

  it('flags balance mismatches against the latest stored snapshot', async () => {
    const client = {
      getInvalidHistory: jest.fn().mockResolvedValue(null),
      getSnapshotIndex: jest.fn().mockResolvedValue({walletId: 'wallet-1'}),
      getLatestSnapshot: jest.fn().mockResolvedValue({
        walletId: 'wallet-1',
        cryptoBalance: '100000000',
      }),
    } as any;

    const decision = await getPortfolioPopulateDecisionForWallet({
      client,
      wallet,
      unitDecimals: 8,
    });

    expect(decision.shouldPopulate).toBe(true);
    expect(decision.reason).toBe('balance_mismatch');
    expect(decision.mismatch).toMatchObject({
      walletId: 'wallet-1',
      computedUnitsHeld: '1',
      currentWalletBalance: '1.5',
      delta: '-0.5',
    });
  });

  it('suppresses auto-populate when invalid history is still under cooldown', async () => {
    const client = {
      getInvalidHistory: jest.fn().mockResolvedValue({
        v: 1,
        walletId: 'wallet-1',
        reason: 'negative_balance',
        detectedAt: Date.now() - 1000,
        retryAfter: Date.now() + 60_000,
        message: 'Invalid tx history',
      }),
      getSnapshotIndex: jest.fn(),
      getLatestSnapshot: jest.fn(),
    } as any;

    const decision = await getPortfolioPopulateDecisionForWallet({
      client,
      wallet,
      unitDecimals: 8,
    });

    expect(decision.shouldPopulate).toBe(false);
    expect(decision.reason).toBe('invalid_history');
    expect(client.getSnapshotIndex).not.toHaveBeenCalled();
    expect(client.getLatestSnapshot).not.toHaveBeenCalled();
  });

  it('aggregates wallet ids that still need populate', async () => {
    const client = {
      getInvalidHistory: jest.fn().mockResolvedValue(null),
      getSnapshotIndex: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({walletId: 'wallet-2'}),
      getLatestSnapshot: jest.fn().mockResolvedValue({
        walletId: 'wallet-2',
        cryptoBalance: '150000000',
      }),
    } as any;

    const decisions = await getPortfolioPopulateDecisionsForWallets({
      client,
      wallets: [wallet, {...wallet, id: 'wallet-2'} as any],
      getUnitDecimals: () => 8,
    });

    expect(decisions.walletIdsToPopulate).toEqual(['wallet-1']);
    expect(decisions.decisions).toHaveLength(2);
    expect(decisions.mismatchByWalletId['wallet-2']).toBeUndefined();
  });
});
