import {
  buildWatchlistRows,
  watchlistImage,
  watchlistAsset,
} from './watchlistRows';
import buildHomeExchangeRateItems from '../tabs/home/homeExchangeRates';
import {buildCoinCatalog} from '../../store/watchlist/coins';
import {SupportedCurrencyOptions} from '../../constants/SupportedCurrencyOptions';
import type {Rates} from '../../store/rate/rate.models';
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
    {
      currencyAbbreviation: 'btc',
      chain: 'btc',
      currentPrice: 123,
      average: 4.5,
    },
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

describe('exact-asset built-in row prices', () => {
  const catalog = buildCoinCatalog(SupportedCurrencyOptions, {
    tokenOptionsByAddress: {},
    tokenDataByAddress: {},
  });
  const usdc = catalog.byId.get('coin:usdc')!;
  const eth = catalog.byId.get('coin:eth')!;
  const polygon = SupportedCurrencyOptions.find(
    option =>
      option.currencyAbbreviation === 'usdc.e' && option.chain === 'matic',
  )!;
  const solana = SupportedCurrencyOptions.find(
    option => option.currencyAbbreviation === 'usdc' && option.chain === 'sol',
  )!;
  const rate = (value: number) => [
    {code: 'USD', rate: value, name: 'US Dollar', ts: 0, fetchedOn: 0},
  ];
  const precomputed = (asset = watchlistAsset(usdc), extra = {}) => ({
    ...asset,
    currentPrice: 123,
    average: 4.5,
    ...extra,
  });

  it.each([true, false])(
    'prices restored Polygon USDC.e from its own asset (precomputed: %s)',
    hasPrecomputed => {
      const coin = catalog.fromSelector({
        chain: 'matic',
        tokenAddress: polygon.tokenAddress!,
      })!;
      const ethereum = watchlistAsset(usdc).tokenAddress!;
      const builtIn = [
        precomputed(watchlistAsset(usdc), {currentPrice: 1.2, average: 20}),
      ];
      if (hasPrecomputed)
        builtIn.push(
          precomputed(watchlistAsset(coin), {
            currentPrice: 0.9,
            average: -10,
          }),
        );
      (buildHomeExchangeRateItems as jest.Mock).mockReturnValueOnce(builtIn);
      const [row] = buildWatchlistRows(
        [coin],
        {
          [ethereum]: rate(1.2),
          [polygon.tokenAddress!]: rate(0.9),
        },
        {[ethereum]: rate(1), [polygon.tokenAddress!]: rate(1)},
        'USD',
        {},
      );
      expect(row.currentPrice).toBe(0.9);
      expect(row.average).toBeCloseTo(-10);
    },
  );

  it.each([usdc, eth])(
    'preserves the exact built-in result for $symbol',
    coin => {
      (buildHomeExchangeRateItems as jest.Mock).mockReturnValueOnce([
        precomputed(watchlistAsset(coin)),
      ]);
      const key =
        watchlistAsset(coin).tokenAddress || coin.symbol.toLowerCase();
      const [row] = buildWatchlistRows(
        [coin],
        {[key]: rate(4)},
        {[key]: rate(2)},
        'USD',
        {},
      );
      expect(row).toMatchObject({currentPrice: 123, average: 4.5});
    },
  );

  it.each([4, undefined])(
    'falls back for a built-in token without an exact result (price: %s)',
    price => {
      const coin = catalog.fromSelector({
        chain: 'matic',
        tokenAddress: polygon.tokenAddress!,
      })!;
      (buildHomeExchangeRateItems as jest.Mock).mockReturnValueOnce([
        precomputed(),
      ]);
      const rates: Rates =
        price === undefined ? {} : {[polygon.tokenAddress!]: rate(price)};
      const [row] = buildWatchlistRows(
        [coin],
        rates,
        {[polygon.tokenAddress!]: rate(2)},
        'USD',
        {},
      );
      expect(row.currentPrice).toBe(price);
      expect(row.average).toBe(price === undefined ? undefined : 100);
    },
  );

  it.each([
    [
      'same address on a different chain',
      usdc,
      {...watchlistAsset(usdc), chain: 'matic'},
      false,
    ],
    [
      'EVM address case',
      usdc,
      {
        ...watchlistAsset(usdc),
        tokenAddress: watchlistAsset(usdc).tokenAddress!.toUpperCase(),
      },
      true,
    ],
    [
      'same Solana address case',
      catalog.fromSelector({chain: 'sol', tokenAddress: solana.tokenAddress!})!,
      {...solana},
      true,
    ],
    [
      'different Solana address case',
      catalog.fromSelector({chain: 'sol', tokenAddress: solana.tokenAddress!})!,
      {...solana, tokenAddress: solana.tokenAddress!.toLowerCase()},
      false,
    ],
    [
      'token versus main coin',
      eth,
      {...watchlistAsset(eth), tokenAddress: '0xlookalike'},
      false,
    ],
    [
      'main coins on different chains',
      eth,
      {...watchlistAsset(eth), chain: 'base'},
      false,
    ],
    [
      'main coin versus token',
      usdc,
      {...watchlistAsset(usdc), tokenAddress: undefined},
      false,
    ],
  ] as const)('matches exact identity: %s', (_, coin, candidate, matches) => {
    (buildHomeExchangeRateItems as jest.Mock).mockReturnValueOnce([
      precomputed(candidate),
    ]);
    const asset = watchlistAsset(coin);
    const key = asset.tokenAddress || asset.currencyAbbreviation;
    const [row] = buildWatchlistRows(
      [coin],
      {[key]: rate(4)},
      {[key]: rate(2)},
      'USD',
      {},
    );
    expect(row.currentPrice).toBe(matches ? 123 : 4);
    expect(row.average).toBe(matches ? 4.5 : 100);
  });

  it.each([
    {currentPrice: 123, average: undefined},
    {currentPrice: undefined, average: 4.5},
  ])('keeps both values from one exact built-in result: %j', values => {
    (buildHomeExchangeRateItems as jest.Mock).mockReturnValueOnce([
      precomputed(watchlistAsset(usdc), values),
    ]);
    const key = watchlistAsset(usdc).tokenAddress!;
    const [row] = buildWatchlistRows(
      [usdc],
      {[key]: rate(4)},
      {[key]: rate(2)},
      'USD',
      {},
    );
    expect(row).toMatchObject(values);
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

it('prices the chosen exact token even when another contract shares its ticker', () => {
  const row = {
    id: 'coin:shared',
    name: 'Token A',
    symbol: 'SHARED',
    image: {uri: 'a.png'},
    selector: {chain: 'matic', tokenAddress: '0xb'},
  };
  const rows = buildWatchlistRows(
    [row],
    {
      '0xb': [{code: 'USD', rate: 4, name: 'US Dollar', ts: 0, fetchedOn: 0}],
      '0xa': [{code: 'USD', rate: 99, name: 'US Dollar', ts: 0, fetchedOn: 0}],
    },
    {'0xb': [{code: 'USD', rate: 2, name: 'US Dollar', ts: 0, fetchedOn: 0}]},
    'USD',
    {},
  );
  expect(rows[0]).toMatchObject({
    tokenAddress: '0xb',
    chain: 'matic',
    currentPrice: 4,
    average: 100,
  });
});

it('opens the EURC row asset with the application abbreviation euroc', () => {
  const catalog = buildCoinCatalog(SupportedCurrencyOptions, {
    tokenDataByAddress: {},
    tokenOptionsByAddress: {},
  });
  const row = catalog.byId.get('coin:eurc')!;
  expect(watchlistAsset(row, catalog)).toMatchObject({
    currencyAbbreviation: 'euroc',
    chain: 'eth',
    tokenAddress:
      row.selector && 'tokenAddress' in row.selector
        ? row.selector.tokenAddress
        : undefined,
  });
});
