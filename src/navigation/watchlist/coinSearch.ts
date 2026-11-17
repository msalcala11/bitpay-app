import {
  WATCHLIST_BROWSE_ORDER,
  type CoinCatalog,
  coinSymbol,
} from '../../store/watchlist/coins';
import type {
  WatchlistAsset,
  WatchlistCoin,
} from '../../store/watchlist/watchlist.models';

// Resolve these browse entries from the loaded registry, retaining its display
// metadata, grouped identity, and preferred alert selector. Symbols alone can
// identify unrelated listed tokens.
const BROWSE_LISTED_ASSETS: Record<string, WatchlistAsset> = {
  // https://docs.arbitrum.foundation/deployment-addresses
  arb: {
    currencyAbbreviation: 'arb',
    chain: 'arb',
    tokenAddress: '0x912ce59144191c1204e64559fe8253a0e49e6548',
  },
  // https://specs.optimism.io/governance/gov-token.html
  op: {
    currencyAbbreviation: 'op',
    chain: 'op',
    tokenAddress: '0x4200000000000000000000000000000000000042',
  },
};

export const searchWatchlistCoins = (
  catalog: CoinCatalog,
  items: WatchlistCoin[],
  query: string,
  limit: number,
) => {
  const text = query.trim().toLowerCase().replace(/\s+/g, '');
  const watched = new Set(items.map(item => item.id));
  if (!text) {
    return WATCHLIST_BROWSE_ORDER.flatMap(symbol => {
      const listedAsset = BROWSE_LISTED_ASSETS[symbol];
      const coin =
        catalog.byId.get(`coin:${symbol}`) ||
        (listedAsset && catalog.match(listedAsset));
      return coin && !watched.has(coin.id) ? [coin] : [];
    });
  }
  const matches: WatchlistCoin[] = [];
  for (const coin of catalog.coins) {
    if (
      coin.name.toLowerCase().replace(/\s+/g, '').includes(text) ||
      coin.symbol.toLowerCase().includes(text) ||
      coinSymbol(coin.symbol).includes(coinSymbol(text))
    ) {
      matches.push(coin);
      if (matches.length >= limit) {
        break;
      }
    }
  }
  return matches;
};
