import {Effect} from '../../../index';
import axios from 'axios';
import {BASE_BWS_URL} from '../../../../constants/config';
import {SUPPORTED_VM_TOKENS} from '../../../../constants/currencies';
import {
  FIAT_RATE_SERIES_CACHED_INTERVALS,
  HistoricRate,
  Rate,
  Rates,
  getFiatRateSeriesCacheKey,
} from '../../../rate/rate.models';
import {isCacheKeyStale} from '../../utils/wallet';
import {
  HISTORIC_RATES_CACHE_DURATION,
  RATES_CACHE_DURATION,
} from '../../../../constants/wallet';
import {DEFAULT_DATE_RANGE} from '../../../../constants/rate';
import {
  failedGetRates,
  successGetRates,
  updateCacheKey,
} from '../../../rate/rate.actions';
import {CacheKeys} from '../../../rate/rate.models';
import moment from 'moment';
import {addAltCurrencyList} from '../../../app/app.actions';
import {AltCurrenciesRowProps} from '../../../../components/list/AltCurrenciesRow';
import {BitpaySupportedTokenOptsByAddress} from '../../../../constants/tokens';
import {
  addTokenChainSuffix,
  getLastDayTimestampStartOfHourMs,
  getErrorString,
} from '../../../../utils/helper-methods';
import {
  getMultipleTokenPrices,
  UnifiedTokenPriceObj,
} from '../../../../store/moralis/moralis.effects';
import {calculateUsdToAltFiat} from '../../../../store/buy-crypto/buy-crypto.effects';
import {IsERCToken} from '../../utils/currency';
import {UpdateAllKeyAndWalletStatusContext} from '../status/status';
import {tokenManager} from '../../../../managers/TokenManager';
import {logManager} from '../../../../managers/LogManager';
import type {Key, Wallet} from '../../wallet.models';

export const startGetRates =
  ({
    context,
    force,
  }: {
    context?: UpdateAllKeyAndWalletStatusContext;
    force?: boolean;
  }): Effect<Promise<Rates>> =>
  async (dispatch, getState) => {
    return new Promise(async resolve => {
      logManager.info('startGetRates: starting...');
      const {
        RATE: {ratesCacheKey, rates: cachedRates},
        APP: {altCurrencyList},
      } = getState();
      if (
        !isCacheKeyStale(
          ratesCacheKey[DEFAULT_DATE_RANGE],
          RATES_CACHE_DURATION,
        ) &&
        !force &&
        altCurrencyList.length > 0
      ) {
        logManager.info('startGetRates: success (using cached rates)');
        return resolve(cachedRates);
      }

      dispatch(updateCacheKey({cacheKey: CacheKeys.RATES}));

      try {
        logManager.info('startGetRates: fetching new rates...');
        const yesterday = getLastDayTimestampStartOfHourMs();

        logManager.info(
          `startGetRates: get request to: ${BASE_BWS_URL}/v3/fiatrates/`,
        );
        const {data: rates} = await axios.get(`${BASE_BWS_URL}/v3/fiatrates/`);
        logManager.info('startGetRates: success get request');

        logManager.info(
          `startGetRates: get request (yesterday) to: ${BASE_BWS_URL}/v3/fiatrates?ts=${yesterday}`,
        );
        const {data: lastDayRates} = await axios.get(
          `${BASE_BWS_URL}/v3/fiatrates?ts=${yesterday}`,
        );
        logManager.info('startGetRates: success get request (yesterday)');

        if (context === 'init' || altCurrencyList.length === 0) {
          logManager.info('startGetRates: setting alternative currency list');
          // set alternative currency list
          const alternatives: Array<AltCurrenciesRowProps> = [];
          rates.btc.forEach((r: Rate) => {
            if (r.code && r.name) {
              alternatives.push({isoCode: r.code, name: r.name});
            }
          });
          alternatives.sort((a, b) => (a.name < b.name ? -1 : 1));
          dispatch(addAltCurrencyList(alternatives));
          logManager.info(
            'startGetRates: success set alternative currency list',
          );
        }

        // needs alt currency list set on init
        const {tokenRates, tokenLastDayRates} = (await dispatch<any>(
          getTokenRates(),
        )) as any;

        const allRates = {...rates, ...tokenRates};
        const allLastDayRates = {...lastDayRates, ...tokenLastDayRates};

        dispatch(
          successGetRates({
            rates: allRates,
            lastDayRates: allLastDayRates,
          }),
        );
        logManager.info('startGetRates: success');
        resolve(allRates);
      } catch (err) {
        const errorStr = getErrorString(err);
        dispatch(failedGetRates());
        logManager.error(`startGetRates: failed ${errorStr}`);
        resolve(getState().RATE.rates); // Return cached rates
      }
    });
  };

