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
    expect(client.getLatestSnapshot).not.toHaveBeenCalled();
  });

  it('flags balance mismatches against the latest stored snapshot', async () => {
    const client = {
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

  it('aggregates wallet ids that still need populate', async () => {
    const client = {
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
