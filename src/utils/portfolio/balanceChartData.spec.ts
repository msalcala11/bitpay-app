jest.mock('./assets', () => ({
  getPortfolioWalletChainLower: jest.fn(() => 'btc'),
  getPortfolioWalletTokenAddress: jest.fn(() => undefined),
}));

jest.mock('./displayCurrency', () => ({
  getAssetCurrentDisplayQuoteRate: jest.fn(() => undefined),
}));

import {
  buildBalanceChartHistoricalRateRequests,
  getBalanceChartHistoricalRateCacheKeys,
} from './balanceChartData';

const makeStoredWallet = (args: {
  walletId: string;
  coin: string;
  chain?: string;
  tokenAddress?: string;
}) =>
  ({
    summary: {
      walletId: args.walletId,
      currencyAbbreviation: args.coin,
      chain: args.chain || args.coin,
      tokenAddress: args.tokenAddress,
    },
  }) as any;

describe('balanceChartData historical rate deps', () => {
  it('requests canonical USD asset histories plus only the BTC bridge for non-USD display quotes', () => {
    const wallets = [
      makeStoredWallet({walletId: 'w-btc', coin: 'btc'}),
      makeStoredWallet({
        walletId: 'w-usdc',
        coin: 'usdc',
        chain: 'eth',
        tokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      }),
    ];

    expect(
      buildBalanceChartHistoricalRateRequests({
        wallets,
        quoteCurrency: 'EUR',
        timeframes: ['1D', '1M'],
      }),
    ).toEqual([
      {
        quoteCurrency: 'EUR',
        requests: [
          {
            coin: 'btc',
            intervals: ['1D', '1M'],
          },
        ],
      },
      {
        quoteCurrency: 'USD',
        requests: [
          {
            coin: 'btc',
            intervals: ['1D', '1M'],
          },
          {
            coin: 'usdc',
            chain: 'eth',
            tokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
            intervals: ['1D', '1M'],
          },
        ],
      },
    ]);
  });

  it('uses only canonical USD asset histories when the display quote is USD', () => {
    const wallets = [
      makeStoredWallet({walletId: 'w-eth', coin: 'eth'}),
    ];

    expect(
      buildBalanceChartHistoricalRateRequests({
        wallets,
        quoteCurrency: 'USD',
        timeframes: ['1D'],
      }),
    ).toEqual([
      {
        quoteCurrency: 'USD',
        requests: [
          {
            coin: 'eth',
            intervals: ['1D'],
          },
        ],
      },
    ]);
  });

  it('builds cache keys from the canonical-plus-bridge dependency set', () => {
    const wallets = [
      makeStoredWallet({walletId: 'w-eth', coin: 'eth'}),
    ];

    expect(
      getBalanceChartHistoricalRateCacheKeys({
        wallets,
        quoteCurrency: 'EUR',
        timeframes: ['1D'],
      }),
    ).toEqual(['EUR:btc:1D', 'USD:btc:1D', 'USD:eth:1D']);
  });
});
