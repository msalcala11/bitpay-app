import type {SupportedCurrencyOption} from '../../constants/SupportedCurrencyOptions';
import type {TokenData} from '../../managers/TokenManager';
import type {PriceAlertSelector} from '../../api/price-alerts/price-alerts.types';
import type {WatchlistAsset, WatchlistCoin} from './watchlist.models';

export const DEFAULT_WATCHLIST = [
  'btc',
  'eth',
  'bch',
  'sol',
  'xrp',
  'doge',
  'ltc',
  'pol',
];
export const WATCHLIST_BROWSE_ORDER = [
  'btc',
  'eth',
  'xrp',
  'sol',
  'doge',
  'wbtc',
  'weth',
  'shib',
  'ltc',
  'bch',
  'arb',
  'pol',
  'op',
  'ape',
  'usdt',
  'usdc',
  'dai',
  'pyusd',
  'eurc',
  'usdp',
  'gusd',
  'busd',
];
const CHAIN_ORDER = ['eth', 'matic', 'arb', 'base', 'op', 'sol', 'arc'];
const SUFFIX_CHAIN: Record<string, string> = {
  e: 'eth',
  m: 'matic',
  arb: 'arb',
  base: 'base',
  op: 'op',
  sol: 'sol',
  arc: 'arc',
};

export const coinSymbol = (symbol: string) => {
  const s = symbol.toLowerCase();
  return s === 'matic'
    ? 'pol'
    : s === 'euroc'
    ? 'eurc'
    : s === 'usdc.e'
    ? 'usdc'
    : s;
};
const address = (chain: string, value: string) =>
  chain === 'sol' ? value : value.toLowerCase();
export const assetKey = (asset: WatchlistAsset) =>
  `${asset.chain.toLowerCase()}:${
    asset.tokenAddress
      ? address(asset.chain.toLowerCase(), asset.tokenAddress)
      : coinSymbol(asset.currencyAbbreviation)
  }`;
export const selectorKey = (selector: PriceAlertSelector) =>
  'coin' in selector
    ? `native:${coinSymbol(selector.coin)}`
    : `token:${selector.chain.toLowerCase()}:${address(
        selector.chain.toLowerCase(),
        selector.tokenAddress,
      )}`;

export interface WatchlistSearchEntry extends WatchlistCoin {
  // A transient React/search key. Never persisted or used by the request queue.
  displayKey: string;
}
export interface CatalogAsset {
  asset: WatchlistAsset;
  name: string;
  symbol: string;
  image: WatchlistCoin['image'];
  builtIn: boolean;
}
export interface CoinCatalog {
  coins: WatchlistSearchEntry[];
  // Built-in defaults only. Listed tickers can have multiple search entries.
  byId: Map<string, WatchlistSearchEntry>;
  match: (asset: WatchlistAsset) => WatchlistSearchEntry | undefined;
  resolveAsset: (
    asset: WatchlistAsset | PriceAlertSelector,
  ) => CatalogAsset | undefined;
  fromSelector: (selector: PriceAlertSelector) => WatchlistCoin | undefined;
}

export const watchlistCoin = ({
  id,
  name,
  symbol,
  image,
  selector,
}: WatchlistCoin): WatchlistCoin => ({id, name, symbol, image, selector});
const assetSelector = (asset: WatchlistAsset): PriceAlertSelector =>
  asset.tokenAddress
    ? {chain: asset.chain, tokenAddress: asset.tokenAddress}
    : {coin: coinSymbol(asset.currencyAbbreviation)};
const compareAssets = (a: CatalogAsset, b: CatalogAsset) =>
  CHAIN_ORDER.indexOf(a.asset.chain) - CHAIN_ORDER.indexOf(b.asset.chain) ||
  (a.asset.tokenAddress || '').localeCompare(b.asset.tokenAddress || '');

