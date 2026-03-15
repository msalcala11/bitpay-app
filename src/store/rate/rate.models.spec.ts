import {
  getFiatRateSeriesCacheKey,
  getFiatRateSeriesLoadedIntervalKey,
} from './rate.models';

describe('rate.models fiat-rate identity helpers', () => {
  it('keeps plain coin-only keys unchanged', () => {
    expect(getFiatRateSeriesCacheKey('usd', 'btc', 'ALL')).toBe('USD:btc:ALL');
    expect(getFiatRateSeriesLoadedIntervalKey('usd', 'btc', 'ALL')).toBe(
      'USD:btc:ALL',
    );
  });

  it('keeps cache and loaded-interval keys distinct for same-coin token assets', () => {
    const ethUsdcCacheKey = getFiatRateSeriesCacheKey('USD', 'usdc', 'ALL', {
      chain: 'eth',
      tokenAddress: '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    });
    const baseUsdcCacheKey = getFiatRateSeriesCacheKey('USD', 'usdc', 'ALL', {
      chain: 'base',
      tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    });

    expect(ethUsdcCacheKey).not.toBe(baseUsdcCacheKey);
    expect(
      getFiatRateSeriesLoadedIntervalKey('USD', 'usdc', 'ALL', {
        chain: 'eth',
        tokenAddress: '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      }),
    ).toBe(ethUsdcCacheKey);
    expect(
      getFiatRateSeriesLoadedIntervalKey('USD', 'usdc', 'ALL', {
        chain: 'base',
        tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      }),
    ).toBe(baseUsdcCacheKey);
  });
});
