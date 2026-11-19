import {
  parseExchangeRateLink,
  resolveExchangeRateLink,
} from './exchangeRateLink';
import {buildCoinCatalog} from '../../store/watchlist/coins';
import {SupportedCurrencyOptions} from '../../constants/SupportedCurrencyOptions';
const empty = {tokenOptionsByAddress: {}, tokenDataByAddress: {}};
const catalog = buildCoinCatalog(SupportedCurrencyOptions, empty);
it('parses native and token links, including encoded values and Solana case', () => {
  expect(
    resolveExchangeRateLink(
      {currencyAbbreviation: 'BTC', notification_type: 'price_alert'},
      catalog,
      false,
    ),
  ).toMatchObject({status: 'resolved', coin: {id: 'coin:btc'}});
  expect(
    parseExchangeRateLink({
      currencyAbbreviation: 'USDC',
      chain: 'SOL',
      tokenAddress: 'Ab%43d',
    }),
  ).toMatchObject({
    currencyAbbreviation: 'usdc',
    chain: 'sol',
    tokenAddress: 'AbCd',
  });
  expect(
    resolveExchangeRateLink(
      {
        currencyAbbreviation: 'usdc',
        chain: 'eth',
        tokenAddress: '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      },
      catalog,
      true,
    ),
  ).toMatchObject({status: 'resolved', coin: {id: 'coin:usdc'}});
  expect(
    resolveExchangeRateLink({currencyAbbreviation: 'unknown'}, catalog, true),
  ).toEqual({status: 'unknown'});
});
it('defers a token link until its registry entry arrives, then resolves it', () => {
  const link = {
    currencyAbbreviation: 'list',
    chain: 'eth',
    tokenAddress: '0xabc',
  };
  expect(resolveExchangeRateLink(link, catalog, false)).toEqual({
    status: 'waiting',
  });
  const loaded = buildCoinCatalog(SupportedCurrencyOptions, {
    ...empty,
    tokenOptionsByAddress: {
      '0xabc_e': {
        name: 'Listed',
        symbol: 'LIST',
        address: '0xabc',
        decimals: 18,
      },
    },
  });
  expect(resolveExchangeRateLink(link, loaded, true)).toMatchObject({
    status: 'resolved',
    coin: {name: 'Listed'},
  });
  expect(
    resolveExchangeRateLink({...link, tokenAddress: '0xmissing'}, loaded, true),
  ).toEqual({status: 'unknown'});
});

it('resolves a deep link’s exact token independently of another watched token with the same ticker', () => {
  const loaded = buildCoinCatalog([], {
    tokenDataByAddress: {},
    tokenOptionsByAddress: {
      '0xa_e': {
        name: 'Token A',
        symbol: 'SAME',
        address: '0xa',
        decimals: 18,
        logoURI: 'a.png',
      },
      '0xb_m': {
        name: 'Token B',
        symbol: 'SAME',
        address: '0xb',
        decimals: 18,
        logoURI: 'b.png',
      },
    },
  });
  expect(
    resolveExchangeRateLink(
      {currencyAbbreviation: 'same', chain: 'matic', tokenAddress: '0xb'},
      loaded,
      true,
    ),
  ).toMatchObject({
    status: 'resolved',
    asset: {currencyAbbreviation: 'same', chain: 'matic', tokenAddress: '0xb'},
    coin: {name: 'Token B', image: {uri: 'b.png'}},
  });
});

it('keeps a built-in default for a legacy token link without a contract despite a listed lookalike', () => {
  const loaded = buildCoinCatalog(SupportedCurrencyOptions, {
    tokenDataByAddress: {},
    tokenOptionsByAddress: {
      '0x0000_e': {
        name: 'Different USD Coin',
        symbol: 'USDC',
        address: '0x0000',
        decimals: 6,
        logoURI: 'other.png',
      },
    },
  });
  expect(
    resolveExchangeRateLink(
      {currencyAbbreviation: 'usdc', chain: 'eth'},
      loaded,
      true,
    ),
  ).toMatchObject({
    status: 'resolved',
    asset: {
      chain: 'eth',
      tokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    },
  });
});