export const refreshRatesForPortfolioPnl =
  ({
    context,
  }: {
    context?: UpdateAllKeyAndWalletStatusContext;
  } = {}): Effect<Promise<void>> =>
  async dispatch => {
    await dispatch(
      startGetRates({
        context,
        force: true,
      }) as any,
    );
  };

export const getContractAddresses =
  (chain: string): Effect<Array<string>> =>
  (dispatch, getState) => {
    logManager.info(`getContractAddresses ${chain}: starting...`);
    const {
      WALLET: {keys},
    } = getState();
    let allTokenAddresses: string[] = [];

    (Object.values(keys) as Key[]).forEach((key: Key) => {
      key.wallets.forEach((wallet: Wallet) => {
        if (
          chain === wallet.chain &&
          !IsERCToken(wallet.currencyAbbreviation, wallet.chain) &&
          wallet.tokens
        ) {
          // workaround to get linked wallets
          const tokenAddresses = wallet.tokens.map((t: string) =>
            t.replace(`${wallet.id}-`, ''),
          );
          allTokenAddresses.push(...tokenAddresses);
        }
      });
    });
    logManager.info('getContractAddresses: success');
    const uniqueTokenAddresses = [...new Set(allTokenAddresses)];
    return uniqueTokenAddresses;
  };

