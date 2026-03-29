import React, {useCallback, useEffect, useMemo, useRef} from 'react';
import {AppState, AppStateStatus} from 'react-native';
import {useTranslation} from 'react-i18next';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {SupportedCurrencyOptions} from '../../../../constants/SupportedCurrencyOptions';
import {EXCHANGE_RATES_CURRENCIES} from '../../../../constants/config';
import {
  BitpaySupportedCoins,
  BitpaySupportedTokens,
} from '../../../../constants/currencies';
import type {Rate, Rates} from '../../../../store/rate/rate.models';
import {getCoinAndChainFromCurrencyCode} from '../../../bitpay-id/utils/bitpay-id-utils';
import {
  calculatePercentageDifference,
  getCurrencyAbbreviation,
  getLastDayTimestampStartOfHourMs,
} from '../../../../utils/helper-methods';
import {useAppSelector} from '../../../../utils/hooks';
import {getFiatRateFromSeriesCacheAtTimestamp} from '../../../../utils/portfolio/rate';
import {
  findSupportedCurrencyOptionForAsset,
  getQuoteCurrency,
} from '../../../../utils/portfolio/assets';
import {measurePerfSync} from '../../../../utils/perfLogger';
import HomeSection from './HomeSection';
import ExchangeRatesList, {
  ExchangeRateItemProps,
} from './exchange-rates/ExchangeRatesList';

type HomeExchangeRatesSectionProps = {
  currencyAbbreviation?: string;
  navigation: NativeStackNavigationProp<any>;
  showArchaxBanner: boolean;
};

