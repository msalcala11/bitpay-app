jest.mock('../helper-methods', () => ({
  getLastDayTimestampStartOfHourMs: (nowMs: number = Date.now()) => {
    const msPerHour = 60 * 60 * 1000;
    const msPerDay = 24 * msPerHour;
    return Math.floor((nowMs - msPerDay) / msPerHour) * msPerHour;
  },
}));

import type {FiatRateSeriesCache} from '../../store/rate/rate.models';
import {getFiatRateSeriesCacheKey} from '../../store/rate/rate.models';
import {
  getFiatRateChangeForTimeframe,
  getFiatRateFromSeriesCacheAtTimestamp,
} from './rate';

const NOW_MS = Date.UTC(2026, 0, 2, 12, 0, 0, 0);
const BASELINE_TS = Date.UTC(2026, 0, 1, 12, 0, 0, 0);

const ETH_USDC_IDENTITY = {
  chain: 'eth',
  tokenAddress: '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
};

const BASE_USDC_IDENTITY = {
  chain: 'base',
  tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
};

const SOL_USDC_IDENTITY = {
  chain: 'sol',
  tokenAddress: 'So11111111111111111111111111111111111111112',
};

const buildSeriesCache = (
  entries: Array<{
    fiatCode: string;
    coin: string;
    interval: '1D';
    identity?: {chain?: string; tokenAddress?: string};
    points: Array<{ts: number; rate: number}>;
  }>,
): FiatRateSeriesCache => {
  return entries.reduce<FiatRateSeriesCache>((cache, entry) => {
    cache[
      getFiatRateSeriesCacheKey(
        entry.fiatCode,
        entry.coin,
        entry.interval,
        entry.identity,
      )
    ] = {
      fetchedOn: NOW_MS,
      points: entry.points,
    };
    return cache;
  }, {});
};