export const getTokenRates =
  (): Effect<
    Promise<{tokenRates: Rates; tokenLastDayRates: Rates} | undefined>
  > =>
  (dispatch, getState) => {
    return new Promise(async resolve => {
      logManager.info('getTokenRates: starting...');

      let tokenRates: {[key in string]: any} = {};
      let tokenLastDayRates: {[key in string]: any} = {};
      const shouldSkipLogging = true;
      const decimalPrecision = 6;

      try {
        const {
          APP: {altCurrencyList},
          WALLET: {customTokenOptionsByAddress},
        } = getState();
        const {tokenOptionsByAddress} = tokenManager.getTokenOptions();

        const tokensOptsByAddress = {
          ...BitpaySupportedTokenOptsByAddress,
          ...tokenOptionsByAddress,
          ...customTokenOptionsByAddress,
        };

        logManager.info('getTokenRates: selecting alternative currencies');
        const altCurrencies = altCurrencyList.map(
          (altCurrency: AltCurrenciesRowProps) =>
            altCurrency.isoCode.toLowerCase(),
        );
        const chunkArray = (array: string[], size: number) => {
          const chunked_arr = [];
          for (let i = 0; i < array.length; i += size) {
            chunked_arr.push(array.slice(i, i + size));
          }
          return chunked_arr;
        };

        for (const chain of SUPPORTED_VM_TOKENS) {
          const contractAddresses = dispatch(getContractAddresses(chain));
          if (contractAddresses?.length > 0) {
            const chunks = chunkArray(contractAddresses, 25);
            for (const chunk of chunks) {
              const data = await dispatch(
                getMultipleTokenPrices({addresses: chunk, chain}),
              );
              data.forEach((tokenInfo: UnifiedTokenPriceObj) => {
                const {
                  usdPrice,
                  tokenAddress,
                  '24hrPercentChange': percentChange,
                } = tokenInfo;
                const lastUpdate = Date.now();

                if (!usdPrice || !tokenAddress || percentChange == null) {
                  return;
                }
                const formattedTokenAddress = addTokenChainSuffix(
                  tokenAddress,
                  chain,
                );
                // only save token rates if exist in tokens list
                if (tokensOptsByAddress[formattedTokenAddress]) {
                  tokenRates[formattedTokenAddress] = [];
                  tokenLastDayRates[formattedTokenAddress] = [];

                  altCurrencies.forEach((altCurrency: string) => {
                    const rate =
                      dispatch(
                        calculateUsdToAltFiat(
                          usdPrice,
                          altCurrency,
                          decimalPrecision,
                          shouldSkipLogging,
                        ),
                      ) || 0;
                    tokenRates[formattedTokenAddress].push({
                      code: altCurrency.toUpperCase(),
                      fetchedOn: lastUpdate,
                      name: tokensOptsByAddress[formattedTokenAddress]?.symbol,
                      rate,
                      ts: lastUpdate,
                    });
                    const sign = Number(percentChange) >= 0 ? 1 : -1;
                    const lastDayRate =
                      rate /
                      (1 + (sign * Math.abs(Number(percentChange))) / 100);
                    const yesterday = moment
                      .unix(lastUpdate)
                      .subtract(1, 'days')
                      .unix();
                    tokenLastDayRates[formattedTokenAddress].push({
                      code: altCurrency.toUpperCase(),
                      fetchedOn: yesterday,
                      name: tokensOptsByAddress[formattedTokenAddress]?.symbol,
                      rate: lastDayRate,
                      ts: yesterday,
                    });
                  });
                }
              });
            }
          } else {
            logManager.info(
              `No tokens wallets for ${chain} found. Skipping getTokenRates...`,
            );
          }
        }

        logManager.info('getTokenRates: success');
        resolve({tokenRates, tokenLastDayRates});
      } catch (e) {
        let errorStr;
        if (e instanceof Error) {
          errorStr = e.message;
        } else {
          errorStr = JSON.stringify(e);
        }
        logManager.error(`getTokenRates: failed (continue anyway) ${errorStr}`);
        resolve({tokenRates, tokenLastDayRates}); // prevent the app from crashing if coingecko fails
      }
    });
  };

export const refreshFiatRateSeries =
  (args: {
    fiatCode: string;
    currencyAbbreviation: string;
    interval: string;
    spotRate?: number;
    series?: {fetchedOn: number; points: Array<{ts: number; rate: number}>};
    chain?: string;
    tokenAddress?: string;
  }): Effect<Promise<boolean>> =>
  async (dispatch, getState) => {
    const cacheKey = getFiatRateSeriesCacheKey(
      args.fiatCode,
      args.currencyAbbreviation,
      args.interval as any,
      {
        chain: args.chain,
        tokenAddress: args.tokenAddress,
      },
    );

    const explicitSeries = args.series;
    if (explicitSeries) {
      dispatch({
        type: 'RATE/UPSERT_FIAT_RATE_SERIES_CACHE',
        payload: {
          cacheKey,
          series: explicitSeries,
        },
      } as any);
      return true;
    }

    const spotRate = args.spotRate;
    if (
      args.interval === 'ALL' ||
      typeof spotRate !== 'number' ||
      !Number.isFinite(spotRate)
    ) {
      return false;
    }

    const currentSeries = (getState().RATE as any)?.fiatRateSeriesCache?.[
      cacheKey
    ];
    const currentPoints = currentSeries?.points;
    if (!Array.isArray(currentPoints) || !currentPoints.length) {
      return false;
    }

    const lastPoint = currentPoints[currentPoints.length - 1];
    const lastTs = Number(lastPoint?.ts);
    if (!Number.isFinite(lastTs) || lastTs <= 0) {
      return false;
    }

    const previousPoint =
      currentPoints.length >= 2
        ? currentPoints[currentPoints.length - 2]
        : undefined;
    const pointDeltaMs =
      previousPoint &&
      Number.isFinite(Number(previousPoint.ts)) &&
      lastTs > Number(previousPoint.ts)
        ? lastTs - Number(previousPoint.ts)
        : undefined;
    const cadenceMs =
      pointDeltaMs ||
      (args.interval === '1M'
        ? 6 * 60 * 60 * 1000
        : args.interval === '1W'
        ? 2 * 60 * 60 * 1000
        : args.interval === '3M' ||
          args.interval === '1Y' ||
          args.interval === '5Y'
        ? 24 * 60 * 60 * 1000
        : 15 * 60 * 1000);
    const now = Date.now();
    if (now - lastTs < cadenceMs) {
      return false;
    }

    const targetLength = currentPoints.length;
    const nextPoints = currentPoints
      .slice(Math.max(0, currentPoints.length - Math.max(1, targetLength - 1)))
      .concat([{ts: now, rate: spotRate}]);
    dispatch({
      type: 'RATE/UPSERT_FIAT_RATE_SERIES_CACHE',
      payload: {
        cacheKey,
        series: {
          fetchedOn: now,
          points: nextPoints,
        },
      },
    } as any);
    return true;
  };

