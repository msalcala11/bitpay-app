jest.mock('../../../utils/helper-methods', () => ({
  formatCurrencyAbbreviation: jest.fn((value: string) => value.toUpperCase()),
  formatFiatAmount: jest.fn((value: number, quoteCurrency: string) => {
    return `${quoteCurrency}:${value}`;
  }),
}));

import {buildAssetRowsFromAnalysis} from './buildAssetRowsFromAnalysis';

describe('buildAssetRowsFromAnalysis', () => {
  it('formats pnl percent with two decimals to match asset detail', () => {
    const rows = buildAssetRowsFromAnalysis({
      storedWallets: [
        {
          walletId: 'wallet-1',
          credentials: {
            walletId: 'wallet-1',
            chain: 'btc',
            coin: 'btc',
          },
          summary: {
            walletId: 'wallet-1',
            walletName: 'BTC Wallet',
            chain: 'btc',
            network: 'livenet',
            currencyAbbreviation: 'btc',
            balanceAtomic: '100000000',
            balanceFormatted: '1',
          },
          addedAt: 0,
        } as any,
      ],
      analysis: {
        points: [
          {
            byWalletId: {
              'wallet-1': {
                unrealizedPnlFiat: 12.3456,
                remainingCostBasisFiat: 100,
              },
            },
          },
        ],
      } as any,
      quoteCurrency: 'USD',
      gainLossMode: '1D',
      collapseAcrossChains: true,
    });

    expect(rows).toEqual([
      expect.objectContaining({
        key: 'btc',
        deltaPercent: '+12.35%',
      }),
    ]);
  });
});
