import {
  WATCHLIST_BROWSE_ORDER,
  type CoinCatalog,
  coinSymbol,
} from '../../store/watchlist/coins';
import type {WatchlistCoin} from '../../store/watchlist/watchlist.models';

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
      const coin = catalog.byId.get(`coin:${symbol}`);
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