// Search groups are rebuilt from scratch. Only ticker IDs are ever stored.
export const buildCoinCatalog = (
  options: SupportedCurrencyOption[],
  data: TokenData,
): CoinCatalog => {
  const byId = new Map<string, WatchlistSearchEntry>();
  const exact = new Map<string, CatalogAsset>();
  const entries = new Map<string, WatchlistSearchEntry>();
  const builtInAssets = new Map<string, CatalogAsset[]>();
  for (const opt of options) {
    const symbol = coinSymbol(opt.currencyAbbreviation);
    const id = `coin:${symbol}`;
    const asset = {
      currencyAbbreviation: opt.currencyAbbreviation,
      chain: opt.chain,
      tokenAddress: opt.tokenAddress,
    };
    const resolved = {
      asset,
      name: opt.currencyName,
      symbol: opt.currencyAbbreviation.toUpperCase(),
      image: {builtin: opt.currencyAbbreviation},
      builtIn: true,
    };
    exact.set(assetKey(asset), resolved);
    builtInAssets.set(id, [...(builtInAssets.get(id) || []), resolved]);
    if (!byId.has(id))
      byId.set(id, {
        id,
        displayKey: id,
        name: opt.currencyName,
        symbol: symbol.toUpperCase(),
        image: resolved.image,
        selector: {coin: symbol},
      });
    entries.set(assetKey(asset), byId.get(id)!);
  }
  for (const [id, assets] of builtInAssets) {
    const coin = byId.get(id)!;
    const native = DEFAULT_WATCHLIST.includes(coinSymbol(coin.symbol));
    const preferred = assets
      .sort(compareAssets)
      .find(value => !!value.asset.tokenAddress);
    coin.selector = native
      ? {coin: coinSymbol(coin.symbol)}
      : assetSelector(preferred!.asset);
  }
  const groups = new Map<
    string,
    {entry: WatchlistSearchEntry; assets: CatalogAsset[]}
  >();
  for (const [key, token] of Object.entries(data.tokenOptionsByAddress)) {
    const chain =
      data.tokenDataByAddress[key]?.chain ||
      SUFFIX_CHAIN[key.split('_').pop() || ''];
    if (!CHAIN_ORDER.includes(chain) || !token.address) continue;
    const asset = {
      currencyAbbreviation: token.symbol.toLowerCase(),
      chain,
      tokenAddress: address(chain, token.address),
    };
    if (exact.has(assetKey(asset))) continue;
    const resolved = {
      asset,
      name: token.name,
      symbol: token.symbol,
      image: {uri: token.logoURI || ''},
      builtIn: false,
    };
    exact.set(assetKey(asset), resolved);
    const id = `coin:${coinSymbol(token.symbol)}`;
    const builtin = byId.get(id);
    if (builtin) {
      entries.set(assetKey(asset), builtin);
      continue;
    }
    const displayKey = JSON.stringify([
      token.name,
      token.symbol,
      token.logoURI || '',
    ]);
    let group = groups.get(displayKey);
    if (!group) {
      group = {
        entry: {
          id,
          displayKey,
          name: token.name,
          symbol: coinSymbol(token.symbol).toUpperCase(),
          image: resolved.image,
          selector: assetSelector(asset),
        },
        assets: [],
      };
      groups.set(displayKey, group);
    }
    group.assets.push(resolved);
    entries.set(assetKey(asset), group.entry);
  }
  for (const {entry, assets} of groups.values())
    entry.selector = assetSelector(assets.sort(compareAssets)[0].asset);
  const symbolChains = new Map<string, CatalogAsset | null>();
  for (const resolved of exact.values()) {
    const key = `${resolved.asset.chain}:${coinSymbol(
      resolved.asset.currencyAbbreviation,
    )}`;
    const previous = symbolChains.get(key);
    if (previous?.builtIn && !resolved.builtIn) continue;
    symbolChains.set(
      key,
      previous === undefined ||
        (previous &&
          entries.get(assetKey(previous.asset)) ===
            entries.get(assetKey(resolved.asset)))
        ? resolved
        : null,
    );
  }
  const resolveAsset = (
    input: WatchlistAsset | PriceAlertSelector,
  ): CatalogAsset | undefined => {
    if ('coin' in input) {
      const entry = byId.get(`coin:${coinSymbol(input.coin)}`);
      if (!entry) return undefined;
      if (!('coin' in entry.selector)) return resolveAsset(entry.selector);
      const chain =
        input.coin === 'pol' || input.coin === 'matic'
          ? 'matic'
          : coinSymbol(input.coin);
      return exact.get(assetKey({chain, currencyAbbreviation: input.coin}));
    }
    if (
      'network' in input &&
      input.network &&
      !['livenet', 'mainnet'].includes(input.network)
    )
      return undefined;
    const asset = {
      ...input,
      currencyAbbreviation:
        'currencyAbbreviation' in input ? input.currencyAbbreviation : '',
    };
    return (
      exact.get(assetKey(asset)) ||
      (!asset.tokenAddress
        ? symbolChains.get(
            `${asset.chain.toLowerCase()}:${coinSymbol(
              asset.currencyAbbreviation,
            )}`,
          ) || undefined
        : undefined)
    );
  };
  return {
    coins: [
      ...byId.values(),
      ...[...groups.values()].map(group => group.entry),
    ],
    byId,
    resolveAsset,
    match: asset => {
      const resolved = resolveAsset(asset);
      return resolved && entries.get(assetKey(resolved.asset));
    },
    fromSelector: selector => {
      const resolved = resolveAsset(selector);
      if (!resolved) return undefined;
      const symbol = coinSymbol(resolved.symbol);
      return {
        id: `coin:${symbol}`,
        name: resolved.name,
        symbol: symbol.toUpperCase(),
        image: resolved.image,
        selector: assetSelector(resolved.asset),
      };
    },
  };
};

// Eligibility is checked before either membership path, including exact matches.
export const findWatchlistRow = (
  catalog: CoinCatalog,
  items: WatchlistCoin[],
  input: WatchlistAsset | PriceAlertSelector,
) => {
  const resolved = catalog.resolveAsset(input);
  if (!resolved) return undefined;
  const selector = selectorKey(assetSelector(resolved.asset));
  return (
    items.find(item => selectorKey(item.selector) === selector) ||
    items.find(item => item.id === `coin:${coinSymbol(resolved.symbol)}`)
  );
};

export const alertCurrency = (code: string) =>
  [
    'USD',
    'INR',
    'GBP',
    'EUR',
    'CAD',
    'COP',
    'NGN',
    'BRL',
    'ARS',
    'AUD',
    'JPY',
    'NZD',
  ].includes(code.toUpperCase())
    ? code.toUpperCase()
    : 'USD';

export const alertsDeliverable = (
  permissionAllowed: boolean,
  pushEnabled: boolean,
  priceAlertsEnabled: boolean,
) => permissionAllowed && pushEnabled && priceAlertsEnabled;
