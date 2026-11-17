import {buildWatchlistRows, watchlistImage} from './watchlistRows';
import buildHomeExchangeRateItems from '../tabs/home/homeExchangeRates';
import {buildCoinCatalog} from '../../store/watchlist/coins';
import {SupportedCurrencyOptions} from '../../constants/SupportedCurrencyOptions';
jest.mock('../tabs/home/homeExchangeRates', () => jest.fn(() => []));
jest.mock('../../utils/helper-methods', () => ({
  getCurrencyAbbreviation: (name: string) => name,
  calculatePercentageDifference: (current: number, previous: number) =>
    ((current - previous) / previous) * 100,
}));
jest.mock('../../utils/portfolio/displayCurrency', () => ({
  getAssetCurrentDisplayQuoteRate: ({
    rates,
    tokenAddress,
    currencyAbbreviation,
  }: any) => rates[tokenAddress || currencyAbbreviation]?.[0]?.rate,
}));

it('preserves the app’s built-in price and change calculation', () => {
  const catalog = buildCoinCatalog(SupportedCurrencyOptions, {
    tokenOptionsByAddress: {},
    tokenDataByAddress: {},
  });
  (buildHomeExchangeRateItems as jest.Mock).mockReturnValueOnce([
    {currencyAbbreviation: 'btc', currentPrice: 123, average: 4.5},
  ]);
  const rows = buildWatchlistRows(
    [catalog.byId.get('coin:btc')!],
    {},
    {},
    'USD',
    {},
  );
  expect(rows[0]).toMatchObject({
    currentPrice: 123,
    average: 4.5,
    currencyName: 'Bitcoin',
  });
});
it('keeps stablecoins, and listed unheld tokens with their own images and missing-price placeholders', () => {
  const catalog = buildCoinCatalog(SupportedCurrencyOptions, {
    tokenDataByAddress: {},
    tokenOptionsByAddress: {
      '0xabc_e': {
        name: 'Listed token',
        symbol: 'LIST',
        address: '0xabc',
        decimals: 18,
        logoURI: 'https://example.test/list.png',
      },
    },
  });
  const coin = catalog.fromSelector({chain: 'eth', tokenAddress: '0xabc'})!;
  const rows = buildWatchlistRows(
    [catalog.byId.get('coin:usdc')!, coin],
    {},
    {},
    'USD',
    {},
  );
  expect(rows).toHaveLength(2);
  expect(rows[1]).toMatchObject({
    currencyName: 'Listed token',
    currencyAbbreviation: 'LIST',
    tokenAddress: '0xabc',
    img: 'https://example.test/list.png',
  });
  expect(rows[1].currentPrice).toBeUndefined();
  expect(rows[1].average).toBeUndefined();
  expect(watchlistImage(coin)).toBe('https://example.test/list.png');
});
