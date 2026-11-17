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
  ).toEqual(
    WATCHLIST_BROWSE_ORDER.filter(
      symbol => !['arb', 'op'].includes(symbol),
    ).map(symbol => `coin:${symbol}`),
  );
  expect(
    searchWatchlistCoins(catalog, [btc], '', 50).some(
      coin => coin.id === btc.id,
    ),
  ).toBe(false);
  expect(searchWatchlistCoins(catalog, [btc], 'bitcoin', 50)).toContain(btc);
  expect(searchWatchlistCoins(catalog, [], 'nomatch', 50)).toEqual([]);
});

const arbAddress = '0x912ce59144191c1204e64559fe8253a0e49e6548';
const arbEthereumAddress = '0xb50721bcf8d664c30412cfbc6cf7a15145234ad1';
const opAddress = '0x4200000000000000000000000000000000000042';
const arb = {name: 'Arbitrum', symbol: 'ARB', logoURI: 'arb.png', decimals: 18};
const op = {name: 'Optimism', symbol: 'OP', logoURI: 'op.png', decimals: 18};

const listedCatalog = buildCoinCatalog(SupportedCurrencyOptions, {
  tokenOptionsByAddress: {
    '0xunrelated_arb': {...arb, address: '0xunrelated', logoURI: 'other.png'},
    [arbAddress + '_arb']: {...arb, address: arbAddress},
    [arbEthereumAddress + '_e']: {...arb, address: arbEthereumAddress},
    [opAddress + '_op']: {...op, address: opAddress},
  },
  tokenDataByAddress: {},
});

it('includes the listed ARB and OP coins in prototype order once the registry loads', () => {
  const results = searchWatchlistCoins(listedCatalog, [], '', 50);
  expect(results.map(coin => coin.symbol.toLowerCase())).toEqual(
    WATCHLIST_BROWSE_ORDER,
  );
  const featuredArb = results.find(coin => coin.symbol === 'ARB')!;
  expect(featuredArb.image).toEqual({uri: 'arb.png'});
  expect(featuredArb.assets).toHaveLength(2);
  expect(featuredArb.selector).toEqual({
    chain: 'eth',
    tokenAddress: arbEthereumAddress,
  });
  expect(results.find(coin => coin.symbol === 'OP')?.selector).toEqual({
    chain: 'op',
    tokenAddress: opAddress,
  });
});

it('omits watched ARB/OP from browse while retaining their same grouped identities in search', () => {
  const watched = searchWatchlistCoins(listedCatalog, [], '', 50).filter(coin =>
    ['ARB', 'OP'].includes(coin.symbol),
  );
  const browse = searchWatchlistCoins(listedCatalog, watched, '  ', 50);
  for (const coin of watched) {
    expect(browse).not.toContain(coin);
    expect(
      searchWatchlistCoins(listedCatalog, watched, coin.symbol, 50),
    ).toContain(coin);
  }
});

it('does not substitute another token with the same name and symbol when a featured asset is unavailable', () => {
  const unrelatedCatalog = buildCoinCatalog(SupportedCurrencyOptions, {
    tokenOptionsByAddress: {
      '0xother_arb': {...arb, address: '0xother'},
      '0xother_op': {...op, address: '0xother'},
    },
    tokenDataByAddress: {},
  });
  expect(
    searchWatchlistCoins(unrelatedCatalog, [], '', 50).some(coin =>
      ['ARB', 'OP'].includes(coin.symbol),
    ),
  ).toBe(false);
});
it('caps search results and treats EUROC as EURC', () => {
  expect(searchWatchlistCoins(catalog, [], 'coin', 2)).toHaveLength(2);
  expect(searchWatchlistCoins(catalog, [], 'euroc', 50)[0].id).toBe(
    'coin:eurc',
  );
});
