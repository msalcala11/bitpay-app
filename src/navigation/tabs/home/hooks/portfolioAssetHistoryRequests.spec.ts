import {
  FIAT_RATE_SERIES_CACHED_INTERVALS,
  getFiatRateSeriesCacheKey,
} from '../../../../store/rate/rate.models';
import {
  getHistoricalRateAssetRequestFromItem,
  getHistoricalRateAssetRequestItemsForVisibleWalletGroups,
  getMissingHistoricalRateAssetRequests,
  hasHistoricalRateSeriesForAsset,
} from './portfolioAssetHistoryRequests';

describe('portfolioAssetHistoryRequests', () => {
  it('builds token-aware request identities from asset row items', () => {
    expect(
      getHistoricalRateAssetRequestFromItem(
        {
          currencyAbbreviation: 'USDC',
          chain: 'BASE',
          tokenAddress: ' 0xAbC123 ',
        },
        'usd',
      ),
    ).toEqual({
      requestKey: 'USD:usdc|base|0xabc123',
      coin: 'usdc',
      chain: 'base',
      tokenAddress: '0xabc123',
    });
  });

  it('keeps same-symbol token requests distinct by asset identity', () => {
    const requests = getMissingHistoricalRateAssetRequests({
      fiatCode: 'USD',
      items: [
        {
          currencyAbbreviation: 'usdc',
          chain: 'eth',
          tokenAddress: '0xaaa',
        },
        {
          currencyAbbreviation: 'usdc',
          chain: 'base',
          tokenAddress: '0xbbb',
        },
      ],
      cache: {},
      intervals: FIAT_RATE_SERIES_CACHED_INTERVALS,
    });

    expect(requests.map(request => request.requestKey)).toEqual([
      'USD:usdc|base|0xbbb',
      'USD:usdc|eth|0xaaa',
    ]);
  });

  it('derives requests for all underlying identities in a visible collapsed wallet group', () => {
    const requestItems =
      getHistoricalRateAssetRequestItemsForVisibleWalletGroups([
        {
          id: 'base-usdc',
          chain: 'base',
          currencyAbbreviation: 'usdc',
          tokenAddress: '0xbbb',
          network: 'livenet',
          balance: {crypto: '1'},
          credentials: {
            token: {
              decimals: 6,
            },
          },
        },
        {
          id: 'eth-usdc',
          chain: 'eth',
          currencyAbbreviation: 'usdc',
          tokenAddress: '0xaaa',
          network: 'livenet',
          balance: {crypto: '0'},
          credentials: {
            token: {
              decimals: 6,
            },
          },
        },
      ] as any);

    expect(
      getMissingHistoricalRateAssetRequests({
        fiatCode: 'USD',
        items: requestItems,
        cache: {},
        intervals: FIAT_RATE_SERIES_CACHED_INTERVALS,
      }),
    ).toEqual([
      {
        requestKey: 'USD:usdc|base|0xbbb',
        coin: 'usdc',
        chain: 'base',
        tokenAddress: '0xbbb',
      },
      {
        requestKey: 'USD:usdc|eth|0xaaa',
        coin: 'usdc',
        chain: 'eth',
        tokenAddress: '0xaaa',
      },
    ]);
  });

  it('treats cached token history as valid only for the matching identity', () => {
    const cache = Object.fromEntries(
      FIAT_RATE_SERIES_CACHED_INTERVALS.map(interval => [
        getFiatRateSeriesCacheKey('USD', 'usdc', interval, {
          chain: 'eth',
          tokenAddress: '0xaaa',
        }),
        {
          fetchedOn: 1,
          points: [{ts: 1, rate: 1}],
        },
      ]),
    );

    expect(
      hasHistoricalRateSeriesForAsset({
        cache,
        fiatCode: 'USD',
        intervals: FIAT_RATE_SERIES_CACHED_INTERVALS,
        coin: 'usdc',
        chain: 'eth',
        tokenAddress: '0xaaa',
      }),
    ).toBe(true);

    expect(
      hasHistoricalRateSeriesForAsset({
        cache,
        fiatCode: 'USD',
        intervals: FIAT_RATE_SERIES_CACHED_INTERVALS,
        coin: 'usdc',
        chain: 'base',
        tokenAddress: '0xbbb',
      }),
    ).toBe(false);

    expect(
      getMissingHistoricalRateAssetRequests({
        fiatCode: 'USD',
        items: [
          {
            currencyAbbreviation: 'usdc',
            chain: 'eth',
            tokenAddress: '0xaaa',
          },
          {
            currencyAbbreviation: 'usdc',
            chain: 'base',
            tokenAddress: '0xbbb',
          },
        ],
        cache,
        intervals: FIAT_RATE_SERIES_CACHED_INTERVALS,
      }),
    ).toEqual([
      {
        requestKey: 'USD:usdc|base|0xbbb',
        coin: 'usdc',
        chain: 'base',
        tokenAddress: '0xbbb',
      },
    ]);
  });
});
