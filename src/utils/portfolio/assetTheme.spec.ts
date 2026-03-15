jest.mock('../../constants/currencies', () => ({
  BitpaySupportedCoins: {
    eth: {
      theme: {
        coinColor: '#6b71d6',
        backgroundColor: '#6b71d6',
        gradientBackgroundColor: '#6b71d6',
      },
    },
    base: {
      theme: {
        coinColor: '#1B4ADD',
        backgroundColor: '#1B4ADD',
        gradientBackgroundColor: '#1B4ADD',
      },
    },
  },
  BitpaySupportedTokens: {
    '0xdac17f958d2ee523a2206206994597c13d831ec7_e': {
      coin: 'usdt',
      chain: 'eth',
      address: '0xdac17f958d2ee523a2206206994597c13d831ec7',
      theme: {
        coinColor: '#089098',
        backgroundColor: '#089098',
        gradientBackgroundColor: '#089098',
      },
    },
  },
}));

jest.mock('../helper-methods', () => ({
  addTokenChainSuffix: (name: string, chain: string) =>
    `${String(name).toLowerCase()}_${chain === 'eth' ? 'e' : chain}`,
}));

const {getAssetTheme} = require('./assetTheme');

describe('getAssetTheme', () => {
  it('prefers a strict tokenAddress and chain match over the chain theme', () => {
    expect(
      getAssetTheme({
        currencyAbbreviation: 'usdt',
        chain: 'eth',
        tokenAddress: '0xdac17f958d2ee523a2206206994597c13d831ec7',
      }),
    ).toEqual({
      coinColor: '#089098',
      backgroundColor: '#089098',
      gradientBackgroundColor: '#089098',
    });
  });

  it('falls back to the token color by abbreviation when strict token lookup misses', () => {
    expect(
      getAssetTheme({
        currencyAbbreviation: 'usdt',
        chain: 'eth',
        tokenAddress: '0x0000000000000000000000000000000000000000',
      }),
    ).toEqual({
      coinColor: '#089098',
      backgroundColor: '#089098',
      gradientBackgroundColor: '#089098',
    });
  });

  it('falls back to the chain theme for native assets on L2 chains', () => {
    expect(
      getAssetTheme({
        currencyAbbreviation: 'eth',
        chain: 'base',
      }),
    ).toEqual({
      coinColor: '#1B4ADD',
      backgroundColor: '#1B4ADD',
      gradientBackgroundColor: '#1B4ADD',
    });
  });
});
