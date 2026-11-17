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
  'pol',
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

export interface CoinCatalog {
  coins: WatchlistCoin[];
  byId: Map<string, WatchlistCoin>;
  match: (asset: WatchlistAsset) => WatchlistCoin | undefined;
  fromSelector: (selector: PriceAlertSelector) => WatchlistCoin | undefined;
}

// Pure builder; the registry wrapper calls it once per TokenManager update.
export const buildCoinCatalog = (
  options: SupportedCurrencyOption[],
  data: TokenData,
  previousCoins: WatchlistCoin[] = [],
): CoinCatalog => {
  const byId = new Map<string, WatchlistCoin>();
  const byAsset = new Map<string, WatchlistCoin>();
  const builtInNames = new Map<string, WatchlistCoin>();
  for (const opt of options) {
    const symbol = coinSymbol(opt.currencyAbbreviation);
    const id = `coin:${symbol}`;
    let coin = byId.get(id);
    if (!coin) {
      coin = {
        id,
        name: opt.currencyName,
        symbol: symbol.toUpperCase(),
        image: {builtin: opt.currencyAbbreviation},
        assets: [],
        selector: {coin: symbol},
      };
      byId.set(id, coin);
    }
    const asset = {
      currencyAbbreviation: opt.currencyAbbreviation,
      chain: opt.chain,
      tokenAddress: opt.tokenAddress,
    };
    coin.assets.push(asset);
    byAsset.set(assetKey(asset), coin);
    builtInNames.set(`${opt.currencyName.toLowerCase()}|${symbol}`, coin);
  }

  const tokens = Object.entries(data.tokenOptionsByAddress).flatMap(
    ([key, token]) => {
      const chain =
        data.tokenDataByAddress[key]?.chain ||
        SUFFIX_CHAIN[key.split('_').pop() || ''];
      if (!CHAIN_ORDER.includes(chain) || !token.address) {
        return [];
      }
      return [
        {
          token,
          asset: {
            currencyAbbreviation: token.symbol.toLowerCase(),
            chain,
            tokenAddress: address(chain, token.address),
          },
          group: JSON.stringify([
            token.name,
            token.symbol,
            token.logoURI || '',
          ]),
        },
      ];
    },
  );
  const builtinGroups = new Map<string, WatchlistCoin>();
  const previousIds = new Map<string, string>();
  for (const coin of previousCoins) {
    if (coin.id.startsWith('listed:')) {
      for (const asset of coin.assets) {
        previousIds.set(assetKey(asset), coin.id);
      }
    }
  }
  const groupIds = new Map<string, string>();
  const assignedIds = new Set<string>();
  for (const entry of tokens) {
    const previousId = previousIds.get(assetKey(entry.asset));
    if (
      previousId &&
      !groupIds.has(entry.group) &&
      !assignedIds.has(previousId)
    ) {
      groupIds.set(entry.group, previousId);
      assignedIds.add(previousId);
    }
    const builtin = byAsset.get(assetKey(entry.asset));
    if (builtin) {
      builtinGroups.set(entry.group, builtin);
    }
  }
  const listedGroups = new Map<string, WatchlistCoin>();
  for (const {token, asset, group} of tokens) {
    const known = byAsset.get(assetKey(asset));
    if (known) {
      continue;
    }
    let id = groupIds.get(group) || `listed:${group}`;
    let coin =
      builtinGroups.get(group) ||
      builtInNames.get(
        `${token.name.toLowerCase()}|${coinSymbol(token.symbol)}`,
      ) ||
      listedGroups.get(group);
    if (!coin) {
      if (byId.has(id)) {
        id = `${id}:${assetKey(asset)}`;
      }
      coin = {
        id,
        name: token.name,
        symbol: token.symbol,
        image: {uri: token.logoURI || ''},
        assets: [],
        selector: {chain: asset.chain, tokenAddress: asset.tokenAddress},
      };
      byId.set(id, coin);
    }
    listedGroups.set(group, coin);
    coin.assets.push(asset);
    byAsset.set(assetKey(asset), coin);
  }
  const coins = [...byId.values()];
  const symbolChains = new Map<string, WatchlistCoin | null>();
  for (const coin of coins) {
    coin.assets.sort(
      (a, b) =>
        CHAIN_ORDER.indexOf(a.chain) - CHAIN_ORDER.indexOf(b.chain) ||
        (a.tokenAddress || '').localeCompare(b.tokenAddress || ''),
    );
    const native =
      coin.id.startsWith('coin:') &&
      DEFAULT_WATCHLIST.includes(coinSymbol(coin.symbol));
    const preferred = coin.assets.find(asset => !!asset.tokenAddress);
    coin.selector = native
      ? {coin: coinSymbol(coin.symbol)}
      : {chain: preferred!.chain, tokenAddress: preferred!.tokenAddress!};
    for (const asset of coin.assets) {
      const key = `${asset.chain}:${coinSymbol(asset.currencyAbbreviation)}`;
      const previous = symbolChains.get(key);
      symbolChains.set(
        key,
        previous === undefined || previous?.id === coin.id ? coin : null,
      );
    }
  }
  const match = (asset: WatchlistAsset) => {
    if (asset.network && !['livenet', 'mainnet'].includes(asset.network)) {
      return undefined;
    }
    return asset.tokenAddress
      ? byAsset.get(assetKey(asset))
      : byAsset.get(assetKey(asset)) ||
          symbolChains.get(
            `${asset.chain.toLowerCase()}:${coinSymbol(
              asset.currencyAbbreviation,
            )}`,
          ) ||
          undefined;
  };
  return {
    coins,
    byId,
    match,
    fromSelector: selector =>
      'coin' in selector
        ? byId.get(`coin:${coinSymbol(selector.coin)}`)
        : match({currencyAbbreviation: '', ...selector}),
  };
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
