import {Effect} from '../../../index';
import axios from 'axios';
import {BASE_BWS_URL} from '../../../../constants/config';
import {SUPPORTED_VM_TOKENS} from '../../../../constants/currencies';
import {
  FiatRatePoint,
  FiatRateSeriesCache,
  FiatRateInterval,
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
  pruneFiatRateSeriesCache,
  successGetRates,
  upsertFiatRateSeriesCache,
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
import {normalizeFiatRateSeriesCoin} from '../../../../utils/portfolio/core/pnl/rates';
import {isSortedByTsAsc} from '../../../../utils/portfolio/timeSeries';

// const FIAT_RATE_SERIES_BASE_URL = `${BASE_BWS_URL}/v4/fiatrates`;
const FIAT_RATE_SERIES_BASE_URL = `http://localhost:3232/bws/api/v4/fiatrates`;


const FIAT_RATE_SERIES_INTERVAL_DAYS: Record<
  FiatRateInterval,
  number | undefined
> = {
  '1D': 1,
  '1W': 7,
  '1M': 30,
  '3M': 90,
  '1Y': 365,
  '5Y': 1825,
  ALL: undefined,
};

const getFiatRateSeriesUrl = (
  fiatCode: string,
  interval: FiatRateInterval,
  coin?: string,
): string => {
  const days = FIAT_RATE_SERIES_INTERVAL_DAYS[interval];
  const codeUpper = (fiatCode || 'USD').toUpperCase();

  const base = !days
    ? `${FIAT_RATE_SERIES_BASE_URL}/${codeUpper}`
    : `${FIAT_RATE_SERIES_BASE_URL}/${codeUpper}?days=${days}`;

  const coinLower = (coin || '').toLowerCase();
  if (!coinLower) {
    return base;
  }
  const joiner = base.includes('?') ? '&' : '?';
  return `${base}${joiner}coin=${encodeURIComponent(coinLower)}`;
};

const getFiatRateSeriesCadenceMs = (
  points: FiatRatePoint[],
  interval: FiatRateInterval,
): number => {
  if (points.length >= 2) {
    const last = points[points.length - 1];
    const prev = points[points.length - 2];
    const delta = last.ts - prev.ts;
    if (Number.isFinite(delta) && delta > 0) {
      return delta;
    }
  }

  switch (interval) {
    case '1D':
      return 15 * 60 * 1000;
    case '1W':
      return 2 * 60 * 60 * 1000;
    case '1M':
      return 6 * 60 * 60 * 1000;
    case '3M':
    case '1Y':
    case '5Y':
    case 'ALL':
    default:
      return 24 * 60 * 60 * 1000;
  }
};

const dedupeFiatRatePointsByTs = (points: FiatRatePoint[]): FiatRatePoint[] => {
  const seen = new Set<number>();
  const out: FiatRatePoint[] = [];
  for (const p of points) {
    if (!p || typeof p.ts !== 'number') {
      continue;
    }
    if (seen.has(p.ts)) {
      continue;
    }
    seen.add(p.ts);
    out.push(p);
  }
  return out;
};

const getFiatRateSeriesPointsByCoin = (args: {
  data: unknown;
  requestedCoin?: string;
  fallbackCoin?: string;
}): Record<string, FiatRatePoint[]> => {
  const {data, requestedCoin, fallbackCoin} = args;

  // v4 returns an object map for default requests, and may return a flat
  // points array when `coin` is explicitly requested.
  if (Array.isArray(data)) {
    const normalizedCoin = normalizeFiatRateSeriesCoin(
      requestedCoin || fallbackCoin || '',
    );
    if (!normalizedCoin) {
      return {};
    }
    return {[normalizedCoin]: data as FiatRatePoint[]};
  }

  if (!data || typeof data !== 'object') {
    return {};
  }

  return data as Record<string, FiatRatePoint[]>;
};

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

export const fetchFiatRateSeriesInterval =
  (args: {
    fiatCode: string;
    interval: FiatRateInterval;
    coinForCacheCheck: string;
    /**
     * Optional `coin` query param for v4/fiatrates.
     * When set, the endpoint should return series data scoped to that coin.
     */
    coin?: string;
    force?: boolean;
    allowedCoins?: string[];
  }): Effect<Promise<void>> =>
  async (dispatch, getState) => {
    const {fiatCode, interval, coinForCacheCheck, coin, force, allowedCoins} =
      args;
    const {
      RATE: {fiatRateSeriesCache},
    } = getState();

    const cacheKey = getFiatRateSeriesCacheKey(
      fiatCode,
      coinForCacheCheck,
      interval,
    );
    const cached = fiatRateSeriesCache[cacheKey];

    if (
      !force &&
      cached?.points?.length &&
      !isCacheKeyStale(cached.fetchedOn, HISTORIC_RATES_CACHE_DURATION)
    ) {
      return;
    }

    const url = getFiatRateSeriesUrl(fiatCode, interval, coin);
    const {data} = await axios.get(url);
    const fetchedOn = Date.now();

    const pointsByCoin = getFiatRateSeriesPointsByCoin({
      data,
      requestedCoin: coin,
      fallbackCoin: coinForCacheCheck,
    });
    if (!Object.keys(pointsByCoin).length) {
      return;
    }

    const allowedCoinsSet =
      Array.isArray(allowedCoins) && allowedCoins.length
        ? new Set(
            allowedCoins.map(c => (c || '').toLowerCase()).filter(Boolean),
          )
        : null;
    // Only prune when a caller explicitly bounds the cache.
    // For the active display fiat, we want to retain any coin-specific caches
    // fetched for a user's portfolio (in addition to the default response).
    if (allowedCoinsSet && allowedCoinsSet.size) {
      dispatch(
        pruneFiatRateSeriesCache({
          fiatCode,
          keepCoins: Array.from(allowedCoinsSet),
        }),
      );
    }

    const updates: FiatRateSeriesCache = {};
    Object.keys(pointsByCoin).forEach(coinKey => {
      if (
        allowedCoinsSet &&
        !allowedCoinsSet.has((coinKey || '').toLowerCase())
      ) {
        return;
      }

      const rawPoints = pointsByCoin[coinKey];
      if (!Array.isArray(rawPoints) || !rawPoints.length) {
        return;
      }

      const filtered = rawPoints.filter(
        p => Number.isFinite(p?.ts) && Number.isFinite(p?.rate),
      );

      if (!filtered.length) {
        return;
      }

      let points = filtered.map(p => ({ts: p.ts, rate: p.rate}));
      if (!isSortedByTsAsc(points)) {
        points = points.sort((a, b) => a.ts - b.ts);
      }
      const deduped = dedupeFiatRatePointsByTs(points);
      updates[getFiatRateSeriesCacheKey(fiatCode, coinKey, interval)] = {
        fetchedOn,
        points: deduped,
      };
    });

    if (Object.keys(updates).length) {
      dispatch(upsertFiatRateSeriesCache({updates}));
    }
  };

export const fetchFiatRateSeriesAllIntervals =
  (args: {
    fiatCode: string;
    currencyAbbreviation: string;
    /** Optional `coin` query param for v4/fiatrates. */
    coin?: string;
    force?: boolean;
    allowedCoins?: string[];
    /** Override which intervals to fetch. */
    intervals?: FiatRateInterval[];
  }): Effect<Promise<void>> =>
  async dispatch => {
    const {fiatCode, currencyAbbreviation, coin, force, allowedCoins} = args;
    const coinForCacheCheck = normalizeFiatRateSeriesCoin(currencyAbbreviation);
    const intervals: FiatRateInterval[] =
      args.intervals ||
      (coin
        ? ['1D', '1W', '1M', '3M', '1Y', '5Y', 'ALL']
        : ['1D', '1W', '1M', 'ALL']);
    await Promise.allSettled(
      intervals.map(interval =>
        dispatch(
          fetchFiatRateSeriesInterval({
            fiatCode,
            interval,
            coinForCacheCheck,
            coin,
            force,
            allowedCoins,
          }),
        ),
      ),
    );
  };

const REQUIRED_FIAT_RATE_SERIES_INTERVALS: FiatRateInterval[] = [
  '1D',
  '1W',
  '1M',
  '3M',
  '1Y',
  '5Y',
  'ALL',
];

const hasRequiredIntervalsInCache = (args: {
  fiatRateSeriesCache: FiatRateSeriesCache | undefined;
  fiatCode: string;
  coin: string;
}): boolean => {
  const fiatCodeUpper = (args.fiatCode || '').toUpperCase();
  const coinLower = (args.coin || '').toLowerCase();
  if (!fiatCodeUpper || !coinLower) {
    return false;
  }

  for (const interval of REQUIRED_FIAT_RATE_SERIES_INTERVALS) {
    const cacheKey = getFiatRateSeriesCacheKey(fiatCodeUpper, coinLower, interval);
    const pointsLen =
      args.fiatRateSeriesCache?.[cacheKey]?.points?.length || 0;
    if (pointsLen <= 0) {
      return false;
    }
  }
  return true;
};

const COIN_SPECIFIC_RETRY_MS = 5 * 60 * 1000;
const nextCoinRetryAtByFiatCoin = new Map<string, number>();

/**
 * Ensures v4 fiat rate series exist for all intervals for the given coins.
 *
 * - Always performs (cached) default requests without a `coin` param so the
 *   Home "Exchange Rates" section coins stay warm in-cache.
 * - For coins not included in the default response, issues coin-specific
 *   requests (with `coin` param) across all 7 intervals.
 */
export const ensureFiatRateSeriesForCoins =
  (args: {
    fiatCode: string;
    currencyAbbreviations: string[];
    force?: boolean;
  }): Effect<Promise<void>> =>
  async (dispatch, getState) => {
    const fiatCodeUpper = (args.fiatCode || '').toUpperCase();
    if (!fiatCodeUpper) {
      return;
    }

    // 1) Keep the default multi-coin response warm for all intervals.
    await Promise.allSettled(
      REQUIRED_FIAT_RATE_SERIES_INTERVALS.map(interval =>
        dispatch(
          fetchFiatRateSeriesInterval({
            fiatCode: fiatCodeUpper,
            interval,
            // BTC is always in the default response and works well as a
            // freshness sentinel.
            coinForCacheCheck: 'btc',
            force: args.force,
          }),
        ),
      ),
    );

    const coins = Array.from(
      new Set(
        (args.currencyAbbreviations || [])
          .map(c => normalizeFiatRateSeriesCoin(c))
          .map(c => (c || '').toLowerCase())
          .filter(Boolean),
      ),
    );

    if (!coins.length) {
      return;
    }

    const now = Date.now();
    const cache = getState().RATE?.fiatRateSeriesCache;

    // 2) For each coin, fill gaps with coin-specific requests if needed.
    //    Use a small retry backoff for coins that are currently unsupported.
    await Promise.allSettled(
      coins.map(async coin => {
        const retryKey = `${fiatCodeUpper}:${coin}`;
        const nextRetryAt = nextCoinRetryAtByFiatCoin.get(retryKey) || 0;

        const hasAll = hasRequiredIntervalsInCache({
          fiatRateSeriesCache: cache,
          fiatCode: fiatCodeUpper,
          coin,
        });
        if (hasAll) {
          nextCoinRetryAtByFiatCoin.delete(retryKey);
          return;
        }

        if (!args.force && now < nextRetryAt) {
          return;
        }

        await dispatch(
          fetchFiatRateSeriesAllIntervals({
            fiatCode: fiatCodeUpper,
            currencyAbbreviation: coin,
            coin,
            // Ensure all 7 intervals get fetched for coin-specific requests.
            intervals: REQUIRED_FIAT_RATE_SERIES_INTERVALS,
            force: args.force,
          }) as any,
        );

        const nextCache = getState().RATE?.fiatRateSeriesCache;
        const hasAllAfter = hasRequiredIntervalsInCache({
          fiatRateSeriesCache: nextCache,
          fiatCode: fiatCodeUpper,
          coin,
        });
        if (!hasAllAfter) {
          nextCoinRetryAtByFiatCoin.set(retryKey, Date.now() + COIN_SPECIFIC_RETRY_MS);
        } else {
          nextCoinRetryAtByFiatCoin.delete(retryKey);
        }
      }),
    );
  };

export const refreshFiatRateSeries =
  (args: {
    fiatCode: string;
    currencyAbbreviation: string;
    interval: FiatRateInterval;
    spotRate?: number;
  }): Effect<Promise<boolean>> =>
  async (dispatch, getState) => {
    const {fiatCode, currencyAbbreviation, interval, spotRate} = args;
    const {
      RATE: {fiatRateSeriesCache},
    } = getState();

    if (!spotRate || !Number.isFinite(spotRate)) {
      return false;
    }

    const coin = normalizeFiatRateSeriesCoin(currencyAbbreviation);
    const cacheKey = getFiatRateSeriesCacheKey(fiatCode, coin, interval);
    const cached = fiatRateSeriesCache[cacheKey];
    if (!cached?.points?.length) {
      return false;
    }

    if (interval === 'ALL') {
      return false;
    }

    const now = Date.now();
    const lastTs = cached.points[cached.points.length - 1]?.ts;
    if (!lastTs) {
      return false;
    }

    const cadenceMs = getFiatRateSeriesCadenceMs(cached.points, interval);
    if (now - lastTs < cadenceMs) {
      return false;
    }

    if (cached.points.some((p: FiatRatePoint) => p.ts === now)) {
      return false;
    }

    const newPoint: FiatRatePoint = {ts: now, rate: spotRate};
    let points = [...cached.points, newPoint];

    points = dedupeFiatRatePointsByTs(points);
    const targetLength = cached.points.length;
    if (points.length > targetLength) {
      points = points.slice(points.length - targetLength);
    }

    dispatch(
      upsertFiatRateSeriesCache({
        updates: {
          [cacheKey]: {
            fetchedOn: now,
            points,
          },
        },
      }),
    );
    return true;
  };