const HomeExchangeRatesSection = ({
  currencyAbbreviation,
  navigation,
  showArchaxBanner,
}: HomeExchangeRatesSectionProps) => {
  const {t} = useTranslation();
  const defaultAltCurrency = useAppSelector(({APP}) => APP.defaultAltCurrency);
  const lastDayRates = useAppSelector(({RATE}) => RATE.lastDayRates) as Rates;
  const rates = useAppSelector(({RATE}) => RATE.rates) as Rates;
  const fiatRateSeriesCache = useAppSelector(
    ({RATE}) => RATE.fiatRateSeriesCache,
  );
  const portfolioQuoteCurrency = useAppSelector(
    ({PORTFOLIO}) => PORTFOLIO.quoteCurrency,
  );

  const quoteCurrency = getQuoteCurrency({
    portfolioQuoteCurrency,
    defaultAltCurrencyIsoCode: defaultAltCurrency?.isoCode,
  }).toUpperCase();

  const items = useMemo<Array<ExchangeRateItemProps>>(() => {
    return measurePerfSync(
      'screen.home_root.exchange_rates_list',
      () => {
        const baselineTimestampMs = getLastDayTimestampStartOfHourMs();
        const result = (
          Object.entries(lastDayRates) as Array<[string, Rate[]]>
        ).reduce((ratesList, [key, lastDayRate]) => {
          const lastDayRateForDefaultCurrency = lastDayRate.find(
            ({code}: {code: string}) => code === quoteCurrency,
          );
          const rateForDefaultCurrency = rates[key].find(
            ({code}: {code: string}) => code === quoteCurrency,
          );
          const {coin: targetCoin, chain: targetChain} =
            getCoinAndChainFromCurrencyCode(key);
          const option = findSupportedCurrencyOptionForAsset({
            options: SupportedCurrencyOptions,
            currencyAbbreviation: targetCoin,
            chain: targetChain,
          });

          if (option && option.chain && option.currencyAbbreviation) {
            const currencyName = getCurrencyAbbreviation(
              option.tokenAddress
                ? option.tokenAddress
                : option.currencyAbbreviation,
              option.chain,
            );
            const isStableCoin =
              BitpaySupportedCoins[currencyName]?.properties?.isStableCoin ||
              BitpaySupportedTokens[currencyName]?.properties?.isStableCoin;

            if (
              rateForDefaultCurrency?.rate &&
              !isStableCoin &&
              EXCHANGE_RATES_CURRENCIES.includes(
                option.currencyAbbreviation.toLowerCase(),
              )
            ) {
              const prevRateFromSeries = getFiatRateFromSeriesCacheAtTimestamp({
                fiatRateSeriesCache,
                fiatCode: quoteCurrency,
                currencyAbbreviation: option.currencyAbbreviation,
                interval: '1D',
                timestampMs: baselineTimestampMs,
                method: 'linear',
              });
              const prevRate =
                prevRateFromSeries ?? lastDayRateForDefaultCurrency?.rate;

              if (!(prevRate && prevRate > 0)) {
                return ratesList;
              }

              const {
                id,
                img,
                currencyName: optionCurrencyName,
                currencyAbbreviation: optionCurrencyAbbreviation,
                chain,
                tokenAddress,
              } = option;

              const percentChange = calculatePercentageDifference(
                rateForDefaultCurrency.rate,
                prevRate,
              );

              ratesList.push({
                id,
                img,
                currencyName: optionCurrencyName,
                currencyAbbreviation: optionCurrencyAbbreviation,
                chain,
                tokenAddress,
                average: percentChange,
                currentPrice: rateForDefaultCurrency.rate,
              });
            }
          }
          return ratesList;
        }, [] as ExchangeRateItemProps[]);

        return result.sort((a, b) => {
          const indexA = EXCHANGE_RATES_CURRENCIES.indexOf(
            a.currencyAbbreviation.toLowerCase(),
          );
          const indexB = EXCHANGE_RATES_CURRENCIES.indexOf(
            b.currencyAbbreviation.toLowerCase(),
          );

          if (indexA !== -1 && indexB !== -1) {
            return indexA - indexB;
          }
          if (indexA !== -1) {
            return -1;
          }
          if (indexB !== -1) {
            return 1;
          }
          return a.currencyName.localeCompare(b.currencyName);
        });
      },
      {
        lastDayRateAssetCount: Object.keys(lastDayRates || {}).length,
        quoteCurrency,
        screen: 'HomeRoot',
      },
    );
  }, [fiatRateSeriesCache, lastDayRates, quoteCurrency, rates]);

  const exchangeRatesRef = useRef(items);
  useEffect(() => {
    exchangeRatesRef.current = items;
  }, [items]);

  const handleAppStateChange = useCallback(
    (status: AppStateStatus) => {
      if (status !== 'active' || !currencyAbbreviation) {
        return;
      }

      navigation.setParams({
        currencyAbbreviation: undefined,
      });

      const {coin: targetAbbreviation} =
        getCoinAndChainFromCurrencyCode(currencyAbbreviation);
      const exchangeRatesSection = exchangeRatesRef.current.find(
        ({currencyAbbreviation: abbr}) =>
          abbr.toLowerCase() === targetAbbreviation,
      );

      if (!exchangeRatesSection) {
        return;
      }

      navigation
        .getParent<NativeStackNavigationProp<any>>()
        ?.navigate('ExchangeRate', {
          currencyName: exchangeRatesSection.currencyName,
          currencyAbbreviation: exchangeRatesSection.currencyAbbreviation,
          chain: exchangeRatesSection.chain,
          tokenAddress: exchangeRatesSection.tokenAddress,
        });
    },
    [currencyAbbreviation, navigation],
  );

  useEffect(() => {
    const subscriptionAppStateChange = AppState.addEventListener(
      'change',
      handleAppStateChange,
    );

    return () => subscriptionAppStateChange.remove();
  }, [handleAppStateChange]);

  if (showArchaxBanner || !items.length) {
    return null;
  }

  return (
    <HomeSection title={t('Exchange Rates')} label="24H">
      <ExchangeRatesList
        items={items}
        defaultAltCurrencyIsoCode={defaultAltCurrency.isoCode}
      />
    </HomeSection>
  );
};

export default React.memo(HomeExchangeRatesSection);
