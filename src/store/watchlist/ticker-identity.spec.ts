import {SupportedCurrencyOptions} from '../../constants/SupportedCurrencyOptions';
import {buildCoinCatalog, findWatchlistRow} from './coins';

const token = (name: string, symbol: string, address: string) => ({
  name,
  symbol,
  address,
  decimals: 18,
  logoURI: name + '.png',
});
const data = (tokens: Record<string, ReturnType<typeof token>>) => ({
  tokenOptionsByAddress: tokens,
  tokenDataByAddress: {},
});
const a = {chain: 'eth', tokenAddress: '0xa', currencyAbbreviation: 'same'};
const b = {chain: 'matic', tokenAddress: '0xb', currencyAbbreviation: 'same'};

it('uses permanent ticker row IDs with distinct ephemeral search keys and exact selectors', () => {
  const catalog = buildCoinCatalog(
    [],
    data({
      '0xa_e': token('First', 'SAME', '0xa'),
      '0xb_m': token('Second', 'SAME', '0xb'),
    }),
  );
  expect(catalog.coins.map(entry => entry.id)).toEqual([
    'coin:same',
    'coin:same',
  ]);
  expect(new Set(catalog.coins.map(entry => entry.displayKey)).size).toBe(2);
  expect(catalog.coins.map(entry => entry.selector)).toEqual([
    {chain: 'eth', tokenAddress: '0xa'},
    {chain: 'matic', tokenAddress: '0xb'},
  ]);
  expect(catalog.fromSelector(a)).not.toHaveProperty('assets');
  const row = catalog.fromSelector(a)!;
  expect(findWatchlistRow(catalog, [row], a)).toBe(row);
  expect(findWatchlistRow(catalog, [row], b)).toBe(row);
});

it('matches the chosen contract before a renamed ticker while still rejecting ineligible assets', () => {
  const before = buildCoinCatalog(
    [],
    data({'0xa_e': token('First', 'SAME', '0xa')}),
  );
  const row = before.fromSelector(a)!;
  const after = buildCoinCatalog(
    [],
    data({'0xa_e': token('Renamed', 'NEW', '0xa')}),
  );
  expect(findWatchlistRow(after, [row], a)).toBe(row);
  expect(
    findWatchlistRow(after, [row], {...a, network: 'testnet'}),
  ).toBeUndefined();
  expect(
    findWatchlistRow(after, [row], {...a, tokenAddress: '0xcustom'}),
  ).toBeUndefined();
});

it('uses only the ticker to join built-in search entries and preserves their defaults', () => {
  const before = buildCoinCatalog(SupportedCurrencyOptions, data({}));
  const after = buildCoinCatalog(
    SupportedCurrencyOptions,
    data({
      '0x0000_e': token('Unrelated name', 'USDC', '0x0000'),
      '0xother_m': token('USD Coin', 'DIFFERENT', '0xother'),
    }),
  );
  expect(after.match({...a, tokenAddress: '0x0000'})?.id).toBe('coin:usdc');
  expect(after.coins.filter(entry => entry.id === 'coin:usdc')).toHaveLength(1);
  expect(after.byId.get('coin:usdc')?.selector).toEqual(
    before.byId.get('coin:usdc')?.selector,
  );
  expect(after.match({...b, tokenAddress: '0xother'})?.id).toBe(
    'coin:different',
  );
});

it('resolves exact asset metadata independently of its search group or watched ticker', () => {
  const catalog = buildCoinCatalog(
    [],
    data({
      '0xa_e': token('First', 'SAME', '0xa'),
      '0xb_m': token('Second', 'SAME', '0xb'),
    }),
  );
  expect(catalog.resolveAsset(b)).toMatchObject({
    asset: b,
    name: 'Second',
    symbol: 'SAME',
    image: {uri: 'Second.png'},
  });
  expect(catalog.fromSelector(b)).toMatchObject({
    id: 'coin:same',
    name: 'Second',
    selector: {chain: 'matic', tokenAddress: '0xb'},
  });
});
