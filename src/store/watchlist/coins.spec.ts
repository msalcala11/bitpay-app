import {SupportedCurrencyOptions} from '../../constants/SupportedCurrencyOptions';
import {
  buildCoinCatalog,
  alertCurrency,
  alertsDeliverable,
  DEFAULT_WATCHLIST,
} from './coins';

const empty = {tokenOptionsByAddress: {}, tokenDataByAddress: {}};
describe('watchlist coin catalog', () => {
  it('groups built-ins across chains, with native selectors and aliases', () => {
    const catalog = buildCoinCatalog(SupportedCurrencyOptions, empty);
    for (const symbol of DEFAULT_WATCHLIST) {
      expect(catalog.byId.get(`coin:${symbol}`)?.selector).toEqual({
        coin: symbol,
      });
    }
    expect(
      catalog.match({currencyAbbreviation: 'eth', chain: 'base'})?.id,
    ).toBe('coin:eth');
    expect(
      catalog.match({currencyAbbreviation: 'matic', chain: 'matic'})?.id,
    ).toBe('coin:pol');
    expect(
      catalog.match({currencyAbbreviation: 'EURC', chain: 'eth'})?.id,
    ).toBe('coin:eurc');
    expect(catalog.byId.get('coin:usdc')?.selector).toEqual({
      chain: 'eth',
      tokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    });
  });
  it('groups listed tokens by name, symbol and logo, choosing Ethereum first', () => {
    const token = {
      name: 'Example',
      symbol: 'EX',
      logoURI: 'https://example.test/ex.png',
      decimals: 18,
    };
    const catalog = buildCoinCatalog(SupportedCurrencyOptions, {
      ...empty,
      tokenOptionsByAddress: {
        '0xabc_m': {...token, address: '0xABC'},
        '0xdef_e': {...token, address: '0xDEF'},
        '0xaaa_base': {...token, address: '0xAAA', logoURI: 'different'},
      },
    });
    const coin = catalog.match({
      currencyAbbreviation: 'ex',
      chain: 'matic',
      tokenAddress: '0xAbC',
    });
    expect(coin?.assets).toHaveLength(2);
    expect(coin?.selector).toEqual({chain: 'eth', tokenAddress: '0xdef'});
    expect(coin?.image).toEqual({uri: token.logoURI});
    expect(
      catalog.match({
        currencyAbbreviation: 'ex',
        chain: 'eth',
        tokenAddress: '0xDEF',
      }),
    ).toBe(coin);
    expect(
      catalog.match({
        currencyAbbreviation: 'ex',
        chain: 'base',
        tokenAddress: '0xaaa',
      }),
    ).not.toBe(coin);
  });
  it('matches built-in token names and rejects testnet or unlisted custom tokens', () => {
    const catalog = buildCoinCatalog(SupportedCurrencyOptions, {
      ...empty,
      tokenOptionsByAddress: {
        '0xabc_base': {
          name: 'USD Coin',
          symbol: 'USDC',
          address: '0xabc',
          decimals: 6,
          logoURI: 'usdc.png',
        },
      },
    });
    expect(
      catalog.match({
        currencyAbbreviation: 'usdc',
        chain: 'base',
        tokenAddress: '0xabc',
      })?.id,
    ).toBe('coin:usdc');
    expect(
      catalog.match({
        currencyAbbreviation: 'btc',
        chain: 'btc',
        network: 'testnet',
      }),
    ).toBeUndefined();
    expect(
      catalog.match({
        currencyAbbreviation: 'usdc',
        chain: 'eth',
        tokenAddress: '0xunlisted',
      }),
    ).toBeUndefined();
  });
  it('keeps Solana address case and a stable id as registry order changes', () => {
    const token = {
      name: 'Example',
      symbol: 'EX',
      logoURI: 'ex.png',
      decimals: 6,
    };
    const tokens = {
      AbCd_sol: {...token, address: 'AbCd'},
      '0xabc_m': {...token, address: '0xabc'},
    };
    const a = buildCoinCatalog([], {...empty, tokenOptionsByAddress: tokens});
    const b = buildCoinCatalog([], {
      ...empty,
      tokenOptionsByAddress: Object.fromEntries(
        Object.entries(tokens).reverse(),
      ),
    });
    expect(a.coins[0].id).toBe(b.coins[0].id);
    expect(a.coins[0].selector).toEqual({
      chain: 'matic',
      tokenAddress: '0xabc',
    });
    expect(
      a.match({currencyAbbreviation: 'ex', chain: 'sol', tokenAddress: 'abcd'}),
    ).toBeUndefined();
  });
  it('falls back to USD and separates push permission from delivery preferences', () => {
    expect(alertCurrency('eur')).toBe('EUR');
    expect(alertCurrency('CHF')).toBe('USD');
    expect(alertsDeliverable(true, true, false)).toBe(false);
    expect(alertsDeliverable(true, true, true)).toBe(true);
  });
});
