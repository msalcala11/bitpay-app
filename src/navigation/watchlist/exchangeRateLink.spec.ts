import {
  parseExchangeRateLink,
  resolveExchangeRateLink,
} from './exchangeRateLink';
import {buildCoinCatalog} from '../../store/watchlist/coins';
import {SupportedCurrencyOptions} from '../../constants/SupportedCurrencyOptions';
jest.mock('./watchlistRows', () => ({
  watchlistAsset: (coin: any) =>
    coin.assets.find(
      (asset: any) =>
        asset.chain ===
        ('coin' in coin.selector ? coin.selector.coin : coin.selector.chain),
    ) || coin.assets[0],
}));
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
