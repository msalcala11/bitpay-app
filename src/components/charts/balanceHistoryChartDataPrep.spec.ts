import {getFiatRateSeriesCacheKey} from '../../store/rate/rate.models';
import {
  buildBalanceHistoryChartPrepFiatRateSeriesCacheKeys,
  buildBalanceHistoryChartRateFetchAssets,
  buildBalanceHistoryChartRelevantRateCacheAssets,
  getLatestFiatRateSeriesPointTs,
} from './balanceHistoryChartDataPrep';

jest.mock('../../utils/portfolio/assets', () => ({
  getPortfolioWalletChainLower: (wallet?: {chain?: string}) =>
    String(wallet?.chain || '').toLowerCase(),
  getPortfolioWalletCurrencyAbbreviation: (wallet?: {
    currencyAbbreviation?: string;
  }) => String(wallet?.currencyAbbreviation || ''),
  getPortfolioWalletTokenAddressNormalized: (wallet?: {
    chain?: string;
    tokenAddress?: string;
  }) => {
    const tokenAddress = String(wallet?.tokenAddress || '');
    if (!tokenAddress) {
      return undefined;
    }

    return String(wallet?.chain || '').toLowerCase() === 'sol'
      ? tokenAddress
      : tokenAddress.toLowerCase();
  },
}));

describe('balanceHistoryChartDataPrep', () => {
  it('dedupes rate-fetch identities while preserving normalized chain/token rules', () => {
    const wallets = [
      {
        id: 'wallet-eth-1',
        chain: 'eth',
        currencyAbbreviation: 'usdc',
        tokenAddress: '0xAbC123',
      },
      {
        id: 'wallet-eth-2',
        chain: 'eth',
        currencyAbbreviation: 'usdc',
        tokenAddress: '0xabc123',
      },
      {
        id: 'wallet-sol-1',
        chain: 'sol',
        currencyAbbreviation: 'usdc',
        tokenAddress: 'AbCdEf123',
      },
      {
        id: 'wallet-btc-1',
        chain: 'btc',
        currencyAbbreviation: 'btc',
      },
    ] as any;

    const rateFetchAssets = buildBalanceHistoryChartRateFetchAssets(wallets);

    expect(rateFetchAssets).toEqual([
      {
        coinForCacheCheck: 'usdc',
        chain: 'eth',
        tokenAddress: '0xabc123',
      },
      {
        coinForCacheCheck: 'usdc',
        chain: 'sol',
        tokenAddress: 'AbCdEf123',
      },
      {
        coinForCacheCheck: 'btc',
        chain: undefined,
        tokenAddress: undefined,
      },
    ]);
    expect(
      buildBalanceHistoryChartRelevantRateCacheAssets(rateFetchAssets),
    ).toEqual([
      {
        coin: 'usdc',
        chain: 'eth',
        tokenAddress: '0xabc123',
      },
      {
        coin: 'usdc',
        chain: 'sol',
        tokenAddress: 'AbCdEf123',
      },
      {
        coin: 'btc',
        chain: undefined,
        tokenAddress: undefined,
      },
    ]);
  });

  it('builds sorted prep-only FX cache keys only when snapshot quote currencies differ', () => {
    expect(
      buildBalanceHistoryChartPrepFiatRateSeriesCacheKeys({
        quoteCurrency: 'EUR',
        scopedSnapshotsByWalletId: {
          'wallet-1': [{quoteCurrency: 'USD'}] as any,
          'wallet-2': [{quoteCurrency: 'cad'}] as any,
          'wallet-3': [{quoteCurrency: 'EUR'}] as any,
        },
        prepIntervals: ['1D', 'ALL'],
      }),
    ).toEqual([
      getFiatRateSeriesCacheKey('CAD', 'btc', '1D'),
      getFiatRateSeriesCacheKey('CAD', 'btc', 'ALL'),
      getFiatRateSeriesCacheKey('EUR', 'btc', '1D'),
      getFiatRateSeriesCacheKey('EUR', 'btc', 'ALL'),
      getFiatRateSeriesCacheKey('USD', 'btc', '1D'),
      getFiatRateSeriesCacheKey('USD', 'btc', 'ALL'),
    ]);

    expect(
      buildBalanceHistoryChartPrepFiatRateSeriesCacheKeys({
        quoteCurrency: 'USD',
        scopedSnapshotsByWalletId: {
          'wallet-1': [{quoteCurrency: 'USD'}] as any,
        },
        prepIntervals: ['1D', 'ALL'],
      }),
    ).toEqual([]);
  });

  it('returns the latest point timestamp across mixed cache entries', () => {
    expect(
      getLatestFiatRateSeriesPointTs({
        malformed: null as any,
        'USD:btc:ALL': {
          fetchedOn: 100,
          points: [
            {ts: 1_000, rate: 1},
            {ts: 5_000, rate: 2},
          ],
        },
        'USD:eth:ALL': {
          fetchedOn: 200,
          points: [
            {ts: 2_000, rate: 1},
            {ts: 4_000, rate: 2},
          ],
        },
      } as any),
    ).toBe(5_000);
  });
});