export const fetchFiatRateSeriesInterval =
  (args: {
    fiatCode: string;
    currencyAbbreviation?: string;
    coinForCacheCheck?: string;
    coin?: string;
    allowedCoins?: string[];
    interval: string;
    force?: boolean;
    chain?: string;
    tokenAddress?: string;
  }): Effect<Promise<boolean>> =>
  async (dispatch, getState) => {
    const fiatCode = String(args.fiatCode || '').toUpperCase();
    const coinForCacheCheck = String(
      args.coinForCacheCheck || args.currencyAbbreviation || args.coin || '',
    ).toLowerCase();
    if (!fiatCode || !coinForCacheCheck) {
      return false;
    }

    const cache = (getState().RATE as any)?.fiatRateSeriesCache;
    const cacheKey = getFiatRateSeriesCacheKey(
      fiatCode,
      coinForCacheCheck,
      args.interval as any,
      {
        chain: args.chain,
        tokenAddress: args.tokenAddress,
      },
    );
    const cached = cache?.[cacheKey];
    if (
      !args.force &&
      cached?.points?.length &&
      typeof cached.fetchedOn === 'number' &&
      Number.isFinite(cached.fetchedOn) &&
      Date.now() - cached.fetchedOn <= HISTORIC_RATES_CACHE_DURATION * 1000
    ) {
      return true;
    }

    try {
      const query: string[] = [];
      if (args.interval !== 'ALL') {
        query.push(`days=${encodeURIComponent(String(args.interval))}`);
      }
      if (args.coin) {
        query.push(`coin=${encodeURIComponent(args.coin)}`);
      }
      const {data} = await axios.get(
        `${BASE_BWS_URL}/v4/fiatrates/${fiatCode}${
          query.length ? `?${query.join('&')}` : ''
        }`,
      );
      const byCoin: Record<string, unknown> = Array.isArray(data)
        ? args.coin
          ? {[args.coin]: data}
          : {}
        : data && typeof data === 'object'
        ? data
        : {};
      const allowedCoins = new Set(
        (args.allowedCoins || Object.keys(byCoin)).map(coin =>
          String(coin || '').toLowerCase(),
        ),
      );
      let updateCount = 0;
      let updatedTargetCoin = false;
      for (const [coin, rawPoints] of Object.entries(byCoin)) {
        const normalizedCoin = String(coin || '').toLowerCase();
        if (!allowedCoins.has(normalizedCoin) || !Array.isArray(rawPoints)) {
          continue;
        }
        const points = rawPoints
          .map((point: any) => ({
            ts: Number(point?.ts ?? point?.timestamp),
            rate: Number(point?.rate),
          }))
          .filter(
            point => Number.isFinite(point.ts) && Number.isFinite(point.rate),
          )
          .sort((left, right) => left.ts - right.ts);
        if (!points.length) {
          continue;
        }
        await dispatch(
          refreshFiatRateSeries({
            fiatCode,
            currencyAbbreviation: normalizedCoin,
            interval: args.interval,
            chain: args.chain,
            tokenAddress: args.tokenAddress,
            series: {
              fetchedOn: Date.now(),
              points,
            },
          }) as any,
        );
        updateCount += 1;
        updatedTargetCoin = updatedTargetCoin || normalizedCoin === coinForCacheCheck;
      }

      if (
        !updatedTargetCoin &&
        !args.coin &&
        !(args.allowedCoins || []).length
      ) {
        const fallbackQuery = [
          args.interval === 'ALL'
            ? ''
            : `days=${encodeURIComponent(String(args.interval))}`,
          `coin=${encodeURIComponent(coinForCacheCheck)}`,
        ].filter(Boolean);
        const fallback = await axios.get(
          `${BASE_BWS_URL}/v4/fiatrates/${fiatCode}${
            fallbackQuery.length ? `?${fallbackQuery.join('&')}` : ''
          }`,
        );
        const fallbackRawPoints = Array.isArray(fallback?.data)
          ? fallback.data
          : fallback?.data?.[coinForCacheCheck];
        const fallbackPoints = Array.isArray(fallbackRawPoints)
          ? fallbackRawPoints
              .map((point: any) => ({
                ts: Number(point?.ts ?? point?.timestamp),
                rate: Number(point?.rate),
              }))
              .filter(
                point =>
                  Number.isFinite(point.ts) && Number.isFinite(point.rate),
              )
              .sort((left, right) => left.ts - right.ts)
          : [];
        if (fallbackPoints.length) {
          await dispatch(
            refreshFiatRateSeries({
              fiatCode,
              currencyAbbreviation: coinForCacheCheck,
              interval: args.interval,
              chain: args.chain,
              tokenAddress: args.tokenAddress,
              series: {
                fetchedOn: Date.now(),
                points: fallbackPoints,
              },
            }) as any,
          );
          updateCount += 1;
        }
      }

      return updateCount > 0;
    } catch (error: unknown) {
      logManager.warn(
        `fetchFiatRateSeriesInterval failed: ${getErrorString(error)}`,
      );
      return false;
    }
  };

