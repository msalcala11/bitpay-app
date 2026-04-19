import {
  extractPortfolioWalletCredentialsSnapshot,
  isPortfolioRuntimeEligibleWallet,
  toPortfolioStoredWallet,
} from './walletMappers';

describe('walletMappers', () => {
  it('detects runtime-eligible mainnet wallets with request signing credentials', () => {
    const wallet = {
      id: 'wallet-1',
      chain: 'eth',
      network: 'livenet',
      currencyAbbreviation: 'usdc',
      tokenAddress: '0xToken',
      walletName: 'My Wallet',
      balance: {
        crypto: '12.5',
      },
      receiveAddress: '0xAbC123',
      credentials: {
        walletId: 'wallet-1',
        copayerId: 'copayer-1',
        requestPrivKey: 'priv-key',
        requestPubKey: 'pub-key',
        walletName: 'My Wallet',
        chain: 'eth',
        network: 'livenet',
        coin: 'usdc',
        token: {
          address: '0xToken',
          symbol: 'usdc',
        },
        isComplete: () => true,
      },
    } as any;

    expect(isPortfolioRuntimeEligibleWallet(wallet)).toBe(true);

    const credentials = extractPortfolioWalletCredentialsSnapshot(wallet);
    expect(credentials.walletId).toBe('wallet-1');
    expect(credentials.requestPrivKey).toBe('priv-key');
    expect(credentials.token?.address).toBe('0xToken');
    expect(credentials.receiveAddress).toBe('0xAbC123');

    const stored = toPortfolioStoredWallet({
      wallet,
      unitDecimals: 6,
      addedAt: 123,
    });
    expect(stored.addedAt).toBe(123);
    expect(stored.summary.walletId).toBe('wallet-1');
    expect(stored.summary.currencyAbbreviation).toBe('usdc');
    expect(stored.summary.tokenAddress).toBe('0xToken');
    expect(stored.summary.balanceAtomic).toBe('12500000');
  });

  it('rejects wallets that are incomplete or missing signing credentials', () => {
    const wallet = {
      id: 'wallet-2',
      chain: 'btc',
      network: 'livenet',
      currencyAbbreviation: 'btc',
      balance: {
        crypto: '0.1',
      },
      credentials: {
        walletId: 'wallet-2',
        copayerId: 'copayer-2',
        isComplete: () => false,
      },
    } as any;

    expect(isPortfolioRuntimeEligibleWallet(wallet)).toBe(false);
  });
});
