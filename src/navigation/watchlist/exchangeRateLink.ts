import type {CoinCatalog} from '../../store/watchlist/coins';
import {coinSymbol} from '../../store/watchlist/coins';
import type {
  WatchlistAsset,
  WatchlistCoin,
} from '../../store/watchlist/watchlist.models';
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
  const resolved = link.tokenAddress
    ? catalog.resolveAsset({
        currencyAbbreviation: symbol,
        chain,
        tokenAddress: link.tokenAddress,
      })
    : catalog.resolveAsset({coin: symbol}) ||
      catalog.resolveAsset({currencyAbbreviation: symbol, chain});
  if (!resolved)
    return {status: link.tokenAddress && !tokensReady ? 'waiting' : 'unknown'};
  const selector = resolved.asset.tokenAddress
    ? {chain: resolved.asset.chain, tokenAddress: resolved.asset.tokenAddress}
    : {coin: coinSymbol(resolved.asset.currencyAbbreviation)};
  return {
    status: 'resolved',
    coin: catalog.fromSelector(selector)!,
    asset: resolved.asset,
  };
};
