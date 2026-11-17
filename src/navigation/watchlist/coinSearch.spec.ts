import {searchWatchlistCoins} from './coinSearch';
import {
  buildCoinCatalog,
  WATCHLIST_BROWSE_ORDER,
} from '../../store/watchlist/coins';
import {SupportedCurrencyOptions} from '../../constants/SupportedCurrencyOptions';
const catalog = buildCoinCatalog(SupportedCurrencyOptions, {
  tokenOptionsByAddress: {},
  tokenDataByAddress: {},
});
it('uses the fixed browse order, omits watched coins, and retains them in search', () => {
  const btc = catalog.byId.get('coin:btc')!;
  expect(
    searchWatchlistCoins(catalog, [], '', 50).map(coin => coin.id),
  ).toEqual(WATCHLIST_BROWSE_ORDER.map(symbol => `coin:${symbol}`));
  expect(
    searchWatchlistCoins(catalog, [btc], '', 50).some(
      coin => coin.id === btc.id,
    ),
  ).toBe(false);
  expect(searchWatchlistCoins(catalog, [btc], 'bitcoin', 50)).toContain(btc);
  expect(searchWatchlistCoins(catalog, [], 'nomatch', 50)).toEqual([]);
});
it('caps search results and treats EUROC as EURC', () => {
  expect(searchWatchlistCoins(catalog, [], 'coin', 2)).toHaveLength(2);
  expect(searchWatchlistCoins(catalog, [], 'euroc', 50)[0].id).toBe(
    'coin:eurc',
  );
});
