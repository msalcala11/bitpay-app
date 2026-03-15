jest.mock('../../constants/currencies', () => ({
  BitpaySupportedCoins: {
    eth: {
      theme: {
        coinColor: '#6b71d6',
      },
    },
  },
  BitpaySupportedTokens: {
    usdt_eth: {
      coin: 'usdt',
      chain: 'eth',
      address: '0xdac17f958d2ee523a2206206994597c13d831ec7',
      theme: {
        coinColor: '#089098',
      },
    },
  },
}));

jest.mock('../helper-methods', () => ({
  formatCurrencyAbbreviation: (value: string) => (value || '').toUpperCase(),
  formatFiatAmount: (value: number, isoCode: string) =>
    `${(isoCode || '').toUpperCase()} ${value.toFixed(2)}`,
}));

jest.mock('./assets', () => ({
  getVisibleWalletsFromKeys: jest.fn(() => []),
}));

const {
  BitpaySupportedCoins,
  BitpaySupportedTokens,
} = require('../../constants/currencies');
const {buildAllocationDataFromWalletRows} = require('./allocation');

describe('buildAllocationDataFromWalletRows', () => {
  it('uses the token theme color for token allocation slices, legend items, and rows', () => {
    const usdtToken = Object.values(BitpaySupportedTokens).find(
      token => token.coin === 'usdt' && token.chain === 'eth',
    );
    const usdtColor = usdtToken?.theme?.coinColor;
    const ethColor = BitpaySupportedCoins.eth?.theme?.coinColor;

    expect(usdtToken?.address).toBeDefined();
    expect(usdtColor).toBeDefined();
    expect(ethColor).toBeDefined();
    expect(usdtColor).not.toBe(ethColor);

    const {legendItems, rows, slices} = buildAllocationDataFromWalletRows(
      [
        {
          currencyAbbreviation: 'usdt',
          chain: 'eth',
          tokenAddress: usdtToken?.address,
          currencyName: 'Tether USD',
          fiatBalance: 100,
        },
      ],
      'usd',
    );

    const expectedColor = {
      light: usdtColor as string,
      dark: usdtColor as string,
    };

    expect(rows[0]?.barColor).toEqual(expectedColor);
    expect(legendItems[0]?.color).toEqual(expectedColor);
    expect(slices[0]?.color).toEqual(expectedColor);
  });
});
