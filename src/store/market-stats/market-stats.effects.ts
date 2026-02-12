import axios from 'axios';
import {Effect} from '../index';
import {BASE_BWS_URL} from '../../constants/config';
import {logManager} from '../../managers/LogManager';
import {RATES_CACHE_DURATION} from '../../constants/wallet';
import {isCacheKeyStale} from '../wallet/utils/wallet';
import {updateMarketStats} from './market-stats.actions';
import {MarketStatsItem} from './market-stats.models';

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  return value != null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
};

export const getMarketStatsCacheKey = (params: {
  fiatCode: string;
  coin: string;
}): string => {
  return `${(params.fiatCode || '').toUpperCase()}:${(
    params.coin || ''
  ).toLowerCase()}`;
};

const normalizeMarketStatsCoin = (coin: string): string => {
  return (coin || '').toLowerCase();
};

const normalizeUniqueMarketStatsCoins = (coins: string[]): string[] => {
  const out = new Set<string>();
  for (const raw of coins || []) {
    const coin = normalizeMarketStatsCoin(raw);
    if (!coin) {
      continue;
    }
    out.add(coin);
  }
  return Array.from(out);
};

const requestMarketStatsForCoin = async (args: {
  fiatCode: string;
  coin: string;
}): Promise<MarketStatsItem | null> => {
  const url = `${BASE_BWS_URL}/v1/marketstats/${args.fiatCode}?coin=${args.coin}`;
  logManager.info(`fetchMarketStats: get request to: ${url}`);
  const {data} = await axios.get(url);

  const payloadArray = Array.isArray(data) ? data : [];
  const payload = asRecord(payloadArray[0]);
  if (payload) {
    return payload as MarketStatsItem;
  }

  const payloadRecord = asRecord(data);
  const keyedPayload = payloadRecord
    ? asRecord(payloadRecord[args.coin])
    : undefined;
  return keyedPayload ? (keyedPayload as MarketStatsItem) : null;
};

export const fetchMarketStatsForCoins =
  (params: {
    fiatCode: string;
    coins: string[];
    force?: boolean;
  }): Effect<Promise<Record<string, MarketStatsItem>>> =>
  async (dispatch, getState) => {
    const fiatCode = (params.fiatCode || '').toUpperCase();
    const normalizedCoins = normalizeUniqueMarketStatsCoins(params.coins || []);
    if (!fiatCode || !normalizedCoins.length) {
      return {};
    }

    const marketStatsState = getState().MARKET_STATS;
    const out: Record<string, MarketStatsItem> = {};

    for (const coin of normalizedCoins) {
      const key = getMarketStatsCacheKey({fiatCode, coin});
      const cached = marketStatsState?.itemsByKey?.[key];
      if (cached) {
        out[coin] = cached;
      }
    }

    const coinsToFetch = params.force
      ? normalizedCoins
      : normalizedCoins.filter(coin => {
          const key = getMarketStatsCacheKey({fiatCode, coin});
          const cached = marketStatsState?.itemsByKey?.[key];
          if (!cached) {
            return true;
          }
          const lastFetched = marketStatsState?.lastFetchedByKey?.[key];
          return isCacheKeyStale(lastFetched, RATES_CACHE_DURATION);
        });

    if (!coinsToFetch.length) {
      return out;
    }

    const MAX_PARALLEL_MARKET_STATS_REQUESTS = 6;
    for (
      let i = 0;
      i < coinsToFetch.length;
      i += MAX_PARALLEL_MARKET_STATS_REQUESTS
    ) {
      const coinChunk = coinsToFetch.slice(
        i,
        i + MAX_PARALLEL_MARKET_STATS_REQUESTS,
      );
      const results = await Promise.allSettled(
        coinChunk.map(async coin => {
          const data = await requestMarketStatsForCoin({fiatCode, coin});
          return {coin, data};
        }),
      );

      for (const result of results) {
        if (result.status === 'rejected') {
          const errStr =
            result.reason instanceof Error
              ? result.reason.message
              : JSON.stringify(result.reason);
          logManager.warn(`fetchMarketStats: failed - ${errStr}`);
          continue;
        }

        const {coin, data} = result.value;
        if (!data) {
          logManager.warn(`fetchMarketStats: empty payload for ${fiatCode}/${coin}`);
          continue;
        }

        const key = getMarketStatsCacheKey({fiatCode, coin});
        dispatch(updateMarketStats({key, data}));
        out[coin] = data;
      }
    }

    return out;
  };

export const fetchMarketStats =
  (params: {
    fiatCode: string;
    coin: string;
  }): Effect<Promise<MarketStatsItem | null>> =>
  async dispatch => {
    const fiatCode = (params.fiatCode || '').toUpperCase();
    const coin = normalizeMarketStatsCoin(params.coin || '');
    if (!fiatCode || !coin) {
      return null;
    }

    const dataByCoin = (await dispatch(
      fetchMarketStatsForCoins({
        fiatCode,
        coins: [coin],
      }),
    )) as Record<string, MarketStatsItem>;

    return dataByCoin[coin] || null;
  };