describe('portfolio rate readers', () => {
  it('returns the correct timestamp rate for same-coin assets with different identities', () => {
    const fiatRateSeriesCache = buildSeriesCache([
      {
        fiatCode: 'USD',
        coin: 'usdc',
        interval: '1D',
        identity: ETH_USDC_IDENTITY,
        points: [
          {ts: BASELINE_TS, rate: 1},
          {ts: NOW_MS, rate: 2},
        ],
      },
      {
        fiatCode: 'USD',
        coin: 'usdc',
        interval: '1D',
        identity: BASE_USDC_IDENTITY,
        points: [
          {ts: BASELINE_TS, rate: 10},
          {ts: NOW_MS, rate: 15},
        ],
      },
    ]);

    expect(
      getFiatRateFromSeriesCacheAtTimestamp({
        fiatRateSeriesCache,
        fiatCode: 'USD',
        currencyAbbreviation: 'usdc',
        interval: '1D',
        timestampMs: NOW_MS,
        identity: ETH_USDC_IDENTITY,
      }),
    ).toBe(2);

    expect(
      getFiatRateFromSeriesCacheAtTimestamp({
        fiatRateSeriesCache,
        fiatCode: 'USD',
        currencyAbbreviation: 'usdc',
        interval: '1D',
        timestampMs: NOW_MS,
        identity: BASE_USDC_IDENTITY,
      }),
    ).toBe(15);
  });

  it('returns the correct change values for same-coin assets with different identities', () => {
    const fiatRateSeriesCache = buildSeriesCache([
      {
        fiatCode: 'USD',
        coin: 'usdc',
        interval: '1D',
        identity: ETH_USDC_IDENTITY,
        points: [
          {ts: BASELINE_TS, rate: 1},
          {ts: NOW_MS, rate: 2},
        ],
      },
      {
        fiatCode: 'USD',
        coin: 'usdc',
        interval: '1D',
        identity: BASE_USDC_IDENTITY,
        points: [
          {ts: BASELINE_TS, rate: 10},
          {ts: NOW_MS, rate: 15},
        ],
      },
    ]);

    expect(
      getFiatRateChangeForTimeframe({
        fiatRateSeriesCache,
        fiatCode: 'USD',
        currencyAbbreviation: 'usdc',
        timeframe: '1D',
        nowMs: NOW_MS,
        identity: ETH_USDC_IDENTITY,
      }),
    ).toEqual({
      timeframe: '1D',
      baselineTimestampMs: BASELINE_TS,
      baselineRate: 1,
      currentRate: 2,
      priceChange: 1,
      percentChange: 100,
      percentRatio: 1,
    });

    expect(
      getFiatRateChangeForTimeframe({
        fiatRateSeriesCache,
        fiatCode: 'USD',
        currencyAbbreviation: 'usdc',
        timeframe: '1D',
        nowMs: NOW_MS,
        identity: BASE_USDC_IDENTITY,
      }),
    ).toEqual({
      timeframe: '1D',
      baselineTimestampMs: BASELINE_TS,
      baselineRate: 10,
      currentRate: 15,
      priceChange: 5,
      percentChange: 50,
      percentRatio: 0.5,
    });
  });

  it('preserves plain coin-only behavior when no identity is provided', () => {
    const fiatRateSeriesCache = buildSeriesCache([
      {
        fiatCode: 'USD',
        coin: 'btc',
        interval: '1D',
        points: [
          {ts: BASELINE_TS, rate: 100},
          {ts: NOW_MS, rate: 120},
        ],
      },
    ]);

    expect(
      getFiatRateChangeForTimeframe({
        fiatRateSeriesCache,
        fiatCode: 'USD',
        currencyAbbreviation: 'btc',
        timeframe: '1D',
        nowMs: NOW_MS,
      }),
    ).toEqual({
      timeframe: '1D',
      baselineTimestampMs: BASELINE_TS,
      baselineRate: 100,
      currentRate: 120,
      priceChange: 20,
      percentChange: 20,
      percentRatio: 0.2,
    });
  });

  it('matches the cache-key normalization rules for non-SVM identities', () => {
    const fiatRateSeriesCache = buildSeriesCache([
      {
        fiatCode: 'USD',
        coin: 'usdc',
        interval: '1D',
        identity: ETH_USDC_IDENTITY,
        points: [{ts: NOW_MS, rate: 3}],
      },
    ]);

    expect(
      getFiatRateFromSeriesCacheAtTimestamp({
        fiatRateSeriesCache,
        fiatCode: 'USD',
        currencyAbbreviation: 'usdc',
        interval: '1D',
        timestampMs: NOW_MS,
        identity: {
          chain: 'ETH',
          tokenAddress: ETH_USDC_IDENTITY.tokenAddress.toUpperCase(),
        },
      }),
    ).toBe(3);
  });

  it('preserves SVM token-address casing instead of collapsing it', () => {
    const fiatRateSeriesCache = buildSeriesCache([
      {
        fiatCode: 'USD',
        coin: 'usdc',
        interval: '1D',
        identity: SOL_USDC_IDENTITY,
        points: [{ts: NOW_MS, rate: 7}],
      },
    ]);

    expect(
      getFiatRateFromSeriesCacheAtTimestamp({
        fiatRateSeriesCache,
        fiatCode: 'USD',
        currencyAbbreviation: 'usdc',
        interval: '1D',
        timestampMs: NOW_MS,
        identity: {
          chain: 'SOL',
          tokenAddress: SOL_USDC_IDENTITY.tokenAddress,
        },
      }),
    ).toBe(7);

    expect(
      getFiatRateFromSeriesCacheAtTimestamp({
        fiatRateSeriesCache,
        fiatCode: 'USD',
        currencyAbbreviation: 'usdc',
        interval: '1D',
        timestampMs: NOW_MS,
        identity: {
          chain: 'sol',
          tokenAddress: SOL_USDC_IDENTITY.tokenAddress.toLowerCase(),
        },
      }),
    ).toBeUndefined();
  });
});
