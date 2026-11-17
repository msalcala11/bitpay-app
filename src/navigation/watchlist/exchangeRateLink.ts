import type {CoinCatalog} from '../../store/watchlist/coins';
import {coinSymbol} from '../../store/watchlist/coins';
import type {
  WatchlistAsset,
  WatchlistCoin,
} from '../../store/watchlist/watchlist.models';
import {watchlistAsset} from './watchlistRows';
export type ExchangeRateLink = {
  currencyAbbreviation?: string;
  chain?: string;
  tokenAddress?: string;
  notification_type?: string;
  code?: string;
  nonce?: number;
};
const decode = (value?: string) => {
  try {
    return value ? decodeURIComponent(value) : undefined;
  } catch {
    return undefined;
  }
};
export const parseExchangeRateLink = (
  params: ExchangeRateLink,
): ExchangeRateLink => ({
  currencyAbbreviation: decode(params.currencyAbbreviation)?.toLowerCase(),
  chain: decode(params.chain)?.toLowerCase(),
  tokenAddress: decode(params.tokenAddress),
  notification_type: decode(params.notification_type),
  code: decode(params.code),
  nonce: params.nonce,
});
export const resolveExchangeRateLink = (
  params: ExchangeRateLink,
  catalog: CoinCatalog,
  tokensReady: boolean,
):
  | {status: 'waiting' | 'unknown'}
  | {status: 'resolved'; coin: WatchlistCoin; asset: WatchlistAsset} => {
  const link = parseExchangeRateLink(params);
  if (!link.currencyAbbreviation) {
    return {status: 'unknown'};
  }
  const symbol = coinSymbol(link.currencyAbbreviation);
  const chain = link.chain || (symbol === 'pol' ? 'matic' : symbol);
  const coin = link.tokenAddress
    ? catalog.match({
        currencyAbbreviation: symbol,
        chain,
        tokenAddress: link.tokenAddress,
      })
    : catalog.byId.get(`coin:${symbol}`) ||
      catalog.match({currencyAbbreviation: symbol, chain});
  if (!coin) {
    return {status: link.tokenAddress && !tokensReady ? 'waiting' : 'unknown'};
  }
  const asset = link.tokenAddress
    ? coin.assets.find(
        candidate =>
          candidate.chain === chain &&
          (chain === 'sol'
            ? candidate.tokenAddress === link.tokenAddress
            : candidate.tokenAddress?.toLowerCase() ===
              link.tokenAddress?.toLowerCase()),
      )!
    : watchlistAsset(coin);
  return {status: 'resolved', coin, asset};
};
