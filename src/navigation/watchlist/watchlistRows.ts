import {SupportedCurrencyOptions} from '../../constants/SupportedCurrencyOptions';
import type {WatchlistCoin} from '../../store/watchlist/watchlist.models';
import {coinSymbol, type CoinCatalog} from '../../store/watchlist/coins';
import {getCoinCatalog} from '../../store/watchlist/coin-registry';
import type {Rates, FiatRateSeriesCache} from '../../store/rate/rate.models';
import buildHomeExchangeRateItems from '../tabs/home/homeExchangeRates';
import {getAssetCurrentDisplayQuoteRate} from '../../utils/portfolio/displayCurrency';
import {
  getCurrencyAbbreviation,
  calculatePercentageDifference,
} from '../../utils/helper-methods';
import type {ExchangeRateItemProps} from '../tabs/home/components/exchange-rates/ExchangeRateItem';

export const watchlistImage = (coin: Pick<WatchlistCoin, 'image'>) =>
  'uri' in coin.image
    ? coin.image.uri
    : SupportedCurrencyOptions.find(
        option =>
          'builtin' in coin.image &&
          option.currencyAbbreviation === coin.image.builtin,
      )?.img || '';
export const watchlistAsset = (
  coin: WatchlistCoin,
  catalog: CoinCatalog = getCoinCatalog(),
) => {
  const resolved = catalog.resolveAsset(coin.selector);
  if (resolved) return resolved.asset;
  const selector = coin.selector;
  return 'coin' in selector
    ? {
        currencyAbbreviation: selector.coin,
        chain: selector.coin === 'pol' ? 'matic' : selector.coin,
      }
    : {currencyAbbreviation: coin.symbol.toLowerCase(), ...selector};
};
export const buildWatchlistRows = (
  items: WatchlistCoin[],
  rates: Rates,
  lastDayRates: Rates,
  quoteCurrency: string,
  fiatRateSeriesCache: FiatRateSeriesCache,
): ExchangeRateItemProps[] => {
  const builtInRows = buildHomeExchangeRateItems({
    rates,
    lastDayRates,
    quoteCurrency,
    fiatRateSeriesCache,
    exchangeRateCurrencies: SupportedCurrencyOptions.map(
      option => option.currencyAbbreviation,
    ),
    supportedCurrencyOptions: SupportedCurrencyOptions,
    isStableCoinCurrencyName: () => false,
  });
  return items.map(coin => {
    const asset = watchlistAsset(coin);
    const builtin = getCoinCatalog().resolveAsset(coin.selector)?.builtIn
      ? builtInRows.find(
          row =>
            coinSymbol(row.currencyAbbreviation) ===
            coinSymbol(asset.currencyAbbreviation),
        )
      : undefined;
    const currentPrice =
      builtin?.currentPrice ??
      getAssetCurrentDisplayQuoteRate({...asset, rates, quoteCurrency});
    const key = getCurrencyAbbreviation(
      asset.tokenAddress || asset.currencyAbbreviation,
      asset.chain,
    );
    const previous = lastDayRates[key]?.find(
      rate => rate.code.toUpperCase() === quoteCurrency.toUpperCase(),
    )?.rate;
    return {
      ...asset,
      id: coin.id,
      currencyName: coin.name,
      currencyAbbreviation: coin.symbol,
      img: watchlistImage(coin),
      currentPrice,
      average:
        builtin?.average ??
        (currentPrice && previous
          ? calculatePercentageDifference(currentPrice, previous)
          : undefined),
    };
  });
};
