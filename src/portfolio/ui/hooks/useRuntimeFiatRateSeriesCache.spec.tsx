import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import {useRuntimeFiatRateSeriesCache} from './useRuntimeFiatRateSeriesCache';

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mockLoadRuntimeFiatRateSeriesCache = jest.fn();
const mockOnHistoricalRatesPersisted = jest.fn();

jest.mock('../../v2/triggers', () => ({
  onHistoricalRatesPersisted: (...args: unknown[]) =>
    mockOnHistoricalRatesPersisted(...args),
}));

jest.mock('../fiatRateSeries', () => {
  return {
    buildRuntimeFiatRateCacheRequestKey: jest.fn(
      ({
        quoteCurrency,
        requests,
        maxAgeMs,
      }: {
        quoteCurrency: string;
        requests: Array<{
          coin: string;
          chain?: string;
          tokenAddress?: string;
          intervals: string[];
        }>;
        maxAgeMs?: number;
      }) =>
        [
          String(quoteCurrency || '')
            .trim()
            .toUpperCase(),
          typeof maxAgeMs === 'number' ? String(maxAgeMs) : '',
          (requests || [])
            .map(
              request =>
                `${request.coin}|${request.chain || ''}|${
                  request.tokenAddress || ''
                }|${(request.intervals || []).join(',')}`,
            )
            .sort()
            .join('||'),
        ].join('|'),
    ),
    normalizeRuntimeFiatRateCacheRequests: jest.fn(
      (
        requests: Array<{
          coin: string;
          chain?: string;
          tokenAddress?: string;
          intervals: string[];
        }>,
      ) =>
        [...(requests || [])]
          .map(request => ({
            ...request,
            coin: String(request.coin || '').trim().toLowerCase(),
            intervals: [...new Set(request.intervals || [])].sort(),
          }))
          .sort((a, b) => a.coin.localeCompare(b.coin)),
    ),
    loadRuntimeFiatRateSeriesCache: jest.fn((...args) =>
      mockLoadRuntimeFiatRateSeriesCache(...args),
    ),
  };
});

const HookHarness = ({
  refreshToken,
  notifyHistoricalRatesPersisted,
  requests = [
    {
      coin: 'btc',
      intervals: ['1D'],
    },
  ],
}: {
  refreshToken?: string | number;
  notifyHistoricalRatesPersisted?: boolean;
  requests?: Array<{
    coin: string;
    chain?: string;
    tokenAddress?: string;
    intervals: string[];
  }>;
}) => {
  useRuntimeFiatRateSeriesCache({
    quoteCurrency: 'USD',
    requests,
    refreshToken,
    notifyHistoricalRatesPersisted,
  });

  return null;
};

function nonEmptyCache() {
  return {
    'USD:btc:1D': {
      fetchedOn: 1,
      points: [{ts: 1, rate: 100}],
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(innerResolve => {
    resolve = innerResolve;
  });
  return {promise, resolve};
}

describe('useRuntimeFiatRateSeriesCache', () => {
  beforeEach(() => {
    mockLoadRuntimeFiatRateSeriesCache.mockReset();
    mockOnHistoricalRatesPersisted.mockReset();
    mockLoadRuntimeFiatRateSeriesCache.mockResolvedValue({});
  });

  it('does not reload for semantically identical request arrays across rerenders', async () => {
    let view: TestRenderer.ReactTestRenderer;

    await act(async () => {
      view = TestRenderer.create(<HookHarness />);
    });

    expect(mockLoadRuntimeFiatRateSeriesCache).toHaveBeenCalledTimes(1);

    await act(async () => {
      view!.update(<HookHarness />);
    });

    expect(mockLoadRuntimeFiatRateSeriesCache).toHaveBeenCalledTimes(1);
  });

  it('still reloads when an explicit refresh token changes', async () => {
    let view: TestRenderer.ReactTestRenderer;

    await act(async () => {
      view = TestRenderer.create(<HookHarness refreshToken="a" />);
    });

    expect(mockLoadRuntimeFiatRateSeriesCache).toHaveBeenCalledTimes(1);

    await act(async () => {
      view!.update(<HookHarness refreshToken="b" />);
    });

    expect(mockLoadRuntimeFiatRateSeriesCache).toHaveBeenCalledTimes(2);
  });

  it('does not notify historical-rate persistence for default consumers', async () => {
    mockLoadRuntimeFiatRateSeriesCache.mockResolvedValue(nonEmptyCache());

    await act(async () => {
      TestRenderer.create(<HookHarness />);
    });

    expect(mockLoadRuntimeFiatRateSeriesCache).toHaveBeenCalledTimes(1);
    expect(mockOnHistoricalRatesPersisted).not.toHaveBeenCalled();
  });

  it('notifies historical-rate persistence for opted-in non-empty cache loads without scheduling inputs yet', async () => {
    mockLoadRuntimeFiatRateSeriesCache.mockResolvedValue(nonEmptyCache());

    await act(async () => {
      TestRenderer.create(
        <HookHarness
          notifyHistoricalRatesPersisted
          requests={[
            {
              coin: ' BTC ',
              chain: 'livenet',
              tokenAddress: 'Token',
              intervals: ['ALL', '1D', '1M', '3M', '1Y'],
            },
          ]}
        />,
      );
    });

    expect(mockOnHistoricalRatesPersisted).toHaveBeenCalledTimes(1);
    expect(mockOnHistoricalRatesPersisted).toHaveBeenCalledWith({
      quoteCurrency: 'USD',
      assetRefs: [
        {
          coin: 'btc',
          chain: 'livenet',
          tokenAddress: 'Token',
        },
      ],
      intervals: ['1D', '1M', 'ALL'],
      source: 'exchangeRateScreen',
      // Production scheduling remains deferred until this Exchange Rate path
      // can provide a safe fire-time normalized recompute input.
      normalizedFormulaInput: undefined,
    });
  });

  it('does not notify historical-rate persistence for empty cache loads or empty normalized request metadata', async () => {
    mockLoadRuntimeFiatRateSeriesCache.mockResolvedValueOnce({});

    await act(async () => {
      TestRenderer.create(<HookHarness notifyHistoricalRatesPersisted />);
    });

    expect(mockOnHistoricalRatesPersisted).not.toHaveBeenCalled();

    await act(async () => {
      TestRenderer.create(
        <HookHarness
          notifyHistoricalRatesPersisted
          requests={[{coin: '', intervals: ['1D']}]}
        />,
      );
    });

    expect(mockOnHistoricalRatesPersisted).not.toHaveBeenCalled();
  });

  it('does not notify historical-rate persistence for stale out-of-order loads', async () => {
    const first = deferred<ReturnType<typeof nonEmptyCache>>();
    const second = deferred<ReturnType<typeof nonEmptyCache>>();
    mockLoadRuntimeFiatRateSeriesCache
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    let view: TestRenderer.ReactTestRenderer;
    await act(async () => {
      view = TestRenderer.create(
        <HookHarness notifyHistoricalRatesPersisted refreshToken="a" />,
      );
    });
    await act(async () => {
      view!.update(
        <HookHarness notifyHistoricalRatesPersisted refreshToken="b" />,
      );
    });

    await act(async () => {
      second.resolve(nonEmptyCache());
      await second.promise;
    });

    expect(mockOnHistoricalRatesPersisted).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve(nonEmptyCache());
      await first.promise;
    });

    expect(mockOnHistoricalRatesPersisted).toHaveBeenCalledTimes(1);
  });
});
