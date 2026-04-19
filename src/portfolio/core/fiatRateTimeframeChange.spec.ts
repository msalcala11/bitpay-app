import {
  getFiatRateBaselineTsForTimeframe,
  getFiatRateChangeForTimeframe,
  getFiatRateFromSeriesCacheAtTimestamp,
} from './fiatRateTimeframeChange';
import type {FiatRateSeriesCache} from './fiatRatesShared';

describe('fiatRateTimeframeChange', () => {
  it('uses the exchange-rate 1D baseline rounded down to the start of the hour', () => {
    const nowMs = Date.UTC(2026, 3, 18, 19, 37, 25);

    expect(
      getFiatRateBaselineTsForTimeframe({timeframe: '1D', nowMs}),
    ).toBe(Date.UTC(2026, 3, 17, 19, 0, 0));
  });

  it('computes linear timeframe price change with the supplied current spot rate', () => {
    const nowMs = Date.UTC(2026, 3, 18, 19, 37, 25);
    const baselineMs = Date.UTC(2026, 3, 17, 19, 0, 0);
    const cache: FiatRateSeriesCache = {
      'USD:btc:1D': {
        fetchedOn: nowMs,
        points: [
          {ts: baselineMs - 60 * 60 * 1000, rate: 90},
          {ts: baselineMs + 60 * 60 * 1000, rate: 110},
          {ts: nowMs - 60 * 60 * 1000, rate: 120},
        ],
      },
    };

    const result = getFiatRateChangeForTimeframe({
      fiatRateSeriesCache: cache,
      fiatCode: 'USD',
      currencyAbbreviation: 'btc',
      timeframe: '1D',
      nowMs,
      currentRate: 121,
      method: 'linear',
    });

    expect(result).toEqual({
      timeframe: '1D',
      baselineTimestampMs: baselineMs,
      baselineRate: 100,
      currentRate: 121,
      priceChange: 21,
      percentChange: 21,
      percentRatio: 0.21,
    });
  });

  it('prefers a currentRatesByAssetId spot-rate override when provided', () => {
    const nowMs = Date.UTC(2026, 3, 18, 19, 37, 25);
    const baselineMs = Date.UTC(2026, 3, 17, 19, 0, 0);
    const cache: FiatRateSeriesCache = {
      'USD:eth:1D': {
        fetchedOn: nowMs,
        points: [
          {ts: baselineMs, rate: 2000},
          {ts: nowMs, rate: 2100},
        ],
      },
    };

    const result = getFiatRateChangeForTimeframe({
      fiatRateSeriesCache: cache,
      fiatCode: 'USD',
      currencyAbbreviation: 'eth',
      timeframe: '1D',
      nowMs,
      assetId: 'eth:eth',
      currentRatesByAssetId: {'eth:eth': 2200},
      currentRate: 2100,
      method: 'linear',
    });

    expect(result?.currentRate).toBe(2200);
    expect(result?.priceChange).toBe(200);
    expect(result?.percentRatio).toBe(0.1);
  });

  it('can read legacy JS token rate cache keys and portfolio worklet cache keys', () => {
    const ts = Date.UTC(2026, 3, 18, 12, 0, 0);
    const legacyCache: FiatRateSeriesCache = {
      'USD:usdc|eth|0xabc:1D': {
        fetchedOn: ts,
        points: [{ts, rate: 1.01}],
      },
    };
    const workletCache: FiatRateSeriesCache = {
      'USD:usdc:1D:eth:0xabc': {
        fetchedOn: ts,
        points: [{ts, rate: 1.02}],
      },
    };

    expect(
      getFiatRateFromSeriesCacheAtTimestamp({
        fiatRateSeriesCache: legacyCache,
        fiatCode: 'USD',
        currencyAbbreviation: 'usdc',
        interval: '1D',
        identity: {chain: 'eth', tokenAddress: '0xAbC'},
        timestampMs: ts,
      }),
    ).toBe(1.01);

    expect(
      getFiatRateFromSeriesCacheAtTimestamp({
        fiatRateSeriesCache: workletCache,
        fiatCode: 'USD',
        currencyAbbreviation: 'usdc',
        interval: '1D',
        identity: {chain: 'eth', tokenAddress: '0xAbC'},
        timestampMs: ts,
      }),
    ).toBe(1.02);
  });
});