export const fetchFiatRateSeriesAllIntervals =
  (args: {
    fiatCode: string;
    currencyAbbreviation?: string;
    allowedCoins?: string[];
    force?: boolean;
  }): Effect<Promise<boolean>> =>
  async dispatch => {
    const coins = args.currencyAbbreviation
      ? [args.currencyAbbreviation]
      : args.allowedCoins || ['btc'];
    let ok = true;

    for (const coin of coins) {
      for (const interval of FIAT_RATE_SERIES_CACHED_INTERVALS) {
        const fetched = await dispatch(
          fetchFiatRateSeriesInterval({
            fiatCode: args.fiatCode,
            currencyAbbreviation: coin,
            interval,
            force: args.force,
          }) as any,
        );
        ok = ok && !!fetched;
      }
    }

    return ok;
  };

export const getHistoricFiatRate = (
  fiatCode: string,
  currencyAbbreviation: string,
  ts: string,
): Promise<HistoricRate> => {
  return new Promise(async (resolve, reject) => {
    try {
      const url = `${BASE_BWS_URL}/v1/fiatrates/${fiatCode}?coin=${currencyAbbreviation}&ts=${ts}`;
      const {data} = await axios.get(url);
      resolve(data);
    } catch (e) {
      reject(e);
    }
  });
};
